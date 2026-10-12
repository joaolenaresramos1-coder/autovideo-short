import { classifyHttpStatus, StepError } from "../core/backoff.ts";
import { redact } from "../core/crypto.ts";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface HttpOptions extends RequestInit {
  timeoutMs?: number;
  /** Name of the service, for error messages. */
  service?: string;
}

/** "retryDelay": "75583s" (Google RetryInfo) or "retry in 20h59m43.9s" / "try again in 7m12s" in an error body. */
export function retryDelayFrom(body: string): number | undefined {
  const rd = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(body);
  if (rd) return Math.ceil(Number(rd[1]));
  const m = /(?:retry|try again) in\s+(?:(\d+)h)?\s*(?:(\d+)m(?!s))?\s*(?:([\d.]+)s)?/i.exec(body);
  if (!m || (!m[1] && !m[2] && !m[3])) return undefined;
  return Math.ceil(Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0));
}

export function formatWait(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
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
    body = (await res.text()).slice(0, 2000);
  } catch {
    // ignore
  }
  const retryAfter = Number(res.headers.get("retry-after"));
  const after = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined;
  if (res.status === 503 || res.status === 429) {
    // Service busy or rate limited: wait and try again, without spending one
    // of the job's attempts. A daily quota says how long to wait.
    const wait = after ?? retryDelayFrom(body) ?? 120;
    const msg = wait > 900
      ? `${service}: cota grátis esgotada (HTTP ${res.status}); libera em ~${formatWait(wait)}. ${redact(body)}`
      : `${service} ocupado agora (HTTP ${res.status}); nova tentativa em instantes. ${redact(body)}`;
    throw new StepError(msg.trim(), "waiting", wait);
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
