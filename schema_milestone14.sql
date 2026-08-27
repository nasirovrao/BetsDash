-- Milestone 14: заявку на доступ к каналу теперь может подать ТОЛЬКО тот,
-- кого владелец канала сам заранее пригласил по email — а не любой
-- зарегистрированный пользователь, который угадал/нашёл имя канала.
--
-- Модель: владелец ведёт список приглашённых email'ов (channel_invites).
-- Заявка (channel_members, insert) проходит только если заявитель залогинен
-- под email'ом, который есть в этом списке для этого владельца+канала —
-- проверяется прямо в insert-политике ниже, а не только в UI (UI-проверка
-- легко обходится, поэтому реальная защита — на уровне RLS).
--
-- Требует применённого schema_milestone12.sql.

create table if not exists public.channel_invites (
  id             bigint generated always as identity primary key,
  owner_user_id  uuid not null references auth.users(id) on delete cascade,
  channel        text not null,
  invited_email  text not null,
  created_at     timestamptz not null default now(),
  unique (owner_user_id, channel, invited_email)
);

alter table public.channel_invites enable row level security;

-- Владелец полностью управляет своим списком приглашённых (добавляет/видит/удаляет).
drop policy if exists "channel_invites: owner manages" on public.channel_invites;
create policy "channel_invites: owner manages"
  on public.channel_invites for all
  using (auth.uid() = owner_user_id)
  with check (auth.uid() = owner_user_id);

-- Приглашённый должен суметь проверить "меня правда пригласили?" на странице
-- "Доступ к каналу" — даёт select на СВОЮ строку по email из JWT
-- (auth.email() — стандартный хелпер Supabase, регистр email не имеет
-- значения, поэтому сравниваем через lower()).
drop policy if exists "channel_invites: invitee sees own invite" on public.channel_invites;
create policy "channel_invites: invitee sees own invite"
  on public.channel_invites for select
  using (lower(invited_email) = lower(coalesce(auth.email(), '')));

-- Главное изменение: заявку (channel_members insert) теперь можно подать,
-- только если для этого owner_user_id+channel существует приглашение на
-- email заявителя. Раньше это мог сделать вообще любой пользователь —
-- по прямой просьбе владельца сайта это больше не так.
drop policy if exists "channel_members: request access" on public.channel_members;
create policy "channel_members: request access only if invited"
  on public.channel_members for insert
  with check (
    auth.uid() = member_user_id
    and status = 'pending'
    and exists (
      select 1 from public.channel_invites ci
      where ci.owner_user_id = channel_members.owner_user_id
        and ci.channel = channel_members.channel
        and lower(ci.invited_email) = lower(coalesce(auth.email(), ''))
    )
  );
