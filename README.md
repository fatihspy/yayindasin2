# Yayındasın

Spikerlik ve sunuculuk eğitim simülasyonu.

- `public/` — site (Netlify bunu yayınlar)
- `netlify/edge-functions/ai.js` — yapay zekâ (Google Gemini)
- `public/cloud.js` + `supabase/setup.sql` — hesaplar, bulut kayıtları, eğitmen paneli (Supabase)

## Yapay zekâ
Netlify → Environment variables:
- `GEMINI_API_KEY` — https://aistudio.google.com/apikey
- `ALLOWED_ORIGIN` — `https://SITEN.netlify.app`
- `SUPABASE_URL`, `SUPABASE_ANON_KEY` — `public/config.js` ile aynı değerler (günlük kullanım sınırı için)
- `DIAG_KEY` — teşhis sayfasının şifresi (rastgele uzun bir kelime)
- İsteğe bağlı: `AI_USER_DAILY` (varsayılan 300), `AI_GUEST_DAILY` (varsayılan 150)

Teşhis: `https://SITEN.netlify.app/api/ai?test=DIAG_KEY`

## Bulut kayıtları (Supabase)
1. https://supabase.com → New project (bölge: Frankfurt / eu-central-1).
2. SQL Editor → New query → `supabase/setup.sql` dosyasının tamamını yapıştır → Run.
3. `supabase/guvenlik-guncelleme.sql` dosyasını da aynı şekilde çalıştır.
   Eğitmeni belirle (eğitmen siteye hesap açtıktan SONRA):
   `insert into public.trainer_users (user_id) select id from auth.users where email = 'egitmen@ornek.com' on conflict do nothing;`
4. Authentication → URL Configuration → Site URL: `https://SITEN.netlify.app`
5. E-posta onayı: Authentication → Sign In / Providers → Email → "Confirm email".
   Kapalıysa herkes istediği e-postayla hesap açabilir (eğitmen artık hesap kimliğiyle eklendiği için yetki riski yok,
   ama sahte hesap açılabilir). En güvenlisi: özel SMTP (ör. Resend, ücretsiz katmanı var) bağlayıp onayı açmak.
6. Project Settings → API (veya "Connect"): Project URL ve anon/publishable anahtarı `public/config.js` içine yaz.
   `service_role` / `secret` anahtarını ASLA bu dosyaya yazma.

Ücretsiz plan: 1 GB dosya, ayda 5 GB izleme, dosya başına 50 MB. Proje 1 hafta kullanılmazsa uykuya alınır;
Supabase panelinden "Restore" ile uyandırılır.

## Yerelde çalıştırma
```
npm i -g netlify-cli
netlify dev
```
