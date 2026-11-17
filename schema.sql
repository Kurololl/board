create table if not exists public.boards (
  id text primary key check (char_length(id) between 1 and 64),
  data jsonb not null check (pg_column_size(data) < 8000000),
  version integer not null default 1,
  updated_at timestamptz not null default now()
);

alter table public.boards enable row level security;

drop policy if exists "boards public access" on public.boards;
create policy "boards public access" on public.boards
  for all to anon, authenticated using (true) with check (true);

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'boards') then
    alter publication supabase_realtime add table public.boards;
  end if;
end $$;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('images', 'images', true, 5242880, array['image/webp', 'image/jpeg', 'image/png', 'image/gif'])
on conflict (id) do nothing;

drop policy if exists "board images read" on storage.objects;
create policy "board images read" on storage.objects
  for select to anon, authenticated using (bucket_id = 'images');

drop policy if exists "board images upload" on storage.objects;
create policy "board images upload" on storage.objects
  for insert to anon, authenticated with check (bucket_id = 'images');
