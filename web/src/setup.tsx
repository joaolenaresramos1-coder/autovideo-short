// Deployment guide shown inside the app (Painel → Implantação) and on the
// "not configured" screen. Mirrors docs/IMPLANTACAO.md.

import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { supabase, configured } from "./supabase.ts";
import { useQuery } from "./hooks.ts";
import { Badge, Card } from "./ui.tsx";

const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? "https://SEU-PROJETO.supabase.co";
const appUrl = () => window.location.href.split("#")[0];

function Copy({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  return (
    <span className="row" style={{ gap: 6 }}>
      <code className="mono">{value}</code>
      <button
        type="button"
        className="small"
        onClick={() => navigator.clipboard?.writeText(value).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); })}
      >
        {done ? "Copiado" : "Copiar"}
      </button>
    </span>
  );
}

/** Random values generated in this browser only — never sent anywhere. */
function SecretGenerator() {
  const make = () => {
    const b = crypto.getRandomValues(new Uint8Array(32));
    const key = btoa(String.fromCharCode(...b));
    const hex = Array.from(crypto.getRandomValues(new Uint8Array(24)), (x) => x.toString(16).padStart(2, "0")).join("");
    return { key, hex };
  };
  const [v, setV] = useState<{ key: string; hex: string } | null>(null);
  return (
    <div className="card stack">
      <strong>Gerar valores aleatórios</strong>
      <span className="muted">Gerados aqui no seu aparelho e não são enviados a lugar nenhum. Copie para os secrets do GitHub.</span>
      <button type="button" className="small" onClick={() => setV(make())}>{v ? "Gerar outros" : "Gerar"}</button>
      {v && (
        <>
          <span>TOKEN_ENCRYPTION_KEY: <Copy value={v.key} /></span>
          <span>CRON_SECRET: <Copy value={v.hex} /></span>
        </>
      )}
    </div>
  );
}

function Step({ n, title, done, children }: { n: number; title: string; done?: boolean; children: ReactNode }) {
  return (
    <details className="card" open={done === false}>
      <summary className="spread" style={{ cursor: "pointer", minHeight: 44 }}>
        <strong>{n}. {title}</strong>
        {done !== undefined && <Badge tone={done ? "good" : "warn"}>{done ? "Feito" : "Pendente"}</Badge>}
      </summary>
      <div className="stack small" style={{ marginTop: 10 }}>{children}</div>
    </details>
  );
}

export interface SetupStatus {
  site: boolean;
  scheduler: boolean;
  gemini: boolean;
  work: boolean;
  schedule: boolean;
  worker: boolean;
  youtube: boolean;
  tiktok: boolean;
}

/** What can be verified from the browser (RLS-safe reads only). */
export function useSetupStatus() {
  return useQuery<SetupStatus>(async () => {
    if (!configured) return { site: false, scheduler: false, gemini: false, work: false, schedule: false, worker: false, youtube: false, tiktok: false };
    const hourAgo = new Date(Date.now() - 2 * 3600_000).toISOString();
    const [cleanup, integrations, works, schedules, rendered] = await Promise.all([
      supabase.from("cleanup_runs").select("id", { count: "exact", head: true }).gte("started_at", hourAgo),
      supabase.from("integrations").select("provider, status"),
      supabase.from("works").select("id", { count: "exact", head: true }),
      supabase.from("schedules").select("id", { count: "exact", head: true }),
      supabase.from("job_steps").select("id", { count: "exact", head: true }).eq("step", "fetching").eq("status", "succeeded"),
    ]);
    const conn = (p: string) => (integrations.data ?? []).some((i: { provider: string; status: string }) => i.provider === p && i.status === "connected");
    return {
      site: true,
      scheduler: (cleanup.count ?? 0) > 0,
      gemini: conn("gemini"),
      work: (works.count ?? 0) > 0,
      schedule: (schedules.count ?? 0) > 0,
      worker: (rendered.count ?? 0) > 0,
      youtube: conn("youtube"),
      tiktok: conn("tiktok"),
    };
  }, [], 60_000);
}

const REQUIRED: (keyof SetupStatus)[] = ["site", "scheduler", "gemini", "worker"];

