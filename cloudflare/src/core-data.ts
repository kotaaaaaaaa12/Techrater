import type { WorkerEnv } from "./index";

const PROFILE_FIELDS = ["statistics", "ranks", "settings", "keymaps", "touch_1", "touch_2", "touch_3", "extra_1", "extra_2", "extra_3"];
const LANGUAGES = ["en_us", "zh_cn", "zh_tw", "fr_fr", "es_es", "pt_pt", "id_id", "ja_jp"];
let ready: Promise<void> | null = null;

async function ensureCoreSchema(db: D1Database): Promise<void> {
  if (!ready) {
    ready = db.batch([
      db.prepare(`CREATE TABLE IF NOT EXISTS techmino_player_data (
        player_id INTEGER PRIMARY KEY, payload TEXT NOT NULL DEFAULT '{}'
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS techmino_notices (
        id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, payload TEXT NOT NULL
      )`),
    ]).then(() => undefined).catch((error) => { ready = null; throw error; });
  }
  await ready;
}

export async function ensurePlayerData(db: D1Database, playerId: number): Promise<void> {
  await ensureCoreSchema(db);
  await db.prepare("INSERT OR IGNORE INTO techmino_player_data (player_id) VALUES (?)").bind(playerId).run();
}

function numericId(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error("Invalid identifier.");
  return value;
}

function fields(value: unknown, names: string[]): Record<string, string | null> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid field values.");
  const result: Record<string, string | null> = {};
  for (const [name, content] of Object.entries(value)) {
    if (!names.includes(name)) continue;
    if (typeof content !== "string" && content !== null) throw new Error("Fields must contain text.");
    result[name] = content;
  }
  return result;
}

async function authorize(request: Request, token: string): Promise<boolean> {
  if (!token || token.length < 32) return false;
  const provided = request.headers.get("Authorization") || "";
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(`Bearer ${token}`)),
  ]);
  const a = new Uint8Array(left), b = new Uint8Array(right);
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}

export async function coreDataRequest(request: Request, env: WorkerEnv): Promise<Response> {
  if (!await authorize(request, env.TECHRATER_AUTH_TOKEN)) return new Response("Forbidden", { status: 403 });
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).length > 1_600_000) return new Response("Payload too large", { status: 413 });
    const body = JSON.parse(text) as Record<string, unknown>;
    await ensureCoreSchema(env.TECHMINO_DB);
    const db = env.TECHMINO_DB;
    let data: unknown = null;
    if (body.operation === "player.get") {
      const id = numericId(body.playerId);
      const row = await db.prepare("SELECT payload FROM techmino_player_data WHERE player_id = ?")
        .bind(id).first<{ payload: string }>();
      data = { ...Object.fromEntries(PROFILE_FIELDS.map((name) => [name, null])), ...(row ? JSON.parse(row.payload) : {}), id };
    } else if (body.operation === "player.update") {
      const id = numericId(body.playerId);
      const patch = JSON.stringify(fields(body.values, PROFILE_FIELDS));
      await db.prepare(`INSERT INTO techmino_player_data (player_id, payload) VALUES (?, ?)
        ON CONFLICT(player_id) DO UPDATE SET payload = json_patch(payload, excluded.payload)`)
        .bind(id, patch).run();
    } else if (body.operation === "player.delete") {
      await db.prepare("DELETE FROM techmino_player_data WHERE player_id = ?").bind(numericId(body.playerId)).run();
    } else if (body.operation === "notice.create") {
      const result = await db.prepare("INSERT INTO techmino_notices (created_at, payload) VALUES (?, ?)")
        .bind(new Date().toISOString(), JSON.stringify(fields(body.values, LANGUAGES))).run();
      data = result.meta.last_row_id;
    } else if (body.operation === "notice.update") {
      await db.prepare("UPDATE techmino_notices SET payload = json_patch(payload, ?) WHERE id = ?")
        .bind(JSON.stringify(fields(body.values, LANGUAGES)), numericId(body.noticeId)).run();
    } else if (body.operation === "notice.delete") {
      await db.prepare("DELETE FROM techmino_notices WHERE id = ?").bind(numericId(body.noticeId)).run();
    } else if (body.operation === "notice.list") {
      const fallback = LANGUAGES.includes(String(body.fallbackLanguage)) ? String(body.fallbackLanguage) : "en_us";
      const language = LANGUAGES.includes(String(body.language)) ? String(body.language) : fallback;
      const lastCount = Number(body.lastCount) || 0;
      const page = Math.max(1, Math.floor(Number(body.pageIndex) || 1));
      const size = Math.min(100, Math.max(1, Math.floor(lastCount || Number(body.pageSize) || 10)));
      const offset = lastCount ? 0 : Math.min(1_000_000, (page - 1) * size);
      const rows = await db.prepare("SELECT id, created_at, payload FROM techmino_notices ORDER BY id DESC LIMIT ? OFFSET ?")
        .bind(size, offset).all<{ id: number; created_at: string; payload: string }>();
      data = { language, contents: rows.results.map((row) => {
        const values = JSON.parse(row.payload) as Record<string, string>;
        return { id: row.id, timestamp: row.created_at, content: values[language] ?? values[fallback] ?? "" };
      }) };
    } else {
      return new Response("Unknown operation", { status: 400 });
    }
    return Response.json({ data }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error({ event: "techrater.core_data.error", error: error instanceof Error ? error.message : "Invalid request" });
    return Response.json({ error: "The data request could not be completed." }, { status: 400 });
  }
}
