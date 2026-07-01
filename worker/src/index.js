// Cloudflare Worker: proxy giữa app tĩnh (public) và GitHub Contents API (private data repo).
// Giữ GITHUB_TOKEN ở phía server (Cloudflare secret) — không bao giờ lộ ra trình duyệt/code public.
// Client chỉ cần nhớ 1 mật khẩu ngắn (APP_PASSWORD) để đăng nhập, đổi lấy 1 session token
// tự ký (SESSION_SECRET), dùng cho các request tiếp theo tới /contents/*.

const GITHUB_OWNER = 'trungcln1991';
const DATA_REPO = 'personal-finance-data';

const ALLOWED_ORIGINS = [
  'https://trungcln1991.github.io',
  'http://localhost:3000',
  'http://localhost:8080',
];

const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 ngày

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET,PUT,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function bufToHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmacHex(payload, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return bufToHex(sig);
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

async function createSessionToken(secret) {
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const payload = String(expiresAt);
  const sig = await hmacHex(payload, secret);
  return `${payload}.${sig}`;
}

async function verifySessionToken(token, secret) {
  if (!token || !token.includes('.')) return false;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return false;
  if (Date.now() > Number(payload)) return false;
  const expected = await hmacHex(payload, secret);
  return timingSafeEqual(sig, expected);
}

function json(data, status, cors) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }

    if (url.pathname === '/login' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      if (!timingSafeEqual(body.password, env.APP_PASSWORD)) {
        return json({ error: 'Sai mật khẩu' }, 401, cors);
      }
      const token = await createSessionToken(env.SESSION_SECRET);
      return json({ token }, 200, cors);
    }

    if (url.pathname.startsWith('/contents/')) {
      const authHeader = request.headers.get('Authorization') || '';
      const sessionToken = authHeader.replace(/^Bearer\s+/i, '');
      const valid = await verifySessionToken(sessionToken, env.SESSION_SECRET);
      if (!valid) {
        return json({ error: 'Phiên đăng nhập hết hạn, đăng nhập lại' }, 401, cors);
      }

      const path = url.pathname.slice('/contents/'.length);
      const githubUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${DATA_REPO}/contents/${path}${url.search}`;
      const githubRes = await fetch(githubUrl, {
        method: request.method,
        headers: {
          Authorization: `Bearer ${env.GITHUB_TOKEN}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'personal-finance-worker',
          'Content-Type': 'application/json',
        },
        body: request.method === 'PUT' ? await request.text() : undefined,
      });
      const text = await githubRes.text();
      return new Response(text, {
        status: githubRes.status,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    return json({ error: 'Not found' }, 404, cors);
  },
};
