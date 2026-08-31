-- schema_milestone27.sql
--
-- Автодобавление ставок из Telegram-канала (CHANGELOG.md, решено ранее,
-- реализовано 31.08.2026 по запросу "Telegram-импорт своих ставок").
-- Настоящий бот: добавляешь его админом в свой Telegram-канал, каждый
-- новый пост уходит в webhook (supabase/functions/telegram-webhook/),
-- модель (тот же принцип, что и у парсинга скриншотов — tool_use-схема
-- record_bet_data) пытается распознать в тексте поста данные ставки. Если
-- похоже на ставку — попадает в очередь telegram_pending_bets, ты сам
-- подтверждаешь/правишь каждую через ту же форму на app.html, что и для
-- скриншотов (?tg=<id> открывает конкретный элемент очереди). Ничего не
-- сохраняется в дневник само — тот же принцип верифицируемости, что и у
-- скриншотов.
--
-- Три таблицы:
--
-- 1) telegram_links — привязка ОДНОГО Telegram-канала к ОДНОМУ аккаунту
--    EDGE. Пишет ТОЛЬКО сервис-роль, из двух Edge Function:
--      - telegram-link (обычная, Verify JWT включён) — код привязки/выбор
--        целевого канала EDGE/отвязка, дёргается с фронтенда как
--        supabase.functions.invoke(...), от твоего собственного JWT;
--      - telegram-webhook (Verify JWT ВЫКЛЮЧЕН — сюда стучится Telegram, а
--        не залогиненный пользователь) — подтверждает привязку, когда в
--        канале публикуется код.
--    RLS явно НЕ даёт insert/update/delete клиенту (даже себе) — тот же
--    принцип, что у screenshot_parse_usage (schema_milestone25.sql): подмену
--    telegram_chat_id обычным API-запросом в обход функций технически
--    невозможно исключить иначе.

create table if not exists public.telegram_links (
  user_id             uuid primary key references auth.users(id) on delete cascade,
  channel             text not null default 'default', -- в какой канал EDGE попадают распознанные ставки
  link_code           text not null,                     -- одноразовый код, публикуется постом в канале для привязки
  telegram_chat_id    bigint,                             -- null, пока не привязано
  telegram_chat_title text,                               -- название канала — только для отображения статуса
  linked_at           timestamptz,
  created_at          timestamptz not null default now()
);

-- Один и тот же Telegram-канал нельзя привязать сразу к двум аккаунтам EDGE.
create unique index if not exists telegram_links_chat_id_key
  on public.telegram_links (telegram_chat_id) where telegram_chat_id is not null;

alter table public.telegram_links enable row level security;

drop policy if exists "select own telegram link" on public.telegram_links;
create policy "select own telegram link" on public.telegram_links
  for select using (auth.uid() = user_id);

-- Намеренно НЕТ insert/update/delete policy для authenticated/anon — строку
-- создаёт/меняет только сервис-роль изнутри telegram-link/telegram-webhook.

-- 2) telegram_pending_bets — очередь распознанных, но ещё не подтверждённых
--    ставок. Пишет ТОЛЬКО сервис-роль (telegram-webhook), а вот УДАЛЯТЬ
--    свои же строки владельцу можно напрямую (тот же принцип, что и для
--    обычных bets/withdrawals) — это происходит и при подтверждении через
--    форму на app.html (успешно сохранил -> убрал из очереди), и при
--    ручном отклонении явного мусора прямо на telegram-import.html.

create table if not exists public.telegram_pending_bets (
  id                   bigint generated always as identity primary key,
  user_id              uuid not null references auth.users(id) on delete cascade,
  channel              text not null,
  telegram_message_id  bigint,
  raw_text             text not null,
  parsed               jsonb not null, -- та же форма одного элемента bets[], что у record_bet_data
  created_at           timestamptz not null default now()
);

alter table public.telegram_pending_bets enable row level security;

drop policy if exists "select own telegram pending bets" on public.telegram_pending_bets;
create policy "select own telegram pending bets" on public.telegram_pending_bets
  for select using (auth.uid() = user_id);

drop policy if exists "delete own telegram pending bets" on public.telegram_pending_bets;
create policy "delete own telegram pending bets" on public.telegram_pending_bets
  for delete using (auth.uid() = user_id);

-- insert — намеренно нет policy для authenticated/anon, пишет только
-- сервис-роль из telegram-webhook.

-- 3) telegram_parse_usage — тот же принцип лимита, что у
--    screenshot_parse_usage (schema_milestone25.sql), отдельная таблица,
--    не общий счётчик: текстовый вызов модели на порядок дешевле вызова с
--    картинкой, лимит выше (см. MONTHLY_TELEGRAM_LIMIT в
--    telegram-webhook/index.ts), но всё ещё нужен — активный канал с
--    частыми постами не должен генерировать неограниченный счёт.

create table if not exists public.telegram_parse_usage (
  user_id     uuid not null references auth.users(id) on delete cascade,
  month       text not null, -- 'YYYY-MM', UTC
  count       integer not null default 0,
  updated_at  timestamptz not null default now(),
  primary key (user_id, month)
);

alter table public.telegram_parse_usage enable row level security;

drop policy if exists "select own telegram usage" on public.telegram_parse_usage;
create policy "select own telegram usage" on public.telegram_parse_usage
  for select using (auth.uid() = user_id);

-- Намеренно НЕТ insert/update/delete policy — пишет только сервис-роль из
-- telegram-webhook, тот же принцип и то же известное упрощение (read-then-
-- write не в одной транзакции), что у screenshot_parse_usage.

-- Безопасно перезапускать целиком: create table if not exists,
-- drop+create policy, create index if not exists.
