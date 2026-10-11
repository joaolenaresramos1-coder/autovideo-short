import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, insertJob, insertWork, type TestDb } from "./helpers.ts";

let db: TestDb;
let user: string;
let work: string;

beforeAll(async () => {
  db = await createTestDb("queue");
  user = await db.createUser();
  work = await insertWork(db, user);
});
afterAll(() => db.close());

const state = async (id: string) =>
  (await db.admin.query("select * from jobs where id = $1", [id])).rows[0];

describe("queue and state machine", () => {
  it("promotes scheduled jobs whose run time arrived", async () => {
    const due = await insertJob(db, user, work);
    const later = await insertJob(db, user, work, { run_at: new Date(Date.now() + 3600_000).toISOString() });
    await db.admin.query("select promote_due_jobs()");
    expect((await state(due)).state).toBe("queued");
    expect((await state(later)).state).toBe("scheduled");
  });

  it("two executors never claim the same job (SKIP LOCKED + lease)", async () => {
    await db.admin.query("update jobs set state = 'cancelled'");
    const j = await insertJob(db, user, work, { state: "queued" });
    const a = await db.admin.query("select * from claim_jobs('edge', 'worker-a', 10, 60)");
    const b = await db.admin.query("select * from claim_jobs('edge', 'worker-b', 10, 60)");
    expect(a.rows.map((r) => r.id)).toContain(j);
    expect(b.rows.map((r) => r.id)).not.toContain(j);
    // Another executor cannot transition a job it does not own.
    await expect(db.admin.query("select transition_job($1, 'worker-b', 'discovering')", [j])).rejects.toThrow(/em uso/);
    // An expired lease can be taken over.
    await db.admin.query("update jobs set locked_until = now() - interval '1 second' where id = $1", [j]);
    const c = await db.admin.query("select * from claim_jobs('edge', 'worker-b', 10, 60)");
    expect(c.rows.map((r) => r.id)).toContain(j);
  });

  it("worker only claims worker steps", async () => {
    await db.admin.query("update jobs set state = 'cancelled', locked_until = null");
    const r = await insertJob(db, user, work, { state: "rendering" });
    const s = await insertJob(db, user, work, { state: "scripting" });
    const w = await db.admin.query("select id from claim_jobs('worker', 'gha-1', 10, 60)");
    expect(w.rows.map((x) => x.id)).toEqual([r]);
    const e = await db.admin.query("select id from claim_jobs('edge', 'edge-1', 10, 60)");
    expect(e.rows.map((x) => x.id)).toEqual([s]);
  });

  it("rejects invalid transitions and is idempotent on repeated ones", async () => {
    const j = await insertJob(db, user, work, { state: "queued" });
    await expect(db.admin.query("select transition_job($1, null, 'published')", [j])).rejects.toThrow(/Transição inválida/);
    await db.admin.query("select transition_job($1, null, 'discovering')", [j]);
    await db.admin.query("select transition_job($1, null, 'discovering')", [j]);
    expect((await state(j)).state).toBe("discovering");
  });

  it("retry_wait keeps the checkpoint and resumes the same step after backoff", async () => {
    const j = await insertJob(db, user, work, { state: "rendering" });
    await db.admin.query("select save_step($1, 'scripting', 'succeeded', '{\"script\":\"ok\"}'::jsonb)", [j]);
    await db.admin.query("select transition_job($1, null, 'retry_wait', 'ffmpeg caiu', 30, true)", [j]);
    let row = await state(j);
    expect(row.state).toBe("retry_wait");
    expect(row.resume_state).toBe("rendering");
    expect(row.attempts).toBe(1);
    // Not yet due.
    await db.admin.query("select promote_due_jobs()");
    expect((await state(j)).state).toBe("retry_wait");
    await db.admin.query("update jobs set next_attempt_at = now() - interval '1 second' where id = $1", [j]);
    await db.admin.query("select promote_due_jobs()");
    row = await state(j);
    expect(row.state).toBe("rendering"); // not back to scripting
    const steps = await db.admin.query("select output from job_steps where job_id = $1 and step = 'scripting'", [j]);
    expect(steps.rows[0].output).toEqual({ script: "ok" });
  });

  it("manual reprocessing of a failed job resumes from its checkpoint", async () => {
    const j = await insertJob(db, user, work, { state: "validating" });
    await db.admin.query("select transition_job($1, null, 'failed', 'vídeo inválido', null, true)", [j]);
    await expect(db.admin.query("select request_job_action($1, $2, 'retry')", [crypto.randomUUID(), j])).rejects.toThrow(/não encontrada/);
    await db.admin.query("select request_job_action($1, $2, 'retry')", [user, j]);
    const row = await state(j);
    expect(row.state).toBe("validating");
    expect(row.attempts).toBe(0);
  });

  it("prevents duplicate jobs for the same slot and for the same content", async () => {
    await insertJob(db, user, work, { dedupe_key: "slot:s1:2026-10-12T21:00Z:0" });
    await expect(insertJob(db, user, work, { dedupe_key: "slot:s1:2026-10-12T21:00Z:0" })).rejects.toThrow(/duplicate key/);
    await insertJob(db, user, work, { content_key: `${work}:12:chapter` });
    await expect(insertJob(db, user, work, { content_key: `${work}:12:chapter` })).rejects.toThrow(/duplicate key/);
    // A cancelled job frees the content for a new attempt.
    await db.admin.query("update jobs set state = 'cancelled' where content_key = $1", [`${work}:12:chapter`]);
    await insertJob(db, user, work, { content_key: `${work}:12:chapter` });
  });

  it("next_chapter_for skips chapters already taken by an active job", async () => {
    const w = await insertWork(db, user);
    await db.admin.query(
      "insert into chapters (user_id, work_id, chapter_key, number) values ($1,$2,'1',1),($1,$2,'2',2)",
      [user, w],
    );
    await insertJob(db, user, w, { content_key: `${w}:1:chapter` });
    const r = await db.admin.query("select (next_chapter_for($1, 'chapter')).chapter_key", [w]);
    expect(r.rows[0].chapter_key).toBe("2");
  });

  it("a paused account does not start cost steps but still publishes", async () => {
    await db.admin.query("update jobs set state = 'cancelled', locked_until = null");
    const cost = await insertJob(db, user, work, { state: "scripting" });
    const pub = await insertJob(db, user, work, { state: "publishing" });
    await db.admin.query("update user_settings set automation_paused = true where user_id = $1", [user]);
    const r = await db.admin.query("select id from claim_jobs('edge', 'e', 10, 60)");
    const ids = r.rows.map((x) => x.id);
    expect(ids).toContain(pub);
    expect(ids).not.toContain(cost);
    await db.admin.query("select resume_automation($1)", [user]);
  });

  it("cancel is refused while publishing and allowed otherwise", async () => {
    const p = await insertJob(db, user, work, { state: "publishing" });
    await expect(db.admin.query("select request_job_action($1, $2, 'cancel')", [user, p])).rejects.toThrow(/publicação/);
    const q = await insertJob(db, user, work, { state: "queued" });
    await db.admin.query("select request_job_action($1, $2, 'cancel')", [user, q]);
    expect((await state(q)).state).toBe("cancelled");
  });

  it("logs every transition", async () => {
    const j = await insertJob(db, user, work, { state: "queued" });
    await db.admin.query("select transition_job($1, null, 'discovering')", [j]);
    const r = await db.admin.query("select data from job_logs where job_id = $1 and event = 'transition'", [j]);
    expect(r.rows[0].data).toMatchObject({ from: "queued", to: "discovering" });
  });
});

describe("schedule changes", () => {
  it("changing the time cancels unstarted jobs and frees their slot", async () => {
    const s = (await db.admin.query(
      "insert into schedules (user_id, work_id, days_of_week, time_of_day) values ($1, $2, '{1}', '10:00') returning id", [user, work],
    )).rows[0].id;
    const j = await insertJob(db, user, work, { schedule_id: s, dedupe_key: `slot:${s}:x:0`, run_at: new Date(Date.now() + 3600_000).toISOString() });
    const running = await insertJob(db, user, work, { schedule_id: s, state: "rendering" });
    await db.admin.query("update schedules set time_of_day = '11:00', materialized_until = now() + interval '2 days' where id = $1", [s]);
    const row = (await db.admin.query("select state, dedupe_key from jobs where id = $1", [j])).rows[0];
    expect(row.state).toBe("cancelled");
    expect(row.dedupe_key).not.toBe(`slot:${s}:x:0`);
    expect((await db.admin.query("select state from jobs where id = $1", [running])).rows[0].state).toBe("rendering");
    expect((await db.admin.query("select materialized_until from schedules where id = $1", [s])).rows[0].materialized_until).toBeNull();
  });
});