/** Compact checklist card for the dashboard. */
export function SetupChecklist() {
  const q = useSetupStatus();
  const s = q.data;
  if (!s) return null;
  const done = REQUIRED.filter((k) => s[k]).length;
  const items: { key: keyof SetupStatus; label: string; to?: string; optional?: boolean }[] = [
    { key: "site", label: "Site ligado ao Supabase" },
    { key: "scheduler", label: "Agendador no servidor (pg_cron) rodando", to: "/implantacao" },
    { key: "gemini", label: "Chave do Gemini salva", to: "/integracoes" },
    { key: "work", label: "Obra cadastrada", to: "/obras/nova", optional: true },
    { key: "schedule", label: "Calendário automático configurado", to: "/calendario", optional: true },
    { key: "worker", label: "Primeiro vídeo processado (use Gerar vídeo)", to: "/gerar" },
    { key: "youtube", label: "YouTube conectado", to: "/integracoes", optional: true },
    { key: "tiktok", label: "TikTok conectado", to: "/integracoes", optional: true },
  ];
  return (
    <Card title={<span className="spread">Implantação <Badge tone={done === REQUIRED.length ? "good" : "warn"}>{done}/{REQUIRED.length}</Badge></span>}
      footer={<Link to="/implantacao">Ver guia completo</Link>}>
      <div className="list small">
        {items.map((i) => (
          <div key={i.key} className="spread">
            <span className={s[i.key] ? "check-ok" : ""}>{s[i.key] ? "✓" : "○"} {i.label}{i.optional ? " (opcional)" : ""}</span>
            {!s[i.key] && i.to && <Link to={i.to}>Resolver</Link>}
          </div>
        ))}
      </div>
    </Card>
  );
}

