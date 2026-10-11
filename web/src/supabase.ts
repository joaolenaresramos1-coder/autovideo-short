import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Public values only: the URL and the publishable (anon) key are meant for the
// browser. Every table is protected by RLS and secrets stay on the server.
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? import.meta.env.VITE_SUPABASE_ANON_KEY) as string | undefined;

export const configured = Boolean(url && key);

export const supabase: SupabaseClient = configured
  ? createClient(url!, key!, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } })
  : (null as unknown as SupabaseClient);

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
