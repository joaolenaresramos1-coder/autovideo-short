-- Groq as an alternative text AI next to Gemini, tried in the order the user
-- picks when one is busy or out of free quota.
alter table public.integrations drop constraint if exists integrations_provider_check;
alter table public.integrations add constraint integrations_provider_check
  check (provider in ('youtube', 'tiktok', 'gemini', 'shotstack', 'groq'));

alter table public.user_settings
  add column if not exists text_provider_order text[] not null default '{gemini,groq}',
  add column if not exists groq_text_model text;
