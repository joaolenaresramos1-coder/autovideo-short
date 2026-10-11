-- Queue, state machine, retention, cleanup and quota functions.
-- All deadlines use the database clock (now()), never the client's clock.
-- Functions prefixed by "Service:" are only executable by the service role.

-- ================================================================ queue
create or replace function public.executor_states(p_executor text)
returns public.job_state[] language sql immutable as $$
  select case p_executor
    when 'edge' then array['discovering', 'analyzing', 'scripting', 'audio_generating', 'publishing']::public.job_state[]
    when 'worker' then array['fetching', 'rendering', 'validating']::public.job_state[]
    else array[]::public.job_state[]
  end
$$;

-- Steps that spend money are blocked while the account is paused by a limit.
create or replace function public.is_cost_state(p_state public.job_state)
returns boolean language sql immutable as $$
  select p_state in ('analyzing', 'scripting', 'audio_generating', 'rendering')
$$;

-- Service: promote due jobs (scheduled -> queued, retry_wait -> checkpoint).
create or replace function public.promote_due_jobs()
returns integer language plpgsql security definer set search_path = public as $$
declare
  n integer := 0;
  m integer := 0;
begin
  update jobs set state = 'queued'
  where state = 'scheduled' and run_at <= now();
  get diagnostics n = row_count;

  update jobs set state = coalesce(resume_state, 'queued'), resume_state = null,
    next_attempt_at = null, waiting_reason = null
  where state = 'retry_wait' and next_attempt_at is not null and next_attempt_at <= now()
    and (locked_until is null or locked_until < now());
  get diagnostics m = row_count;

  if n + m > 0 then
    insert into job_logs (event, message, data)
    values ('promote', 'Tarefas liberadas para execução', jsonb_build_object('queued', n, 'resumed', m));
  end if;
  return n + m;
end $$;

-- Service: atomically claim jobs for an executor with a lease (SKIP LOCKED).
create or replace function public.claim_jobs(
  p_executor text, p_worker text, p_limit integer default 5, p_lease_seconds integer default 140
) returns setof public.jobs language plpgsql security definer set search_path = public as $$
begin
  return query
  with candidates as (
    select j.id
    from jobs j
    left join user_settings s on s.user_id = j.user_id
    where (j.state = any (executor_states(p_executor)) or (p_executor = 'edge' and j.state = 'queued'))
      and (j.locked_until is null or j.locked_until < now())
      and j.run_at <= now()
      and not (coalesce(s.automation_paused, false) and is_cost_state(j.state))
    order by j.priority desc, j.run_at, j.created_at
    limit greatest(p_limit, 0)
    for update of j skip locked
  )
  update jobs j
     set locked_by = p_worker,
         locked_until = now() + make_interval(secs => p_lease_seconds),
         started_at = coalesce(j.started_at, now())
    from candidates c
   where j.id = c.id
  returning j.*;
end $$;

-- Service: extend a lease while a long step is running.
create or replace function public.renew_lease(p_job uuid, p_worker text, p_lease_seconds integer)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  update jobs set locked_until = now() + make_interval(secs => p_lease_seconds)
  where id = p_job and locked_by = p_worker and locked_until > now();
  return found;
end $$;

-- Service: release a lease without changing state.
create or replace function public.release_job(p_job uuid, p_worker text)
returns void language sql security definer set search_path = public as $$
  update jobs set locked_by = null, locked_until = null
  where id = p_job and locked_by = p_worker;
$$;

-- Service: validated state transition. Idempotent when the job is already in p_to.
-- p_retry_in_seconds is required when p_to = 'retry_wait' (null = wait for manual action).
create or replace function public.transition_job(
  p_job uuid,
  p_worker text,
  p_to public.job_state,
  p_error text default null,
  p_retry_in_seconds integer default null,
  p_count_attempt boolean default false,
  p_waiting_reason text default null,
  p_keep_lock boolean default false
) returns public.jobs language plpgsql security definer set search_path = public as $$
declare
  j jobs;
  v_from public.job_state;
