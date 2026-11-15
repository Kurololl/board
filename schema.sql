create table if not exists public.strokes (
  id uuid primary key,
  board text not null check (char_length(board) between 4 and 64),
  points jsonb not null check (jsonb_typeof(points) = 'array' and pg_column_size(points) < 300000),
  color text not null check (char_length(color) <= 16),
  width real not null check (width > 0 and width < 10000),
  created_at timestamptz not null default now()
);

create table if not exists public.pins (
  id uuid primary key,
  board text not null check (char_length(board) between 4 and 64),
  x real not null,
  y real not null,
  w real not null check (w > 0),
  h real not null check (h > 0),
  image_url text check (char_length(image_url) <= 2048),
  text text not null default '' check (char_length(text) <= 10000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists strokes_board_idx on public.strokes (board, created_at);
create index if not exists pins_board_idx on public.pins (board, created_at);

alter table public.strokes enable row level security;
alter table public.pins enable row level security;

drop policy if exists "board strokes public" on public.strokes;
create policy "board strokes public" on public.strokes
  for all to anon, authenticated using (true) with check (true);

drop policy if exists "board pins public" on public.pins;
create policy "board pins public" on public.pins
  for all to anon, authenticated using (true) with check (true);

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'strokes') then
    alter publication supabase_realtime add table public.strokes;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'pins') then
    alter publication supabase_realtime add table public.pins;
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

drop policy if exists "board images delete" on storage.objects;
create policy "board images delete" on storage.objects
  for delete to anon, authenticated using (bucket_id = 'images');
