import { useEffect, useState } from "react";
import { supabase } from "../supabase.ts";
import { rows, useQuery, useToast } from "../hooks.ts";
import { Card, ErrorBox, Field, fmtDate, Loading, Page, Tabs, Toast } from "../ui.tsx";
import type { UserSettings } from "../../../supabase/functions/_shared/core/types.ts";

type S = UserSettings & {
  storage_quota_bytes: number;
  video_after_download_hours: number;
  video_max_retention_hours: number;
  video_no_download_hours: number;
  intermediate_grace_hours: number;
  incomplete_retention_hours: number;
  log_retention_days: number;
};
interface Log { id: number; level: string; event: string; message: string | null; created_at: string; job_id: string | null }

const VOICES = ["Kore", "Puck", "Charon", "Fenrir", "Leda", "Orus", "Aoede", "Zephyr", "Callirrhoe", "Autonoe", "Enceladus", "Iapetus", "Umbriel", "Algieba", "Despina", "Erinome", "Algenib", "Rasalgethi", "Laomedeia", "Achernar", "Alnilam", "Schedar", "Gacrux", "Pulcherrima", "Achird", "Zubenelgenubi", "Vindemiatrix", "Sadachbia", "Sadaltager", "Sulafat"];

export default function Settings() {
  const [tab, setTab] = useState<"config" | "logs">("config");
  return (
    <Page title="Logs e configurações">
      <Tabs value={tab} onChange={setTab} options={[{ value: "config", label: "Configurações" }, { value: "logs", label: "Logs" }]} />
      <div style={{ marginTop: 12 }}>{tab === "config" ? <Config /> : <Logs />}</div>
    </Page>
  );
}

