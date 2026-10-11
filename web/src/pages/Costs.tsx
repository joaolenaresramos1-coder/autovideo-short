import { useEffect, useState } from "react";
import { api, supabase } from "../supabase.ts";
import { rows, useQuery, useToast } from "../hooks.ts";
import { Card, ErrorBox, Field, fmtDate, fmtUsd, Loading, Page, Progress, Stat, Toast } from "../ui.tsx";

interface Usage {
  id: number;
  provider: string;
  kind: string;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  units: number | null;
  unit_type: string | null;
  cost_usd: number;
  failed: boolean;
  created_at: string;
  job_id: string | null;
}
interface Settings {
  daily_cost_limit_usd: number;
  monthly_cost_limit_usd: number;
  daily_ai_call_limit: number;
  monthly_render_limit: number;
  gemini_tier: "free" | "paid";
  automation_paused: boolean;
  pause_reason: string | null;
}

const KIND: Record<string, string> = {
  gemini_text: "Gemini — texto/análise",
  gemini_tts: "Gemini — narração",
  gemini_image: "Gemini — ilustrações",
  render: "Renderizações",
};

export default function Costs() {
  const toast = useToast();
  const q = useQuery(async () => {
    const month = new Date();
    month.setDate(1);
    month.setHours(0, 0, 0, 0);
    const [usage, settings, published] = await Promise.all([
      rows(supabase.from("usage_events").select("*").gte("created_at", month.toISOString()).order("created_at", { ascending: false }).limit(1000)),
      rows(supabase.from("user_settings").select("*").single()),
      rows(supabase.from("jobs").select("cost_spent_usd").in("state", ["ready_to_publish", "publishing", "published"]).gte("created_at", month.toISOString())),
    ]);
    return { usage: usage as Usage[], settings: settings as unknown as Settings, published: published as { cost_spent_usd: number }[] };
  });
  const [limits, setLimits] = useState<Partial<Settings>>({});
  useEffect(() => {
    if (q.data) setLimits(q.data.settings);
  }, [q.data]);
  if (!q.data) return <Page title="Custos e consumo"><ErrorBox error={q.error} /><Loading /></Page>;

  const { usage, settings, published } = q.data;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const day = usage.filter((u) => new Date(u.created_at) >= today);
  const sum = (l: Usage[]) => l.reduce((a, u) => a + Number(u.cost_usd), 0);
  const groups = Object.entries(
    usage.reduce<Record<string, { calls: number; cost: number; inT: number; outT: number; units: number; unit: string | null; failed: number }>>((acc, u) => {
      const g = (acc[u.kind] ??= { calls: 0, cost: 0, inT: 0, outT: 0, units: 0, unit: u.unit_type, failed: 0 });
      g.calls++;
      g.cost += Number(u.cost_usd);
      g.inT += u.input_tokens ?? 0;
      g.outT += u.output_tokens ?? 0;
      g.units += Number(u.units ?? 0);
      if (u.failed) g.failed++;
      return acc;
    }, {}),
  );
  const perVideo = published.length ? published.reduce((a, j) => a + Number(j.cost_spent_usd), 0) / published.length : 0;
  const dayCalls = day.filter((u) => u.provider === "gemini").length;

  async function saveLimits(e: React.FormEvent) {
    e.preventDefault();
    const { error } = await supabase.from("user_settings").update({
      daily_cost_limit_usd: Number(limits.daily_cost_limit_usd), monthly_cost_limit_usd: Number(limits.monthly_cost_limit_usd),
      daily_ai_call_limit: Number(limits.daily_ai_call_limit), monthly_render_limit: Number(limits.monthly_render_limit), gemini_tier: limits.gemini_tier,
    }).eq("user_id", (await supabase.auth.getUser()).data.user!.id);
    if (error) toast.fail(error.message);
    else {
      toast.ok("Limites salvos");
      q.reload();
    }
  }

  return (
    <Page title="Custos e consumo">
      <div className="stack">
        {settings.automation_paused && (
          <div className="alert warn stack">
            <strong>Novas tarefas com custo estão interrompidas</strong>
            <span>{settings.pause_reason}</span>
            <button className="primary" onClick={() => api("resume_automation").then(() => { toast.ok("Reativado"); q.reload(); }, (e) => toast.fail(e.message))}>Reativar manualmente</button>
          </div>
        )}
        <div className="grid two four">
          <Stat label="Hoje" value={fmtUsd(sum(day))} hint={`limite ${fmtUsd(settings.daily_cost_limit_usd)}`} />
          <Stat label="Este mês" value={fmtUsd(sum(usage))} hint={`limite ${fmtUsd(settings.monthly_cost_limit_usd)}`} />
          <Stat label="Chamadas de IA hoje" value={dayCalls} hint={`limite ${settings.daily_ai_call_limit}`} />
          <Stat label="Média por vídeo" value={fmtUsd(perVideo)} hint={`${published.length} vídeo(s) no mês`} />
        </div>
        <Card title="Uso do mês">
          <div className="stack">
            <Progress value={(sum(usage) / Math.max(0.0001, settings.monthly_cost_limit_usd)) * 100} tone={sum(usage) >= settings.monthly_cost_limit_usd * 0.85 ? "warn" : undefined} />
            {settings.gemini_tier === "free" && <p className="small muted">Plano gratuito do Gemini: custo estimado zero, mas as chamadas e tokens continuam contados e os limites de chamadas valem.</p>}
            <div className="table-wrap">
              <table>
                <thead><tr><th>Tipo</th><th>Chamadas</th><th>Tokens (entrada/saída)</th><th>Unidades</th><th>Falhas</th><th>Custo</th></tr></thead>
                <tbody>
                  {groups.map(([k, g]) => (
                    <tr key={k}><td>{KIND[k] ?? k}</td><td>{g.calls}</td><td>{g.inT.toLocaleString("pt-BR")} / {g.outT.toLocaleString("pt-BR")}</td><td>{g.units ? `${g.units.toFixed(0)} ${g.unit ?? ""}` : "—"}</td><td>{g.failed}</td><td>{fmtUsd(g.cost)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="small muted">Valores em dólar são estimativas pela tabela pública de preços (ajustável em Configurações). O armazenamento do Supabase Free e o GitHub Actions em repositório público não geram custo.</p>
          </div>
        </Card>
        <Card title="Limites">
          <form className="stack" onSubmit={saveLimits}>
            <div className="grid two">
              <Field label="Limite diário (US$)"><input type="number" min={0} step={0.05} value={limits.daily_cost_limit_usd ?? 0} onChange={(e) => setLimits({ ...limits, daily_cost_limit_usd: Number(e.target.value) })} /></Field>
              <Field label="Limite mensal (US$)"><input type="number" min={0} step={0.5} value={limits.monthly_cost_limit_usd ?? 0} onChange={(e) => setLimits({ ...limits, monthly_cost_limit_usd: Number(e.target.value) })} /></Field>
              <Field label="Chamadas de IA por dia"><input type="number" min={0} value={limits.daily_ai_call_limit ?? 0} onChange={(e) => setLimits({ ...limits, daily_ai_call_limit: Number(e.target.value) })} /></Field>
              <Field label="Renderizações por mês"><input type="number" min={0} value={limits.monthly_render_limit ?? 0} onChange={(e) => setLimits({ ...limits, monthly_render_limit: Number(e.target.value) })} /></Field>
            </div>
            <Field label="Plano da API Gemini" hint="Usado só para estimar custos. Serviços pagos nunca são ativados por este sistema.">
              <select value={limits.gemini_tier} onChange={(e) => setLimits({ ...limits, gemini_tier: e.target.value as Settings["gemini_tier"] })}>
                <option value="free">Gratuito</option><option value="paid">Pago</option>
              </select>
            </Field>
            <button className="primary">Salvar limites</button>
          </form>
        </Card>
        <Card title="Últimos registros">
          <div className="list small">
            {usage.slice(0, 30).map((u) => (
              <div key={u.id} className="spread"><span>{fmtDate(u.created_at)} · {KIND[u.kind] ?? u.kind} · {u.model}{u.failed ? " · falhou" : ""}</span><span>{fmtUsd(u.cost_usd)}</span></div>
            ))}
          </div>
        </Card>
      </div>
      <Toast msg={toast.msg} />
    </Page>
  );
}
