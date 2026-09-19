import { renderNav, icon } from './nav.js';
import { aiCall, AI_AVAILABLE, md, esc, listen } from './ai-client.js';
import { hydrateIcons } from './ui.js';

renderNav('ai');
hydrateIcons();
document.getElementById('mic').innerHTML = icon('mic');
const chat = document.getElementById('chat');
const turns = [];
let busy = false;
const CHIPS = ['Tháng này chi vượt ngân sách ở đâu?', 'So sánh chi tiêu 3 tháng gần nhất', 'Muốn tiết kiệm thêm 3 triệu/tháng thì cắt ở đâu?',
  'Có khoản chi nào bất thường không?', 'Dự báo cuối tháng còn dư bao nhiêu?', 'Chi ăn uống (sáng/chiều + chợ) tháng này thế nào?'];

function draw() {
  if (!AI_AVAILABLE) {
    chat.innerHTML = '<div class="empty">Trợ lý AI chỉ có ở bản mới: <a href="https://taichinh.dichvunamtrung.com/ai.html">taichinh.dichvunamtrung.com</a></div>';
    return;
  }
  chat.innerHTML = (turns.length ? turns.map((t) => `<div class="ai-msg ${t.role}">${t.role === 'user' ? esc(t.content) : md(t.content)}</div>`).join('')
    : '<div class="empty"><div class="big">✨</div><b>Hỏi gì về tiền nhà mình cũng được</b><br><span class="small">Chọn câu gợi ý bên dưới hoặc tự gõ / bấm micro để nói.</span></div>')
    + (busy ? '<div class="ai-msg assistant muted"><span class="thinking">Đang đọc sổ và suy nghĩ (15–60 giây)</span></div>' : '');
  chat.scrollTop = chat.scrollHeight;
}

async function run(mode, text) {
  if (!AI_AVAILABLE || busy) return;
  turns.push({ role: 'user', content: mode === 'chat' ? text : '📊 Nhận xét tháng này' });
  busy = true; draw();
  try {
    const r = await aiCall({ mode, text, history: turns.slice(0, -1) });
    turns.push({ role: 'assistant', content: r.text });
    document.getElementById('left').textContent = `Còn ${r.left} lượt hôm nay`;
  } catch (e) { turns.push({ role: 'assistant', content: '⚠ ' + e.message }); }
  busy = false; draw();
}

document.getElementById('chips').innerHTML = CHIPS.map((c) => `<button type="button" class="chip">${esc(c)}</button>`).join('');
document.querySelectorAll('#chips .chip').forEach((b) => { b.onclick = () => run('chat', b.textContent); });
document.getElementById('btn-review').onclick = () => run('review', '');
document.getElementById('ask-form').onsubmit = (e) => { e.preventDefault(); const v = document.getElementById('ask').value.trim(); if (v) { document.getElementById('ask').value = ''; run('chat', v); } };
document.getElementById('ask').onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); document.getElementById('ask-form').requestSubmit(); } };
document.getElementById('mic').onclick = () => listen((t) => { document.getElementById('ask').value = t; });
draw();
