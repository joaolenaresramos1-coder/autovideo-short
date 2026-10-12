// Gemini API client (REST generateContent, v1beta). Only what the pipeline
// needs: JSON text generation (with images), speech synthesis and images.
// Docs: https://ai.google.dev/api/generate-content

import { StepError } from "../core/backoff.ts";
import { base64ToBytes, bytesToBase64, parseWav, toWav } from "../core/wav.ts";
import { type FetchLike, httpJson } from "./http.ts";

const BASE = "https://generativelanguage.googleapis.com/v1beta";

export type Part =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } };

export interface GeminiUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

interface GenerateResponse {
  candidates?: {
    content?: { parts?: ({ text?: string; thought?: boolean; inlineData?: { mimeType: string; data: string } })[] };
    finishReason?: string;
  }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    totalTokenCount?: number;
  };
  modelVersion?: string;
}

export interface ModelInfo {
  name: string;
  displayName?: string;
  description?: string;
  supportedGenerationMethods?: string[];
  inputTokenLimit?: number;
  outputTokenLimit?: number;
}

export type ModelCapability = "text" | "tts" | "image";

/**
 * Capabilities from the model metadata. The API does not expose output
 * modalities directly, so TTS/image support is inferred from the model id and
 * description and must be confirmed with a real call (see `testSpeech`).
 */
