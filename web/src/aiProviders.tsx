// Text AIs: Claude (the user's subscription, run by Claude Code on the GitHub
// worker), Gemini and Groq, and the order in which they are tried. Keys go to
// the server or to GitHub secrets (encrypted) and never come back.

import { useState } from "react";
import { api, supabase } from "./supabase.ts";
import { rows, useQuery } from "./hooks.ts";
import { Badge, Card, Field, fmtDate } from "./ui.tsx";
import { guessRepo, sealer, secretExists } from "./serverSetup.tsx";

type Alt = "groq";
const INFO: Record<Alt, { label: string; hint: string; placeholder: string; about: string }> = {
  groq: {
    label: "Groq",
    hint: "Crie em console.groq.com → API Keys",
    placeholder: "gsk_…",
    about: "Plano gratuito com limites diários próprios. Para analisar imagens escolha um modelo com visão (ex.: Llama 4 Scout/Maverick). Até 5 imagens por pedido.",
  },
};
const NAMES: Record<string, string> = { claude: "Claude (sua assinatura)", gemini: "Gemini", groq: "Groq" };
const CLAUDE_MODELS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5 (mais capaz)" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 (gasta menos do limite)" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5 (mais rápido)" },
];

interface Row {
  provider: string;
  status: string;
  account_name: string | null;
  metadata: { text_models?: string[]; vision_models?: string[]; checked_at?: string };
}
interface Settings {
  text_provider_order: string[] | null;
  groq_text_model: string | null;
  claude_model: string | null;
}

