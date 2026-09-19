// Trợ lý AI dạng nút nổi — mở ở MỌI trang, không rời trang đang xem.
// Máy tính: cột bên phải, trang tự co lại (vẫn nhìn thấy). Điện thoại: trượt lên toàn màn hình, đóng là về chỗ cũ.
// Hội thoại + trạng thái mở giữ trong sessionStorage nên chuyển trang không mất.
// Mỗi trang gọi setAiContext(mô tả màn hình, [gợi ý câu hỏi]) để AI hiểu "cái này/khoản này" là gì.
import { aiCall, AI_AVAILABLE, md, esc, listen } from './ai-client.js';

const KEY = 'ai-drawer';
const DEFAULT_CHIPS = ['Tháng này chi vượt ngân sách ở đâu?', 'Muốn tiết kiệm thêm 3 triệu/tháng thì cắt ở đâu?',
  'Dự báo cuối tháng còn dư bao nhiêu?', 'Có khoản chi nào bất thường không?'];
const I = {
  spark: '<path d="M12 3l1.8 4.9L19 9.7l-5.2 1.8L12 16.5l-1.8-5L5 9.7l5.2-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  send: '<path d="M22 2 11 13M22 2l-7 20-4-9-9-4z"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 15h10l1-15"/>',
  pie: '<path d="M21 12A9 9 0 1 1 12 3v9z"/><path d="M15 3.5A9 9 0 0 1 20.5 9H15z"/>',
};
const svg = (n) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${I[n]}</svg>`;

let state = load();
let ctx = { page: '', label: '', chips: DEFAULT_CHIPS };
let busy = false;
let el, fab;

function load() {
  try { return JSON.parse(sessionStorage.getItem(KEY)) || { open: false, turns: [], left: null }; } catch { return { open: false, turns: [], left: null }; }
}
function save() { try { sessionStorage.setItem(KEY, JSON.stringify({ ...state, turns: state.turns.slice(-30) })); } catch {} }

export function setAiContext(page, label, chips) {
  ctx = { page: page || '', label: label || ctx.label, chips: chips?.length ? chips : DEFAULT_CHIPS };
  if (el) drawHead(), drawChips();
}

export function openAi(ask) {
  if (!el) return;
  state.open = true; save();
  el.hidden = false;
  void el.offsetWidth; // ép trình duyệt vẽ trạng thái đóng trước, để hiệu ứng trượt chạy (rAF bị hoãn khi tab chạy nền)
  el.classList.add('open'); document.body.classList.add('ai-open');
  fab.hidden = true;
  draw();
  if (ask) send(ask);
  else setTimeout(() => el.querySelector('#aid-in')?.focus({ preventScroll: true }), 220);
}
export function closeAi() {
  state.open = false; save();
  el.classList.remove('open'); document.body.classList.remove('ai-open');
  fab.hidden = false;
  setTimeout(() => { if (!state.open) el.hidden = true; }, 220);
}
export const toggleAi = () => (state.open ? closeAi() : openAi());

function drawHead() {
  el.querySelector('#aid-ctx').textContent = ctx.label ? `Đang xem: ${ctx.label}` : 'Hỏi gì về tiền nhà mình cũng được';
  el.querySelector('#aid-left').textContent = state.left != null ? `Còn ${state.left} lượt hôm nay` : '';
}
function drawChips() {
  const box = el.querySelector('#aid-chips');
  box.innerHTML = ctx.chips.map((c) => `<button type="button" class="chip">${esc(c)}</button>`).join('');
  box.querySelectorAll('.chip').forEach((b) => { b.onclick = () => send(b.textContent); });
}
function draw() {
  drawHead();
  const body = el.querySelector('#aid-body');
  if (!AI_AVAILABLE) {
    body.innerHTML = '<div class="empty">Trợ lý AI chỉ có ở bản mới: <a href="https://taichinh.dichvunamtrung.com">taichinh.dichvunamtrung.com</a></div>';
    return;
  }
  body.innerHTML = (state.turns.length
    ? state.turns.map((t) => `<div class="ai-msg ${t.role}">${t.role === 'user' ? esc(t.content) : md(t.content)}</div>`).join('')
    : `<div class="aid-empty"><div class="aid-hello">${svg('spark')}</div><b>Trợ lý tài chính</b>
        <p>Đọc sổ thu chi thật 3 tháng gần nhất + màn hình bạn đang xem. Chỉ trả lời, không tự ghi gì vào sổ.</p></div>`)
    + (busy ? '<div class="ai-msg assistant muted"><span class="thinking">Đang đọc sổ và suy nghĩ (15–60 giây)</span></div>' : '');
  body.scrollTop = body.scrollHeight;
  el.querySelector('#aid-chips').hidden = busy || state.turns.length > 0;
}

async function send(text, mode = 'chat') {
  text = (text || '').trim();
  if (busy || (!text && mode === 'chat') || !AI_AVAILABLE) return;
  state.turns.push({ role: 'user', content: mode === 'review' ? '📊 Nhận xét tháng này' : text });
  busy = true; save(); draw();
  const input = el.querySelector('#aid-in'); input.value = ''; autoGrow(input);
  try {
    const r = await aiCall({ mode, text, history: state.turns.slice(0, -1), page: ctx.page });
    state.turns.push({ role: 'assistant', content: r.text });
    state.left = r.left;
  } catch (e) {
    state.turns.push({ role: 'assistant', content: '⚠ ' + e.message });
  }
  busy = false; save(); draw();
}

function autoGrow(t) { t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 140) + 'px'; }

export function initAiDrawer() {
  fab = document.createElement('button');
  fab.type = 'button'; fab.className = 'ai-fab'; fab.setAttribute('aria-label', 'Hỏi trợ lý AI');
  fab.innerHTML = `${svg('spark')}<span>Hỏi AI</span>`;
  fab.onclick = () => openAi();

  el = document.createElement('aside');
  el.className = 'ai-drawer'; el.hidden = true;
  el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Trợ lý AI');
  el.innerHTML = `
    <header class="aid-head">
      <span class="aid-badge">${svg('spark')}</span>
      <div class="aid-title"><b>Trợ lý AI</b><span id="aid-ctx"></span></div>
      <button type="button" class="icon-btn" id="aid-review" title="Nhận xét tháng này" aria-label="Nhận xét tháng này">${svg('pie')}</button>
      <button type="button" class="icon-btn" id="aid-clear" title="Cuộc trò chuyện mới" aria-label="Xoá hội thoại">${svg('trash')}</button>
      <button type="button" class="icon-btn" id="aid-close" aria-label="Đóng trợ lý">${svg('x')}</button>
    </header>
    <div class="aid-body" id="aid-body"></div>
    <div class="aid-chips" id="aid-chips"></div>
    <form class="aid-form" id="aid-form">
      <textarea id="aid-in" rows="1" placeholder="Hỏi về số liệu đang xem…" aria-label="Câu hỏi"></textarea>
      <button type="button" class="icon-btn" id="aid-mic" aria-label="Nói">${svg('mic')}</button>
      <button class="aid-send" aria-label="Gửi">${svg('send')}</button>
    </form>
    <div class="aid-foot small muted"><span id="aid-left"></span><span>Enter gửi · Shift+Enter xuống dòng · Esc đóng</span></div>`;
  document.body.append(el, fab);

  const input = el.querySelector('#aid-in');
  el.querySelector('#aid-close').onclick = closeAi;
  el.querySelector('#aid-clear').onclick = () => { if (busy) return; state.turns = []; save(); draw(); };
  el.querySelector('#aid-review').onclick = () => send('', 'review');
  el.querySelector('#aid-form').onsubmit = (e) => { e.preventDefault(); send(input.value); };
  input.addEventListener('input', () => autoGrow(input));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(input.value); } });
  el.querySelector('#aid-mic').onclick = () => listen((t) => { input.value = t; autoGrow(input); },
    { btn: el.querySelector('#aid-mic'), onStatus: (t) => { el.querySelector('#aid-left').textContent = t; } });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.open && !document.querySelector('.sheet.open, .pwa-bd')) closeAi();
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') { e.preventDefault(); toggleAi(); }  // Ctrl/⌘+J mở nhanh
  });
  drawChips();
  // Mở từ link cũ ai.html (?ai=1) hoặc đang mở dở từ trang trước
  if (new URLSearchParams(location.search).get('ai') === '1') state.open = true;
  if (state.open) { el.hidden = false; el.classList.add('open', 'no-anim'); document.body.classList.add('ai-open'); fab.hidden = true; draw();
    setTimeout(() => el.classList.remove('no-anim'), 50); }
}
