// End-to-end: the whole production runs from server-side code only (pg_cron
// tick + render worker). No browser or client device participates — this is
// the "browser closed" acceptance test. External APIs are replaced by fakes
// that speak their real protocols; FFmpeg and PostgreSQL are real.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { bytesToBase64 } from "../../supabase/functions/_shared/core/wav.ts";
import { handleApi } from "../../supabase/functions/_shared/api.ts";
import { type Ctx, putUserSecret } from "../../supabase/functions/_shared/pipeline/context.ts";
import { runTick } from "../../supabase/functions/_shared/pipeline/tick.ts";
import { runCleanup } from "../../supabase/functions/_shared/pipeline/cleanup.ts";
import { drainQueue } from "../../supabase/functions/_shared/pipeline/runner.ts";
import { WORKER_HANDLERS } from "../../worker/steps.ts";
import { ffprobe } from "../../worker/ffmpeg.ts";
import { createTestDb, type TestDb } from "./helpers.ts";
import { FsBlobs, PgRepo } from "../support/pg_repo.ts";
import { createFakeFetch } from "../support/fakes.ts";

let db: TestDb;
let dir: string;
let repo: PgRepo;
let blobs: FsBlobs;
let user: string;
let work: string;
const fake = createFakeFetch();
const env = {
  TOKEN_ENCRYPTION_KEY: bytesToBase64(new Uint8Array(32).fill(3)),
  SUPABASE_URL: "https://fake.supabase.co",
  APP_URL: "https://app.example",
  YOUTUBE_CLIENT_ID: "yt", YOUTUBE_CLIENT_SECRET: "yts", TIKTOK_CLIENT_KEY: "tt", TIKTOK_CLIENT_SECRET: "tts",
  GITHUB_DISPATCH_TOKEN: "gh", GITHUB_REPOSITORY: "owner/repo",
};

function ctx(workerId: string): Ctx {
  return { repo, blobs, env, fetch: fake.fetchFn, workerId, deadline: Date.now() + 10 * 60_000, now: () => new Date() };
}
const edge = () => ctx("edge-test");
const worker = () => ctx("gha-test");

async function jobRow(id: string) {
  return (await db.admin.query("select * from jobs where id = $1", [id])).rows[0];
}

function makeImage(file: string, src: string, size: string) {
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", src.includes("=") ? `${src}:s=${size}` : `${src}=s=${size}`, "-frames:v", "1", file]);
}

async function uploadChapter(key: string) {
  const files = [
    { name: "001-strip.png", src: "testsrc2", size: "720x3200" }, // long webtoon strip -> several panels
    { name: "002-page.png", src: "mandelbrot", size: "800x1200" },
    { name: "003-blank.png", src: "color=c=white", size: "800x600" }, // blank -> dropped
  ];
  await repo.upsertChapterForUpload(user, work, key, Number(key));
  for (const f of files) {
    const local = join(dir, `${key}-${f.name}`);
    makeImage(local, f.src, f.size);
    const path = `uploads/${user}/${work}/${key}/${f.name}`;
    const bytes = new Uint8Array(readFileSync(local));
    await blobs.put(path, bytes, "image/png");
    await repo.registerObject(user, null, path, "upload", bytes.length, "image/png");
  }
}

