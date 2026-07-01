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
