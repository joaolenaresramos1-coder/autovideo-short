import { useState } from "react";
import { supabase } from "../supabase.ts";
import { rows, useQuery } from "../hooks.ts";
import { Badge, Card, Empty, ErrorBox, fmtDate, Loading, Page } from "../ui.tsx";

interface ScriptRow {
  id: string;
  title: string;
  description: string | null;
  hashtags: string[];
  segments: { text: string; panels: string[]; emphasis?: string[] }[];
  full_text: string;
  word_count: number;
  model: string | null;
  version: number;
  validation: { review?: { consistent: boolean; issues: { severity: string; problem: string }[] }; key_points?: { conflicts?: string[]; revelations?: string[]; consequences?: string[] }; hook?: string } | null;
  created_at: string;
  works: { title: string } | null;
  chapters: { chapter_key: string } | null;
  jobs: { narrations: { duration_seconds: number; voice: string; model: string }[] | { duration_seconds: number; voice: string; model: string } | null } | null;
}

export default function Scripts() {
  const [open, setOpen] = useState<string | null>(null);
  const q = useQuery(() => rows(supabase.from("scripts").select("*, works(title), chapters(chapter_key), jobs(narrations(duration_seconds, voice, model))").order("created_at", { ascending: false }).limit(50)) as Promise<ScriptRow[]>);
  return (
    <Page title="Roteiros e narrações">
      <ErrorBox error={q.error} />
      <p className="small muted">Roteiros e resumos ficam guardados permanentemente; os áudios intermediários são excluídos após a validação do vídeo.</p>
      <div className="list">
        {q.loading && !q.data && <Loading />}
        {q.data?.length === 0 && <Card><Empty>Nenhum roteiro gerado ainda.</Empty></Card>}
        {q.data?.map((s) => {
          const narr = Array.isArray(s.jobs?.narrations) ? s.jobs?.narrations[0] : s.jobs?.narrations;
          const review = s.validation?.review;
          return (
            <Card key={s.id}>
              <div className="stack">
                <div className="spread"><strong>{s.title}</strong>{review && <Badge tone={review.consistent ? "good" : "warn"}>{review.consistent ? "Coerente" : "Com ressalvas"}</Badge>}</div>
                <div className="row small muted">
                  <span>{s.works?.title}{s.chapters ? ` · cap. ${s.chapters.chapter_key}` : ""}</span>·<span>{s.word_count} palavras</span>
                  {narr && <>·<span>narração {Number(narr.duration_seconds).toFixed(1)} s ({narr.voice})</span></>}·<span>{fmtDate(s.created_at)}</span>
                  {s.version > 1 && <>·<span>versão {s.version}</span></>}
                </div>
                <button className="small" onClick={() => setOpen(open === s.id ? null : s.id)}>{open === s.id ? "Fechar" : "Ler roteiro"}</button>
                {open === s.id && (
                  <div className="stack">
                    {s.validation?.hook && <p><strong>Gancho:</strong> {s.validation.hook}</p>}
                    {s.segments.map((seg, i) => (
                      <div key={i} className="segment small">
                        <p style={{ margin: 0 }}>{seg.text}</p>
                        <span className="muted">imagens: {seg.panels.join(", ") || "—"}{seg.emphasis?.length ? ` · destaque: ${seg.emphasis.join(", ")}` : ""}</span>
                      </div>
                    ))}
                    {s.validation?.key_points && (
                      <div className="small">
                        {s.validation.key_points.conflicts?.length ? <p><strong>Conflitos:</strong> {s.validation.key_points.conflicts.join("; ")}</p> : null}
                        {s.validation.key_points.revelations?.length ? <p><strong>Revelações:</strong> {s.validation.key_points.revelations.join("; ")}</p> : null}
                        {s.validation.key_points.consequences?.length ? <p><strong>Consequências:</strong> {s.validation.key_points.consequences.join("; ")}</p> : null}
                      </div>
                    )}
                    {review?.issues?.length ? <div className="alert warn small">{review.issues.map((i) => `${i.severity === "high" ? "⚠" : "•"} ${i.problem}`).join("\n")}</div> : null}
                    <p className="small muted pre">{s.description}{"\n"}{s.hashtags.join(" ")}</p>
                  </div>
                )}
              </div>
            </Card>
          );
        })}
      </div>
    </Page>
  );
}
