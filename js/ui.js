// Mảnh giao diện dùng chung: dòng giao dịch, bảng chi tiết, tên ngày.
import { icon, openSheet, toast, showError } from './nav.js';
import { esc } from './ai-client.js';
import { formatVnd, categoryName, categoryIcon, paymentMethodName, priorityName, deleteTransaction, formatDateVn, todayDateStr, debtMethodMap, effectiveMonth, statementDueDate } from './store.js';

const WD = ['Chủ nhật', 'Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7'];

export function dayLabel(dateStr) {
  const today = todayDateStr();
  const d = new Date(`${dateStr}T00:00:00`);
  const y = new Date(`${today}T00:00:00`); y.setDate(y.getDate() - 1);
  const yStr = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, '0')}-${String(y.getDate()).padStart(2, '0')}`;
  const base = `${WD[d.getDay()]}, ${formatDateVn(dateStr)}`;
  if (dateStr === today) return `Hôm nay · ${base}`;
  if (dateStr === yStr) return `Hôm qua · ${base}`;
  return base;
}

export function txTitle(t, categories) {
  if (t.type === 'transfer') {
    return `${paymentMethodName(categories, t.fromPayment)} → ${paymentMethodName(categories, t.toPayment)}`;
  }
  return categoryName(categories, t.type, t.category);
}

// Khoản quẹt thẻ/ví: tính vào tháng phải trả (không phải tháng quẹt) → nhãn nhỏ cho dễ thấy
const _dm = new WeakMap();
const debtMapOf = (categories) => { if (!_dm.has(categories)) _dm.set(categories, debtMethodMap(categories)); return _dm.get(categories); };
export function dueTag(t, categories) {
  if (t.type === 'transfer') return '';
  const eff = effectiveMonth(t, debtMapOf(categories));
  return eff !== t.date.slice(0, 7) ? `💳 tính vào T${Number(eff.slice(5))}` : '';
}

export function txRowHtml(t, categories, { showDate = false } = {}) {
  const isTr = t.type === 'transfer';
  const ico = isTr ? icon('swap') : t.type === 'income' ? '💰' : categoryIcon(t.category);
  const icoCls = isTr ? 'ico-transfer' : t.type === 'income' ? 'ico-income' : '';
  const sign = t.type === 'income' ? '+' : isTr ? '' : '−';
  const sub = [
    showDate ? formatDateVn(t.date) : '',
    t.note || '',
    !isTr && t.paymentMethod ? paymentMethodName(categories, t.paymentMethod) : '',
  ].filter(Boolean).join(' · ');
  const tag = dueTag(t, categories);
  return `<button type="button" class="tx-item" data-id="${esc(t.id)}">
      <span class="cat-ico ${icoCls}">${ico}</span>
      <span class="tx-info"><b>${esc(txTitle(t, categories))}</b><span>${esc(sub || (isTr ? 'Chuyển khoản' : '—'))}</span>${tag ? `<span class="due-tag">${tag}</span>` : ''}</span>
      <span class="tx-amt ${t.type} money">${sign}${formatVnd(t.amount)}${isTr ? '<small>Chuyển khoản</small>' : ''}</span>
    </button>`;
}

// Bảng chi tiết 1 giao dịch: xem, sửa, nhân bản, xoá. onChanged() chạy sau khi xoá.
export function openTxDetail(t, categories, onChanged) {
  const monthKey = t.date.slice(0, 7);
  const isTr = t.type === 'transfer';
  const sign = t.type === 'income' ? '+' : isTr ? '' : '−';
  const cls = t.type === 'income' ? 'pos' : t.type === 'expense' ? 'neg' : '';
  const rows = [
    ['Loại', t.type === 'income' ? 'Thu' : t.type === 'expense' ? 'Chi' : 'Chuyển khoản'],
    ['Ngày', dayLabel(t.date)],
    isTr ? ['Từ', paymentMethodName(categories, t.fromPayment)] : ['Danh mục', categoryName(categories, t.type, t.category)],
    isTr ? ['Đến', paymentMethodName(categories, t.toPayment)] : ['Thanh toán', t.paymentMethod ? paymentMethodName(categories, t.paymentMethod) : '—'],
    t.type === 'expense' ? ['Mức độ', priorityName(categories, t.priority || 'nice')] : null,
    dueTag(t, categories) ? ['Tính vào', (() => { const p = debtMapOf(categories).get(t.paymentMethod);
      return `${dueTag(t, categories).replace('💳 tính vào ', 'Tháng ')}${p.statementDay && p.dueDay ? ` · hạn trả ${formatDateVn(statementDueDate(p, t.date))}` : ' (chưa đặt ngày chốt sao kê)'}`; })()] : null,
    t.note ? ['Ghi chú', t.note] : null,
    t.defaultIncomeId ? ['Nguồn', 'Tự thêm (thu nhập mặc định)'] : null,
  ].filter(Boolean);
  openSheet(`
    <div class="row" style="justify-content:space-between"><h2>${esc(txTitle(t, categories))}</h2>
      <button class="icon-btn" data-act="close" aria-label="Đóng">${icon('x')}</button></div>
    <div class="detail-amt ${cls} money">${sign}${formatVnd(t.amount)}</div>
    <div class="detail-list">${rows.map(([k, v]) => `<div><span>${k}</span><b>${esc(v)}</b></div>`).join('')}</div>
    <div class="form-actions">
      <a class="btn btn-primary" href="add.html?edit=${encodeURIComponent(t.id)}&month=${monthKey}">${icon('edit')}Sửa</a>
      <a class="btn btn-secondary" href="add.html?copy=${encodeURIComponent(t.id)}&month=${monthKey}">${icon('copy')}Nhân bản</a>
    </div>
    <button class="btn btn-danger btn-block" data-act="del" style="margin-top:10px">${icon('trash')}Xoá giao dịch</button>`,
  (sh, close) => {
    sh.querySelector('[data-act=close]').onclick = close;
    sh.querySelector('[data-act=del]').onclick = async (e) => {
      if (!confirm('Xoá giao dịch này? Không hoàn tác được.')) return;
      e.currentTarget.disabled = true;
      try {
        await deleteTransaction(monthKey, t.id);
        close(); toast('Đã xoá giao dịch');
        onChanged?.();
      } catch (err) { close(); showError(err); }
    };
  });
}

// Gắn icon SVG vào các chỗ đánh dấu data-ico="tên" trong HTML tĩnh.
export function hydrateIcons(root = document) {
  root.querySelectorAll('[data-ico]').forEach((el) => { el.innerHTML = icon(el.dataset.ico); });
}