export function TextAIs({ onToast }: { onToast: (ok: boolean, msg: string) => void }) {
  const q = useQuery(async () => {
    const [ints, settings] = await Promise.all([
      rows(supabase.from("integrations").select("provider, status, account_name, metadata").in("provider", ["gemini", "groq"])) as Promise<Row[]>,
      supabase.from("user_settings").select("text_provider_order, groq_text_model, claude_model").maybeSingle(),
    ]);
    return { ints, settings: (settings.data ?? { text_provider_order: null, groq_text_model: null, claude_model: null }) as Settings };
  });
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [reply, setReply] = useState<Record<string, string>>({});

  const order = [...new Set([...(q.data?.settings.text_provider_order ?? []), "claude", "gemini", "groq"])].filter((p) => p in NAMES);
  const connected = (p: string) => q.data?.ints.find((i) => i.provider === p && i.status === "connected");
  const [claudeToken, setClaudeToken] = useState("");
  const [ghToken, setGhToken] = useState("");
  const [claudeSaved, setClaudeSaved] = useState<boolean | null>(null);
  const repo = guessRepo();

  async function act(label: string, fn: () => Promise<string>) {
    setBusy(label);
    try {
      onToast(true, await fn());
      q.reload();
    } catch (e) {
      onToast(false, (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function saveSettings(patch: Partial<Settings>) {
    const { data: { user } } = await supabase.auth.getUser();
    const { error } = await supabase.from("user_settings").update(patch).eq("user_id", user!.id);
    if (error) throw new Error(error.message);
  }

  const move = (i: number, d: -1 | 1) => {
    const next = [...order];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    return act("order", async () => {
      await saveSettings({ text_provider_order: next });
      return `Ordem salva: ${next.map((p) => NAMES[p]).join(" → ")}`;
    });
  };

  return (
    <>
      <Card title="Ordem das IAs de texto (análise e roteiro)">
        <div className="stack">
          <p className="small muted">A primeira IA com chave salva é usada. Se ela estiver ocupada ou sem cota grátis, a outra assume na hora. A narração (voz) continua sendo do Gemini.</p>
          <div className="list">
            {order.map((p, i) => (
              <div key={p} className="spread">
                <span><strong>{i + 1}.</strong> {NAMES[p]} {p === "claude" ? <Badge tone="info">token no GitHub</Badge> : connected(p) ? <Badge tone="good">chave salva</Badge> : <Badge>sem chave</Badge>}</span>
                <span className="row">
                  <button className="small" aria-label={`Subir ${NAMES[p]}`} disabled={i === 0 || !!busy} onClick={() => move(i, -1)}>↑</button>
                  <button className="small" aria-label={`Descer ${NAMES[p]}`} disabled={i === order.length - 1 || !!busy} onClick={() => move(i, 1)}>↓</button>
                </span>
              </div>
            ))}
          </div>
        </div>
      </Card>

      <Card title="Claude (sua assinatura Pro/Max)">
        <div className="stack">
          <p className="small muted">
            Faz a análise das páginas e o roteiro usando a sua assinatura do Claude, sem chave de API paga. Roda no worker do GitHub com o Claude Code e conta nos limites de uso do seu plano.
            Se o limite acabar, a tarefa passa para a próxima IA da lista (ou espera). A voz continua no Gemini.
          </p>
          <ol className="small" style={{ margin: 0, paddingLeft: 18 }}>
            <li>Em um computador (ou num Codespace do GitHub pelo navegador), instale o Claude Code e rode <code>claude setup-token</code>. Entre com a sua conta do Claude e copie o token gerado.</li>
            <li>Cole o token abaixo junto com um token do GitHub com permissão de <b>Secrets: escrita</b> neste repositório ({repo.owner}/{repo.name}).</li>
            <li>Na lista acima, coloque <b>Claude</b> em 1º lugar.</li>
          </ol>
          <form className="stack" onSubmit={(e) => {
            e.preventDefault();
            act("claude", async () => {
              const seal = await sealer(ghToken, repo);
              await seal("CLAUDE_CODE_OAUTH_TOKEN", claudeToken.trim());
              setClaudeToken("");
              setClaudeSaved(true);
              return "Token do Claude salvo como segredo do GitHub (CLAUDE_CODE_OAUTH_TOKEN)";
            });
          }}>
            <Field label="Token do Claude (claude setup-token)">
              <input type="password" autoComplete="off" value={claudeToken} onChange={(e) => setClaudeToken(e.target.value)} placeholder="sk-ant-oat01-…" />
            </Field>
            <Field label="Token do GitHub" hint="Fine-grained token: este repositório → Secrets: Read and write. Não fica salvo.">
              <input type="password" autoComplete="off" value={ghToken} onChange={(e) => setGhToken(e.target.value)} placeholder="github_pat_…" />
            </Field>
            <div className="row">
              <button className="primary" disabled={!claudeToken || !ghToken || busy === "claude"}>Salvar token no GitHub</button>
              <button type="button" disabled={!ghToken || !!busy} onClick={() => act("claude-check", async () => {
                const ok = await secretExists(ghToken, repo, "CLAUDE_CODE_OAUTH_TOKEN");
                setClaudeSaved(ok);
                return ok ? "Token do Claude encontrado no GitHub" : "Token do Claude ainda não está no GitHub";
              })}>Verificar</button>
            </div>
          </form>
          {claudeSaved !== null && <span className="small">{claudeSaved ? "✓ Token configurado no GitHub." : "Token não encontrado."}</span>}
          <Field label="Modelo do Claude">
            <select value={q.data?.settings.claude_model ?? "claude-opus-5-5"} disabled={!!busy} onChange={(e) => act("claude-model", async () => {
              await saveSettings({ claude_model: e.target.value });
              return `Modelo do Claude: ${e.target.value}`;
            })}>
              {CLAUDE_MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </Field>
        </div>
      </Card>

      {(Object.keys(INFO) as Alt[]).map((p) => {
        const i = q.data?.ints.find((x) => x.provider === p);
        const models = i?.metadata.text_models ?? [];
        const vision = new Set(i?.metadata.vision_models ?? []);
        const model = q.data?.settings.groq_text_model;
        return (
          <Card key={p} title={<span className="spread">{INFO[p].label} (alternativa ao Gemini) {i && <Badge tone={i.status === "connected" ? "good" : "neutral"}>{i.status === "connected" ? "Conectado" : "Desconectado"}</Badge>}</span>}>
            <div className="stack">
              <p className="small muted">{INFO[p].about}</p>
              {i?.status === "connected" && i.account_name && <span className="small">Chave atual: {i.account_name} · verificada {fmtDate(i.metadata.checked_at)}</span>}
              <form className="stack" onSubmit={(e) => {
                e.preventDefault();
                act(p, async () => {
                  const r = await api<{ model: string | null; models: string[] }>("save_ai_key", { provider: p, key: keys[p] });
                  setKeys((k) => ({ ...k, [p]: "" }));
                  return `Chave salva. ${r.models.length} modelos; usando ${r.model ?? "—"}`;
                });
              }}>
                <Field label={`Chave da API ${INFO[p].label}`} hint={INFO[p].hint}>
                  <input type="password" autoComplete="off" value={keys[p] ?? ""} onChange={(e) => setKeys((k) => ({ ...k, [p]: e.target.value }))} placeholder={INFO[p].placeholder} />
                </Field>
                <div className="row">
                  <button className="primary" disabled={!keys[p] || busy === p}>Salvar chave</button>
                  {i?.status === "connected" && (
                    <>
                      <button type="button" disabled={!!busy} onClick={() => act(`t-${p}`, async () => {
                        const r = await api<{ model: string; reply: string }>("test_ai", { provider: p });
                        setReply((x) => ({ ...x, [p]: `${r.model}: “${r.reply}”` }));
                        return `${INFO[p].label} respondeu`;
                      })}>Testar</button>
                      <button type="button" className="danger" disabled={!!busy} onClick={() => act(p, async () => {
                        await api("disconnect", { provider: p });
                        return "Desconectado";
                      })}>Desconectar</button>
                    </>
                  )}
                </div>
              </form>
              {i?.status === "connected" && models.length > 0 && (
                <Field label="Modelo" hint="★ = provavelmente lê imagens (necessário para analisar páginas)">
                  <select value={model ?? ""} disabled={!!busy} onChange={(e) => act(`m-${p}`, async () => {
                    await saveSettings({ groq_text_model: e.target.value });
                    return `Modelo: ${e.target.value}`;
                  })}>
                    {models.map((m) => <option key={m} value={m}>{vision.has(m) ? "★ " : ""}{m}</option>)}
                  </select>
                </Field>
              )}
              {reply[p] && <span className="small">{reply[p]}</span>}
            </div>
          </Card>
        );
      })}
    </>
  );
}
