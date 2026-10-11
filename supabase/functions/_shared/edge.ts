// Deno-only glue shared by the Edge Function entry points.

import { createClient } from "@supabase/supabase-js";
import { safeEqual } from "./core/crypto.ts";
import { SupabaseBlobs, SupabaseRepo, serviceClient } from "./adapters/supabase_repo.ts";
import type { Ctx, Env } from "./pipeline/context.ts";

declare const Deno: { env: { toObject(): Record<string, string> } };
declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

export function env(): Env {
  return Deno.env.toObject() as Env;
}

/** Free plan wall clock is 150 s; keep a safety margin. */
export const WALL_CLOCK_MS = 135_000;

export function makeCtx(e: Env, workerId: string, budgetMs = WALL_CLOCK_MS): Ctx {
  const db = serviceClient(e.SUPABASE_URL!, e.SUPABASE_SERVICE_ROLE_KEY!);
  return {
    repo: new SupabaseRepo(db),
    blobs: new SupabaseBlobs(db),
    env: e,
    fetch: (input, init) => fetch(input, init),
    workerId,
    deadline: Date.now() + budgetMs,
    now: () => new Date(),
  };
}

export function corsHeaders(e: Env): Record<string, string> {
  return {
    "access-control-allow-origin": e.APP_URL ? new URL(e.APP_URL).origin : "*",
    "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    vary: "origin",
  };
}

export function json(e: Env, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders(e), "content-type": "application/json; charset=utf-8" } });
}

/** Cron-only endpoints: compare the shared secret in constant time. */
export function isCron(req: Request, e: Env): boolean {
  const got = req.headers.get("x-cron-secret") ?? "";
  return !!e.CRON_SECRET && safeEqual(got, e.CRON_SECRET);
}

/** Resolve the calling user from the Supabase JWT (Authorization header). */
export async function userFrom(req: Request, e: Env): Promise<string | null> {
  const auth = req.headers.get("authorization") ?? "";
  const jwt = auth.replace(/^Bearer\s+/i, "");
  if (!jwt) return null;
  const client = createClient(e.SUPABASE_URL!, e.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const { data, error } = await client.auth.getUser(jwt);
  if (error || !data.user) return null;
  return data.user.id;
}

/** Answer immediately and keep working in the background (Supabase background tasks). */
export function background(task: Promise<unknown>): void {
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) EdgeRuntime.waitUntil(task);
}
