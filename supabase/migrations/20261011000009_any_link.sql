-- Any website link works: no "compatible source" step. Works that were left
-- without a source become link (with a URL) or upload works, and are active.
update public.works
set source = case when url ~* '^https?://' then 'link' else 'upload' end,
    status = 'active',
    status_reason = null,
    next_check_at = now()
where source = 'manual';

update public.works
set status = 'active', status_reason = null, next_check_at = now()
where status = 'pending_config' and source in ('link', 'upload');

alter table public.works alter column source set default 'upload';
