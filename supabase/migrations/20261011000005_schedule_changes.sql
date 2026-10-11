-- When a schedule's timing changes, is paused or deleted, future jobs that
-- have not started yet are cancelled (their slot key is released so the
-- calendar can be re-created with the new settings).
create or replace function public.schedules_cancel_future() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid := coalesce(old.id, new.id);
begin
  if tg_op = 'UPDATE' and new.days_of_week = old.days_of_week and new.time_of_day = old.time_of_day
     and new.timezone = old.timezone and new.videos_per_slot = old.videos_per_slot
     and new.lead_minutes = old.lead_minutes and new.active = old.active then
    return new;
  end if;
  update jobs
     set state = 'cancelled',
         dedupe_key = dedupe_key || ':cancelled:' || id,
         last_error = 'Programação alterada'
   where schedule_id = v_id and state = 'scheduled';
  if tg_op = 'UPDATE' then
    new.materialized_until := null;
    return new;
  end if;
  return old;
end $$;

create trigger schedules_change before update on public.schedules
  for each row execute function public.schedules_cancel_future();
create trigger schedules_delete before delete on public.schedules
  for each row execute function public.schedules_cancel_future();
