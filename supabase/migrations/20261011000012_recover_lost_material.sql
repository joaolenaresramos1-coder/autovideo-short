-- A job that sat failed long enough loses its intermediate files to the
-- cleanup (the panels cut from the chapter pages). Resuming it from a later
-- step then failed forever with "Object not found". Now such a job resumes
-- from "fetching": the pages are downloaded and cut again, and the analysis
-- starts over; the rest (script, audio) is redone only if its files are gone.

create or replace function public.job_material_lost(p_job uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from storage_objects
    where job_id = p_job and kind = 'image' and path like '%/panels/%' and deleted_at is not null
  )
$$;

-- Where a resumed job should continue: its checkpoint, or "fetching" when the
-- panels it needs were deleted (their checkpoints are then cleared).
create or replace function public.resume_point(p_job uuid, p_resume public.job_state)
returns public.job_state language plpgsql security definer set search_path = public as $$
begin
  if p_resume in ('analyzing', 'scripting', 'audio_generating', 'rendering', 'validating')
     and job_material_lost(p_job) then
    delete from job_steps where job_id = p_job and step in ('fetching', 'analyzing', 'rendering', 'validating');
    insert into job_logs (user_id, job_id, level, event, message)
    select user_id, id, 'info', 'material_refetch',
           'As imagens do capítulo expiraram no servidor; elas serão buscadas de novo antes de continuar.'
    from jobs where id = p_job;
    return 'fetching';
  end if;
  return coalesce(p_resume, 'queued');
end $$;

create or replace function public.promote_due_jobs()
returns integer language plpgsql security definer set search_path = public as $$
declare
  n integer := 0;
  m integer := 0;
begin
  update jobs set state = 'queued'
  where state = 'scheduled' and run_at <= now();
  get diagnostics n = row_count;

  update jobs set state = resume_point(id, resume_state), resume_state = null,
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
    -- Resume from the checkpoint (or from the pages again if they expired).
    return transition_job(p_job, null, resume_point(p_job, j.resume_state));
  elsif p_action = 'run_now' then
    if j.state <> 'scheduled' then
      raise exception 'Somente tarefas agendadas podem ser antecipadas' using errcode = '55000';
    end if;
    update jobs set run_at = now() where id = p_job returning * into j;
    return transition_job(p_job, null, 'queued');
  end if;
  raise exception 'Ação desconhecida: %', p_action using errcode = '22023';
end $$;

-- Retention: a failed job that is retried gets its files back to the normal
-- 7-day lifetime, so the cleanup does not delete them mid-way.
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
  elsif old.state in ('failed', 'cancelled') then
    update storage_objects
       set expires_at = greatest(expires_at, now() + interval '7 days')
     where job_id = new.id and deleted_at is null and kind <> 'video';
  end if;
  return new;
end $$;

revoke execute on function public.job_material_lost(uuid) from public, anon, authenticated;
revoke execute on function public.resume_point(uuid, public.job_state) from public, anon, authenticated;
revoke execute on function public.promote_due_jobs() from public, anon, authenticated;
revoke execute on function public.request_job_action(uuid, uuid, text) from public, anon, authenticated;
