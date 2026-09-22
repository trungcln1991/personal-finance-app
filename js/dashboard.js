import { renderNav, requireToken, showError, icon, toast, getMe, isPrivate, setPrivate } from './nav.js';
import {
  loadCategories, loadBudget, loadTransactions, saveTransactions, formatVnd, currentMonthKey, categoryIcon,
  OWNERS, paymentType, normalizePaymentMethod, loadTransactionsRange, computeAccountBalances,
  shiftMonthKey, computeDebtStatus, addTransaction, genId, resolveVersioned, monthSummary, debtSchedule, debtMethodMap,
  formatNumber, parseAmountInput, attachAmountInput, todayDateStr, formatDateVn, categoryName,
} from './store.js';
import { esc } from './ai-client.js';
import { txRowHtml, openTxDetail, hydrateIcons } from './ui.js';
import { setAiContext } from './ai-drawer.js';

renderNav('dashboard');
hydrateIcons();
document.getElementById('prev-month').innerHTML = icon('left');
document.getElementById('next-month').innerHTML = icon('right');

const monthLabel = (mk) => { const [y, m] = mk.split('-'); return `Tháng ${Number(m)}/${y}`; };
const shortMonth = (mk) => `T${Number(mk.slice(5))}`;
const sum = (list) => list.reduce((s, t) => s + t.amount, 0);
const $ = (id) => document.getElementById(id);

// Lời chào theo giờ + tên người đăng nhập
(() => {
  const h = new Date().getHours();
  const g = h < 11 ? 'Chào buổi sáng' : h < 14 ? 'Chào buổi trưa' : h < 18 ? 'Chào buổi chiều' : 'Chào buổi tối';
  $('greet').textContent = g;
  getMe().then((me) => {
    const name = { 'trung.caolenam@gmail.com': 'Trung', 'lephuc1702@gmail.com': 'Phúc' }[me?.email];
    if (name) $('greet').textContent = `${g}, ${name}`;
  });
})();

const privBtn = $('privacy-btn');
const drawPriv = () => { privBtn.innerHTML = icon(isPrivate() ? 'eyeOff' : 'eye'); };
drawPriv();
privBtn.onclick = () => { setPrivate(!isPrivate()); drawPriv(); };

// "Tháng trả thật" (22/09/2026): khoản quẹt thẻ/ví tính vào THÁNG PHẢI TRẢ theo sao kê (xem store.js monthSummary).
// Chi của tháng = chi tiền mặt/ngân hàng trong tháng + khoản thẻ/ví đến hạn trong tháng — và đúng bằng tổng theo danh mục.
const endOfMonth = (mk) => `${mk}-${String(new Date(Number(mk.slice(0, 4)), Number(mk.slice(5)), 0).getDate()).padStart(2, '0')}`;

function deltaHtml(cur, prev, goodWhenUp) {
  if (!prev) return '<span class="muted">Chưa có tháng trước để so</span>';
  const pct = Math.round(((cur - prev) / prev) * 100);
  if (pct === 0) return 'Bằng tháng trước';
  const up = pct > 0;
  const good = up === goodWhenUp;
  return `<span class="${good ? 'pos' : 'neg'}">${up ? '▲' : '▼'} ${Math.abs(pct)}%</span> so với tháng trước`;
}

