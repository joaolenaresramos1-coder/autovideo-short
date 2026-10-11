// Prompts and JSON schemas for Gemini. Narration is always pt-BR, original,
// and grounded only on the analysed material + narrative memory.

import type { SummaryFormat, WorkType } from "./types.ts";

export const ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    panels: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          scene: { type: "string", description: "O que acontece visualmente, em português" },
          characters: { type: "array", items: { type: "string" } },
          dialogues: {
            type: "array",
            items: {
              type: "object",
              properties: {
                speaker: { type: "string" },
                text: { type: "string", description: "Texto lido no balão, no idioma original" },
                meaning: { type: "string", description: "Sentido da fala parafraseado em português" },
              },
              required: ["speaker", "text", "meaning"],
            },
          },
          usable: { type: "boolean", description: "false para painéis em branco, créditos, avisos ou anúncios" },
        },
        required: ["id", "scene", "dialogues", "usable"],
      },
    },
    events: {
      type: "array",
      items: {
        type: "object",
        properties: {
          description: { type: "string" },
          certainty: { type: "string", enum: ["confirmed", "interpretation"] },
          panels: { type: "array", items: { type: "string" } },
        },
        required: ["description", "certainty", "panels"],
      },
    },
    batch_summary: { type: "string" },
  },
  required: ["panels", "events", "batch_summary"],
} as const;

export const SCRIPT_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    description: { type: "string" },
    hashtags: { type: "array", items: { type: "string" } },
    hook: { type: "string" },
    segments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          panels: { type: "array", items: { type: "string" } },
          emphasis: { type: "array", items: { type: "string" } },
        },
        required: ["text", "panels"],
      },
    },
    key_points: {
      type: "object",
      properties: {
        conflicts: { type: "array", items: { type: "string" } },
        revelations: { type: "array", items: { type: "string" } },
        consequences: { type: "array", items: { type: "string" } },
      },
    },
    chapter_summary: { type: "string" },
    memory_updates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["character", "relationship", "power", "event", "continuity", "location", "item", "theme"] },
          name: { type: "string" },
          content: { type: "string" },
          certainty: { type: "string", enum: ["confirmed", "interpretation", "theory"] },
          supersedes: { type: "boolean" },
        },
        required: ["kind", "name", "content", "certainty"],
      },
    },
  },
  required: ["title", "description", "hashtags", "hook", "segments", "chapter_summary", "memory_updates"],
} as const;

export const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    consistent: { type: "boolean" },
    issues: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: { type: "string", enum: ["high", "low"] },
          problem: { type: "string" },
          fix: { type: "string" },
        },
        required: ["severity", "problem"],
      },
    },
  },
  required: ["consistent", "issues"],
} as const;

const TYPE_PT: Record<WorkType, string> = { manga: "mangá", manhua: "manhua", manhwa: "manhwa", anime: "anime" };

export function analysisPrompt(opts: {
  workTitle: string;
  workType: WorkType;
  chapterLabel: string;
  memory: string;
  previousSummary: string;
  panelIds: string[];
}): string {
  return [
    `Você é um analista de narrativa. Analise as imagens a seguir do ${TYPE_PT[opts.workType]} "${opts.workTitle}", ${opts.chapterLabel}.`,
    `As imagens estão na ordem de leitura e cada uma é precedida do seu identificador (${opts.panelIds.join(", ")}).`,
    "Para cada painel: descreva o que acontece, quem aparece, transcreva os balões de fala e explique o sentido de cada fala em português.",
    "Marque usable=false para imagens sem conteúdo narrativo (créditos, avisos, páginas em branco, anúncios).",
    "Liste os acontecimentos. Use certainty=confirmed apenas para o que está explícito nas imagens; use interpretation para deduções.",
    "Não invente nada que não esteja nas imagens. Se algo estiver ilegível, diga que está ilegível.",
    "",
    "Memória narrativa da obra (contexto):",
    opts.memory,
    "",
    "Resumo do trecho anterior deste capítulo:",
    opts.previousSummary || "(início do capítulo)",
  ].join("\n");
}

