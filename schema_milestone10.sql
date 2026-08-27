-- Milestone 10: лёгкий "tamper-evidence" сигнал доверия для публичного
-- профиля — метка, когда ставка добавлена/расчитана, и флаг, если её
-- меняли уже ПОСЛЕ того, как исход стал известен.
--
-- Это не криптографическое доказательство (клиент технически всё ещё
-- может отредактировать ставку до того, как выставит ей результат — это
-- нормально, ставка живая, пока Pending) — но оно ловит ровно тот паттерн,
-- которым обычно грешат "капперы": тихо переписать историю ПОСЛЕ того,
-- как матч уже прошёл и результат известен.
--
-- Логика:
--   • updated_at — трогается на КАЖДОЕ изменение строки (insert и update).
--   • settled_at — проставляется ОДИН РАЗ, в момент первого перехода
--     result: 'Pending' → что угодно другое (или сразу при вставке, если
--     ставка изначально вносится уже не как Pending). Дальше не меняется.
--   • На фронте флаг "изменено после расчёта" = settled_at не пуст И
--     updated_at заметно (>5 сек) позже settled_at — то есть после того,
--     как результат уже был зафиксирован, строку трогали ЕЩЁ раз.

alter table public.bets add column if not exists updated_at timestamptz not null default now();
alter table public.bets add column if not exists settled_at timestamptz;

create or replace function public.bets_touch_timestamps()
returns trigger as $$
begin
  if TG_OP = 'INSERT' then
    NEW.updated_at := now();
    if NEW.result <> 'Pending' then
      NEW.settled_at := now();
    end if;
    return NEW;
  elsif TG_OP = 'UPDATE' then
    NEW.updated_at := now();
    -- settled_at выставляется только один раз — при первом уходе из Pending.
    -- Если он уже стоит, триггер его больше не трогает (даже если результат
    -- меняется туда-сюда), чтобы дальнейшие правки было видно как разрыв
    -- между settled_at (когда исход стал известен) и updated_at (когда
    -- строку тронули в последний раз).
    if OLD.result = 'Pending' and NEW.result <> 'Pending' and OLD.settled_at is null then
      NEW.settled_at := now();
    end if;
    return NEW;
  end if;
  return NEW;
end;
$$ language plpgsql;

drop trigger if exists trg_bets_touch_timestamps on public.bets;
create trigger trg_bets_touch_timestamps
  before insert or update on public.bets
  for each row execute function public.bets_touch_timestamps();
