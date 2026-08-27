-- Milestone 12: совместное редактирование канала (несколько человек ведут
-- один и тот же канал, например "cybervalue").
--
-- Модель доступа:
--   • Владелец канала — как и раньше, данные физически хранятся под его
--     user_id (иначе публичный профиль и агрегированная статистика канала
--     не будут собираться в одном месте).
--   • Редактор — другой пользователь, которого владелец одобрил. Может
--     ДОБАВЛЯТЬ и РЕДАКТИРОВАТЬ ставки в этом канале, но НЕ удалять их и
--     НЕ управлять банком/выводами (это осталось только у владельца) —
--     решение пользователя явно, см. переписку.
--   • Редактор ВИДИТ (select) банк/выводы канала — иначе дашборд для него
--     был бы сломан (профит/ROI/банк считаются из этих данных), но менять
--     их не может — insert/update/delete там остаются только для владельца.
--
-- Заявки: пользователь сам подаёт заявку (status='pending'), владелец
-- канала одобряет/отклоняет. Без самоодобрения — insert-политика ниже
-- жёстко требует status='pending' от того, кто не владелец.
--
-- Требует применённых schema.sql, schema_milestone2.sql, schema_milestone7.sql.

create table if not exists public.channel_members (
  id             bigint generated always as identity primary key,
  owner_user_id  uuid not null references auth.users(id) on delete cascade,
  channel        text not null,
  channel_label  text,
  member_user_id uuid not null references auth.users(id) on delete cascade,
  member_email   text,
  role           text not null default 'editor' check (role in ('editor')),
  status         text not null default 'pending' check (status in ('pending','approved','rejected')),
  requested_at   timestamptz not null default now(),
  decided_at     timestamptz,
  unique (owner_user_id, channel, member_user_id)
);

alter table public.channel_members enable row level security;

create policy "channel_members: member sees own rows"
  on public.channel_members for select
  using (auth.uid() = member_user_id);

create policy "channel_members: owner sees own channel rows"
  on public.channel_members for select
  using (auth.uid() = owner_user_id);

-- Подать заявку может кто угодно САМ НА СЕБЯ, всегда со статусом pending —
-- нельзя вставить себе сразу approved.
create policy "channel_members: request access"
  on public.channel_members for insert
  with check (auth.uid() = member_user_id and status = 'pending');

-- Менять статус (одобрить/отклонить) может только владелец канала.
create policy "channel_members: owner decides"
  on public.channel_members for update
  using (auth.uid() = owner_user_id)
  with check (auth.uid() = owner_user_id);

-- Отозвать доступ (удалить строку) — тоже только владелец.
create policy "channel_members: owner revokes"
  on public.channel_members for delete
  using (auth.uid() = owner_user_id);

-- SECURITY DEFINER — чтобы политики на bets/withdrawals/settings ниже
-- могли проверять членство без рекурсивной RLS-проверки самой таблицы
-- channel_members (и чтобы редактор мог быть проверен, даже если у него
-- по каким-то причинам нет прав читать саму строку channel_members).
create or replace function public.has_channel_access(p_owner uuid, p_channel text)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.channel_members
    where owner_user_id = p_owner
      and channel = p_channel
      and member_user_id = auth.uid()
      and status = 'approved'
  );
$$;

-- ---- bets: select/insert/update — владелец ИЛИ одобренный редактор.
-- delete — только владелец (без изменений, политику не трогаем).

drop policy if exists "select own bets" on public.bets;
create policy "select own or member bets" on public.bets
  for select using (auth.uid() = user_id or public.has_channel_access(user_id, channel));

drop policy if exists "insert own bets" on public.bets;
create policy "insert own or member bets" on public.bets
  for insert with check (auth.uid() = user_id or public.has_channel_access(user_id, channel));

drop policy if exists "update own bets" on public.bets;
create policy "update own or member bets" on public.bets
  for update using (auth.uid() = user_id or public.has_channel_access(user_id, channel));

-- ---- withdrawals / settings: ТОЛЬКО select расширяем на редакторов
-- (иначе дашборд для них не посчитает банк/профит) — insert/update/delete
-- остаются исключительно у владельца, политики не трогаем.

drop policy if exists "select own withdrawals" on public.withdrawals;
create policy "select own or member withdrawals" on public.withdrawals
  for select using (auth.uid() = user_id or public.has_channel_access(user_id, channel));

drop policy if exists "select own settings" on public.settings;
create policy "select own or member settings" on public.settings
  for select using (auth.uid() = user_id or public.has_channel_access(user_id, channel));

-- edges и clv_entries сознательно НЕ трогаем — это личные заметки/трекер
-- владельца, не часть запроса пользователя ("только ставки" + "банк
-- только владелец"), делиться ими редакторам не нужно.
