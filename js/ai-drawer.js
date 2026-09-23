// Trợ lý AI — nút nổi ở MỌI trang, 2 chế độ:
//  🎙 GIAO TIẾP: mic mở suốt, ngừng nói ~1,5s là tự gửi, AI đọc to rồi tự nghe tiếp; im lặng 8s → tự hỏi lại
//     kèm thông tin đã có; 2 lần không đáp → tạm dừng. Nói "lưu/ok" là tự ghi; im lặng thì KHÔNG BAO GIỜ tự lưu.
//  💬 CHAT: gõ (hoặc đọc chính tả vào ô), bấm Gửi; không đọc to.
// 📷 Gửi ảnh hoá đơn/chuyển khoản (nút ảnh, dán Ctrl+V, kéo thả): AI đọc ra 1 hoặc nhiều giao dịch → thẻ xác nhận.
// Làm được: TẠO / SỬA / XOÁ giao dịch và TRA CỨU. AI chỉ ĐỀ XUẤT (JSON) → app kiểm dữ liệu + thẻ xác nhận
// → chỉ khi người dùng đồng ý APP mới ghi (cùng đường ghi như form → mỗi lần = 1 commit git).
import { aiCall, AI_AVAILABLE, md, esc, listen, shrinkImage } from './ai-client.js';
import { createVoiceLoop } from './voice.js';
import {
  loadCategories, loadTransactions, addTransaction, updateTransaction, deleteTransaction, genId,
  formatVnd, formatDateVn, todayDateStr, currentMonthKey, shiftMonthKey,
} from './store.js';

const KEY = 'ai-drawer';
const MODE_KEY = 'ai-mode';
const SILENCE_REPROMPT_MS = 8000;
const MAX_IMAGES = 4;
const MAX_REPROMPTS = 2;
const DEFAULT_CHIPS = ['Thêm giao dịch mới', 'Tháng này chi tiền chợ bao nhiêu?', 'Sửa giao dịch gần nhất', 'Xoá một giao dịch'];
const I = {
  spark: '<path d="M12 3l1.8 4.9L19 9.7l-5.2 1.8L12 16.5l-1.8-5L5 9.7l5.2-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  send: '<path d="M22 2 11 13M22 2l-7 20-4-9-9-4z"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 15h10l1-15"/>',
  pie: '<path d="M21 12A9 9 0 1 1 12 3v9z"/><path d="M15 3.5A9 9 0 0 1 20.5 9H15z"/>',
  chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  wave: '<path d="M2 12h2M6 8v8M10 5v14M14 8v8M18 10v4M22 12h0"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>',
  pause: '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>',
};
const svg = (n) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${I[n]}</svg>`;

let state = load();
let ctx = { page: '', label: '', chips: DEFAULT_CHIPS };
let busy = false;
let el, fab, cats = null, voice = null;
let mode = (() => { try { return localStorage.getItem(MODE_KEY) || 'voice'; } catch { return 'voice'; } })();
let vState = 'idle';             // idle | listening | thinking | speaking | paused
let silenceTimer = null, reprompts = 0;
let lastAgent = null;            // câu trả lời AI gần nhất — để nhắc lại thông tin đã có khi người dùng im lặng
let attach = [];                 // ảnh chờ gửi: {ext, b64, thumb} — không lưu sessionStorage (quá nặng)

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

// ── Giọng đọc ──
function viVoice() { return speechSynthesis.getVoices().find((v) => /^vi/i.test(v.lang)) || null; }
function speak(text) {
  return new Promise((resolve) => {
    if (mode !== 'voice' || !('speechSynthesis' in window) || !text) return resolve();
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(String(text).replace(/[*_#`>|]/g, '').slice(0, 400));
    u.lang = 'vi-VN'; const v = viVoice(); if (v) u.voice = v;
    u.rate = 1.05;
    let done = false; const fin = () => { if (!done) { done = true; resolve(); } };
    u.onend = u.onerror = fin;
    speechSynthesis.speak(u);
    setTimeout(fin, 3000 + text.length * 90);   // phòng trình duyệt không gọi onend
  });
}

