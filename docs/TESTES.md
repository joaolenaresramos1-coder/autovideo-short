# Testes

| Comando | O que cobre | Requisitos |
|---|---|---|
| `npm run test:unit` | máquina de estados, calendário/fusos, retenção, preços, WAV, criptografia, legendas, plano de cenas, roteiro, memória, validação, conectores, clientes Gemini/YouTube/TikTok/OAuth | Node 22 |
| `npm run test:integration` | render real com FFmpeg (legendas, movimento, áudio) e validação | FFmpeg |
| `npm run test:sql` | migrações, RLS e isolamento, fila (SKIP LOCKED, lease, backoff, checkpoint), duplicatas, retenção, limpeza, alertas, limites de custo, e o **teste ponta a ponta** | PostgreSQL 16 + FFmpeg |
| `npm run check:edge` | tipagem das Edge Functions no Deno | Deno 2 |

## Teste ponta a ponta (`tests/sql/pipeline_e2e.test.ts`)

Executa toda a produção usando apenas código de servidor — nenhum navegador participa (critério “funcionar com o navegador fechado”):

1. o agendador cria as tarefas do calendário sem duplicar;
2. o worker recorta as páginas e descarta a página em branco;
3. análise, roteiro (com memória narrativa) e narração;
4. render FFmpeg real 1080×1920 com áudio e legendas, validado;
5. publicação no YouTube e no TikTok só após confirmação, sem envio duplicado;
6. link de download inicia a contagem de 24 h; outro usuário não acessa o arquivo;
7. limpeza exclui os arquivos e mantém vídeo, roteiro e publicações no histórico; segunda execução não muda nada;
8. limite de custo pausa a conta sem perder a tarefa, e ela continua após reativação;
9. falha no render é retomada sem repetir roteiro nem narração;
10. sem capítulo novo, a tarefa aguarda e nenhuma chamada de roteiro é feita.

Gemini, YouTube e TikTok são substituídos por servidores falsos (`tests/support/fakes.ts`) que seguem o formato real das APIs; PostgreSQL e FFmpeg são reais. As integrações reais exigem as suas credenciais (ver IMPLANTACAO.md).

## PostgreSQL local

Os testes SQL criam um banco temporário por arquivo e emulam os esquemas `auth` e `storage` do Supabase (`tests/sql/bootstrap.sql`). Variáveis: `PGHOST` (padrão `/tmp`), `PGPORT` (padrão `54329`), `PGUSER`, `PGPASSWORD`. No CI é usado o serviço `postgres:16`.
