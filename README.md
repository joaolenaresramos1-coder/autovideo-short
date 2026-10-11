# AutoVideo Short

Plataforma que produz **automaticamente** vídeos verticais (9:16, 1080×1920, 1 a 3 minutos) com resumos de capítulos, arcos e obras de mangás, manhuas, manhwas e animes, e os publica no YouTube e no TikTok.

O estilo de edição segue os vídeos de referência: painéis em tela cheia trocando a cada 1–3 s com zoom/deslocamento suave, **uma palavra por vez** no centro da tela com contorno grosso e palavras de destaque coloridas, narração em português e trilha opcional.

**Tudo roda na nuvem.** Depois de configurar, você pode fechar o navegador e desligar o notebook: o agendamento fica no banco (pg_cron), as etapas curtas rodam em Edge Functions do Supabase e a renderização com FFmpeg roda no GitHub Actions.

```
Celular / PWA ──► Supabase (Auth, Postgres+RLS, Storage, pg_cron)
                      │  tick a cada minuto
                      ▼
               Edge Functions ──► Gemini (análise, roteiro, narração)
                      │                YouTube / TikTok (publicação)
                      │ repository_dispatch
                      ▼
               GitHub Actions (worker FFmpeg: páginas → vídeo → validação)
```

## O que está pronto

| Área | Situação |
|---|---|
| Banco, RLS, autenticação, fila com máquina de estados, checkpoints, backoff | ✅ testado (PostgreSQL real) |
| Calendário mensal/semanal/diário, fusos IANA, prevenção de duplicatas | ✅ testado |
| Conectores: MangaDex (API oficial), RSS/Atom, AniList, envio manual | ✅ testado com respostas simuladas |
| Gemini: análise com imagens, roteiro original, revisão de coerência, memória narrativa, TTS | ✅ testado com servidor simulado no formato real da API |
| Render FFmpeg 1080×1920 com legendas palavra por palavra + validação | ✅ testado com FFmpeg real |
| Retenção (24 h após download, máx. 48 h) e limpeza idempotente | ✅ testado |
| Limites de custo/cota com pausa e reativação manual | ✅ testado |
| YouTube (upload retomável, `publishAt`) e TikTok (Direct Post) | ✅ testado com servidores simulados |
| PWA com 13 telas | ✅ build e verificação visual em 390 px |

**Pendente de configuração (não há como testar sem as suas credenciais):** projeto Supabase, chave Gemini, app OAuth do Google/YouTube e app do TikTok. Veja [docs/IMPLANTACAO.md](docs/IMPLANTACAO.md). Nenhuma integração é simulada em produção: sem credencial, a tela mostra “configuração pendente”.

## Limites honestos

- **Links de qualquer site:** cole o link da obra (os capítulos são encontrados na página) ou o link de um capítulo em Gerar vídeo. Se o site só mostrar as imagens por JavaScript ou exigir login, envie as imagens. Você é responsável pelo material que usa e publica.
- **TikTok:** enquanto o seu app não passar pela auditoria do TikTok, os vídeos só podem ser publicados como privados (`SELF_ONLY`). A API do TikTok não agenda; o envio acontece no horário.
- **YouTube:** a API tem cota diária própria para uploads.
- **Supabase Free:** 1 GB de armazenamento e 50 MB por arquivo — o render limita o bitrate para caber; Edge Functions têm 150 s por execução, por isso cada vídeo é dividido em etapas curtas e recuperáveis.
- **GitHub Actions:** gratuito sem limite de minutos em repositório **público** (2.000 min/mês em privado). O cron do GitHub pode atrasar alguns minutos; o Supabase dispara o worker diretamente quando há trabalho.

## Estrutura

```
supabase/migrations/        esquema, RLS, fila, retenção, cotas, pg_cron
supabase/functions/_shared/ núcleo (TypeScript puro), adaptadores, conectores, pipeline
supabase/functions/{tick,cleanup,api,oauth}/  Edge Functions (Deno)
worker/                     worker FFmpeg (Node 22) para GitHub Actions
web/                        PWA (React + Vite), publicada no GitHub Pages
tests/                      unitários, render real, SQL e ponta a ponta
docs/                       implantação, arquitetura, testes
```

## Comandos

```bash
npm ci
npm test            # unitários + render com FFmpeg
npm run test:sql    # migrações, RLS, fila, retenção e ponta a ponta (precisa de PostgreSQL, ver docs/TESTES.md)
npm run typecheck && npm run check:edge
npm run web:dev     # interface em http://localhost:5173
```
