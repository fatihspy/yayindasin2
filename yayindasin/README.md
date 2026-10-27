# Yayındasın

Spikerlik ve sunuculuk eğitim simülasyonu. Statik site (`public/`) + yapay zekâ için tek bir Netlify fonksiyonu (`netlify/functions/ai.mjs` → Google Gemini).

## Kurulum
1. Bu klasörü GitHub'a yükle.
2. Netlify → Add new site → Import an existing project → GitHub → repoyu seç → Deploy.
3. Site configuration → Environment variables:
   - `GEMINI_API_KEY` = https://aistudio.google.com/apikey adresinden aldığın anahtar
   - `ALLOWED_ORIGIN` = sitenin adresi, örn. `https://yayindasin.netlify.app` (isteğe bağlı ama önerilir)
4. Deploys → Trigger deploy → Deploy site.

## Yerelde çalıştırma
```
npm i -g netlify-cli
netlify dev
```
