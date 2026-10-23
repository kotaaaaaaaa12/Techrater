import type { WorkerEnv } from "./index";
import type { TechraterContainer } from "./index";
import { ensurePlayerData } from "./core-data";

interface AuthRequest {
  mode?: "login" | "register";
  loginId?: unknown;
  accountName?: unknown;
  password?: unknown;
  refreshToken?: unknown;
}

interface ProfileRequest {
  refreshToken?: unknown;
  displayName?: unknown;
}

interface CloudSaveRequest {
  refreshToken?: unknown;
  expectedRevision?: unknown;
  payload?: unknown;
}

interface CloudSavePayload {
  schemaVersion: 1;
  files: Record<string, string>;
}

interface UserRow {
  user_id: string;
  login_id: string;
  account_name: string;
  password_salt: string;
  password_hash: string;
  password_iterations: number;
}

interface SessionUserRow extends UserRow {
  expires_at: number;
}

interface CloudSaveRow {
  revision: number;
  payload: string;
  updated_at: number;
}

class RequestError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
    this.name = "RequestError";
  }
}

const PASSWORD_ITERATIONS = 600_000;
const SESSION_LIFETIME_SECONDS = 90 * 24 * 60 * 60;
const LOGIN_WINDOW_SECONDS = 15 * 60;
const LOGIN_ATTEMPT_LIMIT = 8;
const CLOUD_SAVE_MAX_BYTES = 1_500_000;
const CLOUD_SAVE_MAX_FILES = 512;
const CLOUD_SAVE_FIXED_FILES = new Set([
  "conf/data",
  "conf/unlock",
  "conf/settings",
  "conf/key",
  "conf/virtualkey",
  "conf/vkSave1",
  "conf/vkSave2",
]);
const DUMMY_SALT = "AAAAAAAAAAAAAAAAAAAAAA";

let schemaReady: Promise<void> | null = null;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function jsonError(error: unknown): Response {
  const requestError = error instanceof RequestError
    ? error
    : new RequestError("The account service could not complete the request.", 500, "internal_error");
  if (!(error instanceof RequestError)) {
    console.error({ event: "techrater.account.internal_error", error: errorText(error) });
  }
  return Response.json({ error: requestError.message, code: requestError.code }, {
    status: requestError.status,
    headers: { "Cache-Control": "no-store" },
  });
}

