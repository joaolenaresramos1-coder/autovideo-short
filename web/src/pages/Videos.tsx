import { useState } from "react";
import { api, supabase } from "../supabase.ts";
import { rows, useQuery, useToast } from "../hooks.ts";
import { Badge, Card, Empty, ErrorBox, fmtDate, Loading, Page, Toast } from "../ui.tsx";
import { formatBytes, formatRemaining } from "../../../supabase/functions/_shared/core/retention.ts";

interface VideoRow {
  id: string;
  title: string;
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  size_bytes: number | null;
  rendered_at: string | null;
  first_download_at: string | null;
  file_deleted_at: string | null;
  storage_object_id: string | null;
  validation: { ok: boolean; checks: { name: string; ok: boolean; detail: string }[] } | null;
  works: { title: string } | null;
  storage_objects: { expires_at: string | null; deleted_at: string | null; download_count: number } | null;
}

export default function Videos() {
  const toast = useToast();
  const q = useQuery(
    () => rows(supabase.from("videos").select("*, works(title), storage_objects!videos_storage_object_id_fkey(expires_at, deleted_at, download_count)").order("created_at", { ascending: false }).limit(60)) as Promise<VideoRow[]>,
    [],
    60_000,
  );

  const [playing, setPlaying] = useState<Record<string, string>>({});

  async function watch(v: VideoRow) {
    if (playing[v.id]) return setPlaying(({ [v.id]: _, ...rest }) => rest);
    try {
      const r = await api<{ url: string }>("preview_url", { object_id: v.storage_object_id });
      setPlaying((p) => ({ ...p, [v.id]: r.url }));
    } catch (e) {
      toast.fail((e as Error).message);
    }
  }

  async function download(v: VideoRow) {
    try {
      const r = await api<{ url: string; file_expires_at: string; note: string }>("download_url", { object_id: v.storage_object_id, filename: v.title });
      window.location.assign(r.url);
      toast.ok(`Download iniciado. O arquivo será excluído do servidor em ${formatRemaining(new Date(r.file_expires_at))}.`);
      q.reload();
    } catch (e) {
      toast.fail((e as Error).message);
    }
  }

  return (
    <Page title="Vídeos">
      <ErrorBox error={q.error} />
      <div className="alert info small" style={{ marginBottom: 12 }}>
        Os vídeos ficam no servidor por tempo limitado: 24 h após o primeiro download (no máximo 48 h após a renderização) ou 48 h se não houver download.
        O botão de download não confirma que o arquivo foi salvo no seu aparelho — salve-o antes do prazo. Assistir aqui não conta como download.
      </div>
      <div className="list">
        {q.loading && !q.data && <Loading />}
        {q.data?.length === 0 && <Card><Empty>Nenhum vídeo renderizado ainda.</Empty></Card>}
        {q.data?.map((v) => {
          const obj = v.storage_objects;
          const gone = !!(v.file_deleted_at || obj?.deleted_at);
          const expires = obj?.expires_at ? new Date(obj.expires_at) : null;
          const expired = expires ? expires <= new Date() : false;
          return (
            <Card key={v.id}>
              <div className="stack">
                <div className="spread">
                  <strong>{v.title}</strong>
                  {gone ? <Badge>Arquivo excluído</Badge> : expired ? <Badge tone="warn">Expirado</Badge> : <Badge tone="good">Disponível</Badge>}
                </div>
                <div className="row small muted">
                  <span>{v.works?.title}</span>·<span>{v.duration_seconds ? `${Number(v.duration_seconds).toFixed(0)} s` : "—"}</span>·
                  <span>{v.width}×{v.height}</span>·<span>{formatBytes(Number(v.size_bytes ?? 0))}</span>·<span>renderizado {fmtDate(v.rendered_at)}</span>
                </div>
                {!gone && expires && !expired && (
                  <span className="small">Exclusão automática em <strong>{formatRemaining(expires)}</strong> ({fmtDate(obj!.expires_at)}){v.first_download_at ? ` · primeiro download ${fmtDate(v.first_download_at)}` : ""}</span>
                )}
                {gone && <span className="small muted">O arquivo foi removido conforme a política de retenção. Roteiro, metadados e histórico de publicação continuam guardados.</span>}
                {v.validation && (
                  <details className="small">
                    <summary>Validação {v.validation.ok ? "aprovada" : "reprovada"}</summary>
                    <ul>{v.validation.checks.map((c) => <li key={c.name} className={c.ok ? "check-ok" : "check-bad"}>{c.ok ? "✓" : "✗"} {c.name}: {c.detail}</li>)}</ul>
                  </details>
                )}
                {playing[v.id] && (
                  <video
                    src={playing[v.id]}
                    controls
                    autoPlay
                    playsInline
                    preload="metadata"
                    style={{ width: "100%", maxWidth: 360, aspectRatio: "9 / 16", background: "#000", borderRadius: 12, alignSelf: "center" }}
                  />
                )}
                {!gone && !expired && v.storage_object_id && (
                  <div className="row">
                    <button onClick={() => watch(v)}>{playing[v.id] ? "Fechar vídeo" : "▶ Assistir aqui"}</button>
                    <button className="primary" onClick={() => download(v)}>Baixar vídeo</button>
                  </div>
                )}
              </div>
            </Card>
          );
        })}
      </div>
      <Toast msg={toast.msg} />
    </Page>
  );
}
