// Authenticated user actions. Every input is validated here (server side);
// the browser never receives secrets, only short-lived signed URLs.

import { StepError } from "./core/backoff.ts";
import { randomToken, redact } from "./core/crypto.ts";
import { chapterNumberFrom } from "./connectors/types.ts";
import { connectorFor } from "./connectors/index.ts";
import { GeminiClient, inferCapabilities } from "./adapters/gemini.ts";
import { authorizeUrl, type OAuthProvider } from "./adapters/oauth.ts";
import { type Ctx, dispatchWorker, geminiFor, oauthConfig, putUserSecret } from "./pipeline/context.ts";

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

const UPLOAD_TYPES: Record<string, string> = {
  "image/jpeg": "image",
  "image/png": "image",
  "image/webp": "image",
  "text/plain": "text",
  "application/x-subrip": "text",
  "text/vtt": "text",
};
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

function safeName(name: string): string {
  return name.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9._-]+/g, "_").slice(-80) || "arquivo";
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
      if (!["youtube", "tiktok", "gemini"].includes(provider)) throw new ApiError("Integração inválida");
      await repo.deleteSecret(userId, provider === "gemini" ? "gemini_api_key" : `oauth:${provider}`);
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
      if (work.authorization_status !== "authorized") {
        throw new ApiError("Confirme na obra que você tem autorização para reutilizar este material antes de enviar", 403);
      }
      const chapterKey = str(body, "chapter_key", 40).replace(/[^\p{L}\p{N}._-]/gu, "");
      if (!chapterKey) throw new ApiError("Capítulo inválido");
      const contentType = str(body, "content_type", 60).toLowerCase();
      if (!UPLOAD_TYPES[contentType]) throw new ApiError("Tipo de arquivo não aceito (JPEG, PNG, WebP, TXT, SRT ou VTT)");
      const size = Number(body.size);
      if (!Number.isFinite(size) || size <= 0 || size > MAX_UPLOAD_BYTES) throw new ApiError("Arquivo vazio ou maior que 15 MB");
      const order = String(Number(body.order ?? 0)).padStart(3, "0");
      const path = `uploads/${userId}/${workId}/${chapterKey}/${order}-${safeName(str(body, "filename", 200))}`;
      await repo.upsertChapterForUpload(userId, workId, chapterKey, chapterNumberFrom(`cap ${chapterKey}`));
      const signed = await ctx.blobs.signedUploadUrl(path);
      await repo.registerObject(userId, null, path, "upload", size, contentType, true);
      return { path, ...signed };
    }
    case "process_now": {
      return { dispatched: await dispatchWorker(ctx, "user request") };
    }
    default:
      throw new ApiError(`Ação desconhecida: ${action}`, 404);
  }
}
