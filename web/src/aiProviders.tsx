// Groq as a text AI besides Gemini, and the order in which they are tried.
// The key goes to the server (encrypted there) and never comes back.

import { useState } from "react";
import { api, supabase } from "./supabase.ts";
import { rows, useQuery } from "./hooks.ts";
import { Badge, Card, Field, fmtDate } from "./ui.tsx";

type Alt = "groq";
const INFO: Record<Alt, { label: string; hint: string; placeholder: string; about: string }> = {
  groq: {
    label: "Groq",
    hint: "Crie em console.groq.com → API Keys",
    placeholder: "gsk_…",
    about: "Plano gratuito com limites diários próprios. Para analisar imagens escolha um modelo com visão (ex.: Llama 4 Scout/Maverick). Até 5 imagens por pedido.",
  },
};
const NAMES: Record<string, string> = { gemini: "Gemini", groq: "Groq" };

interface Row {
  provider: string;
  status: string;
  account_name: string | null;
  metadata: { text_models?: string[]; vision_models?: string[]; checked_at?: string };
}
interface Settings {
  text_provider_order: string[] | null;
  groq_text_model: string | null;
}

export function TextAIs({ onToast }: { onToast: (ok: boolean, msg: string) => void }) {
  const q = useQuery(async () => {
    const [ints, settings] = await Promise.all([
      rows(supabase.from("integrations").select("provider, status, account_name, metadata").in("provider", ["gemini", "groq"])) as Promise<Row[]>,
      supabase.from("user_settings").select("text_provider_order, groq_text_model").maybeSingle(),
    ]);
    return { ints, settings: (settings.data ?? { text_provider_order: null, groq_text_model: null }) as Settings };
  });
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [reply, setReply] = useState<Record<string, string>>({});

  const order = [...new Set([...(q.data?.settings.text_provider_order ?? []), "gemini", "groq"])].filter((p) => p in NAMES);
  const connected = (p: string) => q.data?.ints.find((i) => i.provider === p && i.status === "connected");

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
                <span><strong>{i + 1}.</strong> {NAMES[p]} {connected(p) ? <Badge tone="good">chave salva</Badge> : <Badge>sem chave</Badge>}</span>
                <span className="row">
                  <button className="small" aria-label={`Subir ${NAMES[p]}`} disabled={i === 0 || !!busy} onClick={() => move(i, -1)}>↑</button>
                  <button className="small" aria-label={`Descer ${NAMES[p]}`} disabled={i === order.length - 1 || !!busy} onClick={() => move(i, 1)}>↓</button>
                </span>
              </div>
            ))}
          </div>
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
