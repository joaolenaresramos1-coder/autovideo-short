import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, supabase } from "../supabase.ts";
import { rows, useQuery, useToast } from "../hooks.ts";
import { Card, ErrorBox, Field, Page, Tabs, Toast } from "../ui.tsx";
import type { Platform } from "../../../supabase/functions/_shared/core/types.ts";

/** Manual generation: one chapter, by link or by files, produced right away. */
export default function Generate() {
  const nav = useNavigate();
  const toast = useToast();
  const works = useQuery(() => rows(supabase.from("works").select("id, title, standalone").eq("standalone", false).order("title")) as Promise<{ id: string; title: string }[]>);
  const [mode, setMode] = useState<"link" | "files">("link");
  const [workId, setWorkId] = useState("");
  const [title, setTitle] = useState("");
  const [type, setType] = useState("manhwa");
  const [url, setUrl] = useState("");
  const [chapter, setChapter] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [duration, setDuration] = useState(75);
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const toggle = (p: Platform) => setPlatforms((v) => (v.includes(p) ? v.filter((x) => x !== p) : [...v, p]));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (mode === "link" && !/^https?:\/\//i.test(url.trim())) return setError("Cole o link completo do capítulo (começando com https://).");
    if (mode === "files" && files.length === 0) return setError("Escolha as imagens do capítulo.");
    const base = { work_id: workId || undefined, title: workId ? undefined : title || undefined, type, chapter_key: chapter || undefined };
    try {
      let target = base;
      if (mode === "files") {
        setProgress("Preparando…");
        const prep = await api<{ work_id: string; chapter_key: string }>("prepare_chapter", base);
        target = { ...base, work_id: prep.work_id, chapter_key: prep.chapter_key, title: undefined };
        const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
        for (let i = 0; i < sorted.length; i++) {
          const f = sorted[i];
          setProgress(`Enviando ${i + 1}/${sorted.length}…`);
          const ct = f.type || (f.name.endsWith(".srt") ? "application/x-subrip" : f.name.endsWith(".vtt") ? "text/vtt" : "text/plain");
          const r = await api<{ path: string; token: string }>("upload_url", {
            work_id: prep.work_id, chapter_key: prep.chapter_key, filename: f.name, content_type: ct, size: f.size, order: i + 1,
          });
          const up = await supabase.storage.from("media").uploadToSignedUrl(r.path, r.token, f, { contentType: ct });
          if (up.error) throw new Error(up.error.message);
        }
      }
      setProgress("Iniciando a produção…");
      await api("generate_now", {
        ...target,
        chapter_url: mode === "link" ? url.trim() : undefined,
        target_duration_seconds: duration,
        platforms,
      });
      await api("process_now").catch(() => {});
      toast.ok("Produção iniciada! Acompanhe na Fila.");
      setTimeout(() => nav("/fila"), 800);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setProgress(null);
    }
  }

  return (
    <Page title="Gerar vídeo">
      <form className="stack" onSubmit={submit}>
        <Card>
          <div className="stack">
            <Tabs value={mode} onChange={setMode} options={[{ value: "link", label: "Link do capítulo" }, { value: "files", label: "Enviar imagens" }]} />
            {mode === "link" ? (
              <Field label="Link do capítulo" hint="Cole o endereço da página do capítulo (onde as imagens aparecem). Links do MangaDex também funcionam.">
                <input type="url" inputMode="url" autoComplete="off" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…/capitulo-12" />
              </Field>
            ) : (
              <Field label="Imagens do capítulo" hint="Na ordem de leitura (o nome do arquivo define a ordem). JPEG, PNG ou WebP, até 15 MB cada. Também aceita legendas TXT/SRT/VTT.">
                <input type="file" multiple accept="image/jpeg,image/png,image/webp,.txt,.srt,.vtt" onChange={(e) => setFiles([...(e.target.files ?? [])])} />
              </Field>
            )}
          </div>
        </Card>

        <Card title="Obra">
          <div className="stack">
            <Field label="De qual obra?">
              <select value={workId} onChange={(e) => setWorkId(e.target.value)}>
                <option value="">Capítulo avulso (sem cadastrar obra)</option>
                {works.data?.map((w) => <option key={w.id} value={w.id}>{w.title}</option>)}
              </select>
            </Field>
            {!workId && (
              <div className="grid two">
                <Field label="Nome (opcional)"><input value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="Ex.: Solo Leveling" /></Field>
                <Field label="Tipo">
                  <select value={type} onChange={(e) => setType(e.target.value)}>
                    <option value="manhwa">Manhwa</option><option value="manga">Mangá</option><option value="manhua">Manhua</option><option value="anime">Anime</option>
                  </select>
                </Field>
              </div>
            )}
            <Field label="Número do capítulo (opcional)" hint="Se ficar vazio, é detectado pelo link."><input inputMode="decimal" value={chapter} onChange={(e) => setChapter(e.target.value)} /></Field>
          </div>
        </Card>

        <Card title="Vídeo">
          <div className="stack">
            <Field label={`Duração desejada: ${duration} s`} hint="A duração final segue a narração real, entre 1 e 3 minutos.">
              <input type="range" min={60} max={180} step={5} value={duration} onChange={(e) => setDuration(Number(e.target.value))} />
            </Field>
            <div className="field">
              <span className="field-label">Publicar em</span>
              <div className="chips">
                {(["youtube", "tiktok"] as Platform[]).map((p) => (
                  <button type="button" key={p} className={`chip ${platforms.includes(p) ? "on" : ""}`} onClick={() => toggle(p)}>{p === "youtube" ? "YouTube" : "TikTok"}</button>
                ))}
              </div>
              <span className="field-hint">{platforms.length ? "Publica assim que ficar pronto." : "Nenhuma: o vídeo fica só para baixar em Vídeos."}</span>
            </div>
          </div>
        </Card>
        <ErrorBox error={error} />
        {progress && <div className="alert info">{progress}</div>}
        <button className="primary" disabled={!!progress}>Gerar vídeo</button>
        <p className="small muted">Você é responsável pelo material que envia e publica.</p>
      </form>
      <Toast msg={toast.msg} />
    </Page>
  );
}