begin
  select * into j from jobs where id = p_job for update;
  if not found then
    raise exception 'Tarefa % não encontrada', p_job using errcode = 'P0002';
  end if;
  v_from := j.state;

  if p_worker is not null and j.locked_by is not null and j.locked_by <> p_worker
     and j.locked_until > now() then
    raise exception 'Tarefa % está em uso por outro executor (%)', p_job, j.locked_by using errcode = '55P03';
  end if;

  if v_from = p_to then
    if not p_keep_lock then
      update jobs set locked_by = null, locked_until = null where id = p_job returning * into j;
    end if;
    return j;
  end if;

  if not exists (select 1 from job_transitions where from_state = v_from and to_state = p_to) then
    raise exception 'Transição inválida: % -> %', v_from, p_to using errcode = '22023';
  end if;

  update jobs set
    state = p_to,
    resume_state = case
      when p_to in ('retry_wait', 'failed', 'cancelled') then
        case when v_from in ('retry_wait', 'failed', 'cancelled') then j.resume_state else v_from end
      else null end,
    attempts = case
      when p_count_attempt then j.attempts + 1
      when p_to in ('retry_wait', 'failed') then j.attempts
      when v_from in ('failed', 'cancelled') then 0   -- manual reprocessing starts a new attempt budget
      else j.attempts end,
    next_attempt_at = case
      when p_to = 'retry_wait' and p_retry_in_seconds is not null
        then now() + make_interval(secs => p_retry_in_seconds)
      else null end,
    waiting_reason = case when p_to = 'retry_wait' then p_waiting_reason else null end,
    last_error = case when p_error is not null then left(p_error, 2000)
                      when p_to in ('retry_wait', 'failed') then j.last_error
                      else null end,
    -- keep the lease when the same executor continues with the next step
    locked_by = case when p_keep_lock and p_to not in ('retry_wait', 'failed', 'cancelled') then j.locked_by end,
    locked_until = case when p_keep_lock and p_to not in ('retry_wait', 'failed', 'cancelled') then j.locked_until end,
    finished_at = case when p_to in ('published', 'failed', 'cancelled', 'ready_to_publish') then now() else null end
  where id = p_job
  returning * into j;

  insert into job_logs (user_id, job_id, level, event, message, data)
  values (
    j.user_id, j.id,
    case when p_to = 'failed' then 'error' when p_to = 'retry_wait' and p_error is not null then 'warn' else 'info' end,
    'transition',
    coalesce(left(p_error, 500), p_waiting_reason),
    jsonb_build_object('from', v_from, 'to', p_to, 'attempts', j.attempts, 'next_attempt_at', j.next_attempt_at)
  );
  return j;
end $$;

-- Service: record a step checkpoint (upsert, idempotent).
create or replace function public.save_step(
  p_job uuid, p_step text, p_status text, p_output jsonb default null, p_error text default null
) returns public.job_steps language plpgsql security definer set search_path = public as $$
declare
  r job_steps;
  v_user uuid;
begin
  select user_id into v_user from jobs where id = p_job;
  insert into job_steps (user_id, job_id, step, status, output, error, finished_at)
  values (v_user, p_job, p_step, p_status, p_output, left(p_error, 2000),
          case when p_status in ('succeeded', 'failed') then now() end)
  on conflict (job_id, step) do update set
    status = excluded.status,
    output = coalesce(excluded.output, job_steps.output),
    error = excluded.error,
    attempt = case when job_steps.status = 'running' and excluded.status = 'running'
                   then job_steps.attempt else job_steps.attempt + (excluded.status = 'running')::int end,
    started_at = case when excluded.status = 'running' then now() else job_steps.started_at end,
    finished_at = excluded.finished_at
  returning * into r;
  return r;
end $$;

-- Service: user-requested actions (validated by the API function before calling).
create or replace function public.request_job_action(p_user uuid, p_job uuid, p_action text)
returns public.jobs language plpgsql security definer set search_path = public as $$
declare
  j jobs;
