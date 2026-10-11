import { useState } from "react";
import { saveConnection } from "../supabase.ts";
import { ErrorBox, Field } from "../ui.tsx";

/** First screen: link this site to a Supabase project, right from the panel. */
export default function Connect() {
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await saveConnection(url, key);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <main className="login stack">
      <div className="brand" style={{ fontSize: "1.4rem", padding: 0, fontWeight: 800, display: "flex", gap: 10, alignItems: "center" }}>
        <span className="brand-mark" aria-hidden /> AutoVideo Short
      </div>
      <h1 style={{ fontSize: "1.3rem" }}>Ligar o painel ao Supabase</h1>
      <ol className="small stack" style={{ paddingLeft: 18, margin: 0 }}>
        <li>Crie uma conta grátis em <a href="https://supabase.com/dashboard" target="_blank" rel="noreferrer">supabase.com</a> e um projeto (plano Free). Guarde a senha do banco.</li>
        <li>No projeto, abra <b>Project Settings → API Keys</b> (ou <b>Data API</b>) e copie a <b>Project URL</b> e a chave <b>publishable</b> (ou <b>anon</b>).</li>
        <li>Cole aqui embaixo. Depois o painel abre o assistente que configura o resto.</li>
      </ol>
      <form className="card stack" onSubmit={submit}>
        <Field label="Project URL" hint="Ex.: https://abcdefghijklmnop.supabase.co">
          <input inputMode="url" autoComplete="off" required value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://….supabase.co" />
        </Field>
        <Field label="Chave publishable / anon" hint="É a chave pública. Nunca cole aqui a chave service_role/secret.">
          <input autoComplete="off" required value={key} onChange={(e) => setKey(e.target.value)} placeholder="sb_publishable_… ou eyJ…" />
        </Field>
        <ErrorBox error={error} />
        <button className="primary" disabled={busy}>{busy ? "Verificando…" : "Conectar"}</button>
      </form>
      <p className="small muted">Esses dois valores são públicos e ficam salvos só neste navegador.</p>
    </main>
  );
}
