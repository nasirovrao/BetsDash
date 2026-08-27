-- Milestone 9: логотип канала на публичном профиле.
-- Требует, чтобы schema_milestone7.sql (таблица profiles) уже был выполнен.
--
-- Добавляет:
--   1. Колонку profiles.logo_url — публичная ссылка на загруженную картинку.
--   2. Бакет Storage "profile-logos" (публичное чтение), куда пользователь
--      сам загружает файл со страницы "Публичный профиль".
--   3. RLS-политики на storage.objects: загружать/менять/удалять можно
--      только файлы в своей собственной папке вида <user_id>/логотип.png —
--      это гарантирует, что один пользователь не сможет затереть или
--      удалить логотип другого.

alter table public.profiles add column if not exists logo_url text;

insert into storage.buckets (id, name, public)
values ('profile-logos', 'profile-logos', true)
on conflict (id) do nothing;

drop policy if exists "profile logos: owner can upload" on storage.objects;
create policy "profile logos: owner can upload"
on storage.objects for insert
with check (
  bucket_id = 'profile-logos'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "profile logos: owner can update" on storage.objects;
create policy "profile logos: owner can update"
on storage.objects for update
using (
  bucket_id = 'profile-logos'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "profile logos: owner can delete" on storage.objects;
create policy "profile logos: owner can delete"
on storage.objects for delete
using (
  bucket_id = 'profile-logos'
  and (storage.foldername(name))[1] = auth.uid()::text
);

-- Бакет и так публичный (public = true в storage.buckets), но явная select-
-- политика не помешает — на случай, если позже потребуется читать объекты
-- не через публичный URL, а через клиент с RLS (например signed URL).
drop policy if exists "profile logos: public read" on storage.objects;
create policy "profile logos: public read"
on storage.objects for select
using (bucket_id = 'profile-logos');
