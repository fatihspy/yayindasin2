-- ============================================================
-- Yayındasın — güvenlik güncellemesi (setup.sql'den SONRA, bir kez çalıştır)
-- Supabase → SQL Editor → New query → tamamını yapıştır → Run. Tekrar çalıştırmak güvenlidir.
-- ============================================================

-- 1) Kayıt satırı sadece kişinin KENDİ klasöründeki dosyayı gösterebilir
--    (önceden bir öğrenci başkasının dosya yolunu yazıp eğitmene gönderebiliyordu)
alter table public.recordings drop constraint if exists recordings_path_owner;
alter table public.recordings add constraint recordings_path_owner
  check (path like user_id::text || '/%') not valid;

-- 2) Metin alanlarına uzunluk sınırı
alter table public.recordings drop constraint if exists recordings_len;
alter table public.recordings add constraint recordings_len check (
  char_length(title) <= 300 and char_length(local_id) <= 80
  and coalesce(char_length(src), 0) <= 20 and coalesce(char_length(rec_date), 0) <= 40
  and coalesce(char_length(mime), 0) <= 100) not valid;
alter table public.profiles drop constraint if exists profiles_len;
alter table public.profiles add constraint profiles_len check (char_length(display_name) <= 80) not valid;

-- 3) Eğitmen artık e-postayla değil HESAP KİMLİĞİYLE tanınır
--    (e-posta onayı kapalıyken eğitmenin e-postasıyla başkası kayıt olup eğitmen olabiliyordu)
create table if not exists public.trainer_users (
  user_id uuid primary key references auth.users on delete cascade
);
alter table public.trainer_users enable row level security;
revoke all on public.trainer_users from anon, authenticated;
-- Daha önce e-postayla eklenmiş ve hesap açmış eğitmenleri taşı
do $$ begin
  if to_regclass('public.trainers') is not null then
    insert into public.trainer_users (user_id)
      select u.id from auth.users u join public.trainers t on lower(t.email) = lower(u.email)
      on conflict do nothing;
  end if;
end $$;

create or replace function public.is_trainer()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.trainer_users where user_id = auth.uid());
$$;

-- Eğitmen sadece "kendi klasöründeki dosyayı gösteren" ve gönderilmiş kayıtların dosyasını okur
drop policy if exists "egitmen gonderileni okur" on storage.objects;
create policy "egitmen gonderileni okur" on storage.objects for select to authenticated
  using (bucket_id = 'recordings' and public.is_trainer()
         and exists (select 1 from public.recordings r
                     where r.path = storage.objects.name and r.shared
                       and r.path like r.user_id::text || '/%'));

-- 4) Kişi başına depolama kotası (varsayılan 100 MB) ve sadece ses/video/fotoğraf dosyası
create or replace function public.my_storage_bytes()
returns bigint language sql stable security definer set search_path = public, storage as $$
  select coalesce(sum((metadata ->> 'size')::bigint), 0) from storage.objects
  where bucket_id = 'recordings' and (storage.foldername(name))[1] = auth.uid()::text;
$$;
revoke all on function public.my_storage_bytes() from anon;
grant execute on function public.my_storage_bytes() to authenticated;

drop policy if exists "kendi dosyam yukle" on storage.objects;
create policy "kendi dosyam yukle" on storage.objects for insert to authenticated
  with check (bucket_id = 'recordings'
              and (storage.foldername(name))[1] = auth.uid()::text
              and public.my_storage_bytes() < 100 * 1024 * 1024);

update storage.buckets
   set allowed_mime_types = array['audio/*', 'video/*', 'image/jpeg', 'image/png', 'image/webp', 'image/heic']
 where id = 'recordings';

-- 5) Yapay zekâ kullanım sınırı (sunucu fonksiyonu çağırır; günlük sayaç)
create table if not exists public.ai_usage (
  k   text not null,
  day date not null default current_date,
  n   int  not null default 0,
  primary key (k, day)
);
alter table public.ai_usage enable row level security;
revoke all on public.ai_usage from anon, authenticated;

-- Giriş yapmışsa hesap başına, yapmamışsa (sunucunun verdiği) cihaz/ağ anahtarı başına sayar.
-- Kalan hakkı döndürür; sınır aşıldıysa -1.
create or replace function public.ai_take(guest_key text, lim_user int, lim_guest int)
returns int language plpgsql security definer set search_path = public as $$
declare key text; lim int; cnt int;
begin
  if auth.uid() is not null then key := 'u:' || auth.uid(); lim := lim_user;
  else
    if guest_key is null or char_length(guest_key) < 16 or char_length(guest_key) > 128 then return -1; end if;
    key := 'g:' || guest_key; lim := lim_guest;
  end if;
  insert into public.ai_usage (k, day, n) values (key, current_date, 1)
    on conflict (k, day) do update set n = public.ai_usage.n + 1
    returning n into cnt;
  if random() < 0.01 then delete from public.ai_usage where day < current_date - 2; end if;
  return case when cnt <= lim then lim - cnt else -1 end;
end;
$$;
revoke all on function public.ai_take(text, int, int) from public;
grant execute on function public.ai_take(text, int, int) to anon, authenticated;

-- Eski e-posta tablosu artık kullanılmıyor
drop table if exists public.trainers;

-- ============================================================
-- KONTROL: aşağıdaki sorgu boş dönmeli (başkasının dosyasını gösteren eski kayıt yok demek)
select id, user_id, path from public.recordings where path not like user_id::text || '/%';

-- EĞİTMEN EKLEME (yeni yöntem): eğitmen siteye hesap açtıktan SONRA çalıştır.
-- Önce Authentication → Users listesinde o e-postanın gerçekten eğitmene ait olduğunu kontrol et.
-- insert into public.trainer_users (user_id) select id from auth.users where email = 'egitmen@ornek.com' on conflict do nothing;
-- Eğitmeni kaldırma:
-- delete from public.trainer_users where user_id = (select id from auth.users where email = 'egitmen@ornek.com');
-- ============================================================
