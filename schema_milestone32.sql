-- Milestone 32 (04.09.2026): переключатели для новых блоков на публичном
-- профиле — "Лучший турнир" (самый прибыльный турнир по сумме профита) и
-- "Лучшая ставка" (лучшая по профиту в $ + лучшая по кэфу, см. public.html).
--
-- В отличие от show_bank (schema_milestone13.sql, default false — банк
-- считается чувствительными данными, показывается только по явному
-- включению) — здесь default true: эти блоки не показывают ничего личного
-- (просто название турнира/матча и цифры, которые и так видны в таблице
-- ставок ниже), поэтому включены сразу всем, а не только по запросу.
-- Владелец профиля может выключить каждый блок отдельно на profile-settings.html.
alter table public.profiles add column if not exists show_best_tournament boolean not null default true;
alter table public.profiles add column if not exists show_best_bet boolean not null default true;
