# Yayındasın

Spikerlik ve sunuculuk eğitim simülasyonu. Statik site (`public/`) + yapay zekâ için bir Netlify Edge Function (`netlify/edge-functions/ai.js` → Google Gemini, yanıt akış olarak gelir).

## Kurulum
1. Bu klasörü GitHub'a yükle (`netlify.toml` repo kökünde olmalı).
2. Netlify → Add new site → Import an existing project → GitHub → repoyu seç → Deploy.
3. Site configuration → Environment variables:
   - `GEMINI_API_KEY` = https://aistudio.google.com/apikey adresinden aldığın anahtar
   - `ALLOWED_ORIGIN` = sitenin adresi, örn. `https://yayindasin.netlify.app` (isteğe bağlı)
4. Deploys → Trigger deploy → Deploy site.

## Teşhis
Tarayıcıda `https://SITEN.netlify.app/api/ai?test=1` aç: anahtarın tanımlı olup olmadığını ve hangi modellerin çalıştığını gösterir.

## Yerelde çalıştırma
```
npm i -g netlify-cli
netlify dev
```
