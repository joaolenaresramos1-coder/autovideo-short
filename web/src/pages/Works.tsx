import { useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../supabase.ts";
import { rows, useQuery } from "../hooks.ts";
import { Badge, Card, Empty, ErrorBox, fmtDate, Loading, Page, Tabs } from "../ui.tsx";
import type { Work } from "../../../supabase/functions/_shared/core/types.ts";

export const TYPE_LABEL = { manga: "Mangá", manhua: "Manhua", manhwa: "Manhwa", anime: "Anime" } as const;
export const STATUS: Record<Work["status"], { label: string; tone: "good" | "warn" | "bad" | "neutral" }> = {
  active: { label: "Ativa", tone: "good" },
  paused: { label: "Pausada", tone: "neutral" },
  pending_config: { label: "Configuração pendente", tone: "warn" },
  error: { label: "Erro no link", tone: "bad" },
};

type W = Work & { last_checked_at: string | null };

export default function Works() {
  const [filter, setFilter] = useState<"all" | "active" | "attention">("all");
  const q = useQuery(() => rows(supabase.from("works").select("*").order("title")) as Promise<W[]>);
  const list = (q.data ?? []).filter((w) =>
    filter === "all" ? true : filter === "active" ? w.status === "active" : w.status === "pending_config" || w.status === "error",
  );
  return (
    <Page title="Obras" actions={<><Link className="btn" to="/gerar">Gerar vídeo</Link><Link className="btn primary" to="/obras/nova">+ Nova obra</Link></>}>
      <ErrorBox error={q.error} />
      <Tabs value={filter} onChange={setFilter} options={[{ value: "all", label: "Todas" }, { value: "active", label: "Ativas" }, { value: "attention", label: "Atenção" }]} />
      <div className="list" style={{ marginTop: 12 }}>
        {q.loading && !q.data && <Loading />}
        {q.data && list.length === 0 && (
          <Card><Empty action={<Link className="btn primary" to="/obras/nova">Cadastrar obra</Link>}>Nenhuma obra aqui.</Empty></Card>
        )}
        {list.map((w) => (
          <Link key={w.id} className="card item" to={`/obras/${w.id}`}>
            <div className="spread"><strong>{w.title}</strong><Badge tone={STATUS[w.status].tone}>{STATUS[w.status].label}</Badge></div>
            <div className="row small muted">
              <span>{TYPE_LABEL[w.type]}</span>·<span>{w.language}</span>
              {w.last_processed_chapter && <>·<span>último: cap. {w.last_processed_chapter}</span></>}
            </div>
            {w.status_reason && w.status !== "active" && <span className="small">{w.status_reason}</span>}
            <div className="row small muted">
              {w.standalone && <><span>Capítulo avulso</span>·</>}<span>verificada {fmtDate(w.last_checked_at)}</span>
            </div>
          </Link>
        ))}
      </div>
    </Page>
  );
}