async function render(monthKey) {
  $('loading').hidden = false;
  $('content').hidden = true;
  $('month-label').textContent = monthLabel(monthKey);
  $('all-tx').href = `transactions.html?month=${monthKey}`;

  try {
    const [{ categories }, { budget }, { transactions, sha: txSha }] = await Promise.all([
      loadCategories(), loadBudget(), loadTransactions(monthKey),
    ]);

    // Tự thêm thu nhập mặc định (lương...) cho THÁNG HIỆN TẠI nếu chưa có, theo giá trị hiệu lực
    // (versions) tại tháng đó. Không tự thêm khi xem lại tháng cũ hay xem trước tháng tương lai.
    if (monthKey === currentMonthKey() && categories.defaultIncomes?.length) {
      const newTx = categories.defaultIncomes
        .filter((d) => !transactions.some((t) => t.defaultIncomeId === d.id))
        .map((d) => {
          const active = resolveVersioned(d.versions, monthKey);
          if (!active || !active.amount) return null;
          return { id: genId(), date: `${monthKey}-01`, type: 'income', category: d.category, amount: active.amount,
            paymentMethod: d.paymentMethod || null, note: d.name, defaultIncomeId: d.id };
        })
        .filter(Boolean);
      if (newTx.length) {
        transactions.push(...newTx);
        transactions.sort((a, b) => (a.date < b.date ? -1 : 1));
        await saveTransactions(monthKey, transactions, txSha, `Tự động thêm thu nhập mặc định tháng ${monthKey}`);
      }
    }

    const allMethods = categories.paymentMethods.map(normalizePaymentMethod);
    const debtMap = debtMethodMap(categories);

    // Nạp 1 lần: từ mốc cấu hình sớm nhất (tính số dư/nợ) hoặc 5 tháng trước (biểu đồ), lấy cái sớm hơn.
    const earliest = allMethods.flatMap((p) => [p.initialBalanceDate, p.openingDebtDate]).filter(Boolean).sort()[0];
    const flowFrom = shiftMonthKey(monthKey, -8);   // cột đầu của dòng tiền 6 tháng cần cả khoản thẻ quẹt 2 tháng trước đó
    const fromMonth = earliest && earliest.slice(0, 7) < flowFrom ? earliest.slice(0, 7) : flowFrom;
    const loaded = await loadTransactionsRange(fromMonth);
    // Giao dịch tháng đang xem lấy từ bản vừa đọc (có thể vừa thêm lương tự động).
    const allTx = [...loaded.filter((t) => t.date.slice(0, 7) !== monthKey), ...transactions];

    // ── 4 ô tổng ──
    const cur = monthSummary(allTx, monthKey, debtMap);
    const prevMk = shiftMonthKey(monthKey, -1);
    const prev = monthSummary(allTx, prevMk, debtMap);
    $('total-income').textContent = formatVnd(cur.income);
    $('total-expense').textContent = formatVnd(cur.out);
    $('d-income').innerHTML = deltaHtml(cur.income, prev.income, true);
    $('d-expense').innerHTML = deltaHtml(cur.out, prev.out, false)
      + (cur.cardDue ? `<br><span class="muted">gồm <b class="money">${formatVnd(cur.cardDue)}</b> thẻ/ví đến hạn</span>` : '');

    // Tháng đã qua: tính tới cuối tháng đó. Tháng này / tương lai: tính tới hôm nay.
    const today = todayDateStr();
    const until = endOfMonth(monthKey) < today ? endOfMonth(monthKey) : today;
    const sched = debtSchedule(categories, allTx, monthKey, until);
    const nextDue = sched.reduce((s, r) => s + r.nextDue, 0);
    const later = sched.reduce((s, r) => s + r.later, 0);
    const unpaidDue = sched.reduce((s, r) => s + r.unpaidDue, 0);
    $('deferred-label').textContent = `Phải trả ${shortMonth(shiftMonthKey(monthKey, 1))}`;
    $('total-deferred').textContent = formatVnd(nextDue);
    $('deferred-sub').innerHTML = sched.filter((r) => r.nextDue).map((r) => `${esc(r.name.replace(/\s*\(.*\)/, ''))} <b class="money">${formatVnd(r.nextDue)}</b>`).join(' · ')
      + (later ? `<br><span class="muted">sau đó còn <b class="money">${formatVnd(later)}</b></span>` : '') || 'Không có khoản thẻ/ví đến hạn';

    // "Còn lại" = tiền thật (mặt + ngân hàng) tới cuối tháng / hôm nay − nợ thẻ/ví ĐÃ tới hạn tháng này mà chưa trả.
    const carryOver = computeAccountBalances(categories, allTx.filter((t) => t.date < `${monthKey}-01`))
      .reduce((s, a) => s + (a.balance || 0), 0);
    const realEnd = computeAccountBalances(categories, allTx.filter((t) => t.date <= until))
      .reduce((s, a) => s + (a.balance || 0), 0);
    const balance = realEnd - unpaidDue;
    $('total-balance').textContent = formatVnd(balance);
    $('total-balance').className = 'kpi-value money ' + (balance >= 0 ? '' : 'neg');
    $('carry-line').innerHTML = unpaidDue
      ? `Tiền thật <b class="money">${formatVnd(realEnd)}</b> − nợ đến hạn chưa trả <b class="money">${formatVnd(unpaidDue)}</b>`
      : carryOver ? `Gồm <b class="money">${formatVnd(carryOver)}</b> mang sang` : 'Tiền mặt + ngân hàng';

    // ── Hero: tiền đang có hôm nay (không phụ thuộc tháng đang xem) ──
    const accounts = computeAccountBalances(categories, allTx);
    const cashNow = accounts.reduce((s, a) => s + (a.balance || 0), 0);
    const debts = computeDebtStatus(categories, allTx, todayDateStr());
    const debtNow = debts.reduce((s, d) => s + Math.max(0, d.totalDebt || 0), 0);
    $('hero-cash').textContent = formatVnd(cashNow);
    $('hero-debt').textContent = formatVnd(debtNow);
    $('hero-net').textContent = formatVnd(cashNow - debtNow);
    const dueSoon = debts.filter((d) => d.dueAmount > 0 && d.dueDate).sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1))[0];
    $('hero-sub').textContent = dueSoon
      ? `${dueSoon.isOverdue ? '⚠ Quá hạn' : 'Sắp đến hạn'}: ${dueSoon.name} ${formatVnd(dueSoon.dueAmount)} · hạn ${formatDateVn(dueSoon.dueDate)}`
      : `${accounts.length} tài khoản · cập nhật ${formatDateVn(todayDateStr())}`;

    // ── Dòng tiền 6 tháng ──
    const months = Array.from({ length: 6 }, (_, i) => shiftMonthKey(monthKey, i - 5));
    const flows = months.map((mk) => ({ mk, ...monthSummary(allTx, mk, debtMap) }));
    const max = Math.max(1, ...flows.flatMap((f) => [f.income, f.out]));
    $('flow').innerHTML = flows.map((f) => `
      <div class="flow-col ${f.mk === monthKey ? 'sel' : ''}" data-mk="${f.mk}" role="button" tabindex="0" aria-label="${monthLabel(f.mk)}: thu ${formatVnd(f.income)}, chi ${formatVnd(f.out)}">
        <div class="flow-bars"><span class="b-in" style="height:${(f.income / max) * 100}%"></span><span class="b-out" style="height:${(f.out / max) * 100}%"></span></div>
        <div class="tip">${monthLabel(f.mk)}<br>Thu ${formatVnd(f.income)}<br>Chi ${formatVnd(f.out)}<br>Chênh ${f.income - f.out >= 0 ? '+' : ''}${formatVnd(f.income - f.out)}</div>
      </div>`).join('');
    $('flow-x').innerHTML = flows.map((f) => `<span class="${f.mk === monthKey ? 'sel' : ''}">${shortMonth(f.mk)}</span>`).join('');
    $('flow').querySelectorAll('.flow-col').forEach((c) => {
      const go = () => { if (c.dataset.mk !== monthKey) { cur_mk = c.dataset.mk; render(cur_mk); } };
      c.onclick = go; c.onkeydown = (e) => { if (e.key === 'Enter') go(); };
    });
    const withData = flows.filter((f) => f.income || f.out);
    const avgOut = withData.length ? withData.reduce((s, f) => s + f.out, 0) / withData.length : 0;
    $('flow-note').textContent = withData.length
      ? `Trung bình chi ${formatVnd(Math.round(avgOut))}/tháng · ${withData.filter((f) => f.income >= f.out).length}/${withData.length} tháng thu ≥ chi. Bấm vào cột để xem tháng đó.`
      : 'Chưa có dữ liệu.';

    // ── Tài khoản theo chủ sở hữu ──
    const groups = OWNERS.map((o) => {
      const list = accounts.filter((a) => (a.owner || 'shared') === o.id);
      if (!list.length) return '';
      const total = list.reduce((s, a) => s + (a.balance || 0), 0);
      return `<div class="owner-group"><div class="owner-head"><span>${o.label}</span><span class="money">${formatVnd(total)}</span></div>
        ${list.map((a) => `<a class="acct drill-link" href="transactions.html?month=${monthKey}&pay=${encodeURIComponent(a.id)}"><span class="cat-ico">${paymentType(a.type).icon}</span>
          <span class="acct-name"><b>${esc(a.name)}</b><span>${paymentType(a.type).label}</span></span>
          <span class="acct-bal money">${a.balance === null ? '<span class="badge warn">Chưa cấu hình</span>' : formatVnd(a.balance)}</span><span class="chev">${icon('right')}</span></a>`).join('')}</div>`;
    }).join('');
    $('owner-balance-grid').innerHTML = groups || '<p class="muted">Chưa có tài khoản tiền mặt/ngân hàng. <a href="settings.html#payment">Thêm ngay</a></p>';

    // ── Thẻ tín dụng & ví trả sau (sổ nợ) ──
    renderDebts(debts, accounts, monthKey);

    // ── Chi theo danh mục & ngân sách (gộp 1 bảng) ──
    const byCat = {}, byCatCard = {};
    for (const t of cur.expenseList) {
      byCat[t.category] = (byCat[t.category] || 0) + t.amount;
      if (t.dueMonth) byCatCard[t.category] = (byCatCard[t.category] || 0) + t.amount;
    }
    const totalExp = Object.values(byCat).reduce((a, b) => a + b, 0);
    const budgets = Object.entries(budget.categories || {})
      .map(([id, cfg]) => [id, { cfg, active: resolveVersioned(cfg.versions, monthKey) }])
      .filter(([, b]) => b.active);
    const bMap = Object.fromEntries(budgets);
    const catIds = [...new Set([...Object.keys(byCat), ...budgets.map(([id]) => id)])]
      .sort((a, b) => (byCat[b] || 0) - (byCat[a] || 0));
    const dayOfMonth = monthKey === currentMonthKey() ? new Date().getDate() : null;
    const daysIn = new Date(Number(monthKey.slice(0, 4)), Number(monthKey.slice(5)), 0).getDate();
    $('cat-list').innerHTML = catIds.length ? catIds.map((id) => {
      const spent = byCat[id] || 0;
      const b = bMap[id];
      const name = b?.cfg.name || categoryName(categories, 'expense', id);
      let bar, sub;
      if (b) {
        const limit = b.active.monthlyAmount || 0;
        const pct = limit ? spent / limit : 0;
        const cls = pct >= 1 ? 'over' : pct >= (b.cfg.alertThreshold ?? 0.9) ? 'warn' : '';
        bar = `<div class="bar"><i class="${cls}" style="width:${Math.min(pct, 1) * 100}%"></i></div>`;
        const left = limit - spent;
        sub = left >= 0 ? `còn ${formatVnd(left)} / ${formatVnd(limit)}` : `vượt ${formatVnd(-left)} / ${formatVnd(limit)}`;
        // Dự báo: tháng hiện tại, tiêu theo nhịp hiện tại thì cuối tháng có vượt không
        // (khoản thẻ/ví đến hạn là số cố định cả tháng, không nhân theo nhịp ngày)
        const cashPart = spent - (byCatCard[id] || 0);
        if (dayOfMonth && left >= 0 && cashPart > 0 && (byCatCard[id] || 0) + (cashPart / dayOfMonth) * daysIn > limit * 1.05) sub += ' · <span class="neg">nhịp này sẽ vượt</span>';
      } else {
        bar = `<div class="bar"><i style="width:${totalExp ? (spent / totalExp) * 100 : 0}%;background:var(--text-2);opacity:.45"></i></div>`;
        sub = 'chưa đặt ngân sách';
      }
      return `<div class="cat-item" data-cat="${esc(id)}">
        <div class="rank-row drill" role="button" tabindex="0" aria-expanded="false"><span class="cat-ico">${categoryIcon(id)}</span>
        <div class="rank-body"><div class="rank-top"><span class="rank-name">${esc(name)}</span><b class="money">${formatVnd(spent)}</b></div>${bar}
        <div class="rank-sub"><span>${sub}</span><span>${totalExp ? Math.round((spent / totalExp) * 100) : 0}% tổng chi<span class="chev">${icon('right')}</span></span></div></div></div>
        <div class="drill-panel" hidden></div></div>`;
    }).join('') : '<div class="empty"><div class="big">🧾</div>Chưa có khoản chi nào tháng này.</div>';

    // Bấm 1 danh mục → bung chi tiết ngay bên dưới (chỉ mở 1 mục 1 lúc)
    const prevExp = prev.expenseList;
    const drillCtx = { monthKey, prevMk, categories, expenses: cur.expenseList, prevExp, bMap, dayOfMonth, daysIn, rerender: () => render(monthKey) };
    $('cat-list').querySelectorAll('.cat-item').forEach((item) => {
      const row = item.querySelector('.drill');
      const toggle = () => toggleCatDrill(item, drillCtx);
      row.onclick = toggle;
      row.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } };
    });

    // Cảnh báo vượt ngân sách
    const overRows = budgets.map(([id, b]) => ({ id, name: b.cfg.name || id, icon: categoryIcon(id), over: (byCat[id] || 0) - b.active.monthlyAmount }))
      .filter((r) => r.over > 0).sort((a, b) => b.over - a.over);
    $('over-budget-card').hidden = !overRows.length;
    if (overRows.length) {
      $('over-title').textContent = `${overRows.length} mục vượt ngân sách · tổng ${formatVnd(overRows.reduce((s, r) => s + r.over, 0))}`;
      $('over-budget-list').innerHTML = overRows.map((r) => `<button type="button" class="over-row" data-cat="${esc(r.id)}"><span>${r.icon} ${esc(r.name)}</span><span class="money">+${formatVnd(r.over)}</span></button>`).join('')
        + '<div class="small muted" style="margin-top:4px">Bấm vào mục để xem vượt từ ngày nào, do những khoản nào.</div>';
      // Bấm mục vượt → cuộn tới danh mục đó bên dưới và bung chi tiết
      $('over-budget-list').querySelectorAll('.over-row').forEach((b) => {
        b.onclick = () => {
          const item = [...$('cat-list').querySelectorAll('.cat-item')].find((el) => el.dataset.cat === b.dataset.cat);
          if (!item) return;
          if (item.querySelector('.drill-panel').hidden) toggleCatDrill(item, drillCtx);
          item.scrollIntoView({ behavior: 'smooth', block: 'start' });
        };
      });
    }

    // ── Mức độ cần thiết ──
    const P = [['essential', 'Bắt buộc'], ['nice', 'Có thì tốt'], ['unnecessary', 'Không cần thiết']];
    const byP = { essential: 0, nice: 0, unnecessary: 0 };
    for (const t of cur.expenseList) byP[t.priority || 'nice'] = (byP[t.priority || 'nice'] || 0) + t.amount;
    $('priority-card').innerHTML = totalExp ? `
      <div class="stack-bar">${P.map(([k]) => byP[k] ? `<i class="p-${k}" style="width:${(byP[k] / totalExp) * 100}%"></i>` : '').join('')}</div>
      <div class="stack-legend">${P.map(([k, l]) => `<a class="drill-link" href="transactions.html?month=${monthKey}&basis=due&type=expense&prio=${k}"><i class="p-${k}"></i>${l}<span class="muted">${Math.round((byP[k] / totalExp) * 100)}%</span><b class="money">${formatVnd(byP[k])}</b><span class="chev">${icon('right')}</span></a>`).join('')}</div>
      ${byP.unnecessary ? `<p class="small muted" style="margin:10px 0 0">Cắt được phần "Không cần thiết" là dư thêm ${formatVnd(byP.unnecessary)} tháng này.</p>` : ''}`
      : '<p class="muted" style="margin:0">Chưa có khoản chi.</p>';

    // ── Giao dịch gần đây ──
    const recent = [...transactions].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)).slice(0, 6);
    $('recent').innerHTML = recent.length ? recent.map((t) => txRowHtml(t, categories, { showDate: true })).join('')
      : '<div class="empty">Chưa có giao dịch. <a href="add.html">Thêm giao dịch đầu tiên</a></div>';
    $('recent').querySelectorAll('.tx-item').forEach((el) => {
      el.onclick = () => openTxDetail(transactions.find((t) => t.id === el.dataset.id), categories, () => render(monthKey));
    });

    // Cho trợ lý AI biết màn hình đang hiện gì (hỏi "khoản này", "tháng này" là hiểu)
    setAiContext([
      `Trang Tổng quan, ${monthLabel(monthKey)}.`,
      `Thu ${formatVnd(cur.income)}, Chi ${formatVnd(cur.out)} (tính theo tháng trả thật: tiền mặt/ngân hàng ${formatVnd(cur.cashOut)} + thẻ/ví đến hạn ${formatVnd(cur.cardDue)}), Còn lại ${formatVnd(balance)}, phải trả tháng sau ${formatVnd(nextDue)}${later ? `, sau đó ${formatVnd(later)}` : ''}.`,
      `Tiền đang có ${formatVnd(cashNow)}, nợ thẻ/ví ${formatVnd(debtNow)}, tài sản ròng ${formatVnd(cashNow - debtNow)}.`,
      overRows.length ? `Vượt ngân sách: ${overRows.map((r) => `${r.name} +${formatVnd(r.over)}`).join(', ')}.` : 'Không mục nào vượt ngân sách.',
      `Dòng tiền 6 tháng: ${flows.map((f) => `${shortMonth(f.mk)} thu ${formatVnd(f.income)}/chi ${formatVnd(f.out)}`).join('; ')}.`,
      debts.filter((d) => d.configured).map((d) => `${d.name}: nợ ${formatVnd(d.totalDebt)}, đến hạn ${formatVnd(d.dueAmount)}${d.dueDate ? ' hạn ' + formatDateVn(d.dueDate) : ''}`).join('; '),
    ].filter(Boolean).join(' '), `Tổng quan ${monthLabel(monthKey)}`, [
      `Vì sao ${monthLabel(monthKey).toLowerCase()} chi nhiều hơn tháng trước?`,
      overRows.length ? `Cắt ${overRows[0].name.toLowerCase()} thế nào cho hợp lý?` : 'Tháng này có dư được bao nhiêu?',
      'Nên trả nợ thẻ bao nhiêu để không mất phí?',
      cashNow - debtNow < 0 ? 'Tài sản ròng đang âm — làm sao để về dương?' : 'Nên để dành bao nhiêu mỗi tháng?',
    ]);

    $('loading').hidden = true;
    $('content').hidden = false;
  } catch (err) {
    $('loading').hidden = true;
    showError(err);
  }
}

