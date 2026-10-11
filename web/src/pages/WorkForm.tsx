import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, supabase } from "../supabase.ts";
import { Card, ErrorBox, Field, Page } from "../ui.tsx";
import { detectSource } from "../../../supabase/functions/_shared/connectors/index.ts";
import type { Platform, Work } from "../../../supabase/functions/_shared/core/types.ts";

const EMPTY: Partial<Work> = {
  title: "",
  type: "manhwa",
  url: "",
  source: "upload",
  language: "pt-BR",
  monitor_interval_minutes: 360,
  summary_format: "chapter",
  target_platforms: [],
  visual_mode: "source_panels",
};

export default function WorkForm() {
  const { id } = useParams();
  const nav = useNavigate();
  const [w, setW] = useState<Partial<Work>>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    supabase.from("works").select("*").eq("id", id).single().then(({ data, error }) => {
      if (error) setError(error.message);
      else setW(data as Work);
    });
  }, [id]);

  const set = <K extends keyof Work>(k: K, v: Work[K]) => setW((p) => ({ ...p, [k]: v }));
  const togglePlatform = (p: Platform) =>
    set("target_platforms", (w.target_platforms ?? []).includes(p) ? (w.target_platforms ?? []).filter((x) => x !== p) : [...(w.target_platforms ?? []), p]);

  const onUrl = (url: string) => setW((p) => ({ ...p, url, source: detectSource(url) }));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const payload = {
      title: w.title?.trim(),
      type: w.type,
      url: w.url?.trim() || null,
      source: detectSource(w.url),
      language: w.language,
      monitor_interval_minutes: Number(w.monitor_interval_minutes),
      summary_format: w.summary_format,
      target_platforms: w.target_platforms,
      visual_mode: w.visual_mode,
      status: "active" as const,
      next_check_at: new Date().toISOString(),
    };
    const r = id
      ? await supabase.from("works").update(payload).eq("id", id).select("id").single()
      : await supabase.from("works").insert(payload).select("id").single();
    if (r.error) {
      setBusy(false);
      setError(r.error.message);
      return;
    }
    // Server-side check of the source; the work stays saved even if it fails.
    try {
      await api("check_work", { work_id: r.data.id });
    } catch {
      // the detail page shows the status reason
    }
    setBusy(false);
    nav(`/obras/${r.data.id}`);
  }

  return (
    <Page title={id ? "Editar obra" : "Nova obra"}>
      <form className="stack" onSubmit={save}>
        <Card title="Obra">
          <div className="stack">
            <Field label="Nome da obra"><input required maxLength={200} value={w.title ?? ""} onChange={(e) => set("title", e.target.value)} /></Field>
            <Field label="Tipo">
              <select value={w.type} onChange={(e) => set("type", e.target.value as Work["type"])}>
                <option value="manga">Mangá</option><option value="manhua">Manhua</option><option value="manhwa">Manhwa</option><option value="anime">Anime</option>
              </select>
            </Field>
            <Field label="Link da obra (opcional)" hint="Cole o link da página da obra em qualquer site. Os capítulos são encontrados nessa página; você também pode gerar cada capítulo pelo link dele em Gerar vídeo.">
              <input type="url" inputMode="url" placeholder="https://…" value={w.url ?? ""} onChange={(e) => onUrl(e.target.value)} />
            </Field>
            <Field label="Idioma da obra"><input value={w.language ?? ""} onChange={(e) => set("language", e.target.value)} placeholder="pt-BR" /></Field>
          </div>
        </Card>

        <Card title="Produção">
          <div className="stack">
            <Field label="Verificar novos capítulos a cada">
              <select value={w.monitor_interval_minutes} onChange={(e) => set("monitor_interval_minutes", Number(e.target.value))}>
                <option value={60}>1 hora</option><option value={180}>3 horas</option><option value={360}>6 horas</option><option value={720}>12 horas</option><option value={1440}>1 dia</option>
              </select>
            </Field>
            <Field label="Formato de resumo">
              <select value={w.summary_format} onChange={(e) => set("summary_format", e.target.value as Work["summary_format"])}>
                <option value="chapter">Capítulo / episódio</option><option value="arc">Arco narrativo</option><option value="full_work">Obra completa</option>
              </select>
            </Field>
            <Field label="Imagens do vídeo">
              <select value={w.visual_mode} onChange={(e) => set("visual_mode", e.target.value as Work["visual_mode"])}>
                <option value="source_panels">Páginas/quadros da obra</option>
                <option value="uploaded">Material enviado por mim</option>
                <option value="ai_illustrations">Ilustrações originais geradas por IA (custo extra)</option>
              </select>
            </Field>
            <div className="field">
              <span className="field-label">Plataformas de destino</span>
              <div className="chips">
                {(["youtube", "tiktok"] as Platform[]).map((p) => (
                  <button type="button" key={p} className={`chip ${(w.target_platforms ?? []).includes(p) ? "on" : ""}`} onClick={() => togglePlatform(p)}>
                    {p === "youtube" ? "YouTube" : "TikTok"}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </Card>

        <ErrorBox error={error} />
        <button className="primary" disabled={busy}>{busy ? "Salvando e lendo o link…" : "Salvar"}</button>
      </form>
    </Page>
  );
}
