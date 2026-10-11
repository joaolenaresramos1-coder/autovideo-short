// Cost ESTIMATES for the Gemini API, in USD. Source: ai.google.dev/gemini-api/docs/pricing
// (checked 2026-10-11). Prices change: users can override them in Settings
// (user_settings.price_overrides) and the free tier is billed at zero.

import type { ModelPrice } from "./types.ts";

interface DatedPrice extends ModelPrice {
  /** Price applies until this ISO date (exclusive); undefined = no end. */
  until?: string;
}

export const GEMINI_PRICES: Record<string, DatedPrice[]> = {
  "gemini-3.8-flash": [
    { input: 0.75, output: 3.75, until: "2027-01-01" },
    { input: 1.5, output: 7.5 },
  ],
  // TTS: output is billed as audio tokens (~25 tokens per second of audio).
  "gemini-3.8-flash-tts": [
    { input: 0.5, output: 9.0, until: "2027-01-01" },
    { input: 1.0, output: 18.0 },
  ],
  "gemini-3.8-flash-lite-tts": [
    { input: 0.5, output: 6.0, until: "2027-01-01" },
    { input: 1.0, output: 12.0 },
  ],
};

/** Conservative fallback for models without a known price. */
export const UNKNOWN_MODEL_PRICE: ModelPrice = { input: 2.0, output: 12.0, image: 0.05 };

export const AUDIO_TOKENS_PER_SECOND = 25;

export function priceFor(
  model: string,
  at: Date = new Date(),
  overrides: Record<string, Partial<ModelPrice>> = {},
): ModelPrice {
  const base = GEMINI_PRICES[model]?.find((p) => !p.until || at < new Date(p.until)) ?? UNKNOWN_MODEL_PRICE;
  const o = overrides[model] ?? {};
  return { input: o.input ?? base.input, output: o.output ?? base.output, image: o.image ?? base.image };
}

export interface UsageLike {
  inputTokens?: number | null;
  outputTokens?: number | null;
  images?: number;
}

export function estimateCostUsd(
  model: string,
  usage: UsageLike,
  tier: "free" | "paid",
  at: Date = new Date(),
  overrides: Record<string, Partial<ModelPrice>> = {},
): number {
  if (tier === "free") return 0;
  const p = priceFor(model, at, overrides);
  const cost =
    ((usage.inputTokens ?? 0) * p.input) / 1e6 +
    ((usage.outputTokens ?? 0) * p.output) / 1e6 +
    (usage.images ?? 0) * (p.image ?? 0);
  return Math.round(cost * 1e6) / 1e6;
}

/** Upper-bound estimate used BEFORE a call, to check limits. */
export function estimateBeforeCall(
  kind: "gemini_text" | "gemini_tts" | "gemini_image" | "render",
  model: string,
  opts: { inputChars?: number; images?: number; audioSeconds?: number; outputTokens?: number },
  tier: "free" | "paid",
  overrides: Record<string, Partial<ModelPrice>> = {},
): number {
  if (tier === "free" || kind === "render") return 0;
  const inputTokens = Math.ceil((opts.inputChars ?? 0) / 3.5) + (opts.images ?? 0) * 1300;
  if (kind === "gemini_tts") {
    return estimateCostUsd(model, { inputTokens, outputTokens: (opts.audioSeconds ?? 180) * AUDIO_TOKENS_PER_SECOND }, tier, new Date(), overrides);
  }
  if (kind === "gemini_image") {
    return estimateCostUsd(model, { inputTokens, images: opts.images ?? 1 }, tier, new Date(), overrides);
  }
  return estimateCostUsd(model, { inputTokens, outputTokens: opts.outputTokens ?? 8000 }, tier, new Date(), overrides);
}
