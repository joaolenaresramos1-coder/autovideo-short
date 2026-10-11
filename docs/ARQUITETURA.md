# Arquitetura

## Componentes

| Componente | Onde roda | Responsabilidade |
|---|---|---|
| PWA (`web/`) | GitHub Pages | Interface. Lê dados com RLS e chama a função `api`. Não executa automação. |
| Banco (`supabase/migrations`) | Supabase Postgres | Obras, capítulos, memória, calendário, fila, checkpoints, vídeos, publicações, consumo, alertas. Regras de fila, retenção e cotas em funções SQL. |
| Agendador | pg_cron | `tick` a cada minuto, `cleanup` a cada 20 min, promoção da fila e alertas de armazenamento em SQL puro. |
| `tick` | Edge Function | Materializa o calendário (48 h), monitora fontes, executa etapas curtas e inicia publicações. |
| `cleanup` | Edge Function | Exclui arquivos vencidos, confirma no catálogo do Storage, registra e alerta. |
| `api` / `oauth` | Edge Functions | Ações do usuário validadas no servidor; fluxo OAuth com `state` de uso único e PKCE (Google). |
| Worker (`worker/`) | GitHub Actions | Obtém material, recorta páginas, renderiza com FFmpeg e valida com ffprobe. |
| Storage | Supabase (bucket privado `media`) | Somente arquivos temporários; acesso por URL assinada de curta duração. |

## Máquina de estados

`scheduled → queued → discovering → fetching → analyzing → scripting → audio_generating → rendering → validating → ready_to_publish → publishing → published`, além de `retry_wait`, `failed` e `cancelled`.

- A tabela `job_transitions` espelha `core/states.ts`; um teste falha se divergirem.
- Cada etapa grava seu resultado em `job_steps` (checkpoint). Retentativas e reprocessamento manual retomam do estado salvo em `resume_state`, sem refazer etapas concluídas (testado: falha no render não repete roteiro nem narração).
- `claim_jobs` usa `FOR UPDATE SKIP LOCKED` e lease; dois executores nunca pegam a mesma tarefa.
- Erros: `retryable` → backoff exponencial com jitter até `max_attempts`; `config`/`permanent` → `failed` + alerta; `quota` → a conta é pausada e a tarefa fica parada no mesmo estado; `waiting` (sem capítulo) → espera sem consumir tentativas.

| Etapa | Executor | Observação |
|---|---|---|
| discovering | Edge | escolhe o próximo capítulo; nunca inventa conteúdo quando não há capítulo novo |
| fetching | Worker | páginas do link ou material enviado; recorte de tiras longas; descarta painéis em branco |
| analyzing | Edge | Gemini com imagens, em lotes de 8 com checkpoint por lote |
| scripting | Edge | roteiro + validação determinística (tamanho, cópia de diálogos) + revisão de coerência pelo Gemini; atualiza a memória |
| audio_generating | Edge | TTS; a duração real do áudio define o vídeo (ajuste de ±8 %, cartão final curto ou reescrita única) |
| rendering / validating | Worker | FFmpeg + ffprobe + decodificação completa |
| publishing | Edge | YouTube retomável / TikTok Direct Post; só “publicado” com confirmação da plataforma |

## Retenção

Calculada no banco (`compute_video_expiry`, `register_object`, `register_download` e o gatilho `jobs_retention`):

- vídeo: 24 h após o primeiro download registrado, limitado a 48 h após a renderização; 48 h sem download;
- áudio, imagens e páginas: 1 h após a validação do vídeo (configurável); mantidos enquanto a tarefa estiver em recuperação;
- arquivos incompletos e de tarefas com falha: 12 h (configurável);
- logs: 30 dias (configurável); roteiros, resumos, metadados e publicações: preservados.

A limpeza nunca apaga arquivos de uma tarefa em execução, confirma a exclusão no catálogo do Storage, faz backoff em falhas e alerta após 3 falhas. Executá-la de novo não altera nada.

## Segurança

- RLS em todas as tabelas; tabelas de segredos sem políticas (só o service role).
- Gatilhos impedem o usuário de alterar colunas controladas pelo servidor (pausa por limite, dono, último capítulo).
- Funções de serviço com `EXECUTE` revogado de `anon`/`authenticated` (o Supabase concede por padrão — coberto por teste).
- Chave Gemini e tokens OAuth cifrados com AES-256-GCM, vinculados ao dono (AAD); a chave de cifra só existe no servidor.
- Logs passam por `redact()` (chaves, bearer tokens, refresh tokens).
- Funções acionadas pelo cron exigem `x-cron-secret` comparado em tempo constante.
