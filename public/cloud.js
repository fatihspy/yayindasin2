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
  // KVKK: aydınlatma metni sürümü (gizlilik.html'deki "Sürüm" ile aynı tutulmalı)
  const KVKK_V = '1';
  const PRIV = '/gizlilik.html';
  // cons: null = henüz bilinmiyor; legacy = kvkk.sql çalıştırılmamış (eski kurulum, engelleme yok)
  let cons = null;
  const mediaOk = () => !!(cons && (cons.legacy || cons.media));
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
  .tpbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:0 0 12px}.tpbar select{font:inherit;font-size:14px;font-weight:600;padding:8px 10px;border-radius:12px;border:1px solid var(--line);background:var(--surface);color:var(--ink)}
  .ck{display:flex;gap:10px;align-items:flex-start;margin:10px 0 0;font-size:14px;line-height:1.4;cursor:pointer}.ck input{width:20px;height:20px;flex:none;margin:1px 0 0;accent-color:var(--accent,#6A4CF6)}
  .ck a,.acc a.pl{color:inherit;text-decoration:underline;text-underline-offset:2px}.ck small{display:block;color:var(--muted);font-size:12.5px;margin-top:2px}
  .kv{position:fixed;inset:0;z-index:9999;background:rgba(10,8,25,.55);display:flex;align-items:flex-end;justify-content:center;padding:16px}
  .kv>div{background:var(--surface,#fff);color:var(--ink,#111);border-radius:20px;max-width:480px;width:100%;max-height:90vh;overflow:auto;padding:20px;box-shadow:0 20px 60px rgba(0,0,0,.35)}
  .kv h2{margin:0 0 6px;font-size:20px}@media(min-width:600px){.kv{align-items:center}}
  .dz{margin-top:14px;border:1px solid color-mix(in srgb,var(--tally,#e33) 45%,var(--line));border-radius:12px;padding:12px}.dz input{width:100%;font:inherit;padding:8px 10px;border-radius:10px;border:1px solid var(--line);background:var(--surface);color:var(--ink);margin:8px 0}
  .btn.danger{background:var(--tally,#d33);color:#fff;border-color:transparent}`;
  document.head.appendChild(st);

  // ---------- oturum ----------
  sb.auth.onAuthStateChange((event, session) => {
    if (event === 'PASSWORD_RECOVERY') { recovery = true; try { tab = 'profil'; } catch (e) {} }
    const nu = session ? session.user : null;
    const changed = (nu && nu.id) !== (user && user.id);
    user = nu;
    if (changed) cons = null;
    if (changed) setTimeout(() => (user ? afterLogin() : rerender()), 0);
    else if (event === 'PASSWORD_RECOVERY') setTimeout(rerender, 0);
  });

  async function loadConsent() {
    cons = null;
    const r = await sb.from('profiles').select('kvkk_version,kvkk_at,age_ok,media_consent_at').eq('id', user.id).maybeSingle();
    if (r.error) {
      // Sütunlar yoksa kvkk.sql henüz çalıştırılmamış: eski davranış sürsün, kimse engellenmesin
      if (/kvkk_version|column/i.test(r.error.message || '')) cons = { legacy: true };
      return;
    }
    const d = r.data || {};
    cons = { kvkk: d.kvkk_version || null, kvkk_at: d.kvkk_at, age: d.age_ok, media: !!d.media_consent_at, media_at: d.media_consent_at };
  }

  async function setConsent(kvkk, age, media) {
    const r = await sb.rpc('record_consent', { kvkk, age, media });
    if (r.error) throw r.error;
    await loadConsent();
  }

  // Hesap açarken işaretlenen onaylar (e-posta onayından sonra ilk girişte kaydedilir)
  const PEND = 'yayindasin-pending-consent';
  const takePending = () => { try { const v = JSON.parse(localStorage.getItem(PEND) || 'null'); localStorage.removeItem(PEND); return v; } catch (e) { return null; } };

  async function ensureConsent() {
    if (!user) return;
    if (!cons) await loadConsent();
    if (!cons || cons.legacy || cons.kvkk === KVKK_V) return;
    const p = takePending();
    if (p && p.email === user.email && p.kvkk === KVKK_V) {
      try { await setConsent(KVKK_V, true, !!p.media); return; } catch (e) { console.warn('[Yayındasın KVKK]', e.message); }
    }
    consentDialog();
  }

  // Aydınlatma metni onaylanmamış (ya da metin değişmiş) hesaplar için tek seferlik pencere
  function consentDialog() {
    if (document.querySelector('.kv')) return;
    const again = !!(cons && cons.kvkk);
    const o = document.createElement('div'); o.className = 'kv'; o.setAttribute('role', 'dialog'); o.setAttribute('aria-modal', 'true'); o.setAttribute('aria-label', 'Gizlilik');
    o.innerHTML = `<div><h2>${again ? 'Gizlilik metni güncellendi' : 'Kişisel verilerin'}</h2>
      <p class="note" style="margin:0">Hesabını kullanmaya devam etmek için aydınlatma metnini onayla. Ses/görüntü rızası isteğe bağlıdır.</p>
      <label class="ck"><input type="checkbox" data-k1><span><a href="${PRIV}#aydinlatma" target="_blank" rel="noopener">Aydınlatma Metni</a>’ni okudum.</span></label>
      <label class="ck"><input type="checkbox" data-k2><span>18 yaşından büyüğüm ya da velimin onayı var.</span></label>
      <label class="ck"><input type="checkbox" data-k3 ${cons && cons.media ? 'checked' : ''}><span>Ses ve görüntü kayıtlarımın hesabımda saklanmasına ve seçtiklerimi eğitmene gönderebilmeye <a href="${PRIV}#riza" target="_blank" rel="noopener">açık rıza</a> veriyorum.<small>İsteğe bağlı. Vermezsen kayıtların sadece bu cihazda kalır.</small></span></label>
      <div class="row-btns" style="margin-top:14px"><button class="btn" data-ok disabled>Devam</button><button class="btn ghost sm" data-out>Çıkış yap</button></div>
      <p class="clst err" data-m></p></div>`;
    document.body.appendChild(o);
    const k1 = o.querySelector('[data-k1]'), k2 = o.querySelector('[data-k2]'), k3 = o.querySelector('[data-k3]'), ok = o.querySelector('[data-ok]'), m = o.querySelector('[data-m]');
    const upd = () => { ok.disabled = !(k1.checked && k2.checked); }; k1.onchange = upd; k2.onchange = upd;
    ok.onclick = async () => {
      ok.disabled = true; m.textContent = '';
      try { await setConsent(KVKK_V, true, k3.checked); o.remove(); toast('Tercihlerin kaydedildi'); queue(); rerender(); }
      catch (e) { m.textContent = 'Kaydedilemedi: ' + (e.message || e); upd(); }
    };
    o.querySelector('[data-out]').onclick = () => { o.remove(); signOut(); };
  }

  async function afterLogin() {
    try { const r = await sb.rpc('is_trainer'); trainer = r.data === true; } catch (e) { trainer = false; }
    await ensureConsent();
    await syncProgress(); // önce ilerleme (ad dahil) gelsin
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
    S.port = keep;
    clearTimeout(pTimer); await syncProgress(); // son değişiklikleri gönder
    clearProgressLocal(); // ortak cihazda bir sonraki kişi görmesin
    trainer = false; cons = null;
    const d = document.querySelector('.kv'); if (d) d.remove();
    await sb.auth.signOut();
    rerender();
  }

  function saveName() {
    if (!user || !S.name || S.name === 'Adınız Soyadınız') return;
    sb.from('profiles').upsert({ id: user.id, display_name: String(S.name || '').slice(0, 80), updated_at: new Date().toISOString() }).then(r => { if (r.error) console.warn('[Yayındasın bulut] profil', r.error.message); });
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
    if (!/^(audio|video|image)\//.test(blob.type || '')) { z.cerr = 'type'; return; }
    const path = `${user.id}/${crypto.randomUUID()}.${extOf(blob.type)}`;
    const up = await sb.storage.from(BUCKET).upload(path, blob, { contentType: (blob.type || 'application/octet-stream').split(';')[0], upsert: false });
    if (up.error) throw up.error;
    const row = { local_id: String(z.id).slice(0, 80), title: String(z.title || '').slice(0, 300), kind: z.kind, src: z.src ? String(z.src).slice(0, 20) : null, dur: z.dur || null, rec_date: z.date ? String(z.date).slice(0, 40) : null, cv: !!z.cv, path, mime: blob.type ? String(blob.type).slice(0, 100) : null, size: blob.size };
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
    if (!user || uploading || !mediaOk()) return;
    uploading = true;
    let changed = false;
    try {
      for (const z of [...(S.port || [])]) {
        if (!user) break;
        if (z.cid || z.cerr || (z.owner && z.owner !== user.id)) continue;
        try { await upload(z); changed = true; save(); }
        catch (e) {
          const msg = String((e && (e.message || e.error)) || e);
          console.warn('[Yayındasın bulut] yükleme', msg);
          if (/row-level security|violates/i.test(msg)) {
            await loadConsent();
            if (!mediaOk()) { changed = true; break; } // rıza başka cihazda geri alınmış
            z.cerr = 'quota'; changed = true; save(); continue; // kota dolu
          }
          if (/mime|content type|not supported/i.test(msg)) { z.cerr = 'type'; changed = true; save(); continue; }
          offline = true; setTimeout(queue, 30000); break;
        }
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
    if (!z.cid && !mediaOk()) {
      if (!cons) return;
      box.innerHTML = `<p class="clst">Bu kayıt sadece bu cihazda. Buluta yedeklemek ve eğitmene göndermek için ses/görüntü rızası gerekiyor.</p>`;
      const b = document.createElement('button'); b.className = 'btn ghost sm'; b.textContent = 'Rıza ver'; b.style.marginTop = '6px';
      b.onclick = () => mediaConsentAsk();
      box.appendChild(b);
    } else if (!z.cid) {
      const why = z.cerr === 'quota' ? 'Hesabındaki kayıt alanı doldu (100 MB). Eski kayıtlardan birkaçını silersen bu kayıt yüklenir.' : z.cerr === 'type' ? 'Bu dosya türü buluta yüklenemiyor; sadece ses, video ve fotoğraf.' : z.cerr === 'big' ? 'Dosya 50 MB’tan büyük olduğu için buluta yüklenemedi; sadece bu cihazda.' : z.cerr === 'missing' ? 'Dosya bu cihazda bulunamadığı için buluta yüklenemedi.' : (offline ? 'Bağlantı bekleniyor; yüklenecek.' : 'Buluta yükleniyor…');
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
    if (cons && !mediaOk()) {
      el.innerHTML = `<p class="clst" style="margin-top:10px">☁ <span data-notr>${esc(user.email)}</span> · Ses/görüntü rızası verilmediği için kayıtların sadece bu cihazda. <button class="btn ghost sm" data-mc>Rıza ver</button></p>`;
      el.querySelector('[data-mc]').onclick = () => mediaConsentAsk();
      return;
    }
    const n = (S.port || []).filter(z => z.cid).length, wait = (S.port || []).filter(z => !z.cid && !z.cerr).length;
    el.innerHTML = `<p class="clst ${offline ? 'err' : 'ok'}" style="margin-top:10px">☁ <span data-notr>${esc(user.email)}</span> · ${n} kayıt bulutta${wait ? ` · ${wait} yükleniyor` : ''}${offline ? ' · bağlantı sorunu, tekrar denenecek' : ''}</p>`;
    queue();
    pull(false).then(ch => { if (ch && sheetEl().hidden) rerender(); });
  }

  // ---------- KVKK: ses/görüntü rızası, geri alma, hesap silme ----------
  function mediaConsentAsk() {
    const ok = confirm('Ses ve görüntü kayıtlarının hesabında (yurt dışındaki sunucularda) saklanmasına ve seçtiklerini eğitmene gönderebilmeye açık rıza veriyor musun?\n\nAyrıntılar: Gizlilik ve KVKK sayfası. Rızanı Profil → Hesap bölümünden istediğin zaman geri alabilirsin.');
    if (!ok) return;
    setConsent(null, null, true).then(() => {
      (S.port || []).forEach(z => { if (z.cerr === 'consent') delete z.cerr; });
      save(); toast('Rızan kaydedildi; kayıtların yükleniyor'); queue(); rerender();
    }).catch(e => toast('Kaydedilemedi: ' + (e.message || e)));
  }

  // Tüm dosyaları depodan siler (klasör = kullanıcı kimliği)
  async function removeAllFiles() {
    for (let i = 0; i < 50; i++) {
      const l = await sb.storage.from(BUCKET).list(user.id, { limit: 100 });
      if (l.error) throw l.error;
      const names = (l.data || []).filter(f => f && f.name && f.id !== null).map(f => user.id + '/' + f.name);
      if (!names.length) return;
      const r = await sb.storage.from(BUCKET).remove(names);
      if (r.error) throw r.error;
    }
  }

  async function withdrawMedia() {
    if (!confirm('Ses/görüntü rızanı geri alırsan buluttaki bütün kayıtların ve eğitmene gönderdiklerin silinir. Bu cihazda bulunan kayıtlar cihazda kalır. Devam edilsin mi?')) return;
    try {
      await pull(true);
      // Önce yeni yüklemeyi durdur, sonra buluttakileri sil
      await setConsent(null, null, false);
      const d = await sb.from('recordings').delete().eq('user_id', user.id);
      if (d.error) throw d.error;
      await removeAllFiles();
      const keep = [];
      for (const z of S.port || []) {
        if (!z.cid || !mine(z)) { keep.push(z); continue; }
        const local = z.key && z.key.startsWith('port:') && await blobGet(z.key);
        if (local) { ['cid', 'owner', 'path', 'shared', 'feedback', 'feedback_at'].forEach(k => delete z[k]); keep.push(z); }
        else if (z.key && z.key.startsWith('cloud:')) await blobDel(z.key);
      }
      S.port = keep; save();
      toast('Rızan geri alındı, buluttaki kayıtların silindi');
    } catch (e) { toast('Tamamlanamadı: ' + (e.message || e)); }
    rerender();
  }

  async function deleteAccount(msg) {
    msg.textContent = 'Siliniyor…'; msg.className = 'clst';
    try {
      await removeAllFiles();
      const r = await sb.rpc('delete_my_account');
      if (r.error) throw r.error;
    } catch (e) { msg.textContent = 'Silinemedi: ' + (e.message || e); msg.className = 'clst err'; return; }
    // Bu cihazdaki hesap verilerini de temizle
    for (const z of S.port || []) if (z.key && /^(port|cloud):/.test(z.key)) await blobDel(z.key);
    S.port = []; clearTimeout(pTimer);
    clearProgressLocal();
    trainer = false; cons = null;
    try { await sb.auth.signOut({ scope: 'local' }); } catch (e) {}
    user = null;
    toast('Hesabın ve bütün verilerin silindi');
    rerender();
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
        <p class="note" style="margin:12px 0 0">Hesap oluşturuyorsan:</p>
        <label class="ck"><input type="checkbox" id="ack1"><span><a href="${PRIV}#aydinlatma" target="_blank" rel="noopener">Aydınlatma Metni</a>’ni okudum.</span></label>
        <label class="ck"><input type="checkbox" id="ack2"><span>18 yaşından büyüğüm ya da velimin onayı var.</span></label>
        <label class="ck"><input type="checkbox" id="ack3"><span>Ses ve görüntü kayıtlarımın hesabımda saklanmasına ve seçtiklerimi eğitmene gönderebilmeye <a href="${PRIV}#riza" target="_blank" rel="noopener">açık rıza</a> veriyorum.<small>İsteğe bağlı.</small></span></label>
        <div class="row-btns"><button class="btn" data-in>Giriş yap</button><button class="btn ghost" data-up>Hesap oluştur</button></div>
        <button class="btn ghost sm" data-forgot>Şifremi unuttum</button><p class="note" data-acmsg style="margin:10px 0 0"></p>
        <p class="note" style="margin:10px 0 0">🔒 <a class="pl" href="${PRIV}" target="_blank" rel="noopener">Gizlilik ve KVKK</a></p></div>`;
      const em = el.querySelector('#acm'), pw = el.querySelector('#acp'), msg = el.querySelector('[data-acmsg]');
      const busy = on => el.querySelectorAll('button').forEach(b => b.disabled = on);
      el.querySelector('[data-in]').onclick = async () => {
        busy(true); msg.textContent = '';
        const r = await sb.auth.signInWithPassword({ email: em.value.trim(), password: pw.value });
        busy(false); if (r.error) msg.textContent = authMsg(r.error); else toast('Giriş yapıldı');
      };
      el.querySelector('[data-up]').onclick = async () => {
        if (pw.value.length < 6) { msg.textContent = 'Şifre en az 6 karakter olmalı.'; return; }
        if (!el.querySelector('#ack1').checked || !el.querySelector('#ack2').checked) { msg.textContent = 'Hesap oluşturmak için Aydınlatma Metni’ni okuduğunu ve yaş/veli onayını işaretle.'; return; }
        try { localStorage.setItem(PEND, JSON.stringify({ email: em.value.trim().toLowerCase(), kvkk: KVKK_V, media: el.querySelector('#ack3').checked })); } catch (e) {}
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
      <div class="row-btns">${trainer ? '<button class="btn" data-panel>Eğitmen paneli</button>' : ''}<button class="btn ghost sm" data-out>Çıkış yap</button></div>
      ${cons && !cons.legacy ? `<p class="note" style="margin:12px 0 0">🔒 <a class="pl" href="${PRIV}" target="_blank" rel="noopener">Gizlilik ve KVKK</a> · Ses/görüntü rızası: <b>${cons.media ? 'verildi' : 'verilmedi'}</b></p>
      <div class="row-btns" style="margin-top:6px">${cons.media ? '<button class="btn ghost sm" data-mw>Rızamı geri al</button>' : '<button class="btn ghost sm" data-mg>Rıza ver</button>'}<button class="btn ghost sm" data-del>Hesabımı ve verilerimi sil</button></div>
      <div class="dz" data-dz hidden><b>Hesabın kalıcı olarak silinecek</b><p class="note" style="margin:4px 0 0">Buluttaki kayıtların, eğitmen notları, ilerlemen (XP, görevler, CV) ve rıza geçmişin silinir; geri alınamaz. Onaylamak için aşağıya <b>SİL</b> yaz.</p>
        <input type="text" data-dzi autocomplete="off" aria-label="Onay"><div class="row-btns" style="margin:0"><button class="btn danger sm" data-dzok disabled>Kalıcı olarak sil</button><button class="btn ghost sm" data-dzno>Vazgeç</button></div><p class="clst" data-dzm></p></div>` : `<p class="note" style="margin:12px 0 0">🔒 <a class="pl" href="${PRIV}" target="_blank" rel="noopener">Gizlilik ve KVKK</a></p>`}</div>`;
    const p = el.querySelector('[data-panel]'); if (p) p.onclick = () => openSheet('egitmen');
    const mw = el.querySelector('[data-mw]'); if (mw) mw.onclick = withdrawMedia;
    const mg = el.querySelector('[data-mg]'); if (mg) mg.onclick = mediaConsentAsk;
    const del = el.querySelector('[data-del]');
    if (del) {
      const dz = el.querySelector('[data-dz]'), inp = el.querySelector('[data-dzi]'), okb = el.querySelector('[data-dzok]');
      del.onclick = () => { dz.hidden = false; inp.focus(); };
      el.querySelector('[data-dzno]').onclick = () => { dz.hidden = true; inp.value = ''; okb.disabled = true; };
      inp.oninput = () => { okb.disabled = inp.value.trim().toLocaleUpperCase('tr') !== 'SİL'; };
      okb.onclick = () => { okb.disabled = true; deleteAccount(el.querySelector('[data-dzm]')); };
    }
    if (!cons) loadConsent().then(() => { if (cons && el.isConnected) accountCard(el); });
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

  async function token() {
    if (!user) return null;
    try { const { data } = await sb.auth.getSession(); return data && data.session ? data.session.access_token : null; } catch (e) { return null; }
  }

  // ---------- ilerlemenin cihazlar arası eşitlenmesi ----------
  // Eşitlenenler. Mikrofon ayarı, izinler, önbellekler, ses/video (Kayıtlarım'da ayrıca eşitlenir) cihazda kalır.
  const P_DEF = { xp: 0, done: {}, best: {}, days: {}, street: {}, streetLog: [], ai_tasks: [], genTexts: [], myPoems: [], aiPoems: [], gen: {},
    name: 'Adınız Soyadınız', first: '', last: '', cv: {}, script: '', theme: undefined, lang: undefined, subs: undefined, marks: undefined, musicVol: undefined, onboarded: undefined };
  const P_KEYS = Object.keys(P_DEF);
  const SCALAR = new Set(['name', 'first', 'last', 'cv', 'script', 'theme', 'lang', 'subs', 'marks', 'musicVol', 'onboarded']);
  const clone = v => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const baseKey = () => 'yayindasin-sync-base:' + (user ? user.id : '');
  const loadBase = () => { try { return JSON.parse(localStorage.getItem(baseKey()) || 'null'); } catch (e) { return null; } };
  const storeBase = b => { try { localStorage.setItem(baseKey(), JSON.stringify(b)); } catch (e) {} };
  const snapshot = () => { const o = {}; P_KEYS.forEach(k => { if (S[k] !== undefined) o[k] = clone(S[k]); }); return o; };
  const itemKey = x => (x && typeof x === 'object' && x.id != null) ? 'id:' + x.id : 'j:' + JSON.stringify(x);
  const unionArr = (a, b) => { const seen = new Set(), out = []; [...(a || []), ...(b || [])].forEach(x => { const k = itemKey(x); if (!seen.has(k)) { seen.add(k); out.push(x); } }); return out; };

  // 3 yönlü birleştirme: L = bu cihaz, R = bulut, B = son eşitlemedeki hal (yoksa ilk eşitleme)
  function mergeProgress(L, R, B) {
    const first = !B; B = B || {}; R = R || {};
    const out = {};
    for (const k of P_KEYS) {
      const l = L[k], r = R[k], b = B[k];
      if (k === 'xp') { out.xp = Math.max(0, (+r || 0) + ((+l || 0) - (+b || 0))); continue; } // bu cihazda kazanılan farkı buluta ekle
      if (SCALAR.has(k)) {
        if (first) { out[k] = (r !== undefined && !(k === 'name' && r === P_DEF.name)) ? r : l; } // ilk girişte hesaptaki bilgi geçerli
        else out[k] = same(l, b) ? (r !== undefined ? r : l) : l; // bu cihazda değiştiyse cihazdaki, değişmediyse buluttaki
        continue;
      }
      if (k === 'done' || k === 'best') { const o = { ...(r || {}) }; Object.entries(l || {}).forEach(([i, v]) => { o[i] = Math.max(+o[i] || 0, +v || 0); }); out[k] = o; continue; }
      if (k === 'days') { const o = {}; [r || {}, l || {}].forEach(src => Object.entries(src).forEach(([d, ids]) => { o[d] = unionArr(o[d], ids); })); out[k] = o; continue; }
      if (k === 'street') { out[k] = { ...(r || {}), ...(l || {}) }; continue; }
      if (k === 'gen') { const o = {}; [r || {}, l || {}].forEach(src => Object.entries(src).forEach(([kind, arr]) => { o[kind] = unionArr(o[kind], arr); })); out[k] = o; continue; }
      out[k] = unionArr(r, l); // streetLog, ai_tasks, genTexts, myPoems, aiPoems
    }
    return out;
  }

  let pTimer = null, pChain = Promise.resolve(), pErr = false;
  function syncSoon() { if (!user) return; clearTimeout(pTimer); pTimer = setTimeout(() => syncProgress(), 2500); }
  function syncProgress() { pChain = pChain.then(doSync).catch(e => console.warn('[Yayındasın ilerleme]', e)); return pChain; }
  async function doSync() {
    for (let attempt = 0; attempt < 6; attempt++) {
      if (!user) return;
      const uid = user.id;
      const got = await sb.from('progress').select('data,rev').eq('user_id', uid).maybeSingle();
      if (got.error) { pErr = true; return; }
      if (!user || user.id !== uid) return;
      const remote = got.data ? got.data.data : null, rev = got.data ? (+got.data.rev || 0) : null;
      const local = snapshot();
      const merged = mergeProgress(local, remote || {}, remote ? loadBase() : (loadBase() || {}));
      const changedHere = !same(merged, local);
      if (changedHere) { P_KEYS.forEach(k => { if (merged[k] !== undefined) S[k] = clone(merged[k]); }); rawSave(); }
      if (!same(merged, remote)) {
        const now = new Date().toISOString();
        let res;
        if (rev === null) res = await sb.from('progress').insert({ user_id: uid, data: merged, rev: 1, updated_at: now }).select('rev');
        else res = await sb.from('progress').update({ data: merged, rev: rev + 1, updated_at: now }).eq('user_id', uid).eq('rev', rev).select('rev');
        const conflict = (res.error && res.error.code === '23505') || (!res.error && (!res.data || !res.data.length));
        if (conflict) { await new Promise(r => setTimeout(r, 150 + Math.random() * 350)); continue; } // başka cihaz arada yazdı: yeniden oku, birleştir
        if (res.error) { pErr = true; console.warn('[Yayındasın ilerleme]', res.error.message); return; }
      }
      pErr = false; storeBase(merged);
      if (changedHere && sheetEl().hidden) rerender(); // açık bir alıştırmayı bölme
      return;
    }
    pErr = true;
  }
  function clearProgressLocal() { try { localStorage.removeItem(baseKey()); } catch (e) {} P_KEYS.forEach(k => { if (k === 'theme' || k === 'lang' || k === 'onboarded') return; S[k] = clone(P_DEF[k]); }); rawSave(); }

  // Uygulama her kaydettiğinde (XP, görev, CV…) birkaç saniye sonra buluta da gönder
  const rawSave = window.save;
  window.save = function () { rawSave(); syncSoon(); };
  document.addEventListener('visibilitychange', () => { if (!document.hidden && user) { syncProgress(); loadConsent().then(() => { if (cons && !cons.legacy && cons.kvkk !== KVKK_V) consentDialog(); }); } });
  window.addEventListener('pagehide', () => { if (pTimer && user) { clearTimeout(pTimer); syncProgress(); } });

  window.Cloud = {
    enabled: true, token, get user() { return user; }, get trainer() { return trainer; },
    queue, update, remove, url, decorate, kayitStatus, accountCard, saveName, syncProgress, _merge: mergeProgress,
    get consent() { return cons; }, KVKK_V
  };
  rerender();
})();
