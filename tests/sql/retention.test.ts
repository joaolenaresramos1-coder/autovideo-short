import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, insertJob, insertWork, type TestDb } from "./helpers.ts";

let db: TestDb;
let user: string;
let work: string;

beforeAll(async () => {
  db = await createTestDb("retention");
  user = await db.createUser();
  work = await insertWork(db, user);
});
afterAll(() => db.close());

const H = 3600_000;
const obj = async (id: string) => (await db.admin.query("select * from storage_objects where id = $1", [id])).rows[0];

async function registerVideo(jobId: string | null, path: string) {
  const r = await db.admin.query(
    "select * from register_object($1, $2, 'media', $3, 'video', 2048, 'video/mp4', true)",
    [user, jobId, path],
  );
  return r.rows[0];
}

describe("retention policy", () => {
  it("compute_video_expiry follows the 24h-after-download / 48h-cap rule", async () => {
    const q = (c: string, d: string | null) =>
      db.admin.query("select compute_video_expiry($1::timestamptz, $2::timestamptz) as e", [c, d]).then((r) => new Date(r.rows[0].e).toISOString());
    // never downloaded: 48h after completion
    expect(await q("2026-10-10T00:00:00Z", null)).toBe("2026-10-12T00:00:00.000Z");
    // downloaded 1h after completion: 24h after download
    expect(await q("2026-10-10T00:00:00Z", "2026-10-10T01:00:00Z")).toBe("2026-10-11T01:00:00.000Z");
    // downloaded 40h after completion: capped at 48h after completion
    expect(await q("2026-10-10T00:00:00Z", "2026-10-11T16:00:00Z")).toBe("2026-10-12T00:00:00.000Z");
  });

  it("a new video expires 48h after rendering when never downloaded", async () => {
    const o = await registerVideo(null, `v/${crypto.randomUUID()}.mp4`);
    const delta = new Date(o.expires_at).getTime() - new Date(o.completed_at).getTime();
    expect(delta).toBe(48 * H);
  });

  it("the first download shortens the deadline to 24h; later downloads do not extend it", async () => {
    const o = await registerVideo(null, `v/${crypto.randomUUID()}.mp4`);
    const first = (await db.admin.query("select * from register_download($1, $2)", [user, o.id])).rows[0];
    const delta = new Date(first.expires_at).getTime() - new Date(first.first_download_at).getTime();
    expect(delta).toBe(24 * H);
    const second = (await db.admin.query("select * from register_download($1, $2)", [user, o.id])).rows[0];
    expect(second.expires_at).toEqual(first.expires_at);
    expect(second.download_count).toBe(2);
    // Another user cannot register a download for this file.
    const other = await db.createUser();
    await expect(db.admin.query("select register_download($1, $2)", [other, o.id])).rejects.toThrow(/não encontrado/);
  });

  it("validation shortens the life of intermediates; failure keeps them for recovery", async () => {
    const j = await insertJob(db, user, work, { state: "validating" });
    const audio = (await db.admin.query("select * from register_object($1, $2, 'media', $3, 'audio', 10, 'audio/wav', true)", [user, j, `a/${j}.wav`])).rows[0];
    expect(new Date(audio.expires_at).getTime() - Date.now()).toBeGreaterThan(6 * 24 * H);
    await db.admin.query("select transition_job($1, null, 'ready_to_publish')", [j]);
    const after = await obj(audio.id);
    expect(new Date(after.expires_at).getTime() - Date.now()).toBeLessThanOrEqual(1 * H + 5000);

    const f = await insertJob(db, user, work, { state: "rendering" });
    const img = (await db.admin.query("select * from register_object($1, $2, 'media', $3, 'image', 10, 'image/png', true)", [user, f, `i/${f}.png`])).rows[0];
    await db.admin.query("select transition_job($1, null, 'failed', 'erro')", [f]);
    const kept = await obj(img.id);
    const left = new Date(kept.expires_at).getTime() - Date.now();
    expect(left).toBeGreaterThan(11 * H);
    expect(left).toBeLessThanOrEqual(12 * H + 5000);
  });

  it("partial files expire after the incomplete-file retention", async () => {
    const o = (await db.admin.query("select * from register_object($1, null, 'media', 'p/x.part', 'partial', 5, null, false)", [user])).rows[0];
    expect(new Date(o.expires_at).getTime() - new Date(o.created_at).getTime()).toBe(12 * H);
  });
});

