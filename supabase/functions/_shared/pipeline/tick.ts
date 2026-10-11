// One scheduler "tick" (pg_cron, every minute): calendar materialisation,
// source monitoring, queue promotion and execution of edge steps.

import { redact } from "../core/crypto.ts";
import { expandSchedule } from "../core/schedule.ts";
import type { JobState } from "../core/states.ts";
import { connectorFor } from "../connectors/index.ts";
import type { NewJob } from "../adapters/repo.ts";
import { type Ctx, dispatchWorker } from "./context.ts";
import { analyze, discover, generateAudio, writeScript } from "./edge_steps.ts";
import { publish, startPublishing } from "./publish.ts";
import { drainQueue, type StepHandler } from "./runner.ts";

export const EDGE_HANDLERS: Partial<Record<JobState, StepHandler>> = {
  discovering: discover,
  analyzing: analyze,
  scripting: writeScript,
  audio_generating: generateAudio,
  publishing: publish,
};

const HORIZON_MS = 48 * 3600_000;

/** Create jobs for calendar slots in the next 48 h (idempotent by dedupe key). */
export async function materializeSchedules(ctx: Ctx): Promise<number> {
  const now = ctx.now();
  const horizon = new Date(now.getTime() + HORIZON_MS);
  let created = 0;
  for (const s of await ctx.repo.activeSchedules()) {
    const from = s.materialized_until ? new Date(Math.max(new Date(s.materialized_until).getTime(), now.getTime() - 3600_000)) : now;
    if (from >= horizon) continue;
    const settings = await ctx.repo.getSettings(s.user_id);
    const rows: NewJob[] = expandSchedule(s, from, horizon).map((slot) => ({
      user_id: s.user_id,
      work_id: s.work_id,
      schedule_id: s.id,
      summary_format: s.summary_format,
      target_duration_seconds: s.target_duration_seconds,
      platforms: s.platforms,
      priority: s.priority,
      slot_at: slot.slotAt.toISOString(),
      run_at: slot.runAt.toISOString(),
      dedupe_key: slot.dedupeKey,
      cost_limit_usd: s.cost_limit_usd,
      max_attempts: settings.max_attempts ?? 5,
    }));
    created += await ctx.repo.insertJobs(rows);
    await ctx.repo.markMaterialized(s.id, horizon.toISOString());
  }
  return created;
}

/** Check a few works for new chapters and refresh their source status. */
export async function monitorWorks(ctx: Ctx, limit = 3): Promise<{ checked: number; newChapters: number }> {
  let newChapters = 0;
  const works = await ctx.repo.worksDueForCheck(limit);
  for (const work of works) {
    const connector = connectorFor(work);
    const next = new Date(ctx.now().getTime() + work.monitor_interval_minutes * 60_000).toISOString();
    try {
      const check = await connector.check(work, ctx.fetch);
      const patch: Record<string, unknown> = {
        status: check.status === "active" ? "active" : check.status,
        status_reason: check.reason,
        last_checked_at: ctx.now().toISOString(),
        next_check_at: next,
      };
      if (check.sourceRef && !work.source_ref) patch.source_ref = check.sourceRef;
      if (check.status === "active" && connector.detectsChapters) {
        const added = await ctx.repo.upsertChapters(work.user_id, work.id, await connector.listChapters(work, ctx.fetch));
        newChapters += added;
        if (added > 0) {
          await ctx.repo.log({ user_id: work.user_id, level: "info", event: "chapters_found", message: `${work.title}: ${added} capítulo(s) novo(s)` });
        }
      }
      await ctx.repo.updateWork(work.id, patch);
    } catch (e) {
      await ctx.repo.updateWork(work.id, {
        status: "error",
        status_reason: `Falha ao ler o link da obra: ${redact((e as Error).message)}`,
        last_checked_at: ctx.now().toISOString(),
        next_check_at: next,
      });
    }
  }
  return { checked: works.length, newChapters };
}

export async function runTick(ctx: Ctx) {
  const report: Record<string, unknown> = {};
  report.promoted = await ctx.repo.promoteDueJobs();
  // jobs resumed after a retry may continue on the render worker
  if (Number(report.promoted) > 0) report.worker_dispatched = await dispatchWorker(ctx, "resumed jobs");
  report.materialized = await materializeSchedules(ctx);
  report.monitor = await monitorWorks(ctx);
  report.publishing_started = await startPublishing(ctx);
  report.edge = await drainQueue(ctx, "edge", EDGE_HANDLERS, { maxJobs: 6 });
  return report;
}
