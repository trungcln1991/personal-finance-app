import { renderNav, showError, clearError } from './nav.js';
import { getToken, login, clearToken, testToken, hasToken } from './github-api.js';
import {
  loadCategories, saveCategories, loadBudget, saveBudget, genId, formatNumber, formatVnd,
  parseAmountInput, attachAmountInput, categoryIcon, currentMonthKey, previousMonthKey,
  PAYMENT_TYPES, OWNERS, paymentType, ownerLabel, normalizePaymentMethod,
  resolveVersioned, addVersionOverride, paymentMethodName,
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

// ---- Ngân sách: mỗi danh mục chi lưu 1 dãy "versions" hiệu lực theo tháng ----
// Sửa 1 danh mục cho phép chọn: áp dụng từ tháng đã chọn về sau, hoặc chỉ đúng tháng đó
// (tháng sau tự quay lại số cũ) — nhờ đó xem lại tháng cũ vẫn đúng số ngân sách lúc đó.

let editingBudgetCatId = null;

function scopeRadiosHtml(prefix) {
  return `
    <div class="field">
      <label class="radio-option"><input type="radio" name="${prefix}-scope" class="${prefix}-scope-permanent" checked /> Từ tháng đã chọn về sau</label>
      <label class="radio-option"><input type="radio" name="${prefix}-scope" class="${prefix}-scope-temp" /> Chỉ tháng đã chọn (tháng sau tự quay lại số cũ)</label>
    </div>`;
}

function renderBudgetList() {
  const el = document.getElementById('budget-list-settings');
  const refMonth = currentMonthKey();
  const budgetCategories = budget.categories || (budget.categories = {});
  el.innerHTML = categories.expense
    .map((c) => {
      const cfg = budgetCategories[c.id];
      const active = cfg ? resolveVersioned(cfg.versions, refMonth) : null;
      const editing = editingBudgetCatId === c.id;
      return `
        <div class="category-manage-row payment-row" data-id="${c.id}">
          <div class="payment-row-main">
            <span>${categoryIcon(c.id)} ${c.name}</span>
            <span class="pm-sub">${active ? `Hiện tại: ${formatVnd(active.monthlyAmount)}/tháng` : 'Chưa cấu hình'}</span>
          </div>
          <button class="btn btn-secondary edit-btn">${editing ? 'Đóng' : 'Sửa'}</button>
        </div>
        ${editing ? budgetEditPanelHtml(c, cfg, active) : ''}`;
    })
    .join('');

  el.querySelectorAll('.edit-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.closest('.payment-row').dataset.id;
      editingBudgetCatId = editingBudgetCatId === id ? null : id;
      renderBudgetList();
    });
  });
  if (editingBudgetCatId) wireBudgetEditPanel();
}

function budgetEditPanelHtml(c, cfg, active) {
  const thresholdPct = Math.round(((cfg?.alertThreshold ?? 0.9)) * 100);
  return `
    <div class="payment-edit-panel">
      <div class="field"><label>Số tiền/tháng</label><input type="text" inputmode="numeric" class="be-amount" value="${active ? formatNumber(active.monthlyAmount) : ''}" /></div>
      <div class="field"><label>Ngưỡng cảnh báo (%)</label><input type="text" inputmode="numeric" class="be-threshold" value="${formatNumber(thresholdPct)}" /></div>
      <div class="field"><label>Áp dụng từ tháng</label><input type="month" class="be-month" value="${currentMonthKey()}" /></div>
      ${scopeRadiosHtml('be')}
      <button class="btn btn-primary be-save">Lưu</button>
    </div>`;
}

function wireBudgetEditPanel() {
  const panel = document.querySelector('#budget-list-settings .payment-edit-panel');
  if (!panel) return;
  attachAmountInput(panel.querySelector('.be-amount'));
  attachAmountInput(panel.querySelector('.be-threshold'));
  panel.querySelector('.be-save').addEventListener('click', async () => {
    const catId = editingBudgetCatId;
    const monthKey = panel.querySelector('.be-month').value;
    if (!monthKey) { alert('Chọn tháng áp dụng.'); return; }
    const amount = parseAmountInput(panel.querySelector('.be-amount').value);
    const thresholdPct = parseAmountInput(panel.querySelector('.be-threshold').value);
    const temporary = panel.querySelector('.be-scope-temp').checked;
    const cat = categories.expense.find((c) => c.id === catId);
    const existing = budget.categories[catId] || { name: cat?.name || catId, alertThreshold: 0.9, versions: [] };
    existing.name = cat?.name || existing.name;
    existing.alertThreshold = thresholdPct / 100;
    existing.versions = addVersionOverride(existing.versions, monthKey, { monthlyAmount: amount }, temporary);
    budget.categories[catId] = existing;
    try {
      const result = await saveBudget(budget, budgetSha);
      budgetSha = result.content.sha;
      editingBudgetCatId = null;
      renderBudgetList();
    } catch (err) { showError(err); }
  });
}

// ---- Thu nhập mặc định (lương hàng tháng...) ----
// App sẽ tự thêm giao dịch Thu vào đầu mỗi tháng thực tế theo giá trị đang hiệu lực,
// không thêm trùng (kiểm tra qua defaultIncomeId), không tự thêm cho tháng đã qua.

let editingIncomeId = null;

