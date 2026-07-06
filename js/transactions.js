import { renderNav, requireToken, showError } from './nav.js';
import { loadCategories, loadTransactions, deleteTransaction, formatVnd, currentMonthKey, categoryName, categoryIcon, shiftMonthKey, paymentMethodName } from './store.js';

renderNav('transactions');

function monthLabel(monthKey) {
  const [y, m] = monthKey.split('-');
  return `Tháng ${Number(m)}/${y}`;
}

const params = new URLSearchParams(location.search);
let monthKey = params.get('month') || currentMonthKey();
let categories = null;
let transactions = [];

const filterTypeEl = document.getElementById('filter-type');
const filterCategoryEl = document.getElementById('filter-category');
const filterPaymentEl = document.getElementById('filter-payment');
const filterPriorityEl = document.getElementById('filter-priority');
const filterNoteEl = document.getElementById('filter-note');

function populateFilterOptions() {
  const catOptions = [
    ...categories.income.map((c) => `<option value="${c.id}">💰 ${c.name}</option>`),
    ...categories.expense.map((c) => `<option value="${c.id}">${categoryIcon(c.id)} ${c.name}</option>`),
  ];
  filterCategoryEl.innerHTML = '<option value="">Tất cả danh mục</option>' + catOptions.join('');
  filterPaymentEl.innerHTML =
    '<option value="">Tất cả phương thức</option>' + categories.paymentMethods.map((p) => `<option value="${p.id}">${p.name}</option>`).join('');
  filterPriorityEl.innerHTML =
    '<option value="">Tất cả mức ưu tiên</option>' + categories.priorities.map((p) => `<option value="${p.id}">${p.name}</option>`).join('');
}

function matchesFilters(t) {
  const type = filterTypeEl.value;
  const cat = filterCategoryEl.value;
  const payment = filterPaymentEl.value;
  const priority = filterPriorityEl.value;
  const note = filterNoteEl.value.trim().toLowerCase();
  if (type && t.type !== type) return false;
  if (cat && t.category !== cat) return false;
  if (payment) {
    const matchesPayment = t.type === 'transfer' ? t.fromPayment === payment || t.toPayment === payment : t.paymentMethod === payment;
    if (!matchesPayment) return false;
  }
  if (priority && t.priority !== priority) return false;
  if (note && !(t.note || '').toLowerCase().includes(note)) return false;
  return true;
}

function renderList() {
  const listEl = document.getElementById('tx-list');
  const summaryEl = document.getElementById('filter-summary');
  const filtered = transactions.filter(matchesFilters);
  const hasActiveFilter = [filterTypeEl, filterCategoryEl, filterPaymentEl, filterPriorityEl].some((el) => el.value) || filterNoteEl.value.trim();

  if (hasActiveFilter) {
    const totalIncome = filtered.filter((t) => t.type === 'income').reduce((s, t) => s + t.amount, 0);
    const totalExpense = filtered.filter((t) => t.type === 'expense').reduce((s, t) => s + t.amount, 0);
    const totalTransfer = filtered.filter((t) => t.type === 'transfer').reduce((s, t) => s + t.amount, 0);
    const totalParts = [
      totalIncome ? `Thu: ${formatVnd(totalIncome)}` : '',
      totalExpense ? `Chi: ${formatVnd(totalExpense)}` : '',
      totalTransfer ? `Chuyển khoản: ${formatVnd(totalTransfer)}` : '',
    ].filter(Boolean);
    summaryEl.style.display = 'block';
    summaryEl.textContent = `Đang lọc: ${filtered.length}/${transactions.length} giao dịch — ${totalParts.join(' · ')}`;
  } else {
    summaryEl.style.display = 'none';
  }

  if (!transactions.length) {
    listEl.innerHTML = '<p class="muted">Chưa có giao dịch nào trong tháng này.</p>';
    return;
  }
  if (!filtered.length) {
    listEl.innerHTML = '<p class="muted">Không có giao dịch nào khớp bộ lọc.</p>';
    return;
  }

  const sorted = [...filtered].sort((a, b) => (a.date < b.date ? 1 : -1));
  listEl.innerHTML = sorted
      .map((t) => {
        if (t.type === 'transfer') {
          const name = `Chuyển: ${paymentMethodName(categories, t.fromPayment)} → ${paymentMethodName(categories, t.toPayment)}`;
          return `
            <div class="tx-row" data-id="${t.id}">
              <div class="tx-main">
                <span class="tx-icon">🔁</span>
                <div class="tx-text">
                  <span class="tx-cat">${name}</span>
                  <span class="tx-note">${t.date}${t.note ? ' · ' + t.note : ''}</span>
                </div>
              </div>
              <div style="display:flex;align-items:center;">
                <span class="tx-amount transfer">↔ ${formatVnd(t.amount)}</span>
                <div class="tx-actions">
                  <button class="edit-btn" title="Sửa">✏️</button>
                  <button class="del-btn" title="Xoá">🗑️</button>
                </div>
              </div>
            </div>`;
        }
        const name = categoryName(categories, t.type, t.category);
        const icon = t.type === 'income' ? '💰' : categoryIcon(t.category);
        const sign = t.type === 'income' ? '+' : '-';
        return `
          <div class="tx-row" data-id="${t.id}">
            <div class="tx-main">
              <span class="tx-icon">${icon}</span>
              <div class="tx-text">
                <span class="tx-cat">${name}</span>
                <span class="tx-note">${t.date}${t.note ? ' · ' + t.note : ''}</span>
              </div>
            </div>
            <div style="display:flex;align-items:center;">
              <span class="tx-amount ${t.type}">${sign}${formatVnd(t.amount)}</span>
              <div class="tx-actions">
                <button class="edit-btn" title="Sửa">✏️</button>
                <button class="del-btn" title="Xoá">🗑️</button>
              </div>
            </div>
          </div>`;
      })
      .join('');

  listEl.querySelectorAll('.edit-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.closest('.tx-row').dataset.id;
      location.href = `add.html?edit=${id}&month=${monthKey}`;
    });
  });
  listEl.querySelectorAll('.del-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.closest('.tx-row').dataset.id;
      if (!confirm('Xoá giao dịch này?')) return;
      try {
        await deleteTransaction(monthKey, id);
        load();
      } catch (err) {
        showError(err);
      }
    });
  });
}

async function load() {
  document.getElementById('month-label').textContent = monthLabel(monthKey);
  document.getElementById('loading').style.display = 'block';
  document.getElementById('tx-list').innerHTML = '';
  try {
    const [catResult, txResult] = await Promise.all([loadCategories(), loadTransactions(monthKey)]);
    categories = catResult.categories;
    transactions = txResult.transactions;
    populateFilterOptions();
    document.getElementById('loading').style.display = 'none';
    renderList();
  } catch (err) {
    document.getElementById('loading').style.display = 'none';
    showError(err);
  }
}

[filterTypeEl, filterCategoryEl, filterPaymentEl, filterPriorityEl].forEach((el) => el.addEventListener('change', renderList));
filterNoteEl.addEventListener('input', renderList);
document.getElementById('filter-clear').addEventListener('click', () => {
  filterTypeEl.value = '';
  filterCategoryEl.value = '';
  filterPaymentEl.value = '';
  filterPriorityEl.value = '';
  filterNoteEl.value = '';
  renderList();
});

document.getElementById('prev-month').addEventListener('click', () => { monthKey = shiftMonthKey(monthKey, -1); load(); });
document.getElementById('next-month').addEventListener('click', () => { monthKey = shiftMonthKey(monthKey, 1); load(); });

(async () => {
  if (!(await requireToken())) return;
  load();
})();
