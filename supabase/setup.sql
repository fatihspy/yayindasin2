-- ============================================================
-- Yayındasın — Supabase kurulumu
-- Supabase panelinde: SQL Editor → New query → bu dosyanın tamamını yapıştır → Run
-- Tekrar çalıştırmak güvenlidir.
-- ============================================================

-- 1) Öğrenci profilleri (eğitmen panelinde ad görünsün diye)
create table if not exists public.profiles (
  id           uuid primary key references auth.users on delete cascade,
  display_name text not null default '',
  updated_at   timestamptz not null default now()
);

-- 2) Eğitmen listesi (e-posta ile). İstemciden okunamaz, sadece is_trainer() bakar.
create table if not exists public.trainers (
  email text primary key
);

-- 3) Kayıtlar
create table if not exists public.recordings (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users on delete cascade,
  local_id    text not null,
  title       text not null default '',
  kind        text not null check (kind in ('ses','video','foto')),
  src         text,
  dur         real,
  rec_date    text,
  cv          boolean not null default false,
  path        text not null,
  mime        text,
  size        bigint,
  shared      boolean not null default false,
  shared_at   timestamptz,
  feedback    text,
  feedback_at timestamptz,
  created_at  timestamptz not null default now(),
  unique (user_id, local_id)
);
create index if not exists recordings_shared_idx on public.recordings (shared, shared_at desc);

-- Eğitmen mi? (giriş yapan kişinin e-postası trainers tablosunda mı)
create or replace function public.is_trainer()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.trainers t
    where lower(t.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

-- Eğitmen geri bildirimi: sadece eğitmen, sadece gönderilmiş kayda yazabilir
create or replace function public.give_feedback(rec uuid, txt text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_trainer() then raise exception 'Sadece eğitmen geri bildirim yazabilir'; end if;
  update public.recordings
     set feedback = nullif(left(trim(txt), 2000), ''), feedback_at = now()
   where id = rec and shared;
end;
$$;

-- ---------- Güvenlik (RLS) ----------
alter table public.profiles   enable row level security;
alter table public.trainers   enable row level security;
alter table public.recordings enable row level security;

drop policy if exists "profil oku"      on public.profiles;
drop policy if exists "profil ekle"     on public.profiles;
drop policy if exists "profil guncelle" on public.profiles;
create policy "profil oku"      on public.profiles for select to authenticated using (id = auth.uid() or public.is_trainer());
create policy "profil ekle"     on public.profiles for insert to authenticated with check (id = auth.uid());
create policy "profil guncelle" on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists "kayit oku"      on public.recordings;
drop policy if exists "kayit ekle"     on public.recordings;
drop policy if exists "kayit guncelle" on public.recordings;
drop policy if exists "kayit sil"      on public.recordings;
create policy "kayit oku"      on public.recordings for select to authenticated using (user_id = auth.uid() or (shared and public.is_trainer()));
create policy "kayit ekle"     on public.recordings for insert to authenticated with check (user_id = auth.uid());
create policy "kayit guncelle" on public.recordings for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "kayit sil"      on public.recordings for delete to authenticated using (user_id = auth.uid());

-- Yetkiler: giriş yapmamış kişi hiçbir şeye erişemez; öğrenci geri bildirim alanını değiştiremez
revoke all on public.profiles, public.trainers, public.recordings from anon;
revoke all on public.trainers from authenticated;
grant select, insert, update on public.profiles to authenticated;
grant select, insert, delete on public.recordings to authenticated;
revoke update on public.recordings from authenticated;
grant update (title, cv, shared, shared_at) on public.recordings to authenticated;
revoke all on function public.is_trainer() from anon;
revoke all on function public.give_feedback(uuid, text) from anon;
grant execute on function public.is_trainer() to authenticated;
grant execute on function public.give_feedback(uuid, text) to authenticated;

-- ---------- Dosya deposu ----------
-- Özel (public değil) depo, dosya başına en fazla 50 MB (ücretsiz plan sınırı)
insert into storage.buckets (id, name, public, file_size_limit)
values ('recordings', 'recordings', false, 52428800)
on conflict (id) do update set public = false, file_size_limit = 52428800;

drop policy if exists "kendi dosyam oku"   on storage.objects;
drop policy if exists "kendi dosyam yukle" on storage.objects;
drop policy if exists "kendi dosyam sil"   on storage.objects;
drop policy if exists "egitmen gonderileni okur" on storage.objects;
create policy "kendi dosyam oku"   on storage.objects for select to authenticated
  using (bucket_id = 'recordings' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "kendi dosyam yukle" on storage.objects for insert to authenticated
  with check (bucket_id = 'recordings' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "kendi dosyam sil"   on storage.objects for delete to authenticated
  using (bucket_id = 'recordings' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "egitmen gonderileni okur" on storage.objects for select to authenticated
  using (bucket_id = 'recordings' and public.is_trainer()
         and exists (select 1 from public.recordings r where r.path = storage.objects.name and r.shared));

-- ============================================================
-- EĞİTMENİ BELİRLE: aşağıdaki satırdaki e-postayı eğitmenin e-postasıyla değiştir,
-- satırın başındaki "--" işaretini sil ve sadece bu satırı seçip Run'a bas.
-- insert into public.trainers (email) values ('egitmen@ornek.com') on conflict do nothing;
-- ============================================================