function Config() {
  const toast = useToast();
  const q = useQuery(() => rows(supabase.from("user_settings").select("*").single()) as Promise<S>);
  const [s, setS] = useState<Partial<S>>({});
  useEffect(() => {
    if (q.data) setS(q.data);
  }, [q.data]);
  if (!q.data) return <><ErrorBox error={q.error} /><Loading /></>;
  const set = <K extends keyof S>(k: K, v: S[K]) => setS((p) => ({ ...p, [k]: v }));
  const num = (k: keyof S) => (e: React.ChangeEvent<HTMLInputElement>) => set(k, Number(e.target.value) as never);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const { user_id, automation_paused, pause_reason, ...patch } = s as S & { created_at?: string; updated_at?: string; paused_at?: string };
    delete (patch as Record<string, unknown>).created_at;
    delete (patch as Record<string, unknown>).updated_at;
    delete (patch as Record<string, unknown>).paused_at;
    void automation_paused;
    void pause_reason;
    const { error } = await supabase.from("user_settings").update(patch).eq("user_id", user_id);
    if (error) toast.fail(error.message);
    else {
      toast.ok("Configurações salvas");
      q.reload();
    }
  }
  async function logout() {
    await supabase.auth.signOut();
  }

  return (
    <form className="stack" onSubmit={save}>
      <Card title="Geral">
        <div className="stack">
          <Field label="Fuso horário padrão"><input value={s.timezone ?? ""} onChange={(e) => set("timezone", e.target.value)} /></Field>
          <Field label="Tentativas automáticas por tarefa"><input type="number" min={1} max={20} value={s.max_attempts ?? 5} onChange={num("max_attempts")} /></Field>
        </div>
      </Card>
      <Card title="Gemini">
        <div className="stack">
          <Field label="Modelo de texto (análise e roteiro)"><input value={s.gemini_text_model ?? ""} onChange={(e) => set("gemini_text_model", e.target.value)} /></Field>
          <Field label="Modelo de fala (TTS)" hint="Precisa ser um modelo com geração de áudio, ex.: gemini-3.8-flash-lite-tts ou gemini-3.8-flash-tts. Teste em Integrações.">
            <input value={s.gemini_tts_model ?? ""} onChange={(e) => set("gemini_tts_model", e.target.value)} />
          </Field>
          <Field label="Voz"><select value={s.gemini_voice} onChange={(e) => set("gemini_voice", e.target.value)}>{VOICES.map((v) => <option key={v}>{v}</option>)}</select></Field>
          <Field label="Modelo de imagem (ilustrações originais)"><input value={s.gemini_image_model ?? ""} onChange={(e) => set("gemini_image_model", e.target.value)} /></Field>
        </div>
      </Card>
      <Card title="Vídeo">
        <div className="stack">
          <div className="grid two">
            <Field label="Cor das legendas"><input type="color" value={s.caption_style?.color ?? "#FFE600"} onChange={(e) => set("caption_style", { ...s.caption_style!, color: e.target.value })} /></Field>
            <Field label="Cor de destaque"><input type="color" value={s.caption_style?.accent ?? "#7CFF4F"} onChange={(e) => set("caption_style", { ...s.caption_style!, accent: e.target.value })} /></Field>
          </div>
          <label className="check"><input type="checkbox" checked={!!s.background_music} onChange={(e) => set("background_music", e.target.checked)} /> Trilha sonora de fundo (arquivo licenciado em worker/assets/music.mp3)</label>
          <label className="check"><input type="checkbox" checked={!!s.ai_disclosure} onChange={(e) => set("ai_disclosure", e.target.checked)} /> Informar conteúdo gerado por IA nas plataformas</label>
          <div className="grid two">
            <Field label="Privacidade no YouTube">
              <select value={s.youtube_privacy} onChange={(e) => set("youtube_privacy", e.target.value as S["youtube_privacy"])}>
                <option value="private">Privado</option><option value="unlisted">Não listado</option><option value="public">Público</option>
              </select>
            </Field>
            <Field label="Privacidade no TikTok" hint="Apps não auditados: só SELF_ONLY">
              <select value={s.tiktok_privacy} onChange={(e) => set("tiktok_privacy", e.target.value)}>
                <option value="SELF_ONLY">Somente eu</option><option value="MUTUAL_FOLLOW_FRIENDS">Amigos</option><option value="FOLLOWER_OF_CREATOR">Seguidores</option><option value="PUBLIC_TO_EVERYONE">Público</option>
              </select>
            </Field>
          </div>
        </div>
      </Card>
      <Card title="Retenção de arquivos">
        <div className="grid two">
          <Field label="Vídeo: horas após o 1º download" hint="1 a 48"><input type="number" min={1} max={48} value={s.video_after_download_hours ?? 24} onChange={num("video_after_download_hours")} /></Field>
          <Field label="Vídeo: máximo após renderizar (h)"><input type="number" min={1} max={168} value={s.video_max_retention_hours ?? 48} onChange={num("video_max_retention_hours")} /></Field>
          <Field label="Vídeo sem download (h)"><input type="number" min={1} max={168} value={s.video_no_download_hours ?? 48} onChange={num("video_no_download_hours")} /></Field>
          <Field label="Intermediários após validar (h)"><input type="number" min={0} max={72} value={s.intermediate_grace_hours ?? 1} onChange={num("intermediate_grace_hours")} /></Field>
          <Field label="Arquivos incompletos (h)"><input type="number" min={1} max={168} value={s.incomplete_retention_hours ?? 12} onChange={num("incomplete_retention_hours")} /></Field>
          <Field label="Logs operacionais (dias)"><input type="number" min={1} max={365} value={s.log_retention_days ?? 30} onChange={num("log_retention_days")} /></Field>
          <Field label="Cota de armazenamento (MB)"><input type="number" min={50} value={Math.round((s.storage_quota_bytes ?? 0) / 1048576)} onChange={(e) => set("storage_quota_bytes", Number(e.target.value) * 1048576)} /></Field>
        </div>
      </Card>
      <button className="primary">Salvar configurações</button>
      <button type="button" onClick={logout}>Sair da conta</button>
      <Toast msg={toast.msg} />
    </form>
  );
}

function Logs() {
  const [level, setLevel] = useState<"all" | "warn" | "error">("all");
  const q = useQuery(() => {
    let query = supabase.from("job_logs").select("id, level, event, message, created_at, job_id").neq("level", "debug").order("created_at", { ascending: false }).limit(150);
    if (level !== "all") query = query.in("level", level === "warn" ? ["warn", "error"] : ["error"]);
    return rows(query) as Promise<Log[]>;
  }, [level], 30_000);
  return (
    <div className="stack">
      <Tabs value={level} onChange={setLevel} options={[{ value: "all", label: "Todos" }, { value: "warn", label: "Avisos" }, { value: "error", label: "Erros" }]} />
      <ErrorBox error={q.error} />
      <Card>
        <div className="list small">
          {q.data?.length === 0 && <span className="muted">Sem registros.</span>}
          {q.data?.map((l) => (
            <div key={l.id}>
              <div className="row"><span className="muted">{fmtDate(l.created_at)}</span><strong className={l.level === "error" ? "check-bad" : ""}>{l.event}</strong></div>
              {l.message && <div className="pre">{l.message}</div>}
            </div>
          ))}
        </div>
      </Card>
      <p className="small muted">Os logs nunca contêm chaves ou tokens (são filtrados no servidor) e são apagados após o prazo configurado.</p>
    </div>
  );
}
