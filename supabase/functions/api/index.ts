// Authenticated API for the web app (requires the user's Supabase JWT).

import { corsHeaders, env, json, makeCtx, userFrom } from "../_shared/edge.ts";
import { ApiError, handleApi } from "../_shared/api.ts";
import { redact } from "../_shared/core/crypto.ts";

Deno.serve(async (req) => {
  const e = env();
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders(e) });
  if (req.method !== "POST") return json(e, { error: "Use POST" }, 405);
  const userId = await userFrom(req, e);
  if (!userId) return json(e, { error: "Sessão inválida" }, 401);
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json(e, { error: "JSON inválido" }, 400);
  }
  const ctx = makeCtx(e, `api-${crypto.randomUUID().slice(0, 8)}`, 120_000);
  try {
    return json(e, await handleApi(ctx, userId, body));
  } catch (err) {
    const status = err instanceof ApiError ? err.status : 500;
    const message = redact((err as Error).message ?? String(err));
    if (status >= 500) await ctx.repo.log({ user_id: userId, level: "error", event: "api_error", message, data: { action: body.action } }).catch(() => {});
    return json(e, { error: message }, status);
  }
});