// ── Vòng giao tiếp giọng nói ──
function setV(s, note) {
  vState = s;
  if (!el) return;
  const orb = $d('#aid-orb'), lbl = $d('#aid-vlabel');
  orb.className = `aid-orb ${s}`;
  orb.innerHTML = svg(s === 'listening' ? 'wave' : s === 'paused' || s === 'idle' ? 'mic' : s === 'speaking' ? 'spark' : 'spark');
  lbl.textContent = note || {
    idle: 'Chạm để bắt đầu nói', listening: 'Đang nghe… nói xong ngừng 1 chút là mình hiểu',
    thinking: 'Đang nghĩ…', speaking: 'Đang nói…', paused: 'Đã tạm dừng — chạm để nói tiếp',
  }[s];
}
async function say(text, { record = true } = {}) {
  if (record) { state.turns.push({ role: 'assistant', content: text }); save(); draw(); }
  if (mode !== 'voice') return;
  voice?.mute(true); setV('speaking');
  await speak(text);
  await new Promise((r) => setTimeout(r, 350));   // chờ dư âm loa tắt hẳn rồi mới nghe
  if (mode === 'voice' && state.open && voice?.active) { voice.mute(false); setV('listening'); armSilence(); }
}
function armSilence() {
  clearTimeout(silenceTimer);
  if (mode !== 'voice' || !state.open) return;
  silenceTimer = setTimeout(onSilence, SILENCE_REPROMPT_MS);
}
async function onSilence() {
  if (busy || vState !== 'listening') return;
  if (reprompts >= MAX_REPROMPTS) {
    voice?.stop(); setV('paused');
    state.turns.push({ role: 'sys', content: 'Mình tạm dừng vì không nghe thấy gì. Chạm quả cầu để nói tiếp.' }); save(); draw();
    return;
  }
  reprompts++;
  // Nhắc lại y hệt câu trước thì chỉ ĐỌC, không ghi thêm dòng chat (bản cũ để lại 2-3 câu chào trùng nhau)
  const t = repromptText();
  const last = [...state.turns].reverse().find((x) => x.role === 'assistant');
  await say(t, { record: !(last && last.content === t) });
}
// Nhắc lại những gì đã có + hỏi cái còn thiếu — không tốn lượt AI
function repromptText() {
  if (state.pending) {
    const c = state.turns[state.pending.idx];
    const verb = c.action === 'delete' ? 'xoá' : 'lưu';
    return `Mình đang chờ bạn xác nhận ${verb} ${cardSummary(c)}. Nói "${verb}" để ${verb}, hoặc "không" để sửa.`;
  }
  const d = lastAgent?.draft;
  if (d && ['create', 'update'].includes(lastAgent.intent)) {
    const known = [
      d.amount ? `${formatVnd(d.amount)}` : '',
      d.category ? catName(d.type, d.category) : '',
      d.paymentMethod ? `trả bằng ${pmName(d.paymentMethod)}` : '',
      d.date ? `ngày ${formatDateVn(d.date)}` : '',
      d.note || '',
    ].filter(Boolean).join(', ');
    const q = (lastAgent.say || '').split(/(?<=[.!?])\s+/).filter((s) => s.includes('?')).pop() || 'Bạn bổ sung giúp mình nhé?';
    return known ? `Mình đang có: ${known}. ${q}` : q;
  }
  return 'Bạn cần mình giúp gì? Ví dụ: thêm giao dịch, sửa, xoá, hoặc hỏi số liệu.';
}
function startVoice() {                 // PHẢI gọi trong thao tác bấm (cử chỉ người dùng)
  if (!voice) {
    voice = createVoiceLoop({
      onUtterance: (t) => { clearTimeout(silenceTimer); reprompts = 0; $d('#aid-live').textContent = ''; handleUserText(t); },
      onInterim: (t) => { clearTimeout(silenceTimer); $d('#aid-live').textContent = t; },
      onState: (s, err) => {
        if (s === 'error') { setV('paused', err === 'not-allowed' ? 'Chưa cho phép micro — bấm ổ khoá cạnh thanh địa chỉ để cho phép' : 'Micro lỗi: ' + err); }
        else if (s === 'paused') setV('paused', 'Máy tạm tắt mic — chạm để nói tiếp');
        else if (s === 'listening' && vState !== 'speaking' && vState !== 'thinking') setV('listening');
      },
    });
    if (!voice) { setMode('chat'); state.turns.push({ role: 'sys', content: 'Trình duyệt này chưa hỗ trợ nhận giọng nói — dùng chế độ Chat.' }); draw(); return false; }
  }
  voice.start();
  return true;
}

