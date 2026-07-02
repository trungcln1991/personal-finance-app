import { renderNav, showError, clearError } from './nav.js';
import { getToken, login, clearToken, testToken, hasToken } from './github-api.js';
import {
  loadCategories, saveCategories, loadBudget, saveBudget, genId, formatNumber, formatVnd,
  parseAmountInput, attachAmountInput, categoryIcon, currentMonthKey, previousMonthKey,
  PAYMENT_TYPES, OWNERS, paymentType, ownerLabel, normalizePaymentMethod,
} from './store.js';

renderNav('settings');

const passwordInput = document.getElementById('f-password');
const tokenStatus = document.getElementById('token-status');

document.getElementById('login-btn').addEventListener('click', async () => {
  tokenStatus.textContent = 'Đang đăng nhập…';
  try {
    await login(passwordInput.value);
    passwordInput.value = '';
    tokenStatus.textContent = 'Đăng nhập thành công. Trình duyệt này sẽ tự nhớ đăng nhập.';
  } catch (err) {
    tokenStatus.textContent = err.message;
  }
});

document.getElementById('clear-token').addEventListener('click', () => {
  clearToken();
  tokenStatus.textContent = 'Đã đăng xuất khỏi trình duyệt này.';
});

document.getElementById('test-token').addEventListener('click', async () => {
  tokenStatus.textContent = 'Đang kiểm tra…';
  const result = await testToken();
  tokenStatus.textContent = result.message;
});

// ---- Danh mục ----
let categories, categoriesSha;
let budget, budgetSha;

function slugify(s) {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

function renderCategoryList(containerId, list, onRemove, getIcon) {
  const el = document.getElementById(containerId);
  el.innerHTML = list
    .map(
      (c) => `<div class="category-manage-row" data-id="${c.id}">
        <span>${getIcon ? getIcon(c.id) + ' ' : ''}${c.name}</span>
        <button class="btn btn-danger remove-btn">Xoá</button>
      </div>`
    )
    .join('') || '<p class="muted">Chưa có danh mục nào.</p>';
  el.querySelectorAll('.remove-btn').forEach((btn) => {
    btn.addEventListener('click', () => onRemove(btn.closest('.category-manage-row').dataset.id));
  });
}

function renderAllCategoryLists() {
  renderCategoryList('expense-cat-list', categories.expense, removeExpenseCategory, categoryIcon);
  renderCategoryList('income-cat-list', categories.income, removeIncomeCategory, categoryIcon);
  renderPaymentList();
}

// ---- Phương thức thanh toán (có loại/chủ sở hữu/số dư, sửa được inline) ----

let editingPaymentId = null;

function selectOptions(list, selectedId) {
  return list.map((o) => `<option value="${o.id}" ${o.id === selectedId ? 'selected' : ''}>${o.icon ? o.icon + ' ' : ''}${o.label}</option>`).join('');
}

function renderPaymentList() {
  const el = document.getElementById('payment-list');
  if (!categories.paymentMethods.length) {
    el.innerHTML = '<p class="muted">Chưa có phương thức nào.</p>';
    return;
  }
  el.innerHTML = categories.paymentMethods
    .map((raw) => {
      const p = normalizePaymentMethod(raw);
      const t = paymentType(p.type);
      const sub = t.tracksBalance
        ? (p.initialBalanceDate ? `Số dư: ${formatVnd(p.initialBalance)} (từ ${p.initialBalanceDate})` : 'Chưa cấu hình số dư')
        : (p.lastPaidMonth ? `${t.label} · Đã trả nợ đến hết ${p.lastPaidMonth}` : `${t.label} · Chưa cấu hình nợ`);
      const editing = editingPaymentId === p.id;
      return `
        <div class="category-manage-row payment-row" data-id="${p.id}">
          <div class="payment-row-main">
            <span>${t.icon} ${p.name} <span class="muted">· ${ownerLabel(p.owner)}</span></span>
            <span class="pm-sub">${sub}</span>
          </div>
          <button class="btn btn-secondary edit-btn">${editing ? 'Đóng' : 'Sửa'}</button>
        </div>
        ${editing ? paymentEditPanelHtml(p) : ''}`;
    })
    .join('');

  el.querySelectorAll('.edit-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.closest('.payment-row').dataset.id;
      editingPaymentId = editingPaymentId === id ? null : id;
      renderPaymentList();
    });
  });

  if (editingPaymentId) wirePaymentEditPanel();
}

