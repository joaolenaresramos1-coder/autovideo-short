import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { supabase } from "../supabase.ts";
import { rows, useQuery, useToast } from "../hooks.ts";
import { Badge, Card, Empty, ErrorBox, Field, Page, StateBadge, Tabs, Toast } from "../ui.tsx";
import { expandSchedule } from "../../../supabase/functions/_shared/core/schedule.ts";
import type { JobState } from "../../../supabase/functions/_shared/core/states.ts";
import type { Platform, Schedule } from "../../../supabase/functions/_shared/core/types.ts";

type S = Schedule & { works: { title: string } | null };
interface J { id: string; state: JobState; slot_at: string; dedupe_key: string; work_id: string; works: { title: string } | null }
interface Ev { key: string; at: Date; title: string; state?: JobState; projected: boolean }

const DAYS = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

export default function Calendar() {
  const [params] = useSearchParams();
  const toast = useToast();
  const [view, setView] = useState<"month" | "week" | "day">("month");
  const [cursor, setCursor] = useState(() => new Date());
  const [editing, setEditing] = useState<Partial<S> | null>(null);

  const range = useMemo(() => {
    const start = new Date(cursor);
    start.setHours(0, 0, 0, 0);
    if (view === "month") {
      start.setDate(1);
      start.setDate(1 - start.getDay());
      return { start, end: new Date(start.getTime() + 42 * 86400_000) };
    }
    if (view === "week") {
      start.setDate(start.getDate() - start.getDay());
      return { start, end: new Date(start.getTime() + 7 * 86400_000) };
    }
    return { start, end: new Date(start.getTime() + 86400_000) };
  }, [cursor, view]);

  const q = useQuery(async () => {
    const [schedules, jobs, works] = await Promise.all([
      rows(supabase.from("schedules").select("*, works(title)").order("created_at")),
      rows(supabase.from("jobs").select("id, state, slot_at, dedupe_key, work_id, works(title)").gte("slot_at", range.start.toISOString()).lt("slot_at", range.end.toISOString())),
      rows(supabase.from("works").select("id, title").order("title")),
    ]);
    return { schedules: schedules as unknown as S[], jobs: jobs as unknown as J[], works: works as { id: string; title: string }[] };
  }, [range.start.getTime(), range.end.getTime()]);

  const events = useMemo(() => {
    if (!q.data) return new Map<string, Ev[]>();
    const filter = params.get("obra");
    const evs: Ev[] = q.data.jobs.filter((j) => !filter || j.work_id === filter).map((j) => ({ key: j.dedupe_key, at: new Date(j.slot_at), title: j.works?.title ?? "", state: j.state, projected: false }));
    const known = new Set(evs.map((e) => e.key));
    for (const s of q.data.schedules) {
      if (filter && s.work_id !== filter) continue;
      for (const slot of expandSchedule({ ...s, time_of_day: s.time_of_day.slice(0, 5) }, range.start, range.end)) {
        if (!known.has(slot.dedupeKey) && slot.slotAt > new Date()) {
          evs.push({ key: slot.dedupeKey, at: slot.slotAt, title: s.works?.title ?? "", projected: true });
        }
      }
    }
    const map = new Map<string, Ev[]>();
    for (const e of evs.sort((a, b) => a.at.getTime() - b.at.getTime())) {
      const k = dayKey(e.at);
      map.set(k, [...(map.get(k) ?? []), e]);
    }
    return map;
  }, [q.data, range, params]);

  const move = (n: number) => {
    const d = new Date(cursor);
    if (view === "month") d.setMonth(d.getMonth() + n);
    else d.setDate(d.getDate() + (view === "week" ? 7 * n : n));
    setCursor(d);
  };
  const days: Date[] = [];
  for (let t = range.start.getTime(); t < range.end.getTime(); t += 86400_000) days.push(new Date(t));
  const title = view === "month"
    ? cursor.toLocaleDateString("pt-BR", { month: "long", year: "numeric" })
    : view === "week"
      ? `Semana de ${range.start.toLocaleDateString("pt-BR", { day: "2-digit", month: "short" })}`
      : cursor.toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "long" });

  async function toggle(s: S) {
    await supabase.from("schedules").update({ active: !s.active }).eq("id", s.id);
    q.reload();
  }
  async function remove(s: S) {
    if (!confirm("Excluir esta programação? Tarefas já criadas continuam na fila.")) return;
    await supabase.from("schedules").delete().eq("id", s.id);
    q.reload();
  }

  return (
    <Page title="Calendário" actions={<button className="primary small" onClick={() => setEditing({})}>+ Programação</button>}>
      <ErrorBox error={q.error} />
      {editing && q.data && (
        <ScheduleForm initial={editing} works={q.data.works} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); toast.ok("Programação salva"); q.reload(); }} />
      )}
      <div className="stack">
        <Tabs value={view} onChange={setView} options={[{ value: "month", label: "Mês" }, { value: "week", label: "Semana" }, { value: "day", label: "Dia" }]} />
        <div className="spread">
          <button className="small" onClick={() => move(-1)} aria-label="Anterior">‹</button>
          <strong>{title.charAt(0).toUpperCase() + title.slice(1)}</strong>
          <button className="small" onClick={() => move(1)} aria-label="Próximo">›</button>
        </div>

        {view === "month" ? (
          <div className="cal">
            {DAYS.map((d) => <div key={d} className="cal-head">{d}</div>)}
            {days.map((d) => {
              const evs = events.get(dayKey(d)) ?? [];
              return (
                <button key={d.toISOString()} className={`cal-day ${d.getMonth() !== cursor.getMonth() ? "other" : ""} ${dayKey(d) === dayKey(new Date()) ? "today" : ""}`}
                  onClick={() => { setCursor(d); setView("day"); }}>
                  <span>{d.getDate()}</span>
                  {evs.slice(0, 2).map((e) => (
                    <span key={e.key} className={`dot ${e.state === "published" ? "done" : e.state === "failed" ? "fail" : ""}`}>{e.title}</span>
                  ))}
                  {evs.length > 2 && <span className="muted">+{evs.length - 2}</span>}
                </button>
              );
            })}
          </div>
        ) : (
          <div className="timeline">
            {days.map((d) => (
              <Card key={d.toISOString()} title={d.toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "2-digit" })}>
                {(events.get(dayKey(d)) ?? []).length === 0 && <span className="muted small">Sem publicações</span>}
                <div className="list">
                  {(events.get(dayKey(d)) ?? []).map((e) => (
                    <div key={e.key} className="spread">
                      <span><strong>{e.at.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}</strong> {e.title}</span>
                      {e.state ? <StateBadge state={e.state} /> : <Badge>Previsto</Badge>}
                    </div>
                  ))}
                </div>
              </Card>
            ))}
          </div>
        )}

        <h2 style={{ fontSize: "1.1rem", marginTop: 8 }}>Programações</h2>
        {q.data && q.data.schedules.length === 0 && <Card><Empty>Nenhuma programação. Crie uma para que os vídeos sejam produzidos automaticamente.</Empty></Card>}
        {q.data?.schedules.map((s) => (
          <Card key={s.id}>
            <div className="spread"><strong>{s.works?.title}</strong><Badge tone={s.active ? "good" : "neutral"}>{s.active ? "Ativa" : "Pausada"}</Badge></div>
            <p className="small muted">
              {s.days_of_week.map((d) => DAYS[d]).join(", ")} às {s.time_of_day.slice(0, 5)} ({s.timezone}) · {s.videos_per_slot} vídeo(s) · {s.target_duration_seconds}s ·{" "}
              {s.platforms.join(" + ") || "sem publicação automática"} · prioridade {s.priority} · limite US$ {Number(s.cost_limit_usd).toFixed(2)}/vídeo
            </p>
            <div className="card-footer">
              <button className="small" onClick={() => setEditing(s)}>Editar</button>
              <button className="small" onClick={() => toggle(s)}>{s.active ? "Pausar" : "Ativar"}</button>
              <button className="small danger" onClick={() => remove(s)}>Excluir</button>
            </div>
          </Card>
        ))}
      </div>
      <Toast msg={toast.msg} />
    </Page>
  );
}

