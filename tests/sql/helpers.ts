import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

// Connection to a throwaway PostgreSQL server (see docs/TESTES.md).
// Defaults match the local server used in development/CI.
const BASE = {
  host: process.env.PGHOST ?? "/tmp",
  port: Number(process.env.PGPORT ?? 54329),
  user: process.env.PGUSER ?? "postgres",
  password: process.env.PGPASSWORD,
};

const ROOT = new URL("../../", import.meta.url).pathname;

export interface TestDb {
  /** Connection as superuser (acts like the service role, bypasses RLS). */
  admin: pg.Client;
  /** Run statements as an authenticated end user (RLS applies). */
  asUser<T = unknown>(userId: string, sql: string, params?: unknown[]): Promise<pg.QueryResult<T & pg.QueryResultRow>>;
  createUser(id?: string): Promise<string>;
  /** Shift every timestamp-based deadline by moving "now" — implemented by rewriting rows. */
  close(): Promise<void>;
}

export async function createTestDb(name: string): Promise<TestDb> {
  const dbName = `t_${name}_${process.pid}_${Date.now()}`.toLowerCase().replace(/[^a-z0-9_]/g, "_");
  const root = new pg.Client({ ...BASE, database: "postgres" });
  await root.connect();
  await root.query(`create database ${dbName}`);
  await root.end();

  const admin = new pg.Client({ ...BASE, database: dbName });
  await admin.connect();
  await admin.query(readFileSync(join(ROOT, "tests/sql/bootstrap.sql"), "utf8"));
  const dir = join(ROOT, "supabase/migrations");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    try {
      await admin.query(readFileSync(join(dir, file), "utf8"));
    } catch (e) {
      throw new Error(`Falha ao aplicar ${file}: ${(e as Error).message}`);
    }
  }

  return {
    admin,
    async asUser(userId, sql, params) {
      await admin.query("begin");
      try {
        await admin.query("set local role authenticated");
        await admin.query("select set_config('request.jwt.claim.sub', $1, true)", [userId]);
        const r = await admin.query(sql, params as unknown[]);
        await admin.query("commit");
        return r as never;
      } catch (e) {
        await admin.query("rollback");
        throw e;
      }
    },
    async createUser(id = crypto.randomUUID()) {
      await admin.query("insert into auth.users (id, email) values ($1, $2)", [id, `${id}@test.local`]);
      return id;
    },
    async close() {
      await admin.end();
      const r = new pg.Client({ ...BASE, database: "postgres" });
      await r.connect();
      await r.query(`drop database if exists ${dbName} with (force)`);
      await r.end();
    },
  };
}

export async function insertWork(db: TestDb, userId: string, extra: Record<string, unknown> = {}): Promise<string> {
  const cols = { user_id: userId, title: "Obra Teste", type: "manhwa", status: "active", ...extra };
  const keys = Object.keys(cols);
  const r = await db.admin.query(
    `insert into works (${keys.join(",")}) values (${keys.map((_, i) => `$${i + 1}`).join(",")}) returning id`,
    Object.values(cols),
  );
  return r.rows[0].id;
}

export async function insertJob(
  db: TestDb,
  userId: string,
  workId: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const cols = {
    user_id: userId,
    work_id: workId,
    slot_at: new Date(Date.now() + 3600_000).toISOString(),
    run_at: new Date(Date.now() - 1000).toISOString(),
    dedupe_key: `test:${crypto.randomUUID()}`,
    ...extra,
  };
  const keys = Object.keys(cols);
  const r = await db.admin.query(
    `insert into jobs (${keys.join(",")}) values (${keys.map((_, i) => `$${i + 1}`).join(",")}) returning id`,
    Object.values(cols),
  );
  return r.rows[0].id;
}