beforeAll(async () => {
  db = await createTestDb("e2e");
  dir = await mkdtemp(join(tmpdir(), "autovideo-e2e-"));
  repo = new PgRepo(db.admin);
  blobs = new FsBlobs(join(dir, "bucket"), db.admin);
  process.env.WORKER_TMP = join(dir, "work");
  user = await db.createUser();
  await db.admin.query("update user_settings set gemini_tier = 'free', caption_style = $2 where user_id = $1", [
    user, JSON.stringify({ font: "DejaVu Sans", color: "#FFE600", accent: "#7CFF4F", outline: 8 }),
  ]);
  const c = edge();
  await putUserSecret(c, user, "gemini_api_key", "test-gemini-key");
  const far = new Date(Date.now() + 30 * 24 * 3600_000).toISOString();
  for (const p of ["youtube", "tiktok"] as const) {
    await putUserSecret(c, user, `oauth:${p}`, JSON.stringify({ access_token: `${p}-token`, refresh_token: "r", expires_at: far }));
    await repo.upsertIntegration({ user_id: user, provider: p, status: "connected", account_id: `${p}-acc`, account_name: p, scopes: [], token_expires_at: far, metadata: {} });
  }
  work = (await db.admin.query(
    `insert into works (user_id, title, type, source, status, authorization_status, authorization_notes, target_platforms)
     values ($1, 'Herdeiro Esquecido', 'manhwa', 'upload', 'active', 'authorized', 'Material próprio para teste', '{youtube,tiktok}') returning id`,
    [user],
  )).rows[0].id;
  // Slot two hours from now in São Paulo time, every day, production starts 3 h before.
  const sp = new Date(Date.now() + 2 * 3600_000 - 3 * 3600_000);
  const hhmm = `${String(sp.getUTCHours()).padStart(2, "0")}:${String(sp.getUTCMinutes()).padStart(2, "0")}`;
  await db.admin.query(
    `insert into schedules (user_id, work_id, days_of_week, time_of_day, timezone, target_duration_seconds, platforms, lead_minutes)
     values ($1, $2, '{0,1,2,3,4,5,6}', $3, 'America/Sao_Paulo', 75, '{youtube,tiktok}', 180)`,
    [user, work, hhmm],
  );
  await uploadChapter("1");
});

