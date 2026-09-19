// Gọi AI qua công việc nền rồi hỏi lại mỗi 3s (Cloudflare cắt request > 100s). Chỉ chạy ở bản local (taichinh).
import { IS_LOCAL } from './config.js';

export const AI_AVAILABLE = IS_LOCAL;

export async function aiCall(body) {
  const res = await fetch('/api/ai/job', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.detail || `Lỗi AI (${res.status})`);
  for (let i = 0; i < 200; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const r = await fetch(`/api/ai/job/${j.job}`);
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.detail || `Lỗi AI (${r.status})`);
    if (d.status === 'done') return { ...d, left: j.left };
  }
  throw new Error('AI chạy quá lâu, thử lại');
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Markdown tối giản (đã escape trước) cho câu trả lời của AI
export function md(src) {
  let html = '', list = false, table = null;
  const inline = (s) => s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');
  const flushTable = () => { if (!table) return; html += '<div class="ai-table"><table>' + table.map((r, i) => '<tr>' + r.map((c) => (i ? '<td>' : '<th>') + inline(c) + (i ? '</td>' : '</th>')).join('') + '</tr>').join('') + '</table></div>'; table = null; };
  for (const l of esc(src).split('\n')) {
    let m;
    if (/^\s*\|.*\|\s*$/.test(l)) { // bảng Markdown
      if (list) { html += '</ul>'; list = false; }
      if (/^\s*\|[\s:|-]+\|\s*$/.test(l)) continue; // dòng kẻ |---|
      (table ||= []).push(l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
      continue;
    }
    flushTable();
    if ((m = l.match(/^#{1,4}\s+(.*)/))) { if (list) { html += '</ul>'; list = false; } html += `<h3>${inline(m[1])}</h3>`; }
    else if ((m = l.match(/^\s*[-*•]\s+(.*)/)) || (m = l.match(/^\s*\d+[.)]\s+(.*)/))) { if (!list) { html += '<ul>'; list = true; } html += `<li>${inline(m[1])}</li>`; }
    else if (!l.trim()) { if (list) { html += '</ul>'; list = false; } }
    else { if (list) { html += '</ul>'; list = false; } html += `<p>${inline(l)}</p>`; }
  }
  flushTable();
  return html + (list ? '</ul>' : '');
}

export function listen(onText) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { alert('Trình duyệt này chưa hỗ trợ nhận giọng nói — hãy gõ.'); return; }
  const r = new SR(); r.lang = 'vi-VN'; r.interimResults = true;
  r.onresult = (e) => onText([...e.results].map((x) => x[0].transcript).join(' '), e.results[e.results.length - 1].isFinal);
  r.start();
}
