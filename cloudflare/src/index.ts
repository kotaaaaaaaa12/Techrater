import { env } from "cloudflare:workers";
import { Container, getContainer, type StopParams } from "@cloudflare/containers";
import {
  createBrowserSession,
  loadBrowserCloudSave,
  logoutBrowserSession,
  storeBrowserCloudSave,
  updateBrowserProfile,
} from "./accounts";
import { coreDataRequest } from "./core-data";

export interface WorkerEnv {
  TECHRATER: DurableObjectNamespace<TechraterContainer>;
  TECHMINO_DB: D1Database;
  CLIENT_ORIGIN: string;
  TECHRATER_DATA_ORIGIN: string;
  TECHRATER_AUTH_TOKEN: string;
}

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {}
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export class TechraterContainer extends Container {
  defaultPort = 8080;
  sleepAfter = "30m";
  envVars: Record<string, string> = {
    TECHRATER_DATA_ORIGIN: env.TECHRATER_DATA_ORIGIN,
    TECHRATER_AUTH_TOKEN: env.TECHRATER_AUTH_TOKEN,
  };

  override onStart(): void {
    console.info({ event: "techrater.container.started", port: this.defaultPort });
  }

  override onStop(params: StopParams): void {
    console.error({
      event: "techrater.container.stopped",
      exitCode: params.exitCode,
      reason: params.reason,
    });
  }

  override onError(error: unknown): never {
    console.error({ event: "techrater.container.error", error: errorMessage(error) });
    throw error;
  }
}

const DEFAULT_CLIENT_ORIGIN = "https://techmino.what-the-fuck.men";

function configuredClientOrigins(workerEnv: WorkerEnv): Set<string> {
  const origins = new Set<string>([DEFAULT_CLIENT_ORIGIN]);
  for (const value of workerEnv.CLIENT_ORIGIN.split(",")) {
    try {
      origins.add(new URL(value.trim()).origin);
    } catch {
      // Ignore malformed optional entries; the deployment default remains available.
    }
  }
  return origins;
}

function allowedOrigin(request: Request, workerEnv: WorkerEnv): string | null {
  const requestOrigin = request.headers.get("Origin");
  if (!requestOrigin) return null;
  return configuredClientOrigins(workerEnv).has(requestOrigin) ? requestOrigin : null;
}

function corsHeaders(origin: string): Headers {
  return new Headers({
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  });
}

function addCors(response: Response, origin: string): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of corsHeaders(origin)) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function authenticatedWebSocket(
  request: Request,
  container: DurableObjectStub<TechraterContainer>,
): Promise<Response> {
  const url = new URL(request.url);
  const accessToken = url.searchParams.get("access_token");
  if (!accessToken) {
    console.warn({ event: "techrater.websocket.rejected", reason: "missing_access_token" });
    return new Response("Missing access token", { status: 401 });
  }

  const attemptId = crypto.randomUUID();
  console.info({ event: "techrater.websocket.forward.begin", attemptId });
  try {
    const response = await container.fetch(request);
    console.info({
      event: "techrater.websocket.forward.response",
      attemptId,
      status: response.status,
    });
    return response;
  } catch (error) {
    console.error({
      event: "techrater.websocket.forward.error",
      attemptId,
      error: errorMessage(error),
    });
    throw error;
  }
}

async function healthCheck(request: Request, container: DurableObjectStub<TechraterContainer>): Promise<Response> {
  const url = new URL(request.url);
  url.pathname = "/techmino/api/v1/notice";
  url.search = "?language=en_us&lastCount=1";
  try {
    const response = await container.fetch(new Request(url, { method: "GET" }));
    console.info({ event: "techrater.health.response", status: response.status });
    return new Response(response.ok ? "ok\n" : "unhealthy\n", {
      status: response.ok ? 200 : 503,
      headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error({ event: "techrater.health.error", error: errorMessage(error) });
    return new Response("unhealthy\n", {
      status: 503,
      headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" },
    });
  }
}

const API_PATHS = new Set([
  "/_worker/auth/session",
  "/_worker/auth/profile",
  "/_worker/auth/logout",
  "/_worker/save/load",
  "/_worker/save/store",
]);

export default {
  async fetch(request, workerEnv): Promise<Response> {
    const url = new URL(request.url);
    const upgrade = request.headers.get("Upgrade")?.toLowerCase() === "websocket";
    console.info({
      event: "techrater.request",
      method: request.method,
      path: url.pathname,
      upgrade,
      hasOrigin: request.headers.has("Origin"),
    });
    const container = getContainer(workerEnv.TECHRATER);

    if (url.pathname === "/_worker/internal/core-data" && request.method === "POST") {
      return coreDataRequest(request, workerEnv);
    }

    if (url.pathname === "/_worker/health" && request.method === "GET") {
      return healthCheck(request, container);
    }

    const origin = allowedOrigin(request, workerEnv);
    if (!origin) {
      console.warn({
        event: "techrater.request.rejected",
        path: url.pathname,
        reason: "forbidden_origin",
        requestOrigin: request.headers.get("Origin"),
        allowedOrigins: [...configuredClientOrigins(workerEnv)],
      });
      return new Response("Forbidden origin", { status: 403 });
    }

    if (API_PATHS.has(url.pathname) && request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (url.pathname === "/_worker/auth/session" && request.method === "POST") {
      return addCors(await createBrowserSession(request, workerEnv, container), origin);
    }
    if (url.pathname === "/_worker/auth/profile" && request.method === "POST") {
      return addCors(await updateBrowserProfile(request, workerEnv), origin);
    }
    if (url.pathname === "/_worker/auth/logout" && request.method === "POST") {
      return addCors(await logoutBrowserSession(request, workerEnv), origin);
    }
    if (url.pathname === "/_worker/save/load" && request.method === "POST") {
      return addCors(await loadBrowserCloudSave(request, workerEnv), origin);
    }
    if (url.pathname === "/_worker/save/store" && request.method === "POST") {
      return addCors(await storeBrowserCloudSave(request, workerEnv), origin);
    }
    if (url.pathname === "/techmino/ws/v1" && upgrade) {
      return authenticatedWebSocket(request, container);
    }
    return addCors(new Response("Not found", { status: 404 }), origin);
  },
} satisfies ExportedHandler<WorkerEnv>;
