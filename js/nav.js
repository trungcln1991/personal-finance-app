import { hasToken } from './github-api.js';
import { IS_LOCAL } from './config.js';

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

// Icon nét mảnh (kiểu Lucide), vẽ bằng SVG inline để không phụ thuộc CDN.
const PATHS = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M9.5 21v-6h5v6"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r="1"/><circle cx="3.5" cy="12" r="1"/><circle cx="3.5" cy="18" r="1"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  sparkle: '<path d="M12 3l1.8 4.9L19 9.7l-5.2 1.8L12 16.5l-1.8-5L5 9.7l5.2-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  left: '<path d="m15 18-6-6 6-6"/>',
  right: '<path d="m9 18 6-6-6-6"/>',
  up: '<path d="M7 17 17 7M8 7h9v9"/>',
  down: '<path d="M17 7 7 17M16 17H7V8"/>',
  wallet: '<path d="M19 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0 0 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5"/><path d="M16 14h.01"/>',
  card: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/>',
  alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  filter: '<path d="M3 5h18l-7 8.5V20l-4-2v-4.5z"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.1 3.9M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  swap: '<path d="M7 7h13l-4-4M17 17H4l4 4"/>',
  tag: '<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  pie: '<path d="M21 12A9 9 0 1 1 12 3v9z"/><path d="M15 3.5A9 9 0 0 1 20.5 9H15z"/>',
  calendar: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 10h18M8 2v4M16 2v4"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 15h10l1-15"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
};
export function icon(name, cls = 'icon') {
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name] || ''}</svg>`;
}

// ---- Giao diện sáng/tối: 'light' | 'dark' | '' (theo máy) ----
export function getTheme() {
  try { return localStorage.getItem('theme') || ''; } catch { return ''; }
}
export function setTheme(t) {
  try { t ? localStorage.setItem('theme', t) : localStorage.removeItem('theme'); } catch {}
  if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
}

// ---- Người đang đăng nhập (Cloudflare Access) ----
let mePromise;
export function getMe() {
  if (!IS_LOCAL) return Promise.resolve(null);
  mePromise ||= fetch('/api/me').then((r) => (r.ok ? r.json() : null)).catch(() => null);
  return mePromise;
}
export const LOGOUT_URL = '/cdn-cgi/access/logout';

const NAV = [
  { href: 'index.html', label: 'Tổng quan', id: 'dashboard', icon: 'home' },
  { href: 'transactions.html', label: 'Giao dịch', id: 'transactions', icon: 'list' },
  { href: 'ai.html', label: 'Trợ lý AI', short: 'Trợ lý', id: 'ai', icon: 'sparkle' },
  { href: 'settings.html', label: 'Cài đặt', id: 'settings', icon: 'settings' },
];

export function renderNav(active) {
  const side = document.createElement('aside');
  side.className = 'sidebar';
  side.innerHTML = `
    <a class="brand" href="index.html"><span class="brand-mark">₫</span>Sổ Thu Chi</a>
    <a class="btn btn-primary side-add" href="add.html">${icon('plus')}Thêm giao dịch</a>
    ${NAV.map((it) => `<a href="${it.href}" class="side-link ${it.id === active ? 'active' : ''}">${icon(it.icon)}${it.label}</a>`).join('')}
    <div class="side-foot">
      <div class="side-user"><span class="avatar" id="side-avatar">·</span><div class="who"><span class="muted">Đang đăng nhập</span><b id="side-email">—</b></div></div>
    </div>`;
  document.body.prepend(side);

  const tab = document.createElement('nav');
  tab.className = 'tabbar';
  tab.setAttribute('aria-label', 'Điều hướng chính');
  const t = (it) => `<a href="${it.href}" class="tab ${it.id === active ? 'active' : ''}">${icon(it.icon)}<span>${it.short || it.label}</span></a>`;
  tab.innerHTML = `${t(NAV[0])}${t(NAV[1])}
    <a href="add.html" class="tab-add" aria-label="Thêm giao dịch"><span>${icon('plus')}</span></a>
    ${t(NAV[2])}${t(NAV[3])}`;
  document.body.appendChild(tab);

  getMe().then((me) => {
    if (!me?.email) return;
    document.getElementById('side-email').textContent = me.email;
    document.getElementById('side-avatar').textContent = me.email[0];
  });
}

// Chặn dùng app nếu chưa đăng nhập (chỉ còn ý nghĩa ở bản GitHub Pages cũ).
export async function requireToken() {
  if (!hasToken()) {
    document.querySelector('main').innerHTML = `
      <div class="setup-screen">
        <h1>Sổ Thu Chi</h1>
        <p class="muted">Chưa đăng nhập trên thiết bị này.</p>
        <a class="btn btn-primary" href="settings.html">Vào Cài đặt để đăng nhập</a>
      </div>`;
    return false;
  }
  return true;
}

export function showError(err) {
  const box = document.getElementById('error-box') || (() => {
    const el = document.createElement('div');
    el.id = 'error-box';
    el.className = 'error-box';
    el.setAttribute('role', 'alert');
    document.querySelector('main')?.prepend(el);
    return el;
  })();
  box.textContent = err.message || String(err);
  box.style.display = 'block';
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

export function clearError() {
  const box = document.getElementById('error-box');
  if (box) box.style.display = 'none';
}

let toastTimer;
export function toast(msg) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast'; el.className = 'toast'; el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

// Bottom sheet dùng chung (chi tiết giao dịch...). Trả về hàm đóng.
export function openSheet(html, onMount) {
  const bd = document.createElement('div');
  bd.className = 'sheet-backdrop';
  const sh = document.createElement('div');
  sh.className = 'sheet'; sh.setAttribute('role', 'dialog'); sh.setAttribute('aria-modal', 'true');
  sh.innerHTML = `<div class="grab"></div>${html}`;
  document.body.append(bd, sh);
  requestAnimationFrame(() => { bd.classList.add('open'); sh.classList.add('open'); });
  const close = () => {
    bd.classList.remove('open'); sh.classList.remove('open');
    document.removeEventListener('keydown', onKey);
    setTimeout(() => { bd.remove(); sh.remove(); }, 220);
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  bd.addEventListener('click', close);
  onMount?.(sh, close);
  return close;
}

// Ẩn số tiền (khi mở app nơi đông người) — nhớ theo thiết bị.
export function isPrivate() {
  try { return localStorage.getItem('privacy') === '1'; } catch { return false; }
}
export function setPrivate(on) {
  try { localStorage.setItem('privacy', on ? '1' : '0'); } catch {}
  document.body.classList.toggle('privacy', on);
}
if (isPrivate()) document.addEventListener('DOMContentLoaded', () => document.body.classList.add('privacy'));
