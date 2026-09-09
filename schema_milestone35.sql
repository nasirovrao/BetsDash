-- ============================================================
-- CyberValue / EDGE — миграция Milestone 35: доступ на уровне ОДНОГО пика
-- (конкретного каппера/источника пика), не всего журнала — по прямому
-- запросу 09.09.2026: "нужно чтобы он работал на уровне отдельного пика,
-- это первое". Сценарий: "я веду в личном дневнике ставки одного каппера,
-- источник пика — 'Secret series VIP', хочу дать другу видеть ТОЛЬКО их".
--
-- Отличие от Milestone 34 (доступ ко ВСЕМУ журналу/каналу, editor/viewer):
-- это НЕ его расширение, а отдельный, более узкий и более простой механизм
-- — сознательно без роли (доступ здесь только на просмотр, редактировать
-- чужие ставки по pick_source-доступу нельзя вообще, эта возможность не
-- нужна и не запрашивалась) и без банка/выводов (см. ниже, почему это
-- не требует отдельной защиты). Milestone 34 не трогаем и не меняем.
--
-- Требует применённого schema_milestone12.sql (таблица bets, RLS на select).
-- Вставь целиком в Supabase → SQL Editor → New query → Run.
-- Безопасно выполнять повторно.
-- ============================================================

-- 1) pick_shares — кому какой конкретный pick_source в каком журнале открыт.
--    channel обязателен (а не только owner+pick_source), потому что один и
--    тот же текст в pick_source в принципе может повторяться в разных
--    журналах одного пользователя — доступ должен быть однозначно привязан
--    к конкретному журналу, как и у channel_invites/channel_members.
create table if not exists public.pick_shares (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  channel text not null default 'default',
  pick_source text not null,
  invited_email text not null,
  member_user_id uuid references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (owner_user_id, channel, pick_source, invited_email)
);

alter table public.pick_shares enable row level security;

-- Владелец полностью управляет своими же строками (пригласить/убрать/
-- посмотреть, кому он сам открыл доступ).
drop policy if exists "pick_shares: owner manages" on public.pick_shares;
create policy "pick_shares: owner manages"
  on public.pick_shares for all
  using (auth.uid() = owner_user_id)
  with check (auth.uid() = owner_user_id);

-- Приглашённый видит СВОИ же строки (на что именно ему открыт доступ) —
-- нужно для его собственной страницы со списком доступных пиков.
drop policy if exists "pick_shares: member sees own grants" on public.pick_shares;
create policy "pick_shares: member sees own grants"
  on public.pick_shares for select
  using (auth.uid() = member_user_id);

-- 2) Функция проверки доступа — тот же паттерн, что has_channel_access
--    (schema_milestone12.sql), но по (owner, channel, pick_source), не по
--    (owner, channel). ТОЛЬКО просмотр — используется исключительно в
--    select-политике bets ниже, никакого has_pick_edit_access не заводим.
create or replace function public.has_pick_access(p_owner uuid, p_channel text, p_pick_source text)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.pick_shares
    where owner_user_id = p_owner
      and channel = p_channel
      and pick_source = p_pick_source
      and member_user_id = auth.uid()
  );
$$;

-- 3) bets: ДОПОЛНИТЕЛЬНАЯ permissive select-политика (не замена уже
--    существующей "select own or member bets" из schema_milestone12.sql —
--    в Postgres RLS несколько permissive-политик на одну операцию
--    объединяются через OR, поэтому старую трогать не нужно). Даёт доступ
--    строго к строкам с ИМЕННО этим pick_source — банк/выводы (таблицы
--    bank_transactions и т.п.) в этой политике не участвуют вообще, значит
--    без отдельного гранта туда доступа как не было, так и нет.
drop policy if exists "select bets via pick share" on public.bets;
create policy "select bets via pick share" on public.bets
  for select using (public.has_pick_access(user_id, channel, pick_source));

-- ============================================================
-- 4) Автовыдача доступа — тот же паттерн, что в schema_milestone34.sql
--    ("владелец вводит почту в ЛК — доступ открывается сам, без отдельного
--    'Принять' со стороны приглашённого"), продублирован здесь узко под
--    pick_shares, чтобы не завязывать этот более простой механизм на
--    внутренности Milestone 34.
-- ============================================================

create or replace function public.grant_pick_access_for_email(
  p_owner uuid, p_channel text, p_pick_source text, p_email text
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
  update public.pick_shares
  set member_user_id = v_user_id
  where owner_user_id = p_owner and channel = p_channel and pick_source = p_pick_source
    and lower(invited_email) = lower(p_email);
end;
$$;

-- (a) Сразу при добавлении строки в pick_shares (owner только что ввёл
-- почту друга) — если тот уже зарегистрирован, доступ появляется мгновенно.
create or replace function public.trg_pick_share_auto_grant()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.grant_pick_access_for_email(new.owner_user_id, new.channel, new.pick_source, new.invited_email);
  return new;
end;
$$;

drop trigger if exists pick_share_auto_grant on public.pick_shares;
create trigger pick_share_auto_grant
  after insert on public.pick_shares
  for each row execute function public.trg_pick_share_auto_grant();

-- (b) При регистрации НОВОГО пользователя — если на его email уже лежат
-- неактивированные pick_shares (заведённые ДО его регистрации), привязка
-- проставляется сразу же. Отдельный триггер от user_signup_auto_grant
-- (Milestone 34) — оба триггера на auth.users спокойно сосуществуют,
-- Postgres выполнит оба при каждой новой регистрации.
create or replace function public.trg_pick_share_user_signup_auto_grant()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.pick_shares
  set member_user_id = new.id
  where lower(invited_email) = lower(new.email) and member_user_id is null;
  return new;
end;
$$;

drop trigger if exists pick_share_user_signup_auto_grant on auth.users;
create trigger pick_share_user_signup_auto_grant
  after insert on auth.users
  for each row execute function public.trg_pick_share_user_signup_auto_grant();
