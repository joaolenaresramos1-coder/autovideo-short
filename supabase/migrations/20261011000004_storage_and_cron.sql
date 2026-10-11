-- Private bucket for temporary media. Files are only reachable through
-- short-lived signed URLs created by the Edge Functions.
insert into storage.buckets (id, name, public, file_size_limit)
values ('media', 'media', false, 209715200)
on conflict (id) do update set public = false;

-- Server-side schedule (pg_cron + pg_net). The Edge Function URL and the
-- shared secret come from Supabase Vault, never from this repository:
--   select vault.create_secret('https://<ref>.supabase.co', 'project_url');
--   select vault.create_secret('<random string>', 'cron_secret');
-- The block is skipped when the extensions are unavailable (local tests).
do $outer$
begin
  begin
    create extension if not exists pg_cron;
    create extension if not exists pg_net;
  exception when others then
    raise notice 'pg_cron/pg_net indisponíveis (%), agendamento não criado', sqlerrm;
    return;
  end;

  create or replace function public.invoke_edge_function(p_name text, p_body jsonb default '{}'::jsonb)
  returns bigint language plpgsql security definer set search_path = public as $fn$
  declare
    v_url text;
    v_secret text;
  begin
    select decrypted_secret into v_url from vault.decrypted_secrets where name = 'project_url';
    select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'cron_secret';
    if v_url is null or v_secret is null then
      raise warning 'Vault sem project_url/cron_secret: agendamento inativo';
      return null;
    end if;
    return net.http_post(
      url := v_url || '/functions/v1/' || p_name,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', v_secret),
      body := p_body,
      timeout_milliseconds := 10000
    );
  end $fn$;
  revoke all on function public.invoke_edge_function(text, jsonb) from public, anon, authenticated;

  perform cron.schedule('autovideo-tick', '* * * * *', $cron$ select public.invoke_edge_function('tick') $cron$);
  perform cron.schedule('autovideo-cleanup', '*/20 * * * *', $cron$ select public.invoke_edge_function('cleanup') $cron$);
  -- Queue promotion also runs in pure SQL so retries resume even if the tick function is down.
  perform cron.schedule('autovideo-promote', '* * * * *', $cron$ select public.promote_due_jobs() $cron$);
  perform cron.schedule('autovideo-storage-alerts', '*/30 * * * *', $cron$ select public.refresh_storage_alerts() $cron$);
end
$outer$;
