// OAuth redirect target: /functions/v1/oauth/callback/{youtube|tiktok}
// Deployed with --no-verify-jwt (the provider redirects the browser here).
// Starting the flow goes through the authenticated `api` function.

import { env, json, makeCtx } from "../_shared/edge.ts";
import { handleOAuthCallback } from "../_shared/oauth_flow.ts";

Deno.serve(async (req) => {
  const e = env();
  const url = new URL(req.url);
  const m = /\/oauth\/callback\/([a-z]+)\/?$/.exec(url.pathname);
  if (req.method !== "GET" || !m) return json(e, { error: "não encontrado" }, 404);
  const ctx = makeCtx(e, "oauth", 60_000);
  const location = await handleOAuthCallback(ctx, m[1], url.searchParams);
  return new Response(null, { status: 302, headers: { location, "cache-control": "no-store" } });
});
