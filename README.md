# Yayındasın

Spikerlik ve sunuculuk eğitim simülasyonu.

- `public/` — site (Netlify bunu yayınlar)
- `netlify/edge-functions/ai.js` — yapay zekâ (Google Gemini)
- `public/cloud.js` + `supabase/setup.sql` — hesaplar, bulut kayıtları, eğitmen paneli (Supabase)

## Yapay zekâ
Netlify → Environment variables: `GEMINI_API_KEY` (https://aistudio.google.com/apikey), isteğe bağlı `ALLOWED_ORIGIN`.
Teşhis: `https://SITEN.netlify.app/api/ai?test=1`

## Bulut kayıtları (Supabase)
1. https://supabase.com → New project (bölge: Frankfurt / eu-central-1).
2. SQL Editor → New query → `supabase/setup.sql` dosyasının tamamını yapıştır → Run.
3. Eğitmeni belirle (SQL Editor):
   `insert into public.trainers (email) values ('egitmen@ornek.com') on conflict do nothing;`
   Eğitmeni kaldırmak: `delete from public.trainers where email = 'egitmen@ornek.com';`
4. Authentication → URL Configuration → Site URL: `https://SITEN.netlify.app`
5. (Önerilir) Authentication → Sign In / Providers → Email → "Confirm email" kapat.
   Supabase'in ücretsiz e-posta gönderimi saatte birkaç e-postayla sınırlı.
6. Project Settings → API (veya "Connect"): Project URL ve anon/publishable anahtarı `public/config.js` içine yaz.
   `service_role` / `secret` anahtarını ASLA bu dosyaya yazma.

Ücretsiz plan: 1 GB dosya, ayda 5 GB izleme, dosya başına 50 MB. Proje 1 hafta kullanılmazsa uykuya alınır;
Supabase panelinden "Restore" ile uyandırılır.

## Yerelde çalıştırma
```
npm i -g netlify-cli
netlify dev
```
