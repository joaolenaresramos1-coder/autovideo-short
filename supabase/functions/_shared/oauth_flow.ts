// OAuth callback: validates the single-use state, exchanges the code and
// stores the encrypted tokens. Never trusts parameters other than `state`.

import { redact } from "./core/crypto.ts";
import { exchangeCode, type OAuthProvider, SCOPES } from "./adapters/oauth.ts";
import { userInfo } from "./adapters/tiktok.ts";
import { myChannel } from "./adapters/youtube.ts";
import { type Ctx, oauthConfig, putUserSecret } from "./pipeline/context.ts";

export async function handleOAuthCallback(ctx: Ctx, provider: string, params: URLSearchParams): Promise<string> {
  const back = (ok: boolean, msg: string) => {
    const base = (ctx.env.APP_URL ?? "").replace(/\/$/, "");
    return `${base}/#/integracoes?${new URLSearchParams({ provider, status: ok ? "ok" : "erro", msg })}`;
  };
  if (provider !== "youtube" && provider !== "tiktok") return back(false, "Provedor inválido");
  const state = params.get("state") ?? "";
  const saved = state ? await ctx.repo.takeOAuthState(state) : null;
  if (!saved || saved.provider !== provider) return back(false, "Sessão de autorização inválida ou expirada");
  if (params.get("error")) return back(false, `Autorização negada: ${params.get("error_description") ?? params.get("error")}`);
  const code = params.get("code");
  if (!code) return back(false, "Código de autorização ausente");

  const p = provider as OAuthProvider;
  try {
    const tokens = await exchangeCode(p, oauthConfig(ctx.env, p), code, saved.code_verifier, ctx.fetch, ctx.now());
    let accountId: string | null = null;
    let accountName: string | null = null;
    if (p === "youtube") {
      const ch = await myChannel(ctx.fetch, tokens.access_token);
      accountId = ch.id;
      accountName = ch.title;
    } else {
      const u = await userInfo(ctx.fetch, tokens.access_token);
      accountId = u.open_id;
      accountName = u.display_name ?? null;
    }
    await putUserSecret(ctx, saved.user_id, `oauth:${p}`, JSON.stringify(tokens));
    await ctx.repo.upsertIntegration({
      user_id: saved.user_id,
      provider: p,
      status: "connected",
      account_id: accountId,
      account_name: accountName,
      scopes: tokens.scope ? tokens.scope.split(/[ ,]+/) : SCOPES[p],
      token_expires_at: tokens.expires_at,
      metadata: p === "tiktok" ? { note: "Apps não auditados pelo TikTok só publicam como privado (SELF_ONLY)" } : {},
      last_error: null,
    });
    return back(true, accountName ? `Conectado: ${accountName}` : "Conectado");
  } catch (e) {
    return back(false, redact((e as Error).message).slice(0, 200));
  }
}
