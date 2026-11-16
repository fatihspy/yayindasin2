-- ============================================================
-- Yayındasın — ilerlemenin cihazlar arası eşitlenmesi
-- Supabase → SQL Editor → New query → tamamını yapıştır → Run. Tekrar çalıştırmak güvenlidir.
-- ============================================================

-- Her öğrenciye bir satır: XP, tamamlanan görevler, skorlar, CV, kendi metinleri vb. (JSON)
create table if not exists public.progress (
  user_id    uuid primary key default auth.uid() references auth.users on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
-- Sürüm numarası: iki cihaz aynı anda yazarsa biri reddedilir ve yeniden birleştirip yazar (puan kaybolmaz)
alter table public.progress add column if not exists rev bigint not null default 0;

-- Bir öğrencinin ilerlemesi en fazla ~300 KB olabilir (kötüye kullanıma karşı)
alter table public.progress drop constraint if exists progress_size;
alter table public.progress add constraint progress_size check (pg_column_size(data) < 300000);

alter table public.progress enable row level security;

-- Herkes sadece KENDİ ilerlemesini okur ve yazar
drop policy if exists "ilerleme oku"      on public.progress;
drop policy if exists "ilerleme ekle"     on public.progress;
drop policy if exists "ilerleme guncelle" on public.progress;
create policy "ilerleme oku"      on public.progress for select to authenticated using (user_id = auth.uid());
create policy "ilerleme ekle"     on public.progress for insert to authenticated with check (user_id = auth.uid());
create policy "ilerleme guncelle" on public.progress for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

revoke all on public.progress from anon;
grant select, insert, update on public.progress to authenticated;
