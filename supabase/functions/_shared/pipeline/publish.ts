// Publishing to YouTube and TikTok. A publication is only marked
// "published" after the platform itself confirms it; remote ids are stored
// so a retry never uploads the same video twice.

import { backoffSeconds, StepError, toStepError } from "../core/backoff.ts";
import { redact } from "../core/crypto.ts";
import type { Job, Platform } from "../core/types.ts";
import { urlSource } from "../adapters/bytes.ts";
import type { Publication } from "../adapters/repo.ts";
import { initDirectPost, interpretTikTokStatus, postStatus, uploadTikTok } from "../adapters/tiktok.ts";
import { interpretYouTubeStatus, queryUploadOffset, startResumableUpload, uploadChunks, videoStatus } from "../adapters/youtube.ts";
import { accessTokenFor, type Ctx, remainingMs } from "./context.ts";
import type { StepOutcome } from "./runner.ts";

const FINAL = new Set(["published", "failed", "cancelled"]);

/** Called by the tick: move validated videos into publishing near their slot. */
export async function startPublishing(ctx: Ctx, limit = 5): Promise<number> {
  const jobs = await ctx.repo.readyJobsDueForPublishing(limit);
  let n = 0;
  for (const job of jobs) {
    const script = await ctx.repo.getScript(job.id);
    const video = await ctx.repo.getVideo(job.id);
    if (!script || !video) continue;
    const settings = await ctx.repo.getSettings(job.user_id);
    const tags = script.hashtags.join(" ");
    await ctx.repo.createPublications(job.platforms.map((platform: Platform) => ({
      user_id: job.user_id,
      job_id: job.id,
      video_id: video.id,
      platform,
      title: script.title,
      description: `${script.description}\n\n${tags}`.trim(),
      privacy: platform === "youtube" ? settings.youtube_privacy : settings.tiktok_privacy,
      publish_at: job.slot_at,
    })));
    try {
      await ctx.repo.transition(job.id, null, "publishing");
      n++;
    } catch {
      // claimed or changed meanwhile
    }
  }
  return n;
}

export async function publish(ctx: Ctx, job: Job): Promise<StepOutcome> {
  const settings = await ctx.repo.getSettings(job.user_id);
  const video = await ctx.repo.getVideo(job.id);
  if (!video) throw new StepError("Vídeo não encontrado para publicação", "permanent");
  const pubs = await ctx.repo.publications(job.id);
  const objects = video.storage_object_id ? await ctx.repo.objectsForJob(job.id, ["video"]) : [];
  const file = objects.find((o) => o.id === video.storage_object_id);

  for (const pub of pubs) {
    if (FINAL.has(pub.status)) continue;
    if (pub.next_attempt_at && new Date(pub.next_attempt_at) > ctx.now()) continue;
    if (remainingMs(ctx) < 25_000) break;
    try {
      if (pub.platform === "youtube") await publishYouTube(ctx, job, pub, file, settings.ai_disclosure);
      else await publishTikTok(ctx, job, pub, file, settings.ai_disclosure, Number(video.duration_seconds));
    } catch (e) {
      const err = toStepError(e);
      const attempts = pub.attempts + 1;
      const final = err.kind === "permanent" || err.kind === "config" || attempts >= 5;
      await ctx.repo.updatePublication(pub.id, {
        attempts,
        last_error: redact(err.message),
        status: final ? "failed" : pub.status === "pending" ? "pending" : pub.status,
        next_attempt_at: final ? null : new Date(ctx.now().getTime() + (err.retryAfterSeconds ?? backoffSeconds(attempts)) * 1000).toISOString(),
      });
      await ctx.repo.log({ user_id: job.user_id, job_id: job.id, level: final ? "error" : "warn", event: `publish_${pub.platform}_error`, message: redact(err.message) });
    }
  }

  const after = await ctx.repo.publications(job.id);
  if (after.every((p) => p.status === "published")) return { next: "published" };
  const pending = after.filter((p) => !FINAL.has(p.status));
  if (pending.length > 0) {
    return { stay: true, delaySeconds: 120, reason: pending.map((p) => `${p.platform}: ${p.status}`).join(", ") };
  }
  const failed = after.filter((p) => p.status === "failed");
  throw new StepError(`Publicação não confirmada: ${failed.map((p) => `${p.platform} (${p.last_error ?? "erro"})`).join("; ")}`, "permanent");
}

async function videoSource(ctx: Ctx, file: { path: string; size_bytes: number } | undefined) {
  if (!file) throw new StepError("Arquivo do vídeo já foi excluído pela política de retenção; renderize novamente", "permanent");
  const url = await ctx.blobs.signedUrl(file.path, 3600);
  return urlSource(ctx.fetch, url, Number(file.size_bytes), "video/mp4");
}

