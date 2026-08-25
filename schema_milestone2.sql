-- ============================================================
-- CyberValue App — Milestone 2: банк и выводы
-- Вставь целиком в Supabase → SQL Editor → New query → Run
-- (schema.sql из Milestone 1 уже должен быть выполнен раньше)
-- ============================================================

-- Стартовый банк каждого пользователя (задаётся один раз на странице
-- "Выводы и банк"; от него считаются "Банк" и "Прирост банка" на Дашборде).
create table if not exists public.settings (
  user_id            uuid primary key references auth.users(id) on delete cascade,
  starting_bankroll  numeric not null default 0,
  created_at         timestamptz not null default now()
);
alter table public.settings enable row level security;

create policy "select own settings" on public.settings
  for select using (auth.uid() = user_id);
create policy "insert own settings" on public.settings
  for insert with check (auth.uid() = user_id);
create policy "update own settings" on public.settings
  for update using (auth.uid() = user_id);

-- Выводы средств — уменьшают текущий банк, но не влияют на статистику по
-- ставкам (винрейт/ROI считаются только по bets).
create table if not exists public.withdrawals (
  id          bigint generated always as identity primary key,
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  w_date      date not null,
  amount      numeric not null check (amount > 0),
  note        text,
  created_at  timestamptz not null default now()
);
alter table public.withdrawals enable row level security;

create policy "select own withdrawals" on public.withdrawals
  for select using (auth.uid() = user_id);
create policy "insert own withdrawals" on public.withdrawals
  for insert with check (auth.uid() = user_id);
create policy "delete own withdrawals" on public.withdrawals
  for delete using (auth.uid() = user_id);

create index if not exists withdrawals_user_date_idx on public.withdrawals (user_id, w_date desc);
