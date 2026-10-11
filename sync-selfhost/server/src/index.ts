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
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: "same-origin" } }));
app.use(express.json({ limit: "5mb" }));

app.get("/health", (_request, response) => response.json({ ok: true }));

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
app.use(async (request, response, next) => {
  if (request.method !== "GET") return next();
  try { return response.sendFile(path.join(clientDir, "index.html")); }
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
