-- ============================================================
-- CyberValue / EDGE — миграция Milestone 7: публичный профиль
-- 1) Таблица profiles — username, отображаемое имя, описание и флаг
--    is_public. Владелец сам управляет своей строкой на странице
--    profile-settings.html.
-- 2) Публичное чтение: для bets / withdrawals / settings / edges
--    добавляется ВТОРАЯ (дополнительная) политика select — она разрешает
--    видеть строки конкретного пользователя кому угодно (включая
--    неавторизованных, anon-ключом), если и только если у этого
--    пользователя есть профиль с is_public = true. Политики select в
--    Postgres RLS объединяются через OR, поэтому обычный доступ "вижу
--    только свои строки" (auth.uid() = user_id) продолжает работать без
--    изменений — эта миграция ничего не убирает, только добавляет узкую
--    дополнительную дверь наружу для тех, кто сам включил публичность.
-- Требует, чтобы schema_milestone6.sql (таблица edges) уже была выполнена —
-- иначе упадёт политика "select public edges" на несуществующей таблице.
-- Вставь целиком в Supabase → SQL Editor → New query → Run.
-- Безопасно выполнять повторно — везде if not exists / drop-if-exists.
-- ============================================================

create table if not exists public.profiles (
  user_id       uuid primary key references auth.users(id) on delete cascade,
  username      text unique,
  display_name  text,
  bio           text,
  is_public     boolean not null default false,
  updated_at    timestamptz not null default now()
);

-- Юзернейм для URL — только латиница/цифры/дефис/underscore, 3-32 символа.
alter table public.profiles drop constraint if exists profiles_username_format;
alter table public.profiles add constraint profiles_username_format
  check (username is null or username ~ '^[a-z0-9_-]{3,32}$');

alter table public.profiles enable row level security;

drop policy if exists "select own profile" on public.profiles;
create policy "select own profile" on public.profiles
  for select using (auth.uid() = user_id);

drop policy if exists "select public profiles" on public.profiles;
create policy "select public profiles" on public.profiles
  for select using (is_public = true);

drop policy if exists "insert own profile" on public.profiles;
create policy "insert own profile" on public.profiles
  for insert with check (auth.uid() = user_id);

drop policy if exists "update own profile" on public.profiles;
create policy "update own profile" on public.profiles
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---- Публичное чтение данных владельца публичного профиля ----

drop policy if exists "select public bets" on public.bets;
create policy "select public bets" on public.bets
  for select using (
    exists (select 1 from public.profiles p where p.user_id = bets.user_id and p.is_public = true)
  );

drop policy if exists "select public withdrawals" on public.withdrawals;
create policy "select public withdrawals" on public.withdrawals
  for select using (
    exists (select 1 from public.profiles p where p.user_id = withdrawals.user_id and p.is_public = true)
  );

drop policy if exists "select public settings" on public.settings;
create policy "select public settings" on public.settings
  for select using (
    exists (select 1 from public.profiles p where p.user_id = settings.user_id and p.is_public = true)
  );

drop policy if exists "select public edges" on public.edges;
create policy "select public edges" on public.edges
  for select using (
    exists (select 1 from public.profiles p where p.user_id = edges.user_id and p.is_public = true)
  );
