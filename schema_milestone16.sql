-- Milestone 16: чиним рассинхрон между реальными значениями "Тип ставки" в
-- форме (app.html, <select id="f_type">) и CHECK-ограничением в базе.
--
-- Форма СЕЙЧАС отправляет одно из: '', 'Pre', 'Live', 'Хедж' (см. app.html,
-- <option value="Pre">Pre</option> и т.д.). Но исходное ограничение из
-- schema.sql было написано под другие, более длинные названия —
-- ('Pre-value','Live value','Хедж','Попанская') — и с тех пор ни разу не
-- обновлялось (в отличие от result, который чинили в milestone3, добавляя
-- 'Sold'). Итог на проде: сохранить ставку с типом "Pre" или "Live" сейчас
-- невозможно — insert/update падает по CHECK bets_bet_type_check.
--
-- ВАЖНО про порядок операций (первые две версии этой миграции падали
-- именно из-за него):
--   v1 сразу меняла ограничение на строгое ('Pre','Live','Хедж' и всё) —
--      падала, потому что в базе уже были старые строки с длинными
--      значениями ('Pre-value' и т.п.), а ALTER TABLE ADD CONSTRAINT по
--      умолчанию проверяет ВСЕ существующие строки.
--   v2 добавила NOT VALID (чтобы не проверять старые строки) — но СНАЧАЛА
--      делала UPDATE, переводящий 'Pre-value' → 'Pre', а СТАРОЕ строгое
--      ограничение (которое на тот момент ещё действовало — ALTER шёл
--      ПОСЛЕ update) 'Pre' не разрешало. Тот же самый CHECK ловил уже сам
--      UPDATE, а не ALTER — отсюда вторая ошибка ("new row ... violates
--      check constraint", с указанием конкретной "упавшей" строки).
--   Эта версия сначала меняет ограничение (сразу разрешает и старые, и
--      новые варианты), и только потом — когда писать в базу можно уже что
--      угодно из обоих списков — нормализует старые длинные значения в
--      короткие. Порядок именно такой: ALTER, потом UPDATE.
--
-- Если хочешь позже проверить, что осталось нераспознанным:
--   select bet_type, count(*) from public.bets group by bet_type order by 2 desc;
--
-- Безопасно выполнять повторно.

alter table public.bets drop constraint if exists bets_bet_type_check;
alter table public.bets add constraint bets_bet_type_check
  check (bet_type is null or bet_type in ('Pre','Live','Хедж','Pre-value','Live value','Попанская')) not valid;

update public.bets set bet_type = 'Pre' where bet_type = 'Pre-value';
update public.bets set bet_type = 'Live' where bet_type = 'Live value';
