// Trợ lý AI hội thoại — nút nổi ở MỌI trang, nói chuyện bằng giọng nói hoặc gõ.
// Làm được: TẠO / SỬA / XOÁ giao dịch và TRA CỨU. AI chỉ ĐỀ XUẤT (JSON), app hiện thẻ xác nhận;
// chỉ khi người dùng nói "ok"/bấm Lưu thì APP mới ghi (cùng đường ghi như form → mỗi lần = 1 commit git).
// Máy tính: cột phải, trang co lại vẫn thấy. Điện thoại: toàn màn hình. Hội thoại giữ khi chuyển trang.
import { aiCall, AI_AVAILABLE, md, esc, listen } from './ai-client.js';
import {
  loadCategories, loadTransactions, addTransaction, updateTransaction, deleteTransaction, genId,
  formatVnd, formatDateVn, todayDateStr, currentMonthKey, shiftMonthKey,
} from './store.js';

const KEY = 'ai-drawer';
const VOICE_KEY = 'ai-voice';
const DEFAULT_CHIPS = ['Thêm giao dịch mới', 'Tháng này chi tiền chợ bao nhiêu?', 'Sửa giao dịch gần nhất', 'Xoá một giao dịch'];
const I = {
  spark: '<path d="M12 3l1.8 4.9L19 9.7l-5.2 1.8L12 16.5l-1.8-5L5 9.7l5.2-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  send: '<path d="M22 2 11 13M22 2l-7 20-4-9-9-4z"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 15h10l1-15"/>',
  pie: '<path d="M21 12A9 9 0 1 1 12 3v9z"/><path d="M15 3.5A9 9 0 0 1 20.5 9H15z"/>',
  vol: '<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>',
  mute: '<path d="M11 5 6 9H3v6h3l5 4z"/><path d="m22 9-6 6M16 9l6 6"/>',
};
const svg = (n) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${I[n]}</svg>`;

let state = load();
let ctx = { page: '', label: '', chips: DEFAULT_CHIPS };
let busy = false;
let el, fab, cats = null;
let voiceOn = (() => { try { return localStorage.getItem(VOICE_KEY) !== '0'; } catch { return true; } })();
let handsFree = false;   // đang trong vòng hội thoại giọng nói: nói xong → tự nghe tiếp

function load() {
  const empty = { open: false, turns: [], left: null, pending: null };
  try { return { ...empty, ...JSON.parse(sessionStorage.getItem(KEY)) }; } catch { return empty; }
}
function save() { try { sessionStorage.setItem(KEY, JSON.stringify({ ...state, turns: state.turns.slice(-40) })); } catch {} }
const $d = (sel) => el.querySelector(sel);

export function setAiContext(page, label, chips) {
  ctx = { page: page || '', label: label || ctx.label, chips: chips?.length ? [...new Set([DEFAULT_CHIPS[0], ...chips])].slice(0, 5) : DEFAULT_CHIPS };
  if (el) drawHead(), drawChips();
}

// ── Giọng đọc (Web Speech) ──
function viVoice() { return speechSynthesis.getVoices().find((v) => /^vi/i.test(v.lang)) || null; }
function speak(text) {
  return new Promise((resolve) => {
    if (!voiceOn || !('speechSynthesis' in window) || !text) return resolve();
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(String(text).replace(/[*_#`>|]/g, '').slice(0, 400));
    u.lang = 'vi-VN'; const v = viVoice(); if (v) u.voice = v;
    u.rate = 1.05;
    u.onend = u.onerror = () => resolve();
    speechSynthesis.speak(u);
    setTimeout(resolve, 20000); // phòng trình duyệt không gọi onend
  });
}

const YES = /^(có|co|ok|oke|okay|ừ|ừm|uh|đồng ý|dong y|lưu|luu|xoá|xóa|xoa|được|duoc|đúng|dung|chuẩn|xác nhận|xac nhan|yes|chắc chắn|làm đi)/i;
const NO = /^(không|khong|ko|thôi|thoi|huỷ|hủy|huy|đừng|sai|no\b|chưa)/i;

function listenTurn() {
  if (!state.open) return;
  listen((t, fin) => {
    const input = $d('#aid-in'); input.value = t; autoGrow(input);
    if (fin && t.trim()) handleUserText(t.trim(), true);
  }, { btn: $d('#aid-mic'), onStatus: (t) => { $d('#aid-left').textContent = t; if (/Không nghe thấy|⚠/.test(t)) handsFree = false; } });
}

