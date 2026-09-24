-- ============================================================
-- CyberValue / EDGE — миграция Milestone 37: НЕСКОЛЬКО публичных каналов
-- на один профиль (раньше — ровно один, profiles.channel/is_public).
--
-- ЧТО БЫЛО: profiles — одна строка на user_id, с единственным полем
-- channel ("какой канал публичный") + is_public (общий рубильник). Значит
-- физически нельзя было отметить публичными сразу два канала — второй
-- выбор в select просто заменял первый.
--
-- ЧТО МЕНЯЕТСЯ: добавляем profiles.public_channels text[] — список
-- каналов, которые видны всем. is_public остаётся общим рубильником
-- (выключил — скрыто всё, независимо от списка). Старая колонка channel
-- НЕ удаляется (на неё ничего больше не полагается после этой миграции,
-- но дропать её ради экономии одной колонки — риск без выгоды).
--
-- ВАЖНО (см. schema_milestone17.sql — там был реальный инцидент утечки
-- личного дневника через RLS): те же 4 политики "select public …" на
-- bets/withdrawals/settings/edges снова переписываются, теперь проверяют
-- "channel строки — ЛЮБОЙ из public_channels", а не "= единственному
-- channel". Личный дневник (channel='default') по-прежнему НЕ публичен,
-- пока сам владелец явно не добавит 'default' в свой список публичных
-- каналов — ровно та же логика, что раньше, просто список вместо одного
-- значения.
--
-- Требует применённых schema_milestone7/8/17.sql.
-- Вставь целиком в Supabase → SQL Editor → New query → Run.
-- Безопасно выполнять повторно.
-- ============================================================

alter table public.profiles add column if not exists public_channels text[] not null default '{}';

-- Разовый перенос уже существующих публичных каналов в новый список —
-- только у строк, где список ещё пуст (по умолчанию у всех новых колонок),
-- чтобы повторный запуск не затирал то, что владелец уже поменял сам через
-- обновлённую форму на profile-settings.html.
update public.profiles
  set public_channels = array[channel]
  where is_public = true
    and channel is not null
    and public_channels = '{}';

drop policy if exists "select public bets" on public.bets;
create policy "select public bets" on public.bets
  for select using (
    exists (
      select 1 from public.profiles p
      where p.user_id = bets.user_id
        and p.is_public = true
        and bets.channel = any(p.public_channels)
    )
  );

drop policy if exists "select public withdrawals" on public.withdrawals;
create policy "select public withdrawals" on public.withdrawals
  for select using (
    exists (
      select 1 from public.profiles p
      where p.user_id = withdrawals.user_id
        and p.is_public = true
        and withdrawals.channel = any(p.public_channels)
    )
  );

drop policy if exists "select public settings" on public.settings;
create policy "select public settings" on public.settings
  for select using (
    exists (
      select 1 from public.profiles p
      where p.user_id = settings.user_id
        and p.is_public = true
        and settings.channel = any(p.public_channels)
    )
  );

drop policy if exists "select public edges" on public.edges;
create policy "select public edges" on public.edges
  for select using (
    exists (
      select 1 from public.profiles p
      where p.user_id = edges.user_id
        and p.is_public = true
        and edges.channel = any(p.public_channels)
    )
  );

-- ---- Проверка после применения (замени <owner-id> на свой user_id) ----
-- Должно вернуть публичные каналы из списка, но НЕ 'default', пока сам
-- его туда не добавишь:
--   select public_channels from public.profiles where user_id = '<owner-id>';
-- Личный дневник по-прежнему закрыт анонимно (0 строк, если 'default' не
-- в списке) — выполнить через anon-ключ / в инкогнито-вкладке:
--   select * from public.bets where user_id = '<owner-id>' and channel = 'default';
