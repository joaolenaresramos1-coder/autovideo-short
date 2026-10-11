// OAuth 2.0 for YouTube (Google) and TikTok. Client secrets only exist in the
// Edge Function environment.

import { StepError } from "../core/backoff.ts";
import { sha256Base64Url } from "../core/crypto.ts";
import { type FetchLike, http } from "./http.ts";

export type OAuthProvider = "youtube" | "tiktok";

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface TokenSet {
  access_token: string;
  refresh_token?: string;
  expires_at: string; // ISO
  refresh_expires_at?: string;
  scope?: string;
  open_id?: string; // TikTok
}

export const SCOPES: Record<OAuthProvider, string[]> = {
  youtube: [
    "https://www.googleapis.com/auth/youtube.upload",
    "https://www.googleapis.com/auth/youtube.readonly",
  ],
  tiktok: ["user.info.basic", "video.publish"],
};

export async function authorizeUrl(
  provider: OAuthProvider,
  cfg: OAuthConfig,
  state: string,
  codeVerifier: string,
): Promise<string> {
  if (provider === "youtube") {
    const p = new URLSearchParams({
      client_id: cfg.clientId,
      redirect_uri: cfg.redirectUri,
      response_type: "code",
      scope: SCOPES.youtube.join(" "),
      access_type: "offline",
      include_granted_scopes: "true",
      prompt: "consent",
      state,
      code_challenge: await sha256Base64Url(codeVerifier),
      code_challenge_method: "S256",
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
  }
  const p = new URLSearchParams({
    client_key: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: "code",
    scope: SCOPES.tiktok.join(","),
    state,
  });
  return `https://www.tiktok.com/v2/auth/authorize/?${p}`;
}

interface RawToken {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_expires_in?: number;
  scope?: string;
  open_id?: string;
  error?: string;
  error_description?: string;
}

function toTokenSet(r: RawToken, now: Date, previous?: TokenSet): TokenSet {
  if (!r.access_token) {
    const invalid = r.error === "invalid_grant" || r.error === "invalid_request";
    throw new StepError(
      `Falha no token OAuth: ${r.error ?? "sem access_token"} ${r.error_description ?? ""}`.trim(),
      invalid ? "config" : "retryable",
    );
  }
  return {
    access_token: r.access_token,
    refresh_token: r.refresh_token ?? previous?.refresh_token,
    expires_at: new Date(now.getTime() + (r.expires_in ?? 3600) * 1000).toISOString(),
    refresh_expires_at: r.refresh_expires_in
      ? new Date(now.getTime() + r.refresh_expires_in * 1000).toISOString()
      : previous?.refresh_expires_at,
    scope: r.scope ?? previous?.scope,
    open_id: r.open_id ?? previous?.open_id,
  };
}

async function postForm(fetchFn: FetchLike, url: string, form: Record<string, string>): Promise<RawToken> {
  const res = await http(fetchFn, url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
    service: "OAuth",
    timeoutMs: 20_000,
  });
  const body = (await res.json().catch(() => ({}))) as RawToken;
  if (!res.ok && !body.error) body.error = `HTTP ${res.status}`;
  return body;
}

const TOKEN_URL: Record<OAuthProvider, string> = {
  youtube: "https://oauth2.googleapis.com/token",
  tiktok: "https://open.tiktokapis.com/v2/oauth/token/",
};

export async function exchangeCode(
  provider: OAuthProvider,
  cfg: OAuthConfig,
  code: string,
  codeVerifier: string,
  fetchFn: FetchLike = fetch,
  now = new Date(),
): Promise<TokenSet> {
  const form: Record<string, string> = provider === "youtube"
    ? {
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      code,
      code_verifier: codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: cfg.redirectUri,
    }
    : {
      client_key: cfg.clientId,
      client_secret: cfg.clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: cfg.redirectUri,
    };
  return toTokenSet(await postForm(fetchFn, TOKEN_URL[provider], form), now);
}

export async function refreshToken(
  provider: OAuthProvider,
  cfg: OAuthConfig,
  tokens: TokenSet,
  fetchFn: FetchLike = fetch,
  now = new Date(),
): Promise<TokenSet> {
  if (!tokens.refresh_token) throw new StepError("Sem refresh token: reconecte a conta", "config");
  const form: Record<string, string> = provider === "youtube"
    ? { client_id: cfg.clientId, client_secret: cfg.clientSecret, refresh_token: tokens.refresh_token, grant_type: "refresh_token" }
    : { client_key: cfg.clientId, client_secret: cfg.clientSecret, refresh_token: tokens.refresh_token, grant_type: "refresh_token" };
  return toTokenSet(await postForm(fetchFn, TOKEN_URL[provider], form), now, tokens);
}

export function needsRefresh(tokens: TokenSet, now = new Date(), marginSeconds = 300): boolean {
  return new Date(tokens.expires_at).getTime() - now.getTime() < marginSeconds * 1000;
}