// ── Mở / đóng / đổi chế độ ──
export function openAi(ask) {
  if (!el) return;
  state.open = true; save();
  el.hidden = false;
  void el.offsetWidth; // ép vẽ trạng thái đóng trước để hiệu ứng trượt chạy (rAF bị hoãn khi tab chạy nền)
  el.classList.add('open'); document.body.classList.add('ai-open');
  fab.hidden = true;
  applyMode(); draw();
  if (ask) return handleUserText(ask);
  if (mode === 'voice' && AI_AVAILABLE) {
    reprompts = 0;
    if (startVoice()) {
      voice.mute(true);
      say(state.turns.length ? 'Mình nghe đây.' : `Chào ${greetName()}, mình giúp gì? Bạn có thể nói: thêm giao dịch, sửa, xoá, hoặc hỏi số liệu.`,
        { record: !state.turns.length });
    }
  } else setTimeout(() => $d('#aid-in')?.focus({ preventScroll: true }), 220);
}
export function closeAi() {
  state.open = false; save();
  clearTimeout(silenceTimer); voice?.stop(); setV('idle');
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  el.classList.remove('open'); document.body.classList.remove('ai-open');
  fab.hidden = false;
  setTimeout(() => { if (!state.open) el.hidden = true; }, 220);
}
export const toggleAi = () => (state.open ? closeAi() : openAi());
function setMode(m) {
  mode = m; try { localStorage.setItem(MODE_KEY, m); } catch {}
  applyMode();
}
function applyMode() {
  el.classList.toggle('mode-voice', mode === 'voice');
  el.classList.toggle('mode-chat', mode === 'chat');
  el.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  if (mode === 'chat') { clearTimeout(silenceTimer); voice?.stop(); if ('speechSynthesis' in window) speechSynthesis.cancel(); setV('idle'); }
}
let me = '';
fetch('/api/me').then((r) => (r.ok ? r.json() : null)).then((j) => { me = j?.email || ''; }).catch(() => {});
const greetName = () => ({ 'trung.caolenam@gmail.com': 'Trung', 'lephuc1702@gmail.com': 'Phúc' }[me] || 'bạn');

// ── Vẽ ──
function drawHead() {
  $d('#aid-ctx').textContent = ctx.label ? `Đang xem: ${ctx.label}` : 'Thêm · sửa · xoá · tra cứu';
  if (state.left != null) $d('#aid-left').textContent = `Còn ${state.left} lượt hôm nay`;
}
function drawChips() {
  const box = $d('#aid-chips');
  box.innerHTML = ctx.chips.map((c) => `<button type="button" class="chip">${esc(c)}</button>`).join('');
  box.querySelectorAll('.chip').forEach((b) => { b.onclick = () => handleUserText(b.textContent); });
}
function turnHtml(t, i) {
  if (t.role === 'user') return `<div class="ai-msg user">${t.thumbs?.length ? `<div class="aid-uimgs">${t.thumbs.map((b) => `<img src="data:image/jpeg;base64,${b}" alt="ảnh đã gửi">`).join('')}</div>` : ''}${t.content ? esc(t.content) : ''}</div>`;
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
        <p>"Thêm khoản ăn phở 50 nghìn", "sửa khoản bò kho hôm qua thành 75 nghìn", "xoá khoản cà phê", "tháng này tiền chợ bao nhiêu?". Mọi thay đổi đều hỏi bạn trước khi lưu.</p></div>`)
    + (busy ? '<div class="ai-msg assistant muted"><span class="thinking">Đang nghĩ</span></div>' : '');
  body.querySelectorAll('[data-card-ok]').forEach((b) => { b.onclick = () => confirmPending(true); });
  body.querySelectorAll('[data-card-no]').forEach((b) => { b.onclick = () => confirmPending(false); });
  body.querySelectorAll('input[data-bi]').forEach((cb) => {
    cb.onchange = () => { const c = state.turns[state.pending?.idx]; if (!c || c.action !== 'batch') return; c.sel[+cb.dataset.bi] = cb.checked; save(); draw(); };
  });
  body.scrollTop = body.scrollHeight;
  $d('#aid-chips').hidden = busy || state.turns.length > 1;
}

// ── Thẻ xác nhận ──
const catName = (type, id) => (cats?.[type === 'income' ? 'income' : 'expense'] || []).find((c) => c.id === id)?.name || id || '—';
const pmName = (id) => (cats?.paymentMethods || []).find((p) => p.id === id)?.name || (id || '—');
const prName = (id) => (cats?.priorities || []).find((p) => p.id === id)?.name || '';
function cardSummary(c) {
  if (c.action === 'batch') {
    const sel = c.items.filter((it, i) => it.tx && c.sel[i]);
    return `${sel.length} khoản, tổng ${formatVnd(sel.reduce((s, it) => s + it.tx.amount, 0))}`;
  }
  const t = c.action === 'delete' ? c.before : c.tx;
  return `${t.type === 'income' ? 'khoản thu' : 'khoản chi'} ${formatVnd(t.amount)}${t.category ? ', ' + catName(t.type, t.category) : ''}${t.note ? ', ' + t.note : ''}`;
}
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
function batchHtml(c, i) {
  const live = state.pending && state.pending.idx === i;
  const st = { done: ' · ✓ xong', cancel: ' · đã huỷ', error: ' · lỗi', partial: ' · lưu dở' }[c.status] || '';
  const n = c.items.filter((it, k) => it.tx && c.sel[k]).length;
  const rows = c.items.map((it, k) => {
    const t = it.tx || it.raw || {};
    const label = it.tx ? (t.type === 'transfer' ? `${pmName(t.fromPayment)} → ${pmName(t.toPayment)}` : catName(t.type, t.category)) : `⚠ ${it.err}`;
    const sub = [t.date ? formatDateVn(t.date) : '', it.tx && t.type !== 'transfer' ? pmName(t.paymentMethod) : '', t.note || ''].filter(Boolean).join(' · ');
    const sign = t.type === 'income' ? '+' : t.type === 'transfer' ? '' : '−';
    return `<label class="aid-brow ${it.tx ? '' : 'bad'} ${it.saved ? 'saved' : ''}">
      <input type="checkbox" data-bi="${k}" ${it.tx && c.sel[k] ? 'checked' : ''} ${it.tx && live ? '' : 'disabled'}>
      <span class="aid-binfo"><b>${esc(label)}</b><span>${esc(sub)}</span></span>
      <span class="aid-bamt ${t.type || ''}">${it.saved ? '✓ ' : ''}${sign}${formatVnd(Math.round(Number(t.amount) || 0))}</span></label>`;
  }).join('');
  return `<div class="aid-card create ${c.status || ''}"><div class="aid-card-h">Thêm ${c.items.length} giao dịch từ ảnh${st}</div>
    <div class="aid-blist">${rows}</div>
    ${live ? `<div class="aid-card-a"><span class="small muted">Bỏ tick khoản không muốn lưu · nói "lưu" hoặc "không"</span>
      <button type="button" class="btn btn-secondary btn-sm" data-card-no>Không</button>
      <button type="button" class="btn btn-primary btn-sm" data-card-ok ${n ? '' : 'disabled'}>Lưu ${n} khoản</button></div>` : ''}</div>`;
}
function cardHtml(c, i) {
  if (c.action === 'batch') return batchHtml(c, i);
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
    ${live ? `<div class="aid-card-a"><span class="small muted">Nói "${c.action === 'delete' ? 'xoá' : 'lưu'}" hoặc "không"</span>
      <button type="button" class="btn btn-secondary btn-sm" data-card-no>Không</button>
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
  if (a.intent === 'create' && Array.isArray(a.items) && a.items.length > 1) {
    const items = a.items.map((raw) => { const r = normalize(raw); return r.err ? { err: r.err, raw } : { tx: r.tx }; });
    if (!items.some((it) => it.tx)) return { err: 'chưa đọc rõ được khoản nào trong ảnh' };
    return { role: 'card', action: 'batch', items, sel: items.map((it) => !!it.tx) };
  }
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
  state.pending = null; clearTimeout(silenceTimer);
  if (!yes) {
    card.status = 'cancel'; save(); draw();
    return handleUserText('Không, chưa đúng. Hỏi mình cần sửa gì.', true);
  }
  if (card.action === 'batch') return saveBatch(card);
  try {
    if (card.action === 'create') await addTransaction(card.tx.date.slice(0, 7), { id: genId(), ...card.tx });
    else if (card.action === 'delete') await deleteTransaction(card.month, card.id);
    else if (card.tx.date.slice(0, 7) !== card.month) {   // đổi sang tháng khác: xoá cũ, thêm mới (giữ id)
      await deleteTransaction(card.month, card.id);
      await addTransaction(card.tx.date.slice(0, 7), { ...card.before, ...card.tx, id: card.id });
    } else await updateTransaction(card.month, card.id, card.tx);
    card.status = 'done'; lastAgent = null;
    window.dispatchEvent(new CustomEvent('finance:changed'));   // trang đang mở tự tải lại số liệu
    await say({ create: 'Đã lưu.', update: 'Đã cập nhật.', delete: 'Đã xoá.' }[card.action] + ' Còn gì nữa không?');
  } catch (e) {
    card.status = 'error';
    state.turns.push({ role: 'sys', content: '⚠ Không lưu được: ' + e.message });
    save(); draw();
  }
}

