import { renderNav } from './nav.js';
import { aiCall, AI_AVAILABLE, md, esc, listen } from './ai-client.js';

renderNav('ai');
const chat = document.getElementById('chat');
const turns = [];
const CHIPS = ['Tháng này chi vượt ngân sách ở đâu?', 'So sánh chi tiêu 3 tháng gần nhất', 'Muốn tiết kiệm thêm 3 triệu/tháng thì cắt ở đâu?',
  'Có khoản chi nào bất thường không?', 'Dự báo cuối tháng còn dư bao nhiêu?', 'Chi ăn uống (sáng/chiều + chợ) tháng này thế nào?'];

if (!AI_AVAILABLE) {
  chat.innerHTML = '<p>Trợ lý AI chỉ có ở bản mới: <a href="https://taichinh.dichvunamtrung.com/ai.html">taichinh.dichvunamtrung.com</a></p>';
}

function draw(busy) {
  chat.innerHTML = turns.map((t) => `<div class="ai-msg ${t.role}">${t.role === 'user' ? esc(t.content) : md(t.content)}</div>`).join('')
    + (busy ? '<div class="ai-msg assistant muted">Đang đọc sổ và suy nghĩ… (thường 15–60 giây)</div>' : '');
  chat.scrollTop = chat.scrollHeight;
}

async function run(mode, text) {
  if (!AI_AVAILABLE) return;
  if (mode === 'chat') turns.push({ role: 'user', content: text });
  else turns.push({ role: 'user', content: '📊 Nhận xét tháng này' });
  draw(true);
  try {
    const r = await aiCall({ mode, text, history: turns.slice(0, -1) });
    turns.push({ role: 'assistant', content: r.text });
    document.getElementById('left').textContent = `Còn ${r.left} lượt AI hôm nay`;
  } catch (e) { turns.push({ role: 'assistant', content: '⚠ ' + e.message }); }
  draw(false);
}

document.getElementById('chips').innerHTML = CHIPS.map((c) => `<button type="button" class="chip">${esc(c)}</button>`).join('');
document.querySelectorAll('#chips .chip').forEach((b) => b.onclick = () => run('chat', b.textContent));
document.getElementById('btn-review').onclick = () => run('review', '');
document.getElementById('ask-form').onsubmit = (e) => { e.preventDefault(); const v = document.getElementById('ask').value.trim(); if (v) { document.getElementById('ask').value = ''; run('chat', v); } };
document.getElementById('ask').onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); document.getElementById('ask-form').requestSubmit(); } };
document.getElementById('mic').onclick = () => listen((t, fin) => { document.getElementById('ask').value = t; });
