import { renderNav, requireToken, showError, icon, toast } from './nav.js';
import { loadCategories, loadTransactions, loadTransactionsRange, formatVnd, currentMonthKey, categoryName, categoryIcon, shiftMonthKey, paymentMethodName, priorityName, formatDateVn } from './store.js';
import { esc } from './ai-client.js';
import { txRowHtml, openTxDetail, dayLabel, hydrateIcons, txTitle } from './ui.js';
import { setAiContext } from './ai-drawer.js';

renderNav('transactions');
hydrateIcons();
const $ = (id) => document.getElementById(id);
$('prev-month').innerHTML = icon('left');
$('next-month').innerHTML = icon('right');

const monthLabel = (mk) => { const [y, m] = mk.split('-'); return `Tháng ${Number(m)}/${y}`; };
const params = new URLSearchParams(location.search);
let monthKey = params.get('month') || currentMonthKey();
let categories = null;
let transactions = [];

const F = {
  type: $('filter-type'), cat: $('filter-category'), pay: $('filter-payment'), prio: $('filter-priority'),
  q: $('filter-note'), from: $('filter-from'), to: $('filter-to'),
};

// Có chọn khoảng ngày thì nạp nhiều tháng thay vì 1 tháng.
const isRangeMode = () => Boolean(F.from.value || F.to.value);

function populateFilterOptions() {
  const keep = (el, html) => { const v = el.value; el.innerHTML = html; el.value = v; };
  keep(F.cat, '<option value="">Tất cả</option>'
    + `<optgroup label="Chi">${categories.expense.map((c) => `<option value="${esc(c.id)}">${categoryIcon(c.id)} ${esc(c.name)}</option>`).join('')}</optgroup>`
    + `<optgroup label="Thu">${categories.income.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}</optgroup>`);
  keep(F.pay, '<option value="">Tất cả</option>' + categories.paymentMethods.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join(''));
  keep(F.prio, '<option value="">Tất cả</option>' + categories.priorities.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join(''));
}

// Bỏ dấu tiếng Việt để tìm "an sang" vẫn ra "ăn sáng".
const fold = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd');

function matches(t) {
  if (F.from.value && t.date < F.from.value) return false;
  if (F.to.value && t.date > F.to.value) return false;
  if (F.type.value && t.type !== F.type.value) return false;
  if (F.cat.value && t.category !== F.cat.value) return false;
  if (F.pay.value) {
    const p = F.pay.value;
    if (!(t.type === 'transfer' ? t.fromPayment === p || t.toPayment === p : t.paymentMethod === p)) return false;
  }
  if (F.prio.value && t.priority !== F.prio.value) return false;
  const q = fold(F.q.value.trim());
  if (q) {
    const hay = fold(`${t.note || ''} ${txTitle(t, categories)} ${t.amount}`);
    const qDigits = q.replace(/[.,\s]/g, '');
    if (!hay.includes(q) && !(qDigits && /^\d+$/.test(qDigits) && String(t.amount).includes(qDigits))) return false;
  }
  return true;
}

function activeFilterCount() {
  return [F.type, F.cat, F.pay, F.prio, F.from, F.to].filter((el) => el.value).length;
}

function renderList() {
  const list = $('tx-list');
  const filtered = transactions.filter(matches).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const n = activeFilterCount();
  $('filter-count').textContent = n; $('filter-count').classList.toggle('hidden', !n);

  const inc = filtered.filter((t) => t.type === 'income').reduce((s, t) => s + t.amount, 0);
  const exp = filtered.filter((t) => t.type === 'expense').reduce((s, t) => s + t.amount, 0);
  $('s-in').textContent = '+' + formatVnd(inc);
  $('s-out').textContent = '−' + formatVnd(exp);
  $('s-net').textContent = (inc - exp >= 0 ? '+' : '−') + formatVnd(Math.abs(inc - exp));
  $('s-net').className = 'money ' + (inc - exp >= 0 ? 'pos' : 'neg');
  $('s-net-l').textContent = 'Chênh lệch';
  $('range-label').dataset.count = filtered.length;
  $('range-label').textContent = `${$('range-label').dataset.base || 'Sổ giao dịch'} · ${filtered.length} giao dịch`;

  const scope = isRangeMode() ? $('range-label').dataset.base : monthLabel(monthKey);
  const filt = [F.type, F.cat, F.pay, F.prio].filter((e) => e.value).map((e) => e.options[e.selectedIndex].text).concat(F.q.value.trim() ? [`tìm "${F.q.value.trim()}"`] : []);
  setAiContext(`Trang Giao dịch, ${scope}${filt.length ? ', lọc: ' + filt.join(', ') : ''}. Đang hiện ${filtered.length} giao dịch: thu ${formatVnd(inc)}, chi ${formatVnd(exp)}. `
    + 'Danh sách (ngày|loại|tên|số tiền|ghi chú): ' + filtered.slice(0, 60).map((t) => `${t.date}|${t.type}|${txTitle(t, categories)}|${t.amount}|${t.note || ''}`).join('; '),
  `Giao dịch ${scope}${filt.length ? ' (đang lọc)' : ''}`,
  ['Tóm tắt các giao dịch đang hiện', 'Khoản nào lớn bất thường?', 'Ngày nào chi nhiều nhất, vì sao?', 'Gom nhóm các khoản ăn uống giúp mình']);

  if (!transactions.length) {
    list.innerHTML = `<div class="card empty"><div class="big">📒</div>Chưa có giao dịch nào ${isRangeMode() ? 'trong khoảng ngày này' : 'trong tháng này'}.<br><a class="btn btn-primary" style="margin-top:12px" href="add.html">Thêm giao dịch</a></div>`;
    return;
  }
  if (!filtered.length) {
    list.innerHTML = '<div class="card empty"><div class="big">🔍</div>Không có giao dịch nào khớp bộ lọc.</div>';
    return;
  }
  const byDay = new Map();
  for (const t of filtered) { if (!byDay.has(t.date)) byDay.set(t.date, []); byDay.get(t.date).push(t); }
  list.innerHTML = [...byDay].map(([d, items]) => {
    const net = items.reduce((s, t) => s + (t.type === 'income' ? t.amount : t.type === 'expense' ? -t.amount : 0), 0);
    return `<section class="day-group"><div class="day-head"><span>${dayLabel(d)}</span><span class="money">${net ? (net > 0 ? '+' : '−') + formatVnd(Math.abs(net)) : ''}</span></div>
      <div class="tx-card">${items.map((t) => txRowHtml(t, categories)).join('')}</div></section>`;
  }).join('');
  list.querySelectorAll('.tx-item').forEach((el) => {
    el.onclick = () => openTxDetail(filtered.find((t) => t.id === el.dataset.id), categories, load);
  });
}