async function saveBatch(card) {
  const pick = card.items.map((it, k) => ({ it, k })).filter(({ it, k }) => it.tx && card.sel[k] && !it.saved);
  if (!pick.length) { state.turns.push({ role: 'sys', content: 'Chưa chọn khoản nào để lưu.' }); state.pending = { idx: state.turns.indexOf(card) }; save(); draw(); return; }
  let ok = 0;
  try {
    for (const { it } of pick) {   // tuần tự: mỗi lần ghi đọc lại file mới nhất (1 commit/khoản), tránh xung đột sha
      await addTransaction(it.tx.date.slice(0, 7), { id: genId(), ...it.tx });
      it.saved = true; ok++; save(); draw();
    }
    card.status = 'done'; lastAgent = null;
  } catch (e) {
    card.status = 'partial';
    state.turns.push({ role: 'sys', content: `⚠ Đã lưu ${ok}/${pick.length} khoản, còn lại lỗi: ${e.message}` });
  }
  if (ok) window.dispatchEvent(new CustomEvent('finance:changed'));
  save(); draw();
  if (card.status === 'done') await say(`Đã lưu ${ok} khoản. Còn gì nữa không?`);
}

// ── Ảnh đính kèm ──
async function addFiles(files) {
  files = [...files].filter((f) => !f.type || f.type.startsWith('image/'));
  if (!files.length || busy) return;
  const room = MAX_IMAGES - attach.length;
  if (room <= 0) { flash(`Tối đa ${MAX_IMAGES} ảnh mỗi lần gửi.`); return; }
  if (files.length > room) flash(`Chỉ lấy ${room} ảnh đầu (tối đa ${MAX_IMAGES}).`);
  try {
    for (const f of files.slice(0, room)) {
      const [big, small] = await Promise.all([shrinkImage(f), shrinkImage(f, 240, 0.6)]);
      attach.push({ ...big, thumb: small.b64 });
    }
  } catch (e) { flash('⚠ Không đọc được ảnh: ' + e.message); }
  drawThumbs();
  if (!attach.length) return;
  if (mode === 'voice') return handleUserText('');           // giao tiếp: gửi luôn
  const input = $d('#aid-in'); input.placeholder = 'Ghi chú thêm (tuỳ chọn) rồi Gửi';
  input.focus({ preventScroll: true });
}
function drawThumbs() {
  const box = $d('#aid-thumbs');
  box.hidden = !attach.length;
  box.innerHTML = attach.map((im, i) => `<span class="aid-thumb"><img src="data:image/jpeg;base64,${im.thumb}" alt="ảnh ${i + 1}">
    <button type="button" data-rm="${i}" aria-label="Bỏ ảnh ${i + 1}">✕</button></span>`).join('')
    + (attach.length ? `<span class="small muted">${attach.length}/${MAX_IMAGES} ảnh</span>` : '');
  box.querySelectorAll('[data-rm]').forEach((b) => { b.onclick = () => { attach.splice(+b.dataset.rm, 1); drawThumbs(); }; });
  if (!attach.length) $d('#aid-in').placeholder = 'Gõ, hoặc gửi ảnh hoá đơn…';
}
function flash(t) { const f = $d('#aid-left'); f.textContent = t; setTimeout(() => { if (f.textContent === t) drawHead(); }, 4000); }

