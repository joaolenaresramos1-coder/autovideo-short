// Executes claimed jobs step by step with checkpoints, bounded retries,
// exponential backoff and a persistent failure queue.

import { backoffSeconds, StepError, toStepError } from "../core/backoff.ts";
import { redact } from "../core/crypto.ts";
import { type JobState, STEP_EXECUTOR, type WorkState } from "../core/states.ts";
import type { Job } from "../core/types.ts";
import { type Ctx, dispatchWorker } from "./context.ts";

export type StepOutcome =
  | { next: JobState; output?: unknown }
  /** Step needs more time: keep the state, run again later. */
  | { stay: true; delaySeconds?: number; reason?: string; output?: unknown };

export type StepHandler = (ctx: Ctx, job: Job) => Promise<StepOutcome>;

/** Minimum time (ms) that must remain before starting each step. */
export const STEP_BUDGET_MS: Partial<Record<JobState, number>> = {
  discovering: 20_000,
  analyzing: 90_000,
  scripting: 70_000,
  audio_generating: 100_000,
  publishing: 40_000,
  fetching: 60_000,
  rendering: 120_000,
  validating: 30_000,
};

const LEASE_SECONDS: Partial<Record<JobState, number>> = {
  rendering: 1800,
  fetching: 900,
  validating: 600,
};

export async function runClaimedJob(
  ctx: Ctx,
  claimed: Job,
  handlers: Partial<Record<JobState, StepHandler>>,
  chain = true,
): Promise<Job> {
  const { repo, workerId } = ctx;
  let job = claimed;
  try {
    if (job.state === "queued") job = await repo.transition(job.id, workerId, "discovering", { keepLock: true });
  } catch (e) {
    await repo.releaseJob(job.id, workerId);
    throw e;
  }

  for (;;) {
    const state = job.state;
    const handler = handlers[state];
    if (!handler || ctx.deadline - ctx.now().getTime() < (STEP_BUDGET_MS[state] ?? 30_000)) {
      await repo.releaseJob(job.id, workerId);
      return job;
    }
    await repo.renewLease(job.id, workerId, LEASE_SECONDS[state] ?? 300);
    await repo.saveStep(job.id, state, "running");
    let outcome: StepOutcome;
    try {
      outcome = await handler(ctx, job);
    } catch (e) {
      const err = toStepError(e);
      await repo.saveStep(job.id, state, "failed", undefined, redact(err.message));
      return await handleStepError(ctx, job, err);
    }

    if ("stay" in outcome) {
      await repo.saveStep(job.id, state, "running", outcome.output);
      if (outcome.delaySeconds) await delayJob(ctx, job, outcome.delaySeconds);
      if (outcome.reason) await repo.log({ user_id: job.user_id, job_id: job.id, level: "info", event: "step_waiting", message: outcome.reason });
      await repo.releaseJob(job.id, workerId);
      return job;
    }

    await repo.saveStep(job.id, state, "succeeded", outcome.output);
    try {
      job = await repo.transition(job.id, workerId, outcome.next, { keepLock: true });
    } catch (e) {
      // e.g. the user cancelled the job while the step was running
      await repo.log({ user_id: job.user_id, job_id: job.id, level: "warn", event: "transition_rejected", message: redact(String((e as Error).message)) });
      await repo.releaseJob(job.id, workerId);
      return job;
    }
    if (!chain) {
      await repo.releaseJob(job.id, workerId);
      if (needsWorker(job.state, handlers)) await dispatchWorker(ctx, `${job.state} ${job.id}`);
      return job;
    }
    if (needsWorker(job.state, handlers)) {
      // the next step runs on the render worker: release the job, then wake it
      await repo.releaseJob(job.id, workerId);
      await dispatchWorker(ctx, `${job.state} ${job.id}`);
      return job;
    }
  }
}

/** The job moved to a worker step that this runner (the Edge) cannot run. */
function needsWorker(state: JobState, handlers: Partial<Record<JobState, StepHandler>>): boolean {
  return !handlers[state] && STEP_EXECUTOR[state as WorkState] === "worker";
}

async function delayJob(ctx: Ctx, job: Job, seconds: number) {
  // run_at gates claim_jobs: the job will not be picked again before it.
  await ctx.repo.updateJob(job.id, { run_at: new Date(ctx.now().getTime() + seconds * 1000).toISOString() });
}

export async function handleStepError(ctx: Ctx, job: Job, err: StepError): Promise<Job> {
  const { repo, workerId } = ctx;
  const message = redact(err.message);
  await repo.log({ user_id: job.user_id, job_id: job.id, level: err.kind === "waiting" ? "info" : "error", event: `step_${err.kind}`, message, data: { state: job.state } });
  try {
    switch (err.kind) {
      case "quota":
        // The account is paused; the job keeps its state and checkpoint and
        // resumes when the user reactivates automation.
        await repo.releaseJob(job.id, workerId);
        return job;
      case "waiting":
        return await repo.transition(job.id, workerId, "retry_wait", {
          retryInSeconds: err.retryAfterSeconds ?? 3600,
          waitingReason: message,
        });
      case "retryable": {
        const attempt = job.attempts + 1;
        if (attempt >= job.max_attempts) {
          await repo.raiseAlert(job.user_id, "job_failed", "warning", `Tarefa falhou após ${attempt} tentativas: ${message}`, `job_failed:${job.id}`);
          return await repo.transition(job.id, workerId, "failed", { error: message, countAttempt: true });
        }
        return await repo.transition(job.id, workerId, "retry_wait", {
          error: message,
          countAttempt: true,
          retryInSeconds: err.retryAfterSeconds ?? backoffSeconds(attempt),
        });
      }
      case "config":
        await repo.raiseAlert(job.user_id, "config", "critical", `Configuração pendente: ${message}`, `config:${message.slice(0, 80)}`);
        return await repo.transition(job.id, workerId, "failed", { error: `Configuração pendente: ${message}`, countAttempt: true });
      default:
        return await repo.transition(job.id, workerId, "failed", { error: message, countAttempt: true });
    }
  } catch (e) {
    await repo.releaseJob(job.id, workerId).catch(() => {});
    throw e;
  }
}

/** Claim and run jobs for one executor until the deadline. */
export async function drainQueue(
  ctx: Ctx,
  executor: "edge" | "worker",
  handlers: Partial<Record<JobState, StepHandler>>,
  opts: { batch?: number; maxJobs?: number } = {},
): Promise<{ processed: number; errors: string[] }> {
  let processed = 0;
  const errors: string[] = [];
  const max = opts.maxJobs ?? 20;
  while (processed < max && ctx.deadline - ctx.now().getTime() > 15_000) {
    const jobs = await ctx.repo.claimJobs(executor, ctx.workerId, opts.batch ?? 1, executor === "worker" ? 1800 : 170);
    if (jobs.length === 0) break;
    for (const job of jobs) {
      try {
        await runClaimedJob(ctx, job, handlers);
      } catch (e) {
        errors.push(redact((e as Error).message));
        await ctx.repo.releaseJob(job.id, ctx.workerId).catch(() => {});
      }
      processed++;
    }
  }
  return { processed, errors };
}

export { StepError };