async function publishYouTube(ctx: Ctx, job: Job, pub: Publication, file: { path: string; size_bytes: number } | undefined, aiDisclosure: boolean) {
  const tokens = await accessTokenFor(ctx, job.user_id, "youtube");
  if (pub.remote_id) {
    const s = await videoStatus(ctx.fetch, tokens.access_token, pub.remote_id);
    const st = interpretYouTubeStatus(s, ctx.now());
    await ctx.repo.updatePublication(pub.id, {
      status: st.state === "published" ? "published" : st.state === "scheduled" ? "scheduled" : st.state === "failed" ? "failed" : "processing",
      confirmed_at: st.state === "published" || st.state === "scheduled" ? ctx.now().toISOString() : null,
      last_error: st.state === "failed" ? st.detail : null,
      response: s,
    });
    // A scheduled video is only "published" after its time passes and YouTube reports it.
    if (st.state === "scheduled") await ctx.repo.updatePublication(pub.id, { next_attempt_at: s.publishAt ?? null });
    return;
  }
  const source = await videoSource(ctx, file);
  let session = pub.upload_session_url;
  let offset = 0;
  if (session) {
    const q = await queryUploadOffset(ctx.fetch, session, source.size).catch(() => null);
    if (q?.done) return confirmYouTubeUpload(ctx, pub, q.video.id);
    if (q) offset = q.offset;
    else session = null;
  }
  if (!session) {
    session = await startResumableUpload(ctx.fetch, tokens.access_token, {
      title: pub.title ?? "Resumo",
      description: pub.description ?? "",
      tags: (pub.description ?? "").match(/#[\p{L}\p{N}_]+/gu) ?? [],
      privacyStatus: (pub.privacy as "private" | "unlisted" | "public") ?? "private",
      publishAt: pub.publish_at ?? undefined,
      containsSyntheticMedia: aiDisclosure,
    }, source.size);
    await ctx.repo.updatePublication(pub.id, { upload_session_url: session, status: "uploading" });
  }
  const r = await uploadChunks(ctx.fetch, session, source, offset, ctx.deadline - 15_000);
  if (!r.done) {
    await ctx.repo.log({ user_id: job.user_id, job_id: job.id, level: "info", event: "youtube_upload_partial", message: `${r.offset}/${source.size} bytes` });
    return;
  }
  await confirmYouTubeUpload(ctx, pub, r.video.id);
}

async function confirmYouTubeUpload(ctx: Ctx, pub: Publication, videoId: string) {
  await ctx.repo.updatePublication(pub.id, {
    remote_id: videoId,
    remote_url: `https://www.youtube.com/shorts/${videoId}`,
    status: "processing",
    upload_session_url: null,
    last_error: null,
  });
}

async function publishTikTok(
  ctx: Ctx, job: Job, pub: Publication, file: { path: string; size_bytes: number } | undefined, aiDisclosure: boolean, duration: number,
) {
  const tokens = await accessTokenFor(ctx, job.user_id, "tiktok");
  const publishId = pub.upload_session_url?.startsWith("tiktok:") ? pub.upload_session_url.slice(7) : null;
  if (publishId) {
    const s = await postStatus(ctx.fetch, tokens.access_token, publishId);
    const st = interpretTikTokStatus(s);
    await ctx.repo.updatePublication(pub.id, {
      status: st.state === "published" ? "published" : st.state === "failed" ? "failed" : "processing",
      remote_id: st.postId ?? (st.state === "published" ? publishId : null),
      remote_url: st.postId ? `https://www.tiktok.com/video/${st.postId}` : null,
      confirmed_at: st.state === "published" ? ctx.now().toISOString() : null,
      last_error: st.state === "failed" ? st.detail : null,
      response: s,
    });
    return;
  }
  // TikTok's API has no scheduling: post only when the slot arrives.
  if (pub.publish_at && new Date(pub.publish_at) > ctx.now()) {
    await ctx.repo.updatePublication(pub.id, { next_attempt_at: pub.publish_at });
    return;
  }
  const source = await videoSource(ctx, file);
  const init = await initDirectPost(ctx.fetch, tokens.access_token, {
    title: `${pub.title ?? ""}\n${pub.description ?? ""}`.trim(),
    privacy: pub.privacy ?? "SELF_ONLY",
    isAigc: aiDisclosure,
    durationSeconds: duration,
  }, source.size);
  // Store the publish id first: if the upload breaks we never init twice.
  await ctx.repo.updatePublication(pub.id, { upload_session_url: `tiktok:${init.publishId}`, status: "uploading", privacy: init.privacy });
  await uploadTikTok(ctx.fetch, init.uploadUrl, source);
  await ctx.repo.updatePublication(pub.id, { status: "processing" });
}
