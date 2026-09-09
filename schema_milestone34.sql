-- ============================================================
-- CyberValue / EDGE — миграция Milestone 34: роль "только просмотр" для
-- совместного доступа к каналу + доступ к ЛЮБОМУ своему журналу (не только
-- к тому, что отмечен публичным) — обе части одного запроса 09.09.2026:
-- "выдать другу доступ видеть все ставки, но не редактировать".
--
-- Было (Milestone 12/14/15): channel_members.role — CHECK разрешал только
-- 'editor', любой approved-участник мог и видеть, и добавлять/редактировать
-- ставки канала. Теперь роль 'viewer' — approved, но БЕЗ прав на
-- insert/update ставок (см. has_channel_edit_access ниже, отдельная от
-- уже существующей has_channel_access, которая как и раньше означает
-- "видит канал вообще" для ЛЮБОЙ роли).
--
-- Требует применённых schema_milestone12.sql и schema_milestone14/15.sql.
-- Вставь целиком в Supabase → SQL Editor → New query → Run.
-- Безопасно выполнять повторно.
-- ============================================================

-- 1) channel_members.role — расширяем CHECK, разрешая 'viewer' вдобавок к
--    уже существующему 'editor'. Строго ШИРЕ старого ограничения (та же
--    логика, что в schema_milestone23.sql) — ни одна существующая строка
--    ('editor' — единственное, что вообще можно было вставить раньше) не
--    может нарушить новую проверку, обычный DROP+ADD безопасен без
--    двухфазного NOT VALID/VALIDATE.
alter table public.channel_members drop constraint if exists channel_members_role_check;
alter table public.channel_members add constraint channel_members_role_check
  check (role in ('editor', 'viewer'));

-- 2) channel_invites.role — какую роль владелец собирается выдать ДО того,
--    как приглашённый примет приглашение (channel_members ещё не создан).
--    default 'editor' — прежнее поведение (единственное, что было раньше)
--    для уже существующих строк-приглашений не меняется молча.
alter table public.channel_invites add column if not exists role text not null default 'editor' check (role in ('editor', 'viewer'));

-- 3) Отдельная функция для ПРАВА РЕДАКТИРОВАНИЯ (в отличие от
--    has_channel_access из schema_milestone12.sql, которая остаётся как
--    есть и означает "approved-участник вообще, любая роль" — используется
--    ниже для select, доступного и viewer, и editor).
create or replace function public.has_channel_edit_access(p_owner uuid, p_channel text)
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
      and role = 'editor'
  );
$$;

-- 4) bets: insert/update теперь только для владельца ИЛИ editor-участника
--    (viewer больше не может добавлять/менять ставки) — select НЕ трогаем,
--    он остаётся на has_channel_access (владелец + любая approved-роль),
--    viewer по-прежнему видит все ставки канала, просто не может их менять.
-- Дропаем ОБА возможных имени — старое (до этой миграции) и новое (если
-- скрипт уже один раз успешно отработал и запускается повторно) — иначе
-- при повторном запуске "create policy" падает с "policy already exists"
-- (сама политика 1-в-1 та же самая, но пересоздать её надо в любом случае,
-- т.к. может измениться has_channel_edit_access ниже по файлу).
drop policy if exists "insert own or member bets" on public.bets;
drop policy if exists "insert own or editor bets" on public.bets;
create policy "insert own or editor bets" on public.bets
  for insert with check (auth.uid() = user_id or public.has_channel_edit_access(user_id, channel));

drop policy if exists "update own or member bets" on public.bets;
drop policy if exists "update own or editor bets" on public.bets;
create policy "update own or editor bets" on public.bets
  for update using (auth.uid() = user_id or public.has_channel_edit_access(user_id, channel));

-- 5) Приём приглашения (channel_members insert) — та же защита "только если
--    приглашён на этот owner+channel", ПЛЮС теперь ещё и роль, с которой
--    вставляется channel_members, должна совпадать с ролью из самого
--    приглашения (channel_invites.role) — без этого условия ничто не
--    мешало бы залогиненному клиенту подставить role:'editor' в insert,
--    даже если владелец пригласил его именно как 'viewer'. Реальная защита
--    на уровне RLS, не только в UI (UI и так не даёт выбрать роль при
--    приёме — роль выбирает исключительно владелец при приглашении).
drop policy if exists "channel_members: accept invite (auto-approved)" on public.channel_members;
create policy "channel_members: accept invite (auto-approved)"
  on public.channel_members for insert
  with check (
    auth.uid() = member_user_id
    and status = 'approved'
    and exists (
      select 1 from public.channel_invites ci
      where ci.owner_user_id = channel_members.owner_user_id
        and ci.channel = channel_members.channel
        and lower(ci.invited_email) = lower(coalesce(auth.email(), ''))
        and ci.role = channel_members.role
    )
  );

