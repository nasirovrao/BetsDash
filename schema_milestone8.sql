-- ============================================================
-- CyberValue / EDGE — миграция Milestone 8: разделение на "каналы"
-- Личный дневник ставок и публичный канал Cybervalue — теперь два
-- независимых набора данных внутри одного аккаунта, а не один и тот же
-- журнал. У каждой строки bets/withdrawals/settings/edges появляется
-- поле channel ('default' — личный дневник, 'cybervalue' — канал
-- Cybervalue). Личные страницы (Дашборд, Ставки, Выводы и банк и все
-- разбивки) продолжают показывать только channel = 'default' — ничего
-- в привычном виде не меняется. Канал Cybervalue стартует ПУСТЫМ и
-- заполняется отдельно, через переключатель "Cybervalue" на странице
-- "Ставки" (app.html?channel=cybervalue).
-- Требует, чтобы schema_milestone7.sql уже была выполнена.
-- Вставь целиком в Supabase → SQL Editor → New query → Run.
-- Безопасно выполнять повторно.
-- ============================================================

alter table public.bets add column if not exists channel text not null default 'default';
alter table public.bets drop constraint if exists bets_channel_check;
alter table public.bets add constraint bets_channel_check check (channel in ('default','cybervalue'));

alter table public.withdrawals add column if not exists channel text not null default 'default';
alter table public.withdrawals drop constraint if exists withdrawals_channel_check;
alter table public.withdrawals add constraint withdrawals_channel_check check (channel in ('default','cybervalue'));

alter table public.edges add column if not exists channel text not null default 'default';
alter table public.edges drop constraint if exists edges_channel_check;
alter table public.edges add constraint edges_channel_check check (channel in ('default','cybervalue'));
-- Одно и то же название эджа должно быть доступно независимо в каждом
-- канале (например "closing-value-cs2" и в личном дневнике, и в Cybervalue) —
-- старое ограничение unique(user_id, name) под это не подходит.
alter table public.edges drop constraint if exists edges_user_id_name_key;
alter table public.edges add constraint edges_user_id_channel_name_key unique (user_id, channel, name);

-- settings раньше был один ряд на пользователя (PK = user_id) — теперь
-- по ряду на канал (у Cybervalue свой стартовый банк, независимый от
-- личного). Существующий ряд остаётся с channel = 'default' — ничего не
-- теряется, старый банк по-прежнему на месте.
alter table public.settings add column if not exists channel text not null default 'default';
alter table public.settings drop constraint if exists settings_channel_check;
alter table public.settings add constraint settings_channel_check check (channel in ('default','cybervalue'));
alter table public.settings drop constraint if exists settings_pkey;
alter table public.settings add primary key (user_id, channel);

-- profiles.channel — какой из каналов пользователя виден на публичной
-- странице. По умолчанию 'cybervalue', потому что именно для этого и
-- заводится публичный профиль — показать отдельный, курируемый канал,
-- а не личный дневник со сторонней историей ставок.
alter table public.profiles add column if not exists channel text not null default 'cybervalue';
alter table public.profiles drop constraint if exists profiles_channel_check;
alter table public.profiles add constraint profiles_channel_check check (channel in ('default','cybervalue'));
