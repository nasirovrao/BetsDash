-- ============================================================
-- CyberValue / EDGE — миграция Milestone 5
-- 1) Флаг "clv_tracker_enabled" в settings — включает вкладку CLV Tracker
--    для конкретного пользователя. Управляется вручную, администратором,
--    через Table Editor (Supabase → Table Editor → settings → нужная строка
--    → clv_tracker_enabled → true). Специальной админ-панели в приложении
--    пока нет — это осознанно простое решение на старте беты.
-- 2) Таблица clv_entries — отдельный, независимый от "bets" журнал записей
--    для отслеживания Closing Line Value (CLV Tracker). НЕ связана с
--    основным журналом ставок.
-- Вставь целиком в Supabase → SQL Editor → New query → Run.
-- Безопасно выполнять повторно — везде if not exists.
-- ============================================================

alter table public.settings add column if not exists clv_tracker_enabled boolean not null default false;

-- В CLV Tracker НЕТ исхода Win/Loss/Push по формуле "кэф × сумма" — это не
-- обычный журнал ставок, а трекер пойманных эджей. Запись живёт в статусе
-- Pending ("в игре"), пока не закрыта вручную — либо хеджем (Hedged,
-- перекрыта на другой стороне/у другого букмекера), либо продажей (Sold,
-- кэшаут). В обоих случаях итоговый профит вводится вручную (manual_profit),
-- потому что зависит от суммы и кэфа хеджа/продажи, а не выводится по формуле.
create table if not exists public.clv_entries (
  id             bigint generated always as identity primary key,
  user_id        uuid not null default auth.uid() references auth.users(id) on delete cascade,
  entry_date     date not null,
  match          text not null,
  pick           text,
  discipline     text,
  tournament     text,
  entry_odds     numeric not null check (entry_odds > 1),
  closing_odds   numeric check (closing_odds > 1),
  hedge_odds     numeric check (hedge_odds > 1),
  stake          numeric not null check (stake > 0),
  result         text not null default 'Pending' check (result in ('Pending','Hedged','Sold')),
  manual_profit  numeric,
  notes          text,
  created_at     timestamptz not null default now()
);

-- На случай, если clv_entries уже была создана более ранней версией этого
-- файла (с Win/Loss/Push в допустимых значениях) — приводим ограничение
-- к актуальному виду. Безопасно выполнять и на свежесозданной таблице.
alter table public.clv_entries drop constraint if exists clv_entries_result_check;
alter table public.clv_entries add constraint clv_entries_result_check
  check (result in ('Pending','Hedged','Sold'));

alter table public.clv_entries enable row level security;

create policy "select own clv_entries" on public.clv_entries
  for select using (auth.uid() = user_id);
create policy "insert own clv_entries" on public.clv_entries
  for insert with check (auth.uid() = user_id);
create policy "update own clv_entries" on public.clv_entries
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "delete own clv_entries" on public.clv_entries
  for delete using (auth.uid() = user_id);

create index if not exists clv_entries_user_date_idx on public.clv_entries (user_id, entry_date desc);