// ── Một lượt hội thoại ──
const YES = /^(có|co|ok|oke|okay|okie|okela|okla|ô kê|ừ|ừm|ừa|ờ|ờm|uh|uk|vâng|dạ|đồng ý|dong y|lưu|luu|lâu|ghi|nhập|chốt|xong|xoá|xóa|xoa|được|duoc|đc|dc|đúng|chuẩn|ổn|ngon|tốt|xác nhận|xac nhan|yes|yep|yeah|sure|chắc chắn|làm đi|làm luôn|cho vào|thêm đi|triển)/i;
const NO = /^(không|khong|ko|thôi|thoi|huỷ|hủy|huy|đừng|sai|no\b|chưa)/i;
// 23/09: nói bằng giọng hay lặp từ ("Lưu lưu đi lưu đi ok") hoặc đọc lại cả câu rồi thêm "ok" → bản cũ (≤4 từ + mở bằng
// từ đồng ý) coi là "muốn sửa", huỷ thẻ, hỏi lại AI → AI lại hỏi "Lưu nhé?" → lặp mãi.
const YES_WORDS = new Set(('có co ok oke okay okie okela okla ô kê ừ ừm ừa ờ ờm uh uk vâng dạ đồng ý dong y lưu luu ghi nhập '
  + 'chốt xong xoá xóa xoa được duoc đc dc đúng chuẩn ổn ngon tốt hợp lý xác nhận xac nhan yes yep yeah sure go chắc chắn làm đi '
  + 'luôn nhé nha nhá rồi rùi ạ á à đó đấy nhỉ vậy thế lại cho mình tôi em anh chị bạn ơi vào giúp giùm dùm hộ nào lâu lẹ '
  + 'nhanh ngay bố mẹ con triển khai').split(' '));
