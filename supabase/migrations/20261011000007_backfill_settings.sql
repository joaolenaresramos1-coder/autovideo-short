-- Accounts created before the migrations were applied get their settings row.
insert into public.user_settings (user_id)
select id from auth.users
on conflict (user_id) do nothing;
