import { renderNav, requireToken, showError, clearError, icon, toast } from './nav.js';
import { loadCategories, loadTransactions, addTransaction, updateTransaction, deleteTransaction, genId, formatNumber, parseAmountInput, attachAmountInput, categoryIcon, todayDateStr, currentMonthKey } from './store.js';
import { aiCall, AI_AVAILABLE, listen, esc, shrinkImage } from './ai-client.js';
import { hydrateIcons } from './ui.js';
import { setAiContext } from './ai-drawer.js';

renderNav('add');
hydrateIcons();

const params = new URLSearchParams(location.search);
const editId = params.get('edit');
const copyId = params.get('copy');
const srcMonth = params.get('month');

let currentType = 'expense';
let categories = null;

const $ = (id) => document.getElementById(id);
const dateEl = $('f-date');
const categoryEl = $('f-category');
const amountEl = $('f-amount');
const priorityEl = $('f-priority');
const paymentEl = $('f-payment');
const fromPaymentEl = $('f-from-payment');
const toPaymentEl = $('f-to-payment');
const noteEl = $('f-note');
const submitBtn = $('submit-btn');
const moreBtn = $('save-more');
const btnIncome = $('type-income');
const btnExpense = $('type-expense');
const btnTransfer = $('type-transfer');

attachAmountInput(amountEl);
// Ô số tiền co giãn theo độ dài để ký hiệu ₫ luôn đứng sát số
const fitAmount = () => { amountEl.style.width = `${Math.max(2, (amountEl.value || amountEl.placeholder).length + 0.5)}ch`; };
amountEl.addEventListener('input', fitAmount);
const _desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
Object.defineProperty(amountEl, 'value', { get() { return _desc.get.call(this); }, set(v) { _desc.set.call(this, v); fitAmount(); } });
fitAmount();
$('ai-mic').innerHTML = icon('mic');

