// Netlify Edge Function: /api/ai → Google Gemini (yanıt akış olarak gelir)
// Gerekli ortam değişkeni: GEMINI_API_KEY  (https://aistudio.google.com/apikey adresinden ücretsiz)
// İsteğe bağlı:
//   GEMINI_MODEL    — önce denenecek model
//   ALLOWED_ORIGIN  — virgülle ayrılmış izinli adresler, örn. https://yayindasin.netlify.app
// Teşhis: tarayıcıda  /api/ai?test=1  aç (her model için süre ve durum gösterir).

const MAX_CHARS = 60000;
// Hız öncelikli sıra: flash-lite hem hızlı hem bu işler için yeterli; yoğunsa diğerlerine geçilir.
const MODELS = {
  default: ['gemini-3.5-flash-lite', 'gemini-3.6-flash', 'gemini-3.1-flash-lite', 'gemini-flash-latest'],
  quick:   ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.6-flash', 'gemini-flash-latest']
};
// Yeni Gemini modelleri varsayılan olarak cevaptan önce "düşünür" ve bu saniyeler sürer.
// Bu uygulamadaki işler (çeviri, kısa metin) için en düşük seviye yeterli.
const THINK = { 'gemini-3.5-flash-lite': 'minimal', 'gemini-3.1-flash-lite': 'minimal', 'gemini-3.6-flash': 'minimal', 'gemini-flash-latest': 'low' };
const HEADER_TIMEOUT_MS = 8000;   // model bu sürede cevaba başlamazsa sıradakine geç
const COOLDOWN_MS = 60000;        // yoğun/kotası dolmuş modeli bu süre atla
const API = 'https://generativelanguage.googleapis.com/v1beta/models/';

const env = k => (globalThis.Netlify && Netlify.env.get(k)) || '';
const json = (status, body) =>
  new Response(JSON.stringify(body, null, 1), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
const norm = s => String(s || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');

// Aynı sunucu örneğinde son hataları hatırla (örnekler bir süre canlı kalır)
const sick = new Map();      // model → tekrar denenebileceği zaman
const noThink = new Set();   // düşünme ayarını kabul etmeyen modeller

function modelList(tier) {
  const base = MODELS[tier] || MODELS.default;
  const first = env('GEMINI_MODEL');
  const list = first ? [first, ...base.filter(m => m !== first)] : base;
  const now = Date.now();
  // sağlıklılar önce, yoğun olanlar sona
  return [...list.filter(m => !(sick.get(m) > now)), ...list.filter(m => sick.get(m) > now)];
}

function payload(messages, wantJson, model, withThink = true) {
  const level = withThink && !noThink.has(model) ? THINK[model] : null;
  return {
    contents: messages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(m.content || '') }]
    })),
    generationConfig: {
      temperature: 0.9,
      maxOutputTokens: 16384,
      ...(wantJson ? { responseMimeType: 'application/json' } : {}),
      ...(level ? { thinkingConfig: { thinkingLevel: level } } : {})
    }
  };
}

const tryNext = s => s === 400 || s === 403 || s === 404 || s === 408 || s === 429 || s >= 500;

// Tek modele istek; düşünme ayarı reddedilirse ayarsız bir kez daha dener
async function callModel(m, key, messages, wantJson, stream) {
  const url = API + m + (stream ? ':streamGenerateContent?alt=sse' : ':generateContent');
  let retriedWithoutThink = false;
  for (const withThink of [true, false]) {
    if (!withThink && !retriedWithoutThink) break; // ikinci tur sadece düşünme ayarı reddedildiyse
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), HEADER_TIMEOUT_MS);
    let r;
    try {
      r = await fetch(url, {
        method: 'POST', signal: ac.signal,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(payload(messages, wantJson, m, withThink))
      });
    } catch (e) {
      clearTimeout(timer);
      return { status: 408, err: ac.signal.aborted ? `${HEADER_TIMEOUT_MS / 1000} sn içinde cevap başlamadı` : e.message };
    }
    clearTimeout(timer);
    if (r.ok) return { r };
    const t = (await r.text()).slice(0, 300);
    if (r.status === 400 && withThink && THINK[m] && !noThink.has(m) && /thinking/i.test(t)) { noThink.add(m); retriedWithoutThink = true; continue; }
    return { status: r.status, err: t };
  }
  return { status: 400, err: 'istek reddedildi' };
}

async function diagnose(key) {
  const out = { anahtar_tanimli: !!key, izinli_adres: env('ALLOWED_ORIGIN') || '(tanımlı değil — her yerden çalışır)', modeller: {} };
  if (!key) return out;
  const all = [...new Set([...MODELS.default, ...MODELS.quick])];
  await Promise.all(all.map(async m => {
    const t0 = Date.now();
    const res = await callModel(m, key, [{ role: 'user', content: 'Sadece "tamam" yaz.' }], false, false);
    const ms = Date.now() - t0;
    if (res.r) { await res.r.text(); out.modeller[m] = `ÇALIŞIYOR · ${ms} ms${noThink.has(m) ? ' (düşünme ayarı desteklenmiyor)' : ''}`; }
    else out.modeller[m] = `HATA ${res.status} · ${ms} ms: ${String(res.err).slice(0, 140)}`;
  }));
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

  let upstream = null, used = '', lastStatus = 502, lastErr = '';
  const t0 = Date.now();
  for (const m of modelList(body.tier === 'quick' ? 'quick' : 'default')) {
    const res = await callModel(m, key, messages, !!body.json, true);
    if (res.r) { upstream = res.r; used = m; sick.delete(m); break; }
    lastStatus = res.status; lastErr = res.err;
    console.log(`Gemini ${m} → ${res.status} ${String(res.err).slice(0, 200)}`);
    if (res.status === 429 || res.status === 408 || res.status >= 500) sick.set(m, Date.now() + COOLDOWN_MS);
    if (!tryNext(res.status)) break;
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
  let buf = '';
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
  return new Response(stream, { headers: {
    'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store',
    'X-AI-Model': used, 'X-AI-Wait-Ms': String(Date.now() - t0)
  } });
};

export const config = { path: '/api/ai' };
