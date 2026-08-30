-- ============================================================
-- CyberValue / EDGE — миграция Milestone 22: профиль v2 + лента ставок
--
-- 1) profiles.created_at — нужен для строки "На EDGE с ..." на новом
--    профиле. У старых строк проставится текущая дата (не настоящая дата
--    регистрации — колонки для этого раньше не было). Для уже существующих
--    профилей можно поправить руками в Table Editor, если знаешь реальную
--    дату, миграция это не делает автоматически.
-- 2) profiles.roles — ролевые метки (каппер/стример), самостоятельно
--    включаются владельцем в profile-settings.html. text[] без строгого
--    CHECK на допустимые значения (как discipline раньше — держим простым,
--    некритичное поле). Ожидаемые значения в коде: 'capper', 'streamer'.
-- 3) profiles.is_verified — бейдж верификации. НЕ самообслуживание (нет
--    чекбокса в profile-settings.html) — тот же паттерн, что и
--    settings.clv_tracker_enabled: ставится вручную администратором в
--    Supabase Table Editor, когда данные каппера реально проверены.
--
-- Требует применённого schema_milestone7.sql (таблица profiles).
-- Вставь целиком в Supabase → SQL Editor → New query → Run.
-- Безопасно выполнять повторно — везде add column if not exists.
-- ============================================================

alter table public.profiles add column if not exists created_at timestamptz not null default now();
alter table public.profiles add column if not exists roles text[] not null default '{}';
alter table public.profiles add column if not exists is_verified boolean not null default false;