// Ngày theo giờ máy (không dùng toISOString — trước 7h sáng giờ VN, UTC vẫn còn ngày hôm trước).
const shiftDay = (delta) => {
  const d = new Date(); d.setDate(d.getDate() + delta);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
function syncDayChips() {
  document.querySelectorAll('[data-day]').forEach((c) => c.classList.toggle('on', dateEl.value === shiftDay(Number(c.dataset.day))));
}
document.querySelectorAll('[data-day]').forEach((c) => { c.onclick = () => { dateEl.value = shiftDay(Number(c.dataset.day)); syncDayChips(); }; });
dateEl.addEventListener('change', syncDayChips);

// Số tiền gợi ý nhanh: bấm để CỘNG thêm
const QUICK = [10000, 20000, 50000, 100000, 200000, 500000];
$('quick-amt').innerHTML = QUICK.map((v) => `<button type="button" class="chip" data-add="${v}">+${v >= 1000000 ? v / 1000000 + 'tr' : v / 1000 + 'k'}</button>`).join('')
  + '<button type="button" class="chip" data-add="x1000" title="Nhân 1.000">×1.000</button>';
$('quick-amt').querySelectorAll('[data-add]').forEach((b) => {
  b.onclick = () => {
    const cur = parseAmountInput(amountEl.value);
    const next = b.dataset.add === 'x1000' ? cur * 1000 : cur + Number(b.dataset.add);
    amountEl.value = next ? formatNumber(next) : '';
  };
});

// ── Lưới danh mục (đồng bộ với <select> ẩn — select là nguồn sự thật) ──
function drawCatGrid() {
  const list = currentType === 'income' ? categories.income : categories.expense;
  $('cat-grid').innerHTML = list.map((c) => `<button type="button" class="cat-opt ${categoryEl.value === c.id ? 'on' : ''}" role="radio" aria-checked="${categoryEl.value === c.id}" data-id="${esc(c.id)}">
      <span class="cat-ico">${currentType === 'income' ? '💰' : categoryIcon(c.id)}</span>${esc(c.name)}</button>`).join('');
  $('cat-grid').querySelectorAll('.cat-opt').forEach((b) => { b.onclick = () => { categoryEl.value = b.dataset.id; drawCatGrid(); }; });
}
function drawPrio() {
  $('prio-seg').innerHTML = categories.priorities.map((p) => `<button type="button" class="${priorityEl.value === p.id ? 'active' : ''}" data-id="${esc(p.id)}">${esc(p.name)}</button>`).join('');
  $('prio-seg').querySelectorAll('button').forEach((b) => { b.onclick = () => { priorityEl.value = b.dataset.id; drawPrio(); }; });
}

function setType(type, keepCategory) {
  currentType = type;
  btnIncome.classList.toggle('active', type === 'income');
  btnExpense.classList.toggle('active', type === 'expense');
  btnTransfer.classList.toggle('active', type === 'transfer');
  [btnIncome, btnExpense, btnTransfer].forEach((b) => b.setAttribute('aria-selected', b.classList.contains('active')));
  $('amount-box').className = `amount-box ${type}`;

  const isTransfer = type === 'transfer';
  $('category-field').style.display = isTransfer ? 'none' : '';
  $('priority-field').style.display = type === 'expense' ? '' : 'none';
  $('payment-field').style.display = isTransfer ? 'none' : '';
  $('transfer-fields').style.display = isTransfer ? '' : 'none';
  if (!isTransfer) {
    const list = type === 'income' ? categories.income : categories.expense;
    const prev = categoryEl.value;
    categoryEl.innerHTML = list.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
    categoryEl.value = keepCategory && list.some((c) => c.id === prev) ? prev : '';
    drawCatGrid();
  }
}

btnIncome.addEventListener('click', () => setType('income'));
btnExpense.addEventListener('click', () => setType('expense'));
btnTransfer.addEventListener('click', () => setType('transfer'));

function lastPayment() { try { return localStorage.getItem('lastPayment') || ''; } catch { return ''; } }

async function init() {
  if (!(await requireToken())) return;
  const { categories: cats } = await loadCategories();
  categories = cats;
  priorityEl.innerHTML = categories.priorities.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
  priorityEl.value = 'nice';
  const opts = categories.paymentMethods.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
  paymentEl.innerHTML = '<option value="">— Không ghi —</option>' + opts;
  fromPaymentEl.innerHTML = opts;
  toPaymentEl.innerHTML = opts;

  // Gợi ý ghi chú từ giao dịch tháng này (gõ vài chữ là ra câu cũ)
  loadTransactions(currentMonthKey()).then(({ transactions }) => {
    const notes = [...new Set(transactions.map((t) => t.note).filter(Boolean))].slice(-40);
    $('note-suggest').innerHTML = notes.map((n) => `<option value="${esc(n)}"></option>`).join('');
  }).catch(() => {});

  const srcId = editId || copyId;
  if (srcId && srcMonth) {
    const { transactions } = await loadTransactions(srcMonth);
    const tx = transactions.find((t) => t.id === srcId);
    if (!tx) { showError(new Error('Không tìm thấy giao dịch.')); return; }
    if (editId) {
      $('page-title').textContent = 'Sửa giao dịch';
      submitBtn.textContent = 'Cập nhật';
      moreBtn.classList.add('hidden');
      $('delete-btn').classList.remove('hidden');
      $('ai-quick').style.display = 'none';
    } else {
      $('page-title').textContent = 'Nhân bản giao dịch';
    }
    setType(tx.type);
    dateEl.value = editId ? tx.date : todayDateStr();
    noteEl.value = tx.note || '';
    amountEl.value = formatNumber(tx.amount);
    if (tx.type === 'transfer') {
      fromPaymentEl.value = tx.fromPayment || '';
      toPaymentEl.value = tx.toPayment || '';
    } else {
      categoryEl.value = tx.category; drawCatGrid();
      priorityEl.value = tx.priority || 'nice';
      paymentEl.value = tx.paymentMethod || '';
    }
  } else {
    setType('expense');
    dateEl.value = todayDateStr();
    paymentEl.value = lastPayment();
  }
  drawPrio();
  syncDayChips();
  if (!editId) amountEl.focus({ preventScroll: true });
}

function buildPayload() {
  const amount = parseAmountInput(amountEl.value);
  if (!amount) throw new Error('Nhập số tiền.');
  if (!dateEl.value) throw new Error('Chọn ngày.');
  if (currentType === 'transfer') {
    if (fromPaymentEl.value === toPaymentEl.value) throw new Error('Ví/tài khoản nguồn và đích phải khác nhau.');
    return { date: dateEl.value, type: 'transfer', fromPayment: fromPaymentEl.value, toPayment: toPaymentEl.value, amount, note: noteEl.value.trim() };
  }
  if (!categoryEl.value) throw new Error('Chọn danh mục.');
  const payload = { date: dateEl.value, type: currentType, category: categoryEl.value, amount, note: noteEl.value.trim(), paymentMethod: paymentEl.value || null };
  if (currentType === 'expense') payload.priority = priorityEl.value || 'nice';
  return payload;
}

async function save(andMore) {
  clearError();
  let payload;
  try { payload = buildPayload(); } catch (err) { toast(err.message); return; }
  const btn = andMore ? moreBtn : submitBtn;
  const label = btn.textContent;
  submitBtn.disabled = moreBtn.disabled = true;
  btn.textContent = 'Đang lưu…';
  try {
    const monthKey = payload.date.slice(0, 7);
    if (editId && srcMonth) {
      if (monthKey !== srcMonth) {
        // Đổi sang tháng khác: xoá ở tháng cũ, thêm ở tháng mới (giữ id)
        await deleteTransaction(srcMonth, editId);
        await addTransaction(monthKey, { id: editId, ...payload });
      } else {
        await updateTransaction(srcMonth, editId, payload);
      }
    } else {
      await addTransaction(monthKey, { id: genId(), ...payload });
    }
    try { if (payload.paymentMethod) localStorage.setItem('lastPayment', payload.paymentMethod); } catch {}
    if (andMore) {
      toast('Đã lưu — nhập giao dịch tiếp theo');
      amountEl.value = ''; noteEl.value = ''; $('ai-text').value = '';
      amountEl.focus();
      submitBtn.disabled = moreBtn.disabled = false;
      btn.textContent = label;
      return;
    }
    location.href = `transactions.html?month=${monthKey}`;
  } catch (err) {
    showError(err);
    submitBtn.disabled = moreBtn.disabled = false;
    btn.textContent = label;
  }
}

$('tx-form').addEventListener('submit', (e) => { e.preventDefault(); save(false); });
moreBtn.addEventListener('click', () => save(true));
$('delete-btn').addEventListener('click', async () => {
  if (!confirm('Xoá giao dịch này? Không hoàn tác được.')) return;
  try {
    await deleteTransaction(srcMonth, editId);
    location.href = `transactions.html?month=${srcMonth}`;
  } catch (err) { showError(err); }
});

init().then(() => setAiContext('Trang Thêm/Sửa giao dịch (form nhập tay). Người dùng có thể hỏi nên xếp khoản chi vào danh mục nào, mức độ cần thiết, hoặc có nên chi không.',
  'Thêm giao dịch', ['Khoản này nên xếp danh mục nào?', 'Tháng này còn bao nhiêu ngân sách ăn uống?', 'Mua món này có vượt ngân sách không?'])).catch(showError);

// ── Nhập nhanh: câu nói / giọng nói / ảnh hoá đơn. AI chỉ ĐIỀN form, người dùng xem lại rồi tự bấm Lưu. ──
// Thiếu thông tin thì AI hỏi lại 1 câu → trả lời → AI điền lại. Ảnh nhiều giao dịch → danh sách để chọn.
{
  const box = $('ai-quick'), msg = $('ai-msg'), textEl = $('ai-text');
  const askBox = $('ai-ask'), askIn = $('ai-ask-in'), scanBox = $('ai-scan');
  if (!AI_AVAILABLE) box.style.display = 'none';
  $('ai-photo').innerHTML = icon('camera');
  $('ai-ask-mic').innerHTML = icon('mic');
  const status = (t) => { msg.textContent = t; };
  const setSel = (el, v) => { if (v && [...el.options].some((o) => o.value === v)) { el.value = v; return true; } return false; };
  let convo = null;      // { kind: 'parse'|'image', base: câu gốc, images } — để hỏi lại/bổ sung
  let images = [];

  $('ai-mic').onclick = () => (clearImages(), ask(''), scanBox.classList.add('hidden'), listen((t, fin) => { textEl.value = t; if (fin && t) status('✓ Đã nghe: bấm Điền (hoặc Enter) để AI điền form'); },
    { btn: $('ai-mic'), onStatus: status }));
  $('ai-ask-mic').onclick = () => listen((t) => { askIn.value = t; }, { btn: $('ai-ask-mic'), onStatus: status });
  textEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('ai-fill').click(); } });
  askIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('ai-ask-go').click(); } });

  function applyDraft(d) {
    setType(d.type === 'income' ? 'income' : 'expense');
    if (d.date) dateEl.value = d.date;
    if (d.amount) amountEl.value = formatNumber(d.amount);
    const okCat = setSel(categoryEl, d.category);
    setSel(paymentEl, d.paymentMethod);
    setSel(priorityEl, d.priority);
    if (d.note) noteEl.value = d.note;
    drawCatGrid(); drawPrio(); syncDayChips();
    [dateEl, amountEl, paymentEl, noteEl, $('cat-grid')].forEach((el) => { el.classList.add('ai-filled'); setTimeout(() => el.classList.remove('ai-filled'), 2500); });
    return okCat;
  }
  // Câu hỏi lại: AI tự hỏi, hoặc app tự hỏi khi thiếu danh mục/số tiền/phương thức
  function missingQuestion(d, okCat) {
    if (d.question) return d.question;
    if (!d.amount) return 'Số tiền là bao nhiêu?';
    if (!okCat) return 'Khoản này thuộc danh mục nào?';
    if (d.type !== 'income' && !d.paymentMethod) return 'Trả bằng gì (tiền mặt, ngân hàng, thẻ, ví trả sau)?';
    return '';
  }
  function ask(q) {
    askBox.classList.toggle('hidden', !q);
    $('ai-ask-q').textContent = q || '';
    askIn.value = '';
    if (q) setTimeout(() => askIn.focus(), 50);
  }

  async function runParse(text) {
    const btn = $('ai-fill'); btn.disabled = true; ask('');
    msg.innerHTML = '<span class="thinking">AI đang đọc câu của bạn</span>';
    try {
      const { draft: d } = await aiCall({ mode: 'parse', text });
      const okCat = applyDraft(d);
      const q = missingQuestion(d, okCat);
      ask(q);
      status(q ? 'Còn thiếu 1 chút — trả lời câu hỏi bên dưới, hoặc tự chọn trong form.' : '✓ Đã điền — kiểm tra lại rồi bấm "Lưu giao dịch".');
    } catch (e) { status('⚠ ' + e.message); }
    btn.disabled = false;
  }

  function clearImages() { images = []; $('ai-thumbs').innerHTML = ''; }
  $('ai-fill').onclick = () => {
    const text = textEl.value.trim();
    // Có ảnh vừa chọn mà chưa gõ gì → đọc lại ảnh; gõ câu mới → bỏ ảnh cũ, đọc câu
    if (images.length && !text) return runImage('');
    if (!text) { status('Gõ hoặc nói 1 câu trước, vd "ăn sáng 35k tiền mặt".'); return; }
    clearImages();
    convo = { kind: 'parse', base: text };
    scanBox.classList.add('hidden');
    runParse(text);
  };
  $('ai-ask-go').onclick = () => {
    const a = askIn.value.trim(); if (!a || !convo) return;
    convo.base = convo.base ? `${convo.base}. Bổ sung: ${a}` : a;
    convo.kind === 'image' ? runImage(convo.base) : runParse(convo.base);
  };

  // ── Ảnh: thu nhỏ về ≤1600px JPEG trước khi gửi (ảnh điện thoại 5-10MB → ~300KB) ──
  $('ai-photo').onclick = () => $('ai-file').click();
  $('ai-file').onchange = async (e) => {
    const files = [...e.target.files].slice(0, 4); e.target.value = '';
    if (!files.length) return;
    status('Đang chuẩn bị ảnh…');
    try {
      images = await Promise.all(files.map((f) => shrinkImage(f)));
      $('ai-thumbs').innerHTML = images.map((im) => `<img src="data:image/jpeg;base64,${im.b64}" alt="ảnh đính kèm">`).join('')
        + '<button type="button" class="icon-btn" id="ai-thumbs-x" aria-label="Bỏ ảnh" title="Bỏ ảnh">✕</button>';
      $('ai-thumbs-x').onclick = () => { clearImages(); scanBox.classList.add('hidden'); ask(''); status('Đã bỏ ảnh.'); };
      textEl.value = '';          // ảnh mới = lượt mới, chữ của lượt trước không được gửi kèm
      convo = { kind: 'image', base: '' };
      runImage('');
    } catch (err) { status('⚠ Không đọc được ảnh: ' + err.message); }
  };
  async function runImage(hint) {
    const btn = $('ai-fill'); btn.disabled = true; ask(''); scanBox.classList.add('hidden');
    msg.innerHTML = `<span class="thinking">AI đang đọc ${images.length} ảnh (10–40 giây)</span>`;
    try {
      const { scan } = await aiCall({ mode: 'image', images, text: hint || '' });
      const items = (scan.items || []).filter((it) => it.amount > 0);
      if (!items.length) {
        ask(scan.question || 'Mình chưa đọc được khoản chi nào trong ảnh — ảnh này là gì, số tiền bao nhiêu?');
        status('⚠ ' + (scan.summary || 'Không tìm thấy giao dịch trong ảnh.'));
      } else if (items.length === 1) {
        const okCat = applyDraft(items[0]);
        const q = missingQuestion({ ...items[0], question: scan.question }, okCat);
        ask(q);
        status(`📷 ${scan.summary || 'Đã đọc ảnh'} — ${q ? 'còn thiếu 1 chút, trả lời bên dưới.' : 'kiểm tra rồi bấm "Lưu giao dịch".'}`);
      } else {
        showScanList(items, scan);
      }
    } catch (e) { status('⚠ ' + e.message); }
    btn.disabled = false;
  }

  function validCat(it) {
    const list = it.type === 'income' ? categories.income : categories.expense;
    return list.some((c) => c.id === it.category);
  }
  function showScanList(items, scan) {
    const name = (it) => (validCat(it) ? (it.type === 'income' ? categories.income : categories.expense).find((c) => c.id === it.category).name : null);
    scanBox.innerHTML = `<div class="scan-head"><span>📷 ${esc(scan.summary || 'Ảnh có nhiều giao dịch')} — <b>${items.length} giao dịch</b></span></div>
      ${items.map((it, i) => `<label class="scan-row">
        <input type="checkbox" data-i="${i}" ${validCat(it) ? 'checked' : 'disabled'}>
        <span class="tx-info"><b>${name(it) ? esc(name(it)) : '<span class="warn-cat">Chưa rõ danh mục</span>'}</b><span>${esc(it.date || '')} · ${esc(it.note || '')}</span></span>
        <span class="tx-amt ${it.type === 'income' ? 'income' : 'expense'}">${it.type === 'income' ? '+' : '−'}${formatNumber(it.amount)}</span>
        <button type="button" class="btn btn-sm btn-secondary" data-fill="${i}">Điền</button></label>`).join('')}
      <div class="scan-foot"><span class="small muted" style="margin-right:auto;align-self:center">"Điền" để sửa từng khoản · hoặc lưu hết các khoản đã chọn</span>
        <button type="button" class="btn btn-primary btn-sm" id="scan-save">Lưu các khoản đã chọn</button></div>`;
    scanBox.classList.remove('hidden');
    scanBox.querySelectorAll('[data-fill]').forEach((b) => { b.onclick = (e) => { e.preventDefault(); applyDraft(items[+b.dataset.fill]); status('✓ Đã điền 1 khoản — kiểm tra rồi bấm "Lưu giao dịch".'); $('tx-form').scrollIntoView({ behavior: 'smooth' }); }; });
    $('scan-save').onclick = async () => {
      const pick = [...scanBox.querySelectorAll('input[data-i]:checked')].map((c) => items[+c.dataset.i]);
      if (!pick.length) { status('Chưa chọn khoản nào.'); return; }
      const total = pick.reduce((s, it) => s + it.amount, 0);
      if (!confirm(`Lưu ${pick.length} giao dịch, tổng ${formatNumber(total)}đ?`)) return;
      $('scan-save').disabled = true;
      try {
        for (const it of pick) {   // tuần tự: mỗi lần ghi đọc lại file mới nhất, tránh xung đột
          const tx = { id: genId(), date: it.date || todayDateStr(), type: it.type === 'income' ? 'income' : 'expense', category: it.category,
            amount: it.amount, note: it.note || '', paymentMethod: categories.paymentMethods.some((p) => p.id === it.paymentMethod) ? it.paymentMethod : null };
          if (tx.type === 'expense') tx.priority = categories.priorities.some((p) => p.id === it.priority) ? it.priority : 'nice';
          await addTransaction(tx.date.slice(0, 7), tx);
        }
        toast(`Đã lưu ${pick.length} giao dịch`);
        location.href = `transactions.html?month=${(pick[0].date || todayDateStr()).slice(0, 7)}`;
      } catch (err) { showError(err); $('scan-save').disabled = false; }
    };
    status('Kiểm tra danh sách bên dưới.');
  }
}