begin
  select * into j from jobs where id = p_job and user_id = p_user for update;
  if not found then
    raise exception 'Tarefa não encontrada' using errcode = 'P0002';
  end if;
  if p_action = 'cancel' then
    if j.state in ('published', 'cancelled') then return j; end if;
    if j.state = 'publishing' then
      raise exception 'Não é possível cancelar durante a publicação' using errcode = '55000';
    end if;
    update jobs set locked_by = null, locked_until = null where id = p_job;
    return transition_job(p_job, null, 'cancelled', 'Cancelada pelo usuário');
  elsif p_action = 'retry' then
    if j.state not in ('failed', 'retry_wait', 'cancelled') then
      raise exception 'A tarefa não está em falha ou espera (estado: %)', j.state using errcode = '55000';
    end if;
    if j.state = 'cancelled' then
      return transition_job(p_job, null, 'queued');
    end if;
    -- Resume from the checkpoint; finished steps are not repeated.
    return transition_job(p_job, null, coalesce(j.resume_state, 'queued'));
  elsif p_action = 'run_now' then
    if j.state <> 'scheduled' then
      raise exception 'Somente tarefas agendadas podem ser antecipadas' using errcode = '55000';
    end if;
    update jobs set run_at = now() where id = p_job returning * into j;
    return transition_job(p_job, null, 'queued');
  end if;
  raise exception 'Ação desconhecida: %', p_action using errcode = '22023';
end $$;

-- ================================================================ retention
-- Video deadline: 24h after the first registered download, never later than
-- 48h after the render finished; 48h after the render when never downloaded.
create or replace function public.compute_video_expiry(
  p_completed_at timestamptz,
  p_first_download_at timestamptz,
  p_after_download_hours integer default 24,
  p_max_hours integer default 48,
  p_no_download_hours integer default 48
) returns timestamptz language sql immutable as $$
  select case
    when p_first_download_at is null then
      p_completed_at + make_interval(hours => least(p_no_download_hours, p_max_hours))
    else
      least(p_first_download_at + make_interval(hours => p_after_download_hours),
            p_completed_at + make_interval(hours => p_max_hours))
  end
$$;

-- Service: register a stored object and compute its expiry from the user's policy.
create or replace function public.register_object(
  p_user uuid, p_job uuid, p_bucket text, p_path text, p_kind public.storage_kind,
  p_size bigint, p_content_type text default null, p_completed boolean default true
) returns public.storage_objects language plpgsql security definer set search_path = public as $$
declare
  s user_settings;
  r storage_objects;
  v_expires timestamptz;
begin
  select * into s from user_settings where user_id = p_user;
  v_expires := case
    when p_kind = 'video' and p_completed then
      compute_video_expiry(now(), null, coalesce(s.video_after_download_hours, 24),
                           coalesce(s.video_max_retention_hours, 48), coalesce(s.video_no_download_hours, 48))
    when p_kind = 'partial' or not p_completed then
      now() + make_interval(hours => coalesce(s.incomplete_retention_hours, 12))
    -- intermediates live until the job is validated (then grace period), hard cap 7 days
    else now() + interval '7 days'
  end;
  insert into storage_objects (user_id, job_id, bucket, path, kind, size_bytes, content_type, completed_at, expires_at)
  values (p_user, p_job, p_bucket, p_path, p_kind, greatest(p_size, 0), p_content_type,
          case when p_completed then now() end, v_expires)
  on conflict (bucket, path) do update set
    size_bytes = excluded.size_bytes,
    content_type = excluded.content_type,
    kind = excluded.kind,
    completed_at = excluded.completed_at,
    expires_at = excluded.expires_at,
    deleted_at = null,
    delete_attempts = 0,
    last_delete_error = null
  returning * into r;
  return r;
end $$;

-- Service: called when the owner requests a download link. The click does not
-- prove the file was saved; it only starts the 24h countdown.
create or replace function public.register_download(p_user uuid, p_object uuid)
returns public.storage_objects language plpgsql security definer set search_path = public as $$
declare
  o storage_objects;
  s user_settings;
