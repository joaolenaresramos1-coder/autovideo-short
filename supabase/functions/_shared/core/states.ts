// Job state machine shared by the Edge Functions (Deno), the render worker
// (Node) and the web app. The SQL table `job_transitions` mirrors
// TRANSITIONS; tests/sql/states.test.ts fails if they diverge.

export const JOB_STATES = [
  "scheduled",
  "queued",
  "discovering",
  "fetching",
  "analyzing",
  "scripting",
  "audio_generating",
  "rendering",
  "validating",
  "ready_to_publish",
  "publishing",
  "published",
  "retry_wait",
  "failed",
  "cancelled",
] as const;

export type JobState = (typeof JOB_STATES)[number];

/** States in which a step is actively executed by someone. */
export const WORK_STATES = [
  "discovering",
  "fetching",
  "analyzing",
  "scripting",
  "audio_generating",
  "rendering",
  "validating",
  "publishing",
] as const satisfies readonly JobState[];

export type WorkState = (typeof WORK_STATES)[number];

export type Executor = "edge" | "worker";

/**
 * Who runs each step. Edge Functions only run short, network-bound calls;
 * anything that touches FFmpeg or large binaries runs on the worker.
 */
export const STEP_EXECUTOR: Record<WorkState, Executor> = {
  discovering: "edge",
  fetching: "worker",
  analyzing: "edge",
  scripting: "edge",
  audio_generating: "edge",
  rendering: "worker",
  validating: "worker",
  publishing: "edge",
};

/** Steps that may spend money (AI calls, paid renders). */
export const COST_STEPS: readonly WorkState[] = [
  "analyzing",
  "scripting",
  "audio_generating",
  "rendering",
];

export const TERMINAL_STATES: readonly JobState[] = ["published", "cancelled"];

const RESUMABLE: JobState[] = [...WORK_STATES, "queued"];

export const TRANSITIONS: Record<JobState, readonly JobState[]> = {
  scheduled: ["queued", "cancelled"],
  queued: ["discovering", "cancelled"],
  discovering: ["fetching", "analyzing", "scripting", "retry_wait", "failed", "cancelled"],
  fetching: ["analyzing", "retry_wait", "failed", "cancelled"],
  analyzing: ["scripting", "retry_wait", "failed", "cancelled"],
  scripting: ["audio_generating", "retry_wait", "failed", "cancelled"],
  // audio -> scripting: the narration came out far from the target duration
  // and the script must be rewritten once.
  audio_generating: ["rendering", "scripting", "retry_wait", "failed", "cancelled"],
  rendering: ["validating", "retry_wait", "failed", "cancelled"],
  // validating -> rendering: the output failed validation, re-render only.
  validating: ["ready_to_publish", "rendering", "retry_wait", "failed", "cancelled"],
  ready_to_publish: ["publishing", "cancelled"],
  publishing: ["published", "retry_wait", "failed", "cancelled"],
  published: [],
  retry_wait: [...RESUMABLE, "failed", "cancelled"],
  // Manual reprocessing resumes from the stored checkpoint.
  failed: [...RESUMABLE, "cancelled"],
  cancelled: ["queued"],
};

export function canTransition(from: JobState, to: JobState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: JobState, to: JobState): void {
  if (!canTransition(from, to)) {
    throw new Error(`Transição inválida: ${from} -> ${to}`);
  }
}

export function isWorkState(s: JobState): s is WorkState {
  return (WORK_STATES as readonly string[]).includes(s);
}

/** Order of the production pipeline, used to show progress. */
export const PIPELINE_ORDER: readonly JobState[] = [
  "scheduled",
  "queued",
  "discovering",
  "fetching",
  "analyzing",
  "scripting",
  "audio_generating",
  "rendering",
  "validating",
  "ready_to_publish",
  "publishing",
  "published",
];

export function progressOf(state: JobState, resumeState?: JobState | null): number {
  const s = state === "retry_wait" || state === "failed" ? resumeState ?? state : state;
  const i = PIPELINE_ORDER.indexOf(s);
  if (i < 0) return 0;
  return Math.round((i / (PIPELINE_ORDER.length - 1)) * 100);
}

export const STATE_LABELS_PT: Record<JobState, string> = {
  scheduled: "Agendada",
  queued: "Na fila",
  discovering: "Procurando capítulo",
  fetching: "Obtendo material",
  analyzing: "Analisando",
  scripting: "Escrevendo roteiro",
  audio_generating: "Gerando narração",
  rendering: "Renderizando",
  validating: "Validando vídeo",
  ready_to_publish: "Pronto",
  publishing: "Publicando",
  published: "Publicado",
  retry_wait: "Aguardando nova tentativa",
  failed: "Falhou",
  cancelled: "Cancelada",
};
