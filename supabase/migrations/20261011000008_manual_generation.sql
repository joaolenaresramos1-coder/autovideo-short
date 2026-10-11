-- Manual generation and standalone chapters:
-- * works can come from chapter links the user sends (source = 'link');
-- * "standalone" works hold one-off chapters sent without registering a work;
-- * reuse authorization is the user's responsibility: no gate in the pipeline.
alter table public.works drop constraint if exists works_source_check;
alter table public.works add constraint works_source_check
  check (source in ('manual', 'upload', 'mangadex', 'rss', 'anilist', 'link'));
alter table public.works add column if not exists standalone boolean not null default false;
alter table public.works alter column authorization_status set default 'authorized';
update public.works set authorization_status = 'authorized' where authorization_status in ('unknown', 'metadata_only');
