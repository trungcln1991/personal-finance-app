import { renderNav, requireToken, showError } from './nav.js';
import { loadCategories, loadTransactions, deleteTransaction, formatVnd, currentMonthKey, categoryName, categoryIcon, shiftMonthKey, paymentMethodName } from './store.js';

renderNav('transactions');

function monthLabel(monthKey) {
  const [y, m] = monthKey.split('-');
  return `Tháng ${Number(m)}/${y}`;
}

const params = new URLSearchParams(location.search);
let monthKey = params.get('month') || currentMonthKey();

async function render() {
  document.getElementById('month-label').textContent = monthLabel(monthKey);
  document.getElementById('loading').style.display = 'block';
  const listEl = document.getElementById('tx-list');
  listEl.innerHTML = '';
  try {
    const [{ categories }, { transactions }] = await Promise.all([loadCategories(), loadTransactions(monthKey)]);
    document.getElementById('loading').style.display = 'none';

    if (!transactions.length) {
      listEl.innerHTML = '<p class="muted">Chưa có giao dịch nào trong tháng này.</p>';
      return;
    }

    const sorted = [...transactions].sort((a, b) => (a.date < b.date ? 1 : -1));
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
          render();
        } catch (err) {
          showError(err);
        }
      });
    });
  } catch (err) {
    document.getElementById('loading').style.display = 'none';
    showError(err);
  }
}

document.getElementById('prev-month').addEventListener('click', () => { monthKey = shiftMonthKey(monthKey, -1); render(); });
document.getElementById('next-month').addEventListener('click', () => { monthKey = shiftMonthKey(monthKey, 1); render(); });

(async () => {
  if (!(await requireToken())) return;
  render();
})();