export function textAnalysisPrompt(opts: { workTitle: string; workType: WorkType; chapterLabel: string; memory: string }): string {
  return [
    `Analise o material autorizado a seguir (roteiro, legendas ou texto) de "${opts.workTitle}" (${TYPE_PT[opts.workType]}), ${opts.chapterLabel}.`,
    "Não há imagens: devolva panels como lista vazia. Liste os acontecimentos em ordem, marcando confirmed apenas o que está explícito no texto.",
    "Não invente cenas. Memória da obra:",
    opts.memory,
  ].join("\n");
}

const FORMAT_PT: Record<SummaryFormat, string> = {
  chapter: "resumo de um capítulo/episódio",
  arc: "resumo de um arco narrativo",
  full_work: "resumo da obra completa até o ponto conhecido",
  recap: "recapitulação baseada apenas na memória registrada (sem capítulo novo)",
};

export function scriptPrompt(opts: {
  workTitle: string;
  workType: WorkType;
  format: SummaryFormat;
  chapterLabel: string;
  targetSeconds: number;
  targetWords: number;
  memory: string;
  analysis: string;
  panelIds: string[];
  feedback?: string[];
}): string {
  return [
    `Escreva o roteiro de narração para um vídeo vertical curto (${FORMAT_PT[opts.format]}) sobre "${opts.workTitle}" (${TYPE_PT[opts.workType]}), ${opts.chapterLabel}.`,
    `Duração desejada: ${opts.targetSeconds} segundos, cerca de ${opts.targetWords} palavras no total (português brasileiro, narração falada).`,
    "",
    "Regras obrigatórias:",
    "1. Use somente acontecimentos presentes na análise e na memória. Nunca invente cenas, falas ou resultados.",
    "2. Diferencie fatos de interpretações: quando algo for dedução ou teoria, diga isso na narração (\"ao que tudo indica\", \"talvez\").",
    "3. Texto original: não copie os diálogos; parafraseie o sentido com suas palavras.",
    "4. Comece com um gancho forte de uma frase. Ritmo rápido, frases curtas, tom envolvente de canal de resumos.",
    "5. Divida em 10 a 24 trechos; cada trecho tem 1 a 2 frases e cita, em ordem, os identificadores das imagens que o ilustram.",
    `   Identificadores disponíveis: ${opts.panelIds.length ? opts.panelIds.join(", ") : "(nenhum — deixe panels vazio)"}.`,
    "6. Em cada trecho escolha até 2 palavras de destaque (emphasis) que aparecerão coloridas na legenda.",
    "7. Título com no máximo 90 caracteres, sem prometer o que o vídeo não mostra. Descrição curta com aviso de que é um resumo. 3 a 6 hashtags.",
    "8. Em memory_updates registre personagens, relações, poderes, acontecimentos e pontos de continuidade novos ou alterados, com a certeza correta (confirmed, interpretation ou theory).",
    "9. Preencha key_points com conflitos, revelações e consequências do trecho.",
    ...(opts.feedback?.length ? ["", "Corrija estes problemas da versão anterior:", ...opts.feedback.map((f) => `- ${f}`)] : []),
    "",
    "Memória narrativa:",
    opts.memory,
    "",
    "Análise do material:",
    opts.analysis,
  ].join("\n");
}

export function reviewPrompt(opts: { script: string; analysis: string; memory: string }): string {
  return [
    "Revise o roteiro abaixo comparando com a análise do material e a memória narrativa.",
    "Aponte com severity=high: acontecimentos inventados, contradições com a memória, personagens trocados, teorias apresentadas como fatos.",
    "Aponte com severity=low: problemas de clareza ou ritmo. Responda consistent=true se não houver problemas high.",
    "",
    "ROTEIRO:",
    opts.script,
    "",
    "ANÁLISE:",
    opts.analysis,
    "",
    "MEMÓRIA:",
    opts.memory,
  ].join("\n");
}

export function illustrationPrompt(opts: { workTitle: string; segmentText: string }): string {
  return [
    "Crie uma ilustração ORIGINAL, vertical 9:16, estilo ilustração digital de webtoon, cores vivas e iluminação dramática.",
    `Cena (resumo de "${opts.workTitle}"): ${opts.segmentText}`,
    "Não reproduza personagens, logotipos ou arte de terceiros; crie personagens genéricos inspirados apenas na descrição. Sem texto na imagem.",
  ].join("\n");
}
