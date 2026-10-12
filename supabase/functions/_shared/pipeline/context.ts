import { StepError } from "../core/backoff.ts";
import { open, seal } from "../core/crypto.ts";
import { estimateCostUsd } from "../core/pricing.ts";
import type { Job, UserSettings } from "../core/types.ts";
import { GeminiClient, type GeminiUsage } from "../adapters/gemini.ts";
import type { FetchLike } from "../adapters/http.ts";
import { needsRefresh, type OAuthConfig, type OAuthProvider, refreshToken, type TokenSet } from "../adapters/oauth.ts";
import type { Blobs, Repo } from "../adapters/repo.ts";

export interface Env {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  TOKEN_ENCRYPTION_KEY?: string;
  CRON_SECRET?: string;
  GEMINI_API_KEY?: string;
  APP_URL?: string;
  YOUTUBE_CLIENT_ID?: string;
  YOUTUBE_CLIENT_SECRET?: string;
  TIKTOK_CLIENT_KEY?: string;
  TIKTOK_CLIENT_SECRET?: string;
  GITHUB_DISPATCH_TOKEN?: string;
  GITHUB_REPOSITORY?: string;
  SHOTSTACK_API_KEY?: string;
  SHOTSTACK_ENV?: string;
}

/**
 * Runs a prompt through Claude Code with the user's Claude subscription
 * (only on the render worker, where the CLI and its token exist).
 */
export type ClaudeCliFn = (req: {
  model: string;
  prompt: string;
  images: { name: string; bytes: Uint8Array }[];
  schema: unknown;
  timeoutMs: number;
}) => Promise<{ data: unknown; inputTokens: number; outputTokens: number }>;

export interface Ctx {
  repo: Repo;
  blobs: Blobs;
  env: Env;
  fetch: FetchLike;
  workerId: string;
  /** Epoch ms after which no new step may start. */
  deadline: number;
  now(): Date;
  /** Present on the worker when CLAUDE_CODE_OAUTH_TOKEN is configured. */
  claudeCli?: ClaudeCliFn;
}

export function remainingMs(ctx: Ctx): number {
  return ctx.deadline - ctx.now().getTime();
}

export function requireEnv(env: Env, name: keyof Env): string {
  const v = env[name];
  if (!v) throw new StepError(`Variável de ambiente ausente no servidor: ${name}`, "config");
  return v;
}

const aad = (userId: string, name: string) => `${userId}:${name}`;

export async function putUserSecret(ctx: Ctx, userId: string, name: string, value: string): Promise<void> {
  const sealed = await seal(value, requireEnv(ctx.env, "TOKEN_ENCRYPTION_KEY"), aad(userId, name));
  await ctx.repo.putSecret(userId, name, sealed);
}

export async function getUserSecret(ctx: Ctx, userId: string, name: string): Promise<string | null> {
  const sealed = await ctx.repo.getSecret(userId, name);
  if (!sealed) return null;
  try {
    return await open(sealed, requireEnv(ctx.env, "TOKEN_ENCRYPTION_KEY"), aad(userId, name));
  } catch {
    throw new StepError(`Não foi possível decifrar o segredo "${name}" (chave de criptografia alterada?)`, "config");
  }
}

/** The user's own Gemini key, or the project-wide key from the environment. */
export async function geminiFor(ctx: Ctx, userId: string): Promise<GeminiClient> {
  const key = (await getUserSecret(ctx, userId, "gemini_api_key")) ?? ctx.env.GEMINI_API_KEY;
  if (!key) throw new StepError("Chave da API Gemini não configurada (Integrações → Gemini)", "config");
  return new GeminiClient(key, ctx.fetch);
}

export function oauthConfig(env: Env, provider: OAuthProvider): OAuthConfig {
  const base = `${requireEnv(env, "SUPABASE_URL")}/functions/v1/oauth/callback/${provider}`;
  if (provider === "youtube") {
    return { clientId: requireEnv(env, "YOUTUBE_CLIENT_ID"), clientSecret: requireEnv(env, "YOUTUBE_CLIENT_SECRET"), redirectUri: base };
  }
  return { clientId: requireEnv(env, "TIKTOK_CLIENT_KEY"), clientSecret: requireEnv(env, "TIKTOK_CLIENT_SECRET"), redirectUri: base };
}

/** Valid access token for a connected account, refreshed when close to expiry. */
export async function accessTokenFor(ctx: Ctx, userId: string, provider: OAuthProvider): Promise<TokenSet> {
  const raw = await getUserSecret(ctx, userId, `oauth:${provider}`);
  if (!raw) throw new StepError(`Conta ${provider === "youtube" ? "do YouTube" : "do TikTok"} não conectada`, "config");
  let tokens = JSON.parse(raw) as TokenSet;
  if (needsRefresh(tokens, ctx.now())) {
    try {
      tokens = await refreshToken(provider, oauthConfig(ctx.env, provider), tokens, ctx.fetch, ctx.now());
    } catch (e) {
      if (e instanceof StepError && e.kind === "config") {
        await ctx.repo.updateIntegration(userId, provider, { status: "expired", last_error: e.message });
      }
      throw e;
    }
    await putUserSecret(ctx, userId, `oauth:${provider}`, JSON.stringify(tokens));
    await ctx.repo.updateIntegration(userId, provider, { token_expires_at: tokens.expires_at, status: "connected", last_error: null });
  }
  return tokens;
}

/** Stop before spending money when a limit was reached. */
export async function ensureAllowed(ctx: Ctx, job: Job, kind: string, estimateUsd: number): Promise<void> {
  const a = await ctx.repo.checkAllowance(job.user_id, job.id, kind, estimateUsd);
  if (a.allowed) return;
  if (a.job_limit) throw new StepError(a.reason ?? "Limite de custo da tarefa atingido", "permanent");
  throw new StepError(a.reason ?? "Limite de consumo atingido", "quota");
}

export async function trackGemini(
  ctx: Ctx,
  job: Job,
  settings: UserSettings,
  kind: "gemini_text" | "gemini_tts" | "gemini_image",
  model: string,
  usage: GeminiUsage,
  failed = false,
  extra: { units?: number; unit_type?: string; images?: number } = {},
): Promise<number> {
  const cost = estimateCostUsd(
    model,
    { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, images: extra.images },
    settings.gemini_tier,
    ctx.now(),
    settings.price_overrides ?? {},
  );
  await ctx.repo.recordUsage({
    user_id: job.user_id,
    job_id: job.id,
    provider: "gemini",
    kind,
    model,
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    units: extra.units ?? null,
    unit_type: extra.unit_type ?? null,
    cost_usd: cost,
    failed,
  });
  return cost;
}

/** Ask GitHub Actions to start the render worker now (otherwise its cron picks the job up). */
export async function dispatchWorker(ctx: Ctx, reason: string): Promise<boolean> {
  const token = ctx.env.GITHUB_DISPATCH_TOKEN;
  const repo = ctx.env.GITHUB_REPOSITORY;
  if (!token || !repo) return false;
  try {
    const res = await ctx.fetch(`https://api.github.com/repos/${repo}/dispatches`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "content-type": "application/json",
        "user-agent": "autovideo-short",
      },
      body: JSON.stringify({ event_type: "render-worker", client_payload: { reason } }),
    });
    return res.status === 204;
  } catch {
    return false;
  }
}

export function jobPath(job: Pick<Job, "user_id" | "id">, name: string): string {
  return `jobs/${job.user_id}/${job.id}/${name}`;
}
