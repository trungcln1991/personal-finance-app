import { renderNav, requireToken, showError } from './nav.js';
import {
  loadCategories, loadBudget, loadTransactions, saveTransactions, formatVnd, currentMonthKey, categoryName, categoryIcon,
  OWNERS, paymentType, normalizePaymentMethod, loadTransactionsRange, computeAccountBalances,
  shiftMonthKey, computeDebtStatus, payDebt, addTransaction, genId, resolveVersioned,
} from './store.js';

renderNav('dashboard');

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
    const [{ categories, sha: categoriesSha }, { budget }, { transactions, sha: txSha }] = await Promise.all([
      loadCategories(),
      loadBudget(),
      loadTransactions(monthKey),
    ]);

    // Tự động thêm thu nhập mặc định (lương...) cho tháng hiện tại nếu chưa có,
    // theo giá trị đang hiệu lực (versions) tại tháng đó. Chỉ áp dụng cho tháng thực tế hiện tại
    // (không tự thêm khi bấm xem lại tháng cũ hoặc xem trước tháng tương lai).
    if (monthKey === currentMonthKey() && categories.defaultIncomes?.length) {
      const missing = categories.defaultIncomes.filter((d) => !transactions.some((t) => t.defaultIncomeId === d.id));
      const newTx = missing
        .map((d) => {
          const active = resolveVersioned(d.versions, monthKey);
          if (!active || !active.amount) return null;
          return {
            id: genId(),
            date: `${monthKey}-01`,
            type: 'income',
            category: d.category,
            amount: active.amount,
            paymentMethod: d.paymentMethod || null,
            note: d.name,
            defaultIncomeId: d.id,
          };
        })
        .filter(Boolean);
      if (newTx.length) {
        transactions.push(...newTx);
        transactions.sort((a, b) => (a.date < b.date ? -1 : 1));
        await saveTransactions(monthKey, transactions, txSha, `Tự động thêm thu nhập mặc định tháng ${monthKey}`);
      }
    }

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

    // Thẻ tín dụng & ví trả sau: nợ phải trả (tháng đã đóng) + phát sinh tháng này (chưa đến hạn)
    const cwCard = document.getElementById('credit-wallet-card');
    const cwMethodsRaw = categories.paymentMethods.map(normalizePaymentMethod).filter((p) => !paymentType(p.type).tracksBalance);
    const todayMonthKey = currentMonthKey();
    if (!cwMethodsRaw.length) {
      cwCard.innerHTML = '<p class="muted">Chưa có thẻ tín dụng/ví trả sau nào. Vào Cài đặt để thêm.</p>';
    } else {
      const earliestDebtMonth = cwMethodsRaw.filter((p) => p.lastPaidMonth).map((p) => p.lastPaidMonth).sort()[0];
      const debtTx = earliestDebtMonth ? await loadTransactionsRange(earliestDebtMonth) : [];
      const cwMethods = computeDebtStatus(categories, debtTx, todayMonthKey);
      const payAccounts = trackedAccounts;
      const cwRows = cwMethods
        .map((p) => {
          const debtInfo = !p.configured
            ? '<p class="muted">Chưa cấu hình nợ — vào Cài đặt để thiết lập.</p>'
            : `
              <div class="cw-debt-rows">
                <span class="owed">Nợ phải trả: ${formatVnd(p.owedAmount)}</span>
                <span>Phát sinh tháng này (chưa đến hạn): ${formatVnd(p.currentMonthSpend)}</span>
              </div>`;
          const payRow = p.canPay && payAccounts.length
            ? `
              <div class="cw-pay-row" data-method="${p.id}" data-amount="${p.owedAmount}">
                <select class="cw-pay-account">${payAccounts.map((a) => `<option value="${a.id}">${a.name}</option>`).join('')}</select>
                <button class="cw-pay-btn">Đã trả nợ</button>
              </div>`
            : '';
          return `
            <div class="cw-row">
              <span>${paymentType(p.type).icon} ${p.name}<span class="cw-badge">${paymentType(p.type).label}</span></span>
            </div>
            ${debtInfo}
            ${payRow}`;
        })
        .join('');
      cwCard.innerHTML = cwRows;

      cwCard.querySelectorAll('.cw-pay-row').forEach((row) => {
        row.querySelector('.cw-pay-btn').addEventListener('click', async () => {
          const methodId = row.dataset.method;
          const amount = Number(row.dataset.amount);
          const fromPayment = row.querySelector('.cw-pay-account').value;
          const method = cwMethods.find((m) => m.id === methodId);
          if (!confirm(`Xác nhận đã trả ${formatVnd(amount)} nợ ${method?.name || ''}?`)) return;
          try {
            await addTransaction(todayMonthKey, {
              id: genId(),
              date: new Date().toISOString().slice(0, 10),
              type: 'transfer',
              fromPayment,
              toPayment: methodId,
              amount,
              note: `Trả nợ ${method?.name || ''}`,
            });
            await payDebt(categories, categoriesSha, methodId, todayMonthKey);
            render(monthKey);
          } catch (err) {
            showError(err);
          }
        });
      });
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

    // Ngân sách tháng (lấy giá trị đang hiệu lực tại monthKey, xem tháng cũ vẫn đúng số lúc đó)
    const budgetCategories = budget.categories || {};
    const rows = Object.entries(budgetCategories)
      .map(([catId, cfg]) => [catId, cfg, resolveVersioned(cfg.versions, monthKey)])
      .filter(([, , active]) => active);
    const budgetList = document.getElementById('budget-list');
    if (!rows.length) {
      budgetList.innerHTML = '<p class="muted">Chưa cấu hình ngân sách. Vào Cài đặt để thêm.</p>';
    } else {
      budgetList.innerHTML = rows
        .map(([catId, cfg, active]) => {
          const spent = byCategory[catId] || 0;
          const pct = active.monthlyAmount > 0 ? spent / active.monthlyAmount : 0;
          const cls = pct >= 1 ? 'over' : pct >= (cfg.alertThreshold ?? 0.9) ? 'warn' : '';
          return `
            <div class="budget-row">
              <div class="row-top">
                <span>${categoryIcon(catId)} ${cfg.name || catId}</span>
                <span>${formatVnd(spent)} / ${formatVnd(active.monthlyAmount)}</span>
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
  monthKey = shiftMonthKey(monthKey, -1);
  render(monthKey);
});
document.getElementById('next-month').addEventListener('click', () => {
  monthKey = shiftMonthKey(monthKey, 1);
  render(monthKey);
});

(async () => {
  if (!(await requireToken())) return;
  render(monthKey);
})();
