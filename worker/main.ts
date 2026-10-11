// Render worker entry point (GitHub Actions). Claims worker jobs from the
// queue and processes them until the queue is empty or the time budget ends.
//   node worker/main.ts

import { hostname } from "node:os";
import { SupabaseBlobs, SupabaseRepo, serviceClient } from "../supabase/functions/_shared/adapters/supabase_repo.ts";
import type { Ctx, Env } from "../supabase/functions/_shared/pipeline/context.ts";
import { drainQueue } from "../supabase/functions/_shared/pipeline/runner.ts";
import { ffmpegOk } from "./ffmpeg.ts";
import { WORKER_HANDLERS } from "./steps.ts";

async function main() {
  const env = process.env as Env & { WORKER_BUDGET_MINUTES?: string };
  for (const k of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "TOKEN_ENCRYPTION_KEY"] as const) {
    if (!env[k]) {
      console.error(`Variável ausente: ${k} (configure os secrets do repositório)`);
      process.exit(2);
    }
  }
  if (!(await ffmpegOk())) {
    console.error("FFmpeg não encontrado no PATH");
    process.exit(2);
  }
  const db = serviceClient(env.SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);
  const budget = Number(env.WORKER_BUDGET_MINUTES ?? 40) * 60_000;
  const ctx: Ctx = {
    repo: new SupabaseRepo(db),
    blobs: new SupabaseBlobs(db),
    env,
    fetch: (i, init) => fetch(i, init),
    workerId: `gha-${process.env.GITHUB_RUN_ID ?? hostname()}-${process.pid}`,
    deadline: Date.now() + budget,
    now: () => new Date(),
  };
  // Re-check the queue a few times: edge steps may hand new work over while we run.
  let idleRounds = 0;
  let total = 0;
  // Exit quickly when there is nothing to do (each run costs Actions minutes).
  while (Date.now() < ctx.deadline - 120_000 && idleRounds < (total === 0 ? 1 : 2)) {
    await ctx.repo.promoteDueJobs();
    const r = await drainQueue(ctx, "worker", WORKER_HANDLERS, { maxJobs: 50 });
    total += r.processed;
    for (const e of r.errors) console.error("erro:", e);
    if (r.processed === 0) {
      idleRounds++;
      await new Promise((res) => setTimeout(res, 20_000));
    } else {
      idleRounds = 0;
    }
  }
  console.log(`Worker finalizado: ${total} etapa(s) processada(s)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
