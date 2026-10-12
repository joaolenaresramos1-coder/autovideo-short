// Authenticated user actions. Every input is validated here (server side);
// the browser never receives secrets, only short-lived signed URLs.

import { StepError } from "./core/backoff.ts";
import { MAX_UPLOAD_BYTES, UPLOAD_HINT, uploadContentType, uploadKind } from "./core/uploads.ts";
import { randomToken, redact } from "./core/crypto.ts";
import { chapterNumberFrom } from "./connectors/types.ts";
import { connectorFor } from "./connectors/index.ts";
import { GeminiClient, inferCapabilities } from "./adapters/gemini.ts";
import { authorizeUrl, type OAuthProvider } from "./adapters/oauth.ts";
import { type Ctx, dispatchWorker, geminiFor, getUserSecret, oauthConfig, putUserSecret } from "./pipeline/context.ts";
import { ALT_PROVIDERS, type AltProvider, looksVision, OpenAICompatClient } from "./adapters/openai_compat.ts";

export class ApiError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

type Body = Record<string, unknown>;

function str(b: Body, k: string, max = 500): string {
  const v = b[k];
  if (typeof v !== "string" || !v.trim()) throw new ApiError(`Campo obrigatório: ${k}`);
  if (v.length > max) throw new ApiError(`Campo muito longo: ${k}`);
  return v.trim();
}

function uuid(b: Body, k: string): string {
  const v = str(b, k, 64);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) throw new ApiError(`ID inválido: ${k}`);
  return v;
}


function safeName(name: string): string {
  return name.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9._-]+/g, "_").slice(-80) || "arquivo";
}

/** Finds or creates the work and chapter a manual generation refers to. */
async function resolveChapter(ctx: Ctx, userId: string, body: Body): Promise<{ workId: string; chapterKey: string; chapterId: string }> {
  const { repo } = ctx;
  const url = typeof body.chapter_url === "string" && body.chapter_url.trim() ? body.chapter_url.trim() : null;
  if (url && !/^https?:\/\/[^\s]+$/i.test(url)) throw new ApiError("Link do capítulo inválido");
  let workId = typeof body.work_id === "string" && body.work_id ? uuid(body, "work_id") : null;
  if (workId) {
    const work = await repo.getWork(workId);
    if (!work || work.user_id !== userId) throw new ApiError("Obra não encontrada", 404);
  } else {
    const title = (typeof body.title === "string" && body.title.trim()) || (url ? new URL(url).hostname : "Capítulo avulso");
    const type = ["manga", "manhua", "manhwa", "anime"].includes(String(body.type)) ? String(body.type) : "manhwa";
    workId = await repo.createWork({ user_id: userId, title: title.slice(0, 200), type, source: "link", standalone: true, url });
  }
  const given = typeof body.chapter_key === "string" ? body.chapter_key.replace(/[^\p{L}\p{N}._-]/gu, "").slice(0, 40) : "";
  const fromUrl = url ? chapterNumberFrom(decodeURIComponent(new URL(url).pathname).replace(/[-_/]+/g, " ")) : null;
  const chapterKey = given || (fromUrl !== null ? String(fromUrl) : `avulso-${ctx.now().toISOString().slice(0, 16).replace(/[-:T]/g, "")}`);
  const chapterId = await repo.upsertChapter(userId, workId, chapterKey, {
    number: given ? chapterNumberFrom(`cap ${given}`) : fromUrl,
    sourceUrl: url ?? undefined,
  });
  return { workId, chapterKey, chapterId };
}

