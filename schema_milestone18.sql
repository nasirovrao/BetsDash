-- ============================================================
-- CyberValue / EDGE — миграция Milestone 18: фикс регрессии в UPDATE-
-- политике на bets (найдено при аудите "какие ещё есть дыры", 28.08.2026).
--
-- ЧТО БЫЛО НЕ ТАК:
-- Milestone 4 когда-то добавил WITH CHECK на "update own bets" — чтобы
-- пользователь не мог, обновляя СВОЮ строку, переписать в ней user_id на
-- чужой (см. комментарий в schema_milestone4.sql). Но Milestone 12 (общий
-- доступ к каналу, редакторы) полностью DROP+CREATE эту политику под новым
-- именем "update own or member bets" — и при пересоздании WITH CHECK
-- потерялся, остался только USING. Фикс milestone4 тихо отменился именно
-- для bets (settings такой же регрессии не словил — там политику никто
-- после milestone4 не трогал).
--
-- К ЧЕМУ ЭТО ВЕЛО НА ПРАКТИКЕ:
-- Теперь, когда есть РЕДАКТОРЫ (Milestone 12, "Доступ к каналу") — не
-- только сам владелец, но и приглашённый им редактор мог технически
-- (напрямую через Supabase REST, не через UI) отправить UPDATE на любую
-- ставку канала, к которому у него есть доступ, и переписать её user_id —
-- например, на СВОЙ собственный id, "угнав" эту ставку к себе в личный
-- дневник. USING разрешал бы такое обновление (строка была в канале,
-- доступном редактору), а WITH CHECK, который должен был бы это
-- остановить, отсутствовал.
--
-- ФИКС, ДВУМЯ СЛОЯМИ (WITH CHECK один в лоб тут не работает — если просто
-- продублировать условие USING в WITH CHECK, редактор, переписавший
-- user_id на СВОЙ auth.uid(), пройдёт проверку "auth.uid() = user_id"
-- тривиально, потому что сам её и подставил):
--   1. Триггер bets_lock_ownership — user_id ЖЁСТКО фиксируется на
--      значение, которое было ДО обновления (NEW.user_id := OLD.user_id),
--      независимо от того, что прислал клиент. Владелец бет-строки
--      теперь в принципе не может смениться через UPDATE — только через
--      DELETE+INSERT, а вставлять новую строку от чужого имени по-прежнему
--      нельзя (see "insert own or member bets", WITH CHECK не менялся).
--   2. channel аналогично можно поменять только настоящему владельцу
--      строки (auth.uid() = OLD.user_id) — редактор, у которого есть
--      доступ только к конкретному каналу, не может молча переложить
--      чужую ставку в другой канал.
--   3. WITH CHECK на самой политике — оставлен как зеркало USING
--      (defense-in-depth): раз триггер снизу уже гарантирует, что
--      user_id/channel не "уедут", эта проверка увидит корректный,
--      "починенный" NEW-ряд и просто ещё раз подтвердит то же самое.
--
-- Требует применённого schema_milestone12.sql (функция has_channel_access,
-- политика "update own or member bets").
-- Вставь целиком в Supabase → SQL Editor → New query → Run.
-- Безопасно выполнять повторно.
-- ============================================================

create or replace function public.bets_lock_ownership()
returns trigger as $$
begin
  -- Владелец строки (user_id) никогда не меняется через UPDATE — ни
  -- владельцем, ни редактором. Единственный способ сменить владельца —
  -- его нет, это по дизайну (бет физически принадлежит тому каналу/
  -- аккаунту, в который его изначально добавили).
  NEW.user_id := OLD.user_id;

  -- channel может менять только настоящий владелец строки. Редактор
  -- (auth.uid() <> OLD.user_id, у него есть доступ только через
  -- has_channel_access) не может молча переложить ставку в другой канал.
  if auth.uid() <> OLD.user_id then
    NEW.channel := OLD.channel;
  end if;

  return NEW;
end;
$$ language plpgsql security invoker;

drop trigger if exists trg_bets_lock_ownership on public.bets;
create trigger trg_bets_lock_ownership
  before update on public.bets
  for each row execute function public.bets_lock_ownership();

-- Defense-in-depth: восстанавливаем WITH CHECK, потерянный в milestone12
-- (после триггера выше NEW.user_id/NEW.channel уже гарантированно верные,
-- так что это условие теперь всегда пройдёт для легитимных обновлений —
-- но политика описывает намерение явно, а не полагается только на триггер).
drop policy if exists "update own or member bets" on public.bets;
create policy "update own or member bets" on public.bets
  for update
  using (auth.uid() = user_id or public.has_channel_access(user_id, channel))
  with check (auth.uid() = user_id or public.has_channel_access(user_id, channel));

-- ---- Проверка после применения ----
-- Как редактор с доступом к чужому каналу (не владелец):
--   update bets set user_id = auth.uid() where id = <любая строка канала>;
--   select user_id from bets where id = <та же строка>;
-- Должно по-прежнему показывать ПРЕЖНЕГО владельца, а не тебя.
