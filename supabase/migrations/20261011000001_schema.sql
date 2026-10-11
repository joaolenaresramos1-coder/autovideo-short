-- AutoVideo Short — core schema.
-- Every user-owned table carries user_id and is protected by Row Level Security.
-- Tables that hold secrets have RLS enabled and NO policies: only the
-- service role (Edge Functions / worker) can read them.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- enums
create type public.work_type as enum ('manga', 'manhua', 'manhwa', 'anime');
create type public.work_status as enum ('active', 'paused', 'pending_config', 'error');
create type public.authorization_status as enum ('unknown', 'metadata_only', 'authorized', 'denied');
create type public.visual_mode as enum ('source_panels', 'uploaded', 'ai_illustrations');
create type public.summary_format as enum ('chapter', 'arc', 'full_work', 'recap');
create type public.platform as enum ('youtube', 'tiktok');
create type public.job_state as enum (
  'scheduled', 'queued', 'discovering', 'fetching', 'analyzing', 'scripting',
  'audio_generating', 'rendering', 'validating', 'ready_to_publish',
  'publishing', 'published', 'retry_wait', 'failed', 'cancelled'
);
create type public.publication_status as enum (
  'pending', 'uploading', 'processing', 'scheduled', 'published', 'failed', 'cancelled'
);
create type public.storage_kind as enum ('video', 'audio', 'image', 'page', 'upload', 'partial', 'other');
create type public.memory_kind as enum ('character', 'relationship', 'power', 'event', 'continuity', 'location', 'item', 'theme');
create type public.certainty as enum ('confirmed', 'interpretation', 'theory');
create type public.no_chapter_policy as enum ('wait', 'replace', 'skip');

