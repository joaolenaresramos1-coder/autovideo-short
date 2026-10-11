import { useCallback, useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { configured, supabase } from "./supabase.ts";

export function useSession(): { session: Session | null; loading: boolean } {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(configured);
  useEffect(() => {
    if (!configured) return; // site not linked to Supabase yet: the setup guide is shown
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);
  return { session, loading };
}

export interface Query<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/**
 * Small data hook: runs `fn`, exposes loading/error, optional polling.
 * Polling pauses while the tab is hidden (the automation does not depend on it).
 */
export function useQuery<T>(fn: () => Promise<T>, deps: unknown[] = [], pollMs = 0): Query<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fnRef.current()
      .then((d) => alive && (setData(d), setError(null)))
      .catch((e) => alive && setError(e?.message ?? String(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  useEffect(() => {
    if (!pollMs) return;
    const id = setInterval(() => {
      if (document.visibilityState === "visible") reload();
    }, pollMs);
    return () => clearInterval(id);
  }, [pollMs, reload]);

  return { data, error, loading, reload };
}

/** Throws the Supabase error, returns data. */
export async function rows<T>(p: PromiseLike<{ data: T | null; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(error.message);
  return data as T;
}

export function useToast() {
  const [msg, setMsg] = useState<{ text: string; kind: "ok" | "error" } | null>(null);
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), 5000);
    return () => clearTimeout(t);
  }, [msg]);
  return { msg, ok: (text: string) => setMsg({ text, kind: "ok" }), fail: (text: string) => setMsg({ text, kind: "error" }) };
}
