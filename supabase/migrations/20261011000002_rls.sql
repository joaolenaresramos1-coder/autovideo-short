-- Row Level Security: each account only sees its own rows.

alter table public.user_settings enable row level security;
alter table public.works enable row level security;
alter table public.chapters enable row level security;
alter table public.memory_entries enable row level security;
alter table public.schedules enable row level security;
alter table public.jobs enable row level security;
alter table public.job_transitions enable row level security;
alter table public.job_steps enable row level security;
alter table public.job_logs enable row level security;
alter table public.scripts enable row level security;
alter table public.storage_objects enable row level security;
alter table public.narrations enable row level security;
alter table public.videos enable row level security;
alter table public.download_events enable row level security;
alter table public.integrations enable row level security;
alter table public.secrets enable row level security;        -- no policies: service role only
alter table public.oauth_states enable row level security;   -- no policies: service role only
alter table public.publications enable row level security;
alter table public.usage_events enable row level security;
alter table public.alerts enable row level security;
alter table public.cleanup_runs enable row level security;

-- Full CRUD on configuration owned by the user.
create policy settings_own on public.user_settings for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy works_own on public.works for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy schedules_own on public.schedules for all to authenticated
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and exists (select 1 from public.works w where w.id = work_id and w.user_id = (select auth.uid()))
  );
create policy memory_own on public.memory_entries for all to authenticated
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and exists (select 1 from public.works w where w.id = work_id and w.user_id = (select auth.uid()))
  );

-- Chapters: users may read and mark chapters as skipped; the server creates them.
create policy chapters_select on public.chapters for select to authenticated
  using (user_id = (select auth.uid()));
create policy chapters_update on public.chapters for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Read-only for users; written by Edge Functions / worker with the service role.
create policy jobs_select on public.jobs for select to authenticated using (user_id = (select auth.uid()));
create policy steps_select on public.job_steps for select to authenticated using (user_id = (select auth.uid()));
create policy logs_select on public.job_logs for select to authenticated using (user_id = (select auth.uid()));
create policy scripts_select on public.scripts for select to authenticated using (user_id = (select auth.uid()));
create policy objects_select on public.storage_objects for select to authenticated using (user_id = (select auth.uid()));
create policy narrations_select on public.narrations for select to authenticated using (user_id = (select auth.uid()));
create policy videos_select on public.videos for select to authenticated using (user_id = (select auth.uid()));
create policy downloads_select on public.download_events for select to authenticated using (user_id = (select auth.uid()));
create policy integrations_select on public.integrations for select to authenticated using (user_id = (select auth.uid()));
create policy publications_select on public.publications for select to authenticated using (user_id = (select auth.uid()));
create policy usage_select on public.usage_events for select to authenticated using (user_id = (select auth.uid()));
create policy alerts_select on public.alerts for select to authenticated using (user_id = (select auth.uid()) or user_id is null);
create policy alerts_resolve on public.alerts for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy transitions_read on public.job_transitions for select to authenticated using (true);
create policy cleanup_read on public.cleanup_runs for select to authenticated using (true);

-- Supabase grants table-wide privileges to `authenticated`, so column-level
-- REVOKE would have no effect. These triggers keep server-owned columns
-- unchanged when the change comes from a user session.
create or replace function public.is_user_session() returns boolean
language sql stable as $$
  select current_user in ('authenticated', 'anon')
$$;

create or replace function public.protect_settings_columns() returns trigger
language plpgsql as $$
begin
  if public.is_user_session() then
    new.user_id := old.user_id;
    -- Pausing is decided by the server; resuming goes through the API.
    new.automation_paused := old.automation_paused;
    new.pause_reason := old.pause_reason;
    new.paused_at := old.paused_at;
  end if;
  return new;
end $$;
create trigger user_settings_protect before update on public.user_settings
  for each row execute function public.protect_settings_columns();

create or replace function public.protect_owner_column() returns trigger
language plpgsql as $$
begin
  if public.is_user_session() then
    new.user_id := old.user_id;
  end if;
  return new;
end $$;
create trigger schedules_protect before update on public.schedules
  for each row execute function public.protect_owner_column();
create trigger memory_protect before update on public.memory_entries
  for each row execute function public.protect_owner_column();

create or replace function public.protect_chapter_columns() returns trigger
language plpgsql as $$
begin
  if public.is_user_session() then
    -- Users can only skip/unskip a chapter.
    if new.status not in ('new', 'skipped') then
      raise exception 'Status de capítulo não permitido: %', new.status using errcode = '42501';
    end if;
    new := jsonb_populate_record(old, jsonb_build_object('status', new.status));
  end if;
  return new;
end $$;
create trigger chapters_protect before update on public.chapters
  for each row execute function public.protect_chapter_columns();

create or replace function public.protect_work_columns() returns trigger
language plpgsql as $$
begin
  if public.is_user_session() then
    new.user_id := old.user_id;
    new.last_checked_at := old.last_checked_at;
    new.last_processed_chapter := old.last_processed_chapter;
  end if;
  return new;
end $$;
create trigger works_protect before update on public.works
  for each row execute function public.protect_work_columns();

create or replace function public.protect_alert_columns() returns trigger
language plpgsql as $$
begin
  if public.is_user_session() then
    new := jsonb_populate_record(old, jsonb_build_object('resolved_at', new.resolved_at));
  end if;
  return new;
end $$;
create trigger alerts_protect before update on public.alerts
  for each row execute function public.protect_alert_columns();

create or replace function public.works_authorization_stamp() returns trigger
language plpgsql as $$
begin
  if new.authorization_status = 'authorized'
     and (tg_op = 'INSERT' or old.authorization_status is distinct from 'authorized') then
    new.authorization_confirmed_at := now();
  elsif new.authorization_status <> 'authorized' then
    new.authorization_confirmed_at := null;
  end if;
  return new;
end $$;
create trigger works_authorization before insert or update of authorization_status on public.works
  for each row execute function public.works_authorization_stamp();