// ── Chi tiết 1 danh mục (bung ngay dưới dòng) ──
// Trả lời 3 câu: tiêu vào đâu (danh sách), vượt từ lúc nào (ngày + khoản làm vượt), so tháng trước ra sao.
function toggleCatDrill(item, ctx) {
  const list = item.closest('#cat-list');
  const panel = item.querySelector('.drill-panel');
  const opening = panel.hidden;
  list.querySelectorAll('.cat-item').forEach((el) => {
    el.querySelector('.drill-panel').hidden = true;
    el.querySelector('.drill').setAttribute('aria-expanded', 'false');
    el.classList.remove('open');
  });
  if (!opening) return;
  panel.innerHTML = catDrillHtml(item.dataset.cat, ctx);
  panel.hidden = false;
  item.classList.add('open');
  item.querySelector('.drill').setAttribute('aria-expanded', 'true');
  panel.querySelectorAll('.tx-item').forEach((el) => {
    el.onclick = () => openTxDetail(ctx.expenses.find((t) => t.id === el.dataset.id), ctx.categories, ctx.rerender);
  });
}

function catDrillHtml(id, { monthKey, prevMk, categories, expenses, prevExp, bMap, dayOfMonth, daysIn }) {
  const txs = expenses.filter((t) => t.category === id);
  const spent = sum(txs);
  const prevSpent = sum(prevExp.filter((t) => t.category === id));
  const limit = bMap[id]?.active.monthlyAmount || 0;
  const link = `transactions.html?month=${monthKey}&basis=due&type=expense&cat=${encodeURIComponent(id)}`;

  const stats = [
    ['Số lần chi', `${txs.length} lần`],
    ['Trung bình / lần', txs.length ? `<span class="money">${formatVnd(Math.round(spent / txs.length))}</span>` : '—'],
    [`So ${shortMonth(prevMk)}`, prevSpent
      ? `<span class="${spent > prevSpent ? 'neg' : 'pos'}">${spent > prevSpent ? '▲' : '▼'} ${Math.abs(Math.round(((spent - prevSpent) / prevSpent) * 100))}%</span> <span class="muted money">(${formatVnd(prevSpent)})</span>`
      : '<span class="muted">tháng trước 0</span>'],
  ];

  // Ngân sách: vượt từ ngày nào, do khoản nào / còn tiêu được bao nhiêu mỗi ngày
  let note = '';
  let crossId = null;
  if (limit) {
    // Khoản thẻ/ví đến hạn là tiền phải trả của CHÍNH tháng này → xếp ở đầu tháng (không theo ngày quẹt tháng trước)
    const key = (t) => (t.dueMonth && t.date.slice(0, 7) !== monthKey ? `${monthKey}-00` : t.date);
    const asc = [...txs].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
    let run = 0;
    for (const t of asc) { run += t.amount; if (run > limit) { crossId = t.id; break; } }
    const cross = asc.find((t) => t.id === crossId);
    if (cross) {
      const after = asc.slice(asc.indexOf(cross) + 1);
      const early = key(cross).endsWith('-00');
      note = `<div class="drill-note danger">Vượt hạn mức <b class="money">${formatVnd(limit)}</b> ${early ? '<b>ngay đầu tháng</b> khi cộng khoản thẻ/ví đến hạn' : `từ <b>${formatDateVn(cross.date)}</b>`}
        (khoản <b class="money">${formatVnd(cross.amount)}</b>${cross.note ? ` · ${esc(cross.note)}` : ''}${early ? `, quẹt ${formatDateVn(cross.date)}` : ''})${after.length ? ` · sau đó thêm ${after.length} khoản <b class="money">${formatVnd(sum(after))}</b>` : ''}.</div>`;
    } else if (dayOfMonth) {
      const daysLeft = daysIn - dayOfMonth + 1;
      note = `<div class="drill-note">Còn <b class="money">${formatVnd(limit - spent)}</b> cho ${daysLeft} ngày cuối tháng → tiêu tối đa ~<b class="money">${formatVnd(Math.floor((limit - spent) / daysLeft))}</b>/ngày.</div>`;
    }
  }

  const desc = [...txs].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const SHOW = 8;
  const rows = desc.slice(0, SHOW).map((t) => {
    const html = txRowHtml(t, categories, { showDate: true });
    return t.id === crossId ? html.replace('class="tx-item"', 'class="tx-item cross" title="Khoản này làm vượt ngân sách"') : html;
  }).join('');

  return `<div class="drill-stats">${stats.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('')}</div>
    ${note}
    ${txs.length ? `<div class="tx-card drill-tx">${rows}</div>` : '<p class="small muted" style="margin:8px 0">Chưa có khoản chi nào trong danh mục này tháng này.</p>'}
    <a class="btn btn-secondary btn-sm drill-open" href="${link}">${desc.length > SHOW ? `Xem đủ ${desc.length} giao dịch` : 'Mở trong trang Giao dịch'} ${icon('right')}</a>`;
}