function renderDefaultIncomeList() {
  const el = document.getElementById('default-income-list');
  const list = categories.defaultIncomes || [];
  if (!list.length) {
    el.innerHTML = '<p class="muted">Chưa có khoản thu mặc định nào.</p>';
    return;
  }
  const refMonth = currentMonthKey();
  el.innerHTML = list
    .map((d) => {
      const active = resolveVersioned(d.versions, refMonth);
      const editing = editingIncomeId === d.id;
      return `
        <div class="category-manage-row payment-row" data-id="${d.id}">
          <div class="payment-row-main">
            <span>${d.name} <span class="muted">· ${paymentMethodName(categories, d.paymentMethod)}</span></span>
            <span class="pm-sub">${active ? `Hiện tại: ${formatVnd(active.amount)}/tháng` : 'Chưa/ngừng áp dụng'}</span>
          </div>
          <button class="btn btn-secondary edit-btn">${editing ? 'Đóng' : 'Sửa'}</button>
        </div>
        ${editing ? incomeEditPanelHtml(d, active) : ''}`;
    })
    .join('');

  el.querySelectorAll('.edit-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.closest('.payment-row').dataset.id;
      editingIncomeId = editingIncomeId === id ? null : id;
      renderDefaultIncomeList();
    });
  });
  if (editingIncomeId) wireIncomeEditPanel();
}

function incomeEditPanelHtml(d, active) {
  const paymentOptions =
    '<option value="">—</option>' +
    categories.paymentMethods.map((p) => `<option value="${p.id}" ${p.id === d.paymentMethod ? 'selected' : ''}>${p.name}</option>`).join('');
  return `
    <div class="payment-edit-panel">
      <div class="field"><input type="text" class="ie-name" value="${d.name}" /></div>
      <div class="field"><label>Phương thức nhận</label><select class="ie-payment">${paymentOptions}</select></div>
      <div class="field"><label>Số tiền/tháng</label><input type="text" inputmode="numeric" class="ie-amount" value="${active ? formatNumber(active.amount) : ''}" /></div>
      <div class="field"><label>Áp dụng từ tháng</label><input type="month" class="ie-month" value="${currentMonthKey()}" /></div>
      ${scopeRadiosHtml('ie')}
      <div style="display:flex;gap:8px;">
        <button class="btn btn-primary ie-save">Lưu</button>
        <button class="btn btn-danger ie-remove">Xoá</button>
      </div>
    </div>`;
}

function wireIncomeEditPanel() {
  const panel = document.querySelector('#default-income-list .payment-edit-panel');
  if (!panel) return;
  attachAmountInput(panel.querySelector('.ie-amount'));
  panel.querySelector('.ie-save').addEventListener('click', async () => {
    const idx = categories.defaultIncomes.findIndex((d) => d.id === editingIncomeId);
    if (idx === -1) return;
    const monthKey = panel.querySelector('.ie-month').value;
    if (!monthKey) { alert('Chọn tháng áp dụng.'); return; }
    const temporary = panel.querySelector('.ie-scope-temp').checked;
    const amount = parseAmountInput(panel.querySelector('.ie-amount').value);
    const d = categories.defaultIncomes[idx];
    d.name = panel.querySelector('.ie-name').value.trim() || d.name;
    d.paymentMethod = panel.querySelector('.ie-payment').value || null;
    d.versions = addVersionOverride(d.versions, monthKey, { amount }, temporary);
    try {
      await persistCategories();
      editingIncomeId = null;
      renderDefaultIncomeList();
    } catch (err) { showError(err); }
  });
  panel.querySelector('.ie-remove').addEventListener('click', async () => {
    if (!confirm('Xoá khoản thu mặc định này? (Các giao dịch đã tạo trước đó vẫn giữ nguyên, chỉ ngừng tự tạo thêm)')) return;
    categories.defaultIncomes = categories.defaultIncomes.filter((d) => d.id !== editingIncomeId);
    editingIncomeId = null;
    try { await persistCategories(); renderDefaultIncomeList(); } catch (err) { showError(err); }
  });
}

document.getElementById('add-default-income').addEventListener('click', async () => {
  const nameInput = document.getElementById('new-income-name');
  const name = nameInput.value.trim();
  if (!name) return;
  const category = document.getElementById('new-income-category').value;
  const paymentMethod = document.getElementById('new-income-payment').value || null;
  const amount = parseAmountInput(document.getElementById('new-income-amount').value);
  const fromMonth = document.getElementById('new-income-from-month').value || currentMonthKey();
  categories.defaultIncomes = categories.defaultIncomes || [];
  categories.defaultIncomes.push({
    id: slugify(name) || genId(),
    name,
    category,
    paymentMethod,
    versions: [{ from: fromMonth, amount }],
  });
  try {
    await persistCategories();
    nameInput.value = '';
    document.getElementById('new-income-amount').value = '';
    document.getElementById('new-income-from-month').value = '';
    renderDefaultIncomeList();
  } catch (err) { showError(err); }
});

async function init() {
  const catResult = await loadCategories();
  categories = catResult.categories;
  categoriesSha = catResult.sha;
  renderAllCategoryLists();

  document.getElementById('new-income-category').innerHTML = categories.income.map((c) => `<option value="${c.id}">${c.name}</option>`).join('');
  document.getElementById('new-income-payment').innerHTML =
    '<option value="">—</option>' + categories.paymentMethods.map((p) => `<option value="${p.id}">${p.name}</option>`).join('');
  renderDefaultIncomeList();

  const budgetResult = await loadBudget();
  budget = budgetResult.budget;
  budgetSha = budgetResult.sha;
  renderBudgetList();
}

if (getToken()) {
  init().catch(showError);
}
