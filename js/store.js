import { getJsonFile, putJsonFile, listDir } from './github-api.js';

export function genId() {
  return 'tx-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

export function currentMonthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function formatVnd(amount) {
  return new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND', maximumFractionDigits: 0 }).format(amount || 0);
}

export function formatNumber(n) {
  return new Intl.NumberFormat('vi-VN').format(n || 0);
}

export function parseAmountInput(value) {
  return Number(String(value).replace(/\D/g, '')) || 0;
}

// Gắn định dạng phân cách nghìn (17.000.000) tự động khi gõ vào ô số tiền.
export function attachAmountInput(el) {
  el.addEventListener('input', () => {
    const digits = el.value.replace(/\D/g, '');
    el.value = digits ? formatNumber(Number(digits)) : '';
  });
}

export async function loadCategories() {
  const { data, sha } = await getJsonFile('categories.json');
  return { categories: data || { income: [], expense: [], paymentMethods: [], priorities: [] }, sha };
}

export async function saveCategories(categories, sha) {
  return putJsonFile('categories.json', categories, sha, 'Cập nhật danh mục');
}

export async function loadBudget() {
  const { data, sha } = await getJsonFile('budget.json');
  return { budget: data || {}, sha };
}

export async function saveBudget(budget, sha) {
  return putJsonFile('budget.json', budget, sha, 'Cập nhật ngân sách');
}

export async function loadTransactions(monthKey) {
  const { data, sha } = await getJsonFile(`transactions/${monthKey}.json`);
  return { transactions: data || [], sha };
}

export async function saveTransactions(monthKey, transactions, sha, message) {
  return putJsonFile(`transactions/${monthKey}.json`, transactions, sha, message);
}

// Thêm giao dịch mới: luôn đọc lại bản mới nhất trước khi ghi để tránh conflict.
export async function addTransaction(monthKey, tx) {
  const { transactions, sha } = await loadTransactions(monthKey);
  transactions.push(tx);
  transactions.sort((a, b) => (a.date < b.date ? -1 : 1));
  await saveTransactions(monthKey, transactions, sha, `Thêm giao dịch: ${tx.note || tx.category}`);
}

export async function updateTransaction(monthKey, txId, patch) {
  const { transactions, sha } = await loadTransactions(monthKey);
  const idx = transactions.findIndex((t) => t.id === txId);
  if (idx === -1) throw new Error('Không tìm thấy giao dịch để sửa.');
  transactions[idx] = { ...transactions[idx], ...patch };
  await saveTransactions(monthKey, transactions, sha, `Sửa giao dịch: ${transactions[idx].note || transactions[idx].category}`);
}

export async function deleteTransaction(monthKey, txId) {
  const { transactions, sha } = await loadTransactions(monthKey);
  const filtered = transactions.filter((t) => t.id !== txId);
  await saveTransactions(monthKey, filtered, sha, `Xoá giao dịch ${txId}`);
}

// Danh sách các tháng đã có file dữ liệu, mới nhất trước.
export async function listAvailableMonths() {
  const files = await listDir('transactions');
  return files
    .map((f) => f.name.replace('.json', ''))
    .filter((name) => /^\d{4}-\d{2}$/.test(name))
    .sort()
    .reverse();
}

export function categoryName(categories, type, id) {
  const list = type === 'income' ? categories.income : categories.expense;
  return list.find((c) => c.id === id)?.name || id;
}

export function paymentMethodName(categories, id) {
  return categories.paymentMethods.find((p) => p.id === id)?.name || '—';
}

export function priorityName(categories, id) {
  return categories.priorities.find((p) => p.id === id)?.name || id;
}

const CATEGORY_ICONS = {
  'dien-nuoc-internet': '💡',
  'con-di-hoc': '🎒',
  'ta-sua-cua-con': '🍼',
  'tien-xang-bao-tri-xe': '⛽',
  'tien-cho': '🛒',
  'tien-an-sang-chieu': '🍜',
  'tien-ich-dt-dich-vu': '📱',
  'do-dung-gia-dinh': '🏠',
  'cho-bieu-tang': '🎁',
  'quy-suc-khoe': '🏥',
  'quy-dau-tu-dai-han': '📈',
  'quy-du-phong': '🛡️',
  luong: '💰',
  'thu-ngoai': '➕',
};

export function categoryIcon(id) {
  return CATEGORY_ICONS[id] || '💵';
}

// ---- Phương thức thanh toán: loại + chủ sở hữu + số dư ----

export const PAYMENT_TYPES = [
  { id: 'cash', label: 'Tiền mặt', icon: '💵', tracksBalance: true },
  { id: 'bank', label: 'Tài khoản ngân hàng', icon: '🏦', tracksBalance: true },
  { id: 'credit', label: 'Thẻ tín dụng', icon: '💳', tracksBalance: false },
  { id: 'wallet', label: 'Ví trả sau', icon: '🧾', tracksBalance: false },
];

export const OWNERS = [
  { id: 'husband', label: 'Chồng' },
  { id: 'wife', label: 'Vợ' },
  { id: 'shared', label: 'Chung' },
];

export function paymentType(id) {
  return PAYMENT_TYPES.find((t) => t.id === id) || PAYMENT_TYPES[0];
}

export function ownerLabel(id) {
  return OWNERS.find((o) => o.id === id)?.label || 'Chung';
}

// Dữ liệu cũ (trước khi có type/owner) không có 2 trường này — mặc định tiền mặt, dùng chung.
export function normalizePaymentMethod(p) {
  return { type: 'cash', owner: 'shared', initialBalance: 0, initialBalanceDate: null, ...p };
}

// Đọc toàn bộ giao dịch từ 1 tháng trở về sau (để cộng dồn số dư tài khoản).
export async function loadTransactionsRange(fromMonthKey) {
  const months = await listAvailableMonths();
  const targets = fromMonthKey ? months.filter((m) => m >= fromMonthKey) : months;
  const results = await Promise.all(targets.map((m) => loadTransactions(m)));
  return results.flatMap((r) => r.transactions);
}

// Số dư = số dư ban đầu (nhập tay tại 1 ngày) + cộng dồn thu/chi gắn phương thức đó từ ngày đó.
// Trả về balance = null nếu chưa cấu hình ngày bắt đầu (tránh hiện số sai).
export function computeAccountBalances(categories, allTx) {
  return categories.paymentMethods
    .map(normalizePaymentMethod)
    .filter((p) => paymentType(p.type).tracksBalance)
    .map((p) => {
      if (!p.initialBalanceDate) return { ...p, balance: null };
      const delta = allTx
        .filter((t) => t.paymentMethod === p.id && t.date >= p.initialBalanceDate)
        .reduce((s, t) => s + (t.type === 'income' ? t.amount : -t.amount), 0);
      return { ...p, balance: p.initialBalance + delta };
    });
}
