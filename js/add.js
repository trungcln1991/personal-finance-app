import { renderNav, requireToken, showError } from './nav.js';
import { loadCategories, loadTransactions, addTransaction, updateTransaction, deleteTransaction, genId, formatNumber, parseAmountInput, attachAmountInput, categoryIcon } from './store.js';

renderNav('add');

const params = new URLSearchParams(location.search);
const editId = params.get('edit');
const editMonth = params.get('month');

let currentType = 'expense';
let categories = null;

const dateEl = document.getElementById('f-date');
const categoryEl = document.getElementById('f-category');
const amountEl = document.getElementById('f-amount');
const priorityEl = document.getElementById('f-priority');
const paymentEl = document.getElementById('f-payment');
const noteEl = document.getElementById('f-note');
const priorityField = document.getElementById('priority-field');
const submitBtn = document.getElementById('submit-btn');
const btnIncome = document.getElementById('type-income');
const btnExpense = document.getElementById('type-expense');

attachAmountInput(amountEl);

function setType(type) {
  currentType = type;
  btnIncome.classList.toggle('active', type === 'income');
  btnExpense.classList.toggle('active', type === 'expense');
  priorityField.style.display = type === 'expense' ? 'block' : 'none';
  populateCategorySelect();
}

function populateCategorySelect(selectedId) {
  const list = currentType === 'income' ? categories.income : categories.expense;
  categoryEl.innerHTML = list.map((c) => `<option value="${c.id}">${categoryIcon(c.id)} ${c.name}</option>`).join('');
  if (selectedId) categoryEl.value = selectedId;
}

btnIncome.addEventListener('click', () => setType('income'));
btnExpense.addEventListener('click', () => setType('expense'));

async function init() {
  if (!(await requireToken())) return;
  const { categories: cats } = await loadCategories();
  categories = cats;
  priorityEl.innerHTML = categories.priorities.map((p) => `<option value="${p.id}">${p.name}</option>`).join('');
  paymentEl.innerHTML =
    '<option value="">—</option>' + categories.paymentMethods.map((p) => `<option value="${p.id}">${p.name}</option>`).join('');

  if (editId && editMonth) {
    document.getElementById('page-title').textContent = 'Sửa giao dịch';
    submitBtn.textContent = 'Cập nhật giao dịch';
    const { transactions } = await loadTransactions(editMonth);
    const tx = transactions.find((t) => t.id === editId);
    if (!tx) { showError(new Error('Không tìm thấy giao dịch.')); return; }
    setType(tx.type);
    dateEl.value = tx.date;
    populateCategorySelect(tx.category);
    amountEl.value = formatNumber(tx.amount);
    priorityEl.value = tx.priority || 'nice';
    paymentEl.value = tx.paymentMethod || '';
    noteEl.value = tx.note || '';
  } else {
    setType('expense');
    dateEl.value = new Date().toISOString().slice(0, 10);
  }
}

document.getElementById('tx-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  submitBtn.disabled = true;
  submitBtn.textContent = 'Đang lưu…';
  try {
    const monthKey = dateEl.value.slice(0, 7);
    const payload = {
      date: dateEl.value,
      type: currentType,
      category: categoryEl.value,
      amount: parseAmountInput(amountEl.value),
      note: noteEl.value.trim(),
      paymentMethod: paymentEl.value || null,
    };
    if (currentType === 'expense') payload.priority = priorityEl.value;

    if (editId && editMonth) {
      if (monthKey !== editMonth) {
        // Đổi sang tháng khác: xoá ở tháng cũ, thêm mới ở tháng mới
        await deleteTransaction(editMonth, editId);
        await addTransaction(monthKey, { id: editId, ...payload });
      } else {
        await updateTransaction(editMonth, editId, payload);
      }
    } else {
      await addTransaction(monthKey, { id: genId(), ...payload });
    }
    location.href = `transactions.html?month=${monthKey}`;
  } catch (err) {
    showError(err);
    submitBtn.disabled = false;
    submitBtn.textContent = editId ? 'Cập nhật giao dịch' : 'Lưu giao dịch';
  }
});

init();
