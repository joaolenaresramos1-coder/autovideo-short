// Scheduler tick — invoked every minute by pg_cron (see migrations).
// Deployed with --no-verify-jwt; protected by the x-cron-secret header.

import { background, env, isCron, json, makeCtx } from "../_shared/edge.ts";
import { redact } from "../_shared/core/crypto.ts";
import { runTick } from "../_shared/pipeline/tick.ts";
import { serviceClient } from "../_shared/adapters/supabase_repo.ts";

Deno.serve(async (req) => {
  const e = env();
  if (!isCron(req, e)) return json(e, { error: "não autorizado" }, 401);
  // One-time setup called by the deploy workflow: registers URL/secret in Vault and the cron jobs.
  if (new URL(req.url).searchParams.get("setup") === "1") {
    const db = serviceClient(e.SUPABASE_URL!, e.SUPABASE_SERVICE_ROLE_KEY!);
    const r = await db.rpc("configure_scheduler", { p_url: e.SUPABASE_URL, p_secret: e.CRON_SECRET });
    return json(e, r.error ? { ok: false, error: r.error.message } : { ok: true, result: r.data }, r.error ? 500 : 200);
  }
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
