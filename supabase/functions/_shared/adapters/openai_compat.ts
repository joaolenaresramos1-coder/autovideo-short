// Chat Completions client for Groq (OpenAI-compatible API).
// Used as an alternative to Gemini for the text steps (analysis, script,
// review). Images go as data URLs; the answer is requested as a JSON object
// and the expected JSON Schema is written into the prompt.

import { StepError } from "../core/backoff.ts";
import type { GeminiUsage, Part } from "./gemini.ts";
import { type FetchLike, httpJson } from "./http.ts";

export type AltProvider = "groq";

export const ALT_PROVIDERS: Record<AltProvider, { label: string; base: string; maxImages: number; keyHint: string }> = {
  // Groq vision models accept at most 5 images per request
  groq: { label: "Groq", base: "https://api.groq.com/openai/v1", maxImages: 5, keyHint: "gsk_…" },
};

interface ChatResponse {
  choices?: { message?: { content?: string | null }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  model?: string;
}

/** First JSON object in a reply (some models wrap it in ``` fences or add text). */
export function parseJsonReply<T>(text: string): T {
  const clean = text.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  try {
    return JSON.parse(clean) as T;
  } catch {
    const start = clean.indexOf("{");
    const end = clean.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(clean.slice(start, end + 1)) as T;
    throw new Error("sem JSON");
  }
}

/** Models that probably read images, from the id (APIs do not say it). */
export function looksVision(id: string): boolean {
  return /vision|llama-4|scout|maverick|vl\b|-vl-|pixtral|gemma-3/i.test(id);
}

const learnedCaps = new Map<string, number>();

export class OpenAICompatClient {
  readonly provider: AltProvider;
  readonly label: string;
  readonly maxImages: number;
  private readonly base: string;
  private readonly apiKey: string;
  private readonly fetchFn: FetchLike;
  /** Output caps learned from the API, per model (shared by all clients of this process). */
  private readonly maxTokens = learnedCaps;

  constructor(provider: AltProvider, apiKey: string, fetchFn: FetchLike = fetch) {
    const p = ALT_PROVIDERS[provider];
    this.provider = provider;
    this.apiKey = apiKey;
    this.fetchFn = fetchFn;
    this.label = p.label;
    this.base = p.base;
    this.maxImages = p.maxImages;
  }

  private headers() {
    return { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" };
  }

  async listModels(): Promise<string[]> {
    const r = await httpJson<{ data?: { id: string; active?: boolean }[] }>(this.fetchFn, `${this.base}/models`, {
      headers: this.headers(), service: this.label, timeoutMs: 20_000,
    });
    return (r.data ?? []).filter((m) => m.active !== false).map((m) => m.id).sort();
  }

  async generateJson<T>(
    model: string,
    parts: Part[],
    schema: unknown,
    opts: { timeoutMs?: number; maxOutputTokens?: number } = {},
  ): Promise<{ data: T; usage: GeminiUsage; modelVersion?: string }> {
    const content: unknown[] = [];
    let first = true;
    for (const p of parts) {
      if ("text" in p) {
        const text = first
          ? `${p.text}\n\nResponda SOMENTE com um objeto JSON válido (sem texto fora do JSON) que siga este JSON Schema:\n${JSON.stringify(schema)}`
          : p.text;
        first = false;
        content.push({ type: "text", text });
      } else {
        content.push({ type: "image_url", image_url: { url: `data:${p.inlineData.mimeType};base64,${p.inlineData.data}` } });
      }
    }
    const send = (maxTokens: number) => httpJson<ChatResponse>(this.fetchFn, `${this.base}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content }],
        response_format: { type: "json_object" },
        max_tokens: maxTokens,
        temperature: 0.4,
      }),
      service: this.label,
      timeoutMs: opts.timeoutMs ?? 120_000,
    });
    const wanted = opts.maxOutputTokens ?? this.maxTokens.get(model) ?? 8192;
    let r: ChatResponse;
    try {
      r = await send(wanted);
    } catch (e) {
      // Each model has its own output cap; the error says which ("must be less than or equal to `4096`")
      const cap = e instanceof StepError && /HTTP 400/.test(e.message) && /max_tokens/.test(e.message)
        ? Number(/less than or equal to\D{0,3}(\d+)/.exec(e.message)?.[1])
        : NaN;
      if (!Number.isFinite(cap) || cap <= 0 || cap >= wanted) throw e;
      this.maxTokens.set(model, cap);
      r = await send(cap);
    }
    const text = r.choices?.[0]?.message?.content ?? "";
    if (!text) throw new StepError(`${this.label} não retornou conteúdo (${r.choices?.[0]?.finish_reason ?? "?"})`, "retryable");
    let data: T;
    try {
      data = parseJsonReply<T>(text);
    } catch {
      throw new StepError(`${this.label} retornou JSON inválido`, "retryable");
    }
    const u = r.usage ?? {};
    return {
      data,
      usage: { inputTokens: u.prompt_tokens ?? 0, outputTokens: u.completion_tokens ?? 0, totalTokens: u.total_tokens ?? 0 },
      modelVersion: r.model,
    };
  }
}