// ── Mở / đóng ──
export function openAi(ask) {
  if (!el) return;
  state.open = true; save();
  el.hidden = false;
  void el.offsetWidth; // ép vẽ trạng thái đóng trước để hiệu ứng trượt chạy (rAF bị hoãn khi tab chạy nền)
  el.classList.add('open'); document.body.classList.add('ai-open');
  fab.hidden = true;
  draw();
  if (ask) return handleUserText(ask, false);
  // Mở bằng thao tác bấm → chào + tự nghe (vòng hội thoại giọng nói)
  if (!state.turns.length && AI_AVAILABLE) {
    const hi = `Chào ${greetName()}, mình giúp gì? Bạn có thể nói: thêm giao dịch, sửa, xoá, hoặc hỏi số liệu.`;
    pushAssistant({ say: hi });
    save(); draw();
    handsFree = voiceOn;
    speak(hi).then(() => { if (handsFree) listenTurn(); });
  } else setTimeout(() => $d('#aid-in')?.focus({ preventScroll: true }), 220);
}
export function closeAi() {
  state.open = false; handsFree = false; save();
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  el.classList.remove('open'); document.body.classList.remove('ai-open');
  fab.hidden = false;
  setTimeout(() => { if (!state.open) el.hidden = true; }, 220);
}
export const toggleAi = () => (state.open ? closeAi() : openAi());
let me = '';
fetch('/api/me').then((r) => (r.ok ? r.json() : null)).then((j) => { me = j?.email || ''; }).catch(() => {});
const greetName = () => ({ 'trung.caolenam@gmail.com': 'Trung', 'lephuc1702@gmail.com': 'Phúc' }[me] || 'bạn');

// ── Vẽ ──
function drawHead() {
  $d('#aid-ctx').textContent = ctx.label ? `Đang xem: ${ctx.label}` : 'Thêm · sửa · xoá · tra cứu bằng giọng nói';
  if (state.left != null && !$d('#aid-left').textContent.startsWith('🔴')) $d('#aid-left').textContent = `Còn ${state.left} lượt hôm nay`;
  $d('#aid-voice').innerHTML = svg(voiceOn ? 'vol' : 'mute');
  $d('#aid-voice').title = voiceOn ? 'Đang bật đọc to — bấm để tắt' : 'Đang tắt đọc to — bấm để bật';
}
function drawChips() {
  const box = $d('#aid-chips');
  box.innerHTML = ctx.chips.map((c) => `<button type="button" class="chip">${esc(c)}</button>`).join('');
  box.querySelectorAll('.chip').forEach((b) => { b.onclick = () => handleUserText(b.textContent, false); });
}
function turnHtml(t, i) {
  if (t.role === 'user') return `<div class="ai-msg user">${esc(t.content)}</div>`;
  if (t.role === 'card') return cardHtml(t, i);
  if (t.role === 'sys') return `<div class="aid-sys">${esc(t.content)}</div>`;
  return `<div class="ai-msg assistant">${md(t.content)}${t.detail ? `<div class="aid-detail">${md(t.detail)}</div>` : ''}</div>`;
}
function draw() {
  drawHead();
  const body = $d('#aid-body');
  if (!AI_AVAILABLE) {
    body.innerHTML = '<div class="empty">Trợ lý AI chỉ có ở bản mới: <a href="https://taichinh.dichvunamtrung.com">taichinh.dichvunamtrung.com</a></div>';
    return;
  }
  body.innerHTML = (state.turns.length ? state.turns.map(turnHtml).join('')
    : `<div class="aid-empty"><div class="aid-hello">${svg('spark')}</div><b>Trợ lý tài chính</b>
        <p>Nói hoặc gõ: "thêm giao dịch", "sửa khoản ăn trưa hôm qua thành 60 nghìn", "xoá khoản cà phê", "tháng này tiền chợ bao nhiêu?". Mọi thay đổi đều hỏi bạn trước khi lưu.</p></div>`)
    + (busy ? '<div class="ai-msg assistant muted"><span class="thinking">Đang nghĩ</span></div>' : '');
  body.querySelectorAll('[data-card-ok]').forEach((b) => { b.onclick = () => confirmPending(true); });
  body.querySelectorAll('[data-card-no]').forEach((b) => { b.onclick = () => confirmPending(false); });
  body.scrollTop = body.scrollHeight;
  $d('#aid-chips').hidden = busy || state.turns.length > 1;
}
function pushAssistant(a) {
  state.turns.push({ role: 'assistant', content: a.say || '…', detail: a.detail || '' });
}

