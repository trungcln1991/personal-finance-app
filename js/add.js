import { renderNav, requireToken, showError } from './nav.js';
import { loadCategories, loadTransactions, addTransaction, updateTransaction, deleteTransaction, genId, formatNumber, parseAmountInput, attachAmountInput, categoryIcon } from './store.js';

renderNav('add');

const params = new URLSearchParams(location.search);
const editId = params.get('edit');
const editMonth = params.get('month');

let currentType = 'expense';
let categories = null;

const dateEl = document.getElementById('f-date');
const categoryFieldEl = document.getElementById('category-field');
const categoryEl = document.getElementById('f-category');
const amountEl = document.getElementById('f-amount');
const priorityEl = document.getElementById('f-priority');
const paymentFieldEl = document.getElementById('payment-field');
const paymentEl = document.getElementById('f-payment');
const fromPaymentFieldEl = document.getElementById('from-payment-field');
const fromPaymentEl = document.getElementById('f-from-payment');
const toPaymentFieldEl = document.getElementById('to-payment-field');
const toPaymentEl = document.getElementById('f-to-payment');
const noteEl = document.getElementById('f-note');
const priorityField = document.getElementById('priority-field');
const submitBtn = document.getElementById('submit-btn');
const btnIncome = document.getElementById('type-income');
const btnExpense = document.getElementById('type-expense');
const btnTransfer = document.getElementById('type-transfer');

attachAmountInput(amountEl);

function setType(type) {
  currentType = type;
  btnIncome.classList.toggle('active', type === 'income');
  btnExpense.classList.toggle('active', type === 'expense');
  btnTransfer.classList.toggle('active', type === 'transfer');

  const isTransfer = type === 'transfer';
  categoryFieldEl.style.display = isTransfer ? 'none' : 'block';
  categoryEl.required = !isTransfer;
  priorityField.style.display = !isTransfer && type === 'expense' ? 'block' : 'none';
  paymentFieldEl.style.display = isTransfer ? 'none' : 'block';
  fromPaymentFieldEl.style.display = isTransfer ? 'block' : 'none';
  toPaymentFieldEl.style.display = isTransfer ? 'block' : 'none';

  if (!isTransfer) populateCategorySelect();
}

function populateCategorySelect(selectedId) {
  const list = currentType === 'income' ? categories.income : categories.expense;
  categoryEl.innerHTML = list.map((c) => `<option value="${c.id}">${categoryIcon(c.id)} ${c.name}</option>`).join('');
  if (selectedId) categoryEl.value = selectedId;
}

btnIncome.addEventListener('click', () => setType('income'));
btnExpense.addEventListener('click', () => setType('expense'));
btnTransfer.addEventListener('click', () => setType('transfer'));

async function init() {
  if (!(await requireToken())) return;
  const { categories: cats } = await loadCategories();
  categories = cats;
  priorityEl.innerHTML = categories.priorities.map((p) => `<option value="${p.id}">${p.name}</option>`).join('');
  paymentEl.innerHTML =
    '<option value="">—</option>' + categories.paymentMethods.map((p) => `<option value="${p.id}">${p.name}</option>`).join('');
  const paymentOptions = categories.paymentMethods.map((p) => `<option value="${p.id}">${p.name}</option>`).join('');
  fromPaymentEl.innerHTML = paymentOptions;
  toPaymentEl.innerHTML = paymentOptions;

  if (editId && editMonth) {
    document.getElementById('page-title').textContent = 'Sửa giao dịch';
    submitBtn.textContent = 'Cập nhật giao dịch';
    const { transactions } = await loadTransactions(editMonth);
    const tx = transactions.find((t) => t.id === editId);
    if (!tx) { showError(new Error('Không tìm thấy giao dịch.')); return; }
    setType(tx.type);
    dateEl.value = tx.date;
    noteEl.value = tx.note || '';
    if (tx.type === 'transfer') {
      amountEl.value = formatNumber(tx.amount);
      fromPaymentEl.value = tx.fromPayment || '';
      toPaymentEl.value = tx.toPayment || '';
    } else {
      populateCategorySelect(tx.category);
      amountEl.value = formatNumber(tx.amount);
      priorityEl.value = tx.priority || 'nice';
      paymentEl.value = tx.paymentMethod || '';
    }
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
    let payload;
    if (currentType === 'transfer') {
      if (fromPaymentEl.value === toPaymentEl.value) {
        throw new Error('Ví/tài khoản nguồn và đích phải khác nhau.');
      }
      payload = {
        date: dateEl.value,
        type: 'transfer',
        fromPayment: fromPaymentEl.value,
        toPayment: toPaymentEl.value,
        amount: parseAmountInput(amountEl.value),
        note: noteEl.value.trim(),
      };
    } else {
      payload = {
        date: dateEl.value,
        type: currentType,
        category: categoryEl.value,
        amount: parseAmountInput(amountEl.value),
        note: noteEl.value.trim(),
        paymentMethod: paymentEl.value || null,
      };
      if (currentType === 'expense') payload.priority = priorityEl.value;
    }

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
