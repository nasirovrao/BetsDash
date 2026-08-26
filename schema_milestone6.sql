-- Milestone 6: реестр эджей — таблица, где эдж можно назвать и завести
-- ДО первой ставки (а не только неявно через поле "Эдж-паттерн" в форме
-- ставки). Идемпотентно, безопасно выполнять повторно.

create table if not exists public.edges (
  id           bigint generated always as identity primary key,
  user_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name         text not null,
  description  text,
  created_at   timestamptz not null default now(),
  unique (user_id, name)
);

alter table public.edges enable row level security;

drop policy if exists "select own edges" on public.edges;
create policy "select own edges" on public.edges
  for select using (auth.uid() = user_id);

drop policy if exists "insert own edges" on public.edges;
create policy "insert own edges" on public.edges
  for insert with check (auth.uid() = user_id);

drop policy if exists "update own edges" on public.edges;
create policy "update own edges" on public.edges
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "delete own edges" on public.edges;
create policy "delete own edges" on public.edges
  for delete using (auth.uid() = user_id);

create index if not exists edges_user_id_idx on public.edges(user_id, created_at desc);