describe("cleanup", () => {
  it("lists expired files, skipping files of a running job", async () => {
    const running = await insertJob(db, user, work, { state: "rendering", locked_by: "w", locked_until: new Date(Date.now() + 60_000).toISOString() });
    const idle = await insertJob(db, user, work, { state: "ready_to_publish" });
    const a = await registerVideo(running, `c/${running}.mp4`);
    const b = await registerVideo(idle, `c/${idle}.mp4`);
    await db.admin.query("update storage_objects set expires_at = now() - interval '1 minute' where id in ($1, $2)", [a.id, b.id]);
    const r = await db.admin.query("select id from cleanup_candidates(100)");
    const ids = r.rows.map((x) => x.id);
    expect(ids).toContain(b.id);
    expect(ids).not.toContain(a.id);
  });

  it("deleting the file keeps the video record and its history", async () => {
    const j = await insertJob(db, user, work, { state: "ready_to_publish" });
    const o = await registerVideo(j, `h/${j}.mp4`);
    await db.admin.query(
      "insert into videos (user_id, job_id, work_id, title, storage_object_id, rendered_at) values ($1, $2, $3, 'Resumo cap. 1', $4, now())",
      [user, j, work, o.id],
    );
    await db.admin.query(
      "insert into scripts (user_id, job_id, work_id, title, segments, full_text, word_count) values ($1,$2,$3,'Roteiro','[]','texto',1)",
      [user, j, work],
    );
    await db.admin.query("update storage_objects set expires_at = now() - interval '1 minute' where id = $1", [o.id]);
    expect((await db.admin.query("select mark_object_deleted($1) as ok", [o.id])).rows[0].ok).toBe(true);
    // Idempotent: running cleanup again does not break anything.
    expect((await db.admin.query("select mark_object_deleted($1) as ok", [o.id])).rows[0].ok).toBe(true);

    const v = (await db.admin.query("select * from videos where job_id = $1", [j])).rows[0];
    expect(v.title).toBe("Resumo cap. 1");
    expect(v.file_deleted_at).not.toBeNull();
    expect((await db.admin.query("select count(*)::int as n from scripts where job_id = $1", [j])).rows[0].n).toBe(1);
    const ids = (await db.admin.query("select id from cleanup_candidates(100)")).rows.map((x) => x.id);
    expect(ids).not.toContain(o.id);
    // A deleted file can no longer be downloaded.
    await expect(db.admin.query("select register_download($1, $2)", [user, o.id])).rejects.toThrow(/expirou/);
  });

  it("failed deletions back off and raise an alert after 3 failures", async () => {
    const o = await registerVideo(null, `f/${crypto.randomUUID()}.mp4`);
    await db.admin.query("update storage_objects set expires_at = now() - interval '1 minute' where id = $1", [o.id]);
    for (let i = 0; i < 3; i++) {
      await db.admin.query("select mark_object_delete_failed($1, 'timeout')", [o.id]);
      const ids = (await db.admin.query("select id from cleanup_candidates(100)")).rows.map((x) => x.id);
      expect(ids).not.toContain(o.id); // waiting for backoff
      await db.admin.query("update storage_objects set next_delete_attempt_at = now() - interval '1 second' where id = $1", [o.id]);
    }
    const alerts = await db.admin.query("select * from alerts where dedupe_key = $1 and resolved_at is null", [`delete_failed:${o.id}`]);
    expect(alerts.rows).toHaveLength(1);
    await db.admin.query("select mark_object_deleted($1)", [o.id]);
    const resolved = await db.admin.query("select resolved_at from alerts where dedupe_key = $1", [`delete_failed:${o.id}`]);
    expect(resolved.rows[0].resolved_at).not.toBeNull();
  });

  it("purges operational logs older than the retention", async () => {
    await db.admin.query("insert into job_logs (user_id, event, created_at) values ($1, 'old', now() - interval '40 days'), ($1, 'new', now())", [user]);
    await db.admin.query("select purge_old_logs()");
    const r = await db.admin.query("select event from job_logs where user_id = $1 and event in ('old','new')", [user]);
    expect(r.rows.map((x) => x.event)).toEqual(["new"]);
  });

  it("raises storage alerts at 70, 85 and 95 % of the quota", async () => {
    const u = await db.createUser();
    await db.admin.query("update user_settings set storage_quota_bytes = 1000 where user_id = $1", [u]);
    await db.admin.query("select register_object($1, null, 'media', 'q/1', 'video', 860, null, true)", [u]);
    await db.admin.query("select refresh_storage_alerts()");
    let keys = (await db.admin.query("select dedupe_key from alerts where user_id = $1 and resolved_at is null order by 1", [u])).rows.map((x) => x.dedupe_key);
    expect(keys).toEqual(["storage_70", "storage_85"]);
    await db.admin.query("update storage_objects set deleted_at = now() where user_id = $1", [u]);
    await db.admin.query("select refresh_storage_alerts()");
    keys = (await db.admin.query("select dedupe_key from alerts where user_id = $1 and resolved_at is null", [u])).rows.map((x) => x.dedupe_key);
    expect(keys).toEqual([]);
  });
});

