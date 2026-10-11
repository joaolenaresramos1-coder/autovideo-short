# Implantação passo a passo

Tudo pode ser feito pelo navegador do celular. Nenhum serviço pago é ativado por este projeto; você escolhe os planos.

## 1. Supabase (banco, login, arquivos e agendador)

1. Crie uma conta em <https://supabase.com> e um projeto (plano Free). Anote a **senha do banco**.
2. Em **Project Settings → API**, anote:
   - **Project URL** (`https://xxxx.supabase.co`) e o **Project ref** (`xxxx`);
   - a chave **publishable/anon** (pública, vai para o site);
   - a chave **service_role/secret** (privada, só para o worker — nunca no site).
3. Em **Account → Access Tokens**, crie um token para o GitHub publicar as migrações.
4. Em **Authentication → URL Configuration**, coloque o endereço do site (passo 3) em *Site URL*.

## 2. Segredos do GitHub

No repositório: **Settings → Secrets and variables → Actions**.

Gere dois valores aleatórios (pode usar um gerador de senhas; ou `openssl rand -base64 32` e `openssl rand -hex 24`):

| Nome | Tipo | Valor |
|---|---|---|
| `SUPABASE_ACCESS_TOKEN` | secret | token do passo 1.3 |
| `SUPABASE_PROJECT_REF` | secret | `xxxx` |
| `SUPABASE_DB_PASSWORD` | secret | senha do banco |
| `SUPABASE_URL` | secret | `https://xxxx.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | secret | chave service_role (só o worker usa) |
| `TOKEN_ENCRYPTION_KEY` | secret | 32 bytes em base64 (cifra chaves e tokens) |
| `CRON_SECRET` | secret | texto aleatório (protege o agendador) |
| `GH_DISPATCH_TOKEN` | secret | token *fine-grained* deste repositório com **Contents: read and write** (o Supabase usa para acordar o worker) |
| `GEMINI_API_KEY` | secret (opcional) | chave padrão; cada usuário também pode salvar a sua no painel |
| `YOUTUBE_CLIENT_ID` / `YOUTUBE_CLIENT_SECRET` | secret (opcional) | passo 5 |
| `TIKTOK_CLIENT_KEY` / `TIKTOK_CLIENT_SECRET` | secret (opcional) | passo 6 |
| `VITE_SUPABASE_URL` | **variable** | `https://xxxx.supabase.co` |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | **variable** | chave publishable/anon |
| `APP_URL` | **variable** | endereço do site, ex. `https://usuario.github.io/autovideo-short/` |

## 3. Site (GitHub Pages)

1. **Settings → Pages → Source: GitHub Actions.** (Pages gratuito exige repositório público.)
2. Faça o merge para `main` ou rode **Actions → Deploy site (GitHub Pages) → Run workflow**.
3. Abra o endereço no celular e use **Adicionar à tela inicial** para instalar o app.

## 4. Banco e Edge Functions

1. Rode **Actions → Deploy Supabase → Run workflow**. Ele aplica as migrações, grava os secrets das funções e publica `tick`, `cleanup`, `api` e `oauth`.
2. No Supabase, abra **SQL Editor** e execute (uma vez), com os seus valores:

```sql
select vault.create_secret('https://xxxx.supabase.co', 'project_url');
select vault.create_secret('MESMO_VALOR_DO_CRON_SECRET', 'cron_secret');
```

3. Confira em **Database → Cron Jobs** os jobs `autovideo-tick` (1 min), `autovideo-cleanup` (20 min), `autovideo-promote` e `autovideo-storage-alerts`. Se a migração não tiver conseguido criar as extensões, ative **pg_cron** e **pg_net** em *Database → Extensions* e rode o deploy de novo.

## 5. YouTube (opcional)

1. Em <https://console.cloud.google.com>: crie um projeto, ative **YouTube Data API v3**.
2. **OAuth consent screen**: tipo *External*, adicione seu e-mail como usuário de teste e os escopos `youtube.upload` e `youtube.readonly`.
3. **Credentials → Create OAuth client ID → Web application**, com *Authorized redirect URI*:
   `https://xxxx.supabase.co/functions/v1/oauth/callback/youtube`
4. Salve client ID/secret nos secrets do GitHub e rode **Deploy Supabase** de novo.
5. No app: **Integrações → YouTube → Conectar**.

## 6. TikTok (opcional)

1. Em <https://developers.tiktok.com> crie um app com **Login Kit** e **Content Posting API** (Direct Post), escopos `user.info.basic` e `video.publish`.
2. Redirect URI: `https://xxxx.supabase.co/functions/v1/oauth/callback/tiktok`.
3. Salve client key/secret nos secrets e rode **Deploy Supabase**.
4. Sem auditoria do TikTok, só é possível publicar como privado (`SELF_ONLY`) — o sistema escolhe isso automaticamente e avisa.

## 7. Worker de renderização

Não precisa de ação: o workflow **Render worker** roda quando o Supabase avisa (via `GH_DISPATCH_TOKEN`) e, por segurança, a cada 15 min. Para testar: **Actions → Render worker → Run workflow**.

Repositórios públicos sem atividade por 60 dias têm os crons do GitHub pausados; o disparo pelo Supabase continua funcionando.

## 8. Primeiro uso

1. Crie a conta no site e confirme o e-mail.
2. **Integrações → Gemini**: cole a chave (<https://aistudio.google.com>) e use **Testar narração** — isso confirma que o modelo de fala configurado realmente gera áudio.
3. **Obras → Nova obra**: cole o link (MangaDex, AniList ou RSS) e informe a situação de autorização.
4. **Calendário → + Programação**: dias, horário, fuso, duração e plataformas.
5. Feche o navegador. Acompanhe depois em **Fila**, **Vídeos** e **Publicações**.

## Alternativa de render: Shotstack

O renderizador padrão é o FFmpeg no GitHub Actions (gratuito). A configuração `renderer = shotstack` e os campos `SHOTSTACK_API_KEY`/`SHOTSTACK_ENV` estão reservados, mas **o adaptador Shotstack ainda não foi implementado** — se precisar dele, é o próximo passo natural (o plano de cenas em `core/render.ts` já é independente do renderizador).
