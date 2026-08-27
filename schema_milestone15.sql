-- Milestone 15: убираем модель "запрос → одобрение" для доступа к каналу.
--
-- Было (milestone12+14): владелец приглашал email (channel_invites),
-- приглашённый мог ПОДАТЬ ЗАЯВКУ (channel_members, status='pending'), а
-- владелец отдельно одобрял/отклонял её на странице "Доступ к каналу".
--
-- По просьбе пользователя сам шаг "запросить доступ" убран целиком: раз
-- владелец уже пригласил конкретный email — это и есть его решение.
-- Приглашённый просто нажимает "Принять" на своей странице и сразу
-- становится редактором (channel_members вставляется сразу со
-- status='approved'), без промежуточного review-шага и без кнопок
-- "Одобрить"/"Отклонить" у владельца. Отозвать доступ владелец по-прежнему
-- может в любой момент (см. milestone12: "channel_members: owner revokes").
--
-- Требует применённых schema_milestone12.sql и schema_milestone14.sql.

-- Сохраняем удобное отображаемое имя канала прямо в приглашении — чтобы
-- страница "Приглашения для тебя" могла показать его без похода в profiles
-- (профиль владельца может быть не публичным и недоступен на select).
alter table public.channel_invites add column if not exists channel_label text;

-- Старая insert-политика channel_members требовала status='pending' —
-- теперь заявитель вставляет сразу status='approved' (это и есть "принять
-- приглашение"), но по-прежнему только если для этого owner_user_id+channel
-- существует приглашение на его email (auth.email()) — та же защита от
-- "любой может стать редактором чего угодно", что и раньше.
drop policy if exists "channel_members: request access only if invited" on public.channel_members;
drop policy if exists "channel_members: request access" on public.channel_members;
create policy "channel_members: accept invite (auto-approved)"
  on public.channel_members for insert
  with check (
    auth.uid() = member_user_id
    and status = 'approved'
    and exists (
      select 1 from public.channel_invites ci
      where ci.owner_user_id = channel_members.owner_user_id
        and ci.channel = channel_members.channel
        and lower(ci.invited_email) = lower(coalesce(auth.email(), ''))
    )
  );

-- "channel_members: owner decides" (update, из milestone12) больше не
-- используется UI (нечего одобрять/отклонять постфактум), но оставлена как
-- есть — она безвредна и может пригодиться, если понадобится ручная правка.