begin
  select * into o from storage_objects where id = p_object and user_id = p_user for update;
  if not found then
    raise exception 'Arquivo não encontrado' using errcode = 'P0002';
  end if;
  if o.deleted_at is not null or (o.expires_at is not null and o.expires_at <= now()) then
    raise exception 'O arquivo já expirou e foi (ou será) excluído' using errcode = '55000';
  end if;
  select * into s from user_settings where user_id = p_user;

  update storage_objects set
    first_download_at = coalesce(first_download_at, now()),
    download_count = download_count + 1,
    expires_at = case when kind = 'video' then
      compute_video_expiry(coalesce(completed_at, created_at), coalesce(first_download_at, now()),
        coalesce(s.video_after_download_hours, 24), coalesce(s.video_max_retention_hours, 48),
        coalesce(s.video_no_download_hours, 48))
      else expires_at end
  where id = p_object
  returning * into o;

  update videos set first_download_at = coalesce(first_download_at, now())
  where storage_object_id = p_object;

  insert into download_events (user_id, storage_object_id, video_id)
  values (p_user, p_object, (select id from videos where storage_object_id = p_object limit 1));
  return o;
end $$;

-- Adjust retention of a job's files whenever it reaches a milestone.
create or replace function public.jobs_retention_trigger() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  s user_settings;
begin
  if new.state is not distinct from old.state then
    return new;
  end if;
  select * into s from user_settings where user_id = new.user_id;
  if new.state = 'ready_to_publish' then
    -- Video validated: audio, images and pages are no longer needed.
    update storage_objects
       set expires_at = least(coalesce(expires_at, 'infinity'), now() + make_interval(hours => coalesce(s.intermediate_grace_hours, 1)))
     where job_id = new.id and deleted_at is null and kind in ('audio', 'image', 'page', 'partial');
  elsif new.state in ('failed', 'cancelled') then
    -- Keep intermediates for a while so a manual retry can resume from them.
    update storage_objects
       set expires_at = least(coalesce(expires_at, 'infinity'), now() + make_interval(hours => coalesce(s.incomplete_retention_hours, 12)))
     where job_id = new.id and deleted_at is null and kind <> 'video';
  end if;
  return new;
end $$;
create trigger jobs_retention after update of state on public.jobs
  for each row execute function public.jobs_retention_trigger();

-- Service: expired objects that are safe to delete now.
create or replace function public.cleanup_candidates(p_limit integer default 100)
returns table (id uuid, user_id uuid, bucket text, path text, kind public.storage_kind, size_bytes bigint, reason text)
language sql stable security definer set search_path = public as $$
  select o.id, o.user_id, o.bucket, o.path, o.kind, o.size_bytes, 'expired'
  from storage_objects o
  left join jobs j on j.id = o.job_id
  where o.deleted_at is null
    and o.expires_at is not null and o.expires_at <= now()
    and (o.hold_until is null or o.hold_until <= now())
    and (o.next_delete_attempt_at is null or o.next_delete_attempt_at <= now())
    -- never delete under a running step
    and not (j.id is not null and j.locked_until is not null and j.locked_until > now())
    -- intermediates of a job in recovery are kept until the job settles (videos keep their hard cap)
    and not (o.kind <> 'video' and j.id is not null and j.state = 'retry_wait'
             and o.created_at > now() - interval '7 days')
  order by o.expires_at
  limit p_limit
$$;

-- Service: objects skipped because of an active job (for reporting).
create or replace function public.cleanup_blocked_count()
returns integer language sql stable security definer set search_path = public as $$
  select count(*)::int
  from storage_objects o join jobs j on j.id = o.job_id
  where o.deleted_at is null and o.expires_at <= now()
    and ((j.locked_until > now()) or (o.kind <> 'video' and j.state = 'retry_wait'))
$$;

