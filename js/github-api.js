import { WORKER_URL, BRANCH } from './config.js';

const SESSION_KEY = 'pfa_session';

function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToUtf8(b64) {
  const binary = atob(b64.replace(/\s/g, ''));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function getToken() {
  return localStorage.getItem(SESSION_KEY) || '';
}

export function clearToken() {
  localStorage.removeItem(SESSION_KEY);
}

export function hasToken() {
  return !!getToken();
}

// Đăng nhập bằng mật khẩu app (không phải token GitHub thật) -> đổi lấy session token.
export async function login(password) {
  const res = await fetch(`${WORKER_URL}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Sai mật khẩu.');
  }
  const { token } = await res.json();
  localStorage.setItem(SESSION_KEY, token);
  return token;
}

async function proxyFetch(path, options = {}) {
  const token = getToken();
  return fetch(`${WORKER_URL}/contents/${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      ...(options.headers || {}),
    },
  });
}

export async function testToken() {
  if (!hasToken()) return { ok: false, message: 'Chưa đăng nhập.' };
  const res = await proxyFetch(`categories.json?ref=${BRANCH}`);
  if (res.status === 401) return { ok: false, message: 'Phiên đăng nhập hết hạn, đăng nhập lại.' };
  if (!res.ok) return { ok: false, message: `Lỗi (${res.status}).` };
  return { ok: true, message: 'Kết nối OK.' };
}

// Đọc 1 file JSON trong repo data. Trả về { data, sha }.
// data = null nếu file chưa tồn tại (chưa từng ghi).
export async function getJsonFile(path) {
  const res = await proxyFetch(`${path}?ref=${BRANCH}&_=${Date.now()}`);
  if (res.status === 404) return { data: null, sha: null };
  if (res.status === 401) throw new Error('Phiên đăng nhập hết hạn. Vào Cài đặt đăng nhập lại.');
  if (!res.ok) throw new Error(`Không đọc được ${path} (lỗi ${res.status}).`);
  const json = await res.json();
  const data = JSON.parse(base64ToUtf8(json.content));
  return { data, sha: json.sha };
}

// Ghi đè 1 file JSON. sha=null nếu file mới (tạo lần đầu).
export async function putJsonFile(path, data, sha, message) {
  const body = {
    message,
    content: utf8ToBase64(JSON.stringify(data, null, 2)),
    branch: BRANCH,
  };
  if (sha) body.sha = sha;
  const res = await proxyFetch(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 401) throw new Error('Phiên đăng nhập hết hạn. Vào Cài đặt đăng nhập lại.');
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    if (res.status === 409) throw new Error('Dữ liệu vừa bị thay đổi ở nơi khác. Tải lại trang rồi thử lại.');
    throw new Error(`Ghi ${path} thất bại (${res.status}): ${err.message || 'không rõ nguyên nhân'}`);
  }
  return res.json();
}

// Liệt kê các file trong 1 thư mục (dùng để lấy danh sách tháng có dữ liệu)
export async function listDir(path) {
  const res = await proxyFetch(`${path}?ref=${BRANCH}`);
  if (res.status === 404) return [];
  if (res.status === 401) throw new Error('Phiên đăng nhập hết hạn. Vào Cài đặt đăng nhập lại.');
  if (!res.ok) throw new Error(`Không đọc được thư mục ${path} (lỗi ${res.status}).`);
  return res.json();
}