-- ---------------------------------------------------------------- helpers
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ---------------------------------------------------------------- settings
create table public.user_settings (
  user_id uuid primary key references auth.users (id) on delete cascade,
  timezone text not null default 'America/Sao_Paulo',
  -- Gemini
  gemini_text_model text not null default 'gemini-3.8-flash',
  gemini_tts_model text not null default 'gemini-3.8-flash-lite-tts',
  gemini_image_model text not null default 'gemini-nano-banana-2.1',
  gemini_voice text not null default 'Kore',
  gemini_tier text not null default 'free' check (gemini_tier in ('free', 'paid')),
  -- rendering
  renderer text not null default 'ffmpeg' check (renderer in ('ffmpeg', 'shotstack')),
  caption_style jsonb not null default '{"font":"Anton","color":"#FFE600","accent":"#7CFF4F","outline":8}'::jsonb,
  background_music boolean not null default false,
  -- cost & quota limits (USD estimates)
  daily_cost_limit_usd numeric(10, 4) not null default 1.00 check (daily_cost_limit_usd >= 0),
  monthly_cost_limit_usd numeric(10, 4) not null default 10.00 check (monthly_cost_limit_usd >= 0),
  daily_ai_call_limit integer not null default 300 check (daily_ai_call_limit >= 0),
  monthly_render_limit integer not null default 120 check (monthly_render_limit >= 0),
  price_overrides jsonb not null default '{}'::jsonb,
  automation_paused boolean not null default false,
  pause_reason text,
  paused_at timestamptz,
  -- storage retention (hours/days); deadlines are always computed by the database
  storage_quota_bytes bigint not null default 1073741824 check (storage_quota_bytes > 0),
  video_after_download_hours integer not null default 24 check (video_after_download_hours between 1 and 48),
  video_max_retention_hours integer not null default 48 check (video_max_retention_hours between 1 and 168),
  video_no_download_hours integer not null default 48 check (video_no_download_hours between 1 and 168),
  intermediate_grace_hours integer not null default 1 check (intermediate_grace_hours between 0 and 72),
  incomplete_retention_hours integer not null default 12 check (incomplete_retention_hours between 1 and 168),
  log_retention_days integer not null default 30 check (log_retention_days between 1 and 365),
  max_attempts integer not null default 5 check (max_attempts between 1 and 20),
  -- publishing defaults
  youtube_privacy text not null default 'private' check (youtube_privacy in ('private', 'unlisted', 'public')),
  tiktok_privacy text not null default 'SELF_ONLY',
  ai_disclosure boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger user_settings_touch before update on public.user_settings
  for each row execute function public.touch_updated_at();

-- Create settings automatically for every new account.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.user_settings (user_id) values (new.id) on conflict do nothing;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------- works
create table public.works (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 200),
  type public.work_type not null,
  url text check (url is null or url ~* '^https?://'),
  source text not null default 'manual'
    check (source in ('manual', 'upload', 'mangadex', 'rss', 'anilist')),
  source_ref text,
  language text not null default 'pt-BR' check (char_length(language) between 2 and 10),
  monitor_interval_minutes integer not null default 360 check (monitor_interval_minutes >= 30),
  summary_format public.summary_format not null default 'chapter',
  target_platforms public.platform[] not null default '{}',
  visual_mode public.visual_mode not null default 'source_panels',
  last_processed_chapter text,
  last_checked_at timestamptz,
  next_check_at timestamptz not null default now(),
  status public.work_status not null default 'pending_config',
  status_reason text,
  authorization_status public.authorization_status not null default 'unknown',
  authorization_notes text check (authorization_notes is null or char_length(authorization_notes) <= 2000),
  authorization_confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index works_user_idx on public.works (user_id);
create index works_check_idx on public.works (next_check_at) where status = 'active';
create trigger works_touch before update on public.works
  for each row execute function public.touch_updated_at();

create table public.chapters (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  work_id uuid not null references public.works (id) on delete cascade,
  chapter_key text not null,
  number numeric,
  title text,
  source_chapter_id text,
  source_url text,
  source_published_at timestamptz,
  page_count integer,
  status text not null default 'new' check (status in ('new', 'processing', 'processed', 'skipped')),
  summary text,
  analysis jsonb,
  discovered_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (work_id, chapter_key)
);
create index chapters_work_idx on public.chapters (work_id, number);

create table public.memory_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  work_id uuid not null references public.works (id) on delete cascade,
  kind public.memory_kind not null,
  name text not null check (char_length(name) between 1 and 200),
  content text not null check (char_length(content) <= 4000),
  certainty public.certainty not null default 'confirmed',
  first_chapter_key text,
  updated_chapter_key text,
  superseded boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (work_id, kind, name)
);
create index memory_work_idx on public.memory_entries (work_id, kind);
create trigger memory_touch before update on public.memory_entries
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------- calendar
create table public.schedules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  work_id uuid not null references public.works (id) on delete cascade,
  days_of_week smallint[] not null check (
    cardinality(days_of_week) between 1 and 7 and days_of_week <@ array[0,1,2,3,4,5,6]::smallint[]
  ),
  time_of_day time not null,
  timezone text not null default 'America/Sao_Paulo',
  videos_per_slot smallint not null default 1 check (videos_per_slot between 1 and 5),
  target_duration_seconds smallint not null default 75 check (target_duration_seconds between 60 and 180),
  summary_format public.summary_format not null default 'chapter',
  platforms public.platform[] not null default '{}',
  priority smallint not null default 5 check (priority between 1 and 10),
  cost_limit_usd numeric(10, 4) not null default 0.50 check (cost_limit_usd >= 0),
  no_chapter_policy public.no_chapter_policy not null default 'wait',
  replacement_format public.summary_format not null default 'recap',
  lead_minutes integer not null default 180 check (lead_minutes between 30 and 1440),
  starts_on date,
  ends_on date,
  active boolean not null default true,
  materialized_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_on is null or starts_on is null or ends_on >= starts_on)
);
create index schedules_user_idx on public.schedules (user_id);
create trigger schedules_touch before update on public.schedules
  for each row execute function public.touch_updated_at();

-- Reject unknown IANA time zones server-side.
create or replace function public.validate_timezone() returns trigger
language plpgsql as $$
begin
  if not exists (select 1 from pg_timezone_names where name = new.timezone) then
    raise exception 'Fuso horário inválido: %', new.timezone using errcode = '22023';
  end if;
  return new;
end $$;
create trigger schedules_tz before insert or update of timezone on public.schedules
  for each row execute function public.validate_timezone();
create trigger settings_tz before insert or update of timezone on public.user_settings
  for each row execute function public.validate_timezone();

