import { env } from "cloudflare:workers";
import { Container, getContainer, type StopParams } from "@cloudflare/containers";

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

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
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

interface SupabaseSession {
  access_token?: string;
  refresh_token?: string;
  user?: {
    id: string;
    email?: string;
    is_anonymous?: boolean;
    user_metadata?: Record<string, unknown>;
  };
}

interface BrowserAuthRequest {
  mode?: "guest" | "email-sign-in" | "email-sign-up";
  refreshToken?: unknown;
  email?: unknown;
  password?: unknown;
}

interface BrowserProfileRequest {
  refreshToken?: unknown;
  displayName?: unknown;
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

async function stablePlayerId(userId: string): Promise<number> {
  const input = new TextEncoder().encode(userId);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  let value = 0n;
  for (let index = 0; index < 7; index += 1) value = (value << 8n) | BigInt(digest[index]);
  return Number((value & ((1n << 52n) - 1n)) + 1n);
}

function supabaseError(payload: unknown, status: number): string {
  if (payload && typeof payload === "object") {
    const body = payload as Record<string, unknown>;
    for (const key of ["msg", "error_description", "message", "error"]) {
      if (typeof body[key] === "string" && body[key]) return body[key];
    }
  }
  return `Supabase authentication failed (${status})`;
}

function accountDisplayName(session: SupabaseSession): string {
  const metadata = session.user?.user_metadata;
  if (metadata) {
    for (const key of ["display_name", "full_name", "name", "user_name", "preferred_username"]) {
      if (typeof metadata[key] === "string" && metadata[key]) return metadata[key].slice(0, 24);
    }
  }
  const email = session.user?.email;
  if (email) return email.split("@", 1)[0].slice(0, 24);
  return "Guest";
}

async function updateBrowserProfile(request: Request, workerEnv: WorkerEnv): Promise<Response> {
  try {
    const profile = await request.json<BrowserProfileRequest>();
    const refreshToken = typeof profile.refreshToken === "string" ? profile.refreshToken : "";
    const displayName = typeof profile.displayName === "string" ? profile.displayName.trim() : "";
    if (!refreshToken) throw new Error("The account session is missing.");
    if (!displayName || displayName.length > 24) {
      throw new Error("Display name must be between 1 and 24 characters.");
    }

    const refreshResponse = await fetch(`${workerEnv.SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: {
        apikey: workerEnv.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${workerEnv.SUPABASE_ANON_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    const session = await refreshResponse.json<SupabaseSession & Record<string, unknown>>();
    if (!refreshResponse.ok) throw new Error(supabaseError(session, refreshResponse.status));
    if (!session.access_token || !session.refresh_token || !session.user) {
      throw new Error("Supabase returned an incomplete session.");
    }

    const updateResponse = await fetch(`${workerEnv.SUPABASE_URL}/auth/v1/user`, {
      method: "PUT",
      headers: {
        apikey: workerEnv.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${session.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ data: { display_name: displayName } }),
    });
    const updatedUser = await updateResponse.json<SupabaseSession["user"] & Record<string, unknown>>();
    if (!updateResponse.ok) throw new Error(supabaseError(updatedUser, updateResponse.status));

    const updatedSession: SupabaseSession = { ...session, user: updatedUser };
    return Response.json({
      refreshToken: session.refresh_token,
      account: {
        email: updatedUser.email || null,
        isAnonymous: updatedUser.is_anonymous === true || !updatedUser.email,
        displayName: accountDisplayName(updatedSession),
      },
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error({ event: "techrater.profile.error", error: errorMessage(error) });
    return Response.json({ error: errorMessage(error) }, {
      status: 400,
      headers: { "Cache-Control": "no-store" },
    });
  }
}

async function getSupabaseSession(
  request: Request,
  workerEnv: WorkerEnv,
): Promise<{ session?: SupabaseSession; confirmationRequired?: boolean; email?: string }> {
  let auth: BrowserAuthRequest = {};
  try {
    auth = await request.json<BrowserAuthRequest>();
  } catch {
    // An empty request creates a new anonymous account.
  }

  const refreshToken = typeof auth.refreshToken === "string" ? auth.refreshToken : "";
  const mode = auth.mode || (refreshToken ? "guest" : "guest");
  let endpoint = `${workerEnv.SUPABASE_URL}/auth/v1/signup`;
  let payload: Record<string, string> = {};

  if (refreshToken) {
    endpoint = `${workerEnv.SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`;
    payload = { refresh_token: refreshToken };
  } else if (mode === "email-sign-in" || mode === "email-sign-up") {
    const email = typeof auth.email === "string" ? auth.email.trim() : "";
    const password = typeof auth.password === "string" ? auth.password : "";
    if (!email || email.length > 254 || password.length < 8 || password.length > 128) {
      throw new Error("Enter a valid email address and a password between 8 and 128 characters.");
    }
    endpoint = mode === "email-sign-in"
      ? `${workerEnv.SUPABASE_URL}/auth/v1/token?grant_type=password`
      : `${workerEnv.SUPABASE_URL}/auth/v1/signup`;
    payload = { email, password };
  }

  console.info({ event: "techrater.auth.supabase.begin", mode, refresh: Boolean(refreshToken) });
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      apikey: workerEnv.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${workerEnv.SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  console.info({ event: "techrater.auth.supabase.response", status: response.status });
  const session = await response.json<SupabaseSession & Record<string, unknown>>();
  if (!response.ok) throw new Error(supabaseError(session, response.status));

  if (mode === "email-sign-up" && session.user && (!session.access_token || !session.refresh_token)) {
    return { confirmationRequired: true, email: session.user.email };
  }
  return { session };
}

async function createBrowserSession(
  request: Request,
  workerEnv: WorkerEnv,
  container: DurableObjectStub<TechraterContainer>,
): Promise<Response> {
  try {
    const authResult = await getSupabaseSession(request, workerEnv);
    if (authResult.confirmationRequired) {
      return Response.json({
        confirmationRequired: true,
        email: authResult.email,
      }, { headers: { "Cache-Control": "no-store" } });
    }
    const session = authResult.session;
    if (!session || !session.access_token || !session.refresh_token || !session.user?.id) {
      throw new Error("Supabase returned an incomplete session");
    }

    const playerId = await stablePlayerId(session.user.id);
    console.info({ event: "techrater.auth.exchange.begin", playerId });
    const oauthUrl = new URL(request.url);
    oauthUrl.pathname = `/techmino/api/v1/auth/oauth/${encodeURIComponent(workerEnv.TECHRATER_AUTH_TOKEN)}`;
    oauthUrl.search = "";
    const oauthResponse = await container.fetch(new Request(oauthUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playerId }),
    }));
    console.info({ event: "techrater.auth.exchange.response", playerId, status: oauthResponse.status });
    const oauthBody = await oauthResponse.json<{ data?: string; message?: string }>();
    if (!oauthResponse.ok || typeof oauthBody.data !== "string") {
      throw new Error(oauthBody.message || `Techrater token exchange failed (${oauthResponse.status})`);
    }

    console.info({ event: "techrater.auth.complete", playerId });
    return Response.json({
      accessToken: oauthBody.data,
      refreshToken: session.refresh_token,
      playerId,
      account: {
        email: session.user.email || null,
        isAnonymous: session.user.is_anonymous === true || !session.user.email,
        displayName: accountDisplayName(session),
      },
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error({ event: "techrater.auth.error", error: errorMessage(error) });
    return Response.json({ error: errorMessage(error) }, {
      status: 502,
      headers: { "Cache-Control": "no-store" },
    });
  }
}

function googleAuthRedirect(request: Request, workerEnv: WorkerEnv): Response {
  const requestUrl = new URL(request.url);
  const allowedOrigins = configuredClientOrigins(workerEnv);
  const returnTo = requestUrl.searchParams.get("return_to");
  if (!returnTo) return new Response("Missing return URL", { status: 400 });

  let callback: URL;
  try {
    callback = new URL(returnTo);
  } catch {
    return new Response("Invalid return URL", { status: 400 });
  }
  if (!allowedOrigins.has(callback.origin)) {
    console.warn({
      event: "techrater.auth.google.rejected",
      returnOrigin: callback.origin,
      allowedOrigins: [...allowedOrigins],
    });
    return new Response("Invalid return origin", { status: 403 });
  }
  callback.hash = "";
  callback.search = "?techmino_auth=google";

  const authorizeUrl = new URL("/auth/v1/authorize", workerEnv.SUPABASE_URL);
  authorizeUrl.searchParams.set("provider", "google");
  authorizeUrl.searchParams.set("redirect_to", callback.href);
  return Response.redirect(authorizeUrl.href, 302);
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

    if (url.pathname === "/_worker/health" && request.method === "GET") {
      return healthCheck(request, container);
    }

    if (url.pathname === "/_worker/auth/google" && request.method === "GET") {
      return googleAuthRedirect(request, workerEnv);
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

    if ((url.pathname === "/_worker/auth/session" || url.pathname === "/_worker/auth/profile") && request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (url.pathname === "/_worker/auth/session" && request.method === "POST") {
      return addCors(await createBrowserSession(request, workerEnv, container), origin);
    }
    if (url.pathname === "/_worker/auth/profile" && request.method === "POST") {
      return addCors(await updateBrowserProfile(request, workerEnv), origin);
    }
    if (url.pathname === "/techmino/ws/v1" && upgrade) {
      return authenticatedWebSocket(request, container);
    }
    return addCors(new Response("Not found", { status: 404 }), origin);
  },
} satisfies ExportedHandler<WorkerEnv>;
