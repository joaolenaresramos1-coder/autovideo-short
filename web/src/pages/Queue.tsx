import { useState } from "react";
import { api, supabase } from "../supabase.ts";
import { rows, useQuery, useToast } from "../hooks.ts";
import { Card, Empty, ErrorBox, fmtDate, fmtUsd, JobProgress, Loading, Page, StateBadge, Tabs, Toast } from "../ui.tsx";
import { STATE_LABELS_PT, type JobState } from "../../../supabase/functions/_shared/core/states.ts";

interface JobRow {
  id: string;
  state: JobState;
  resume_state: JobState | null;
  slot_at: string;
  run_at: string;
  attempts: number;
  max_attempts: number;
  next_attempt_at: string | null;
  last_error: string | null;
  waiting_reason: string | null;
  cost_spent_usd: number;
  summary_format: string;
  works: { title: string } | null;
  chapters: { chapter_key: string } | null;
}
interface StepRow { step: string; status: string; error: string | null; finished_at: string | null; attempt: number }
interface LogRow { id: number; level: string; event: string; message: string | null; created_at: string }

const FILTERS: Record<string, JobState[]> = {
  active: ["queued", "discovering", "fetching", "analyzing", "scripting", "audio_generating", "rendering", "validating", "publishing", "retry_wait"],
  scheduled: ["scheduled"],
  failed: ["failed"],
  done: ["ready_to_publish", "published", "cancelled"],
};

export default function Queue() {
  const toast = useToast();
  const [filter, setFilter] = useState<keyof typeof FILTERS>("active");
  const [open, setOpen] = useState<string | null>(null);
  const q = useQuery(
    () => rows(supabase.from("jobs").select("*, works(title), chapters(chapter_key)").in("state", FILTERS[filter]).order("slot_at", { ascending: filter !== "done" }).limit(60)) as Promise<JobRow[]>,
    [filter],
    15_000,
  );

  async function act(job: JobRow, op: "retry" | "cancel" | "run_now") {
    if (op === "cancel" && !confirm("Cancelar esta tarefa?")) return;
    try {
      const r = await api<{ state: JobState }>("job_action", { job_id: job.id, op });
      toast.ok(`Tarefa: ${STATE_LABELS_PT[r.state]}`);
      q.reload();
    } catch (e) {
      toast.fail((e as Error).message);
    }
  }

  return (
    <Page title="Fila de processamento" actions={<button className="small" onClick={() => api("process_now").then(() => toast.ok("Worker acionado"), (e) => toast.fail(e.message))}>Processar agora</button>}>
      <ErrorBox error={q.error} />
      <Tabs value={filter} onChange={setFilter} options={[
        { value: "active", label: "Em andamento" }, { value: "scheduled", label: "Agendadas" }, { value: "failed", label: "Falhas" }, { value: "done", label: "Concluídas" },
      ]} />
      <div className="list" style={{ marginTop: 12 }}>
        {q.loading && !q.data && <Loading />}
        {q.data?.length === 0 && <Card><Empty>Nenhuma tarefa nesta lista.</Empty></Card>}
        {q.data?.map((j) => (
          <Card key={j.id}>
            <div className="stack">
              <div className="spread"><strong>{j.works?.title}{j.chapters ? ` · cap. ${j.chapters.chapter_key}` : ""}</strong><StateBadge state={j.state} /></div>
              <JobProgress state={j.state} resume={j.resume_state} />
              <div className="row small muted">
                <span>Publicação: {fmtDate(j.slot_at)}</span>·<span>Tentativas: {j.attempts}/{j.max_attempts}</span>·<span>Custo: {fmtUsd(j.cost_spent_usd)}</span>
              </div>
              {j.state === "retry_wait" && (
                <div className="alert warn small">
                  {j.waiting_reason ?? j.last_error} {j.next_attempt_at ? `— nova tentativa ${fmtDate(j.next_attempt_at)}` : ""}
                  {j.resume_state && <> (retoma em: {STATE_LABELS_PT[j.resume_state]})</>}
                </div>
              )}
              {j.state === "failed" && j.last_error && <div className="alert bad small">{j.last_error}</div>}
              <div className="row">
                {(j.state === "failed" || j.state === "retry_wait" || j.state === "cancelled") && <button className="small primary" onClick={() => act(j, "retry")}>Reprocessar</button>}
                {j.state === "scheduled" && <button className="small" onClick={() => act(j, "run_now")}>Produzir agora</button>}
                {!["published", "cancelled", "publishing"].includes(j.state) && <button className="small danger" onClick={() => act(j, "cancel")}>Cancelar</button>}
                <button className="small" onClick={() => setOpen(open === j.id ? null : j.id)}>{open === j.id ? "Ocultar etapas" : "Etapas e logs"}</button>
              </div>
              {open === j.id && <JobDetail id={j.id} />}
            </div>
          </Card>
        ))}
      </div>
      <Toast msg={toast.msg} />
    </Page>
  );
}

function JobDetail({ id }: { id: string }) {
  const q = useQuery(async () => {
    const [steps, logs] = await Promise.all([
      rows(supabase.from("job_steps").select("step, status, error, finished_at, attempt").eq("job_id", id).order("started_at")),
      rows(supabase.from("job_logs").select("id, level, event, message, created_at").eq("job_id", id).order("created_at", { ascending: false }).limit(30)),
    ]);
    return { steps: steps as StepRow[], logs: logs as LogRow[] };
  }, [id]);
  if (!q.data) return <Loading />;
  return (
    <div className="stack small">
      <div className="table-wrap">
        <table>
          <thead><tr><th>Etapa</th><th>Situação</th><th>Concluída</th></tr></thead>
          <tbody>
            {q.data.steps.map((s) => (
              <tr key={s.step}>
                <td>{STATE_LABELS_PT[s.step as JobState] ?? s.step}</td>
                <td className={s.status === "succeeded" ? "check-ok" : s.status === "failed" ? "check-bad" : ""}>
                  {{ succeeded: "concluída (checkpoint salvo)", failed: "falhou", running: "em andamento" }[s.status] ?? s.status}
                  {s.error && <div className="muted">{s.error}</div>}
                </td>
                <td>{fmtDate(s.finished_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="list">
        {q.data.logs.map((l) => (
          <div key={l.id} className="row"><span className="muted">{fmtDate(l.created_at)}</span><span className={l.level === "error" ? "check-bad" : ""}>{l.event}</span><span>{l.message}</span></div>
        ))}
      </div>
    </div>
  );
}
