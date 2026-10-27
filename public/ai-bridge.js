/*
 * Yayındasın — yapay zekâ köprüsü
 * Uygulama yapay zekâya window.claude.use('sample') ile ulaşıyor.
 * Bu dosya aynı arayüzü sağlar ama istekleri kendi sunucu fonksiyonumuza
 * (/api/ai → Gemini) gönderir. Uygulama kodunda değişiklik gerekmez.
 */
(function () {
  const ENDPOINT = '/api/ai';

  function toMessages(input) {
    if (typeof input === 'string') return [{ role: 'user', content: input }];
    if (Array.isArray(input)) return input.map(m => ({ role: m.role, content: String(m.content || '') }));
    return [{ role: 'user', content: String(input) }];
  }

  async function call(input, opts, json) {
    opts = opts || {};
    let res;
    try {
      res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: toMessages(input), json: !!json, tier: opts.modelTier || 'default' }),
        signal: opts.signal
      });
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      throw { code: 'unavailable', message: 'Sunucuya ulaşılamadı' };
    }
    let data = {};
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) {
      const code = res.status === 429 ? 'rate_limited' : (data.code || 'unavailable');
      throw { code, message: data.error || ('HTTP ' + res.status) };
    }
    return data;
  }

  async function sample(input, opts) {
    const d = await call(input, opts, false);
    const text = d.text || '';
    if (opts && typeof opts.onText === 'function') { try { opts.onText({ text, delta: text }); } catch (e) {} }
    return { text, truncated: !!d.truncated };
  }

  sample.json = async function (input, opts) {
    const d = await call(input, opts, true);
    let t = String(d.text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    try { return JSON.parse(t); }
    catch (e) { throw { code: 'bad_json', message: 'Yapay zekâ geçerli JSON döndürmedi', text: t }; }
  };

  sample.limits = async function () { return { images: false }; };

  window.claude = {
    use: async function (name) { return name === 'sample' ? sample : null; }
  };
})();