-- ---------------------------------------------------------------- jobs
create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  work_id uuid not null references public.works (id) on delete cascade,
  schedule_id uuid references public.schedules (id) on delete set null,
  chapter_id uuid references public.chapters (id) on delete set null,
  state public.job_state not null default 'scheduled',
  resume_state public.job_state,
  summary_format public.summary_format not null default 'chapter',
  target_duration_seconds smallint not null default 75 check (target_duration_seconds between 60 and 180),
  platforms public.platform[] not null default '{}',
  priority smallint not null default 5,
  slot_at timestamptz not null,
  run_at timestamptz not null,
  -- Prevents two jobs for the same calendar slot.
  dedupe_key text not null unique,
  -- Prevents two videos about the same content (work+chapter+format).
  content_key text,
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  next_attempt_at timestamptz,
  waiting_reason text,
  last_error text,
  error_kind text,
  locked_by text,
  locked_until timestamptz,
  cost_limit_usd numeric(10, 4) not null default 0.50,
  cost_spent_usd numeric(12, 6) not null default 0,
  render_requested_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index jobs_content_unique on public.jobs (content_key)
  where content_key is not null and state <> 'cancelled';
create index jobs_claim_idx on public.jobs (state, run_at);
create index jobs_user_idx on public.jobs (user_id, created_at desc);
create trigger jobs_touch before update on public.jobs
  for each row execute function public.touch_updated_at();

create table public.job_transitions (
  from_state public.job_state not null,
  to_state public.job_state not null,
  primary key (from_state, to_state)
);

insert into public.job_transitions (from_state, to_state) values
  ('scheduled', 'queued'), ('scheduled', 'cancelled'),
  ('queued', 'discovering'), ('queued', 'cancelled'),
  ('discovering', 'fetching'), ('discovering', 'analyzing'), ('discovering', 'scripting'),
  ('discovering', 'retry_wait'), ('discovering', 'failed'), ('discovering', 'cancelled'),
  ('fetching', 'analyzing'), ('fetching', 'retry_wait'), ('fetching', 'failed'), ('fetching', 'cancelled'),
  ('analyzing', 'scripting'), ('analyzing', 'retry_wait'), ('analyzing', 'failed'), ('analyzing', 'cancelled'),
  ('scripting', 'audio_generating'), ('scripting', 'retry_wait'), ('scripting', 'failed'), ('scripting', 'cancelled'),
  ('audio_generating', 'rendering'), ('audio_generating', 'scripting'), ('audio_generating', 'retry_wait'),
  ('audio_generating', 'failed'), ('audio_generating', 'cancelled'),
  ('rendering', 'validating'), ('rendering', 'retry_wait'), ('rendering', 'failed'), ('rendering', 'cancelled'),
  ('validating', 'ready_to_publish'), ('validating', 'rendering'), ('validating', 'retry_wait'),
  ('validating', 'failed'), ('validating', 'cancelled'),
  ('ready_to_publish', 'publishing'), ('ready_to_publish', 'cancelled'),
  ('publishing', 'published'), ('publishing', 'retry_wait'), ('publishing', 'failed'), ('publishing', 'cancelled'),
  ('cancelled', 'queued');
-- retry_wait and failed resume into any work state (checkpoint recovery).
insert into public.job_transitions (from_state, to_state)
select f.s::public.job_state, t.s::public.job_state
from (values ('retry_wait'), ('failed')) f(s)
cross join (values ('queued'), ('discovering'), ('fetching'), ('analyzing'), ('scripting'),
  ('audio_generating'), ('rendering'), ('validating'), ('publishing'), ('cancelled')) t(s);
insert into public.job_transitions values ('retry_wait', 'failed');

-- Checkpoint of each step: the output survives retries so finished steps are never repeated.
create table public.job_steps (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  job_id uuid not null references public.jobs (id) on delete cascade,
  step text not null,
  status text not null default 'running' check (status in ('running', 'succeeded', 'failed')),
  attempt integer not null default 1,
  output jsonb,
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (job_id, step)
);

create table public.job_logs (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users (id) on delete cascade,
  job_id uuid references public.jobs (id) on delete cascade,
  level text not null default 'info' check (level in ('debug', 'info', 'warn', 'error')),
  event text not null,
  message text,
  data jsonb,
  created_at timestamptz not null default now()
);
create index job_logs_job_idx on public.job_logs (job_id, created_at);
create index job_logs_user_idx on public.job_logs (user_id, created_at desc);
create index job_logs_created_idx on public.job_logs (created_at);

-- ---------------------------------------------------------------- outputs (preserved history)
create table public.scripts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  job_id uuid not null unique references public.jobs (id) on delete cascade,
  work_id uuid not null references public.works (id) on delete cascade,
  chapter_id uuid references public.chapters (id) on delete set null,
  title text not null,
  description text,
  hashtags text[] not null default '{}',
  segments jsonb not null,
  full_text text not null,
  word_count integer not null,
  model text,
  validation jsonb,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger scripts_touch before update on public.scripts
  for each row execute function public.touch_updated_at();