/** Full step-by-step guide. `status` is omitted on the not-configured screen. */
export function SetupGuide({ status }: { status?: SetupStatus }) {
  const ref = SUPABASE_URL.replace(/^https:\/\//, "").split(".")[0];
  return (
    <div className="stack">
      <p className="small muted">
        Tudo pode ser feito pelo navegador do celular. Nenhum serviço pago é ativado pelo sistema. Depois de concluir, a produção
        roda no servidor — você pode fechar este site.
      </p>

      <Step n={1} title="Criar o projeto no Supabase" done={status?.site}>
        <ol>
          <li>Crie uma conta em <a href="https://supabase.com" target="_blank" rel="noreferrer">supabase.com</a> e um projeto no plano Free. Anote a senha do banco.</li>
          <li>Em <b>Project Settings → API</b> anote: Project URL, Project ref, chave <b>publishable/anon</b> (pública) e chave <b>service_role</b> (privada — nunca coloque no site).</li>
          <li>Em <b>Account → Access Tokens</b> crie um token para o GitHub.</li>
          <li>Em <b>Authentication → URL Configuration</b>, em <i>Site URL</i>, coloque: <Copy value={appUrl()} /></li>
        </ol>
      </Step>

      <Step n={2} title="Cadastrar segredos e variáveis no GitHub" done={status?.site}>
        <p>No repositório: <b>Settings → Secrets and variables → Actions</b>.</p>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Nome</th><th>Tipo</th><th>Valor</th></tr></thead>
            <tbody>
              <tr><td className="mono">SUPABASE_ACCESS_TOKEN</td><td>secret</td><td>token do passo 1.3</td></tr>
              <tr><td className="mono">SUPABASE_PROJECT_REF</td><td>secret</td><td>{configured ? <Copy value={ref} /> : "ref do projeto"}</td></tr>
              <tr><td className="mono">SUPABASE_DB_PASSWORD</td><td>secret</td><td>senha do banco</td></tr>
              <tr><td className="mono">SUPABASE_URL</td><td>secret</td><td>Project URL</td></tr>
              <tr><td className="mono">SUPABASE_SERVICE_ROLE_KEY</td><td>secret</td><td>chave service_role (só o worker usa)</td></tr>
              <tr><td className="mono">TOKEN_ENCRYPTION_KEY</td><td>secret</td><td>32 bytes aleatórios em base64</td></tr>
              <tr><td className="mono">CRON_SECRET</td><td>secret</td><td>texto aleatório longo</td></tr>
              <tr><td className="mono">GH_DISPATCH_TOKEN</td><td>secret</td><td>token fine-grained do repositório com “Contents: read and write”</td></tr>
              <tr><td className="mono">GEMINI_API_KEY</td><td>secret (opcional)</td><td>chave padrão do Gemini</td></tr>
              <tr><td className="mono">VITE_SUPABASE_URL</td><td>variable</td><td>Project URL</td></tr>
              <tr><td className="mono">VITE_SUPABASE_PUBLISHABLE_KEY</td><td>variable</td><td>chave publishable/anon</td></tr>
              <tr><td className="mono">APP_URL</td><td>variable</td><td><Copy value={appUrl()} /></td></tr>
            </tbody>
          </table>
        </div>
        <SecretGenerator />
      </Step>

      <Step n={3} title="Publicar o site (GitHub Pages)" done={status?.site}>
        <ol>
          <li><b>Settings → Pages → Source: GitHub Actions</b> (Pages gratuito exige repositório público).</li>
          <li><b>Actions → Deploy site (GitHub Pages) → Run workflow</b>.</li>
          <li>Abra o endereço no celular e use <b>Adicionar à tela inicial</b>.</li>
        </ol>
      </Step>

      <Step n={4} title="Banco, funções e agendador no servidor" done={status?.scheduler}>
        <ol>
          <li><b>Actions → Deploy Supabase → Run workflow</b>. Ele aplica as migrações, publica as funções tick, cleanup, api e oauth e configura o agendador sozinho (Vault + pg_cron) — sem SQL manual.</li>
          <li>Se o workflow avisar que o pg_cron está indisponível: ative <b>pg_cron</b> e <b>pg_net</b> em Database → Extensions e rode o workflow de novo.</li>
          <li>Depois do primeiro deploy, cada mudança na branch main republica automaticamente.</li>
          <li>Este passo aparece como feito quando a limpeza automática rodar (até 20 min).</li>
        </ol>
      </Step>

      <Step n={5} title="Conectar o Gemini" done={status?.gemini}>
        <p>Crie a chave em <a href="https://aistudio.google.com" target="_blank" rel="noreferrer">aistudio.google.com</a> e salve em <Link to="/integracoes">Integrações</Link>. Use <b>Testar narração</b> para confirmar que o modelo de fala gera áudio.</p>
      </Step>

      <Step n={6} title="Cadastrar obra e calendário" done={status ? status.work && status.schedule : undefined}>
        <p><Link to="/obras/nova">Nova obra</Link>: cole o link (MangaDex, AniList ou RSS) e informe a autorização de reutilização. Depois crie a programação em <Link to="/calendario">Calendário</Link>.</p>
      </Step>

      <Step n={7} title="Worker de renderização (GitHub Actions)" done={status?.worker}>
        <p>Não precisa de ação: ele é acionado pelo Supabase quando há trabalho e, por segurança, uma vez por hora. Para testar: <b>Actions → Render worker → Run workflow</b>. Aparece como feito depois do primeiro capítulo processado.</p>
      </Step>

      <Step n={8} title="YouTube (opcional)" done={status?.youtube}>
        <ol>
          <li>Em <a href="https://console.cloud.google.com" target="_blank" rel="noreferrer">console.cloud.google.com</a>: crie um projeto e ative <b>YouTube Data API v3</b>.</li>
          <li>Tela de consentimento OAuth: tipo External, seu e-mail como usuário de teste, escopos youtube.upload e youtube.readonly.</li>
          <li>Credentials → OAuth client ID → Web application. Redirect URI: <Copy value={`${SUPABASE_URL}/functions/v1/oauth/callback/youtube`} /></li>
          <li>Salve <span className="mono">YOUTUBE_CLIENT_ID</span> e <span className="mono">YOUTUBE_CLIENT_SECRET</span> nos secrets, rode <b>Deploy Supabase</b> e conecte em <Link to="/integracoes">Integrações</Link>.</li>
        </ol>
      </Step>

      <Step n={9} title="TikTok (opcional)" done={status?.tiktok}>
        <ol>
          <li>Em <a href="https://developers.tiktok.com" target="_blank" rel="noreferrer">developers.tiktok.com</a> crie um app com Login Kit e Content Posting API (Direct Post), escopos user.info.basic e video.publish.</li>
          <li>Redirect URI: <Copy value={`${SUPABASE_URL}/functions/v1/oauth/callback/tiktok`} /></li>
          <li>Salve <span className="mono">TIKTOK_CLIENT_KEY</span> e <span className="mono">TIKTOK_CLIENT_SECRET</span>, rode <b>Deploy Supabase</b> e conecte em Integrações.</li>
          <li>Sem a auditoria do TikTok, os vídeos só podem ser publicados como privados.</li>
        </ol>
      </Step>
    </div>
  );
}