const EDIT = /(nhưng|đổi thành|đổi lại|đổi sang|sửa thành|sửa lại|không phải|chứ không|mà là|nhầm|thay vì|ghi chú|thêm khoản|còn khoản|khoản khác)/i;
const ASK_SAVE = /(lưu|ghi|cập nhật|thêm)[^?]{0,160}(nhé|nha|không|ko|chứ|ạ|hả|chưa)\s*\?\s*$/i;   // AI đang hỏi "…lưu nhé?"
const ENDS_YES = /(^| )(ok|oke|okay|okela|ok luôn|lưu|lưu đi|lưu luôn|lưu giùm|lưu dùm|lưu hộ|ghi đi|ghi giùm|ghi luôn|nhập đi|chốt|chốt đi|xong|đồng ý|được|được rồi|được đấy|đc|dc|ừ|vâng|đúng rồi|chuẩn|chuẩn rồi|xác nhận|yes|xoá đi|xóa đi)$/i;
// Đồng ý khi: không có từ phủ định/sửa, MỌI con số trong câu khớp số tiền hoặc ngày/tháng của thẻ (đọc lại "20.000" thì
// được, nói "30 nghìn" là muốn sửa), và (toàn từ đồng ý) hoặc (mở/kết bằng từ đồng ý).
function sameTx(x, y) {
  if (!x || !y) return false;
  const k = ['type', 'date', 'amount', 'category', 'paymentMethod', 'fromPayment', 'toPayment'];
  return k.every((f) => (x[f] ?? null) === (y[f] ?? null)) && (x.note || '').trim().toLowerCase() === (y.note || '').trim().toLowerCase();
}
export function isAffirm(text, amount, date) {
  const t = (text || '').toLowerCase().normalize('NFC').trim();
  const w = t.replace(/[.,!?…"'“”]/g, ' ').split(/\s+/).filter(Boolean);
  if (!w.length || NO.test(t) || EDIT.test(t)) return false;
  const day = date ? Number(String(date).slice(8, 10)) : null, month = date ? Number(String(date).slice(5, 7)) : null;
  const nums = (t.match(/\d[\d.,]*/g) || []).map((x) => Number(x.replace(/[.,]/g, ''))).filter((n) => n > 0);
  if (nums.some((n) => ![n, n * 1000, n * 1e6].includes(amount) && n !== day && n !== month)) return false;
  if (w.every((x) => YES_WORDS.has(x))) return w.length <= 12;
  return (YES.test(t) || ENDS_YES.test(w.slice(-2).join(' '))) && w.length <= 16;
}
async function handleUserText(text, hidden = false) {
  let prevCard = null;
  text = (text || '').trim();
  const imgs = hidden ? [] : attach;
  if (busy || (!text && !imgs.length) || !AI_AVAILABLE) return;
  clearTimeout(silenceTimer);
  const input = $d('#aid-in'); input.value = ''; autoGrow(input);
  // Đang chờ xác nhận: câu ngắn có/không → xử lý luôn (không tốn lượt AI)
  if (state.pending && !hidden && !imgs.length) {
    const short = text.split(/\s+/).length <= 4;
    const c = state.turns[state.pending.idx];
    if (short && NO.test(text)) { state.turns.push({ role: 'user', content: text }); return confirmPending(false); }
    if (isAffirm(text, c?.tx?.amount, c?.tx?.date)) { state.turns.push({ role: 'user', content: text }); return confirmPending(true); }
    // Câu chưa rõ → hỏi AI hiểu ý (vẫn nhớ thẻ đang chờ). AI hiểu là đồng ý thì lưu luôn thẻ này, không hỏi lại.
    prevCard = c; c.status = 'cancel'; state.pending = null;
  }
  // Lưới an toàn: AI đã đọc lại tóm tắt + hỏi "...nhé?" nhưng không thành thẻ (quên ready=true) mà người dùng đồng ý
  // → dựng thẻ từ draft đã có rồi lưu luôn, không hỏi AI thêm vòng nữa.
  // Chỉ khi câu AI ĐÚNG là câu hỏi lưu (không phải đang hỏi thông tin thiếu) và đã có phương thức thanh toán —
  // tránh "ok" cho câu "tiền mặt hay thẻ?" thành lưu khoản thiếu PTTT.
  if (!state.pending && !hidden && !imgs.length && lastAgent && ['create', 'update'].includes(lastAgent.intent)
      && ASK_SAVE.test(lastAgent.say || '') && (lastAgent.draft || lastAgent.items?.length)) {
    const d = lastAgent.draft || {};
    if (isAffirm(text, Math.round(Number(d.amount) || 0), d.date)) {
      cats ||= (await loadCategories().catch(() => ({ categories: null }))).categories;
      const card = cats && await buildCard({ ...lastAgent, ready: true }).catch(() => null);
      const pmOk = !card?.tx || card.tx.type === 'transfer' || card.tx.paymentMethod;
      if (card && !card.err && pmOk) {
        state.turns.push({ role: 'user', content: text }, card);
        state.pending = { idx: state.turns.length - 1 }; lastAgent = null;
        return confirmPending(true);
      }
    }
  }
  if (state.pending && imgs.length) { state.turns[state.pending.idx].status = 'cancel'; state.pending = null; }   // ảnh mới = việc mới
  if (!hidden) state.turns.push(imgs.length ? { role: 'user', content: text, thumbs: imgs.map((im) => im.thumb) } : { role: 'user', content: text });
  attach = []; drawThumbs();
  busy = true; voice?.mute(true); if (mode === 'voice') setV('thinking');
  save(); draw();
  cats ||= (await loadCategories().catch(() => ({ categories: null }))).categories;
  // memo = dữ liệu AI đã đọc (từ ảnh) ở lượt trước — lượt sau không gửi lại ảnh nên AI phải nhớ qua đây
  const history = state.turns.filter((t) => t.role === 'user' || t.role === 'assistant').map((t) => ({ role: t.role,
    content: (t.content || (t.thumbs ? '(gửi ảnh)' : '')) + (t.thumbs ? ` [kèm ${t.thumbs.length} ảnh]` : '') + (t.detail ? `\n${t.detail.slice(0, 500)}` : '') + (t.memo ? `\n[Dữ liệu đã đọc: ${t.memo}]` : '') }));
  if (!hidden) history.pop();   // câu vừa nói gửi riêng ở "text"
  let a;
  try {
    const r = await aiCall({ mode: 'agent', text, history, page: ctx.page, images: imgs.map(({ ext, b64 }) => ({ ext, b64 })) });
    a = r.agent || { say: '…' }; state.left = r.left;
  } catch (e) { a = { say: 'Lỗi: ' + e.message, intent: 'chat' }; }
  busy = false; lastAgent = a;
  if (a.intent === 'create' && !a.draft && Array.isArray(a.items) && a.items.length === 1) a.draft = a.items[0];
  const memoData = Array.isArray(a.items) && a.items.length > 1 ? a.items : a.draft;
  state.turns.push({ role: 'assistant', content: a.say || '…', detail: a.detail || '',
    ...(memoData && ['create', 'update'].includes(a.intent) ? { memo: JSON.stringify(memoData).slice(0, 1500) } : {}) });
  let spoken = a.say;
  // AI đôi khi hỏi "Lưu nhé?" nhưng quên đặt ready=true → draft đã đủ + đang hỏi xác nhận thì coi như ready
  // 23/09: regex cũ chỉ bắt "lưu nhé?" liền nhau — AI nói "Lưu khoản thu 2 triệu …, ghi chú Thủy nhé?" là trượt.
  if (!a.ready && ['create', 'update'].includes(a.intent) && cats && ASK_SAVE.test(a.say || '')) {
    const d = Array.isArray(a.items) && a.items.length > 1 ? null : a.draft;
    const r = d && normalize(d, {});
    if (r?.tx && (r.tx.type === 'transfer' || r.tx.paymentMethod)) a.ready = true;
  }
  // AI hiểu câu vừa rồi là ĐỒNG Ý với thẻ đang chờ (confirmed=true, hoặc trả lại y nguyên khoản đó) → lưu thẻ cũ luôn
  if (prevCard && a.ready && ['create', 'update', 'delete'].includes(a.intent) && cats) {
    const nc = a.confirmed ? null : await buildCard(a).catch(() => null);
    if (a.confirmed || sameTx(nc?.tx, prevCard.tx) || (a.intent === 'delete' && nc?.id && nc.id === prevCard.id)) {
      state.turns.pop();                                 // bỏ câu "…lưu nhé?" AI vừa hỏi lại
      delete prevCard.status; state.pending = { idx: state.turns.indexOf(prevCard) };
      return confirmPending(true);
    }
  }
  if (a.ready && ['create', 'update', 'delete'].includes(a.intent) && cats) {
    const card = await buildCard(a).catch((e) => ({ err: e.message }));
    if (card?.err) {
      spoken = `Mình ${card.err} — bạn nói rõ giúp mình nhé.`;
      state.turns.push({ role: 'assistant', content: spoken });
    } else if (card) {
      state.turns.push(card);
      state.pending = { idx: state.turns.length - 1 };
    }
  }
  save(); draw();
  await say(spoken, { record: false });
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
      <button type="button" class="icon-btn" id="aid-review" title="Nhận xét tháng này" aria-label="Nhận xét tháng này">${svg('pie')}</button>
      <button type="button" class="icon-btn" id="aid-clear" title="Cuộc trò chuyện mới" aria-label="Cuộc trò chuyện mới">${svg('trash')}</button>
      <button type="button" class="icon-btn" id="aid-close" aria-label="Đóng trợ lý">${svg('x')}</button>
    </header>
    <div class="aid-modes segmented" role="tablist" aria-label="Chế độ">
      <button type="button" data-mode="voice" role="tab">🎙 Giao tiếp</button>
      <button type="button" data-mode="chat" role="tab">💬 Chat</button>
    </div>
    <div class="aid-body" id="aid-body"></div>
    <div class="aid-chips" id="aid-chips"></div>
    <div class="aid-voice">
      <button type="button" class="aid-orb idle" id="aid-orb" aria-label="Bắt đầu / tạm dừng nói"></button>
      <div class="aid-vlabel" id="aid-vlabel"></div>
      <div class="aid-live" id="aid-live" aria-live="polite"></div>
      <button type="button" class="btn btn-secondary btn-sm aid-vimg" id="aid-img2">${svg('image')} Gửi ảnh hoá đơn</button>
    </div>
    <div class="aid-thumbs" id="aid-thumbs" hidden></div>
    <input type="file" id="aid-file" accept="image/*" multiple hidden>
    <form class="aid-form" id="aid-form">
      <textarea id="aid-in" rows="1" placeholder="Gõ, hoặc gửi ảnh hoá đơn…" aria-label="Câu hỏi"></textarea>
      <button type="button" class="icon-btn" id="aid-img" title="Gửi ảnh hoá đơn / chuyển khoản" aria-label="Gửi ảnh">${svg('image')}</button>
      <button type="button" class="icon-btn" id="aid-mic" aria-label="Đọc chính tả" aria-pressed="false">${svg('mic')}</button>
      <button class="aid-send" aria-label="Gửi">${svg('send')}</button>
    </form>
    <div class="aid-foot small muted"><span id="aid-left"></span><span>Esc đóng · ⌘/Ctrl+J mở</span></div>`;
  document.body.append(el, fab);

  const input = $d('#aid-in');
  $d('#aid-close').onclick = closeAi;
  $d('#aid-clear').onclick = () => {
    if (busy) return;
    state.turns = []; state.pending = null; lastAgent = null; reprompts = 0; attach = []; drawThumbs(); save(); draw();
    if (mode === 'voice') { startVoice(); voice?.mute(true); say(`Chào ${greetName()}, mình giúp gì?`); }
  };
  $d('#aid-review').onclick = async () => {
    if (busy) return;
    clearTimeout(silenceTimer); voice?.mute(true);
    state.turns.push({ role: 'user', content: '📊 Nhận xét tháng này' }); busy = true; save(); draw();
    try { const r = await aiCall({ mode: 'review', text: '' }); state.turns.push({ role: 'assistant', content: r.text }); state.left = r.left; }
    catch (e) { state.turns.push({ role: 'sys', content: '⚠ ' + e.message }); }
    busy = false; save(); draw();
    if (mode === 'voice' && voice?.active) await say('Mình đã viết nhận xét tháng này ở trên. Bạn muốn làm gì tiếp?', { record: false });
  };
  el.querySelectorAll('[data-mode]').forEach((b) => {
    b.onclick = () => {
      if (b.dataset.mode === mode) return;
      setMode(b.dataset.mode);
      if (mode === 'voice' && startVoice()) { voice.mute(true); say('Mình nghe đây.', { record: false }); }
      else setTimeout(() => input.focus(), 50);
    };
  });
  $d('#aid-orb').onclick = () => {        // chạm quả cầu: đang nghe → tạm dừng; đang dừng → nghe tiếp
    if (vState === 'listening') { clearTimeout(silenceTimer); voice?.stop(); setV('paused', 'Đã tạm dừng — chạm để nói tiếp'); return; }
    if (vState === 'speaking') { speechSynthesis.cancel(); return; }   // chạm khi đang nói = cắt lời
    reprompts = 0;
    if (startVoice()) { voice.mute(false); setV('listening'); armSilence(); }
  };
  const pick = () => { if (busy) return; if (mode === 'voice' && startVoice()) voice.mute(true); $d('#aid-file').click(); };
  $d('#aid-img').onclick = pick; $d('#aid-img2').onclick = pick;
  $d('#aid-file').onchange = (e) => { const f = [...e.target.files]; e.target.value = ''; addFiles(f); };
  input.addEventListener('paste', (e) => {            // dán ảnh chụp màn hình (Ctrl/⌘+V)
    const f = [...(e.clipboardData?.files || [])].filter((x) => x.type.startsWith('image/'));
    if (f.length) { e.preventDefault(); addFiles(f); }
  });
  el.addEventListener('dragover', (e) => { if ([...e.dataTransfer.items].some((x) => x.kind === 'file')) { e.preventDefault(); el.classList.add('drop'); } });
  el.addEventListener('dragleave', (e) => { if (!el.contains(e.relatedTarget)) el.classList.remove('drop'); });
  el.addEventListener('drop', (e) => { e.preventDefault(); el.classList.remove('drop'); addFiles(e.dataTransfer.files); });
  const sendTyped = () => handleUserText(input.value);
  $d('#aid-form').onsubmit = (e) => { e.preventDefault(); sendTyped(); };
  input.addEventListener('input', () => autoGrow(input));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendTyped(); } });
  $d('#aid-mic').onclick = () => listen((t) => { input.value = t; autoGrow(input); },
    { btn: $d('#aid-mic'), onStatus: (t) => { $d('#aid-left').textContent = t; } });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.open && !document.querySelector('.sheet.open, .pwa-bd')) closeAi();
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') { e.preventDefault(); toggleAi(); }
  });
  drawChips(); applyMode(); setV('idle');
  if (new URLSearchParams(location.search).get('ai') === '1') state.open = true;
  if (state.open) {   // mở sẵn từ trang trước: chưa có cử chỉ → chưa bật mic, chạm quả cầu để nói tiếp
    el.hidden = false; el.classList.add('open', 'no-anim'); document.body.classList.add('ai-open'); fab.hidden = true; draw();
    if (mode === 'voice') setV('paused', 'Chạm quả cầu để nói tiếp');
    setTimeout(() => el.classList.remove('no-anim'), 50);
  }
}