afterAll(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

let jobId: string;

describe("pipeline end to end (server only)", () => {
  it("scheduler materializes the calendar without duplicates and starts the due job", async () => {
    await runTick(edge());
    await runTick(edge()); // second tick must not duplicate jobs
    const jobs = (await db.admin.query("select * from jobs where user_id = $1 order by slot_at", [user])).rows;
    expect(jobs.length).toBe(2); // today + tomorrow inside the 48 h horizon
    jobId = jobs[0].id;
    expect(jobs[1].state).toBe("scheduled");
    const j = await jobRow(jobId);
    expect(j.state).toBe("fetching");
    expect(j.chapter_id).not.toBeNull();
    expect(fake.stats.calls.github_dispatch).toBeGreaterThan(0);
  });

  it("worker slices pages into panels and drops blank ones", async () => {
    await drainQueue(worker(), "worker", WORKER_HANDLERS);
    const j = await jobRow(jobId);
    expect(j.state).toBe("analyzing");
    const out = (await repo.getStep(jobId, "fetching"))!.output as { panels: { id: string; height: number; width: number }[] };
    expect(out.panels.length).toBeGreaterThanOrEqual(3);
    expect(out.panels.some((p) => p.id.startsWith("p003"))).toBe(false); // blank page removed
    expect(out.panels.filter((p) => p.id.startsWith("p001")).length).toBeGreaterThan(1); // strip split
  });

  it("analysis, script with memory, and narration run on the edge", async () => {
    await runTick(edge());
    const j = await jobRow(jobId);
    expect(j.state).toBe("rendering");
    const script = await repo.getScript(jobId);
    expect(script!.word_count).toBeGreaterThan(120);
    const mem = await repo.getMemory(work);
    expect(mem.find((m) => m.name === "Ivan")?.certainty).toBe("confirmed");
    expect(mem.find((m) => m.name === "Promessa")?.certainty).toBe("theory");
    const audio = (await repo.getStep(jobId, "audio_generating"))!.output as { duration: number; video_seconds: number };
    expect(audio.duration).toBeGreaterThan(60);
    expect(audio.video_seconds).toBeGreaterThanOrEqual(60);
    expect(fake.stats.calls.gemini_review).toBe(1);
    const usage = (await db.admin.query("select count(*)::int n from usage_events where user_id = $1 and provider = 'gemini'", [user])).rows[0].n;
    expect(usage).toBeGreaterThanOrEqual(4);
  });

  it("worker renders a valid 1080x1920 video with audio and captions", { timeout: 900_000 }, async () => {
    await drainQueue(worker(), "worker", WORKER_HANDLERS);
    const j = await jobRow(jobId);
    expect(j.state, j.last_error ?? "").toBe("ready_to_publish");
    const video = (await db.admin.query("select * from videos where job_id = $1", [jobId])).rows[0];
    expect(video.validation.ok).toBe(true);
    expect(video.width).toBe(1080);
    expect(video.height).toBe(1920);
    const obj = (await db.admin.query("select * from storage_objects where id = $1", [video.storage_object_id])).rows[0];
    expect(obj.kind).toBe("video");
    const probe = await ffprobe(join(dir, "bucket", obj.path));
    expect(probe.streams?.some((s) => s.codec_type === "audio")).toBe(true);
    const ch = (await db.admin.query("select status from chapters where id = $1", [j.chapter_id])).rows[0];
    expect(ch.status).toBe("processed");
    // intermediates now expire within the grace period
    const audioObj = (await db.admin.query("select expires_at from storage_objects where job_id = $1 and kind = 'audio'", [jobId])).rows[0];
    expect(new Date(audioObj.expires_at).getTime() - Date.now()).toBeLessThanOrEqual(3600_000 + 5000);
  });

  it("publishes only after platform confirmation and never uploads twice", async () => {
    await runTick(edge());
    let pubs = await repo.publications(jobId);
    const yt = pubs.find((p) => p.platform === "youtube")!;
    const tt = pubs.find((p) => p.platform === "tiktok")!;
    expect(yt.remote_id).toBe("yt-video-1");
    expect(tt.status).toBe("pending"); // TikTok has no API scheduling: waits for the slot
    expect((await jobRow(jobId)).state).toBe("publishing");

    // The slot arrives.
    await db.admin.query("update publications set publish_at = now() - interval '1 minute', next_attempt_at = null where job_id = $1", [jobId]);
    await db.admin.query("update jobs set run_at = now() where id = $1", [jobId]);
    await runTick(edge());
    pubs = await repo.publications(jobId);
    expect(pubs.find((p) => p.platform === "youtube")!.status).toBe("published");
    expect(pubs.find((p) => p.platform === "tiktok")!.status).toBe("processing");
    expect((await jobRow(jobId)).state).toBe("publishing");

    await db.admin.query("update jobs set run_at = now() where id = $1", [jobId]);
    await runTick(edge());
    pubs = await repo.publications(jobId);
    expect(pubs.every((p) => p.status === "published" && p.confirmed_at)).toBe(true);
    expect((await jobRow(jobId)).state).toBe("published");
    expect(fake.stats.calls.youtube_start).toBe(1);
    expect(fake.stats.calls.tiktok_init).toBe(1);
    const size = Number((await db.admin.query("select size_bytes from videos where job_id = $1", [jobId])).rows[0].size_bytes);
    expect(fake.stats.youtubeBytes).toBe(size);
    expect(fake.stats.tiktokBytes).toBe(size);
  });

  it("download link starts the 24 h countdown (capped at 48 h after render)", async () => {
    const v = (await db.admin.query("select storage_object_id from videos where job_id = $1", [jobId])).rows[0];
    const r = (await handleApi(edge(), user, { action: "download_url", object_id: v.storage_object_id })) as { url: string; file_expires_at: string; note: string };
    expect(r.url).toContain("video.mp4");
    expect(r.note).toMatch(/não confirma/);
    const left = new Date(r.file_expires_at).getTime() - Date.now();
    expect(left).toBeGreaterThan(23.9 * 3600_000);
    expect(left).toBeLessThanOrEqual(24 * 3600_000);
    // another account cannot download it
    const other = await db.createUser();
    await expect(handleApi(edge(), other, { action: "download_url", object_id: v.storage_object_id })).rejects.toThrow(/não encontrado/);
  });

  it("cleanup deletes expired files but keeps the history", async () => {
    await db.admin.query("update storage_objects set expires_at = now() - interval '1 minute' where user_id = $1 and deleted_at is null", [user]);
    const before = (await db.admin.query("select count(*)::int n, sum(size_bytes)::bigint b from storage_objects where user_id = $1 and deleted_at is null", [user])).rows[0];
    const r1 = await runCleanup(edge());
    expect(r1.failed).toBe(0);
    expect(r1.deleted).toBe(before.n);
    expect(r1.bytes_freed).toBe(Number(before.b));
    const path = (await db.admin.query("select path from storage_objects where job_id = $1 and kind = 'video'", [jobId])).rows[0].path;
    expect(blobs.exists(path)).toBe(false);
    const video = (await db.admin.query("select * from videos where job_id = $1", [jobId])).rows[0];
    expect(video.file_deleted_at).not.toBeNull();
    expect(video.title).toBeTruthy();
    expect((await db.admin.query("select count(*)::int n from scripts where job_id = $1", [jobId])).rows[0].n).toBe(1);
    expect((await db.admin.query("select count(*)::int n from publications where job_id = $1 and status = 'published'", [jobId])).rows[0].n).toBe(2);
    // idempotent
    const r2 = await runCleanup(edge());
    expect(r2.deleted).toBe(0);
    expect(r2.failed).toBe(0);
    const runs = (await db.admin.query("select count(*)::int n from cleanup_runs where finished_at is not null")).rows[0].n;
    expect(runs).toBe(2);
  });
});

describe("recovery and limits", () => {
  let second: string;
  it("a cost limit pauses the account and the job resumes after reactivation", async () => {
    await uploadChapter("2");
    second = (await db.admin.query("select id from jobs where user_id = $1 and state = 'scheduled'", [user])).rows[0].id;
    await repo.requestJobAction(user, second, "run_now");
    await runTick(edge());
    await drainQueue(worker(), "worker", WORKER_HANDLERS);
    expect((await jobRow(second)).state).toBe("analyzing");

    await db.admin.query("update user_settings set gemini_tier = 'paid', daily_cost_limit_usd = 0 where user_id = $1", [user]);
    await runTick(edge());
    const s = (await db.admin.query("select automation_paused, pause_reason from user_settings where user_id = $1", [user])).rows[0];
    expect(s.automation_paused).toBe(true);
    expect(s.pause_reason).toMatch(/Limite diário/);
    expect((await jobRow(second)).state).toBe("analyzing"); // preserved, not failed

    await db.admin.query("update user_settings set daily_cost_limit_usd = 10 where user_id = $1", [user]);
    await handleApi(edge(), user, { action: "resume_automation" });
    await runTick(edge());
    expect((await jobRow(second)).state).toBe("rendering");
    const spent = Number((await jobRow(second)).cost_spent_usd);
    expect(spent).toBeGreaterThan(0);
  });

  it("a render failure retries from the render step without repeating finished steps", { timeout: 900_000 }, async () => {
    const scriptsBefore = fake.stats.calls.gemini_script;
    const ttsBefore = fake.stats.calls.gemini_tts;
    const audioPath = ((await repo.getStep(second, "audio_generating"))!.output as { path: string }).path;
    blobs.failNextGet.add(audioPath);
    await drainQueue(worker(), "worker", WORKER_HANDLERS);
    let j = await jobRow(second);
    expect(j.state).toBe("retry_wait");
    expect(j.resume_state).toBe("rendering");
    expect(j.attempts).toBe(1);

    await db.admin.query("update jobs set next_attempt_at = now() - interval '1 second' where id = $1", [second]);
    await repo.promoteDueJobs();
    await drainQueue(worker(), "worker", WORKER_HANDLERS);
    j = await jobRow(second);
    expect(j.state, j.last_error ?? "").toBe("ready_to_publish");
    expect(fake.stats.calls.gemini_script).toBe(scriptsBefore);
    expect(fake.stats.calls.gemini_tts).toBe(ttsBefore);
  });

  it("does not invent content when there is no new chapter", async () => {
    const w = (await db.admin.query(
      "insert into works (user_id, title, type, source, status, authorization_status) values ($1, 'Sem capítulos', 'manga', 'upload', 'active', 'authorized') returning id",
      [user],
    )).rows[0].id;
    const id = (await db.admin.query(
      "insert into jobs (user_id, work_id, slot_at, run_at, dedupe_key, state) values ($1, $2, now() + interval '1 hour', now(), 'nochap', 'queued') returning id",
      [user, w],
    )).rows[0].id;
    const calls = fake.stats.calls.gemini_script;
    await runTick(edge());
    const j = await jobRow(id);
    expect(j.state).toBe("retry_wait");
    expect(j.waiting_reason).toMatch(/nenhum acontecimento será inventado/);
    expect(j.attempts).toBe(0);
    expect(fake.stats.calls.gemini_script).toBe(calls);
  });
});
