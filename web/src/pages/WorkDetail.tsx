import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, supabase } from "../supabase.ts";
import { rows, useQuery, useToast } from "../hooks.ts";
import { Badge, Card, Empty, ErrorBox, Field, fmtDate, Loading, Page, Tabs, Toast } from "../ui.tsx";
import { STATUS, TYPE_LABEL } from "./Works.tsx";
import type { Certainty, MemoryKind, Work } from "../../../supabase/functions/_shared/core/types.ts";

interface ChapterRow {
  id: string;
  chapter_key: string;
  number: number | null;
  title: string | null;
  status: string;
  summary: string | null;
  source_url: string | null;
  discovered_at: string;
}
interface MemoryRow {
  id: string;
  kind: MemoryKind;
  name: string;
  content: string;
  certainty: Certainty;
  updated_chapter_key: string | null;
  superseded: boolean;
}

const KIND_LABEL: Record<MemoryKind, string> = {
  character: "Personagens", relationship: "Relações", power: "Poderes", event: "Acontecimentos",
  continuity: "Continuidade", location: "Lugares", item: "Itens", theme: "Temas",
};
const CERTAINTY: Record<Certainty, { label: string; tone: "good" | "info" | "warn" }> = {
  confirmed: { label: "Fato confirmado", tone: "good" },
  interpretation: { label: "Interpretação", tone: "info" },
  theory: { label: "Teoria", tone: "warn" },
};

