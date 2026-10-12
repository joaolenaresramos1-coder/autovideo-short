import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, ApiFailure, supabase } from "../supabase.ts";
import { rows, useQuery, useToast } from "../hooks.ts";
import { Badge, Card, ErrorBox, Field, fmtDate, Page, Toast } from "../ui.tsx";
import { TextAIs } from "../aiProviders.tsx";

interface Integration {
  provider: string;
  status: string;
  account_name: string | null;
  token_expires_at: string | null;
  metadata: { tts_models?: string[]; text_models?: string[]; note?: string; checked_at?: string };
  last_error: string | null;
  updated_at: string;
}

const STATUS: Record<string, { label: string; tone: "good" | "warn" | "bad" | "neutral" }> = {
  connected: { label: "Conectado", tone: "good" },
  expired: { label: "Reconectar", tone: "warn" },
  error: { label: "Erro", tone: "bad" },
  disconnected: { label: "Desconectado", tone: "neutral" },
};

export default function Integrations() {
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [test, setTest] = useState<Record<string, unknown> | null>(null);
  const [serverMissing, setServerMissing] = useState<Record<string, string>>({});
  const q = useQuery(() => rows(supabase.from("integrations").select("*")) as Promise<Integration[]>);
  const by = (p: string) => q.data?.find((i) => i.provider === p);

  useEffect(() => {
    const status = params.get("status");
    if (status) {
      if (status === "ok") toast.ok(params.get("msg") ?? "Conectado");
      else toast.fail(params.get("msg") ?? "Falha na conexão");
      setParams({}, { replace: true });
      q.reload();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function run<T>(label: string, fn: () => Promise<T>, ok?: (r: T) => string) {
    setBusy(label);
    try {
      const r = await fn();
      if (ok) toast.ok(ok(r));
      q.reload();
      return r;
    } catch (e) {
      if (e instanceof ApiFailure && e.status === 501) setServerMissing((m) => ({ ...m, [label]: e.message }));
      toast.fail((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const connect = (provider: "youtube" | "tiktok") =>
    run(provider, async () => {
      const r = await api<{ url: string }>("oauth_start", { provider });
      window.location.assign(r.url);
    });

  const gemini = by("gemini");
  return (
    <Page title="Integrações">
      <ErrorBox error={q.error} />
      <div className="stack">
        <Card title={<span className="spread">Gemini (análise, roteiro e narração) {gemini && <Badge tone={STATUS[gemini.status]?.tone}>{STATUS[gemini.status]?.label}</Badge>}</span>}>
          <div className="stack">
            <p className="small muted">A chave fica cifrada no servidor e nunca volta para o navegador. Ela é validada junto ao Google antes de ser salva.</p>
            {gemini?.account_name && <span className="small">Chave atual: {gemini.account_name} · verificada {fmtDate(gemini.metadata.checked_at)}</span>}
            <form className="stack" onSubmit={(e) => { e.preventDefault(); run("gemini", () => api<{ tts_models: string[] }>("save_gemini_key", { key }), (r) => `Chave salva. Modelos de fala disponíveis: ${r.tts_models.join(", ") || "nenhum"}`).then(() => setKey("")); }}>
              <Field label="Chave da API Gemini" hint="Crie em aistudio.google.com → Get API key">
                <input type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder="AIza…" />
              </Field>
              <div className="row">
                <button className="primary" disabled={!key || busy === "gemini"}>Salvar chave</button>
                {gemini?.status === "connected" && (
                  <>
                    <button type="button" disabled={!!busy} onClick={() => run("test", () => api<Record<string, unknown>>("test_gemini", {})).then((r) => r && setTest(r))}>Verificar modelos</button>
                    <button type="button" disabled={!!busy} onClick={() => run("test", () => api<Record<string, unknown>>("test_gemini", { speak: true })).then((r) => r && setTest(r))}>Testar narração</button>
                  </>
                )}
              </div>
            </form>
            {gemini?.metadata.tts_models && <span className="small muted">Modelos de fala detectados: {gemini.metadata.tts_models.join(", ") || "nenhum"}</span>}
            {test && <pre className="mono pre small">{JSON.stringify(test, null, 2)}</pre>}
          </div>
        </Card>

        <TextAIs onToast={(ok, msg) => (ok ? toast.ok(msg) : toast.fail(msg))} />

        {(["youtube", "tiktok"] as const).map((p) => {
          const i = by(p);
          return (
            <Card key={p} title={<span className="spread">{p === "youtube" ? "YouTube" : "TikTok"} {i && <Badge tone={STATUS[i.status]?.tone}>{STATUS[i.status]?.label}</Badge>}</span>}>
              <div className="stack">
                {i?.account_name && <span>Conta: <strong>{i.account_name}</strong></span>}
                {i?.last_error && <div className="alert warn small">{i.last_error}</div>}
                {p === "youtube" ? (
                  <p className="small muted">Usa a API oficial (OAuth do Google). Envio retomável, agendamento por <code>publishAt</code> e confirmação do processamento. A cota de uploads da API é limitada por dia.</p>
                ) : (
                  <p className="small muted">Usa a Content Posting API oficial. Enquanto o app não for auditado pelo TikTok, os vídeos só podem ser publicados como privados (SELF_ONLY). A API não agenda: o envio ocorre no horário programado.</p>
                )}
                {serverMissing[p] && <div className="alert warn small">Pendente no servidor: {serverMissing[p]}. Veja docs/IMPLANTACAO.md.</div>}
                <div className="row">
                  <button className="primary" disabled={busy === p} onClick={() => connect(p)}>{i?.status === "connected" ? "Reconectar" : "Conectar"}</button>
                  {i && i.status !== "disconnected" && <button className="danger" disabled={!!busy} onClick={() => run(p, () => api("disconnect", { provider: p }), () => "Desconectado")}>Desconectar</button>}
                </div>
              </div>
            </Card>
          );
        })}
        <Card title="Renderização">
          <p className="small muted">Os vídeos são renderizados com FFmpeg em um worker do GitHub Actions (gratuito em repositório público). Nada é renderizado no seu aparelho. O Shotstack pode ser configurado como alternativa (ver documentação).</p>
        </Card>
      </div>
      <Toast msg={toast.msg} />
    </Page>
  );
}