-- Service: mark an object as deleted. Keeps every historical row (video, script...).
create or replace function public.mark_object_deleted(p_object uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  o storage_objects;
begin
  update storage_objects set deleted_at = coalesce(deleted_at, now()), last_delete_error = null,
    next_delete_attempt_at = null
  where id = p_object
  returning * into o;
  if not found then return false; end if;
  update videos set file_deleted_at = coalesce(file_deleted_at, o.deleted_at)
  where storage_object_id = p_object;
  update alerts set resolved_at = now()
  where dedupe_key = 'delete_failed:' || p_object and resolved_at is null;
  return true;
end $$;

-- Service: register a failed deletion; retries with backoff, alerts after 3 failures.
create or replace function public.mark_object_delete_failed(p_object uuid, p_error text)
returns integer language plpgsql security definer set search_path = public as $$
declare
  o storage_objects;
begin
  update storage_objects set
    delete_attempts = delete_attempts + 1,
    last_delete_error = left(p_error, 1000),
    next_delete_attempt_at = now() + make_interval(mins => least(power(2, delete_attempts + 1)::int * 5, 720))
  where id = p_object
  returning * into o;
  if not found then return 0; end if;
  if o.delete_attempts >= 3 then
    insert into alerts (user_id, kind, level, message, data, dedupe_key)
    values (o.user_id, 'delete_failed', 'critical',
            'Falha persistente ao excluir arquivo: ' || o.path,
            jsonb_build_object('object_id', o.id, 'attempts', o.delete_attempts, 'error', left(p_error, 300)),
            'delete_failed:' || o.id)
    on conflict do nothing;
  end if;
  return o.delete_attempts;
end $$;

-- Service: purge operational logs older than each user's retention.
create or replace function public.purge_old_logs()
returns integer language plpgsql security definer set search_path = public as $$
declare
  n integer;
  m integer;
begin
  delete from job_logs l
  using user_settings s
  where l.user_id = s.user_id and l.created_at < now() - make_interval(days => s.log_retention_days);
  get diagnostics n = row_count;
  delete from job_logs where user_id is null and created_at < now() - interval '30 days';
  get diagnostics m = row_count;
  delete from oauth_states where expires_at < now();
  delete from cleanup_runs where started_at < now() - interval '90 days';
  return n + m;
end $$;

-- Real bytes stored in the bucket according to Supabase Storage itself.
create or replace function public.bucket_usage_bytes(p_bucket text default 'media')
returns bigint language sql stable security definer set search_path = public, storage as $$
  select coalesce(sum((metadata ->> 'size')::bigint), 0)::bigint
  from storage.objects where bucket_id = p_bucket
$$;

-- Service: confirm a deletion against Supabase Storage's own catalogue.
create or replace function public.storage_object_exists(p_bucket text, p_path text)
returns boolean language sql stable security definer set search_path = public, storage as $$
  select exists (select 1 from storage.objects where bucket_id = p_bucket and name = p_path)
$$;

-- Storage dashboard for the signed-in user.
create or replace function public.storage_summary()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_user uuid := auth.uid();
  s user_settings;
  r jsonb;
begin
  if v_user is null then
    raise exception 'Não autenticado' using errcode = '42501';
  end if;
  select * into s from user_settings where user_id = v_user;
  select jsonb_build_object(
    'quota_bytes', coalesce(s.storage_quota_bytes, 1073741824),
    'used_bytes', coalesce(sum(size_bytes) filter (where deleted_at is null), 0),
    'video_bytes', coalesce(sum(size_bytes) filter (where deleted_at is null and kind = 'video'), 0),
    'temporary_bytes', coalesce(sum(size_bytes) filter (where deleted_at is null and kind <> 'video'), 0),
    'reclaimable_bytes', coalesce(sum(size_bytes) filter (where deleted_at is null and expires_at <= now()), 0),
    'expiring_24h', coalesce(count(*) filter (where deleted_at is null and expires_at <= now() + interval '24 hours'), 0),
    'delete_failures', coalesce(count(*) filter (where deleted_at is null and delete_attempts > 0), 0),
    'object_count', coalesce(count(*) filter (where deleted_at is null), 0),
    'bucket_bytes_all_users', bucket_usage_bytes('media'),
    'last_cleanup', (select to_jsonb(c) from cleanup_runs c order by started_at desc limit 1)
  ) into r
  from storage_objects where user_id = v_user;
  return r;
end $$;

-- Service: raise/resolve the 70/85/95 % storage alerts for every user.
create or replace function public.refresh_storage_alerts()
returns integer language plpgsql security definer set search_path = public as $$
declare
  rec record;
  lvl integer;
  n integer := 0;
begin
  for rec in
    select s.user_id, s.storage_quota_bytes as quota,
           coalesce((select sum(size_bytes) from storage_objects o
                     where o.user_id = s.user_id and o.deleted_at is null), 0) as used
    from user_settings s
  loop
    foreach lvl in array array[70, 85, 95] loop
      if rec.used * 100 >= rec.quota * lvl then
        insert into alerts (user_id, kind, level, message, data, dedupe_key)
        values (rec.user_id, 'storage', case when lvl >= 95 then 'critical' when lvl >= 85 then 'warning' else 'info' end,
                format('Armazenamento atingiu %s%% da cota configurada', lvl),
                jsonb_build_object('used_bytes', rec.used, 'quota_bytes', rec.quota, 'threshold', lvl),
                'storage_' || lvl)
        on conflict do nothing;
        if found then n := n + 1; end if;
      else
        update alerts set resolved_at = now()
        where user_id = rec.user_id and dedupe_key = 'storage_' || lvl and resolved_at is null;
      end if;
    end loop;
  end loop;
  return n;
end $$;

-- ================================================================ costs & quotas
create or replace function public.usage_totals(p_user uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'day_cost_usd', coalesce(sum(cost_usd) filter (where created_at >= date_trunc('day', now() at time zone tz) at time zone tz), 0),
    'month_cost_usd', coalesce(sum(cost_usd) filter (where created_at >= date_trunc('month', now() at time zone tz) at time zone tz), 0),
    'day_ai_calls', count(*) filter (where provider = 'gemini' and created_at >= date_trunc('day', now() at time zone tz) at time zone tz),
    'month_renders', count(*) filter (where kind = 'render' and not failed and created_at >= date_trunc('month', now() at time zone tz) at time zone tz),
    'month_failed_cost_usd', coalesce(sum(cost_usd) filter (where failed and created_at >= date_trunc('month', now() at time zone tz) at time zone tz), 0)
  )
  from (select coalesce((select timezone from user_settings where user_id = p_user), 'UTC') as tz) z
  left join usage_events u on u.user_id = p_user and u.created_at >= now() - interval '32 days'
$$;

-- Service: record usage and update the job's spent cost.
create or replace function public.record_usage(
  p_user uuid, p_job uuid, p_provider text, p_kind text, p_model text,
  p_input_tokens integer, p_output_tokens integer, p_units numeric, p_unit_type text,
  p_cost_usd numeric, p_failed boolean default false
) returns void language plpgsql security definer set search_path = public as $$
begin
  insert into usage_events (user_id, job_id, provider, kind, model, input_tokens, output_tokens, units, unit_type, cost_usd, failed)
  values (p_user, p_job, p_provider, p_kind, p_model, p_input_tokens, p_output_tokens, p_units, p_unit_type, coalesce(p_cost_usd, 0), p_failed);
  if p_job is not null then
    update jobs set cost_spent_usd = cost_spent_usd + coalesce(p_cost_usd, 0) where id = p_job;
  end if;
end $$;

-- Service: decide whether a cost-generating step may start. When a daily or
-- monthly limit is reached the account is paused until the user reactivates it.
create or replace function public.check_cost_allowance(
  p_user uuid, p_job uuid, p_kind text, p_estimated_usd numeric default 0
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  s user_settings;
  t jsonb;
  j jobs;
  v_reason text;
begin
  select * into s from user_settings where user_id = p_user;
  if not found then
    return jsonb_build_object('allowed', false, 'reason', 'Configurações do usuário ausentes');
  end if;
  if s.automation_paused then
    return jsonb_build_object('allowed', false, 'reason', coalesce(s.pause_reason, 'Automação pausada'));
  end if;
  t := usage_totals(p_user);
  select * into j from jobs where id = p_job;

  if (t ->> 'day_cost_usd')::numeric + p_estimated_usd > s.daily_cost_limit_usd then
    v_reason := format('Limite diário de custo atingido (US$ %s de US$ %s)',
                       round((t ->> 'day_cost_usd')::numeric, 4), s.daily_cost_limit_usd);
  elsif (t ->> 'month_cost_usd')::numeric + p_estimated_usd > s.monthly_cost_limit_usd then
    v_reason := format('Limite mensal de custo atingido (US$ %s de US$ %s)',
                       round((t ->> 'month_cost_usd')::numeric, 4), s.monthly_cost_limit_usd);
  elsif p_kind in ('gemini_text', 'gemini_tts', 'gemini_image') and (t ->> 'day_ai_calls')::int >= s.daily_ai_call_limit then
    v_reason := format('Limite diário de chamadas de IA atingido (%s)', s.daily_ai_call_limit);
  elsif p_kind = 'render' and (t ->> 'month_renders')::int >= s.monthly_render_limit then
    v_reason := format('Limite mensal de renderizações atingido (%s)', s.monthly_render_limit);
  end if;

  if v_reason is not null then
    update user_settings set automation_paused = true, pause_reason = v_reason, paused_at = now()
    where user_id = p_user;
    insert into alerts (user_id, kind, level, message, data, dedupe_key)
    values (p_user, 'quota', 'critical', v_reason || '. Novas tarefas com custo foram interrompidas.', t, 'quota_pause')
    on conflict do nothing;
    return jsonb_build_object('allowed', false, 'reason', v_reason, 'paused', true, 'totals', t);
  end if;

  -- Per-video limit: only this job waits, the account keeps running.
  if j.id is not null and j.cost_spent_usd + p_estimated_usd > j.cost_limit_usd then
    return jsonb_build_object('allowed', false, 'job_limit', true,
      'reason', format('Limite de custo desta tarefa atingido (US$ %s de US$ %s)', round(j.cost_spent_usd, 4), j.cost_limit_usd));
  end if;
  return jsonb_build_object('allowed', true, 'totals', t);
end $$;

-- Service: manual reactivation after a limit pause.
create or replace function public.resume_automation(p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update user_settings set automation_paused = false, pause_reason = null, paused_at = null where user_id = p_user;
  update alerts set resolved_at = now() where user_id = p_user and dedupe_key = 'quota_pause' and resolved_at is null;
  -- wake jobs that were waiting because of the limit
  update jobs set next_attempt_at = now()
  where user_id = p_user and state = 'retry_wait' and waiting_reason like 'Limite%';
  insert into job_logs (user_id, event, message) values (p_user, 'automation_resumed', 'Automação reativada manualmente');
end $$;

-- ================================================================ chapters
-- Service: next unprocessed chapter not yet claimed by another job for this format.
create or replace function public.next_chapter_for(p_work uuid, p_format public.summary_format)
returns public.chapters language sql stable security definer set search_path = public as $$
  select c.* from chapters c
  where c.work_id = p_work and c.status = 'new'
    and not exists (
      select 1 from jobs j
      where j.content_key = c.work_id || ':' || c.chapter_key || ':' || p_format and j.state <> 'cancelled'
    )
  order by c.number nulls last, c.discovered_at
  limit 1
$$;

-- ================================================================ privileges
do $$
declare
  f text;
begin
  foreach f in array array[
    'promote_due_jobs()', 'claim_jobs(text,text,integer,integer)', 'renew_lease(uuid,text,integer)',
    'release_job(uuid,text)',
    'transition_job(uuid,text,public.job_state,text,integer,boolean,text,boolean)',
    'save_step(uuid,text,text,jsonb,text)', 'request_job_action(uuid,uuid,text)',
    'register_object(uuid,uuid,text,text,public.storage_kind,bigint,text,boolean)',
    'register_download(uuid,uuid)', 'cleanup_candidates(integer)', 'cleanup_blocked_count()',
    'mark_object_deleted(uuid)', 'mark_object_delete_failed(uuid,text)', 'purge_old_logs()',
    'refresh_storage_alerts()', 'usage_totals(uuid)',
    'record_usage(uuid,uuid,text,text,text,integer,integer,numeric,text,numeric,boolean)',
    'check_cost_allowance(uuid,uuid,text,numeric)', 'resume_automation(uuid)',
    'next_chapter_for(uuid,public.summary_format)', 'bucket_usage_bytes(text)', 'storage_object_exists(text,text)', 'handle_new_user()',
    'jobs_retention_trigger()'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

revoke all on function public.storage_summary() from public, anon;
grant execute on function public.storage_summary() to authenticated, service_role;

-- Convenience view for the dashboard (RLS of the base tables applies).
create or replace view public.my_usage_today with (security_invoker = true) as
  select provider, kind, count(*) as calls, sum(cost_usd) as cost_usd,
         sum(input_tokens) as input_tokens, sum(output_tokens) as output_tokens
  from public.usage_events
  where created_at >= date_trunc('day', now())
  group by provider, kind;
