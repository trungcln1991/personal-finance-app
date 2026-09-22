import { getJsonFile, putJsonFile, listDir } from './github-api.js';

export function genId() {
  return 'tx-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

export function currentMonthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Ngày hôm nay dạng YYYY-MM-DD theo giờ LOCAL (không dùng toISOString để tránh lệch ngày
// khi giờ VN đã sang ngày mới nhưng UTC còn ở ngày hôm trước).
export function todayDateStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function formatDateVn(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-');
  return `${d}/${m}/${y}`;
}

export function shiftMonthKey(monthKey, delta) {
  const [y, m] = monthKey.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function previousMonthKey(monthKey) {
  return shiftMonthKey(monthKey, -1);
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
  return { categories: data || { income: [], expense: [], paymentMethods: [], priorities: [], defaultIncomes: [] }, sha };
}

export async function saveCategories(categories, sha) {
  return putJsonFile('categories.json', categories, sha, 'Cập nhật danh mục');
}

export async function loadBudget() {
  const { data, sha } = await getJsonFile('budget.json');
  return { budget: data || { categories: {} }, sha };
}

// ---- Giá trị hiệu lực theo tháng (budget theo danh mục, lương mặc định...) ----
// Mỗi field-cần-đổi-theo-thời-gian lưu 1 mảng "versions": [{ from: 'YYYY-MM', until?: 'YYYY-MM', ...giá trị }].
// Bản ghi có hiệu lực cho 1 tháng = bản ghi có from <= tháng đó (và until >= tháng đó nếu có until),
// ưu tiên bản ghi có from lớn nhất trong số các bản ghi thoả điều kiện.

export function resolveVersioned(versions, monthKey) {
  const candidates = (versions || []).filter((v) => v.from <= monthKey && (!v.until || monthKey <= v.until));
  if (!candidates.length) return null;
  return candidates.reduce((best, v) => (v.from > best.from ? v : best));
}

function stripVersionMeta(v) {
  const { from, until, ...rest } = v;
  return rest;
}

// Thêm 1 bản ghi hiệu lực mới bắt đầu từ monthKey.
// temporary=true: chỉ áp dụng đúng monthKey đó, tháng sau tự động quay lại giá trị trước đó.
// temporary=false: áp dụng từ monthKey trở về sau (không giới hạn), các tháng trước đó giữ nguyên.
export function addVersionOverride(versions, monthKey, valueFields, temporary) {
  const list = (versions || []).filter((v) => v.from !== monthKey);
  const prevActive = resolveVersioned(list, monthKey);
  list.push({ from: monthKey, ...(temporary ? { until: monthKey } : {}), ...valueFields });
  if (temporary) {
    const nextMonth = shiftMonthKey(monthKey, 1);
    const nextAlreadyHasOverride = list.some((v) => v.from === nextMonth);
    if (!nextAlreadyHasOverride && prevActive) {
      list.push({ from: nextMonth, ...stripVersionMeta(prevActive) });
    }
  }
  return list.sort((a, b) => (a.from < b.from ? -1 : 1));
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

// Dữ liệu cũ (trước khi có type/owner) không có các trường này — mặc định tiền mặt, dùng chung.
// lastPaidMonth là cách tính nợ cũ (đóng sổ theo mốc tháng), nay chỉ dùng để suy ra nợ đầu kỳ
// cho dữ liệu chưa migrate: đã trả hết đến hết tháng X ⇒ nợ đầu kỳ = 0 kể từ ngày 01 tháng X+1.
export function normalizePaymentMethod(p) {
  const base = {
    type: 'cash', owner: 'shared', initialBalance: 0, initialBalanceDate: null,
    openingDebt: 0, openingDebtDate: null, statementDay: null, dueDay: null, ...p,
  };
  if (!base.openingDebtDate && base.lastPaidMonth) {
    base.openingDebt = 0;
    base.openingDebtDate = `${shiftMonthKey(base.lastPaidMonth, 1)}-01`;
  }
  return base;
}

// ---- Chu kỳ sao kê thẻ tín dụng / ví trả sau (statementDay = ngày chốt, dueDay = ngày đến hạn) ----
// Quy ước: dueDay luôn rơi vào tháng NGAY SAU tháng chốt sao kê (đúng cách HSBC/Mono công bố).
// statementDay/dueDay > số ngày thực của tháng đó sẽ tự co về ngày cuối tháng (dùng cho "chốt cuối
// tháng" kiểu Mono — nhập statementDay=31, tháng nào cũng tự hiểu là ngày cuối cùng).

function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

function resolveMonthDay(year, month, day) {
  return Math.min(day, daysInMonth(year, month));
}

function toDateStr(year, month, day) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function addMonths(year, month, delta) {
  const d = new Date(year, month - 1 + delta, 1);
  return { year: d.getFullYear(), month: d.getMonth() + 1 };
}

// Trả về mốc chu kỳ sao kê GẦN NHẤT đã/đang chốt tính đến `todayStr`:
// - lastCloseDate: ngày chốt sao kê gần nhất (đã qua hoặc đúng hôm nay)
// - dueDate: hạn thanh toán cho kỳ vừa chốt đó (ngày dueDay của tháng kế tiếp tháng chốt)
// - nextCloseDate: ngày chốt kế tiếp (kỳ đang mở, chưa tới)
export function getStatementCycle(p, todayStr) {
  const [ty, tm] = todayStr.split('-').map(Number);
  const closeThisMonth = toDateStr(ty, tm, resolveMonthDay(ty, tm, p.statementDay));
  let closeYear = ty, closeMonth = tm;
  if (todayStr < closeThisMonth) {
    const prev = addMonths(ty, tm, -1);
    closeYear = prev.year; closeMonth = prev.month;
  }
  const lastCloseDate = toDateStr(closeYear, closeMonth, resolveMonthDay(closeYear, closeMonth, p.statementDay));
  const dueMonth = addMonths(closeYear, closeMonth, 1);
  const dueDate = toDateStr(dueMonth.year, dueMonth.month, resolveMonthDay(dueMonth.year, dueMonth.month, p.dueDay));
  const nextClose = addMonths(closeYear, closeMonth, 1);
  const nextCloseDate = toDateStr(nextClose.year, nextClose.month, resolveMonthDay(nextClose.year, nextClose.month, p.statementDay));
  return { lastCloseDate, dueDate, nextCloseDate };
}

// Đọc toàn bộ giao dịch từ 1 tháng trở về sau (để cộng dồn số dư tài khoản).
export async function loadTransactionsRange(fromMonthKey) {
  const months = await listAvailableMonths();
  const targets = fromMonthKey ? months.filter((m) => m >= fromMonthKey) : months;
  const results = await Promise.all(targets.map((m) => loadTransactions(m)));
  return results.flatMap((r) => r.transactions);
}

// Số dư = số dư ban đầu (nhập tay tại 1 ngày) + cộng dồn thu/chi/chuyển khoản gắn phương thức đó
// từ ngày đó. Trả về balance = null nếu chưa cấu hình ngày bắt đầu (tránh hiện số sai).
export function computeAccountBalances(categories, allTx) {
  return categories.paymentMethods
    .map(normalizePaymentMethod)
    .filter((p) => paymentType(p.type).tracksBalance)
    .map((p) => {
      if (!p.initialBalanceDate) return { ...p, balance: null };
      const delta = allTx
        .filter((t) => t.date >= p.initialBalanceDate && !t.excludeFromBalance)
        .reduce((s, t) => {
          if (t.type === 'transfer') {
            if (t.toPayment === p.id) return s + t.amount;
            if (t.fromPayment === p.id) return s - t.amount;
            return s;
          }
          if (t.paymentMethod !== p.id) return s;
          return s + (t.type === 'income' ? t.amount : -t.amount);
        }, 0);
      return { ...p, balance: p.initialBalance + delta };
    });
}

// Nợ thẻ tín dụng/ví trả sau tính như sổ nợ (ledger), không đóng sổ theo mốc tháng:
//   nợ = nợ đầu kỳ + mọi chi tiêu bằng phương thức đó − mọi khoản đã chuyển trả cho nó.
// Nhờ vậy trả một phần vẫn đúng, và nhập bù giao dịch cũ không làm mất nợ.
// Mốc tách "đã chốt sao kê, đến hạn" / "kỳ hiện tại, chưa chốt" ưu tiên dùng chu kỳ thật
// (statementDay/dueDay, xem getStatementCycle) nếu đã cấu hình; nếu chưa cấu hình thì fallback
// về cách cũ (chia theo tháng lịch) để không phá dữ liệu các phương thức chưa cập nhật.
export function computeDebtStatus(categories, allTx, todayStr) {
  const todayMonthKey = todayStr.slice(0, 7);
  return categories.paymentMethods
    .map(normalizePaymentMethod)
    .filter((p) => !paymentType(p.type).tracksBalance)
    .map((p) => {
      if (!p.openingDebtDate) {
        return { ...p, configured: false, totalDebt: 0, dueAmount: 0, currentMonthSpend: 0, paidAmount: 0, canPay: false, dueDate: null, isOverdue: false };
      }
      const cycle = p.statementDay && p.dueDay ? getStatementCycle(p, todayStr) : null;
      let spendBefore = 0;
      let currentMonthSpend = 0;
      let paidAmount = 0;
      for (const t of allTx) {
        if (t.date < p.openingDebtDate) continue;
        if (t.type === 'expense' && t.paymentMethod === p.id) {
          const isBilled = cycle ? t.date <= cycle.lastCloseDate : t.date.slice(0, 7) !== todayMonthKey;
          if (isBilled) spendBefore += t.amount;
          else currentMonthSpend += t.amount;
        } else if (t.type === 'transfer' && t.toPayment === p.id) {
          paidAmount += t.amount;
        }
      }
      const totalDebt = p.openingDebt + spendBefore + currentMonthSpend - paidAmount;
      const dueAmount = Math.max(0, p.openingDebt + spendBefore - paidAmount);
      const dueDate = cycle ? cycle.dueDate : null;
      const isOverdue = !!(dueDate && dueAmount > 0 && todayStr > dueDate);
      return { ...p, configured: true, totalDebt, dueAmount, currentMonthSpend, paidAmount, canPay: totalDebt > 0, dueDate, isOverdue };
    });
}

// ════════ "Tháng trả thật" (22/09/2026, 3T chốt) ════════
// Khoản quẹt thẻ tín dụng / ví trả sau KHÔNG thuộc tháng quẹt mà thuộc THÁNG PHẢI TRẢ theo sao kê:
//   HSBC chốt 14, hạn 5 tháng sau → quẹt 01–14/9 trả 05/10 (tháng 10) · quẹt 15–30/9 trả 05/11 (tháng 11).
//   Mono chốt cuối tháng, hạn 10 → quẹt tháng 9 trả 10/10 (tháng 10).
//   Thẻ/ví chưa cấu hình ngày chốt → mặc định tháng kế tiếp.
// Tiền mặt/ngân hàng: tháng của chính ngày giao dịch.

export function statementDueDate(p, dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  if (!(p.statementDay && p.dueDay)) {
    const n = addMonths(y, m, 1);
    return toDateStr(n.year, n.month, 1);   // chưa cấu hình chu kỳ: tính vào tháng sau
  }
  let cy = y, cm = m;
  if (d > resolveMonthDay(y, m, p.statementDay)) { const n = addMonths(y, m, 1); cy = n.year; cm = n.month; }
  const due = addMonths(cy, cm, 1);
  return toDateStr(due.year, due.month, resolveMonthDay(due.year, due.month, p.dueDay));
}

// Bảng tra id → phương thức (đã chuẩn hoá) + tập id thẻ/ví
export function debtMethodMap(categories) {
  const map = new Map();
  for (const p of (categories.paymentMethods || []).map(normalizePaymentMethod)) {
    if (!paymentType(p.type).tracksBalance) map.set(p.id, p);
  }
  return map;
}

// Tháng mà 1 giao dịch được TÍNH vào (Chi, danh mục, ngân sách). Thu/chi qua thẻ/ví → tháng phải trả.
// Khoản trước mốc theo dõi nợ (openingDebtDate) coi như đã tất toán trong sổ cũ → giữ tháng quẹt.
export function effectiveMonth(t, debtMap) {
  const p = t.type !== 'transfer' ? debtMap.get(t.paymentMethod) : null;
  if (!p || (p.openingDebtDate && t.date < p.openingDebtDate)) return t.date.slice(0, 7);
  return statementDueDate(p, t.date).slice(0, 7);
}

// Tổng hợp 1 tháng theo "tháng trả thật".
//  income   = thu tiền thật trong tháng (+ hoàn tiền về thẻ/ví tính vào tháng phải trả, vì nó trừ vào kỳ đó)
//  out      = chi tiền mặt/ngân hàng trong tháng + khoản quẹt thẻ/ví đến hạn trả trong tháng
//  expenseList = đúng các khoản chi tạo nên `out` (dùng cho danh mục, ngân sách, mức độ)
//  cardDue  = phần của `out` đến từ thẻ/ví (quẹt từ trước, trả tháng này)
//  debtPaid = tiền thật đã chuyển trả thẻ/ví trong tháng (chỉ để hiển thị, KHÔNG cộng vào out — tránh tính 2 lần)
export function monthSummary(allTx, monthKey, debtMap) {
  let income = 0, cashOut = 0, cardDue = 0, debtPaid = 0;
  const expenseList = [];
  for (const t of allTx) {
    if (t.type === 'transfer') {
      if (t.date.slice(0, 7) === monthKey && debtMap.has(t.toPayment) && !debtMap.has(t.fromPayment)) debtPaid += t.amount;
      continue;
    }
    if (effectiveMonth(t, debtMap) !== monthKey) continue;
    const viaCard = debtMap.has(t.paymentMethod);
    if (t.type === 'income') { income += t.amount; continue; }
    if (t.type !== 'expense') continue;
    expenseList.push(viaCard ? { ...t, dueMonth: monthKey } : t);
    if (viaCard) cardDue += t.amount; else cashOut += t.amount;
  }
  return { income, out: cashOut + cardDue, cashOut, cardDue, debtPaid, expenseList };
}

// Sổ nợ theo tháng đến hạn, cho 1 tháng đang xem M và mốc "đã trả tính tới ngày" paidUntil:
//  unpaidDue = nợ ĐÃ tới hạn trong/trước tháng M mà chưa trả (đang trễ nếu đã qua ngày hạn)
//  nextDue   = phải trả trong tháng M+1 (sau khi trừ phần đã trả trước)
//  later     = phải trả từ tháng M+2 trở đi (vd HSBC quẹt sau ngày chốt)
// Thanh toán (chuyển vào thẻ/ví) và hoàn tiền (thu qua thẻ/ví) trừ vào khoản đến hạn SỚM NHẤT trước.
export function debtSchedule(categories, allTx, monthKey, paidUntil) {
  const debtMap = debtMethodMap(categories);
  const next = shiftMonthKey(monthKey, 1);
  const rows = [];
  for (const p of debtMap.values()) {
    if (!p.openingDebtDate) continue;
    const byMonth = new Map();        // tháng đến hạn → số tiền
    const add = (mk, a) => byMonth.set(mk, (byMonth.get(mk) || 0) + a);
    if (p.openingDebt) add(p.openingDebtDate.slice(0, 7), p.openingDebt);
    let paid = 0;
    for (const t of allTx) {
      if (t.date < p.openingDebtDate || t.date > paidUntil) continue;
      if (t.type === 'expense' && t.paymentMethod === p.id) add(effectiveMonth(t, debtMap), t.amount);
      else if (t.type === 'transfer' && t.fromPayment === p.id) add(statementDueDate(p, t.date).slice(0, 7), t.amount);  // rút tiền mặt từ thẻ
      else if (t.type === 'transfer' && t.toPayment === p.id) paid += t.amount;
      else if (t.type === 'income' && t.paymentMethod === p.id) paid += t.amount;   // hoàn tiền về thẻ
    }
    const through = (mk) => [...byMonth].filter(([k]) => k <= mk).reduce((s, [, a]) => s + a, 0);
    const total = through('9999-12');
    const unpaid = (mk) => Math.max(0, through(mk) - paid);
    const unpaidDue = unpaid(monthKey);
    const nextDue = unpaid(next) - unpaidDue;
    rows.push({ id: p.id, name: p.name, type: p.type, unpaidDue, nextDue, later: Math.max(0, total - paid) - unpaid(next), total: total - paid });
  }
  return rows;
}
