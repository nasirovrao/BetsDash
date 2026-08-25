-- ============================================================
-- CyberValue App — схема базы данных, Milestone 1
-- Вставь целиком в Supabase → SQL Editor → New query → Run
-- ============================================================

create table if not exists public.bets (
  id           bigint generated always as identity primary key,
  user_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  bet_date     date not null,
  discipline   text not null,
  bookmaker    text not null,
  tournament   text,
  match        text,
  pick         text not null,
  odds         numeric not null check (odds > 1),
  flat_mult    numeric not null default 1 check (flat_mult > 0),
  stake        numeric not null check (stake > 0),
  result       text not null default 'Pending' check (result in ('Win','Loss','Push','Pending')),
  bet_type     text check (bet_type in ('Pre-value','Live value','Хедж','Попанская')),
  conviction   smallint check (conviction between 1 and 3),
  edge_tag     text,
  is_live      boolean not null default false,
  created_at   timestamptz not null default now()
);

-- На случай, если "Enable automatic RLS" не сработал сам — включаем явно.
alter table public.bets enable row level security;

-- Каждый видит и меняет только свои строки.
create policy "select own bets" on public.bets
  for select using (auth.uid() = user_id);

create policy "insert own bets" on public.bets
  for insert with check (auth.uid() = user_id);

create policy "update own bets" on public.bets
  for update using (auth.uid() = user_id);

create policy "delete own bets" on public.bets
  for delete using (auth.uid() = user_id);

-- Индекс — чтобы запросы "мои ставки, свежие сверху" были быстрыми и дальше,
-- когда строк станет много.
create index if not exists bets_user_date_idx on public.bets (user_id, bet_date desc);