export default function WorkDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const [tab, setTab] = useState<"chapters" | "memory" | "upload">("chapters");
  const q = useQuery(async () => {
    const [work, chapters, memory] = await Promise.all([
      rows(supabase.from("works").select("*").eq("id", id!).single()),
      rows(supabase.from("chapters").select("*").eq("work_id", id!).order("number", { ascending: false, nullsFirst: false }).limit(200)),
      rows(supabase.from("memory_entries").select("*").eq("work_id", id!).order("name")),
    ]);
    return { work: work as unknown as Work & { last_checked_at: string | null; authorization_confirmed_at: string | null }, chapters: chapters as ChapterRow[], memory: memory as MemoryRow[] };
  }, [id]);

  if (q.loading && !q.data) return <Page title="Obra"><Loading /></Page>;
  if (!q.data) return <Page title="Obra"><ErrorBox error={q.error} /></Page>;
  const { work, chapters, memory } = q.data;

  async function check() {
    try {
      const r = await api<{ reason: string }>("check_work", { work_id: work.id });
      toast.ok(r.reason);
      q.reload();
    } catch (e) {
      toast.fail((e as Error).message);
    }
  }
  async function toggleSkip(c: ChapterRow) {
    const { error } = await supabase.from("chapters").update({ status: c.status === "skipped" ? "new" : "skipped" }).eq("id", c.id);
    if (error) toast.fail(error.message);
    q.reload();
  }
  async function generate(c: ChapterRow) {
    try {
      await api("generate_now", { work_id: work.id, chapter_key: c.chapter_key });
      await api("process_now").catch(() => {});
      toast.ok(`Produção do capítulo ${c.number ?? c.chapter_key} iniciada`);
      setTimeout(() => nav("/fila"), 800);
    } catch (e) {
      toast.fail((e as Error).message);
    }
  }
  async function pause() {
    await supabase.from("works").update({ status: work.status === "paused" ? "active" : "paused" }).eq("id", work.id);
    q.reload();
  }
  async function remove() {
    if (!confirm(`Excluir "${work.title}"? Calendário, capítulos, memória e histórico desta obra serão apagados.`)) return;
    const { error } = await supabase.from("works").delete().eq("id", work.id);
    if (error) toast.fail(error.message);
    else nav("/obras");
  }

  return (
    <Page title={work.title} actions={<Link className="btn small" to={`/obras/${work.id}/editar`}>Editar</Link>}>
      <div className="stack">
        <Card>
          <div className="stack">
            <div className="row">
              <Badge tone={STATUS[work.status].tone}>{STATUS[work.status].label}</Badge>
              <Badge>{TYPE_LABEL[work.type]}</Badge>
            </div>
            {work.status_reason && <p className="small">{work.status_reason}</p>}
            <div className="small muted">
              {work.url && <> · <a href={work.url} target="_blank" rel="noreferrer">link</a></>} · último capítulo processado: {work.last_processed_chapter ?? "—"} · verificada {fmtDate(work.last_checked_at)}
            </div>
          </div>
          <div className="card-footer">
            <button className="small" onClick={check}>Procurar capítulos agora</button>
            <button className="small" onClick={pause}>{work.status === "paused" ? "Retomar" : "Pausar"}</button>
            <Link className="btn small" to={`/calendario?obra=${work.id}`}>Calendário</Link>
            <button className="small danger" onClick={remove}>Excluir</button>
          </div>
        </Card>

        <Tabs value={tab} onChange={setTab} options={[
          { value: "chapters", label: `Capítulos (${chapters.length})` },
          { value: "memory", label: `Memória (${memory.length})` },
          { value: "upload", label: "Enviar capítulo" },
        ]} />

        {tab === "chapters" && (
          <div className="list">
            {chapters.length === 0 && <Card><Empty>Nenhum capítulo detectado ainda. Os capítulos são procurados no link da obra no intervalo configurado, ou use Gerar vídeo em cada capítulo.</Empty></Card>}
            {chapters.map((c) => (
              <Card key={c.id}>
                <div className="spread">
                  <strong>Cap. {c.number ?? c.chapter_key}{c.title ? ` — ${c.title}` : ""}</strong>
                  <Badge tone={c.status === "processed" ? "good" : c.status === "skipped" ? "neutral" : "info"}>
                    {{ new: "Novo", processing: "Em produção", processed: "Processado", skipped: "Ignorado" }[c.status] ?? c.status}
                  </Badge>
                </div>
                {c.summary && <p className="small">{c.summary}</p>}
                <div className="card-footer">
                  {(c.status === "new" || c.status === "skipped") && (
                    <button className="small" onClick={() => toggleSkip(c)}>{c.status === "skipped" ? "Não ignorar" : "Ignorar"}</button>
                  )}
                  <button className="small primary" onClick={() => generate(c)}>Gerar vídeo</button>
                  {c.source_url && <a className="btn small" href={c.source_url} target="_blank" rel="noreferrer">Abrir link</a>}
                </div>
              </Card>
            ))}
          </div>
        )}

        {tab === "memory" && <Memory workId={work.id} entries={memory} onChange={q.reload} />}
        {tab === "upload" && <Upload work={work} onDone={() => { toast.ok("Material enviado"); q.reload(); }} onError={toast.fail} />}
      </div>
      <Toast msg={toast.msg} />
    </Page>
  );
}