function ScheduleForm({ initial, works, onClose, onSaved }: { initial: Partial<S>; works: { id: string; title: string }[]; onClose: () => void; onSaved: () => void }) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Sao_Paulo";
  const [s, setS] = useState<Partial<Schedule>>({
    work_id: works[0]?.id, days_of_week: [1, 3, 5], time_of_day: "18:00", timezone: tz, videos_per_slot: 1,
    target_duration_seconds: 75, summary_format: "chapter", platforms: [], priority: 5, cost_limit_usd: 0.5,
    no_chapter_policy: "wait", replacement_format: "recap", lead_minutes: 180, active: true, ...initial,
  });
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof Schedule>(k: K, v: Schedule[K]) => setS((p) => ({ ...p, [k]: v }));
  const toggleDay = (d: number) => set("days_of_week", (s.days_of_week ?? []).includes(d) ? (s.days_of_week ?? []).filter((x) => x !== d) : [...(s.days_of_week ?? []), d].sort());
  const togglePlatform = (p: Platform) => set("platforms", (s.platforms ?? []).includes(p) ? (s.platforms ?? []).filter((x) => x !== p) : [...(s.platforms ?? []), p]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const payload = {
      work_id: s.work_id, days_of_week: s.days_of_week, time_of_day: s.time_of_day, timezone: s.timezone,
      videos_per_slot: Number(s.videos_per_slot), target_duration_seconds: Number(s.target_duration_seconds),
      summary_format: s.summary_format, platforms: s.platforms, priority: Number(s.priority), cost_limit_usd: Number(s.cost_limit_usd),
      no_chapter_policy: s.no_chapter_policy, replacement_format: s.replacement_format, lead_minutes: Number(s.lead_minutes), active: s.active,
      materialized_until: null,
    };
    const r = initial.id ? await supabase.from("schedules").update(payload).eq("id", initial.id) : await supabase.from("schedules").insert(payload);
    if (r.error) setError(r.error.message);
    else onSaved();
  }

  if (works.length === 0) return <Card><Empty>Cadastre uma obra antes de criar a programação.</Empty></Card>;
  return (
    <Card title={initial.id ? "Editar programação" : "Nova programação"}>
      <form className="stack" onSubmit={save}>
        <Field label="Obra"><select value={s.work_id} onChange={(e) => set("work_id", e.target.value)}>{works.map((w) => <option key={w.id} value={w.id}>{w.title}</option>)}</select></Field>
        <div className="field">
          <span className="field-label">Dias de publicação</span>
          <div className="chips">{DAYS.map((d, i) => <button type="button" key={d} className={`chip ${(s.days_of_week ?? []).includes(i) ? "on" : ""}`} onClick={() => toggleDay(i)}>{d}</button>)}</div>
        </div>
        <div className="grid two">
          <Field label="Horário"><input type="time" required value={s.time_of_day?.slice(0, 5)} onChange={(e) => set("time_of_day", e.target.value)} /></Field>
          <Field label="Fuso horário"><input required value={s.timezone} onChange={(e) => set("timezone", e.target.value)} /></Field>
          <Field label="Vídeos por horário"><input type="number" min={1} max={5} value={s.videos_per_slot} onChange={(e) => set("videos_per_slot", Number(e.target.value))} /></Field>
          <Field label="Duração desejada (s)" hint="60 a 180"><input type="number" min={60} max={180} step={5} value={s.target_duration_seconds} onChange={(e) => set("target_duration_seconds", Number(e.target.value))} /></Field>
          <Field label="Prioridade (1–10)"><input type="number" min={1} max={10} value={s.priority} onChange={(e) => set("priority", Number(e.target.value))} /></Field>
          <Field label="Limite de custo por vídeo (US$)"><input type="number" min={0} step={0.05} value={s.cost_limit_usd} onChange={(e) => set("cost_limit_usd", Number(e.target.value))} /></Field>
        </div>
        <Field label="Tipo de resumo">
          <select value={s.summary_format} onChange={(e) => set("summary_format", e.target.value as Schedule["summary_format"])}>
            <option value="chapter">Capítulo / episódio novo</option><option value="arc">Arco narrativo</option><option value="full_work">Obra completa</option><option value="recap">Recapitulação</option>
          </select>
        </Field>
        <div className="field">
          <span className="field-label">Plataformas</span>
          <div className="chips">{(["youtube", "tiktok"] as Platform[]).map((p) => <button type="button" key={p} className={`chip ${(s.platforms ?? []).includes(p) ? "on" : ""}`} onClick={() => togglePlatform(p)}>{p === "youtube" ? "YouTube" : "TikTok"}</button>)}</div>
          <span className="field-hint">Sem plataforma: o vídeo fica disponível só para download.</span>
        </div>
        <Field label="Se não houver capítulo novo">
          <select value={s.no_chapter_policy} onChange={(e) => set("no_chapter_policy", e.target.value as Schedule["no_chapter_policy"])}>
            <option value="wait">Aguardar (até 24 h após o horário)</option>
            <option value="replace">Substituir por recapitulação da memória (exige ilustrações originais)</option>
            <option value="skip">Pular este horário</option>
          </select>
        </Field>
        <Field label="Começar a produção com antecedência de (min)" hint="Tempo para análise, narração e renderização"><input type="number" min={30} max={1440} value={s.lead_minutes} onChange={(e) => set("lead_minutes", Number(e.target.value))} /></Field>
        <ErrorBox error={error} />
        <div className="row"><button className="primary">Salvar</button><button type="button" onClick={onClose}>Cancelar</button></div>
      </form>
    </Card>
  );
}
