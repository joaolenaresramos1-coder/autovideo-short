import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Public values only: the project URL and the publishable (anon) key are meant
// for the browser. Every table is protected by RLS and secrets stay on the
// server. They come from the build (VITE_*) or are typed once in the panel and
// kept in this browser.
const STORAGE_KEY = "autovideo.connection";

interface Connection {
  url: string;
  key: string;
}

function readStored(): Connection | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const c = raw ? (JSON.parse(raw) as Connection) : null;
    return c?.url && c?.key ? c : null;
  } catch {
    return null;
  }
}

const envUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const envKey = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? import.meta.env.VITE_SUPABASE_ANON_KEY) as string | undefined;
const stored = readStored();

export const connection: Connection | null = envUrl && envKey ? { url: envUrl, key: envKey } : stored;
export const connectionSource: "build" | "browser" | null = envUrl && envKey ? "build" : stored ? "browser" : null;
export const configured = connection !== null;

export const supabase: SupabaseClient = configured
  ? createClient(connection!.url, connection!.key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } })
  : (null as unknown as SupabaseClient);

/** Normalise what the user pasted: accepts the full URL or just the project ref. */
export function normalizeSupabaseUrl(input: string): string {
  const v = input.trim().replace(/\/+$/, "");
  if (/^[a-z0-9]{15,30}$/.test(v)) return `https://${v}.supabase.co`;
  return v;
}

/** Checks the values against the project itself, then stores them and reloads. */
export async function saveConnection(urlInput: string, keyInput: string): Promise<void> {
  const url = normalizeSupabaseUrl(urlInput);
  const key = keyInput.trim();
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.(co|in|net)$/.test(url)) {
    throw new Error("URL inválida. Use o formato https://xxxx.supabase.co (Project Settings → API).");
  }
  if (key.length < 20) throw new Error("Chave muito curta. Copie a chave publishable (ou anon) completa.");
  if (/service_role|sb_secret_/.test(key) || decodesToServiceRole(key)) {
    throw new Error("Esta é a chave secreta (service_role). Aqui vai a chave pública: publishable ou anon.");
  }
  let res: Response;
  try {
    res = await fetch(`${url}/auth/v1/settings`, { headers: { apikey: key } });
  } catch {
    throw new Error("Não foi possível falar com o projeto. Confira a URL e se o projeto está ativo.");
  }
  if (res.status === 401 || res.status === 403) throw new Error("O Supabase recusou a chave. Confira se copiou a chave publishable/anon deste projeto.");
  if (!res.ok) throw new Error(`O Supabase respondeu com erro ${res.status}.`);
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ url, key }));
  window.location.reload();
}

export function clearConnection(): void {
  localStorage.removeItem(STORAGE_KEY);
  window.location.reload();
}

function decodesToServiceRole(key: string): boolean {
  try {
    const payload = JSON.parse(atob(key.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    return payload?.role === "service_role";
  } catch {
    return false;
  }
}

export class ApiFailure extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** Calls the authenticated `api` Edge Function. */
export async function api<T = unknown>(action: string, body: Record<string, unknown> = {}): Promise<T> {
  const { data, error, response } = await supabase.functions.invoke("api", { body: { action, ...body } }) as {
    data: T;
    error: (Error & { context?: Response }) | null;
    response?: Response;
  };
  if (error) {
    let message = error.message;
    const res = error.context ?? response;
    try {
      const j = await res?.clone().json();
      if (j?.error) message = j.error;
    } catch {
      // keep generic message
    }
    throw new ApiFailure(message, res?.status ?? 500);
  }
  return data;
}