describe("cost limits", () => {
  it("pauses the account when the daily limit is reached and resumes manually", async () => {
    const u = await db.createUser();
    const w = await insertWork(db, u);
    const j = await insertJob(db, u, w, { state: "scripting", cost_limit_usd: 5 });
    await db.admin.query("update user_settings set daily_cost_limit_usd = 0.10 where user_id = $1", [u]);
    let r = (await db.admin.query("select check_cost_allowance($1, $2, 'gemini_text', 0.01) as a", [u, j])).rows[0].a;
    expect(r.allowed).toBe(true);
    await db.admin.query("select record_usage($1, $2, 'gemini', 'gemini_text', 'm', 1, 1, null, null, 0.095, false)", [u, j]);
    r = (await db.admin.query("select check_cost_allowance($1, $2, 'gemini_text', 0.01) as a", [u, j])).rows[0].a;
    expect(r.allowed).toBe(false);
    expect(r.paused).toBe(true);
    const s = (await db.admin.query("select automation_paused, pause_reason from user_settings where user_id = $1", [u])).rows[0];
    expect(s.automation_paused).toBe(true);
    expect(s.pause_reason).toMatch(/Limite diário/);
    // Completed work is preserved: the job is untouched.
    expect((await db.admin.query("select state, cost_spent_usd from jobs where id = $1", [j])).rows[0]).toMatchObject({ state: "scripting" });
    await db.admin.query("select resume_automation($1)", [u]);
    expect((await db.admin.query("select automation_paused from user_settings where user_id = $1", [u])).rows[0].automation_paused).toBe(false);
  });

  it("per-job cost limit only blocks that job", async () => {
    const u = await db.createUser();
    const w = await insertWork(db, u);
    const j = await insertJob(db, u, w, { state: "scripting", cost_limit_usd: 0.02 });
    await db.admin.query("select record_usage($1, $2, 'gemini', 'gemini_text', 'm', 1, 1, null, null, 0.015, false)", [u, j]);
    const r = (await db.admin.query("select check_cost_allowance($1, $2, 'gemini_text', 0.01) as a", [u, j])).rows[0].a;
    expect(r).toMatchObject({ allowed: false, job_limit: true });
    expect((await db.admin.query("select automation_paused from user_settings where user_id = $1", [u])).rows[0].automation_paused).toBe(false);
  });

  it("render limit per month", async () => {
    const u = await db.createUser();
    await db.admin.query("update user_settings set monthly_render_limit = 1 where user_id = $1", [u]);
    await db.admin.query("select record_usage($1, null, 'github', 'render', 'ffmpeg', null, null, 60, 'seconds', 0, false)", [u]);
    const r = (await db.admin.query("select check_cost_allowance($1, null, 'render', 0) as a", [u])).rows[0].a;
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/renderizações/);
  });
});
