/*
 * Yayındasın — yapay zekâ köprüsü
 * Uygulama yapay zekâya window.claude.use('sample') ile ulaşıyor.
 * Bu dosya aynı arayüzü sağlar ama istekleri kendi sunucu fonksiyonumuza
 * (/api/ai → Gemini) gönderir.
 *
 * - Aynı anda en fazla MAX_PARALLEL istek gider (ücretsiz kota ani yüklenmeleri kaldırmıyor).
 * - Kota / sunucu hatasında bekleyip tekrar dener.
 * - Çeviri dizisi yanlış uzunlukta dönerse kabul etmez (metinler kaymasın diye).
 */
(function () {
  const ENDPOINT = '/api/ai';
  const MAX_PARALLEL = 3;
  const RETRY_DELAYS = [3000, 8000, 20000]; // ms

  // ---- öncelikli istek sırası ----
  // Kullanıcının bastığı butonlar (default) arka plan çevirilerinin (quick) önüne geçer.
  let active = 0;
  const waiting = { high: [], low: [] };
  function slot(high) {
    if (active < MAX_PARALLEL) { active++; return Promise.resolve(); }
    return new Promise(res => waiting[high ? 'high' : 'low'].push(res));
  }
  function release() {
    const next = waiting.high.shift() || waiting.low.shift();
    if (next) next(); else active--;
  }
  const wait = (ms, signal) => new Promise((res, rej) => {
    const t = setTimeout(res, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); rej(new DOMException('Aborted', 'AbortError')); }, { once: true });
  });

  function toMessages(input) {
    if (typeof input === 'string') return [{ role: 'user', content: input }];
    if (Array.isArray(input)) return input.map(m => ({ role: m.role, content: String(m.content || '') }));
    return [{ role: 'user', content: String(input) }];
  }
  const lastUser = msgs => (msgs.filter(m => m.role !== 'assistant').pop() || {}).content || '';

  async function once(messages, opts, json) {
    let res;
    try {
      res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages, json: !!json, tier: opts.modelTier || 'default' }),
        signal: opts.signal
      });
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      throw { code: 'server_error', message: 'Sunucuya ulaşılamadı', retry: true };
    }
    if (!res.ok) {
      let data = {};
      try { data = await res.json(); } catch (e) {}
      // Uygulama 'unavailable' ve 'not_granted' kodlarını "Claude izni verilmedi" diye yorumlayıp
      // yapay zekâyı oturum boyunca kapatıyor. Sunucu hataları geçici olduğu için farklı kod kullan.
      const code = res.status === 429 ? 'rate_limited' : 'server_error';
      console.warn('[Yayındasın AI]', res.status, data.error || '', data.detail || '');
      throw { code, message: data.error || ('HTTP ' + res.status), retry: res.status === 429 || res.status >= 500 };
    }
    const onText = typeof opts.onText === 'function' ? opts.onText : null;
    let text = '';
    if (res.body && res.body.getReader) {
      const reader = res.body.getReader(), dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const delta = dec.decode(value, { stream: true });
        text += delta;
        if (onText && delta && !json) { try { onText({ text, delta }); } catch (e) {} }
      }
      text += dec.decode();
    } else {
      text = await res.text();
    }
    if (!text.trim()) throw { code: 'server_error', message: 'Yapay zekâ boş yanıt döndürdü', retry: true };
    return text;
  }

  function parseJSON(text, prompt) {
    const t = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    let v;
    try { v = JSON.parse(t); }
    catch (e) { throw { code: 'bad_json', message: 'Yapay zekâ geçerli JSON döndürmedi', text: t, retry: true }; }
    // İstemde bir JSON dizisi varsa ve model {"x":[...]} gibi sardıysa diziyi çıkar
    const inArr = prompt.match(/\n(\[[\s\S]*\])\s*$/);
    if (inArr && v && !Array.isArray(v) && typeof v === 'object') {
      const vals = Object.values(v);
      if (vals.length === 1 && Array.isArray(vals[0])) v = vals[0];
    }
    // "Translate each string of this JSON array" → aynı uzunlukta dönmeli
    if (inArr && /same length and order|array lengths exactly the same/.test(prompt)) {
      try {
        const src = JSON.parse(inArr[1]);
        if (Array.isArray(src) && (!Array.isArray(v) || v.length !== src.length)) {
          throw { code: 'bad_json', message: 'Çeviri dizisi yanlış uzunlukta', retry: true };
        }
      } catch (e) { if (e && e.code) throw e; }
    }
    return v;
  }

  async function run(input, opts, json) {
    opts = opts || {};
    const messages = toMessages(input);
    const prompt = lastUser(messages);
    let lastErr;
    for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
      await slot(opts.modelTier !== 'quick');
      try {
        const text = await once(messages, opts, json);
        return json ? parseJSON(text, prompt) : text;
      } catch (e) {
        if (e && e.name === 'AbortError') throw e;
        lastErr = e;
        // bozuk JSON'u bir kez, kota/sunucu hatasını üç kez tekrar dene
        const canRetry = e && e.retry && (e.code !== 'bad_json' || attempt < 1);
        if (!canRetry || attempt === RETRY_DELAYS.length) break;
      } finally {
        release();
      }
      await wait(RETRY_DELAYS[attempt], opts.signal);
    }
    const { retry, ...err } = lastErr || { code: 'server_error', message: 'Bilinmeyen hata' };
    throw err;
  }

  async function sample(input, opts) {
    const text = await run(input, opts, false);
    return { text, truncated: false };
  }
  sample.json = (input, opts) => run(input, opts, true);
  sample.limits = async () => ({ images: false });

  window.claude = {
    use: async name => (name === 'sample' ? sample : null)
  };
})();
