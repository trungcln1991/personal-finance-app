import { hasToken } from './github-api.js';

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

export function renderNav(active) {
  const items = [
    { href: 'index.html', label: 'Tổng quan', id: 'dashboard' },
    { href: 'add.html', label: 'Thêm', id: 'add' },
    { href: 'transactions.html', label: 'Giao dịch', id: 'transactions' },
    { href: 'settings.html', label: 'Cài đặt', id: 'settings' },
  ];
  const nav = document.createElement('nav');
  nav.className = 'bottom-nav';
  nav.innerHTML = items
    .map(
      (it) => `<a href="${it.href}" class="nav-item ${it.id === active ? 'active' : ''}">${it.label}</a>`
    )
    .join('');
  document.body.appendChild(nav);
}

// Chặn dùng app nếu chưa cấu hình token, điều hướng về Cài đặt.
export async function requireToken() {
  if (!hasToken()) {
    document.body.innerHTML = `
      <div class="setup-screen">
        <h1>Sổ Thu Chi</h1>
        <p>Chưa cấu hình kết nối tới kho dữ liệu GitHub.</p>
        <a class="btn btn-primary" href="settings.html">Vào Cài đặt để nhập token</a>
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
    document.querySelector('main')?.prepend(el);
    return el;
  })();
  box.textContent = err.message || String(err);
  box.style.display = 'block';
}

export function clearError() {
  const box = document.getElementById('error-box');
  if (box) box.style.display = 'none';
}
