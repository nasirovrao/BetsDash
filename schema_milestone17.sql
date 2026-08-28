-- ============================================================
-- CyberValue / EDGE — миграция Milestone 17: ФИКС УТЕЧКИ личного дневника
-- через публичный профиль (найдено по прямому вопросу пользователя,
-- 28.08.2026 — "точно ли люди по ссылке не увидят личный дневник?").
--
-- ЧТО БЫЛО НЕ ТАК:
-- Milestone 7 завёл политики "select public bets/withdrawals/settings/
-- edges" ДО того, как в Milestone 8 появилось понятие "канал"
-- (default = личный дневник, cybervalue = публичный канал). Эти политики
-- проверяют только "у user_id есть публичный профиль (is_public=true)" —
-- БЕЗ учёта колонки channel. Milestone 8 эту дыру не закрыл: он добавил
-- profiles.channel (какой канал считается публичным), но не научил
-- политики milestone7 её проверять.
--
-- К ЧЕМУ ЭТО ПРИВОДИЛО НА ПРАКТИКЕ:
-- public.html на фронте сам фильтрует channel=cybervalue — поэтому в
-- обычном UI действительно виден только канал Cybervalue. Но RLS-политика
-- в базе разрешает читать ВСЕ строки этого user_id, включая channel=
-- 'default' (личный дневник). Anon-ключ Supabase лежит открыто в клиентском
-- JS (это нормально и ожидаемо для Supabase — защита должна идти через
-- RLS, а не через секретность ключа, см. комментарий вверху
-- supabase-client.js), а user_id владельца виден в network-запросах любого
-- браузера, открывшего публичную страницу. Значит ЛЮБОЙ человек — даже
-- без регистрации — мог собрать анонимный запрос напрямую к Supabase REST
-- API (например GET /rest/v1/bets?user_id=eq.<owner-id>&channel=eq.default)
-- и получить личный дневник в обход фронтенда.
--
-- ФИКС: политики теперь дополнительно требуют, чтобы channel строки
-- совпадал с ТЕМ ЕДИНСТВЕННЫМ каналом, который владелец явно объявил
-- публичным в profiles.channel. Личный дневник (channel='default')
-- публично нечитаем ни при каких обстоятельствах, пока сам владелец не
-- назначит его публичным каналом в profile-settings.html (сейчас там
-- всегда 'cybervalue' по умолчанию, см. milestone8).
--
-- Требует применённых schema_milestone7.sql и schema_milestone8.sql.
-- Вставь целиком в Supabase → SQL Editor → New query → Run.
-- Безопасно выполнять повторно.
-- ============================================================

drop policy if exists "select public bets" on public.bets;
create policy "select public bets" on public.bets
  for select using (
    exists (
      select 1 from public.profiles p
      where p.user_id = bets.user_id
        and p.is_public = true
        and p.channel = bets.channel
    )
  );

drop policy if exists "select public withdrawals" on public.withdrawals;
create policy "select public withdrawals" on public.withdrawals
  for select using (
    exists (
      select 1 from public.profiles p
      where p.user_id = withdrawals.user_id
        and p.is_public = true
        and p.channel = withdrawals.channel
    )
  );

drop policy if exists "select public settings" on public.settings;
create policy "select public settings" on public.settings
  for select using (
    exists (
      select 1 from public.profiles p
      where p.user_id = settings.user_id
        and p.is_public = true
        and p.channel = settings.channel
    )
  );

drop policy if exists "select public edges" on public.edges;
create policy "select public edges" on public.edges
  for select using (
    exists (
      select 1 from public.profiles p
      where p.user_id = edges.user_id
        and p.is_public = true
        and p.channel = edges.channel
    )
  );

-- ---- Проверка после применения (выполни отдельно, замени <owner-id>) ----
-- Должно вернуть 0 строк (личный дневник больше не читается анонимно):
--   select * from public.bets where user_id = '<owner-id>' and channel = 'default';
--   -- выполнить это НЕ как владелец, а через anon-ключ / в новой инкогнито-вкладке
