// Cloudflare Workers giriş noktası
// /api/ai → yapay zekâ fonksiyonu (netlify/edge-functions/ai.js ile aynı kod)
// diğer her şey → public/ klasöründeki site dosyaları
import ai from '../netlify/edge-functions/ai.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/ai') {
      globalThis.__YENV = env; // ortam değişkenleri ve gizli anahtarlar
      return ai(request, { ip: request.headers.get('CF-Connecting-IP') || '' });
    }
    return env.ASSETS.fetch(request);
  }
};