function renderDebts(debts, payAccounts, monthKey) {
  const box = $('credit-wallet-card');
  if (!debts.length) {
    box.innerHTML = '<p class="muted" style="margin:0">Chưa có thẻ tín dụng/ví trả sau. <a href="settings.html#payment">Thêm</a></p>';
    return;
  }
  box.innerHTML = debts.map((p) => {
    const t = paymentType(p.type);
    if (!p.configured) {
      return `<div class="debt"><div class="debt-top"><span class="cat-ico">${t.icon}</span><span class="acct-name"><b>${esc(p.name)}</b><span>${t.label}</span></span>
        <a class="badge warn" href="settings.html#payment">Chưa cấu hình nợ</a></div></div>`;
    }
    const badge = p.isOverdue ? '<span class="badge danger">Quá hạn</span>'
      : p.dueAmount > 0 ? `<span class="badge warn">Hạn ${formatDateVn(p.dueDate) || 'tháng này'}</span>`
      : p.totalDebt <= 0 ? '<span class="badge good">Hết nợ</span>' : '';
    const suggested = p.dueAmount > 0 ? p.dueAmount : p.totalDebt;
    return `<div class="debt" data-method="${esc(p.id)}">
      <a class="debt-top drill-link" href="transactions.html?month=${monthKey}&pay=${encodeURIComponent(p.id)}"><span class="cat-ico">${t.icon}</span><span class="acct-name"><b>${esc(p.name)}</b><span>Tổng nợ <span class="money">${formatVnd(p.totalDebt)}</span> · xem giao dịch</span></span>${badge}<span class="chev">${icon('right')}</span></a>
      <div class="debt-meta">
        <div class="${p.isOverdue ? 'overdue' : 'due'}"><span>Đến hạn phải trả</span><b class="money">${formatVnd(p.dueAmount)}</b></div>
        <div><span>${p.dueDate ? 'Kỳ hiện tại (chưa chốt)' : 'Phát sinh tháng này'}</span><b class="money">${formatVnd(p.currentMonthSpend)}</b></div>
      </div>
      ${p.canPay && payAccounts.length ? `<div class="pay-row">
        <input type="text" inputmode="numeric" class="cw-pay-amount" value="${formatNumber(suggested)}" aria-label="Số tiền trả" />
        <select class="cw-pay-account" aria-label="Trả từ tài khoản">${payAccounts.map((a) => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('')}</select>
        <button class="btn btn-secondary cw-pay-btn">Ghi nhận trả nợ</button></div>` : ''}
    </div>`;
  }).join('');

  box.querySelectorAll('.pay-row').forEach((row) => {
    const wrap = row.closest('.debt');
    const amountEl = row.querySelector('.cw-pay-amount');
    attachAmountInput(amountEl);
    row.querySelector('.cw-pay-btn').addEventListener('click', async (e) => {
      const method = debts.find((m) => m.id === wrap.dataset.method);
      const amount = parseAmountInput(amountEl.value);
      if (!amount) { toast('Nhập số tiền đã trả'); return; }
      const remaining = method.totalDebt - amount;
      if (!confirm(`Ghi nhận trả ${formatVnd(amount)} cho ${method.name}? ${remaining > 0 ? `Còn nợ ${formatVnd(remaining)}.` : 'Hết nợ.'}`)) return;
      e.currentTarget.disabled = true;
      try {
        const today = todayDateStr();
        await addTransaction(today.slice(0, 7), {
          id: genId(), date: today, type: 'transfer',
          fromPayment: row.querySelector('.cw-pay-account').value, toPayment: method.id,
          amount, note: `Trả nợ ${method.name}`,
        });
        toast('Đã ghi nhận trả nợ');
        render(monthKey);
      } catch (err) { showError(err); e.currentTarget.disabled = false; }
    });
  });
}

let cur_mk = new URLSearchParams(location.search).get('month') || currentMonthKey();
$('prev-month').addEventListener('click', () => { cur_mk = shiftMonthKey(cur_mk, -1); render(cur_mk); });
$('next-month').addEventListener('click', () => { cur_mk = shiftMonthKey(cur_mk, 1); render(cur_mk); });

window.addEventListener('finance:changed', () => render(cur_mk));  // trợ lý AI vừa ghi

(async () => {
  if (!(await requireToken())) return;
  render(cur_mk);
})();
