-- schema_milestone26.sql
--
-- "Личные настройки" — три галочки, которыми человек сам решает, какие
-- разделы навигации ему нужны: ведёт ли он личный дневник, ведёт ли
-- публичный канал, читает ли чужую статистику как подписчик. НЕ новая
-- модель доступа — все три вещи и так технически доступны любому аккаунту
-- всегда (см. CHANGELOG.md, обсуждение "трёх сценариев входа" 30.08.2026);
-- эти три колонки управляют ТОЛЬКО видимостью пунктов меню на приватных
-- страницах, ничего не блокируют по факту. Прямая ссылка на скрытую
-- страницу продолжает работать как раньше.
--
-- default true у всех трёх — по умолчанию ничего не прячем: до этой
-- миграции навигация показывала вообще всё всем, и первое включение
-- функции не должно тихо спрятать то, чем человек уже пользуется. Прятать
-- разделы — осознанное действие самого человека на personal-settings.html.
--
-- Безопасно перезапускать: add column if not exists.

alter table public.profiles add column if not exists nav_diary boolean not null default true;
alter table public.profiles add column if not exists nav_channel boolean not null default true;
alter table public.profiles add column if not exists nav_reader boolean not null default true;

comment on column public.profiles.nav_diary is
  'Показывать в меню разделы личного дневника (Дашборд/Ставки/Банк/Детальная статистика/Эджи/CLV). Только видимость нав-бара, не право доступа.';
comment on column public.profiles.nav_channel is
  'Показывать в меню "Публичный профиль" и "Доступ к каналу". Только видимость нав-бара, не право доступа.';
comment on column public.profiles.nav_reader is
  'Показывать в меню "Лента ставок" (чтение чужих публичных каналов). Только видимость нав-бара, не право доступа.';

-- Отдельная политика insert/update/select не нужна — это те же три новые
-- колонки в уже существующей public.profiles, RLS-политики которой
-- ("select own profile" / "select public profiles" / "insert own profile" /
-- "update own profile" из schema_milestone7.sql) уже покрывают владельца
-- строки без изменений.
