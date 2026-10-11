import type { JobState } from "./states.ts";

export type Platform = "youtube" | "tiktok";
export type SummaryFormat = "chapter" | "arc" | "full_work" | "recap";
export type WorkType = "manga" | "manhua" | "manhwa" | "anime";
export type Certainty = "confirmed" | "interpretation" | "theory";
export type MemoryKind =
  | "character"
  | "relationship"
  | "power"
  | "event"
  | "continuity"
  | "location"
  | "item"
  | "theme";

export interface Work {
  id: string;
  user_id: string;
  title: string;
  type: WorkType;
  url: string | null;
  source: "manual" | "upload" | "mangadex" | "rss" | "anilist";
  source_ref: string | null;
  language: string;
  monitor_interval_minutes: number;
  summary_format: SummaryFormat;
  target_platforms: Platform[];
  visual_mode: "source_panels" | "uploaded" | "ai_illustrations";
  last_processed_chapter: string | null;
  status: "active" | "paused" | "pending_config" | "error";
  status_reason: string | null;
  authorization_status: "unknown" | "metadata_only" | "authorized" | "denied";
  authorization_notes: string | null;
}

export interface Chapter {
  id: string;
  user_id: string;
  work_id: string;
  chapter_key: string;
  number: number | null;
  title: string | null;
  source_chapter_id: string | null;
  source_url: string | null;
  status: "new" | "processing" | "processed" | "skipped";
  summary: string | null;
  analysis?: unknown;
}

export interface Schedule {
  id: string;
  user_id: string;
  work_id: string;
  days_of_week: number[];
  time_of_day: string; // "HH:MM" or "HH:MM:SS"
  timezone: string;
  videos_per_slot: number;
  target_duration_seconds: number;
  summary_format: SummaryFormat;
  platforms: Platform[];
  priority: number;
  cost_limit_usd: number;
  no_chapter_policy: "wait" | "replace" | "skip";
  replacement_format: SummaryFormat;
  lead_minutes: number;
  starts_on: string | null;
  ends_on: string | null;
  active: boolean;
  materialized_until: string | null;
}

export interface Job {
  id: string;
  user_id: string;
  work_id: string;
  schedule_id: string | null;
  chapter_id: string | null;
  state: JobState;
  resume_state: JobState | null;
  summary_format: SummaryFormat;
  target_duration_seconds: number;
  platforms: Platform[];
  priority: number;
  slot_at: string;
  run_at: string;
  dedupe_key: string;
  content_key: string | null;
  attempts: number;
  max_attempts: number;
  next_attempt_at: string | null;
  last_error: string | null;
  locked_by: string | null;
  locked_until: string | null;
  cost_limit_usd: number;
  cost_spent_usd: number;
}

export interface UserSettings {
  user_id: string;
  timezone: string;
  gemini_text_model: string;
  gemini_tts_model: string;
  gemini_image_model: string;
  gemini_voice: string;
  gemini_tier: "free" | "paid";
  renderer: "ffmpeg" | "shotstack";
  caption_style: CaptionStyle;
  background_music: boolean;
  daily_cost_limit_usd: number;
  monthly_cost_limit_usd: number;
  price_overrides: Record<string, Partial<ModelPrice>>;
  automation_paused: boolean;
  pause_reason: string | null;
  max_attempts: number;
  youtube_privacy: "private" | "unlisted" | "public";
  tiktok_privacy: string;
  ai_disclosure: boolean;
}

export interface CaptionStyle {
  font: string;
  color: string; // #RRGGBB
  accent: string; // #RRGGBB
  outline: number;
}

export interface ModelPrice {
  /** USD per 1M input tokens */
  input: number;
  /** USD per 1M output tokens (text or audio) */
  output: number;
  /** USD per generated image (image models) */
  image?: number;
}

/** A panel/image available to illustrate the narration. */
export interface Panel {
  id: string; // stable id, e.g. "p03-2"
  path: string; // storage path
  width: number;
  height: number;
  page?: number;
}

export interface ScriptSegment {
  /** Narration text in pt-BR. */
  text: string;
  /** Panel ids illustrating this segment, in order. */
  panels: string[];
  /** Words to highlight in the captions. */
  emphasis?: string[];
}

export interface Script {
  title: string;
  description: string;
  hashtags: string[];
  hook: string;
  segments: ScriptSegment[];
}
