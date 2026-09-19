// Nút "Cài app" — tạo icon trên màn hình (Windows/Mac/Android/iPhone/iPad) để mở như app riêng.
// File độc lập (script thường, không module), dùng chung cho taichinh + hoctap.
//  - Chỗ nào có <div data-pwa-install></div> sẽ tự hiện nút (data-btn-class để đặt class nút).
//  - Trên điện thoại/máy tính bảng chưa cài: hiện 1 thanh gợi ý nhỏ, bấm ✕ là không hiện lại.
//  - Chrome/Edge/Android: bấm là hiện hộp cài chính chủ (beforeinstallprompt).
//  - iPhone/iPad, Safari Mac, Firefox: Apple/Mozilla không cho web tự cài → hiện hướng dẫn từng bước.
(function () {
  'use strict';
  let deferred = null;
  const ua = navigator.userAgent;
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isAndroid = /Android/.test(ua);
  const isSamsung = /SamsungBrowser/.test(ua);
  const isEdge = /Edg\//.test(ua);
  const isFirefox = /Firefox|FxiOS/.test(ua);
  const isMacSafari = !isIOS && /Macintosh/.test(ua) && /Safari/.test(ua) && !/Chrome|Chromium|Edg|Firefox/.test(ua);
  const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const appName = () => document.querySelector('meta[name="application-name"]')?.content || document.title.split('—').pop().trim();
  const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };

  const CSS = `
  .pwa-btn{display:inline-flex;align-items:center;gap:8px}
  .pwa-ico{width:18px;height:18px;flex:none}
  .pwa-bd{position:fixed;inset:0;background:rgba(8,12,18,.5);z-index:200;display:grid;place-items:end center}
  @media(min-width:700px){.pwa-bd{place-items:center}}
  .pwa-sheet{background:var(--surface,#fff);color:var(--text,var(--ink,#111));width:min(440px,100%);border-radius:20px 20px 0 0;padding:20px 20px calc(20px + env(safe-area-inset-bottom));box-shadow:0 16px 40px rgba(0,0,0,.3);font:inherit}
  @media(min-width:700px){.pwa-sheet{border-radius:20px}}
  .pwa-sheet h3{margin:0 0 4px;font-size:18px}.pwa-sheet p{margin:0 0 14px;color:var(--muted,#6b7280);font-size:14px}
  .pwa-sheet ol{margin:0 0 16px;padding:0;list-style:none;counter-reset:s;display:grid;gap:10px}
  .pwa-sheet li{counter-increment:s;display:flex;gap:12px;align-items:flex-start;font-size:15px;line-height:1.45}
  .pwa-sheet li::before{content:counter(s);flex:none;width:26px;height:26px;border-radius:50%;display:grid;place-items:center;background:var(--brand,var(--accent,#0B7A6F));color:#fff;font-weight:700;font-size:13px}
  .pwa-sheet kbd{display:inline-flex;align-items:center;gap:4px;padding:1px 7px;border-radius:6px;border:1px solid var(--border,#d0d5dd);background:var(--surface-2,#f2f4f7);font:600 13px/1.6 inherit;white-space:nowrap}
  .pwa-sheet kbd svg{width:15px;height:15px}
  .pwa-close{width:100%;min-height:44px;border-radius:11px;border:0;background:var(--brand,var(--accent,#0B7A6F));color:#fff;font:600 15px inherit;cursor:pointer}
  .pwa-banner{position:fixed;left:12px;right:12px;top:calc(10px + env(safe-area-inset-top));z-index:150;display:flex;align-items:center;gap:10px;padding:10px 10px 10px 12px;border-radius:14px;background:var(--surface,#fff);color:var(--text,var(--ink,#111));border:1px solid var(--border,#e3e6eb);box-shadow:0 10px 30px rgba(0,0,0,.18);font-size:14px}
  .pwa-banner img{width:36px;height:36px;border-radius:9px;flex:none}
  .pwa-banner b{display:block}.pwa-banner span{color:var(--muted,#6b7280);font-size:12.5px}
  .pwa-banner .pwa-go{margin-left:auto;border:0;border-radius:10px;padding:8px 12px;background:var(--brand,var(--accent,#0B7A6F));color:#fff;font:600 13px inherit;cursor:pointer;white-space:nowrap}
  .pwa-banner .pwa-x{border:0;background:none;color:var(--muted,#6b7280);font-size:18px;padding:4px 6px;cursor:pointer}
  @media(min-width:900px){.pwa-banner{display:none}}`;
  const style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style);

  const SVG = {
    down: '<svg class="pwa-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7 10l5 5 5-5"/><rect x="3" y="17" width="18" height="4" rx="1"/></svg>',
    share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M8 7l4-4 4 4"/><path d="M5 11v9h14v-9"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="18" height="18" rx="4"/><path d="M12 8v8M8 12h8"/></svg>',
    dots: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="19" r="1.8"/></svg>',
  };

  // Hướng dẫn từng bước theo đúng máy/trình duyệt đang dùng
  function steps() {
    if (isIOS) return {
      note: 'iPhone/iPad không cho trang web tự cài — làm 3 bước này (mất 10 giây):',
      list: [`Bấm nút <kbd>${SVG.share} Chia sẻ</kbd> (Safari: thanh dưới cùng; Chrome: góc trên phải)`,
        `Kéo xuống, chọn <kbd>${SVG.plus} Thêm vào MH chính</kbd>`, 'Bấm <kbd>Thêm</kbd> ở góc trên phải — icon hiện ngay trên màn hình chính'],
    };
    if (isMacSafari) return {
      note: 'Safari trên Mac cài app qua Dock:',
      list: ['Trên thanh menu chọn <kbd>Tệp</kbd> (File)', 'Chọn <kbd>Thêm vào Dock…</kbd> (Add to Dock)', 'Bấm <kbd>Thêm</kbd> — app xuất hiện ở Dock và Launchpad'],
    };
    if (isFirefox) return {
      note: 'Firefox chưa hỗ trợ cài trang web thành app.',
      list: ['Mở trang này bằng <kbd>Chrome</kbd>, <kbd>Edge</kbd> hoặc <kbd>Safari</kbd>', 'Bấm lại nút <kbd>Cài app</kbd>'],
    };
    if (isSamsung) return {
      note: 'Trên Samsung Internet:',
      list: ['Bấm <kbd>☰</kbd> menu dưới cùng', 'Chọn <kbd>Thêm trang vào</kbd> → <kbd>Màn hình chờ</kbd>'],
    };
    if (isAndroid) return {
      note: 'Trên Chrome Android:',
      list: [`Bấm <kbd>${SVG.dots}</kbd> góc trên phải`, 'Chọn <kbd>Thêm vào màn hình chính</kbd> → <kbd>Cài đặt</kbd>'],
    };
    if (isEdge) return {
      note: 'Trên Microsoft Edge:',
      list: ['Bấm <kbd>…</kbd> góc trên phải', 'Chọn <kbd>Ứng dụng</kbd> → <kbd>Cài đặt trang web này dưới dạng ứng dụng</kbd>'],
    };
    return {
      note: 'Trên Chrome (Windows/Mac):',
      list: ['Bấm biểu tượng <kbd>⊕ Cài đặt</kbd> ở cuối thanh địa chỉ, <b>hoặc</b>',
        `Bấm <kbd>${SVG.dots}</kbd> → <kbd>Truyền, lưu và chia sẻ</kbd> → <kbd>Cài đặt trang dưới dạng ứng dụng</kbd>`],
    };
  }

  function showHelp() {
    const s = steps();
    const bd = document.createElement('div');
    bd.className = 'pwa-bd';
    bd.innerHTML = `<div class="pwa-sheet" role="dialog" aria-modal="true" aria-label="Cài app"><h3>Cài ${esc(appName())} lên máy</h3><p>${s.note}</p>
      <ol>${s.list.map((x) => `<li><span>${x}</span></li>`).join('')}</ol><button class="pwa-close" type="button">Đã hiểu</button></div>`;
    const close = () => bd.remove();
    bd.addEventListener('click', (e) => { if (e.target === bd) close(); });
    bd.querySelector('.pwa-close').onclick = close;
    document.addEventListener('keydown', function k(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', k); } });
    document.body.appendChild(bd);
  }

  async function install() {
    if (deferred) {
      deferred.prompt();
      const { outcome } = await deferred.userChoice.catch(() => ({}));
      deferred = null;
      if (outcome === 'accepted') store.set('pwa-installed', '1');
      refresh();
      return;
    }
    showHelp();
  }

  function esc(t) { return String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  function refresh() {
    const installed = isStandalone();
    document.querySelectorAll('[data-pwa-install]').forEach((el) => {
      if (installed) { el.innerHTML = el.dataset.installedText ? `<span class="small muted">${esc(el.dataset.installedText)}</span>` : ''; return; }
      el.innerHTML = `<button type="button" class="pwa-btn ${esc(el.dataset.btnClass || 'btn')}">${SVG.down}${esc(el.dataset.label || 'Cài app lên máy')}</button>`;
      el.querySelector('button').onclick = install;
    });
    const banner = document.getElementById('pwa-banner');
    if (banner && (installed || store.get('pwa-banner-off'))) banner.remove();
  }

  function maybeBanner() {
    if (isStandalone() || store.get('pwa-banner-off') || store.get('pwa-installed') || window.PWA_NO_BANNER) return;
    if (!(isIOS || isAndroid || matchMedia('(max-width: 899px)').matches)) return;
    const icon = document.querySelector('link[rel="apple-touch-icon"]')?.href || '';
    const b = document.createElement('div');
    b.id = 'pwa-banner'; b.className = 'pwa-banner'; b.setAttribute('role', 'region'); b.setAttribute('aria-label', 'Cài app');
    b.innerHTML = `${icon ? `<img src="${esc(icon)}" alt="">` : ''}<div><b>Cài ${esc(appName())}</b><span>Mở nhanh từ màn hình chính như app</span></div>
      <button type="button" class="pwa-go">Cài app</button><button type="button" class="pwa-x" aria-label="Ẩn gợi ý">✕</button>`;
    b.querySelector('.pwa-go').onclick = install;
    b.querySelector('.pwa-x').onclick = () => { store.set('pwa-banner-off', '1'); b.remove(); };
    document.body.appendChild(b);
  }

  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; refresh(); });
  window.addEventListener('appinstalled', () => { deferred = null; store.set('pwa-installed', '1'); refresh(); });
  const start = () => { refresh(); setTimeout(maybeBanner, 1500); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  // Trang vẽ lại DOM (SPA) thì gọi window.PWAInstall.refresh() để gắn lại nút
  window.PWAInstall = { refresh, install, isStandalone, canPrompt: () => !!deferred };
})();