// ── Thẻ xác nhận ──
const catName = (type, id) => (cats?.[type === 'income' ? 'income' : 'expense'] || []).find((c) => c.id === id)?.name || id || '—';
const pmName = (id) => (cats?.paymentMethods || []).find((p) => p.id === id)?.name || (id || '—');
const prName = (id) => (cats?.priorities || []).find((p) => p.id === id)?.name || '';
function txLines(t) {
  const isTr = t.type === 'transfer';
  return [
    ['Loại', t.type === 'income' ? 'Thu' : isTr ? 'Chuyển khoản' : 'Chi'],
    ['Ngày', formatDateVn(t.date)],
    isTr ? ['Từ', pmName(t.fromPayment)] : ['Danh mục', catName(t.type, t.category)],
    isTr ? ['Đến', pmName(t.toPayment)] : ['Thanh toán', pmName(t.paymentMethod)],
    ['Số tiền', formatVnd(t.amount)],
    t.type === 'expense' && t.priority ? ['Mức độ', prName(t.priority)] : null,
    ['Ghi chú', t.note || '—'],
  ].filter(Boolean);
}
function cardHtml(c, i) {
  const title = { create: 'Thêm giao dịch', update: 'Sửa giao dịch', delete: 'Xoá giao dịch' }[c.action];
  let rows;
  if (c.action === 'update') {
    const a = txLines(c.before);
    rows = txLines(c.tx).map(([k, v]) => {
      const old = a.find(([k2]) => k2 === k)?.[1];
      return `<div><span>${k}</span><b>${old !== undefined && old !== v ? `<s>${esc(old)}</s> → ` : ''}${esc(v)}</b></div>`;
    }).join('');
  } else rows = txLines(c.action === 'delete' ? c.before : c.tx).map(([k, v]) => `<div><span>${k}</span><b>${esc(v)}</b></div>`).join('');
  const live = state.pending && state.pending.idx === i;
  const st = { done: ' · ✓ xong', cancel: ' · đã huỷ', error: ' · lỗi' }[c.status] || '';
  return `<div class="aid-card ${c.action} ${c.status || ''}"><div class="aid-card-h">${title}${st}</div>
    <div class="detail-list">${rows}</div>
    ${live ? `<div class="aid-card-a"><button type="button" class="btn btn-secondary btn-sm" data-card-no>Không</button>
      <button type="button" class="btn ${c.action === 'delete' ? 'btn-danger' : 'btn-primary'} btn-sm" data-card-ok>${c.action === 'delete' ? 'Xoá' : 'Lưu'}</button></div>` : ''}</div>`;
}

// Kiểm dữ liệu AI đề xuất trước khi cho xác nhận — AI đoán sai id/danh mục thì chặn ở đây
async function findTx(id) {
  for (let k = 0; k < 4; k++) {
    const mk = shiftMonthKey(currentMonthKey(), -k);
    const { transactions } = await loadTransactions(mk);
    const t = transactions.find((x) => x.id === id);
    if (t) return { t, mk };
  }
  return null;
}
function normalize(d, base = {}) {
  const t = { ...base, ...Object.fromEntries(Object.entries(d || {}).filter(([, v]) => v !== null && v !== '' && v !== undefined)) };
  const type = ['income', 'expense', 'transfer'].includes(t.type) ? t.type : 'expense';
  const out = { type, date: /^\d{4}-\d{2}-\d{2}$/.test(t.date || '') ? t.date : todayDateStr(), amount: Math.round(Number(t.amount) || 0), note: (t.note || '').trim() };
  const pmOk = (id) => (cats.paymentMethods || []).some((p) => p.id === id);
  if (type === 'transfer') {
    Object.assign(out, { fromPayment: t.fromPayment, toPayment: t.toPayment });
    if (!pmOk(out.fromPayment) || !pmOk(out.toPayment) || out.fromPayment === out.toPayment) return { err: 'chưa rõ chuyển từ tài khoản nào sang tài khoản nào' };
  } else {
    const list = type === 'income' ? cats.income : cats.expense;
    if (!list.some((c) => c.id === t.category)) return { err: 'chưa rõ danh mục' };
    Object.assign(out, { category: t.category, paymentMethod: pmOk(t.paymentMethod) ? t.paymentMethod : null });
    if (type === 'expense') out.priority = (cats.priorities || []).some((p) => p.id === t.priority) ? t.priority : 'nice';
  }
  if (!(out.amount > 0)) return { err: 'chưa rõ số tiền' };
  return { tx: out };
}

