import { supabase } from "../supabase.ts";
import { rows, useQuery } from "../hooks.ts";
import { Badge, Card, ErrorBox, fmtDate, Loading, Page, Progress, Stat } from "../ui.tsx";
import { formatBytes, formatRemaining, quotaLevel } from "../../../supabase/functions/_shared/core/retention.ts";

interface Summary {
  quota_bytes: number;
  used_bytes: number;
  video_bytes: number;
  temporary_bytes: number;
  reclaimable_bytes: number;
  expiring_24h: number;
  delete_failures: number;
  object_count: number;
  bucket_bytes_all_users: number;
  last_cleanup: { started_at: string; finished_at: string | null; deleted: number; failed: number; bytes_freed: number; skipped: number } | null;
}
interface Obj { id: string; path: string; kind: string; size_bytes: number; expires_at: string | null; delete_attempts: number; last_delete_error: string | null }

const KIND: Record<string, string> = { video: "Vídeo", audio: "Áudio", image: "Imagem", page: "Página", upload: "Envio", partial: "Incompleto", other: "Outro" };

export default function Storage() {
  const q = useQuery(async () => {
    const [summary, expiring, failures] = await Promise.all([
      supabase.rpc("storage_summary").then((r) => { if (r.error) throw new Error(r.error.message); return r.data as Summary; }),
      rows(supabase.from("storage_objects").select("*").is("deleted_at", null).order("expires_at").limit(30)),
      rows(supabase.from("storage_objects").select("*").is("deleted_at", null).gt("delete_attempts", 0).limit(20)),
    ]);
    return { summary, expiring: expiring as Obj[], failures: failures as Obj[] };
  }, [], 60_000);
  if (!q.data) return <Page title="Armazenamento"><ErrorBox error={q.error} /><Loading /></Page>;
  const s = q.data.summary;
  const pct = (s.used_bytes / s.quota_bytes) * 100;
  const level = quotaLevel(s.used_bytes, s.quota_bytes);

  return (
    <Page title="Armazenamento">
      <div className="stack">
        {level > 0 && <div className={`alert ${level >= 95 ? "bad" : "warn"}`}>Uso atingiu {level}% da cota configurada. A limpeza automática remove arquivos vencidos a cada 20 minutos.</div>}
        <Card title="Uso total">
          <div className="stack">
            <div className="spread"><span>{formatBytes(s.used_bytes)} de {formatBytes(s.quota_bytes)}</span><strong>{pct.toFixed(1)}%</strong></div>
            <Progress value={pct} tone={level >= 95 ? "bad" : level >= 70 ? "warn" : undefined} />
            <span className="small muted">Alertas em 70%, 85% e 95%. Bucket inteiro (todas as contas, segundo o Supabase): {formatBytes(s.bucket_bytes_all_users)}.</span>
          </div>
        </Card>
        <div className="grid two four">
          <Stat label="Vídeos" value={formatBytes(s.video_bytes)} />
          <Stat label="Temporários" value={formatBytes(s.temporary_bytes)} hint="áudios, imagens, envios" />
          <Stat label="Recuperável agora" value={formatBytes(s.reclaimable_bytes)} hint="vencidos aguardando limpeza" />
          <Stat label="Expiram em 24 h" value={s.expiring_24h} tone={s.delete_failures ? "bad" : undefined} hint={`${s.delete_failures} falha(s) de exclusão`} />
        </div>
        <Card title="Última limpeza">
          {s.last_cleanup ? (
            <p className="small">
              {fmtDate(s.last_cleanup.started_at)} · {s.last_cleanup.deleted} arquivo(s) excluído(s) · {formatBytes(s.last_cleanup.bytes_freed)} liberados ·{" "}
              {s.last_cleanup.skipped} adiado(s) por tarefa em execução · {s.last_cleanup.failed} falha(s)
            </p>
          ) : <p className="small muted">A limpeza ainda não rodou.</p>}
        </Card>
        {q.data.failures.length > 0 && (
          <Card title="Falhas de exclusão">
            <div className="list small">
              {q.data.failures.map((o) => <div key={o.id}><span className="mono">{o.path}</span><div className="check-bad">{o.delete_attempts} tentativa(s): {o.last_delete_error}</div></div>)}
            </div>
          </Card>
        )}
        <Card title="Próximos a expirar">
          <div className="list small">
            {q.data.expiring.length === 0 && <span className="muted">Nenhum arquivo armazenado.</span>}
            {q.data.expiring.map((o) => (
              <div key={o.id} className="spread">
                <span><Badge>{KIND[o.kind] ?? o.kind}</Badge> {formatBytes(Number(o.size_bytes))}</span>
                <span className="muted">{o.expires_at ? formatRemaining(new Date(o.expires_at)) : "—"}</span>
              </div>
            ))}
          </div>
        </Card>
        <p className="small muted">Roteiros, resumos, metadados e histórico de publicação nunca são excluídos pela limpeza — apenas os arquivos binários. Ajuste os prazos em Logs e configurações.</p>
      </div>
    </Page>
  );
}