create table public.storage_objects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  job_id uuid references public.jobs (id) on delete set null,
  bucket text not null default 'media',
  path text not null,
  kind public.storage_kind not null,
  size_bytes bigint not null default 0 check (size_bytes >= 0),
  content_type text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  expires_at timestamptz,
  first_download_at timestamptz,
  download_count integer not null default 0,
  hold_until timestamptz,
  deleted_at timestamptz,
  delete_attempts integer not null default 0,
  next_delete_attempt_at timestamptz,
  last_delete_error text,
  unique (bucket, path)
);
create index storage_objects_expiry_idx on public.storage_objects (expires_at) where deleted_at is null;
create index storage_objects_job_idx on public.storage_objects (job_id);
create index storage_objects_user_idx on public.storage_objects (user_id) where deleted_at is null;

create table public.narrations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  job_id uuid not null unique references public.jobs (id) on delete cascade,
  script_id uuid references public.scripts (id) on delete set null,
  model text not null,
  voice text not null,
  duration_seconds numeric(8, 3) not null,
  storage_object_id uuid references public.storage_objects (id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.videos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  job_id uuid not null unique references public.jobs (id) on delete cascade,
  work_id uuid not null references public.works (id) on delete cascade,
  title text not null,
  duration_seconds numeric(8, 3),
  width integer,
  height integer,
  size_bytes bigint,
  render_provider text not null default 'ffmpeg',
  render_ref text,
  validation jsonb,
  storage_object_id uuid references public.storage_objects (id) on delete set null,
  rendered_at timestamptz,
  validated_at timestamptz,
  first_download_at timestamptz,
  file_deleted_at timestamptz,
  created_at timestamptz not null default now()
);
create index videos_user_idx on public.videos (user_id, created_at desc);

create table public.download_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  storage_object_id uuid not null references public.storage_objects (id) on delete cascade,
  video_id uuid references public.videos (id) on delete set null,
  requested_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- integrations
create table public.integrations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null check (provider in ('youtube', 'tiktok', 'gemini', 'shotstack')),
  status text not null default 'connected' check (status in ('connected', 'expired', 'error', 'disconnected')),
  account_id text,
  account_name text,
  scopes text[] not null default '{}',
  token_expires_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, provider)
);
create trigger integrations_touch before update on public.integrations
  for each row execute function public.touch_updated_at();

-- Encrypted secrets (AES-GCM, key only in Edge Function secrets). No RLS policies on purpose.
create table public.secrets (
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  ciphertext text not null,
  iv text not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, name)
);

create table public.oauth_states (
  state text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null,
  code_verifier text,
  redirect_to text,
  expires_at timestamptz not null default now() + interval '15 minutes'
);

create table public.publications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  job_id uuid not null references public.jobs (id) on delete cascade,
  video_id uuid references public.videos (id) on delete set null,
  platform public.platform not null,
  status public.publication_status not null default 'pending',
  title text,
  description text,
  privacy text,
  publish_at timestamptz,
  remote_id text,
  remote_url text,
  upload_session_url text,
  attempts integer not null default 0,
  next_attempt_at timestamptz,
  last_error text,
  response jsonb,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (job_id, platform)
);
create unique index publications_remote_unique on public.publications (platform, remote_id) where remote_id is not null;
create trigger publications_touch before update on public.publications
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------- usage, alerts, cleanup
create table public.usage_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  job_id uuid references public.jobs (id) on delete set null,
  provider text not null,
  kind text not null,
  model text,
  input_tokens integer,
  output_tokens integer,
  units numeric,
  unit_type text,
  cost_usd numeric(12, 6) not null default 0,
  failed boolean not null default false,
  created_at timestamptz not null default now()
);
create index usage_user_time_idx on public.usage_events (user_id, created_at);

create table public.alerts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users (id) on delete cascade,
  kind text not null,
  level text not null default 'warning' check (level in ('info', 'warning', 'critical')),
  message text not null,
  data jsonb,
  dedupe_key text not null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create unique index alerts_open_unique on public.alerts (coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid), dedupe_key)
  where resolved_at is null;

create table public.cleanup_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  scanned integer not null default 0,
  deleted integer not null default 0,
  skipped integer not null default 0,
  failed integer not null default 0,
  bytes_freed bigint not null default 0,
  logs_purged integer not null default 0,
  notes jsonb
);
