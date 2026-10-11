import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TRANSITIONS, JOB_STATES } from "../../supabase/functions/_shared/core/states.ts";
import { createTestDb, insertJob, insertWork, type TestDb } from "./helpers.ts";

let db: TestDb;
let alice: string;
let bob: string;

beforeAll(async () => {
  db = await createTestDb("schema");
  alice = await db.createUser();
  bob = await db.createUser();
});
afterAll(() => db.close());

describe("schema", () => {
  it("SQL job_transitions mirrors the TypeScript state machine", async () => {
    const r = await db.admin.query("select from_state, to_state from job_transitions");
    const sql = new Set(r.rows.map((x) => `${x.from_state}>${x.to_state}`));
    const ts = new Set(
      Object.entries(TRANSITIONS).flatMap(([from, tos]) => tos.map((to) => `${from}>${to}`)),
    );
    expect([...sql].sort()).toEqual([...ts].sort());
  });

  it("job_state enum matches TypeScript", async () => {
    const r = await db.admin.query("select unnest(enum_range(null::job_state))::text as s");
    expect(r.rows.map((x) => x.s)).toEqual([...JOB_STATES]);
  });

  it("creates default settings for every new account", async () => {
    const r = await db.admin.query("select * from user_settings where user_id = $1", [alice]);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].video_after_download_hours).toBe(24);
    expect(r.rows[0].video_max_retention_hours).toBe(48);
    expect(r.rows[0].video_no_download_hours).toBe(48);
  });

  it("validates schedule input server-side", async () => {
    const work = await insertWork(db, alice);
    await expect(
      db.asUser(alice, "insert into schedules (work_id, days_of_week, time_of_day, target_duration_seconds) values ($1, '{1,3}', '18:00', 400)", [work]),
    ).rejects.toThrow(/check/);
    await expect(
      db.asUser(alice, "insert into schedules (work_id, days_of_week, time_of_day) values ($1, '{9}', '18:00')", [work]),
    ).rejects.toThrow(/check/);
    await expect(
      db.asUser(alice, "insert into schedules (work_id, days_of_week, time_of_day, timezone) values ($1, '{1}', '18:00', 'Mars/Base')", [work]),
    ).rejects.toThrow(/Fuso horário inválido/);
    await expect(
      db.asUser(alice, "insert into works (title, type, url) values ('x', 'manga', 'javascript:alert(1)')"),
    ).rejects.toThrow(/check/);
  });
});

describe("row level security", () => {
  it("isolates works and schedules between accounts", async () => {
    await db.asUser(alice, "insert into works (title, type) values ('Obra da Alice', 'manga')");
    const own = await db.asUser(alice, "select title from works");
    expect(own.rows.map((r: any) => r.title)).toContain("Obra da Alice");
    const other = await db.asUser(bob, "select title from works where title = 'Obra da Alice'");
    expect(other.rows).toHaveLength(0);
  });

  it("prevents creating a schedule for someone else's work", async () => {
    const aliceWork = await insertWork(db, alice);
    await expect(
      db.asUser(bob, "insert into schedules (work_id, days_of_week, time_of_day) values ($1, '{1}', '10:00')", [aliceWork]),
    ).rejects.toThrow(/row-level security/);
  });

  it("users cannot insert or change jobs directly", async () => {
    const work = await insertWork(db, alice);
    const job = await insertJob(db, alice, work);
    const upd = await db.asUser(alice, "update jobs set state = 'published' where id = $1", [job]);
    expect(upd.rowCount).toBe(0);
    await expect(
      db.asUser(alice, "insert into jobs (user_id, work_id, slot_at, run_at, dedupe_key) values ($1, $2, now(), now(), 'x')", [alice, work]),
    ).rejects.toThrow(/row-level security/);
  });

  it("secrets and oauth states are invisible to users", async () => {
    await db.admin.query("insert into secrets (user_id, name, ciphertext, iv) values ($1, 'gemini_api_key', 'c', 'i')", [alice]);
    const r = await db.asUser(alice, "select * from secrets");
    expect(r.rows).toHaveLength(0);
  });

  it("server-owned columns cannot be changed by the user", async () => {
    await db.admin.query("update user_settings set automation_paused = true, pause_reason = 'limite' where user_id = $1", [alice]);
    await db.asUser(alice, "update user_settings set automation_paused = false, daily_cost_limit_usd = 2 where user_id = $1", [alice]);
    const r = await db.admin.query("select automation_paused, daily_cost_limit_usd from user_settings where user_id = $1", [alice]);
    expect(r.rows[0].automation_paused).toBe(true);
    expect(Number(r.rows[0].daily_cost_limit_usd)).toBe(2);
  });

  it("service functions are not executable by end users", async () => {
    await expect(db.asUser(alice, "select claim_jobs('edge', 'x', 1, 10)")).rejects.toThrow(/permission denied/);
    await expect(db.asUser(alice, "select register_download($1, gen_random_uuid())", [alice])).rejects.toThrow(/permission denied/);
  });

  it("storage_summary only reports the caller's files", async () => {
    await db.admin.query(
      "select register_object($1, null, 'media', 'a/1.mp4', 'video', 1000, 'video/mp4', true)", [alice],
    );
    await db.admin.query(
      "select register_object($1, null, 'media', 'b/1.mp4', 'video', 5000, 'video/mp4', true)", [bob],
    );
    const r = await db.asUser(alice, "select storage_summary() as s");
    expect(Number((r.rows[0] as any).s.used_bytes)).toBe(1000);
  });

  it("authorization timestamp is stamped by the server", async () => {
    const r = await db.asUser(alice, "insert into works (title, type, authorization_status) values ('Autorizada', 'manga', 'authorized') returning authorization_confirmed_at");
    expect((r.rows[0] as any).authorization_confirmed_at).not.toBeNull();
  });
});
