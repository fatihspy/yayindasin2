-- ============================================================
-- Yayındasın — KVKK: rıza kayıtları, rızasız kayıt yüklemeyi engelleme, hesap silme
-- setup.sql, guvenlik-guncelleme.sql ve ilerleme.sql'den SONRA çalıştır. Tekrar çalıştırmak güvenlidir.
-- ============================================================

-- 1) Profilde rıza durumu
alter table public.profiles add column if not exists kvkk_version     text;
alter table public.profiles add column if not exists kvkk_at          timestamptz;
alter table public.profiles add column if not exists age_ok           boolean;
alter table public.profiles add column if not exists media_consent_at timestamptz;

-- Rıza alanlarını istemci doğrudan değiştiremez; sadece record_consent() (sunucu saatiyle) değiştirir
revoke insert, update on public.profiles from authenticated;
grant insert (id, display_name, updated_at) on public.profiles to authenticated;
grant update (id, display_name, updated_at) on public.profiles to authenticated;  -- id: upsert için; RLS başkasının id'sini engeller

-- 2) Rıza geçmişi (ne zaman, hangi sürüme, verildi mi geri mi alındı)
create table if not exists public.consent_log (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users on delete cascade,
  kind       text not null check (kind in ('kvkk', 'media', 'age')),
  granted    boolean not null,
  version    text,
  created_at timestamptz not null default now()
);
alter table public.consent_log enable row level security;
drop policy if exists "riza gecmisim" on public.consent_log;
create policy "riza gecmisim" on public.consent_log for select to authenticated using (user_id = auth.uid());
revoke all on public.consent_log from anon, authenticated;
grant select on public.consent_log to authenticated;

-- Aydınlatma metnini okuduğunu onayla + yaş beyanı + ses/görüntü için açık rıza (ver ya da geri al)
create or replace function public.record_consent(kvkk text, age boolean, media boolean)
returns void language plpgsql security definer set search_path = public as $$
declare had_media boolean;
begin
  if auth.uid() is null then raise exception 'Giriş gerekli'; end if;
  insert into public.profiles (id, display_name) values (auth.uid(), '') on conflict (id) do nothing;
  select media_consent_at is not null into had_media from public.profiles where id = auth.uid();
  update public.profiles set
    kvkk_version = coalesce(kvkk, kvkk_version),
    kvkk_at = case when kvkk is not null then now() else kvkk_at end,
    age_ok = coalesce(age, age_ok),
    media_consent_at = case when media then coalesce(media_consent_at, now()) else null end
  where id = auth.uid();
  if kvkk is not null then insert into public.consent_log (user_id, kind, granted, version) values (auth.uid(), 'kvkk', true, kvkk); end if;
  if age is not null then insert into public.consent_log (user_id, kind, granted, version) values (auth.uid(), 'age', age, kvkk); end if;
  if media is distinct from had_media then insert into public.consent_log (user_id, kind, granted, version) values (auth.uid(), 'media', media, kvkk); end if;
end;
$$;
revoke all on function public.record_consent(text, boolean, boolean) from public, anon;
grant execute on function public.record_consent(text, boolean, boolean) to authenticated;

-- 3) Rıza yoksa kayıt yüklenemez (hem kayıt satırı hem dosya) — sunucu tarafında da zorunlu
create or replace function public.has_media_consent()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and media_consent_at is not null);
$$;
revoke all on function public.has_media_consent() from public, anon;
grant execute on function public.has_media_consent() to authenticated;

drop policy if exists "kayit ekle" on public.recordings;
create policy "kayit ekle" on public.recordings for insert to authenticated
  with check (user_id = auth.uid() and public.has_media_consent());

drop policy if exists "kendi dosyam yukle" on storage.objects;
create policy "kendi dosyam yukle" on storage.objects for insert to authenticated
  with check (bucket_id = 'recordings'
              and (storage.foldername(name))[1] = auth.uid()::text
              and public.my_storage_bytes() < 100 * 1024 * 1024
              and public.has_media_consent());

-- 4) Hesabı ve bütün verileri silme
--    Dosyalar uygulama tarafından önce depodan silinir (Supabase dosyaları SQL ile silmeye izin vermez),
--    sonra bu fonksiyon hesabı siler; profil, kayıt listesi, ilerleme, rıza geçmişi, eğitmenlik zincirleme silinir.
create or replace function public.delete_my_account()
returns void language plpgsql security definer set search_path = public, auth as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'Giriş gerekli'; end if;
  delete from public.ai_usage where k = 'u:' || uid::text;
  delete from auth.users where id = uid;
end;
$$;
revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;

-- ============================================================
-- NOT: Bu dosyayı çalıştırdıktan sonra mevcut kullanıcılar bir sonraki girişlerinde
-- aydınlatma metnini onaylayıp ses/görüntü rızası verene kadar yeni kayıt yükleyemez.
-- ============================================================
