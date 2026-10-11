// "Configurar servidor" wizard: talks to the GitHub REST API straight from the
// browser to store the repository secrets (encrypted with the repo's public
// key, libsodium sealed box) and start the deploy workflows. Tokens typed here
// live only in memory: they are never saved or sent anywhere except GitHub.

import { useEffect, useState } from "react";
import { connection } from "./supabase.ts";
import { Badge, Card, ErrorBox, Field } from "./ui.tsx";

const GH = "https://api.github.com";

interface Repo {
  owner: string;
  name: string;
}

/** On GitHub Pages the address already says which repository this is. */
export function guessRepo(): Repo {
  const m = /^([a-z0-9-]+)\.github\.io$/i.exec(window.location.hostname);
  const path = window.location.pathname.split("/").filter(Boolean)[0];
  return m && path ? { owner: m[1], name: path } : { owner: "", name: "autovideo-short" };
}

async function gh<T>(token: string, path: string, init: RequestInit = {}): Promise<{ status: number; data: T }> {
  const res = await fetch(`${GH}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok && res.status !== 404) {
    const msg = (data as { message?: string } | null)?.message ?? `HTTP ${res.status}`;
    if (res.status === 401) throw new Error("Token do GitHub inválido ou expirado.");
    if (res.status === 403) throw new Error(`O token do GitHub não tem permissão para isso (${msg}). Veja as permissões indicadas abaixo.`);
    throw new Error(`GitHub: ${msg}`);
  }
  return { status: res.status, data: data as T };
}

function randomBase64(bytes: number): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(bytes))));
}
function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function sealer(token: string, repo: Repo) {
  const { default: sodium } = await import("libsodium-wrappers");
  await sodium.ready;
  const { data: key } = await gh<{ key_id: string; key: string }>(token, `/repos/${repo.owner}/${repo.name}/actions/secrets/public-key`);
  const pk = sodium.from_base64(key.key, sodium.base64_variants.ORIGINAL);
  return async (name: string, value: string) => {
    const sealed = sodium.crypto_box_seal(sodium.from_string(value), pk);
    await gh(token, `/repos/${repo.owner}/${repo.name}/actions/secrets/${name}`, {
      method: "PUT",
      body: JSON.stringify({ encrypted_value: sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL), key_id: key.key_id }),
    });
  };
}

async function secretExists(token: string, repo: Repo, name: string): Promise<boolean> {
  return (await gh(token, `/repos/${repo.owner}/${repo.name}/actions/secrets/${name}`)).status === 200;
}

async function setVariable(token: string, repo: Repo, name: string, value: string) {
  const base = `/repos/${repo.owner}/${repo.name}/actions/variables`;
  const exists = (await gh(token, `${base}/${name}`)).status === 200;
  if (exists) await gh(token, `${base}/${name}`, { method: "PATCH", body: JSON.stringify({ name, value }) });
  else await gh(token, base, { method: "POST", body: JSON.stringify({ name, value }) });
}

async function dispatch(token: string, repo: Repo, workflow: string) {
  await gh(token, `/repos/${repo.owner}/${repo.name}/actions/workflows/${workflow}/dispatches`, {
    method: "POST",
    body: JSON.stringify({ ref: "main" }),
  });
}

interface Run {
  status: string;
  conclusion: string | null;
  html_url: string;
  created_at: string;
}

async function latestRun(token: string, repo: Repo, workflow: string): Promise<Run | null> {
  const { data } = await gh<{ workflow_runs: Run[] }>(token, `/repos/${repo.owner}/${repo.name}/actions/workflows/${workflow}/runs?per_page=1&event=workflow_dispatch`);
  return data?.workflow_runs?.[0] ?? null;
}

type StepState = "todo" | "running" | "done" | "error" | "skipped";
interface Step {
  label: string;
  state: StepState;
  detail?: string;
}

const WORKFLOWS = [
  { file: "deploy-supabase.yml", label: "Instalar banco, funções e agendador" },
  { file: "deploy-web.yml", label: "Republicar o site" },
];

export function ServerSetup() {
  const ref = connection?.url.match(/^https:\/\/([a-z0-9]+)\./)?.[1] ?? "";
  const [repo, setRepo] = useState<Repo>(guessRepo);
  const [f, setF] = useState({
    githubToken: "",
    supabaseToken: "",
    dbPassword: "",
    serviceKey: "",
    gemini: "",
    ytId: "",
    ytSecret: "",
    ttKey: "",
    ttSecret: "",
  });
  const [steps, setSteps] = useState<Step[]>([]);
  const [runs, setRuns] = useState<Record<string, Run | null>>({});
  const [busy, setBusy] = useState(false);
  const [dispatchedAt, setDispatchedAt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value.trim() });

  // Follow the deploy runs once they were started.
  const started = steps.some((s) => s.label.startsWith("Iniciar") && s.state === "done");
  useEffect(() => {
    if (!started || !f.githubToken) return;
    let alive = true;
    const poll = async () => {
      const next: Record<string, Run | null> = {};
      for (const w of WORKFLOWS) {
        const r = await latestRun(f.githubToken, repo, w.file).catch(() => null);
        // ignore runs from before this configuration
        next[w.file] = r && new Date(r.created_at).getTime() >= dispatchedAt - 60_000 ? r : null;
      }
      if (alive) setRuns(next);
    };
    poll();
    const id = setInterval(poll, 15_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [started, f.githubToken, repo, dispatchedAt]);

  async function run(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!connection) return setError("Conecte o site ao Supabase primeiro.");
    if (!repo.owner || !repo.name) return setError("Informe o dono e o nome do repositório.");
    setBusy(true);
    const list: Step[] = [];
    const push = (label: string): number => {
      list.push({ label, state: "running" });
      setSteps([...list]);
      return list.length - 1;
    };
    const finish = (i: number, state: StepState, detail?: string) => {
      list[i] = { ...list[i], state, detail };
      setSteps([...list]);
    };
    let i = -1;
    try {
      i = push("Verificar acesso ao repositório");
      const { data: info } = await gh<{ permissions?: { admin?: boolean; push?: boolean }; private: boolean }>(f.githubToken, `/repos/${repo.owner}/${repo.name}`);
      if (!info) throw new Error("Repositório não encontrado (confira o nome ou as permissões do token).");
      finish(i, "done", info.private ? "repositório privado" : "repositório público");

      i = push("Gravar segredos cifrados no GitHub");
      const seal = await sealer(f.githubToken, repo);
      const secrets: [string, string][] = [
        ["SUPABASE_URL", connection.url],
        ["SUPABASE_PROJECT_REF", ref],
        ["SUPABASE_ACCESS_TOKEN", f.supabaseToken],
        ["SUPABASE_DB_PASSWORD", f.dbPassword],
        ["SUPABASE_SERVICE_ROLE_KEY", f.serviceKey],
        ["GH_DISPATCH_TOKEN", f.githubToken],
        ["GEMINI_API_KEY", f.gemini],
        ["YOUTUBE_CLIENT_ID", f.ytId],
        ["YOUTUBE_CLIENT_SECRET", f.ytSecret],
        ["TIKTOK_CLIENT_KEY", f.ttKey],
        ["TIKTOK_CLIENT_SECRET", f.ttSecret],
      ];
      // Generated once: replacing them later would make stored keys unreadable.
      const generated: string[] = [];
      if (!(await secretExists(f.githubToken, repo, "TOKEN_ENCRYPTION_KEY"))) {
        secrets.push(["TOKEN_ENCRYPTION_KEY", randomBase64(32)]);
        generated.push("TOKEN_ENCRYPTION_KEY");
      }
      if (!(await secretExists(f.githubToken, repo, "CRON_SECRET"))) {
        secrets.push(["CRON_SECRET", randomHex(24)]);
        generated.push("CRON_SECRET");
      }
      let n = 0;
      for (const [name, value] of secrets) {
        if (!value) continue; // empty optional field: keep what is already there
        await seal(name, value);
        n++;
      }
      finish(i, "done", `${n} segredo(s) gravado(s)${generated.length ? `; gerados: ${generated.join(", ")}` : ""}`);

      i = push("Gravar variáveis públicas do site");
      const appUrl = window.location.href.split("#")[0];
      await setVariable(f.githubToken, repo, "VITE_SUPABASE_URL", connection.url);
      await setVariable(f.githubToken, repo, "VITE_SUPABASE_PUBLISHABLE_KEY", connection.key);
      await setVariable(f.githubToken, repo, "APP_URL", appUrl);
      finish(i, "done", appUrl);

      i = push("Iniciar instalação no servidor");
      setDispatchedAt(Date.now());
      for (const w of WORKFLOWS) await dispatch(f.githubToken, repo, w.file);
      finish(i, "done", "acompanhe abaixo (leva de 2 a 5 minutos)");
    } catch (err) {
      if (i >= 0) finish(i, "error", (err as Error).message);
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const required = f.githubToken && f.supabaseToken && f.dbPassword && f.serviceKey;
  return (
    <Card title="Configurar o servidor pelo painel">
      <form className="stack small" onSubmit={run}>
        <p className="muted">
          Preencha e toque em <b>Configurar</b>: o painel grava tudo cifrado nos segredos do GitHub e inicia a instalação do banco,
          das funções e do agendador. Os tokens ficam só na memória desta página.
        </p>
        <div className="grid two">
          <Field label="Dono do repositório"><input value={repo.owner} onChange={(e) => setRepo({ ...repo, owner: e.target.value.trim() })} /></Field>
          <Field label="Repositório"><input value={repo.name} onChange={(e) => setRepo({ ...repo, name: e.target.value.trim() })} /></Field>
        </div>
        <Field label="Token do GitHub" hint={<>Crie em <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer">GitHub → Fine-grained token</a>, só para este repositório, com permissão <b>Read and write</b> em: Actions, Contents, Secrets e Variables. O servidor também o usa para acionar o renderizador.</>}>
          <input type="password" autoComplete="off" value={f.githubToken} onChange={set("githubToken")} placeholder="github_pat_…" />
        </Field>
        <Field label="Token de acesso do Supabase" hint={<>Em <a href="https://supabase.com/dashboard/account/tokens" target="_blank" rel="noreferrer">Supabase → Account → Access Tokens</a>.</>}>
          <input type="password" autoComplete="off" value={f.supabaseToken} onChange={set("supabaseToken")} placeholder="sbp_…" />
        </Field>
        <Field label="Senha do banco de dados" hint="A senha definida ao criar o projeto (Project Settings → Database permite redefinir).">
          <input type="password" autoComplete="off" value={f.dbPassword} onChange={set("dbPassword")} />
        </Field>
        <Field label="Chave service_role (secreta)" hint={<>Project Settings → API Keys{ref ? <> do projeto <b>{ref}</b></> : null}. Só o servidor usa; nunca vai para o site.</>}>
          <input type="password" autoComplete="off" value={f.serviceKey} onChange={set("serviceKey")} />
        </Field>
        <details>
          <summary style={{ minHeight: 44, display: "flex", alignItems: "center" }}>Opcional: Gemini, YouTube e TikTok</summary>
          <div className="stack" style={{ marginTop: 8 }}>
            <Field label="Chave do Gemini (padrão do servidor)" hint="Também pode ser salva depois em Integrações."><input type="password" autoComplete="off" value={f.gemini} onChange={set("gemini")} /></Field>
            <Field label="YouTube client ID"><input value={f.ytId} onChange={set("ytId")} /></Field>
            <Field label="YouTube client secret"><input type="password" autoComplete="off" value={f.ytSecret} onChange={set("ytSecret")} /></Field>
            <Field label="TikTok client key"><input value={f.ttKey} onChange={set("ttKey")} /></Field>
            <Field label="TikTok client secret"><input type="password" autoComplete="off" value={f.ttSecret} onChange={set("ttSecret")} /></Field>
            <p className="muted">Campos vazios não alteram o que já estiver configurado.</p>
          </div>
        </details>
        <ErrorBox error={error} />
        <button className="primary" disabled={!required || busy}>{busy ? "Configurando…" : "Configurar"}</button>
      </form>

      {steps.length > 0 && (
        <div className="list small" style={{ marginTop: 12 }}>
          {steps.map((s) => (
            <div key={s.label}>
              <div className="spread">
                <span>{s.label}</span>
                <Badge tone={s.state === "done" ? "good" : s.state === "error" ? "bad" : "info"}>
                  {{ todo: "aguardando", running: "em andamento", done: "ok", error: "erro", skipped: "pulado" }[s.state]}
                </Badge>
              </div>
              {s.detail && <div className="muted">{s.detail}</div>}
            </div>
          ))}
          {WORKFLOWS.map((w) => {
            const r = runs[w.file];
            if (!started) return null;
            const tone = r?.conclusion === "success" ? "good" : r?.conclusion ? "bad" : "info";
            const label = !r ? "iniciando…" : r.status !== "completed" ? "rodando…" : r.conclusion === "success" ? "concluído" : `falhou (${r.conclusion})`;
            return (
              <div key={w.file} className="spread">
                <span>{w.label}</span>
                <span className="row">
                  <Badge tone={tone}>{label}</Badge>
                  {r && <a href={r.html_url} target="_blank" rel="noreferrer">ver</a>}
                </span>
              </div>
            );
          })}
          {runs["deploy-supabase.yml"]?.conclusion === "success" && (
            <div className="alert info">Servidor instalado. A lista de verificação do Painel atualiza sozinha nos próximos minutos.</div>
          )}
        </div>
      )}
    </Card>
  );
}
