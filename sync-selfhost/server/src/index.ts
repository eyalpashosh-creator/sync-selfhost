import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import express from "express";
import helmet from "helmet";
import { Actions } from "./actions.js";
import { ADMIN_PAGE_HTML, deleteAdminUser, getAdminStats, listAdminCampaigns, listAdminFeedback, listAdminReports, searchAdminUsers } from "./admin.js";
import * as schema from "./schema.js";
import type { AuthenticatedUser, BlobStore, Ctx } from "./portable-sdk.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(moduleDir, "../..");
const dataDir = path.resolve(process.env.DATA_DIR ?? path.join(projectRoot, "data"));
const databasePath = path.resolve(process.env.DATABASE_PATH ?? path.join(dataDir, "sync.sqlite"));
const uploadsDir = path.join(dataDir, "uploads");
const migrationsDir = path.resolve(process.env.MIGRATIONS_DIR ?? path.join(projectRoot, "drizzle"));
const clientDir = path.resolve(process.env.CLIENT_DIR ?? path.join(projectRoot, "client/dist"));
const port = Number(process.env.PORT ?? 3000);

await fs.mkdir(path.dirname(databasePath), { recursive: true });
await fs.mkdir(uploadsDir, { recursive: true });

const sqlite = new Database(databasePath);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");
sqlite.pragma("busy_timeout = 5000");

function applyMigrations(): void {
  sqlite.exec("CREATE TABLE IF NOT EXISTS __sync_migrations (name TEXT PRIMARY KEY NOT NULL, applied_at INTEGER NOT NULL)");
  const applied = new Set((sqlite.prepare("SELECT name FROM __sync_migrations").all() as Array<{ name: string }>).map((row) => row.name));
  const files = requireDirectoryEntries(migrationsDir).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
  for (const name of files) {
    if (applied.has(name)) continue;
    const sql = requireFile(path.join(migrationsDir, name)).replaceAll("--> statement-breakpoint", "\n");
    sqlite.exec(sql);
    sqlite.prepare("INSERT INTO __sync_migrations (name, applied_at) VALUES (?, ?)").run(name, Date.now());
    console.log(`[migrate] ${name}`);
  }
}

function requireDirectoryEntries(directory: string): string[] {
  return fsSync.readdirSync(directory);
}

function requireFile(filename: string): string {
  return fsSync.readFileSync(filename, "utf8");
}

applyMigrations();

const rawOrm = drizzle(sqlite, { schema });
const db = new Proxy(rawOrm as any, {
  get(target, property, receiver) {
    if (property === "batch") {
      return async (queries: Array<{ run(): unknown }>) => sqlite.transaction(() => queries.map((query) => query.run()))();
    }
    return Reflect.get(target, property, receiver);
  },
});

function safeBlobPath(key: string): string {
  const normalized = key.replaceAll("\\", "/").replace(/^\/+/, "");
  const resolved = path.resolve(uploadsDir, normalized);
  if (resolved !== uploadsDir && !resolved.startsWith(`${uploadsDir}${path.sep}`)) throw new Error("Invalid file key");
  return resolved;
}

const blobs: BlobStore = {
  async put(key, bytes, options) {
    const filename = safeBlobPath(key);
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, bytes);
    await fs.writeFile(`${filename}.meta.json`, JSON.stringify({ contentType: options.contentType }));
  },
  async get(key) {
    return fs.readFile(safeBlobPath(key));
  },
  async getUrl(key) {
    return `/files/${key.split("/").map(encodeURIComponent).join("/")}`;
  },
  async delete(key) {
    const filename = safeBlobPath(key);
    await Promise.all([fs.rm(filename, { force: true }), fs.rm(`${filename}.meta.json`, { force: true })]);
  },
};

async function resolveAuthenticatedUser(args: unknown): Promise<AuthenticatedUser> {
  if (!args || typeof args !== "object" || !("sessionToken" in args) || typeof (args as { sessionToken?: unknown }).sessionToken !== "string") return null;
  const token = (args as { sessionToken: string }).sessionToken;
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const row = sqlite.prepare("SELECT u.id, u.role FROM user_sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? LIMIT 1").get(tokenHash, Date.now()) as { id: number; role: "artist" | "curator" | null } | undefined;
  return row ?? null;
}

async function createContext(args: unknown): Promise<Ctx> {
  return {
    db: () => db,
    blobs,
    auth: await resolveAuthenticatedUser(args),
    invalidateQueries() { /* requests read authoritative state directly */ },
  };
}