export async function handleApi(ctx: Ctx, userId: string, body: Body): Promise<unknown> {
  const action = str(body, "action", 40);
  const { repo } = ctx;
  switch (action) {
    case "save_gemini_key": {
      const key = str(body, "key", 200);
      const client = new GeminiClient(key, ctx.fetch);
      let models;
      try {
        models = await client.listModels();
      } catch (e) {
        throw new ApiError(`Chave recusada pelo Gemini: ${redact((e as Error).message)}`, 400);
      }
      await putUserSecret(ctx, userId, "gemini_api_key", key);
      const tts = models.filter((m) => inferCapabilities(m).includes("tts")).map((m) => m.name.replace(/^models\//, ""));
      const text = models.filter((m) => inferCapabilities(m).includes("text")).map((m) => m.name.replace(/^models\//, ""));
      await repo.upsertIntegration({
        user_id: userId, provider: "gemini", status: "connected", account_id: null, account_name: `Chave …${key.slice(-4)}`,
        scopes: [], token_expires_at: null, metadata: { tts_models: tts.slice(0, 50), text_models: text.slice(0, 80), checked_at: ctx.now().toISOString() },
        last_error: null,
      });
      return { ok: true, tts_models: tts, text_models: text };
    }
    case "save_ai_key": {
      // Groq: check the key by listing its models, then store it encrypted.
      const provider = str(body, "provider", 10) as AltProvider;
      if (!(provider in ALT_PROVIDERS)) throw new ApiError("IA inválida");
      const key = str(body, "key", 300);
      const client = new OpenAICompatClient(provider, key, ctx.fetch);
      let models: string[];
      try {
        models = await client.listModels();
      } catch (e) {
        throw new ApiError(`Chave recusada pelo ${client.label}: ${redact((e as Error).message)}`, 400);
      }
      await putUserSecret(ctx, userId, `${provider}_api_key`, key);
      const vision = models.filter(looksVision);
      const settings = await repo.getSettings(userId);
      const current = settings.groq_text_model;
      const model = current && models.includes(current) ? current : (vision[0] ?? models[0] ?? null);
      await repo.updateSettings(userId, { groq_text_model: model });
      await repo.upsertIntegration({
        user_id: userId, provider, status: "connected", account_id: null, account_name: `Chave …${key.slice(-4)}`,
        scopes: [], token_expires_at: null, metadata: { text_models: models.slice(0, 120), vision_models: vision.slice(0, 60), checked_at: ctx.now().toISOString() },
        last_error: null,
      });
      return { ok: true, models, vision_models: vision, model };
    }
    case "test_ai": {
      // One tiny real request to the chosen text AI.
      const provider = str(body, "provider", 10);
      const settings = await repo.getSettings(userId);
      const schema = { type: "object", properties: { ok: { type: "boolean" }, frase: { type: "string" } }, required: ["ok", "frase"] };
      const parts = [{ text: "Teste de conexão. Responda em JSON com ok=true e uma frase curta em português." }];
      try {
        if (provider === "gemini") {
          const r = await (await geminiFor(ctx, userId)).generateJson<{ frase: string }>(settings.gemini_text_model, parts, schema, { timeoutMs: 40_000, quick: true });
          return { provider, model: settings.gemini_text_model, reply: r.data.frase };
        }
        if (!(provider in ALT_PROVIDERS)) throw new ApiError("IA inválida");
        const key = await getUserSecret(ctx, userId, `${provider}_api_key`);
        const model = settings.groq_text_model;
        if (!key || !model) throw new ApiError("Salve a chave e escolha o modelo primeiro");
        const r = await new OpenAICompatClient(provider as AltProvider, key, ctx.fetch).generateJson<{ frase: string }>(model, parts, schema, { timeoutMs: 40_000 });
        return { provider, model, reply: r.data.frase };
      } catch (e) {
        if (e instanceof ApiError) throw e;
        throw new ApiError(redact((e as Error).message), 502);
      }
    }
    case "test_gemini": {
      const settings = await repo.getSettings(userId);
      const client = await geminiFor(ctx, userId);
      const result: Record<string, unknown> = {};
      for (const [label, model] of [["texto", settings.gemini_text_model], ["fala", settings.gemini_tts_model]] as const) {
        try {
          const info = await client.getModel(model);
          result[label] = { model, capabilities: inferCapabilities(info), limits: { input: info.inputTokenLimit, output: info.outputTokenLimit } };
        } catch (e) {
          result[label] = { model, error: redact((e as Error).message) };
        }
      }
      if (body.speak === true) {
        // Real synthesis of one short sentence: confirms the model actually returns audio.
        const r = await client.synthesize(settings.gemini_tts_model, "Teste de narração em português.", { voice: settings.gemini_voice });
        await repo.recordUsage({ user_id: userId, job_id: null, provider: "gemini", kind: "gemini_tts", model: settings.gemini_tts_model, input_tokens: r.usage.inputTokens, output_tokens: r.usage.outputTokens, units: r.durationSeconds, unit_type: "audio_seconds", cost_usd: 0 });
        result.audio_seconds = Number(r.durationSeconds.toFixed(2));
      }
      return result;
    }
    case "disconnect": {
      const provider = str(body, "provider", 20);
      if (!["youtube", "tiktok", "gemini", "groq"].includes(provider)) throw new ApiError("Integração inválida");
      await repo.deleteSecret(userId, ["gemini", "groq"].includes(provider) ? `${provider}_api_key` : `oauth:${provider}`);
      await repo.updateIntegration(userId, provider as "youtube", { status: "disconnected" });
      return { ok: true };
    }
    case "oauth_start": {
      const provider = str(body, "provider", 20) as OAuthProvider;
      if (provider !== "youtube" && provider !== "tiktok") throw new ApiError("Provedor inválido");
      let cfg;
      try {
        cfg = oauthConfig(ctx.env, provider);
      } catch (e) {
        throw new ApiError(`Integração não configurada no servidor: ${(e as Error).message}`, 501);
      }
      const state = randomToken(24);
      const verifier = randomToken(48);
      await repo.putOAuthState({ state, user_id: userId, provider, code_verifier: verifier, redirect_to: ctx.env.APP_URL ?? null });
      return { url: await authorizeUrl(provider, cfg, state, verifier) };
    }
    case "check_work": {
      const workId = uuid(body, "work_id");
      const work = await repo.getWork(workId);
      if (!work || work.user_id !== userId) throw new ApiError("Obra não encontrada", 404);
      const check = await connectorFor(work).check(work, ctx.fetch);
      await repo.updateWork(work.id, {
        status: check.status, status_reason: check.reason, next_check_at: ctx.now().toISOString(),
        ...(check.sourceRef && !work.source_ref ? { source_ref: check.sourceRef } : {}),
      });
      return check;
    }
    case "preview_url": {
      // Watch inside the panel: short-lived link, not counted as a download
      // (does not start the 24 h deletion countdown).
      const objectId = uuid(body, "object_id");
      const obj = await repo.findObject(userId, objectId);
      if (!obj || obj.kind !== "video") throw new ApiError("Vídeo não encontrado", 404);
      if (obj.deleted_at || (obj.expires_at && new Date(obj.expires_at) <= ctx.now())) throw new ApiError("O arquivo deste vídeo já foi excluído", 410);
      return { url: await ctx.blobs.signedUrl(obj.path, 3600), link_expires_in_seconds: 3600 };
    }
    case "download_url": {
      const objectId = uuid(body, "object_id");
      const obj = await repo.findObject(userId, objectId);
      if (!obj || obj.kind !== "video") throw new ApiError("Vídeo não encontrado", 404);
      let registered;
      try {
        registered = await repo.registerDownload(userId, objectId);
      } catch (e) {
        throw new ApiError((e as Error).message.replace(/^Banco \([^)]*\): /, ""), 410);
      }
      const name = `${safeName(String(body.filename ?? "resumo"))}.mp4`.replace(/\.mp4\.mp4$/, ".mp4");
      const url = await ctx.blobs.signedUrl(obj.path, 600, name);
      return {
        url,
        link_expires_in_seconds: 600,
        file_expires_at: registered.expires_at,
        note: "O clique não confirma que o arquivo foi salvo no aparelho. O vídeo será excluído do servidor no prazo indicado.",
      };
    }
    case "job_action": {
      const jobId = uuid(body, "job_id");
      const op = str(body, "op", 20);
      if (!["retry", "cancel", "run_now"].includes(op)) throw new ApiError("Ação inválida");
      try {
        const job = await repo.requestJobAction(userId, jobId, op as "retry");
        if (op !== "cancel") await dispatchWorker(ctx, `user ${op}`);
        return { ok: true, state: job.state };
      } catch (e) {
        throw new ApiError((e as Error).message.replace(/^Banco \([^)]*\): /, ""), e instanceof StepError && e.kind === "permanent" ? 409 : 500);
      }
    }
    case "resume_automation": {
      await repo.resumeAutomation(userId);
      return { ok: true };
    }
    case "upload_url": {
      const workId = uuid(body, "work_id");
      const work = await repo.getWork(workId);
      if (!work || work.user_id !== userId) throw new ApiError("Obra não encontrada", 404);
      const chapterKey = str(body, "chapter_key", 40).replace(/[^\p{L}\p{N}._-]/gu, "");
      if (!chapterKey) throw new ApiError("Capítulo inválido");
      const filename = str(body, "filename", 200);
      const rawType = typeof body.content_type === "string" ? body.content_type.slice(0, 100) : "";
      if (!uploadKind(rawType, filename)) throw new ApiError(`Tipo de arquivo não aceito: ${filename}. ${UPLOAD_HINT}`);
      const contentType = uploadContentType(rawType, filename);
      const size = Number(body.size);
      if (!Number.isFinite(size) || size <= 0 || size > MAX_UPLOAD_BYTES) throw new ApiError(`${filename}: arquivo vazio ou maior que 50 MB`);
      const order = String(Number(body.order ?? 0)).padStart(3, "0");
      const path = `uploads/${userId}/${workId}/${chapterKey}/${order}-${safeName(filename)}`;
      await repo.upsertChapterForUpload(userId, workId, chapterKey, chapterNumberFrom(`cap ${chapterKey}`));
      const signed = await ctx.blobs.signedUploadUrl(path);
      await repo.registerObject(userId, null, path, "upload", size, contentType, true);
      return { path, content_type: contentType, ...signed };
    }
    case "prepare_chapter": {
      // Where uploaded files of a one-off chapter go (creates the work if needed).
      const { workId, chapterKey } = await resolveChapter(ctx, userId, body);
      return { work_id: workId, chapter_key: chapterKey };
    }
    case "generate_now": {
      const { workId, chapterKey, chapterId } = await resolveChapter(ctx, userId, body);
      const settings = await repo.getSettings(userId);
      const duration = Math.round(Math.min(180, Math.max(60, Number(body.target_duration_seconds ?? 75))));
      const platforms = (Array.isArray(body.platforms) ? body.platforms : []).filter((p): p is "youtube" | "tiktok" => p === "youtube" || p === "tiktok");
      const now = ctx.now().toISOString();
      const jobId = await repo.createJob({
        user_id: userId,
        work_id: workId,
        schedule_id: null,
        chapter_id: chapterId,
        state: "queued",
        summary_format: "chapter",
        target_duration_seconds: duration,
        platforms,
        priority: 8,
        slot_at: now,
        run_at: now,
        dedupe_key: `manual:${crypto.randomUUID()}`,
        content_key: null, // manual runs may regenerate the same chapter
        cost_limit_usd: Math.max(0.5, Number(body.cost_limit_usd ?? 0.5)),
        max_attempts: settings.max_attempts ?? 5,
      });
      await repo.log({ user_id: userId, job_id: jobId, level: "info", event: "manual_generate", message: `Geração manual do capítulo ${chapterKey}` });
      return { job_id: jobId, work_id: workId, chapter_key: chapterKey };
    }
    case "process_now": {
      return { dispatched: await dispatchWorker(ctx, "user request") };
    }
    default:
      throw new ApiError(`Ação desconhecida: ${action}`, 404);
  }
}