function Memory({ workId, entries, onChange }: { workId: string; entries: MemoryRow[]; onChange: () => void }) {
  const [edit, setEdit] = useState<Partial<MemoryRow> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const kinds = Object.keys(KIND_LABEL) as MemoryKind[];

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!edit) return;
    const payload = { work_id: workId, kind: edit.kind, name: edit.name?.trim(), content: edit.content?.trim(), certainty: edit.certainty };
    const r = edit.id
      ? await supabase.from("memory_entries").update(payload).eq("id", edit.id)
      : await supabase.from("memory_entries").insert(payload);
    if (r.error) setError(r.error.message);
    else {
      setEdit(null);
      onChange();
    }
  }
  async function del(id: string) {
    if (!confirm("Remover este registro da memória?")) return;
    await supabase.from("memory_entries").delete().eq("id", id);
    onChange();
  }

  return (
    <div className="stack">
      <p className="small muted">A memória é atualizada após cada capítulo e usada para manter a continuidade. Fatos, interpretações e teorias ficam separados.</p>
      <button className="small" onClick={() => setEdit({ kind: "character", certainty: "confirmed", name: "", content: "" })}>+ Adicionar registro</button>
      {edit && (
        <Card>
          <form className="stack" onSubmit={save}>
            <Field label="Tipo"><select value={edit.kind} onChange={(e) => setEdit({ ...edit, kind: e.target.value as MemoryKind })}>{kinds.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}</select></Field>
            <Field label="Nome"><input required maxLength={200} value={edit.name ?? ""} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label="Descrição"><textarea required maxLength={4000} value={edit.content ?? ""} onChange={(e) => setEdit({ ...edit, content: e.target.value })} /></Field>
            <Field label="Certeza">
              <select value={edit.certainty} onChange={(e) => setEdit({ ...edit, certainty: e.target.value as Certainty })}>
                <option value="confirmed">Fato confirmado</option><option value="interpretation">Interpretação</option><option value="theory">Teoria</option>
              </select>
            </Field>
            <ErrorBox error={error} />
            <div className="row"><button className="primary">Salvar</button><button type="button" onClick={() => setEdit(null)}>Cancelar</button></div>
          </form>
        </Card>
      )}
      {entries.length === 0 && <Card><Empty>Memória vazia. Ela é preenchida automaticamente ao processar capítulos.</Empty></Card>}
      {kinds.filter((k) => entries.some((e) => e.kind === k)).map((k) => (
        <div key={k} className="stack">
          <h3 className="memory-kind">{KIND_LABEL[k]}</h3>
          {entries.filter((e) => e.kind === k).map((e) => (
            <Card key={e.id}>
              <div className="spread"><strong>{e.name}</strong><Badge tone={CERTAINTY[e.certainty].tone}>{CERTAINTY[e.certainty].label}</Badge></div>
              <p className="small pre">{e.content}</p>
              <div className="row small muted">
                {e.updated_chapter_key && <span>atualizado no cap. {e.updated_chapter_key}</span>}
                <button className="small" onClick={() => setEdit(e)}>Editar</button>
                <button className="small danger" onClick={() => del(e.id)}>Remover</button>
              </div>
            </Card>
          ))}
        </div>
      ))}
    </div>
  );
}

function Upload({ work, onDone, onError }: { work: Work; onDone: () => void; onError: (m: string) => void }) {
  const [chapter, setChapter] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [progress, setProgress] = useState<string | null>(null);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    try {
      const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      for (let i = 0; i < sorted.length; i++) {
        const f = sorted[i];
        setProgress(`Enviando ${i + 1}/${sorted.length}: ${f.name}`);
        const type = f.type || (f.name.endsWith(".srt") ? "application/x-subrip" : f.name.endsWith(".vtt") ? "text/vtt" : "text/plain");
        const r = await api<{ path: string; token: string }>("upload_url", {
          work_id: work.id, chapter_key: chapter, filename: f.name, content_type: type, size: f.size, order: i + 1,
        });
        const up = await supabase.storage.from("media").uploadToSignedUrl(r.path, r.token, f, { contentType: type });
        if (up.error) throw new Error(up.error.message);
      }
      setProgress(null);
      setFiles([]);
      onDone();
    } catch (err) {
      setProgress(null);
      onError((err as Error).message);
    }
  }

  return (
    <Card title="Enviar material do capítulo">
      <form className="stack" onSubmit={send}>
        <Field label="Capítulo / episódio" hint="Ex.: 12 ou 12.5"><input required value={chapter} onChange={(e) => setChapter(e.target.value)} inputMode="decimal" /></Field>
        <Field label="Arquivos" hint="Páginas (JPEG, PNG, WebP) na ordem de leitura, ou legendas/roteiro (TXT, SRT, VTT). Até 15 MB cada. Ficam no servidor apenas temporariamente.">
          <input type="file" multiple accept="image/jpeg,image/png,image/webp,.txt,.srt,.vtt" onChange={(e) => setFiles([...(e.target.files ?? [])])} />
        </Field>
        {progress && <div className="alert info">{progress}</div>}
        <button className="primary" disabled={!files.length || !chapter || !!progress}>Enviar {files.length ? `(${files.length})` : ""}</button>
      </form>
    </Card>
  );
}
