-- ============================================================
-- CyberValue / EDGE — миграция Milestone 3
-- Нужна для переноса истории из старого журнала: там есть статусы и поля,
-- которых не было в исходной схеме (досрочная продажа ставки, заметки,
-- оценка вероятности, дата фактического размещения ставки).
-- Вставь целиком в Supabase → SQL Editor → New query → Run.
-- Безопасно выполнять повторно — везде if not exists / or replace.
-- ============================================================

-- "Sold" — ставка продана/закрыта досрочно, финальный профит в этом случае
-- не считается по формуле (stake * (odds-1)), а берётся из manual_profit.
alter table public.bets drop constraint if exists bets_result_check;
alter table public.bets add constraint bets_result_check
  check (result in ('Win','Loss','Push','Pending','Sold'));

alter table public.bets add column if not exists manual_profit numeric;
alter table public.bets add column if not exists notes text;
alter table public.bets add column if not exists est_prob numeric check (est_prob is null or (est_prob >= 0 and est_prob <= 1));
alter table public.bets add column if not exists date_added date;
