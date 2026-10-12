import { classifyHttpStatus, StepError } from "../core/backoff.ts";
import { redact } from "../core/crypto.ts";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface HttpOptions extends RequestInit {
  timeoutMs?: number;
  /** Name of the service, for error messages. */
  service?: string;
}

export const TIMEOUT_TEXT = "sem resposta no tempo limite";

export function isTimeout(e: unknown): boolean {
  return e instanceof StepError && e.message.includes(TIMEOUT_TEXT);
}

/** fetch with timeout; network errors become retryable StepErrors. */
export async function http(fetchFn: FetchLike, url: string, opts: HttpOptions = {}): Promise<Response> {
  const { timeoutMs = 60_000, service = new URL(url).host, ...init } = opts;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetchFn(url, { ...init, signal: init.signal ?? ctrl.signal });
  } catch (e) {
    if (ctrl.signal.aborted) throw new StepError(`${service}: ${TIMEOUT_TEXT} (${Math.round(timeoutMs / 1000)} s)`, "retryable");
    const msg = e instanceof Error ? e.message : String(e);
    throw new StepError(`${service}: falha de rede (${redact(msg)})`, "retryable");
  } finally {
    clearTimeout(timer);
  }
}

/** Throws a classified StepError for non-2xx responses. */
export async function ensureOk(res: Response, service: string): Promise<Response> {
  if (res.ok) return res;
  let body = "";
  try {
    body = (await res.text()).slice(0, 800);
  } catch {
    // ignore
  }
  const retryAfter = Number(res.headers.get("retry-after"));
  const after = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined;
  if (res.status === 503 || res.status === 429) {
    // Service busy or rate limited: wait and try again, without spending one
    // of the job's attempts.
    throw new StepError(`${service} ocupado agora (HTTP ${res.status}); nova tentativa em instantes. ${redact(body)}`.trim(), "waiting", after ?? 120);
  }
  throw new StepError(`${service}: HTTP ${res.status} ${redact(body)}`.trim(), classifyHttpStatus(res.status), after);
}

export async function httpJson<T>(fetchFn: FetchLike, url: string, opts: HttpOptions = {}): Promise<T> {
  const service = opts.service ?? new URL(url).host;
  const res = await ensureOk(await http(fetchFn, url, opts), service);
  try {
    return (await res.json()) as T;
  } catch {
    throw new StepError(`${service}: resposta não é JSON`, "retryable");
  }
}