-- "channel_members: owner decides" (update, Milestone 12) уже разрешает
-- владельцу менять ЛЮБЫЕ колонки своих строк channel_members, включая
-- role — значит смена роли уже существующему редактору/зрителю ("поменять
-- в личном кабинете") ничего нового в RLS не требует, только UI на
-- channel-team.html (см. тот же коммит).

-- ============================================================
-- 6) Автоматическая активация приглашения — по прямому запросу 09.09.2026:
--    "чтобы я просто в ЛК ввёл его почту и доступ открылся", без отдельного
--    шага "Принять" со стороны приглашённого. Раньше (Milestone 15)
--    приглашённый всё равно должен был сам зайти на channel-team.html и
--    нажать "Принять". Теперь — два триггера, SECURITY DEFINER (нужен
--    доступ к auth.users, которого у обычного клиента через RLS нет и не
--    должно быть):
--
--    a) Приглашение добавлено (channel_invites insert), а человек с таким
--       email УЖЕ зарегистрирован в EDGE — доступ выдаётся немедленно.
--    b) Приглашение уже лежало (email ещё не был зарегистрирован), человек
--       ТОЛЬКО ЧТО зарегистрировался этой же почтой — доступ выдаётся сразу
--       по факту регистрации, retroactively.
--
--    UI-путь "Приглашения для тебя" → "Принять" (Milestone 15) НЕ убираю —
--    оставлен как ручной fallback на случай, если по какой-то причине
--    триггер не сработал (например, email в auth.users и в приглашении
--    совпадает не идеально по регистру не через lower(), хотя ниже она
--    приведена — двойная защита безопаснее, чем полагаться только на
--    автоматику).
-- ============================================================

create or replace function public.grant_channel_access_for_email(
  p_owner uuid, p_channel text, p_channel_label text, p_email text, p_role text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
begin
  select id into v_user_id from auth.users where lower(email) = lower(p_email) limit 1;
  if v_user_id is null then
    return; -- ещё не зарегистрирован — сработает позже, вторым триггером ниже
  end if;
  insert into public.channel_members (owner_user_id, channel, channel_label, member_user_id, member_email, role, status, decided_at)
  values (p_owner, p_channel, p_channel_label, v_user_id, p_email, p_role, 'approved', now())
  on conflict (owner_user_id, channel, member_user_id)
  do update set role = excluded.role, status = 'approved', decided_at = now();
end;
$$;

-- (a) Срабатывает сразу при создании приглашения (owner только что ввёл
-- почту друга) — если тот уже зарегистрирован, доступ появляется мгновенно.
create or replace function public.trg_channel_invite_auto_grant()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.grant_channel_access_for_email(new.owner_user_id, new.channel, new.channel_label, new.invited_email, new.role);
  return new;
end;
$$;

drop trigger if exists channel_invite_auto_grant on public.channel_invites;
create trigger channel_invite_auto_grant
  after insert on public.channel_invites
  for each row execute function public.trg_channel_invite_auto_grant();

-- (b) Срабатывает при регистрации НОВОГО пользователя — если на его email
-- уже лежат неактивированные приглашения (заведённые ДО того, как он
-- зарегистрировался), выдаёт доступ по каждому из них сразу.
create or replace function public.trg_user_signup_auto_grant()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  inv record;
begin
  for inv in
    select owner_user_id, channel, channel_label, role
    from public.channel_invites
    where lower(invited_email) = lower(new.email)
  loop
    perform public.grant_channel_access_for_email(inv.owner_user_id, inv.channel, inv.channel_label, new.email, inv.role);
  end loop;
  return new;
end;
$$;

drop trigger if exists user_signup_auto_grant on auth.users;
create trigger user_signup_auto_grant
  after insert on auth.users
  for each row execute function public.trg_user_signup_auto_grant();
