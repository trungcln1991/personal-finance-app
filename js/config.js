export const GITHUB_OWNER = 'trungcln1991';
export const DATA_REPO = 'personal-finance-data';
export const BRANCH = 'main';

// URL Worker sau khi deploy (worker/README.md). Cập nhật lại giá trị này sau bước `wrangler deploy`.
// Từ 19/09/2026: bản chính chạy trên PC E5 tại taichinh.dichvunamtrung.com (backend local, sau Cloudflare Access + MFA).
// Bản GitHub Pages cũ chỉ còn ĐỌC (khoá ghi) để tránh 2 nơi ghi làm lệch dữ liệu.
export const IS_LOCAL = location.hostname.startsWith('taichinh.') || location.hostname === '127.0.0.1' || location.hostname === 'localhost';
export const NEW_HOME = 'https://taichinh.dichvunamtrung.com';
export const WORKER_URL = IS_LOCAL ? '/api' : 'https://personal-finance-proxy.trung-caolenam.workers.dev';
