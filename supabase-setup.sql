-- JUST MELLOW POS: private cloud-backup table
-- Run this script in the Supabase SQL Editor for your own project.
-- Never put a service_role key in the client app.

create table if not exists public.pos_backups (
  owner_id uuid primary key references auth.users (id) on delete cascade,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.pos_backups enable row level security;

-- Remove any default/table grants first; anon and public must not be able to read backups.
revoke all on table public.pos_backups from public, anon, authenticated;

-- Authenticated users may use the table, but row-level policies below restrict them to their own row.
grant select, insert, update, delete on table public.pos_backups to authenticated;

drop policy if exists "Users can read their own POS backup" on public.pos_backups;
create policy "Users can read their own POS backup"
  on public.pos_backups for select to authenticated
  using (auth.uid() = owner_id);

drop policy if exists "Users can insert their own POS backup" on public.pos_backups;
create policy "Users can insert their own POS backup"
  on public.pos_backups for insert to authenticated
  with check (auth.uid() = owner_id);

drop policy if exists "Users can update their own POS backup" on public.pos_backups;
create policy "Users can update their own POS backup"
  on public.pos_backups for update to authenticated
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

drop policy if exists "Users can delete their own POS backup" on public.pos_backups;
create policy "Users can delete their own POS backup"
  on public.pos_backups for delete to authenticated
  using (auth.uid() = owner_id);