async function load() {
  const range = isRangeMode();
  $('month-switcher').hidden = range;
  $('month-switcher').style.display = range ? 'none' : '';
  $('range-label').dataset.base = range
    ? `${F.from.value ? formatDateVn(F.from.value) : 'Từ đầu'} → ${F.to.value ? formatDateVn(F.to.value) : 'nay'}`
    : 'Sổ giao dịch';
  $('range-label').textContent = $('range-label').dataset.base;
  $('month-label').textContent = monthLabel(monthKey);
  $('loading').hidden = false;
  $('tx-list').innerHTML = '';
  try {
    const fromMk = F.from.value ? F.from.value.slice(0, 7) : undefined;
    const [c, tx] = await Promise.all([
      loadCategories(),
      range ? loadTransactionsRange(fromMk) : loadTransactions(monthKey).then((r) => r.transactions),
    ]);
    categories = c.categories;
    transactions = tx;
    populateFilterOptions();
    $('loading').hidden = true;
    renderList();
  } catch (err) {
    $('loading').hidden = true;
    showError(err);
  }
}

// Xuất CSV (mở được bằng Excel, có BOM để giữ tiếng Việt) theo đúng bộ lọc đang áp dụng.
function exportCsv() {
  const rows = transactions.filter(matches).sort((a, b) => (a.date < b.date ? -1 : 1));
  if (!rows.length) { toast('Không có giao dịch để xuất'); return; }
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['Ngày', 'Loại', 'Danh mục', 'Số tiền', 'Phương thức', 'Từ', 'Đến', 'Mức độ', 'Ghi chú'];
  const lines = rows.map((t) => [
    t.date,
    t.type === 'income' ? 'Thu' : t.type === 'expense' ? 'Chi' : 'Chuyển khoản',
    t.type === 'transfer' ? '' : categoryName(categories, t.type, t.category),
    t.type === 'expense' ? -t.amount : t.amount,
    t.paymentMethod ? paymentMethodName(categories, t.paymentMethod) : '',
    t.fromPayment ? paymentMethodName(categories, t.fromPayment) : '',
    t.toPayment ? paymentMethodName(categories, t.toPayment) : '',
    t.type === 'expense' ? priorityName(categories, t.priority || 'nice') : '',
    t.note || '',
  ].map(q).join(','));
  const blob = new Blob(['\ufeff' + [head.map(q).join(','), ...lines].join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `so-thu-chi-${isRangeMode() ? `${F.from.value || 'dau'}_${F.to.value || 'nay'}` : monthKey}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast(`Đã xuất ${rows.length} giao dịch`);
}

[F.type, F.cat, F.pay, F.prio].forEach((el) => el.addEventListener('change', renderList));
F.q.addEventListener('input', renderList);
[F.from, F.to].forEach((el) => el.addEventListener('change', load));
$('filter-toggle').onclick = () => {
  const open = $('filters-card').classList.toggle('hidden') === false;
  $('filter-toggle').setAttribute('aria-expanded', open);
};
$('filter-clear').onclick = () => {
  const wasRange = isRangeMode();
  Object.values(F).forEach((el) => { el.value = ''; });
  wasRange ? load() : renderList();
};
$('export-csv').onclick = exportCsv;
$('prev-month').onclick = () => { monthKey = shiftMonthKey(monthKey, -1); history.replaceState(null, '', `?month=${monthKey}`); load(); };
$('next-month').onclick = () => { monthKey = shiftMonthKey(monthKey, 1); history.replaceState(null, '', `?month=${monthKey}`); load(); };

(async () => {
  if (!(await requireToken())) return;
  load();
})();
