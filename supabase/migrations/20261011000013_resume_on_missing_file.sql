-- A panel can also be missing from Storage while its row was never marked as
-- deleted (the job's last error then says "Object not found"). Treat that the
-- same way: resume from "fetching" so the pages are downloaded again.
create or replace function public.resume_point(p_job uuid, p_resume public.job_state)
returns public.job_state language plpgsql security definer set search_path = public as $$
begin
  if p_resume in ('analyzing', 'scripting', 'audio_generating', 'rendering', 'validating')
     and (job_material_lost(p_job)
          or exists (select 1 from jobs where id = p_job
                     and (last_error ilike '%Object not found%' or last_error ilike '%expiraram no servidor%'))) then
    delete from job_steps where job_id = p_job and step in ('fetching', 'analyzing', 'rendering', 'validating');
    insert into job_logs (user_id, job_id, level, event, message)
    select user_id, id, 'info', 'material_refetch',
           'As imagens do capítulo expiraram no servidor; elas serão buscadas de novo antes de continuar.'
    from jobs where id = p_job;
    return 'fetching';
  end if;
  return coalesce(p_resume, 'queued');
end $$;

revoke execute on function public.resume_point(uuid, public.job_state) from public, anon, authenticated;
