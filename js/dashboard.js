import { renderNav, requireToken, showError } from './nav.js';
import {
  loadCategories, loadBudget, loadTransactions, formatVnd, currentMonthKey, categoryName, categoryIcon,
  OWNERS, paymentType, normalizePaymentMethod, loadTransactionsRange, computeAccountBalances,
} from './store.js';

renderNav('dashboard');

function shiftMonth(monthKey, delta) {
  const [y, m] = monthKey.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(monthKey) {
  const [y, m] = monthKey.split('-');
  return `Tháng ${Number(m)}/${y}`;
}

let categoryChart, priorityChart;

async function render(monthKey) {
  document.getElementById('loading').style.display = 'block';
  document.getElementById('content').style.display = 'none';
  document.getElementById('month-label').textContent = monthLabel(monthKey);

  try {
    const [{ categories }, { budget }, { transactions }] = await Promise.all([
      loadCategories(),
      loadBudget(),
      loadTransactions(monthKey),
    ]);

    const income = transactions.filter((t) => t.type === 'income');
    const expense = transactions.filter((t) => t.type === 'expense');
    const totalIncome = income.reduce((s, t) => s + t.amount, 0);
    const totalExpense = expense.reduce((s, t) => s + t.amount, 0);
    const balance = totalIncome - totalExpense;

    document.getElementById('total-income').textContent = formatVnd(totalIncome);
    document.getElementById('total-expense').textContent = formatVnd(totalExpense);
    const balanceEl = document.getElementById('total-balance');
    balanceEl.textContent = formatVnd(balance);
    balanceEl.className = 'value ' + (balance >= 0 ? 'income-value' : 'expense-value');

    // Số dư tiền mặt & tài khoản, chia theo chủ sở hữu
    const balanceGrid = document.getElementById('owner-balance-grid');
    const trackedAccounts = categories.paymentMethods.map(normalizePaymentMethod).filter((p) => paymentType(p.type).tracksBalance);
    const earliestDate = trackedAccounts.filter((p) => p.initialBalanceDate).map((p) => p.initialBalanceDate).sort()[0];
    const allTx = earliestDate ? await loadTransactionsRange(earliestDate.slice(0, 7)) : [];
    const accounts = computeAccountBalances(categories, allTx);
    const ownerCards = OWNERS.map((o) => {
      const list = accounts.filter((a) => (a.owner || 'shared') === o.id);
      if (!list.length) return '';
      const total = list.reduce((s, a) => s + (a.balance || 0), 0);
      const rows = list
        .map(
          (a) => `
        <div class="account-row">
          <span class="acc-name">${paymentType(a.type).icon} ${a.name}</span>
          <span class="acc-balance ${a.balance === null ? 'unset' : ''}">${a.balance === null ? 'Chưa cấu hình' : formatVnd(a.balance)}</span>
        </div>`
        )
        .join('');
      return `
        <div class="card owner-card">
          <div class="owner-title">${o.label}</div>
          <div class="owner-total">${formatVnd(total)}</div>
          ${rows}
        </div>`;
    }).join('');
    balanceGrid.innerHTML = ownerCards || '<p class="muted">Chưa có tài khoản tiền mặt/ngân hàng nào. Vào Cài đặt để thêm.</p>';

    // Thẻ tín dụng & ví trả sau: đã chi bao nhiêu trong tháng
    const cwCard = document.getElementById('credit-wallet-card');
    const cwMethods = categories.paymentMethods.map(normalizePaymentMethod).filter((p) => !paymentType(p.type).tracksBalance);
    if (!cwMethods.length) {
      cwCard.innerHTML = '<p class="muted">Chưa có thẻ tín dụng/ví trả sau nào. Vào Cài đặt để thêm.</p>';
    } else {
      const spentByMethod = {};
      for (const t of expense) if (t.paymentMethod) spentByMethod[t.paymentMethod] = (spentByMethod[t.paymentMethod] || 0) + t.amount;
      const cwRows = cwMethods
        .map(
          (p) => `
        <div class="cw-row">
          <span>${paymentType(p.type).icon} ${p.name}<span class="cw-badge">${paymentType(p.type).label}</span></span>
          <span>${formatVnd(spentByMethod[p.id] || 0)}</span>
        </div>`
        )
        .join('');
      const creditTotal = cwMethods.filter((p) => p.type === 'credit').reduce((s, p) => s + (spentByMethod[p.id] || 0), 0);
      const walletTotal = cwMethods.filter((p) => p.type === 'wallet').reduce((s, p) => s + (spentByMethod[p.id] || 0), 0);
      cwCard.innerHTML =
        cwRows +
        `<div class="cw-subtotal"><span>Tổng thẻ tín dụng</span><span>${formatVnd(creditTotal)}</span></div>` +
        `<div class="cw-subtotal"><span>Tổng ví trả sau</span><span>${formatVnd(walletTotal)}</span></div>`;
    }

    // Chi theo danh mục
    const byCategory = {};
    for (const t of expense) byCategory[t.category] = (byCategory[t.category] || 0) + t.amount;
    const catEntries = Object.entries(byCategory).sort((a, b) => b[1] - a[1]);
    const catLabels = catEntries.map(([id]) => categoryName(categories, 'expense', id));
    const catValues = catEntries.map(([, v]) => v);

    categoryChart?.destroy();
    categoryChart = new Chart(document.getElementById('chart-category'), {
      type: 'doughnut',
      data: {
        labels: catLabels.length ? catLabels : ['Chưa có chi tiêu'],
        datasets: [{
          data: catValues.length ? catValues : [1],
          backgroundColor: ['#6366f1','#22c55e','#f59e0b','#ef4444','#06b6d4','#a855f7','#eab308','#f97316','#14b8a6','#ec4899','#84cc16','#64748b'],
        }],
      },
      options: { plugins: { legend: { position: 'bottom', labels: { color: '#e2e8f0', boxWidth: 12, font: { size: 11 } } } } },
    });

    // Chi theo mức ưu tiên
    const priorityOrder = ['essential', 'nice', 'unnecessary'];
    const priorityLabels = { essential: 'Bắt buộc', nice: 'Có thì tốt', unnecessary: 'Không cần thiết' };
    const byPriority = { essential: 0, nice: 0, unnecessary: 0 };
    for (const t of expense) byPriority[t.priority || 'nice'] += t.amount;

    priorityChart?.destroy();
    priorityChart = new Chart(document.getElementById('chart-priority'), {
      type: 'bar',
      data: {
        labels: priorityOrder.map((k) => priorityLabels[k]),
        datasets: [{
          data: priorityOrder.map((k) => byPriority[k]),
          backgroundColor: ['#22c55e', '#f59e0b', '#ef4444'],
        }],
      },
      options: {
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: '#94a3b8' }, grid: { display: false } },
          y: { ticks: { color: '#94a3b8' }, grid: { color: '#273449' } },
        },
      },
    });

    // Ngân sách tháng
    const year = monthKey.split('-')[0];
    const yearBudget = budget[year] || {};
    const budgetList = document.getElementById('budget-list');
    const rows = Object.entries(yearBudget);
    if (!rows.length) {
      budgetList.innerHTML = '<p class="muted">Chưa cấu hình ngân sách cho năm này. Vào Cài đặt để thêm.</p>';
    } else {
      budgetList.innerHTML = rows
        .map(([catId, cfg]) => {
          const spent = byCategory[catId] || 0;
          const pct = cfg.monthlyAmount > 0 ? spent / cfg.monthlyAmount : 0;
          const cls = pct >= 1 ? 'over' : pct >= (cfg.alertThreshold || 0.9) ? 'warn' : '';
          return `
            <div class="budget-row">
              <div class="row-top">
                <span>${categoryIcon(catId)} ${cfg.name || catId}</span>
                <span>${formatVnd(spent)} / ${formatVnd(cfg.monthlyAmount)}</span>
              </div>
              <div class="progress-bar"><div class="progress-fill ${cls}" style="width:${Math.min(pct, 1) * 100}%"></div></div>
            </div>`;
        })
        .join('');
    }

    document.getElementById('loading').style.display = 'none';
    document.getElementById('content').style.display = 'block';
  } catch (err) {
    document.getElementById('loading').style.display = 'none';
    showError(err);
  }
}

let monthKey = currentMonthKey();

document.getElementById('prev-month').addEventListener('click', () => {
  monthKey = shiftMonth(monthKey, -1);
  render(monthKey);
});
document.getElementById('next-month').addEventListener('click', () => {
  monthKey = shiftMonth(monthKey, 1);
  render(monthKey);
});

(async () => {
  if (!(await requireToken())) return;
  render(monthKey);
})();
