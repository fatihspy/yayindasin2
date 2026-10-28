// Netlify Edge Function: /api/ai → Google Gemini (yanıt akış olarak gelir)
// Gerekli ortam değişkeni: GEMINI_API_KEY  (https://aistudio.google.com/apikey adresinden ücretsiz)
// İsteğe bağlı:
//   GEMINI_MODEL    — önce denenecek model (varsayılan aşağıdaki listede)
//   ALLOWED_ORIGIN  — virgülle ayrılmış izinli adresler, örn. https://yayindasin.netlify.app
// Teşhis: tarayıcıda  /api/ai?test=1  aç.

const MAX_CHARS = 60000;
// Ücretsiz katmanda olan modeller; ilki çalışmazsa sıradakine geçilir.
const MODELS = {
  default: ['gemini-3.6-flash', 'gemini-flash-latest', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'],
  quick: ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.6-flash', 'gemini-flash-latest']
};
const API = 'https://generativelanguage.googleapis.com/v1beta/models/';

const env = k => (globalThis.Netlify && Netlify.env.get(k)) || '';
const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
const norm = s => String(s || '').trim().replace(/\/+$/, '').toLowerCase();

function modelList(tier) {
  const base = MODELS[tier] || MODELS.default;
  const first = env('GEMINI_MODEL');
  return first ? [first, ...base.filter(m => m !== first)] : base;
}

function payload(messages, wantJson) {
  return {
    contents: messages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(m.content || '') }]
    })),
    generationConfig: {
      temperature: 0.9,
      maxOutputTokens: 16384,
      ...(wantJson ? { responseMimeType: 'application/json' } : {})
    }
  };
}

// Model bulunamadı / bu hesaba kapalı / kota doldu → sıradaki modeli dene
const tryNext = s => s === 400 || s === 403 || s === 404 || s === 429;

async function diagnose(key) {
  const out = { anahtar_tanimli: !!key, izinli_adres: env('ALLOWED_ORIGIN') || '(tanımlı değil — her yerden çalışır)', modeller: {} };
  if (!key) return out;
  for (const m of [...new Set([...modelList('default'), ...modelList('quick')])]) {
    try {
      const r = await fetch(API + m + ':generateContent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(payload([{ role: 'user', content: 'Sadece "tamam" yaz.' }], false))
      });
      const t = await r.text();
      out.modeller[m] = r.ok ? 'ÇALIŞIYOR' : `HATA ${r.status}: ${t.slice(0, 160)}`;
    } catch (e) {
      out.modeller[m] = 'Ulaşılamadı: ' + e.message;
    }
  }
  return out;
}

export default async (req) => {
  const key = env('GEMINI_API_KEY');
  const url = new URL(req.url);

  if (req.method === 'GET') {
    if (url.searchParams.get('test')) return json(200, await diagnose(key));
    return json(405, { error: 'Sadece POST', code: 'unavailable' });
  }
  if (req.method !== 'POST') return json(405, { error: 'Sadece POST', code: 'unavailable' });

  const allowed = env('ALLOWED_ORIGIN').split(',').map(norm).filter(Boolean);
  const origin = norm(req.headers.get('origin'));
  if (allowed.length && origin && !allowed.includes(origin) && origin !== norm(url.origin)) {
    return json(403, { error: 'Bu adresten istek kabul edilmiyor: ' + origin, code: 'unavailable' });
  }
  if (!key) return json(500, { error: 'GEMINI_API_KEY tanımlı değil', code: 'unavailable' });

  let body;
  try { body = await req.json(); } catch { return json(400, { error: 'Geçersiz istek', code: 'unavailable' }); }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const total = messages.reduce((n, m) => n + String(m.content || '').length, 0);
  if (!messages.length || total > MAX_CHARS) return json(400, { error: 'İstek boş ya da çok uzun', code: 'unavailable' });

  const reqBody = JSON.stringify(payload(messages, !!body.json));
  let upstream = null, lastStatus = 502, lastErr = '';
  for (const m of modelList(body.tier === 'quick' ? 'quick' : 'default')) {
    try {
      const r = await fetch(API + m + ':streamGenerateContent?alt=sse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: reqBody
      });
      if (r.ok) { upstream = r; break; }
      lastStatus = r.status; lastErr = (await r.text()).slice(0, 300);
      console.log(`Gemini ${m} → ${r.status} ${lastErr}`);
      if (!tryNext(r.status)) break;
    } catch (e) {
      lastErr = e.message;
    }
  }
  if (!upstream) {
    return json(lastStatus === 429 ? 429 : 502, {
      error: lastStatus === 429 ? 'Ücretsiz kullanım sınırı doldu' : 'Gemini hatası ' + lastStatus,
      detail: lastErr, code: lastStatus === 429 ? 'rate_limited' : 'unavailable'
    });
  }

  // Gemini'nin SSE akışını düz metin akışına çevir
  const enc = new TextEncoder(), dec = new TextDecoder();
  const reader = upstream.body.getReader();
  let buf = ''; // yarım kalan satır bir sonraki parçada tamamlanır
  const textOf = line => {
    if (!line.startsWith('data:')) return '';
    try {
      const d = JSON.parse(line.slice(5));
      const parts = ((((d.candidates || [])[0] || {}).content || {}).parts) || [];
      return parts.filter(p => !p.thought).map(p => p.text || '').join('');
    } catch { return ''; }
  };
  const stream = new ReadableStream({
    async pull(ctrl) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          const rest = textOf(buf.trim()); buf = '';
          if (rest) ctrl.enqueue(enc.encode(rest));
          ctrl.close(); return;
        }
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n'); buf = lines.pop();
        const out = lines.map(l => textOf(l.trim())).join('');
        if (out) { ctrl.enqueue(enc.encode(out)); return; }
      }
    },
    cancel() { try { reader.cancel(); } catch {} }
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
};

export const config = { path: '/api/ai' };
