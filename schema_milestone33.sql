-- ============================================================
-- CyberValue / EDGE — миграция Milestone 33: подписки на капперов
-- Первый шаг из приоритетов "три лица" (04.09.2026) — follow/unfollow
-- на публичный профиль/канал + фильтр "Мои подписки" в ленте (feed.html).
-- Уведомления НЕ входят в эту миграцию — отдельный следующий шаг.
--
-- followed_channel — не просто followed_user_id, потому что у одного
-- user_id может быть несколько публичных каналов (архитектура каналов,
-- см. lib.js getChannelParams) — подписка должна быть на конкретный канал,
-- а не на всего человека разом (иначе подписка на "личный дневник" молча
-- утекла бы и на его отдельный публичный канал, если такой есть).
--
-- RLS: select открыт всем (включая анонимусов) — подписки не приватные
-- данные, тот же уровень открытости, что у profiles.is_public=true (видно,
-- кто на кого подписан, как в большинстве соцсетей по умолчанию); нужен
-- анонимный select и для публичного счётчика подписчиков на public.html
-- (страница работает без входа). insert/delete — только от своего имени.
-- Вставь целиком в Supabase → SQL Editor → New query → Run.
-- Безопасно выполнять повторно.
-- ============================================================

create table if not exists public.follows (
  follower_user_id uuid not null references auth.users(id) on delete cascade,
  followed_user_id uuid not null references auth.users(id) on delete cascade,
  followed_channel text not null default 'default',
  created_at timestamptz not null default now(),
  primary key (follower_user_id, followed_user_id, followed_channel)
);

-- Нельзя подписаться на самого себя — проверяется и в UI (кнопка не
-- рисуется на своём профиле), но constraint на всякий случай на уровне БД.
alter table public.follows drop constraint if exists follows_no_self_follow;
alter table public.follows add constraint follows_no_self_follow
  check (follower_user_id <> followed_user_id);

alter table public.follows enable row level security;

drop policy if exists "select all follows" on public.follows;
create policy "select all follows" on public.follows
  for select using (true);

drop policy if exists "insert own follow" on public.follows;
create policy "insert own follow" on public.follows
  for insert with check (auth.uid() = follower_user_id);

drop policy if exists "delete own follow" on public.follows;
create policy "delete own follow" on public.follows
  for delete using (auth.uid() = follower_user_id);
