import { useState } from "react";
import { supabase } from "../supabase.ts";
import { rows, useQuery } from "../hooks.ts";
import { Badge, Card, Empty, ErrorBox, fmtDate, Loading, Page, Tabs } from "../ui.tsx";

interface PubRow {
  id: string;
  platform: "youtube" | "tiktok";
  status: string;
  title: string | null;
  privacy: string | null;
  publish_at: string | null;
  remote_id: string | null;
  remote_url: string | null;
  attempts: number;
  last_error: string | null;
  confirmed_at: string | null;
  created_at: string;
}

const STATUS: Record<string, { label: string; tone: "good" | "warn" | "bad" | "info" | "neutral" }> = {
  pending: { label: "Aguardando horário", tone: "info" },
  uploading: { label: "Enviando", tone: "info" },
  processing: { label: "Processando na plataforma", tone: "info" },
  scheduled: { label: "Agendado na plataforma", tone: "info" },
  published: { label: "Publicado (confirmado)", tone: "good" },
  failed: { label: "Falhou", tone: "bad" },
  cancelled: { label: "Cancelado", tone: "neutral" },
};

export default function Publications() {
  const [platform, setPlatform] = useState<"all" | "youtube" | "tiktok">("all");
  const q = useQuery(() => {
    let query = supabase.from("publications").select("*").order("created_at", { ascending: false }).limit(80);
    if (platform !== "all") query = query.eq("platform", platform);
    return rows(query) as Promise<PubRow[]>;
  }, [platform], 30_000);
  return (
    <Page title="Publicações">
      <ErrorBox error={q.error} />
      <p className="small muted">Um vídeo só aparece como publicado depois que a própria plataforma confirma. Identificadores remotos são guardados para impedir envios duplicados.</p>
      <Tabs value={platform} onChange={setPlatform} options={[{ value: "all", label: "Todas" }, { value: "youtube", label: "YouTube" }, { value: "tiktok", label: "TikTok" }]} />
      <div className="list" style={{ marginTop: 12 }}>
        {q.loading && !q.data && <Loading />}
        {q.data?.length === 0 && <Card><Empty>Nenhuma publicação ainda.</Empty></Card>}
        {q.data?.map((p) => (
          <Card key={p.id}>
            <div className="stack">
              <div className="spread"><strong>{p.platform === "youtube" ? "YouTube" : "TikTok"} · {p.title}</strong><Badge tone={STATUS[p.status]?.tone}>{STATUS[p.status]?.label ?? p.status}</Badge></div>
              <div className="row small muted">
                <span>Horário: {fmtDate(p.publish_at)}</span>·<span>Privacidade: {p.privacy}</span>·<span>Tentativas: {p.attempts}</span>
                {p.confirmed_at && <>·<span>Confirmado {fmtDate(p.confirmed_at)}</span></>}
              </div>
              {p.remote_url && <a href={p.remote_url} target="_blank" rel="noreferrer">Abrir na plataforma</a>}
              {p.remote_id && !p.remote_url && <span className="mono">ID: {p.remote_id}</span>}
              {p.last_error && <div className={`alert ${p.status === "failed" ? "bad" : "warn"} small`}>{p.last_error}</div>}
            </div>
          </Card>
        ))}
      </div>
    </Page>
  );
}
