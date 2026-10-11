import { useState } from "react";
import { supabase } from "../supabase.ts";
import { ErrorBox, Field } from "../ui.tsx";

export default function Login() {
  const [mode, setMode] = useState<"in" | "up">("in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setInfo(null);
    const redirect = window.location.href.split("#")[0];
    const r = mode === "in"
      ? await supabase.auth.signInWithPassword({ email, password })
      : await supabase.auth.signUp({ email, password, options: { emailRedirectTo: redirect } });
    setBusy(false);
    if (r.error) setError(r.error.message);
    else if (mode === "up" && !r.data.session) setInfo("Conta criada. Confirme o e-mail recebido para entrar.");
  }

  return (
    <main className="login">
      <div className="brand" style={{ fontSize: "1.4rem", padding: "0 0 16px", fontWeight: 800, display: "flex", gap: 10, alignItems: "center" }}>
        <span className="brand-mark" aria-hidden /> AutoVideo Short
      </div>
      <p className="muted">Resumos automáticos de mangás, manhuas, manhwas e animes. A produção roda no servidor — você pode fechar o navegador.</p>
      <form className="stack card" onSubmit={submit}>
        <Field label="E-mail">
          <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Senha" hint={mode === "up" ? "Mínimo de 8 caracteres" : undefined}>
          <input type="password" autoComplete={mode === "in" ? "current-password" : "new-password"} minLength={8} required value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <ErrorBox error={error} />
        {info && <div className="alert info">{info}</div>}
        <button className="primary" disabled={busy}>{mode === "in" ? "Entrar" : "Criar conta"}</button>
        <button type="button" onClick={() => setMode(mode === "in" ? "up" : "in")}>
          {mode === "in" ? "Criar uma conta" : "Já tenho conta"}
        </button>
      </form>
    </main>
  );
}
