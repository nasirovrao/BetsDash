-- schema_milestone25.sql
--
-- Лимит на распознавание скриншотов ставок (CHANGELOG.md, "Парсинг ставок со
-- скриншота" — вторая итерация выше, лимит добавлен 31.08.2026 по прямому
-- запросу): 100 скриншотов на пользователя в календарный месяц. Считаются
-- сами ВЫЗОВЫ функции с картинкой (не количество распознанных ставок внутри
-- одного скриншота — очередь из 3 ставок с одного скрина всё ещё стоит "1").
-- Причина лимита та же, что и у самой платности фичи: каждый вызов с
-- картинкой тратит реальные деньги на ключе Anthropic (см. README функции).
--
-- Таблица пишется ТОЛЬКО из самой Edge Function (parse-bet-screenshot/
-- index.ts), сервис-роль ключом, который автоматически доступен внутри
-- любой Edge Function как Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') — этот
-- секрет НЕ нужно задавать руками через `supabase secrets set`, Supabase
-- инжектит его сам во все функции проекта. RLS ниже сознательно не даёт
-- клиенту (даже самому пользователю) ни insert, ни update — только select
-- своей же строки, чтобы фронтенд мог показать "осталось N из 100", но не
-- мог сам накрутить/сбросить себе счётчик, отправив прямой запрос в обход
-- Edge Function.
--
-- Известное упрощение: инкремент в index.ts — не в одной атомарной SQL-
-- транзакции (сначала SELECT текущего count, потом отдельный upsert), то
-- есть теоретически возможна гонка при ДВУХ одновременных запросах от
-- одного и того же пользователя ровно на границе лимита (оба могут успеть
-- проскочить на 100-й). Для одиночного пользователя, кликающего вручную
-- одну кнопку за раз, риск практически нулевой — если это когда-нибудь
-- станет проблемой (например, при появлении много одновременных
-- пользователей), решение — перенести инкремент в postgres-функцию с
-- `select ... for update`, сейчас это осознанно не сделано ради простоты.
--
-- Безопасно перезапускать: create table if not exists, DROP+CREATE policy.

create table if not exists public.screenshot_parse_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  month text not null, -- 'YYYY-MM', UTC (см. комментарий в index.ts про выбор UTC, а не локального времени пользователя)
  count integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, month)
);

alter table public.screenshot_parse_usage enable row level security;

drop policy if exists "select own screenshot usage" on public.screenshot_parse_usage;
create policy "select own screenshot usage" on public.screenshot_parse_usage
  for select using (auth.uid() = user_id);

-- Намеренно НЕТ insert/update/delete policy для authenticated/anon — строки
-- создаёт и меняет только Edge Function сервис-ролью, которая RLS не видит
-- вообще (bypass по дизайну service_role в Supabase), обычным пользователям
-- запись сюда должна быть недоступна никаким способом, включая напрямую
-- через supabase-js с их собственным JWT.
