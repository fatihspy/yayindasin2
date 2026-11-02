// Netlify Edge Function: /api/ai → Google Gemini (yanıt akış olarak gelir)
// Gerekli ortam değişkeni: GEMINI_API_KEY  (https://aistudio.google.com/apikey adresinden ücretsiz)
// Önerilen (kötüye kullanımı engeller):
//   SUPABASE_URL, SUPABASE_ANON_KEY — günlük kullanım sınırı için (public/config.js'teki değerlerin aynısı)
//   ALLOWED_ORIGIN  — virgülle ayrılmış izinli adresler, örn. https://yayindasin.netlify.app
//   DIAG_KEY        — teşhis sayfasının şifresi: /api/ai?test=DIAG_KEY
// İsteğe bağlı:
//   AI_USER_DAILY (varsayılan 300), AI_GUEST_DAILY (varsayılan 150), IP_SALT, GEMINI_MODEL

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

// Netlify'da Netlify.env, Cloudflare'de worker/index.js'in her istekte koyduğu globalThis.__YENV
const env = k => (globalThis.Netlify && Netlify.env.get(k)) || (globalThis.__YENV && globalThis.__YENV[k]) || '';
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

// ---------- günlük kullanım sınırı (Supabase'deki ai_take fonksiyonu) ----------
const SB_URL = () => env('SUPABASE_URL').replace(/\/+$/, '');
const SB_KEY = () => env('SUPABASE_ANON_KEY');
async function sha(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 40);
}
// Giriş yapmışsa hesap başına, yapmamışsa IP başına (IP saklanmaz, sadece özeti) sayar.
async function takeQuota(req, context) {
  if (!SB_URL() || !SB_KEY()) return { ok: true, skipped: 'Supabase ayarı yok' };
  const ip = (context && context.ip) || req.headers.get('x-nf-client-connection-ip') || 'bilinmiyor';
  const guest_key = await sha((env('IP_SALT') || 'yayindasin') + '|' + ip);
  const body = JSON.stringify({ guest_key, lim_user: +env('AI_USER_DAILY') || 300, lim_guest: +env('AI_GUEST_DAILY') || 150 });
  const call = jwt => fetch(SB_URL() + '/rest/v1/rpc/ai_take', {
    method: 'POST', body,
    headers: { 'Content-Type': 'application/json', apikey: SB_KEY(), ...(jwt ? { Authorization: 'Bearer ' + jwt } : {}) }
  });
  try {
    const m = (req.headers.get('authorization') || '').match(/^Bearer\s+(\S+)$/);
    let r = m ? await call(m[1]) : null;
    if (!r || r.status === 401 || r.status === 403) r = await call(null); // oturum geçersizse misafir say
    if (!r.ok) { console.log('Kota kontrolü yapılamadı', r.status, (await r.text()).slice(0, 200)); return { ok: true, skipped: 'rpc ' + r.status }; }
    const left = await r.json();
    return { ok: typeof left === 'number' && left >= 0, left, user: !!m };
  } catch (e) {
    console.log('Kota kontrolü yapılamadı', e.message);
    return { ok: true, skipped: e.message }; // Supabase'e ulaşılamazsa hizmeti kesme
  }
}

async function diagnose(key, req, context) {
  const out = { anahtar_tanimli: !!key, izinli_adres: env('ALLOWED_ORIGIN') || '(tanımlı değil)', modeller: {} };
  const q = await takeQuota(req, context);
  out.gunluk_sinir = q.skipped ? 'ÇALIŞMIYOR: ' + q.skipped : `çalışıyor (bu ağ için bugün kalan hak: ${q.left})`;
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

export default async (req, context) => {
  const key = env('GEMINI_API_KEY');
  const url = new URL(req.url);

  if (req.method === 'GET') {
    const t = url.searchParams.get('test');
    if (t) {
      if (!env('DIAG_KEY')) return json(403, { error: "Teşhis kapalı. Netlify'da DIAG_KEY tanımla ve /api/ai?test=DIAG_KEY adresini aç." });
      if (t !== env('DIAG_KEY')) return json(403, { error: 'Teşhis şifresi yanlış.' });
      return json(200, await diagnose(key, req, context));
    }
    return json(405, { error: 'Sadece POST', code: 'unavailable' });
  }
  if (req.method !== 'POST') return json(405, { error: 'Sadece POST', code: 'unavailable' });

  const allowed = env('ALLOWED_ORIGIN').split(',').map(norm).filter(Boolean);
  const origin = norm(req.headers.get('origin'));
  // Tarayıcılar POST isteğinde Origin başlığını her zaman gönderir; başlıksız istek betikten gelir
  if (allowed.length && (!origin || (!allowed.includes(origin) && origin !== norm(url.origin)))) {
    return json(403, { error: 'Bu adresten istek kabul edilmiyor: ' + (origin || '(başlık yok)'), code: 'unavailable' });
  }
  if (!key) return json(500, { error: 'GEMINI_API_KEY tanımlı değil', code: 'unavailable' });

  let body;
  try { body = await req.json(); } catch { return json(400, { error: 'Geçersiz istek', code: 'unavailable' }); }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const total = messages.reduce((n, m) => n + String(m.content || '').length, 0);
  if (!messages.length || total > MAX_CHARS) return json(400, { error: 'İstek boş ya da çok uzun', code: 'unavailable' });

  const quota = await takeQuota(req, context);
  if (!quota.ok) {
    return json(429, { error: quota.user ? 'Bugünkü yapay zekâ kullanım hakkın doldu.' : 'Bugünkü misafir kullanım hakkı doldu. Giriş yaparsan daha fazla kullanabilirsin.', code: 'daily_limit' });
  }

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
