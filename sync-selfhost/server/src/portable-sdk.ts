import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { z } from "zod";

export { z };

export type BlobStore = {
  put(key: string, bytes: Uint8Array, options: { contentType: string }): Promise<void>;
  get(key: string): Promise<Buffer>;
  getUrl(key: string): Promise<string>;
  delete(key: string): Promise<void>;
};

export type AuthenticatedUser = { id: number; role: "artist" | "curator" | null } | null;

export type PortableDatabase<T extends Record<string, unknown>> = BetterSQLite3Database<T> & {
  batch(queries: Array<{ run(): unknown }>): Promise<unknown[]>;
};

export type Ctx = {
  db<T extends Record<string, unknown>>(): PortableDatabase<T>;
  blobs: BlobStore;
  auth: AuthenticatedUser;
  invalidateQueries(): void;
};

export type ActionDefinition<Req extends z.ZodType = z.ZodType, Res extends z.ZodType = z.ZodType> = {
  request: Req;
  response: Res;
  handler(ctx: Ctx, args: z.infer<Req>): Promise<z.infer<Res>> | z.infer<Res>;
};

export function defineAction<Req extends z.ZodType, Res extends z.ZodType>(definition: ActionDefinition<Req, Res>): ActionDefinition<Req, Res> {
  return definition;
}

export type ActionsModule = Record<string, ActionDefinition<any, any>>;