export function inferCapabilities(m: ModelInfo): ModelCapability[] {
  const id = m.name.replace(/^models\//, "").toLowerCase();
  const desc = `${m.displayName ?? ""} ${m.description ?? ""}`.toLowerCase();
  const methods = m.supportedGenerationMethods ?? [];
  if (!methods.includes("generateContent")) return [];
  if (/tts|text-to-speech/.test(id) || /text-to-speech/.test(desc)) return ["tts"];
  if (/image|nano-banana/.test(id)) return ["image", "text"];
  return ["text"];
}

function usageOf(r: GenerateResponse): GeminiUsage {
  const u = r.usageMetadata ?? {};
  const out = (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0);
  return { inputTokens: u.promptTokenCount ?? 0, outputTokens: out, totalTokens: u.totalTokenCount ?? 0 };
}

function blockedOrEmpty(r: GenerateResponse): never {
  if (r.promptFeedback?.blockReason) {
    throw new StepError(`Gemini bloqueou o pedido (${r.promptFeedback.blockReason})`, "permanent");
  }
  const reason = r.candidates?.[0]?.finishReason;
  throw new StepError(`Gemini não retornou conteúdo (finishReason=${reason ?? "?"})`, reason === "SAFETY" ? "permanent" : "retryable");
}

export class GeminiClient {
  private noThinkingConfig = false;
  apiKey: string;
  fetchFn: FetchLike;
  constructor(apiKey: string, fetchFn: FetchLike = fetch) {
    if (!apiKey) throw new StepError("Chave da API Gemini não configurada", "config");
    this.apiKey = apiKey;
    this.fetchFn = fetchFn;
  }

  private headers() {
    return { "content-type": "application/json", "x-goog-api-key": this.apiKey };
  }

  async getModel(model: string): Promise<ModelInfo> {
    return httpJson<ModelInfo>(this.fetchFn, `${BASE}/models/${encodeURIComponent(model)}`, {
      headers: this.headers(),
      service: "Gemini",
      timeoutMs: 20_000,
    });
  }

  async listModels(): Promise<ModelInfo[]> {
    const out: ModelInfo[] = [];
    let page = "";
    for (let i = 0; i < 10; i++) {
      const r = await httpJson<{ models?: ModelInfo[]; nextPageToken?: string }>(
        this.fetchFn,
        `${BASE}/models?pageSize=200${page ? `&pageToken=${encodeURIComponent(page)}` : ""}`,
        { headers: this.headers(), service: "Gemini", timeoutMs: 20_000 },
      );
      out.push(...(r.models ?? []));
      if (!r.nextPageToken) break;
      page = r.nextPageToken;
    }
    return out;
  }

  private async generate(model: string, body: unknown, timeoutMs: number): Promise<GenerateResponse> {
    const started = Date.now();
    for (let attempt = 0; ; attempt++) {
      try {
        return await httpJson<GenerateResponse>(this.fetchFn, `${BASE}/models/${encodeURIComponent(model)}:generateContent`, {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify(body),
          service: "Gemini",
          timeoutMs: Math.max(5_000, timeoutMs - (Date.now() - started)),
        });
      } catch (e) {
        // "high demand" spikes are usually short: retry a couple of times right away
        const wait = this.busyRetryMs[attempt];
        const busy = e instanceof StepError && e.kind === "waiting" && /HTTP 503/.test(e.message);
        if (!busy || wait === undefined || Date.now() - started + wait + 20_000 > timeoutMs) throw e;
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }

  /** Waits between quick retries when the model is overloaded (tests set []). */
  busyRetryMs: number[] = [3_000, 8_000];

  /** Structured JSON output validated against `schema`. */
  async generateJson<T>(
    model: string,
    parts: Part[],
    schema: unknown,
    opts: { system?: string; maxOutputTokens?: number; timeoutMs?: number; quick?: boolean } = {},
  ): Promise<{ data: T; usage: GeminiUsage; modelVersion?: string }> {
    const base = {
      contents: [{ role: "user", parts }],
      ...(opts.system ? { systemInstruction: { parts: [{ text: opts.system }] } } : {}),
    };
    const timeout = opts.timeoutMs ?? 120_000;
    const maxOutputTokens = opts.maxOutputTokens ?? 16384;
    // quick: little "thinking" — reading panels does not need long reasoning
    let thinking: Record<string, unknown> = opts.quick && !this.noThinkingConfig ? { thinkingConfig: { thinkingLevel: "low" } } : {};
    const call = async (format: Record<string, unknown>) => {
      try {
        return await this.generate(model, { ...base, generationConfig: { ...format, maxOutputTokens, ...thinking } }, timeout);
      } catch (e) {
        if (!Object.keys(thinking).length || !(e instanceof StepError) || !/HTTP 400/.test(e.message) || !/thinking/i.test(e.message)) throw e;
        this.noThinkingConfig = true; // model without thinking levels
        thinking = {};
        return await this.generate(model, { ...base, generationConfig: { ...format, maxOutputTokens } }, timeout);
      }
    };
    let r: GenerateResponse;
    try {
      // Current field (responseSchema/responseJsonSchema are deprecated).
      r = await call({ responseFormat: { text: { mimeType: "APPLICATION_JSON", schema } } });
    } catch (e) {
      if (!(e instanceof StepError) || !/HTTP 400/.test(e.message) || !/responseFormat|response_format|Unknown name/i.test(e.message)) throw e;
      r = await call({ responseMimeType: "application/json", responseJsonSchema: schema });
    }
    const text = (r.candidates?.[0]?.content?.parts ?? [])
      .filter((p) => typeof p.text === "string" && !p.thought)
      .map((p) => p.text)
      .join("");
    if (!text) blockedOrEmpty(r);
    try {
      return { data: JSON.parse(text) as T, usage: usageOf(r), modelVersion: r.modelVersion };
    } catch {
      throw new StepError("Gemini retornou JSON inválido", "retryable");
    }
  }

  /**
   * Speech synthesis with a TTS-capable model. Returns WAV bytes and the real
   * duration measured from the audio itself.
   */
  async synthesize(
    model: string,
    text: string,
    opts: { voice: string; languageCode?: string; style?: string; timeoutMs?: number },
  ): Promise<{ wav: Uint8Array; durationSeconds: number; usage: GeminiUsage; mimeType: string }> {
    const r = await this.generate(
      model,
      {
        contents: [{ role: "user", parts: [{ text }] }],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: opts.voice } },
            languageCode: opts.languageCode ?? "pt-BR",
          },
        },
      },
      opts.timeoutMs ?? 140_000,
    );
    const part = (r.candidates?.[0]?.content?.parts ?? []).find((p) => p.inlineData?.data);
    if (!part?.inlineData) {
      const hasText = (r.candidates?.[0]?.content?.parts ?? []).some((p) => p.text);
      if (hasText) {
        throw new StepError(`O modelo ${model} respondeu texto em vez de áudio: ele não oferece geração de fala`, "config");
      }
      blockedOrEmpty(r);
    }
    const wav = toWav(base64ToBytes(part.inlineData.data), part.inlineData.mimeType);
    const info = parseWav(wav);
    if (info.durationSeconds < 0.5) throw new StepError("Áudio gerado vazio ou curto demais", "retryable");
    return { wav, durationSeconds: info.durationSeconds, usage: usageOf(r), mimeType: part.inlineData.mimeType };
  }

  /** Original illustration (image-capable models only). */
  async generateImage(
    model: string,
    prompt: string,
    opts: { aspectRatio?: string; timeoutMs?: number } = {},
  ): Promise<{ bytes: Uint8Array; mimeType: string; usage: GeminiUsage }> {
    const r = await this.generate(
      model,
      {
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          responseModalities: ["IMAGE"],
          imageConfig: { aspectRatio: opts.aspectRatio ?? "9:16" },
        },
      },
      opts.timeoutMs ?? 120_000,
    );
    const part = (r.candidates?.[0]?.content?.parts ?? []).find((p) => p.inlineData?.data);
    if (!part?.inlineData) blockedOrEmpty(r);
    return { bytes: base64ToBytes(part.inlineData.data), mimeType: part.inlineData.mimeType, usage: usageOf(r) };
  }
}

export function imagePart(bytes: Uint8Array, mimeType: string): Part {
  return { inlineData: { mimeType, data: bytesToBase64(bytes) } };
}
