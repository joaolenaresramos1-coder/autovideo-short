// Retention cleanup — invoked by pg_cron every 20 minutes.

import { background, env, isCron, json, makeCtx } from "../_shared/edge.ts";
import { redact } from "../_shared/core/crypto.ts";
import { runCleanup } from "../_shared/pipeline/cleanup.ts";

Deno.serve(async (req) => {
  const e = env();
  if (!isCron(req, e)) return json(e, { error: "não autorizado" }, 401);
  const ctx = makeCtx(e, `cleanup-${crypto.randomUUID().slice(0, 8)}`);
  const work = runCleanup(ctx)
    .then((r) => ctx.repo.log({ level: r.failed ? "warn" : "info", event: "cleanup", data: r }))
    .catch((err) => ctx.repo.log({ level: "error", event: "cleanup_failed", message: redact(String(err?.message ?? err)) }));
  background(work);
  return json(e, { accepted: true }, 202);
});
