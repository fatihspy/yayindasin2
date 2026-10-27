// Netlify Function: /api/ai → Google Gemini
// Gerekli ortam değişkeni: GEMINI_API_KEY  (https://aistudio.google.com/apikey adresinden ücretsiz)
// İsteğe bağlı: GEMINI_MODEL (varsayılan gemini-2.5-flash), ALLOWED_ORIGIN (örn. https://yayindasin.netlify.app)

const MAX_CHARS = 60000; // tek istekte gönderilebilecek en fazla metin

const reply = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export default async (req) => {
  if (req.method !== 'POST') return reply(405, { error: 'Sadece POST', code: 'unavailable' });

  // Başka sitelerin anahtarını kullanmasını zorlaştır
  const allowed = process.env.ALLOWED_ORIGIN;
  const origin = req.headers.get('origin') || '';
  if (allowed && origin && origin !== allowed) return reply(403, { error: 'İzin yok', code: 'not_granted' });

  const key = process.env.GEMINI_API_KEY;
  if (!key) return reply(500, { error: 'GEMINI_API_KEY tanımlı değil', code: 'unavailable' });

  let body;
  try { body = await req.json(); } catch { return reply(400, { error: 'Geçersiz istek', code: 'unavailable' }); }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  const total = messages.reduce((n, m) => n + String(m.content || '').length, 0);
  if (!messages.length || total > MAX_CHARS) return reply(400, { error: 'İstek boş ya da çok uzun', code: 'unavailable' });

  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const payload = {
    contents: messages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(m.content || '') }]
    })),
    generationConfig: {
      temperature: 0.9,
      maxOutputTokens: 8192,
      ...(body.json ? { responseMimeType: 'application/json' } : {})
    }
  };

  let r;
  try {
    r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(payload)
    });
  } catch {
    return reply(502, { error: 'Gemini’ye ulaşılamadı', code: 'unavailable' });
  }

  if (r.status === 429) return reply(429, { error: 'Kullanım sınırı', code: 'rate_limited' });
  if (!r.ok) {
    const t = await r.text();
    console.error('Gemini hata', r.status, t.slice(0, 500));
    return reply(502, { error: 'Gemini hatası ' + r.status, code: 'unavailable' });
  }

  const data = await r.json();
  const cand = (data.candidates || [])[0] || {};
  const text = ((cand.content || {}).parts || []).map(p => p.text || '').join('');
  return reply(200, { text, truncated: cand.finishReason === 'MAX_TOKENS' });
};

export const config = { path: '/api/ai' };