function paymentEditPanelHtml(p) {
  const t = paymentType(p.type);
  return `
    <div class="payment-edit-panel">
      <div class="field"><input type="text" class="pe-name" value="${p.name}" /></div>
      <div class="field"><label>Loại</label><select class="pe-type">${selectOptions(PAYMENT_TYPES, p.type)}</select></div>
      <div class="field"><label>Chủ sở hữu</label><select class="pe-owner">${selectOptions(OWNERS, p.owner)}</select></div>
      <div class="pe-balance-fields" style="display:${t.tracksBalance ? 'flex' : 'none'};gap:8px;">
        <div class="field" style="flex:1;"><label>Số dư hiện có</label><input type="text" inputmode="numeric" class="pe-balance" value="${formatNumber(p.initialBalance)}" /></div>
        <div class="field" style="flex:1;"><label>Tính từ ngày</label><input type="date" class="pe-balance-date" value="${p.initialBalanceDate || ''}" /></div>
      </div>
      <div class="field pe-debt-field" style="display:${t.tracksBalance ? 'none' : 'block'};">
        <label>Đã thanh toán nợ đến hết tháng</label>
        <input type="month" class="pe-last-paid-month" value="${p.lastPaidMonth || previousMonthKey(currentMonthKey())}" />
      </div>
      <div style="display:flex;gap:8px;">
        <button class="btn btn-primary pe-save">Lưu</button>
        <button class="btn btn-danger pe-remove">Xoá</button>
      </div>
    </div>`;
}

function wirePaymentEditPanel() {
  const panel = document.querySelector('#payment-list .payment-edit-panel');
  if (!panel) return;
  attachAmountInput(panel.querySelector('.pe-balance'));
  panel.querySelector('.pe-type').addEventListener('change', (e) => {
    const tracksBalance = paymentType(e.target.value).tracksBalance;
    panel.querySelector('.pe-balance-fields').style.display = tracksBalance ? 'flex' : 'none';
    panel.querySelector('.pe-debt-field').style.display = tracksBalance ? 'none' : 'block';
  });
  panel.querySelector('.pe-save').addEventListener('click', async () => {
    const idx = categories.paymentMethods.findIndex((c) => c.id === editingPaymentId);
    if (idx === -1) return;
    categories.paymentMethods[idx] = {
      ...categories.paymentMethods[idx],
      name: panel.querySelector('.pe-name').value.trim() || categories.paymentMethods[idx].name,
      type: panel.querySelector('.pe-type').value,
      owner: panel.querySelector('.pe-owner').value,
      initialBalance: parseAmountInput(panel.querySelector('.pe-balance').value),
      initialBalanceDate: panel.querySelector('.pe-balance-date').value || null,
      lastPaidMonth: panel.querySelector('.pe-last-paid-month').value || null,
    };
    try {
      await persistCategories();
      editingPaymentId = null;
      renderPaymentList();
    } catch (err) { showError(err); }
  });
  panel.querySelector('.pe-remove').addEventListener('click', () => removePaymentMethod(editingPaymentId));
}

async function persistCategories(message) {
  const result = await saveCategories(categories, categoriesSha);
  categoriesSha = result.content.sha;
}

async function removeExpenseCategory(id) {
  if (!confirm('Xoá danh mục chi này? Các giao dịch cũ vẫn giữ nguyên id danh mục.')) return;
  categories.expense = categories.expense.filter((c) => c.id !== id);
  try { await persistCategories(); renderAllCategoryLists(); } catch (err) { showError(err); }
}

async function removeIncomeCategory(id) {
  if (!confirm('Xoá danh mục thu này?')) return;
  categories.income = categories.income.filter((c) => c.id !== id);
  try { await persistCategories(); renderAllCategoryLists(); } catch (err) { showError(err); }
}

async function removePaymentMethod(id) {
  if (!confirm('Xoá phương thức thanh toán này?')) return;
  categories.paymentMethods = categories.paymentMethods.filter((c) => c.id !== id);
  editingPaymentId = null;
  try { await persistCategories(); renderPaymentList(); } catch (err) { showError(err); }
}

document.getElementById('add-expense-cat').addEventListener('click', async () => {
  const input = document.getElementById('new-expense-cat');
  const name = input.value.trim();
  if (!name) return;
  categories.expense.push({ id: slugify(name) || genId(), name });
  try { await persistCategories(); input.value = ''; renderAllCategoryLists(); } catch (err) { showError(err); }
});

