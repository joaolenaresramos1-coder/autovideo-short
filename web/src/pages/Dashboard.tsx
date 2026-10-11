import { Link } from "react-router-dom";
import { supabase, api } from "../supabase.ts";
import { rows, useQuery, useToast } from "../hooks.ts";
import { Card, Empty, ErrorBox, fmtDate, fmtUsd, JobProgress, Page, Progress, Stat, StateBadge, Toast } from "../ui.tsx";
import { formatBytes, quotaLevel } from "../../../supabase/functions/_shared/core/retention.ts";
import type { JobState } from "../../../supabase/functions/_shared/core/states.ts";
import { SetupChecklist } from "../setup.tsx";

interface JobRow {
  id: string;
  state: JobState;
  resume_state: JobState | null;
  slot_at: string;
  last_error: string | null;
  works: { title: string } | null;
}

export default function Dashboard() {
  const toast = useToast();
  const q = useQuery(async () => {
    const since = new Date();
    since.setHours(0, 0, 0, 0);
    const month = new Date(since.getFullYear(), since.getMonth(), 1);
    const [settings, active, upcoming, failed, publishedToday, usage, storage, alerts, works] = await Promise.all([
      rows(supabase.from("user_settings").select("*").maybeSingle()),
      rows(supabase.from("jobs").select("id, state, resume_state, slot_at, last_error, works(title)").not("state", "in", "(scheduled,published,cancelled,failed,ready_to_publish)").order("slot_at").limit(6)),
      rows(supabase.from("jobs").select("id, state, resume_state, slot_at, last_error, works(title)").eq("state", "scheduled").order("slot_at").limit(3)),
      supabase.from("jobs").select("id", { count: "exact", head: true }).eq("state", "failed"),
      supabase.from("publications").select("id", { count: "exact", head: true }).eq("status", "published").gte("confirmed_at", since.toISOString()),
      rows(supabase.from("usage_events").select("cost_usd, created_at").gte("created_at", month.toISOString())),
      supabase.rpc("storage_summary"),
      rows(supabase.from("alerts").select("*").is("resolved_at", null).order("created_at", { ascending: false }).limit(5)),
      supabase.from("works").select("id", { count: "exact", head: true }),
    ]);
    const u = usage as { cost_usd: number; created_at: string }[];
    return {
      settings: settings as { automation_paused: boolean; pause_reason: string | null } | null,
      active: active as unknown as JobRow[],
      upcoming: upcoming as unknown as JobRow[],
      failed: failed.count ?? 0,
      publishedToday: publishedToday.count ?? 0,
      dayCost: u.filter((x) => new Date(x.created_at) >= since).reduce((a, x) => a + Number(x.cost_usd), 0),
      monthCost: u.reduce((a, x) => a + Number(x.cost_usd), 0),
      storage: storage.data as { used_bytes: number; quota_bytes: number } | null,
      alerts: alerts as { id: string; level: string; message: string; created_at: string }[],
      works: works.count ?? 0,
    };
  }, [], 30_000);

  const d = q.data;
  const pct = d?.storage ? (d.storage.used_bytes / d.storage.quota_bytes) * 100 : 0;
  const level = d?.storage ? quotaLevel(d.storage.used_bytes, d.storage.quota_bytes) : 0;

  async function resume() {
    try {
      await api("resume_automation");
      toast.ok("Automação reativada");
      q.reload();
    } catch (e) {
      toast.fail((e as Error).message);
    }
  }

  async function resolve(id: string) {
    await supabase.from("alerts").update({ resolved_at: new Date().toISOString() }).eq("id", id);
    q.reload();
  }

  return (
    <Page title="Painel" actions={<Link className="btn primary" to="/gerar">✚ Gerar vídeo</Link>}>
      <ErrorBox error={q.error} />
      <div style={{ marginBottom: 12 }}><SetupChecklist /></div>
      {d?.settings?.automation_paused && (
        <div className="alert warn stack" role="alert">
          <strong>Automação pausada</strong>
          <span>{d.settings.pause_reason}. Tarefas concluídas foram preservadas.</span>
          <button className="primary" onClick={resume}>Reativar manualmente</button>
        </div>
      )}
      {d && d.works === 0 && (
        <Card>
          <Empty action={<Link className="btn primary" to="/obras/nova">Cadastrar primeira obra</Link>}>
            Comece cadastrando uma obra, depois configure o calendário e conecte o Gemini em Integrações.
          </Empty>
        </Card>
      )}
      <div className="grid two four" style={{ marginBottom: 12 }}>
        <Stat label="Em produção" value={d?.active.length ?? "…"} to="/fila" />
        <Stat label="Publicados hoje" value={d?.publishedToday ?? "…"} tone="good" to="/publicacoes" />
        <Stat label="Falhas" value={d?.failed ?? "…"} tone={d?.failed ? "bad" : undefined} to="/fila" />
        <Stat label="Custo hoje / mês" value={d ? fmtUsd(d.dayCost) : "…"} hint={d ? `mês: ${fmtUsd(d.monthCost)}` : undefined} to="/custos" />
      </div>

      <div className="stack">
        {d && d.alerts.length > 0 && (
          <Card title="Alertas">
            <div className="list">
              {d.alerts.map((a) => (
                <div key={a.id} className={`alert ${a.level === "critical" ? "bad" : "warn"} spread`}>
                  <span>{a.message}</span>
                  <button className="small" onClick={() => resolve(a.id)}>Ok</button>
                </div>
              ))}
            </div>
          </Card>
        )}

        <Card title="Armazenamento" footer={<Link to="/armazenamento">Detalhes</Link>}>
          {d?.storage ? (
            <div className="stack">
              <div className="spread small"><span>{formatBytes(d.storage.used_bytes)} de {formatBytes(d.storage.quota_bytes)}</span><span>{pct.toFixed(0)}%</span></div>
              <Progress value={pct} tone={level >= 95 ? "bad" : level >= 70 ? "warn" : undefined} />
            </div>
          ) : "…"}
        </Card>

        <Card title="Em produção agora" footer={<Link to="/fila">Ver fila</Link>}>
          {d && d.active.length === 0 && <p className="muted">Nada em produção no momento.</p>}
          <div className="list">
            {d?.active.map((j) => (
              <div key={j.id} className="item">
                <div className="spread"><strong>{j.works?.title}</strong><StateBadge state={j.state} /></div>
                <JobProgress state={j.state} resume={j.resume_state} />
                {j.last_error && j.state === "retry_wait" && <span className="small muted">{j.last_error}</span>}
              </div>
            ))}
          </div>
        </Card>

        <Card title="Próximas publicações" footer={<Link to="/calendario">Calendário</Link>}>
          {d && d.upcoming.length === 0 && <p className="muted">Nenhuma publicação agendada.</p>}
          <div className="list">
            {d?.upcoming.map((j) => (
              <div key={j.id} className="spread"><span>{j.works?.title}</span><span className="muted small">{fmtDate(j.slot_at)}</span></div>
            ))}
          </div>
        </Card>
        <p className="small muted">A produção acontece no servidor (Supabase + GitHub Actions). Você pode fechar este painel a qualquer momento.</p>
      </div>
      <Toast msg={toast.msg} />
    </Page>
  );
}
