/*
 * Yayındasın — bulut kayıtları (Supabase)
 * - E-posta + şifre ile giriş
 * - Kayıtlarım'daki kayıtlar hesaba yedeklenir, her cihazda görünür
 * - Öğrenci "Eğitmene gönder" dediği kaydı eğitmen görür ve not yazar
 * Ana uygulamadan sonra yüklenir; ana uygulamanın global fonksiyonlarını kullanır
 * (S, save, render, tl, esc, toast, blobGet, blobPut, blobDel, mod, openSheet, fmt, KN).
 */
(function () {
  const CFG = window.YAYINDASIN_CONFIG || {};
  const enabled = !!(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY && window.supabase && window.supabase.createClient);
  const BUCKET = 'recordings';
  const MAX_BYTES = 50 * 1024 * 1024;

  const noop = () => {};
  if (!enabled) {
    window.Cloud = { enabled: false, queue: noop, update: noop, remove: noop, url: async () => null, decorate: noop, kayitStatus: noop, accountCard: noop, saveName: noop };
    return;
  }

  const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: 'yayindasin-auth' }
  });

  let user = null, trainer = false, recovery = false;
  let uploading = false, lastPull = 0, offline = false;
  const urlCache = {};

  // ---------- küçük yardımcılar ----------
  const sheetEl = () => document.getElementById('sheet');
  const rerender = () => { try { render(); } catch (e) { console.warn(e); } };
  const tsOf = z => z.ts || Number((String(z.id || '').match(/\d{10,}/) || [0])[0]) || 0;
  const mine = z => user && z.owner === user.id;
  const EXT = { 'audio/webm': 'webm', 'video/webm': 'webm', 'audio/mp4': 'm4a', 'video/mp4': 'mp4', 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'video/quicktime': 'mov', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic' };
  const extOf = t => EXT[String(t || '').split(';')[0].trim().toLowerCase()] || 'bin';
  const ago = iso => { if (!iso) return ''; const d = new Date(iso); return d.toLocaleDateString(S.lang || 'tr', { day: 'numeric', month: 'short' }) + ' ' + d.toLocaleTimeString(S.lang || 'tr', { hour: '2-digit', minute: '2-digit' }); };
  function authMsg(e) {
    const m = String((e && (e.message || e.error_description)) || e || '');
    if (/invalid login credentials/i.test(m)) return 'E-posta ya da şifre yanlış.';
    if (/already registered|already exists/i.test(m)) return 'Bu e-postayla zaten bir hesap var. Giriş yap.';
    if (/email not confirmed/i.test(m)) return 'Önce e-postana gelen bağlantıyla hesabını onayla.';
    if (/password should be at least|at least 6/i.test(m)) return 'Şifre en az 6 karakter olmalı.';
    if (/rate limit|too many/i.test(m)) return 'Çok fazla deneme yapıldı. Birkaç dakika bekleyip tekrar dene.';
    if (/invalid email|unable to validate email/i.test(m)) return 'Geçerli bir e-posta adresi yaz.';
    if (/failed to fetch|network/i.test(m)) return 'İnternet bağlantısı yok ya da sunucuya ulaşılamadı.';
    return 'Bir sorun oldu: ' + m;
  }

  // Uygulama metinleri (yeni sayfa başlığı)
  L.m_egitmen = ['Eğitmen paneli', 'Təlimçi paneli', 'Жаттықтырушы панелі', 'Машыктыруучу панели', 'Murabbiy paneli', 'Tälimçi paneli', 'Trainer panel'];

  // E-posta ve şifre alanları uygulamanın diğer alanları gibi görünsün
  const st = document.createElement('style');
  st.textContent = `.acc input[type=email],.acc input[type=password],.tp textarea{width:100%;font:inherit;color:var(--ink);background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:10px 12px}
  .clst{font-size:13px;color:var(--muted);margin:8px 0 0}.clst.ok{color:var(--c-grn)}.clst.err{color:var(--tally)}
  .fb{margin-top:10px;background:color-mix(in srgb,var(--c-grn) 12%,var(--surface));border:1px solid color-mix(in srgb,var(--c-grn) 40%,var(--line));border-radius:12px;padding:10px 12px;font-size:14px}
  .fb b{display:block;font-size:13px;margin-bottom:2px}.tp .who{font-weight:800}.tp .pmeta{margin-top:2px}
  .tpbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:0 0 12px}.tpbar select{font:inherit;font-size:14px;font-weight:600;padding:8px 10px;border-radius:12px;border:1px solid var(--line);background:var(--surface);color:var(--ink)}`;
  document.head.appendChild(st);

  // ---------- oturum ----------
  sb.auth.onAuthStateChange((event, session) => {
    if (event === 'PASSWORD_RECOVERY') { recovery = true; try { tab = 'profil'; } catch (e) {} }
    const nu = session ? session.user : null;
    const changed = (nu && nu.id) !== (user && user.id);
    user = nu;
    if (changed) setTimeout(() => (user ? afterLogin() : rerender()), 0);
    else if (event === 'PASSWORD_RECOVERY') setTimeout(rerender, 0);
  });

  async function afterLogin() {
    try { const r = await sb.rpc('is_trainer'); trainer = r.data === true; } catch (e) { trainer = false; }
    saveName();
    await pull(true);
    queue();
    rerender();
  }

  async function signOut() {
    // Bu cihazdan, yedeklenmiş kayıtları kaldır (bulutta kalır)
    const keep = [];
    for (const z of S.port || []) {
      if (mine(z) && z.cid) { if (/^(port|cloud):/.test(z.key)) await blobDel(z.key); }
      else keep.push(z);
    }
    S.port = keep; save();
    trainer = false;
    await sb.auth.signOut();
    rerender();
  }

  function saveName() {
    if (!user) return;
    sb.from('profiles').upsert({ id: user.id, display_name: S.name || '', updated_at: new Date().toISOString() }).then(r => { if (r.error) console.warn('[Yayındasın bulut] profil', r.error.message); });
  }

  // ---------- eşitleme ----------
  function apply(z, r) {
    Object.assign(z, { cid: r.id, owner: r.user_id, path: r.path, title: r.title, cv: r.cv, shared: r.shared, feedback: r.feedback, feedback_at: r.feedback_at, ts: Date.parse(r.created_at) || z.ts });
    delete z.cerr;
  }

  async function pull(force) {
    if (!user) return false;
    if (!force && Date.now() - lastPull < 15000) return false;
    lastPull = Date.now();
    const { data, error } = await sb.from('recordings').select('*').eq('user_id', user.id).order('created_at', { ascending: false });
    if (error) { offline = true; console.warn('[Yayındasın bulut]', error.message); return false; }
    offline = false;
    const before = JSON.stringify(S.port || []);
    S.port = S.port || [];
    const byId = new Map(data.map(r => [r.id, r])), byLocal = new Map(data.map(r => [r.local_id, r]));
    const next = [];
    for (const z of S.port) {
      if (z.owner && z.owner !== user.id) { if (/^(port|cloud):/.test(z.key)) await blobDel(z.key); continue; } // başka hesabın kaydı
      const r = (z.cid && byId.get(z.cid)) || byLocal.get(z.id);
      if (r) { apply(z, r); next.push(z); }
      else if (z.cid) { if (/^(port|cloud):/.test(z.key)) await blobDel(z.key); } // başka cihazda silinmiş
      else next.push(z); // henüz yüklenmemiş
    }
    for (const r of data) {
      if (!next.some(z => z.cid === r.id)) {
        const z = { id: r.local_id, key: 'cloud:' + r.id, kind: r.kind, src: r.src, dur: r.dur, date: r.rec_date };
        apply(z, r); next.push(z);
      }
    }
    next.sort((a, b) => tsOf(b) - tsOf(a));
    S.port = next; save();
    return JSON.stringify(S.port) !== before;
  }

  async function upload(z) {
    const blob = await blobGet(z.key);
    if (!blob) { z.cerr = 'missing'; return; }
    if (blob.size > MAX_BYTES) { z.cerr = 'big'; return; }
    const path = `${user.id}/${crypto.randomUUID()}.${extOf(blob.type)}`;
    const up = await sb.storage.from(BUCKET).upload(path, blob, { contentType: (blob.type || 'application/octet-stream').split(';')[0], upsert: false });
    if (up.error) throw up.error;
    const row = { local_id: z.id, title: z.title || '', kind: z.kind, src: z.src || null, dur: z.dur || null, rec_date: z.date || null, cv: !!z.cv, path, mime: blob.type || null, size: blob.size };
    let ins = await sb.from('recordings').insert(row).select().single();
    if (ins.error && ins.error.code === '23505') { // aynı kayıt başka sekmeden yüklenmiş
      await sb.storage.from(BUCKET).remove([path]);
      ins = await sb.from('recordings').select('*').eq('user_id', user.id).eq('local_id', z.id).single();
    }
    if (ins.error) { await sb.storage.from(BUCKET).remove([path]); throw ins.error; }
    apply(z, ins.data);
    // Yüklenen dosya bu cihazda port: anahtarıyla zaten duruyor
  }

  async function queue() {
    if (!user || uploading) return;
    uploading = true;
    let changed = false;
    try {
      for (const z of [...(S.port || [])]) {
        if (!user) break;
        if (z.cid || z.cerr || (z.owner && z.owner !== user.id)) continue;
        try { await upload(z); changed = true; save(); }
        catch (e) { console.warn('[Yayındasın bulut] yükleme', e.message || e); offline = true; setTimeout(queue, 30000); break; }
      }
    } finally { uploading = false; }
    if (changed) { offline = false; rerender(); }
  }

  function update(z, fields) {
    if (!mine(z) || !z.cid) return;
    sb.from('recordings').update(fields).eq('id', z.cid).then(r => { if (r.error) { toast('Değişiklik buluta kaydedilemedi.'); console.warn(r.error.message); } });
  }

  async function remove(z) {
    if (!mine(z) || !z.cid) return;
    const d = await sb.from('recordings').delete().eq('id', z.cid);
    if (d.error) { toast('Kayıt buluttan silinemedi.'); return; }
    if (z.path) await sb.storage.from(BUCKET).remove([z.path]);
    if (z.key && z.key.startsWith('cloud:')) await blobDel(z.key);
  }

  async function url(z) {
    if (!z.path) return null;
    const c = urlCache[z.path];
    if (c && c.exp > Date.now()) return c.u;
    const r = await sb.storage.from(BUCKET).createSignedUrl(z.path, 3600);
    if (r.error) return null;
    urlCache[z.path] = { u: r.data.signedUrl, exp: Date.now() + 50 * 60000 };
    return r.data.signedUrl;
  }

  function share(z, on) {
    if (!mine(z) || !z.cid) return;
    z.shared = on; save();
    sb.from('recordings').update({ shared: on, shared_at: on ? new Date().toISOString() : null }).eq('id', z.cid).then(r => {
      if (r.error) { z.shared = !on; save(); toast('Gönderilemedi, tekrar dene.'); }
      else toast(on ? 'Kayıt eğitmenine gönderildi' : 'Gönderim geri alındı');
      rerender();
    });
  }

  // ---------- Kayıtlarım ----------
  function decorate(d, z) {
    if (!user) return;
    const btns = d.querySelector('.row-btns');
    const box = document.createElement('div');
    if (!z.cid) {
      const why = z.cerr === 'big' ? 'Dosya 50 MB’tan büyük olduğu için buluta yüklenemedi; sadece bu cihazda.' : z.cerr === 'missing' ? 'Dosya bu cihazda bulunamadığı için buluta yüklenemedi.' : (offline ? 'Bağlantı bekleniyor; yüklenecek.' : 'Buluta yükleniyor…');
      box.innerHTML = `<p class="clst ${z.cerr ? 'err' : ''}">${why}</p>`;
    } else {
      const sbtn = document.createElement('button');
      sbtn.className = 'chip'; sbtn.setAttribute('aria-pressed', String(!!z.shared));
      sbtn.textContent = z.shared ? '✓ Eğitmene gönderildi' : '📤 Eğitmene gönder';
      sbtn.onclick = () => share(z, !z.shared);
      btns && btns.appendChild(sbtn);
      box.innerHTML = `<p class="clst ok">☁ Hesabına yedeklendi${z.shared ? '. Eğitmen bu kaydı görebilir; geri almak için butona tekrar bas.' : ''}</p>` +
        (z.feedback ? `<div class="fb"><b>Eğitmen notu · ${esc(ago(z.feedback_at))}</b><span data-notr>${esc(z.feedback)}</span></div>` : '');
    }
    d.appendChild(box);
  }

  function kayitStatus(el) {
    if (!el) return;
    if (!user) {
      el.innerHTML = `<div class="card" style="margin-top:12px"><p class="note" style="margin:0 0 10px">Kayıtların şu an sadece bu cihazda. Giriş yaparsan her cihazda görünür ve istediğini eğitmenine gönderebilirsin.</p><button class="btn sm" data-gologin>Giriş yap / hesap oluştur</button></div>`;
      el.querySelector('[data-gologin]').onclick = () => { tab = 'profil'; window.scrollTo(0, 0); rerender(); setTimeout(() => { const a = document.querySelector('[data-account]'); a && a.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, 50); };
      return;
    }
    const n = (S.port || []).filter(z => z.cid).length, wait = (S.port || []).filter(z => !z.cid && !z.cerr).length;
    el.innerHTML = `<p class="clst ${offline ? 'err' : 'ok'}" style="margin-top:10px">☁ <span data-notr>${esc(user.email)}</span> · ${n} kayıt bulutta${wait ? ` · ${wait} yükleniyor` : ''}${offline ? ' · bağlantı sorunu, tekrar denenecek' : ''}</p>`;
    queue();
    pull(false).then(ch => { if (ch && sheetEl().hidden) rerender(); });
  }

  // ---------- Profil: hesap kartı ----------
  function accountCard(el) {
    if (!el) return;
    el.className = 'acc';
    if (recovery && user) {
      el.innerHTML = `<div class="sec"><h2>Yeni şifre</h2></div><div class="card"><label class="f" for="acnp">Yeni şifren (en az 6 karakter)</label><input type="password" id="acnp" autocomplete="new-password"><div class="row-btns"><button class="btn" data-setpw>Şifreyi kaydet</button></div><p class="note" data-acmsg></p></div>`;
      el.querySelector('[data-setpw]').onclick = async () => {
        const pw = el.querySelector('#acnp').value; const msg = el.querySelector('[data-acmsg]');
        const r = await sb.auth.updateUser({ password: pw });
        if (r.error) { msg.textContent = authMsg(r.error); return; }
        recovery = false; toast('Şifren güncellendi'); rerender();
      };
      return;
    }
    if (!user) {
      el.innerHTML = `<div class="sec"><h2>Hesap</h2></div><div class="card">
        <p class="note" style="margin:0 0 4px">Giriş yaparsan kayıtların her cihazda görünür ve istediğini eğitmenine gönderebilirsin.</p>
        <label class="f" for="acm">E-posta</label><input type="email" id="acm" autocomplete="email" inputmode="email">
        <label class="f" for="acp">Şifre</label><input type="password" id="acp" autocomplete="current-password">
        <div class="row-btns"><button class="btn" data-in>Giriş yap</button><button class="btn ghost" data-up>Hesap oluştur</button></div>
        <button class="btn ghost sm" data-forgot>Şifremi unuttum</button><p class="note" data-acmsg style="margin:10px 0 0"></p></div>`;
      const em = el.querySelector('#acm'), pw = el.querySelector('#acp'), msg = el.querySelector('[data-acmsg]');
      const busy = on => el.querySelectorAll('button').forEach(b => b.disabled = on);
      el.querySelector('[data-in]').onclick = async () => {
        busy(true); msg.textContent = '';
        const r = await sb.auth.signInWithPassword({ email: em.value.trim(), password: pw.value });
        busy(false); if (r.error) msg.textContent = authMsg(r.error); else toast('Giriş yapıldı');
      };
      el.querySelector('[data-up]').onclick = async () => {
        if (pw.value.length < 6) { msg.textContent = 'Şifre en az 6 karakter olmalı.'; return; }
        busy(true); msg.textContent = '';
        const r = await sb.auth.signUp({ email: em.value.trim(), password: pw.value, options: { emailRedirectTo: location.origin } });
        busy(false);
        if (r.error) { msg.textContent = authMsg(r.error); return; }
        if (!r.data.session) msg.textContent = 'Hesap oluşturuldu. E-postana gelen bağlantıya tıklayıp hesabını onayla, sonra giriş yap.';
        else toast('Hesap oluşturuldu');
      };
      el.querySelector('[data-forgot]').onclick = async () => {
        if (!em.value.trim()) { msg.textContent = 'Önce e-posta adresini yaz.'; return; }
        busy(true);
        const r = await sb.auth.resetPasswordForEmail(em.value.trim(), { redirectTo: location.origin });
        busy(false);
        msg.textContent = r.error ? authMsg(r.error) : 'Şifre sıfırlama bağlantısı e-postana gönderildi.';
      };
      return;
    }
    el.innerHTML = `<div class="sec"><h2>Hesap</h2><span>☁</span></div><div class="card">
      <p style="margin:0"><b data-notr>${esc(user.email)}</b></p>
      <p class="note" style="margin:4px 0 0">${trainer ? 'Eğitmen hesabı. Öğrencilerin gönderdiği kayıtları panelden izleyip not yazabilirsin.' : 'Kayıtların hesabına yedekleniyor ve her cihazda görünüyor.'}</p>
      <div class="row-btns">${trainer ? '<button class="btn" data-panel>Eğitmen paneli</button>' : ''}<button class="btn ghost sm" data-out>Çıkış yap</button></div></div>`;
    const p = el.querySelector('[data-panel]'); if (p) p.onclick = () => openSheet('egitmen');
    el.querySelector('[data-out]').onclick = () => {
      if (confirm('Çıkış yapınca hesabına yedeklenmiş kayıtlar bu cihazdan kaldırılır; hesabında durmaya devam eder. Çıkış yapılsın mı?')) signOut();
    };
  }

  // ---------- Eğitmen paneli ----------
  mod('egitmen', {
    t: 'Eğitmen paneli', s: 'Öğrencilerin gönderdiği kayıtlar', i: '🎓', xp: 0,
    async render(b) {
      if (!user || !trainer) { b.innerHTML = '<p class="note">Bu sayfayı sadece eğitmen hesabı açabilir.</p>'; return; }
      b.innerHTML = '<p class="note">Kayıtlar yükleniyor…</p>';
      const { data, error } = await sb.from('recordings')
        .select('id,user_id,title,kind,src,dur,rec_date,path,shared_at,feedback,feedback_at')
        .eq('shared', true).order('shared_at', { ascending: false }).limit(300);
      if (!b.isConnected) return;
      if (error) { b.innerHTML = `<p class="note">Kayıtlar alınamadı: ${esc(error.message)}</p>`; return; }
      const ids = [...new Set(data.map(r => r.user_id))];
      const names = {};
      if (ids.length) {
        const pr = await sb.from('profiles').select('id,display_name').in('id', ids);
        (pr.data || []).forEach(p => names[p.id] = p.display_name);
      }
      const urls = {};
      if (data.length) {
        const su = await sb.storage.from(BUCKET).createSignedUrls(data.map(r => r.path), 3600);
        (su.data || []).forEach((u, i) => { if (u && u.signedUrl) urls[data[i].path] = u.signedUrl; });
      }
      if (!b.isConnected) return;
      let who = 'all', only = false;
      const draw = () => {
        const list = data.filter(r => (who === 'all' || r.user_id === who) && (!only || !r.feedback));
        const waiting = data.filter(r => !r.feedback).length;
        b.innerHTML = `<p class="lead">Öğrencilerin “Eğitmene gönder” dediği kayıtlar. Dinle, izle ve not bırak; not öğrencinin Kayıtlarım sayfasında görünür.</p>
          <div class="tpbar"><select data-who aria-label="Öğrenci"><option value="all">Tüm öğrenciler (${ids.length})</option>${ids.map(id => `<option value="${id}" ${who === id ? 'selected' : ''}>${esc(names[id] || 'Adsız öğrenci')}</option>`).join('')}</select>
          <button class="chip" data-only aria-pressed="${only}">Not bekleyen (${waiting})</button></div>
          <div class="list" data-l></div>`;
        b.querySelector('[data-who]').onchange = e => { who = e.target.value; draw(); };
        b.querySelector('[data-only]').onclick = () => { only = !only; draw(); };
        const L2 = b.querySelector('[data-l]');
        if (!list.length) { L2.innerHTML = `<div class="card"><p class="note" style="margin:0">${data.length ? 'Bu filtrede kayıt yok.' : 'Henüz gönderilmiş kayıt yok.'}</p></div>`; return; }
        for (const r of list) {
          const d = document.createElement('div'); d.className = 'pitem tp';
          d.innerHTML = `<div class="who" data-notr>${esc(names[r.user_id] || 'Adsız öğrenci')}</div>
            <div data-notr>${esc(r.title || '')}</div>
            <p class="pmeta">${KN(r.kind)}${r.dur ? ', ' + fmt(r.dur) : ''}${r.rec_date ? ', ' + esc(r.rec_date) : ''} · gönderildi ${esc(ago(r.shared_at))}</p>
            <div data-m></div>
            <label class="f" for="fb_${r.id}">Eğitmen notu</label><textarea id="fb_${r.id}" maxlength="2000" placeholder="Örnek: Vurgular yerinde, ikinci cümlede nefes erken bitti.">${esc(r.feedback || '')}</textarea>
            <div class="row-btns" style="margin:8px 0 0"><button class="btn sm" data-save>Notu kaydet</button><span class="clst" data-st>${r.feedback ? 'Not kaydedildi · ' + esc(ago(r.feedback_at)) : ''}</span></div>`;
          const u = urls[r.path], mm = d.querySelector('[data-m]');
          if (u) { const el = document.createElement(r.kind === 'foto' ? 'img' : r.kind === 'video' ? 'video' : 'audio'); el.src = u; if (r.kind !== 'foto') { el.controls = true; el.playsInline = true; el.preload = 'metadata'; } else el.alt = r.title || ''; mm.appendChild(el); }
          else mm.innerHTML = '<p class="note">Dosya açılamadı.</p>';
          d.querySelector('[data-save]').onclick = async () => {
            const btn = d.querySelector('[data-save]'), stt = d.querySelector('[data-st]'), txt = d.querySelector('textarea').value;
            btn.disabled = true;
            const res = await sb.rpc('give_feedback', { rec: r.id, txt });
            btn.disabled = false;
            if (res.error) { stt.textContent = 'Kaydedilemedi: ' + res.error.message; stt.className = 'clst err'; return; }
            r.feedback = txt.trim() || null; r.feedback_at = new Date().toISOString();
            stt.textContent = r.feedback ? 'Not kaydedildi · ' + ago(r.feedback_at) : 'Not silindi'; stt.className = 'clst ok';
          };
          L2.appendChild(d);
        }
      };
      draw();
    }
  });

  window.Cloud = {
    enabled: true, get user() { return user; }, get trainer() { return trainer; },
    queue, update, remove, url, decorate, kayitStatus, accountCard, saveName
  };
  rerender();
})();
