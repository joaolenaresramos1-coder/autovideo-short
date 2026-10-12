// Text AI for analysis, script and review: Claude (the user's subscription,
// on the render worker), Gemini or Groq, in the order the user chose. When
// one is busy or out of quota, the next available one answers instead,
// inside the same step.

import { StepError } from "../core/backoff.ts";
import type { Job, UserSettings } from "../core/types.ts";
import type { GeminiUsage, Part } from "../adapters/gemini.ts";
import { type AltProvider, OpenAICompatClient } from "../adapters/openai_compat.ts";
import { base64ToBytes } from "../core/wav.ts";
import { type Ctx, geminiFor, getUserSecret, remainingMs, trackGemini } from "./context.ts";

export type TextProvider = "claude" | "gemini" | AltProvider;
export const TEXT_PROVIDERS: TextProvider[] = ["claude", "gemini", "groq"];
export const DEFAULT_CLAUDE_MODEL = "claude-opus-5-5";

/** Claude goes first: analysis and script then run on the render worker. */
export function claudeFirst(settings: Pick<UserSettings, "text_provider_order">): boolean {
  return providerOrder(settings)[0] === "claude";
}

interface Candidate {
  provider: TextProvider;
  model: string;
  maxImages: number;
  call<T>(parts: Part[], schema: unknown, opts: { timeoutMs?: number; quick?: boolean }): Promise<{ data: T; usage: GeminiUsage }>;
}

/** Too many images for every provider that could answer now. */
export class ImageLimitError extends StepError {
  readonly max: number;
  constructor(max: number) {
    super(`No máximo ${max} imagem(ns) por pedido para a IA disponível`, "retryable");
    this.max = max;
  }
}

const secretName = (p: AltProvider) => `${p}_api_key`;

export function providerOrder(settings: Pick<UserSettings, "text_provider_order">): TextProvider[] {
  const chosen = (settings.text_provider_order ?? []).filter((p): p is TextProvider => TEXT_PROVIDERS.includes(p as TextProvider));
  // Claude only when the user put it in the list (it needs the GitHub token)
  return [...new Set([...chosen, ...TEXT_PROVIDERS.filter((p) => p !== "claude")])];
}

async function candidates(ctx: Ctx, userId: string, settings: UserSettings): Promise<Candidate[]> {
  const out: Candidate[] = [];
  for (const provider of providerOrder(settings)) {
    if (provider === "claude") {
      const cli = ctx.claudeCli;
      if (!cli) continue; // only on the worker, with CLAUDE_CODE_OAUTH_TOKEN
      const model = settings.claude_model || DEFAULT_CLAUDE_MODEL;
      out.push({
        provider, model, maxImages: 20,
        call: async (parts, schema) => {
          const images: { name: string; bytes: Uint8Array }[] = [];
          const text: string[] = [];
          for (const p of parts) {
            if ("text" in p) {
              text.push(p.text);
            } else {
              const name = `imagem-${String(images.length + 1).padStart(2, "0")}.jpg`;
              images.push({ name, bytes: base64ToBytes(p.inlineData.data) });
              text.push(`[${name}]`);
            }
          }
          // Claude Code reads the images itself: give it time (it runs on the worker)
          const timeoutMs = Math.max(120_000, Math.min(600_000, remainingMs(ctx) - 30_000));
          const r = await cli({ model, prompt: text.join("\n"), images, schema, timeoutMs });
          return { data: r.data as never, usage: { inputTokens: r.inputTokens, outputTokens: r.outputTokens, totalTokens: r.inputTokens + r.outputTokens } };
        },
      });
    } else if (provider === "gemini") {
      const gemini = await geminiFor(ctx, userId).catch(() => null);
      if (!gemini) continue;
      out.push({
        provider, model: settings.gemini_text_model, maxImages: 16,
        call: (parts, schema, opts) => gemini.generateJson(settings.gemini_text_model, parts, schema, opts),
      });
    } else {
      const model = settings.groq_text_model;
      const key = model ? await getUserSecret(ctx, userId, secretName(provider)) : null;
      if (!key || !model) continue;
      const client = new OpenAICompatClient(provider, key, ctx.fetch);
      out.push({
        provider, model, maxImages: client.maxImages,
        call: (parts, schema, opts) => client.generateJson(model, parts, schema, { timeoutMs: opts.timeoutMs }),
      });
    }
  }
  if (out.length === 0) {
    throw new StepError("Nenhuma IA de texto disponível: configure o Claude (assinatura), o Gemini ou o Groq em Integrações", "config");
  }
  return out;
}

async function track(ctx: Ctx, job: Job, settings: UserSettings, c: Candidate, usage: GeminiUsage) {
  if (c.provider === "gemini") {
    await trackGemini(ctx, job, settings, "gemini_text", c.model, usage, false, { images: 0 });
    return;
  }
  // Claude runs on the user's subscription and Groq's free tier costs nothing.
  await ctx.repo.recordUsage({
    user_id: job.user_id, job_id: job.id, provider: c.provider, kind: `${c.provider}_text`, model: c.model,
    input_tokens: usage.inputTokens, output_tokens: usage.outputTokens, cost_usd: 0,
  });
}

/**
 * JSON answer from the first provider that can give one. Busy/quota errors
 * move on to the next provider; anything else (bad request, timeout) stops.
 */
export async function generateJsonAny<T>(
  ctx: Ctx,
  job: Job,
  settings: UserSettings,
  parts: Part[],
  schema: unknown,
  opts: { timeoutMs?: number; quick?: boolean } = {},
): Promise<{ data: T; provider: TextProvider; model: string }> {
  const images = parts.filter((p) => "inlineData" in p).length;
  const list = await candidates(ctx, job.user_id, settings);
  const failures: StepError[] = [];
  let smallest = Infinity;
  for (const c of list) {
    if (images > c.maxImages) {
      smallest = Math.min(smallest, c.maxImages);
      continue;
    }
    try {
      const r = await c.call<T>(parts, schema, opts);
      await track(ctx, job, settings, c, r.usage);
      if (failures.length) {
        await ctx.repo.log({
          user_id: job.user_id, job_id: job.id, level: "info", event: "ai_fallback",
          message: `Usando ${c.provider} (${c.model}); antes: ${failures.map((f) => f.message.slice(0, 120)).join(" | ")}`,
        });
      }
      return { data: r.data, provider: c.provider, model: c.model };
    } catch (e) {
      // busy, out of quota, bad key or a request this provider rejects
      // (HTTP 4xx, e.g. a model limit): the next provider may answer
      const providerSide = e instanceof StepError && (e.kind === "waiting" || e.kind === "config" || /HTTP 4\d\d/.test(e.message));
      if (!providerSide) throw e;
      failures.push(e);
    }
  }
  // Someone could answer with fewer images: let the caller shrink the batch.
  if (Number.isFinite(smallest)) throw new ImageLimitError(smallest);
  const waiting = failures.filter((f) => f.kind === "waiting");
  if (waiting.length) {
    // retry when the first provider frees up
    const wait = Math.min(...waiting.map((f) => f.retryAfterSeconds ?? 120));
    const note = list.length > 1 ? " (todas as IAs configuradas estão ocupadas ou sem cota)" : "";
    throw new StepError(`${waiting[0].message}${note}`, "waiting", wait);
  }
  if (failures.length) {
    const f = failures[0];
    // a request rejected by every provider is worth one more try later, not a dead job
    throw /HTTP 4\d\d/.test(f.message) && f.kind === "permanent" ? new StepError(f.message, "retryable", 300) : f;
  }
  throw new StepError("Nenhuma IA de texto disponível", "retryable");
}