const app = express();
app.disable("x-powered-by");
// Optional site-wide password gate (for staging). Set SITE_PASSWORD on the
// staging service only; production leaves it unset and stays public.
const sitePassword = process.env.SITE_PASSWORD;
const STAGING_COOKIE = "sync_staging_session";
function stagingSessionToken(): string {
  return crypto.createHmac("sha256", sitePassword ?? "").update("staging-session-v1").digest("hex");
}
function hasStagingSession(request: express.Request): boolean {
  if (!sitePassword) return true;
  const cookies = (request.header("cookie") ?? "").split(";").map((c) => c.trim());
  const session = cookies.find((c) => c.startsWith(`${STAGING_COOKIE}=`))?.slice(STAGING_COOKIE.length + 1) ?? "";
  const expected = stagingSessionToken();
  if (session.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(session), Buffer.from(expected));
}
const STAGING_LOGIN_HTML = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sync Staging</title><style>
*{box-sizing:border-box;margin:0;padding:0}body{background:#0a0c0e;color:#e8eaed;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;min-height:100vh;display:grid;place-items:center;padding:20px}
.card{background:#121518;border:1px solid #23282e;border-radius:16px;padding:40px 36px;width:100%;max-width:400px;text-align:center}
h1{font-size:1.5rem;margin-bottom:8px}p{color:#8a919c;font-size:.9rem;margin-bottom:28px}
input{width:100%;background:#0a0c0e;border:1px solid #2a3038;border-radius:10px;color:#e8eaed;font-size:1rem;padding:14px 16px;margin-bottom:12px;outline:none}
input:focus{border-color:#b8e62e}button{width:100%;background:#b8e62e;color:#0a0c0e;border:none;border-radius:10px;font-size:1rem;font-weight:700;padding:14px;cursor:pointer}
button:hover{background:#c9f04a}.error{color:#ff7a7a;font-size:.85rem;margin-bottom:12px;min-height:1.2em}
</style></head><body><div class="card"><h1>Sync Staging</h1><p>Private test site. Enter the password.</p><form method="POST" action="/staging-login"><div class="error">__ERROR__</div><input type="password" name="password" placeholder="Password" autocomplete="off" autofocus><button type="submit">Open test site</button></form></div></body></html>`;
if (sitePassword) {
  app.use(express.urlencoded({ extended: false }));
  app.post("/staging-login", (request, response) => {
    if (request.body?.password === sitePassword) {
      // Session cookie, no expiry: dies when the browser closes, so it asks again next time.
      response.cookie(STAGING_COOKIE, stagingSessionToken(), { httpOnly: true, sameSite: "lax", secure: true, path: "/" });
      return response.redirect("/");
    }
    return response.type("html").status(401).send(STAGING_LOGIN_HTML.replace("__ERROR__", "Wrong password. Try again."));
  });
  app.use((request, response, next) => {
    if (request.path === "/staging-login") return next();
    if (hasStagingSession(request)) return next();
    return response.type("html").status(401).send(STAGING_LOGIN_HTML.replace("__ERROR__", ""));
  });
}
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: "same-origin" } }));
app.use(express.json({ limit: "5mb" }));

app.get("/health", (_request, response) => response.json({ ok: true }));

function adminAuthorized(request: express.Request): boolean {
  const configured = process.env.ADMIN_KEY;
  if (!configured) return false;
  return request.header("x-admin-key") === configured;
}

app.get("/admin", (_request, response) => {
  response.type("html").send(ADMIN_PAGE_HTML);
});

app.get("/admin/stats", (request, response) => {
  if (!adminAuthorized(request)) return response.status(401).json({ error: "Unauthorized." });
  try {
    return response.json(getAdminStats(sqlite));
  } catch (error) {
    console.error("[admin] stats failed", error);
    return response.status(500).json({ error: "Could not load stats." });
  }
});

app.get("/admin/users", (request, response) => {
  if (!adminAuthorized(request)) return response.status(401).json({ error: "Unauthorized." });
  try {
    const q = typeof request.query.q === "string" ? request.query.q : "";
    return response.json({ users: searchAdminUsers(sqlite, q) });
  } catch (error) {
    console.error("[admin] users failed", error);
    return response.status(500).json({ error: "Could not load users." });
  }
});

app.get("/admin/campaigns", (request, response) => {
  if (!adminAuthorized(request)) return response.status(401).json({ error: "Unauthorized." });
  try {
    return response.json({ campaigns: listAdminCampaigns(sqlite) });
  } catch (error) {
    console.error("[admin] campaigns failed", error);
    return response.status(500).json({ error: "Could not load campaigns." });
  }
});

app.get("/admin/reports", (request, response) => {
  if (!adminAuthorized(request)) return response.status(401).json({ error: "Unauthorized." });
  try {
    return response.json({ reports: listAdminReports(sqlite) });
  } catch (error) {
    console.error("[admin] reports failed", error);
    return response.status(500).json({ error: "Could not load reports." });
  }
});

app.get("/admin/feedback", (request, response) => {
  if (!adminAuthorized(request)) return response.status(401).json({ error: "Unauthorized." });
  try {
    return response.json({ feedback: listAdminFeedback(sqlite) });
  } catch (error) {
    console.error("[admin] feedback failed", error);
    return response.status(500).json({ error: "Could not load feedback." });
  }
});

app.post("/admin/users/:id/delete", (request, response) => {
  if (!adminAuthorized(request)) return response.status(401).json({ error: "Unauthorized." });
  try {
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) return response.status(400).json({ error: "Invalid user." });
    const ok = deleteAdminUser(sqlite, id);
    return response.json({ ok });
  } catch (error) {
    console.error("[admin] delete user failed", error);
    return response.status(500).json({ error: "Could not delete user." });
  }
});

app.post("/actions", async (request, response) => {
  const body: unknown = request.body;
  if (!body || typeof body !== "object") return response.status(400).json({ error: "Expected a JSON object." });
  const { action, args } = body as { action?: unknown; args?: unknown };
  if (typeof action !== "string" || !(action in Actions)) return response.status(404).json({ error: "Unknown action." });
  const definition = Actions[action as keyof typeof Actions];
  const requestResult = definition.request.safeParse(args ?? {});
  if (!requestResult.success) return response.status(400).json({ error: "Invalid request.", issues: requestResult.error.issues });
  try {
    const result = await definition.handler(await createContext(requestResult.data), requestResult.data as never);
    const responseResult = definition.response.safeParse(result);
    if (!responseResult.success) {
      console.error(`[actions] ${action} returned an invalid response`, responseResult.error.issues);
      return response.status(500).json({ error: "The action returned an invalid response." });
    }
    return response.json(responseResult.data);
  } catch (error) {
    console.error(`[actions] ${action} failed`, error);
    return response.status(500).json({ error: "The request could not be completed." });
  }
});

app.get("/files/*path", async (request, response) => {
  try {
    const rawPath = Array.isArray(request.params.path) ? request.params.path.join("/") : request.params.path;
    const key = String(rawPath ?? "").split("/").map(decodeURIComponent).join("/");
    const filename = safeBlobPath(key);
    const metadata = JSON.parse(await fs.readFile(`${filename}.meta.json`, "utf8")) as { contentType?: string };
    response.type(metadata.contentType ?? "application/octet-stream");
    response.setHeader("Cache-Control", "private, max-age=300");
    return response.sendFile(filename);
  } catch {
    return response.status(404).json({ error: "File not found." });
  }
});

app.use(express.static(clientDir, { index: false, maxAge: "1h" }));
// HIDE_TESTING_FEATURES=1 strips testing affordances (role switcher, workspace
// preview-as) on production. Staging leaves it unset to keep them.
const hideTestingFeatures = process.env.HIDE_TESTING_FEATURES === "1";
app.use(async (request, response, next) => {
  if (request.method !== "GET") return next();
  try {
    const html = await fs.readFile(path.join(clientDir, "index.html"), "utf8");
    const injected = html.replace("</head>", `<script>window.SYNC_CONFIG=${JSON.stringify({ hideTestingFeatures })};</script></head>`);
    return response.type("html").send(injected);
  }
  catch (error) { return next(error); }
});

const server = app.listen(port, "0.0.0.0", () => {
  console.log(`Sync listening on http://0.0.0.0:${port}`);
  console.log(`Data directory: ${dataDir}`);
});

const expiryJob = async () => {
  try {
    const definition = Actions.processResolveExpirations;
    const result = await definition.handler(await createContext({}), {});
    if (result.expired > 0) console.log(`[scheduler] auto-resolved ${result.expired} collaboration(s)`);
  } catch (error) { console.error("[scheduler] resolve expiry job failed", error); }
};
const expiryTimer = setInterval(() => void expiryJob(), 60 * 60 * 1000);
expiryTimer.unref();
void expiryJob();

function shutdown(signal: string): void {
  console.log(`Received ${signal}; shutting down.`);
  clearInterval(expiryTimer);
  server.close(() => { sqlite.close(); process.exit(0); });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
