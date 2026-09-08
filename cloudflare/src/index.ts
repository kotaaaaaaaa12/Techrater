import { env } from "cloudflare:workers";
import { Container, getContainer } from "@cloudflare/containers";

interface WorkerEnv {
  TECHRATER: DurableObjectNamespace<TechraterContainer>;
  CLIENT_ORIGIN: string;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_DB_HOST: string;
  SUPABASE_DB_PORT: string;
  SUPABASE_DB_NAME: string;
  SUPABASE_DB_USER: string;
  SUPABASE_DB_PASSWORD: string;
  TECHRATER_AUTH_TOKEN: string;
}

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {}
  }
}

export class TechraterContainer extends Container {
  defaultPort = 8080;
  sleepAfter = "30m";
  envVars: Record<string, string> = {
    SUPABASE_DB_HOST: env.SUPABASE_DB_HOST,
    SUPABASE_DB_PORT: env.SUPABASE_DB_PORT,
    SUPABASE_DB_NAME: env.SUPABASE_DB_NAME,
    SUPABASE_DB_USER: env.SUPABASE_DB_USER,
    SUPABASE_DB_PASSWORD: env.SUPABASE_DB_PASSWORD,
    TECHRATER_AUTH_TOKEN: env.TECHRATER_AUTH_TOKEN,
  };
}

interface SupabaseSession {
  access_token: string;
  refresh_token: string;
  user: { id: string };
}

function allowedOrigin(request: Request, workerEnv: WorkerEnv): string | null {
  const requestOrigin = request.headers.get("Origin");
  if (!requestOrigin) return null;
  try {
    return requestOrigin === new URL(workerEnv.CLIENT_ORIGIN).origin ? requestOrigin : null;
  } catch {
    return null;
  }
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

async function stablePlayerId(userId: string): Promise<number> {
  const input = new TextEncoder().encode(userId);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  let value = 0n;
  for (let index = 0; index < 7; index += 1) value = (value << 8n) | BigInt(digest[index]);
  return Number((value & ((1n << 52n) - 1n)) + 1n);
}

async function getSupabaseSession(request: Request, workerEnv: WorkerEnv): Promise<SupabaseSession> {
  let refreshToken = "";
  try {
    const body = await request.json<{ refreshToken?: unknown }>();
    if (typeof body.refreshToken === "string") refreshToken = body.refreshToken;
  } catch {
    // An empty request creates a new anonymous account.
  }

  const endpoint = refreshToken
    ? `${workerEnv.SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`
    : `${workerEnv.SUPABASE_URL}/auth/v1/signup`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      apikey: workerEnv.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${workerEnv.SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(refreshToken ? { refresh_token: refreshToken } : {}),
  });
  if (!response.ok) throw new Error(`Supabase authentication failed (${response.status})`);
  return response.json<SupabaseSession>();
}

async function createBrowserSession(
  request: Request,
  workerEnv: WorkerEnv,
  container: DurableObjectStub<TechraterContainer>,
): Promise<Response> {
  try {
    const session = await getSupabaseSession(request, workerEnv);
    if (!session.access_token || !session.refresh_token || !session.user?.id) {
      throw new Error("Supabase returned an incomplete session");
    }

    const playerId = await stablePlayerId(session.user.id);
    const oauthUrl = new URL(request.url);
    oauthUrl.pathname = `/techmino/api/v1/auth/oauth/${encodeURIComponent(workerEnv.TECHRATER_AUTH_TOKEN)}`;
    oauthUrl.search = "";
    const oauthResponse = await container.fetch(new Request(oauthUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playerId }),
    }));
    const oauthBody = await oauthResponse.json<{ data?: string; message?: string }>();
    if (!oauthResponse.ok || typeof oauthBody.data !== "string") {
      throw new Error(oauthBody.message || `Techrater token exchange failed (${oauthResponse.status})`);
    }

    return Response.json({
      accessToken: oauthBody.data,
      refreshToken: session.refresh_token,
      playerId,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({
      error: error instanceof Error ? error.message : "Authentication failed",
    }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}

async function authenticatedWebSocket(
  request: Request,
  container: DurableObjectStub<TechraterContainer>,
): Promise<Response> {
  const url = new URL(request.url);
  const accessToken = url.searchParams.get("access_token");
  if (!accessToken) return new Response("Missing access token", { status: 401 });
  url.searchParams.delete("access_token");
  const headers = new Headers(request.headers);
  headers.set("x-access-token", accessToken);
  return container.fetch(new Request(url, { method: "GET", headers }));
}

async function healthCheck(request: Request, container: DurableObjectStub<TechraterContainer>): Promise<Response> {
  const url = new URL(request.url);
  url.pathname = "/techmino/api/v1/notice";
  url.search = "?language=en_us&lastCount=1";
  try {
    const response = await container.fetch(new Request(url, { method: "GET" }));
    return new Response(response.ok ? "ok\n" : "unhealthy\n", {
      status: response.ok ? 200 : 503,
      headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" },
    });
  } catch {
    return new Response("unhealthy\n", {
      status: 503,
      headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" },
    });
  }
}

export default {
  async fetch(request, workerEnv): Promise<Response> {
    const url = new URL(request.url);
    const container = getContainer(workerEnv.TECHRATER);

    if (url.pathname === "/_worker/health" && request.method === "GET") {
      return healthCheck(request, container);
    }

    const origin = allowedOrigin(request, workerEnv);
    if (!origin) return new Response("Forbidden origin", { status: 403 });

    if (url.pathname === "/_worker/auth/session" && request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (url.pathname === "/_worker/auth/session" && request.method === "POST") {
      return addCors(await createBrowserSession(request, workerEnv, container), origin);
    }
    if (url.pathname === "/techmino/ws/v1" && request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      return authenticatedWebSocket(request, container);
    }
    return addCors(new Response("Not found", { status: 404 }), origin);
  },
} satisfies ExportedHandler<WorkerEnv>;
