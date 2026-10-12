-- Claude (the user's subscription, via Claude Code on the render worker) as a
-- text AI. When Claude is first in the user's order, the analysis and script
-- steps of that user's jobs run on the worker instead of the Edge Functions.
alter table public.user_settings
  add column if not exists claude_model text not null default 'claude-opus-5-5';

create or replace function public.claude_first(p_order text[])
returns boolean language sql immutable as $$
  select coalesce(p_order[1] = 'claude', false)
$$;

create or replace function public.claim_jobs(
  p_executor text, p_worker text, p_limit integer default 5, p_lease_seconds integer default 140
) returns setof public.jobs language plpgsql security definer set search_path = public as $$
begin
  return query
  with candidates as (
    select j.id
    from jobs j
    left join user_settings s on s.user_id = j.user_id
    where (
        (j.state = any (executor_states(p_executor))
          and not (p_executor = 'edge' and j.state in ('analyzing', 'scripting') and claude_first(s.text_provider_order)))
        or (p_executor = 'edge' and j.state = 'queued')
        or (p_executor = 'worker' and j.state in ('analyzing', 'scripting') and claude_first(s.text_provider_order))
      )
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

revoke execute on function public.claim_jobs(text, text, integer, integer) from public, anon, authenticated;
revoke execute on function public.claude_first(text[]) from public, anon, authenticated;