async function ensureSchema(workerEnv: WorkerEnv): Promise<void> {
  if (!schemaReady) {
    schemaReady = workerEnv.TECHMINO_DB.batch([
      workerEnv.TECHMINO_DB.prepare(`CREATE TABLE IF NOT EXISTS techmino_users (
        user_id TEXT PRIMARY KEY,
        login_id TEXT NOT NULL UNIQUE COLLATE NOCASE,
        account_name TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        password_iterations INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`),
      workerEnv.TECHMINO_DB.prepare(`CREATE TABLE IF NOT EXISTS techmino_sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES techmino_users(user_id) ON DELETE CASCADE
      )`),
      workerEnv.TECHMINO_DB.prepare("CREATE INDEX IF NOT EXISTS techmino_sessions_user_id ON techmino_sessions(user_id)"),
      workerEnv.TECHMINO_DB.prepare("CREATE INDEX IF NOT EXISTS techmino_sessions_expires_at ON techmino_sessions(expires_at)"),
      workerEnv.TECHMINO_DB.prepare(`CREATE TABLE IF NOT EXISTS techmino_login_limits (
        limit_key TEXT PRIMARY KEY,
        attempts INTEGER NOT NULL,
        reset_at INTEGER NOT NULL
      )`),
      workerEnv.TECHMINO_DB.prepare(`CREATE TABLE IF NOT EXISTS techmino_cloud_saves (
        user_id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL,
        payload TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES techmino_users(user_id) ON DELETE CASCADE
      )`),
    ]).then(() => undefined).catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  await schemaReady;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function randomToken(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

async function sha256(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return bytesToBase64Url(digest);
}

async function derivePasswordHash(password: string, salt: string, iterations: number,
  workerEnv: WorkerEnv, container: DurableObjectStub<TechraterContainer>): Promise<string> {
  // Use the existing native crypto library without Workers' PBKDF2 iteration ceiling.
  const saltHex = Array.from(base64UrlToBytes(salt), (value) => value.toString(16).padStart(2, "0")).join("");
  const response = await container.fetch(new Request("http://container/_internal/password-hash", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${workerEnv.TECHRATER_AUTH_TOKEN}` },
    body: JSON.stringify({ password, saltHex, iterations }),
  }));
  if (!response.ok) throw new RequestError("The password service is unavailable. Try again shortly.", 503, "password_service_unavailable");
  const result = await response.json<{ hashHex?: string }>();
  if (!result.hashHex || !/^[a-f0-9]{64}$/u.test(result.hashHex)) {
    throw new RequestError("The password service returned an invalid result.", 503, "password_service_unavailable");
  }
  return bytesToBase64Url(Uint8Array.from(result.hashHex.match(/../gu)!, (pair) => Number.parseInt(pair, 16)));
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  let difference = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] || 0) ^ (rightBytes[index] || 0);
  }
  return difference === 0;
}

function normalizeLoginId(value: unknown): string {
  const loginId = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^[a-z0-9][a-z0-9_.-]{3,31}$/u.test(loginId)) {
    throw new RequestError("ID must be 4 to 32 characters using letters, numbers, dots, hyphens, or underscores.", 400, "invalid_id");
  }
  return loginId;
}

function validateAccountName(value: unknown): string {
  const accountName = typeof value === "string" ? value.trim() : "";
  if (!accountName || [...accountName].length > 24) {
    throw new RequestError("Account name must be between 1 and 24 characters.", 400, "invalid_account_name");
  }
  return accountName;
}

function validatePassword(value: unknown): string {
  const password = typeof value === "string" ? value : "";
  if (password.length < 8 || password.length > 128) {
    throw new RequestError("Password must be between 8 and 128 characters.", 400, "invalid_password");
  }
  return password;
}

async function stablePlayerId(userId: string): Promise<number> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(userId)));
  let value = 0n;
  for (let index = 0; index < 7; index += 1) value = (value << 8n) | BigInt(digest[index]);
  return Number((value & ((1n << 52n) - 1n)) + 1n);
}

async function loginLimitKey(request: Request, loginId: string): Promise<string> {
  const address = request.headers.get("CF-Connecting-IP") || "unknown";
  return sha256(`${loginId}\n${address}`);
}

async function assertLoginAllowed(request: Request, workerEnv: WorkerEnv, loginId: string): Promise<string> {
  const key = await loginLimitKey(request, loginId);
  const current = await workerEnv.TECHMINO_DB.prepare(
    "SELECT attempts, reset_at FROM techmino_login_limits WHERE limit_key = ?",
  ).bind(key).first<{ attempts: number; reset_at: number }>();
  if (current && current.reset_at > nowSeconds() && current.attempts >= LOGIN_ATTEMPT_LIMIT) {
    throw new RequestError("Too many sign-in attempts. Try again later.", 429, "rate_limited");
  }
  return key;
}

async function recordLoginFailure(workerEnv: WorkerEnv, key: string): Promise<void> {
  const now = nowSeconds();
  await workerEnv.TECHMINO_DB.prepare(`INSERT INTO techmino_login_limits (limit_key, attempts, reset_at)
    VALUES (?, 1, ?)
    ON CONFLICT(limit_key) DO UPDATE SET
      attempts = CASE WHEN reset_at <= ? THEN 1 ELSE attempts + 1 END,
      reset_at = CASE WHEN reset_at <= ? THEN excluded.reset_at ELSE reset_at END`)
    .bind(key, now + LOGIN_WINDOW_SECONDS, now, now)
    .run();
}

async function createStoredSession(workerEnv: WorkerEnv, userId: string): Promise<string> {
  const token = randomToken(32);
  const tokenHash = await sha256(token);
  const now = nowSeconds();
  await workerEnv.TECHMINO_DB.batch([
    workerEnv.TECHMINO_DB.prepare(
      "INSERT INTO techmino_sessions (token_hash, user_id, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(tokenHash, userId, now, now, now + SESSION_LIFETIME_SECONDS),
    workerEnv.TECHMINO_DB.prepare("DELETE FROM techmino_sessions WHERE expires_at <= ?").bind(now),
  ]);
  return token;
}

async function consumeAuthBudget(request: Request, workerEnv: WorkerEnv, registering: boolean): Promise<void> {
  const now = nowSeconds();
  const interval = registering ? 3600 : 60;
  const maximum = registering ? 5 : 30;
  const address = request.headers.get("CF-Connecting-IP") || "unknown";
  const key = await sha256(`${registering ? "register" : "login"}:${address}`);
  const result = await workerEnv.TECHMINO_DB.prepare(`INSERT INTO techmino_login_limits (limit_key, attempts, reset_at)
    VALUES (?, 1, ?)
    ON CONFLICT(limit_key) DO UPDATE SET
      attempts = CASE WHEN reset_at <= ? THEN 1 ELSE attempts + 1 END,
      reset_at = CASE WHEN reset_at <= ? THEN excluded.reset_at ELSE reset_at END
    RETURNING attempts`)
    .bind(key, now + interval, now, now).first<{ attempts: number }>();
  if (!result || result.attempts > maximum) {
    throw new RequestError("Too many authentication requests. Try again later.", 429, "rate_limited");
  }
}

async function registerUser(auth: AuthRequest, workerEnv: WorkerEnv, container: DurableObjectStub<TechraterContainer>): Promise<{ user: UserRow; token: string }> {
  const loginId = normalizeLoginId(auth.loginId);
  const accountName = validateAccountName(auth.accountName);
  const password = validatePassword(auth.password);
  const existing = await workerEnv.TECHMINO_DB.prepare(
    "SELECT user_id FROM techmino_users WHERE login_id = ? COLLATE NOCASE",
  ).bind(loginId).first<{ user_id: string }>();
  if (existing) throw new RequestError("This ID is already taken.", 409, "id_taken");

  const salt = randomToken(16);
  const passwordHash = await derivePasswordHash(password, salt, PASSWORD_ITERATIONS, workerEnv, container);
  const userId = crypto.randomUUID();
  const now = nowSeconds();
  try {
    await workerEnv.TECHMINO_DB.prepare(`INSERT INTO techmino_users
      (user_id, login_id, account_name, password_salt, password_hash, password_iterations, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(userId, loginId, accountName, salt, passwordHash, PASSWORD_ITERATIONS, now, now)
      .run();
  } catch (error) {
    if (/unique|constraint/i.test(errorText(error))) {
      throw new RequestError("This ID is already taken.", 409, "id_taken");
    }
    throw error;
  }
  return {
    user: {
      user_id: userId,
      login_id: loginId,
      account_name: accountName,
      password_salt: salt,
      password_hash: passwordHash,
      password_iterations: PASSWORD_ITERATIONS,
    },
    token: await createStoredSession(workerEnv, userId),
  };
}

async function loginUser(request: Request, auth: AuthRequest, workerEnv: WorkerEnv, container: DurableObjectStub<TechraterContainer>): Promise<{ user: UserRow; token: string }> {
  const loginId = normalizeLoginId(auth.loginId);
  const password = validatePassword(auth.password);
  const limitKey = await assertLoginAllowed(request, workerEnv, loginId);
  const user = await workerEnv.TECHMINO_DB.prepare(`SELECT user_id, login_id, account_name,
    password_salt, password_hash, password_iterations FROM techmino_users WHERE login_id = ? COLLATE NOCASE`)
    .bind(loginId)
    .first<UserRow>();
  const passwordHash = await derivePasswordHash(
    password,
    user?.password_salt || DUMMY_SALT,
    user?.password_iterations || PASSWORD_ITERATIONS,
    workerEnv,
    container,
  );
  if (!user || !constantTimeEqual(passwordHash, user.password_hash)) {
    await recordLoginFailure(workerEnv, limitKey);
    throw new RequestError("The ID or password is incorrect.", 401, "invalid_credentials");
  }
  await workerEnv.TECHMINO_DB.prepare("DELETE FROM techmino_login_limits WHERE limit_key = ?").bind(limitKey).run();
  return { user, token: await createStoredSession(workerEnv, user.user_id) };
}

async function authenticateToken(workerEnv: WorkerEnv, tokenValue: unknown): Promise<{ user: UserRow; token: string }> {
  const token = typeof tokenValue === "string" ? tokenValue : "";
  if (!token) throw new RequestError("The account session is missing.", 401, "session_missing");
  const tokenHash = await sha256(token);
  const row = await workerEnv.TECHMINO_DB.prepare(`SELECT u.user_id, u.login_id, u.account_name,
      u.password_salt, u.password_hash, u.password_iterations, s.expires_at
    FROM techmino_sessions s JOIN techmino_users u ON u.user_id = s.user_id
    WHERE s.token_hash = ?`)
    .bind(tokenHash)
    .first<SessionUserRow>();
  const now = nowSeconds();
  if (!row || row.expires_at <= now) {
    await workerEnv.TECHMINO_DB.prepare("DELETE FROM techmino_sessions WHERE token_hash = ?").bind(tokenHash).run();
    throw new RequestError("Your session expired. Sign in again.", 401, "session_expired");
  }
  await workerEnv.TECHMINO_DB.prepare(
    "UPDATE techmino_sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?",
  ).bind(now, now + SESSION_LIFETIME_SECONDS, tokenHash).run();
  return { user: row, token };
}

async function exchangeContainerToken(
  request: Request,
  workerEnv: WorkerEnv,
  container: DurableObjectStub<TechraterContainer>,
  userId: string,
): Promise<{ accessToken: string; playerId: number }> {
  const playerId = await stablePlayerId(userId);
  await ensurePlayerData(workerEnv.TECHMINO_DB, playerId);
  const oauthUrl = new URL(request.url);
  oauthUrl.pathname = `/techmino/api/v1/auth/oauth/${encodeURIComponent(workerEnv.TECHRATER_AUTH_TOKEN)}`;
  oauthUrl.search = "";
  const response = await container.fetch(new Request(oauthUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ playerId }),
  }));
  const body = await response.json<{ data?: string; message?: string }>();
  if (!response.ok || typeof body.data !== "string") {
    throw new RequestError(body.message || `Techrater token exchange failed (${response.status}).`, 502, "token_exchange_failed");
  }
  return { accessToken: body.data, playerId };
}

export async function createBrowserSession(
  request: Request,
  workerEnv: WorkerEnv,
  container: DurableObjectStub<TechraterContainer>,
): Promise<Response> {
  try {
    await ensureSchema(workerEnv);
    const auth = await request.json<AuthRequest>();
    let authenticated: { user: UserRow; token: string };
    if (typeof auth.refreshToken === "string" && auth.refreshToken) {
      authenticated = await authenticateToken(workerEnv, auth.refreshToken);
    } else if (auth.mode === "register") {
      await consumeAuthBudget(request, workerEnv, true);
      authenticated = await registerUser(auth, workerEnv, container);
    } else if (auth.mode === "login") {
      await consumeAuthBudget(request, workerEnv, false);
      authenticated = await loginUser(request, auth, workerEnv, container);
    } else {
      throw new RequestError("Sign in before using multiplayer.", 401, "sign_in_required");
    }

    const exchanged = await exchangeContainerToken(request, workerEnv, container, authenticated.user.user_id);
    return Response.json({
      accessToken: exchanged.accessToken,
      refreshToken: authenticated.token,
      playerId: exchanged.playerId,
      account: {
        id: authenticated.user.login_id,
        displayName: authenticated.user.account_name,
        isAnonymous: false,
      },
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return jsonError(error);
  }
}

export async function updateBrowserProfile(request: Request, workerEnv: WorkerEnv): Promise<Response> {
  try {
    await ensureSchema(workerEnv);
    const profile = await request.json<ProfileRequest>();
    const authenticated = await authenticateToken(workerEnv, profile.refreshToken);
    const accountName = validateAccountName(profile.displayName);
    await workerEnv.TECHMINO_DB.prepare(
      "UPDATE techmino_users SET account_name = ?, updated_at = ? WHERE user_id = ?",
    ).bind(accountName, nowSeconds(), authenticated.user.user_id).run();
    return Response.json({
      refreshToken: authenticated.token,
      account: {
        id: authenticated.user.login_id,
        displayName: accountName,
        isAnonymous: false,
      },
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return jsonError(error);
  }
}

export async function logoutBrowserSession(request: Request, workerEnv: WorkerEnv): Promise<Response> {
  try {
    await ensureSchema(workerEnv);
    const auth = await request.json<AuthRequest>();
    const token = typeof auth.refreshToken === "string" ? auth.refreshToken : "";
    if (token) {
      await workerEnv.TECHMINO_DB.prepare("DELETE FROM techmino_sessions WHERE token_hash = ?")
        .bind(await sha256(token))
        .run();
    }
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return jsonError(error);
  }
}

function isCloudSavePath(path: string): boolean {
  return CLOUD_SAVE_FIXED_FILES.has(path) || /^record\/[A-Za-z0-9_-]+\.rec$/u.test(path);
}

function validateCloudSavePayload(value: unknown): CloudSavePayload {
  if (!value || typeof value !== "object") throw new RequestError("Cloud save payload must be an object.", 400, "invalid_save");
  const payload = value as Record<string, unknown>;
  if (payload.schemaVersion !== 1 || !payload.files || typeof payload.files !== "object" || Array.isArray(payload.files)) {
    throw new RequestError("Cloud save payload has an unsupported format.", 400, "invalid_save");
  }
  const entries = Object.entries(payload.files as Record<string, unknown>);
  if (entries.length > CLOUD_SAVE_MAX_FILES) throw new RequestError("Cloud save contains too many files.", 400, "invalid_save");
  const files: Record<string, string> = {};
  for (const [path, content] of entries) {
    if (!isCloudSavePath(path) || typeof content !== "string") {
      throw new RequestError("Cloud save contains invalid data.", 400, "invalid_save");
    }
    files[path] = content;
  }
  const normalized: CloudSavePayload = { schemaVersion: 1, files };
  if (new TextEncoder().encode(JSON.stringify(normalized)).byteLength > CLOUD_SAVE_MAX_BYTES) {
    throw new RequestError("Cloud save exceeds the 1.5 MB limit.", 413, "save_too_large");
  }
  return normalized;
}

export async function loadBrowserCloudSave(request: Request, workerEnv: WorkerEnv): Promise<Response> {
  try {
    await ensureSchema(workerEnv);
    const body = await request.json<CloudSaveRequest>();
    const authenticated = await authenticateToken(workerEnv, body.refreshToken);
    const row = await workerEnv.TECHMINO_DB.prepare(
      "SELECT revision, payload, updated_at FROM techmino_cloud_saves WHERE user_id = ?",
    ).bind(authenticated.user.user_id).first<CloudSaveRow>();
    return Response.json({
      refreshToken: authenticated.token,
      save: row ? {
        revision: row.revision,
        payload: validateCloudSavePayload(JSON.parse(row.payload)),
        updatedAt: new Date(row.updated_at * 1000).toISOString(),
      } : null,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return jsonError(error);
  }
}

export async function storeBrowserCloudSave(request: Request, workerEnv: WorkerEnv): Promise<Response> {
  try {
    await ensureSchema(workerEnv);
    const body = await request.json<CloudSaveRequest>();
    const authenticated = await authenticateToken(workerEnv, body.refreshToken);
    const expectedRevision = typeof body.expectedRevision === "number" ? body.expectedRevision : Number.NaN;
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new RequestError("Cloud save revision is invalid.", 400, "invalid_save");
    }
    const payload = validateCloudSavePayload(body.payload);
    const revision = expectedRevision + 1;
    const updatedAt = nowSeconds();
    const result = expectedRevision === 0
      ? await workerEnv.TECHMINO_DB.prepare(`INSERT INTO techmino_cloud_saves (user_id, revision, payload, updated_at)
          VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO NOTHING`)
        .bind(authenticated.user.user_id, revision, JSON.stringify(payload), updatedAt)
        .run()
      : await workerEnv.TECHMINO_DB.prepare(`UPDATE techmino_cloud_saves
          SET revision = ?, payload = ?, updated_at = ? WHERE user_id = ? AND revision = ?`)
        .bind(revision, JSON.stringify(payload), updatedAt, authenticated.user.user_id, expectedRevision)
        .run();
    if (result.meta.changes !== 1) {
      return Response.json({
        error: "Cloud save changed on another device.",
        code: "save_conflict",
        conflict: true,
        refreshToken: authenticated.token,
      }, { status: 409, headers: { "Cache-Control": "no-store" } });
    }
    return Response.json({
      refreshToken: authenticated.token,
      save: { revision, updatedAt: new Date(updatedAt * 1000).toISOString() },
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return jsonError(error);
  }
}