async function buildCard(a) {
  cats ||= (await loadCategories()).categories;
  const d = a.draft || {};
  if (a.intent === 'create') {
    const r = normalize(d);
    return r.err ? { err: r.err } : { role: 'card', action: 'create', tx: r.tx };
  }
  if (!d.id) return { err: 'chưa xác định được giao dịch nào' };
  const f = await findTx(d.id);
  if (!f) return { err: 'không tìm thấy giao dịch đó trong 4 tháng gần nhất' };
  if (a.intent === 'delete') return { role: 'card', action: 'delete', id: d.id, month: f.mk, before: f.t };
  const { id, ...rest } = d;
  const r = normalize(rest, f.t);
  return r.err ? { err: r.err } : { role: 'card', action: 'update', id: d.id, month: f.mk, before: f.t, tx: r.tx };
}

async function confirmPending(yes) {
  const p = state.pending; if (!p || busy) return;
  const card = state.turns[p.idx];
  state.pending = null;
  if (!yes) {
    card.status = 'cancel'; save(); draw();
    return handleUserText('Không, chưa đúng. Hỏi mình cần sửa gì.', false, true);
  }
  try {
    if (card.action === 'create') await addTransaction(card.tx.date.slice(0, 7), { id: genId(), ...card.tx });
    else if (card.action === 'delete') await deleteTransaction(card.month, card.id);
    else if (card.tx.date.slice(0, 7) !== card.month) {   // đổi sang tháng khác: xoá cũ, thêm mới (giữ id)
      await deleteTransaction(card.month, card.id);
      await addTransaction(card.tx.date.slice(0, 7), { ...card.before, ...card.tx, id: card.id });
    } else await updateTransaction(card.month, card.id, card.tx);
    card.status = 'done';
    const msg = { create: 'Đã lưu.', update: 'Đã cập nhật.', delete: 'Đã xoá.' }[card.action] + ' Còn gì nữa không?';
    state.turns.push({ role: 'assistant', content: msg });
    save(); draw();
    window.dispatchEvent(new CustomEvent('finance:changed'));   // trang đang mở tự tải lại số liệu
    await speak(msg);
    if (handsFree) listenTurn();
  } catch (e) {
    card.status = 'error';
    state.turns.push({ role: 'sys', content: '⚠ Không lưu được: ' + e.message });
    save(); draw();
  }
}

// ── Một lượt hội thoại ──
async function handleUserText(text, fromVoice, silentUser = false) {
  text = (text || '').trim();
  if (busy || !text || !AI_AVAILABLE) return;
  if (fromVoice) handsFree = true;
  const input = $d('#aid-in'); input.value = ''; autoGrow(input);
  // Đang chờ xác nhận: câu ngắn có/không thì xử lý luôn, không cần hỏi AI
  if (state.pending && !silentUser) {
    const short = text.split(/\s+/).length <= 4;
    if (short && NO.test(text)) { state.turns.push({ role: 'user', content: text }); return confirmPending(false); }
    if (short && YES.test(text)) { state.turns.push({ role: 'user', content: text }); return confirmPending(true); }
    state.turns[state.pending.idx].status = 'cancel'; state.pending = null;   // nói điều khác = muốn sửa → bỏ thẻ cũ
  }
  if (!silentUser) state.turns.push({ role: 'user', content: text });
  busy = true; save(); draw();
  const history = state.turns.filter((t) => t.role === 'user' || t.role === 'assistant')
    .map((t) => ({ role: t.role, content: t.content }));
  if (!silentUser) history.pop();   // câu vừa nói gửi riêng ở "text"
  let a;
  try {
    const r = await aiCall({ mode: 'agent', text, history, page: ctx.page });
    a = r.agent || { say: '…' }; state.left = r.left;
  } catch (e) { a = { say: 'Lỗi: ' + e.message, intent: 'chat' }; }
  busy = false;
  pushAssistant(a);
  if (a.ready && ['create', 'update', 'delete'].includes(a.intent)) {
    const card = await buildCard(a).catch((e) => ({ err: e.message }));
    if (card?.err) {
      const q = `Mình ${card.err} — bạn nói rõ giúp mình nhé.`;
      state.turns.push({ role: 'assistant', content: q }); a.say = q;
    } else if (card) {
      state.turns.push(card);
      state.pending = { idx: state.turns.length - 1 };
    }
  }
  save(); draw();
  await speak(a.say);
  if (handsFree && state.open) listenTurn();
}

