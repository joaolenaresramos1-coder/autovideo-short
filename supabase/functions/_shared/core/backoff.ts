export interface BackoffOptions {
  baseSeconds?: number;
  maxSeconds?: number;
  /** 0..1 — fraction of random jitter added to spread retries. */
  jitter?: number;
  random?: () => number;
}

/** Exponential backoff: base * 2^(attempt-1), capped, with jitter. attempt starts at 1. */
export function backoffSeconds(attempt: number, opts: BackoffOptions = {}): number {
  const base = opts.baseSeconds ?? 60;
  const max = opts.maxSeconds ?? 6 * 3600;
  const jitter = opts.jitter ?? 0.2;
  const rnd = opts.random ?? Math.random;
  const n = Math.max(1, Math.floor(attempt));
  const raw = Math.min(max, base * 2 ** (n - 1));
  return Math.round(Math.min(max, raw * (1 + jitter * rnd())));
}

export type ErrorKind = "retryable" | "permanent" | "quota" | "config" | "waiting";

/** Error carrying how the pipeline should react to it. */
export class StepError extends Error {
  kind: ErrorKind;
  retryAfterSeconds?: number;
  constructor(message: string, kind: ErrorKind = "retryable", retryAfterSeconds?: number) {
    super(message);
    this.name = "StepError";
    this.kind = kind;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Classify HTTP failures from external APIs. */
export function classifyHttpStatus(status: number): ErrorKind {
  if (status === 401 || status === 403) return "config";
  if (status === 429) return "retryable";
  if (status === 408 || status >= 500) return "retryable";
  return "permanent";
}

export function toStepError(e: unknown): StepError {
  if (e instanceof StepError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  return new StepError(msg, "retryable");
}
