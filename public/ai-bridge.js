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
      throw { code: 'server_error', message: 'Sunucuya ulaşılamadı' };
    }
    if (!res.ok) {
      let data = {};
      try { data = await res.json(); } catch (e) {}
      // Uygulama 'unavailable' ve 'not_granted' kodlarını "Claude izni verilmedi" diye yorumlayıp
      // yapay zekâyı oturum boyunca kapatıyor. Sunucu hataları geçici olduğu için farklı bir kod kullan.
      const code = res.status === 429 ? 'rate_limited' : 'server_error';
      console.warn('[Yayındasın AI]', res.status, data.error || '', data.detail || '');
      throw { code, message: data.error || ('HTTP ' + res.status) };
    }
    // Yanıt düz metin akışı olarak gelir
    const onText = opts && typeof opts.onText === 'function' ? opts.onText : null;
    let text = '';
    if (res.body && res.body.getReader) {
      const reader = res.body.getReader(), dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const delta = dec.decode(value, { stream: true });
        text += delta;
        if (onText && delta) { try { onText({ text, delta }); } catch (e) {} }
      }
      text += dec.decode();
    } else {
      text = await res.text();
      if (onText) { try { onText({ text, delta: text }); } catch (e) {} }
    }
    if (!text.trim()) throw { code: 'server_error', message: 'Yapay zekâ boş yanıt döndürdü' };
    return { text };
  }

  async function sample(input, opts) {
    const d = await call(input, opts, false);
    return { text: d.text, truncated: false };
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
