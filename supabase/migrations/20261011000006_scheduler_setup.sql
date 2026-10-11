-- Service: stores the Edge Function URL and cron secret in Vault and (re)creates
-- the pg_cron jobs. Called automatically by the "Deploy Supabase" workflow
-- through the tick function, so no manual SQL step is needed.
create or replace function public.configure_scheduler(p_url text, p_secret text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_cron boolean := false;
begin
  if p_url !~ '^https://' or coalesce(length(p_secret), 0) < 16 then
    raise exception 'URL ou segredo inválido' using errcode = '22023';
  end if;
  select id into v_id from vault.secrets where name = 'project_url';
  if v_id is null then perform vault.create_secret(p_url, 'project_url');
  else perform vault.update_secret(v_id, p_url, 'project_url'); end if;
  v_id := null;
  select id into v_id from vault.secrets where name = 'cron_secret';
  if v_id is null then perform vault.create_secret(p_secret, 'cron_secret');
  else perform vault.update_secret(v_id, p_secret, 'cron_secret'); end if;

  begin
    perform cron.schedule('autovideo-tick', '* * * * *', $c$ select public.invoke_edge_function('tick') $c$);
    perform cron.schedule('autovideo-cleanup', '*/20 * * * *', $c$ select public.invoke_edge_function('cleanup') $c$);
    perform cron.schedule('autovideo-promote', '* * * * *', $c$ select public.promote_due_jobs() $c$);
    perform cron.schedule('autovideo-storage-alerts', '*/30 * * * *', $c$ select public.refresh_storage_alerts() $c$);
    v_cron := true;
  exception when others then
    raise warning 'pg_cron indisponível: %', sqlerrm;
  end;
  return jsonb_build_object('vault', true, 'cron', v_cron);
end $$;

revoke all on function public.configure_scheduler(text, text) from public, anon, authenticated;
grant execute on function public.configure_scheduler(text, text) to service_role;
