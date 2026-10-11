// AES-256-GCM for API keys and OAuth tokens stored in public.secrets.
// The key lives only in the Edge Function / worker environment
// (TOKEN_ENCRYPTION_KEY, 32 random bytes in base64).

import { base64ToBytes, bytesToBase64 } from "./wav.ts";

async function importKey(keyB64: string): Promise<CryptoKey> {
  const raw = base64ToBytes(keyB64);
  if (raw.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY deve ter 32 bytes em base64");
  return crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export interface Sealed {
  ciphertext: string;
  iv: string;
}

/** `aad` binds the ciphertext to its owner/name so rows cannot be swapped. */
export async function seal(plaintext: string, keyB64: string, aad: string): Promise<Sealed> {
  const key = await importKey(keyB64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) },
    key,
    new TextEncoder().encode(plaintext),
  );
  return { ciphertext: bytesToBase64(new Uint8Array(ct)), iv: bytesToBase64(iv) };
}

export async function open(sealed: Sealed, keyB64: string, aad: string): Promise<string> {
  const key = await importKey(keyB64);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(sealed.iv) as BufferSource, additionalData: new TextEncoder().encode(aad) },
    key,
    base64ToBytes(sealed.ciphertext) as BufferSource,
  );
  return new TextDecoder().decode(pt);
}

export function randomToken(bytes = 32): string {
  return bytesToBase64(crypto.getRandomValues(new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function sha256Base64Url(input: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return bytesToBase64(new Uint8Array(d)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Constant-time string comparison for shared secrets. */
export function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

/** Remove anything that looks like a secret before logging. */
export function redact(text: string): string {
  return text
    .replace(/(key=)[^&\s"]+/gi, "$1***")
    .replace(/(Bearer\s+)[A-Za-z0-9._\-]+/g, "$1***")
    .replace(/("?(?:access_token|refresh_token|api_key|client_secret|x-goog-api-key)"?\s*[:=]\s*"?)[^"\s,}]+/gi, "$1***")
    .replace(/AIza[0-9A-Za-z_\-]{20,}/g, "AIza***");
}