function autoGrow(t) { t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 140) + 'px'; }

export function initAiDrawer() {
  fab = document.createElement('button');
  fab.type = 'button'; fab.className = 'ai-fab'; fab.setAttribute('aria-label', 'Mở trợ lý AI');
  fab.innerHTML = `${svg('spark')}<span>Trợ lý AI</span>`;
  fab.onclick = () => openAi();

  el = document.createElement('aside');
  el.className = 'ai-drawer'; el.hidden = true;
  el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Trợ lý AI');
  el.innerHTML = `
    <header class="aid-head">
      <span class="aid-badge">${svg('spark')}</span>
      <div class="aid-title"><b>Trợ lý AI</b><span id="aid-ctx"></span></div>
      <button type="button" class="icon-btn" id="aid-voice" aria-label="Bật/tắt đọc to"></button>
      <button type="button" class="icon-btn" id="aid-review" title="Nhận xét tháng này" aria-label="Nhận xét tháng này">${svg('pie')}</button>
      <button type="button" class="icon-btn" id="aid-clear" title="Cuộc trò chuyện mới" aria-label="Cuộc trò chuyện mới">${svg('trash')}</button>
      <button type="button" class="icon-btn" id="aid-close" aria-label="Đóng trợ lý">${svg('x')}</button>
    </header>
    <div class="aid-body" id="aid-body"></div>
    <div class="aid-chips" id="aid-chips"></div>
    <form class="aid-form" id="aid-form">
      <textarea id="aid-in" rows="1" placeholder="Nói hoặc gõ: thêm, sửa, xoá, hỏi…" aria-label="Câu nói"></textarea>
      <button type="button" class="icon-btn aid-mic" id="aid-mic" aria-label="Nói" aria-pressed="false">${svg('mic')}</button>
      <button class="aid-send" aria-label="Gửi">${svg('send')}</button>
    </form>
    <div class="aid-foot small muted"><span id="aid-left"></span><span>Enter gửi · Esc đóng · ⌘/Ctrl+J mở</span></div>`;
  document.body.append(el, fab);

  const input = $d('#aid-in');
  $d('#aid-close').onclick = closeAi;
  $d('#aid-clear').onclick = () => { if (busy) return; state.turns = []; state.pending = null; handsFree = false; save(); openAi(); };
  $d('#aid-review').onclick = async () => {
    if (busy) return;
    state.turns.push({ role: 'user', content: '📊 Nhận xét tháng này' }); busy = true; save(); draw();
    try { const r = await aiCall({ mode: 'review', text: '' }); state.turns.push({ role: 'assistant', content: r.text }); state.left = r.left; }
    catch (e) { state.turns.push({ role: 'sys', content: '⚠ ' + e.message }); }
    busy = false; save(); draw();
  };
  $d('#aid-voice').onclick = () => {
    voiceOn = !voiceOn; try { localStorage.setItem(VOICE_KEY, voiceOn ? '1' : '0'); } catch {}
    if (!voiceOn && 'speechSynthesis' in window) speechSynthesis.cancel();
    drawHead();
  };
  const sendTyped = () => { handsFree = false; handleUserText(input.value, false); };
  $d('#aid-form').onsubmit = (e) => { e.preventDefault(); sendTyped(); };
  input.addEventListener('input', () => autoGrow(input));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendTyped(); } });
  $d('#aid-mic').onclick = () => { if ('speechSynthesis' in window) speechSynthesis.cancel(); handsFree = true; listenTurn(); };
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.open && !document.querySelector('.sheet.open, .pwa-bd')) closeAi();
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') { e.preventDefault(); toggleAi(); }
  });
  drawChips();
  if (new URLSearchParams(location.search).get('ai') === '1') state.open = true;
  if (state.open) {
    el.hidden = false; el.classList.add('open', 'no-anim'); document.body.classList.add('ai-open'); fab.hidden = true; draw();
    setTimeout(() => el.classList.remove('no-anim'), 50);
  }
}
