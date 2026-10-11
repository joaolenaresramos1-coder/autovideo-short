// Scheduler tick — invoked every minute by pg_cron (see migrations).
// Deployed with --no-verify-jwt; protected by the x-cron-secret header.

import { background, env, isCron, json, makeCtx } from "../_shared/edge.ts";
import { redact } from "../_shared/core/crypto.ts";
import { runTick } from "../_shared/pipeline/tick.ts";

Deno.serve(async (req) => {
  const e = env();
  if (!isCron(req, e)) return json(e, { error: "não autorizado" }, 401);
  const ctx = makeCtx(e, `edge-${crypto.randomUUID().slice(0, 8)}`);
  const work = runTick(ctx)
    .then((r) => ctx.repo.log({ level: "debug", event: "tick", data: r }))
    .catch((err) => ctx.repo.log({ level: "error", event: "tick_failed", message: redact(String(err?.message ?? err)) }));
  if (new URL(req.url).searchParams.get("wait") === "1") {
    await work;
    return json(e, { ok: true });
  }
  background(work);
  return json(e, { accepted: true }, 202);
});
