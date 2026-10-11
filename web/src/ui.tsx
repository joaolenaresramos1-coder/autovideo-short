import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { STATE_LABELS_PT, progressOf, type JobState } from "../../supabase/functions/_shared/core/states.ts";

export function Page({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <main className="page">
      <header className="page-head">
        <h1>{title}</h1>
        {actions && <div className="page-actions">{actions}</div>}
      </header>
      {children}
    </main>
  );
}

export function Card({ children, className = "", title, footer }: { children: ReactNode; className?: string; title?: ReactNode; footer?: ReactNode }) {
  return (
    <section className={`card ${className}`}>
      {title && <h2 className="card-title">{title}</h2>}
      {children}
      {footer && <div className="card-footer">{footer}</div>}
    </section>
  );
}

export function Stat({ label, value, hint, to, tone }: { label: string; value: ReactNode; hint?: ReactNode; to?: string; tone?: "warn" | "bad" | "good" }) {
  const body = (
    <>
      <span className="stat-label">{label}</span>
      <span className={`stat-value ${tone ?? ""}`}>{value}</span>
      {hint && <span className="stat-hint">{hint}</span>}
    </>
  );
  return to ? <Link className="stat" to={to}>{body}</Link> : <div className="stat">{body}</div>;
}

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "good" | "warn" | "bad" | "info" }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

const STATE_TONE: Partial<Record<JobState, "good" | "warn" | "bad" | "info">> = {
  published: "good",
  ready_to_publish: "good",
  failed: "bad",
  retry_wait: "warn",
  cancelled: "neutral" as never,
  scheduled: "info",
};

export function StateBadge({ state }: { state: JobState }) {
  return <Badge tone={STATE_TONE[state] ?? "info"}>{STATE_LABELS_PT[state]}</Badge>;
}

export function Progress({ value, tone }: { value: number; tone?: "warn" | "bad" | "good" }) {
  return (
    <div className={`progress ${tone ?? ""}`} role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100}>
      <span style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}

export function JobProgress({ state, resume }: { state: JobState; resume?: JobState | null }) {
  const tone = state === "failed" ? "bad" : state === "retry_wait" ? "warn" : state === "published" ? "good" : undefined;
  return <Progress value={progressOf(state, resume)} tone={tone} />;
}

export function Empty({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <p>{children}</p>
      {action}
    </div>
  );
}

export function ErrorBox({ error }: { error: string | null | undefined }) {
  if (!error) return null;
  return <div className="alert bad" role="alert">{error}</div>;
}

export function Loading() {
  return <div className="loading" aria-busy="true">Carregando…</div>;
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function Toast({ msg }: { msg: { text: string; kind: "ok" | "error" } | null }) {
  if (!msg) return null;
  return <div className={`toast ${msg.kind}`} role="status">{msg.text}</div>;
}

export function Tabs<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {options.map((o) => (
        <button key={o.value} role="tab" aria-selected={value === o.value} className={value === o.value ? "active" : ""} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export const fmtDate = (s: string | null | undefined, withTime = true) =>
  s
    ? new Date(s).toLocaleString("pt-BR", withTime ? { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" } : { day: "2-digit", month: "2-digit", year: "numeric" })
    : "—";

export const fmtUsd = (n: number | string | null | undefined) => `US$ ${Number(n ?? 0).toFixed(Number(n ?? 0) < 0.1 ? 4 : 2)}`;
