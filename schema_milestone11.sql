-- Milestone 11: конкретика вместо общей фразы в бейдже "✎ изменено".
--
-- Раньше тултип бейджа объяснял только КОГДА строку трогали (две даты:
-- "рассчитана ... / последняя правка ..."), а само пояснение на публичном
-- профиле было длинным абзацем текста. Это и есть та "громоздкость", от
-- которой просили уйти.
--
-- Теперь триггер сам считает короткий diff по значимым полям ставки
-- (пик / результат / кэф / сумма) и пишет его в новую колонку edit_note —
-- например: "пик: П1 → П2". Именно ЭТО показываем в бейдже, а не даты.
--
-- Упрощение сознательное: храним только ПОСЛЕДНИЙ diff, а не полную историю
-- правок — полноценный журнал изменений это отдельная, более тяжёлая фича
-- (нужна была бы отдельная таблица bet_edit_log), а тут нужен был именно
-- лёгкий сигнал доверия, не аудит.
--
-- Требует, чтобы schema_milestone10.sql (updated_at/settled_at + сам
-- триггер) уже был применён — эта миграция дополняет ту же функцию.

alter table public.bets add column if not exists edit_note text;

create or replace function public.bets_touch_timestamps()
returns trigger as $$
declare
  parts text[] := '{}';
begin
  if TG_OP = 'INSERT' then
    NEW.updated_at := now();
    if NEW.result <> 'Pending' then
      NEW.settled_at := now();
    end if;
    return NEW;

  elsif TG_OP = 'UPDATE' then
    NEW.updated_at := now();

    -- settled_at по-прежнему выставляется один раз, при первом уходе из
    -- Pending (см. milestone10) — эту часть логики не меняем.
    if OLD.result = 'Pending' and NEW.result <> 'Pending' and OLD.settled_at is null then
      NEW.settled_at := now();
    end if;

    -- Diff считаем, только если исход УЖЕ был известен ДО этой правки
    -- (settled_at уже стоял) — именно этот случай и нужно объяснять
    -- конкретно. Правки живой (ещё Pending) ставки — нормальная работа,
    -- diff для них не пишем.
    if OLD.settled_at is not null then
      if OLD.pick is distinct from NEW.pick then
        parts := parts || format('пик: %s → %s', OLD.pick, NEW.pick);
      end if;
      if OLD.result is distinct from NEW.result then
        parts := parts || format('результат: %s → %s', OLD.result, NEW.result);
      end if;
      if OLD.odds is distinct from NEW.odds then
        parts := parts || format('кэф: %s → %s', OLD.odds, NEW.odds);
      end if;
      if OLD.stake is distinct from NEW.stake then
        parts := parts || format('сумма: %s → %s', OLD.stake, NEW.stake);
      end if;
      if array_length(parts, 1) > 0 then
        NEW.edit_note := array_to_string(parts, '; ');
      end if;
      -- Если ни одно из значимых полей не изменилось (поправили, скажем,
      -- только заметку) — edit_note НЕ трогаем: пусть остаётся diff
      -- предыдущей значимой правки, а не затирается пустотой.
    end if;

    return NEW;
  end if;
  return NEW;
end;
$$ language plpgsql;

-- Триггер уже висит на таблице с milestone10 (before insert or update,
-- for each row) — пересоздавать не нужно, create or replace function
-- выше меняет его поведение сразу.