document.getElementById('add-income-cat').addEventListener('click', async () => {
  const input = document.getElementById('new-income-cat');
  const name = input.value.trim();
  if (!name) return;
  categories.income.push({ id: slugify(name) || genId(), name });
  try { await persistCategories(); input.value = ''; renderAllCategoryLists(); } catch (err) { showError(err); }
});

const newPaymentTypeEl = document.getElementById('new-payment-type');
const newPaymentOwnerEl = document.getElementById('new-payment-owner');
newPaymentTypeEl.innerHTML = selectOptions(PAYMENT_TYPES, 'cash');
newPaymentOwnerEl.innerHTML = selectOptions(OWNERS, 'shared');
attachAmountInput(document.getElementById('new-payment-balance'));
newPaymentTypeEl.addEventListener('change', () => {
  const tracksBalance = paymentType(newPaymentTypeEl.value).tracksBalance;
  document.getElementById('new-payment-balance-fields').style.display = tracksBalance ? 'flex' : 'none';
  document.getElementById('new-payment-debt-field').style.display = tracksBalance ? 'none' : 'block';
  if (!tracksBalance) document.getElementById('new-payment-last-paid-month').value = previousMonthKey(currentMonthKey());
});

document.getElementById('add-payment').addEventListener('click', async () => {
  const nameInput = document.getElementById('new-payment-name');
  const name = nameInput.value.trim();
  if (!name) return;
  const type = newPaymentTypeEl.value;
  categories.paymentMethods.push({
    id: slugify(name) || genId(),
    name,
    type,
    owner: newPaymentOwnerEl.value,
    initialBalance: paymentType(type).tracksBalance ? parseAmountInput(document.getElementById('new-payment-balance').value) : 0,
    initialBalanceDate: paymentType(type).tracksBalance ? (document.getElementById('new-payment-balance-date').value || null) : null,
    lastPaidMonth: paymentType(type).tracksBalance ? null : (document.getElementById('new-payment-last-paid-month').value || previousMonthKey(currentMonthKey())),
  });
  try {
    await persistCategories();
    nameInput.value = '';
    document.getElementById('new-payment-balance').value = '';
    document.getElementById('new-payment-balance-date').value = '';
    document.getElementById('new-payment-last-paid-month').value = '';
    renderPaymentList();
  } catch (err) { showError(err); }
});

// ---- Ngân sách ----
function renderBudgetForm() {
  const year = String(new Date().getFullYear());
  document.getElementById('budget-year').textContent = year;
  const yearBudget = budget[year] || {};
  const el = document.getElementById('budget-form');
  el.innerHTML = categories.expense
    .map((c) => {
      const cfg = yearBudget[c.id] || { monthlyAmount: 0, alertThreshold: 0.9 };
      return `
        <div class="field" data-cat="${c.id}">
          <label>${c.name}</label>
          <input type="text" inputmode="numeric" class="budget-amount" value="${formatNumber(cfg.monthlyAmount)}" />
        </div>`;
    })
    .join('');
  el.querySelectorAll('.budget-amount').forEach(attachAmountInput);
}

document.getElementById('save-budget').addEventListener('click', async () => {
  clearError();
  const year = String(new Date().getFullYear());
  const yearBudget = {};
  document.querySelectorAll('#budget-form .field').forEach((field) => {
    const catId = field.dataset.cat;
    const amount = parseAmountInput(field.querySelector('.budget-amount').value);
    const cat = categories.expense.find((c) => c.id === catId);
    yearBudget[catId] = { name: cat?.name || catId, monthlyAmount: amount, alertThreshold: 0.9 };
  });
  budget[year] = yearBudget;
  try {
    const result = await saveBudget(budget, budgetSha);
    budgetSha = result.content.sha;
    alert('Đã lưu ngân sách.');
  } catch (err) {
    showError(err);
  }
});

async function init() {
  const catResult = await loadCategories();
  categories = catResult.categories;
  categoriesSha = catResult.sha;
  renderAllCategoryLists();

  const budgetResult = await loadBudget();
  budget = budgetResult.budget;
  budgetSha = budgetResult.sha;
  renderBudgetForm();
}

if (getToken()) {
  init().catch(showError);
}
