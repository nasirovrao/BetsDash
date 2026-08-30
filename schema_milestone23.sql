-- schema_milestone23.sql
--
-- Снимает жёсткое ограничение channel IN ('default','cybervalue') на
-- bets/withdrawals/edges/settings/profiles (было заведено в
-- schema_milestone8.sql), которое блокировало произвольные названия
-- публичных каналов на уровне базы, хотя channel_members
-- (schema_milestone12.sql, совместное редактирование канала) уже
-- поддерживает произвольный channel text без такого ограничения.
-- См. CHANGELOG.md, "Замечено по ходу работы" в записи "Профиль v2 +
-- Лента ставок".
--
-- Безопасность миграции: новое ограничение строго ШИРЕ старого — оба
-- текущих реальных значения ('default' и 'cybervalue', единственные,
-- которые вообще может произвести сегодняшний UI — см. p_channel в
-- profile-settings.html) проходят и новую проверку тоже. Значит, ни одна
-- существующая строка не может её нарушить, и обычного DROP+ADD в одной
-- транзакции достаточно — двухфазный DROP → ADD ... NOT VALID → UPDATE →
-- VALIDATE (см. памятку в скилле edge-site-dev) нужен только при
-- УЖЕСТОЧЕНИИ constraint'а против уже существующих "нелегальных" по новым
-- правилам строк, здесь не тот случай.
--
-- Новое ограничение не убирает проверку целиком (в отличие от
-- channel_members, где её вообще не было) — сознательно требуем тот же
-- формат, что уже применяется к юзернеймам в profile-settings.html
-- (USERNAME_RE: латиница в нижнем регистре, цифры, дефис, подчёркивание,
-- 3–32 символа), плюс отдельно разрешаем зарезервированное имя 'default'
-- (личный дневник — не публичный канал, под тот же формат подгонять незачем).
--
-- Безопасно перезапускать: DROP CONSTRAINT IF EXISTS чистит место перед
-- каждым ADD, как и во всех предыдущих schema_milestoneN.sql.

alter table public.bets drop constraint if exists bets_channel_check;
alter table public.bets add constraint bets_channel_check
  check (channel = 'default' or channel ~ '^[a-z0-9_-]{3,32}$');

alter table public.withdrawals drop constraint if exists withdrawals_channel_check;
alter table public.withdrawals add constraint withdrawals_channel_check
  check (channel = 'default' or channel ~ '^[a-z0-9_-]{3,32}$');

alter table public.edges drop constraint if exists edges_channel_check;
alter table public.edges add constraint edges_channel_check
  check (channel = 'default' or channel ~ '^[a-z0-9_-]{3,32}$');

alter table public.settings drop constraint if exists settings_channel_check;
alter table public.settings add constraint settings_channel_check
  check (channel = 'default' or channel ~ '^[a-z0-9_-]{3,32}$');

alter table public.profiles drop constraint if exists profiles_channel_check;
alter table public.profiles add constraint profiles_channel_check
  check (channel = 'default' or channel ~ '^[a-z0-9_-]{3,32}$');

-- ПОСЛЕ этой миграции сама возможность завести публичный канал с
-- произвольным именем (не только 'cybervalue') всё ещё требует отдельной
-- доработки UI — сейчас <select id="p_channel"> в profile-settings.html
-- жёстко хардкодит два варианта (Cybervalue / Личный дневник), это не
-- меняется этой миграцией. Миграция только снимает блокировку на уровне
-- базы, чтобы этот будущий UI не упёрся в constraint, когда до него дойдёт
-- очередь.
