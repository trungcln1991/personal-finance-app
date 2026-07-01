import { renderNav, showError, clearError } from './nav.js';
import { getToken, saveToken, clearToken, testToken } from './github-api.js';
import { loadCategories, saveCategories, loadBudget, saveBudget, genId } from './store.js';

renderNav('settings');

const tokenInput = document.getElementById('f-token');
const tokenStatus = document.getElementById('token-status');

tokenInput.value = getToken();

document.getElementById('save-token').addEventListener('click', () => {
  saveToken(tokenInput.value);
  tokenStatus.textContent = 'Đã lưu token vào trình duyệt này.';
});

document.getElementById('clear-token').addEventListener('click', () => {
  clearToken();
  tokenInput.value = '';
  tokenStatus.textContent = 'Đã xoá token.';
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

function renderCategoryList(containerId, list, onRemove) {
  const el = document.getElementById(containerId);
  el.innerHTML = list
    .map(
      (c) => `<div class="category-manage-row" data-id="${c.id}">
        <span>${c.name}</span>
        <button class="btn btn-danger remove-btn">Xoá</button>
      </div>`
    )
    .join('') || '<p class="muted">Chưa có danh mục nào.</p>';
  el.querySelectorAll('.remove-btn').forEach((btn) => {
    btn.addEventListener('click', () => onRemove(btn.closest('.category-manage-row').dataset.id));
  });
}

function renderAllCategoryLists() {
  renderCategoryList('expense-cat-list', categories.expense, removeExpenseCategory);
  renderCategoryList('income-cat-list', categories.income, removeIncomeCategory);
  renderCategoryList('payment-list', categories.paymentMethods, removePaymentMethod);
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
  try { await persistCategories(); renderAllCategoryLists(); } catch (err) { showError(err); }
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

document.getElementById('add-payment').addEventListener('click', async () => {
  const input = document.getElementById('new-payment');
  const name = input.value.trim();
  if (!name) return;
  categories.paymentMethods.push({ id: slugify(name) || genId(), name });
  try { await persistCategories(); input.value = ''; renderAllCategoryLists(); } catch (err) { showError(err); }
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
          <input type="number" class="budget-amount" min="0" step="10000" value="${cfg.monthlyAmount}" />
        </div>`;
    })
    .join('');
}

document.getElementById('save-budget').addEventListener('click', async () => {
  clearError();
  const year = String(new Date().getFullYear());
  const yearBudget = {};
  document.querySelectorAll('#budget-form .field').forEach((field) => {
    const catId = field.dataset.cat;
    const amount = Number(field.querySelector('.budget-amount').value) || 0;
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
