// Gọi AI qua công việc nền rồi hỏi lại mỗi 3s (Cloudflare cắt request > 100s). Chỉ chạy ở bản local (taichinh).
import { IS_LOCAL } from './config.js';

export const AI_AVAILABLE = IS_LOCAL;

export async function aiCall(body) {
  const res = await fetch('/api/ai/job', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.detail || `Lỗi AI (${res.status})`);
  for (let i = 0; i < 600; i++) {   // hỏi lại mỗi 1s (trước 3s → chậm thêm trung bình 1,5s mỗi câu)
    await new Promise((r) => setTimeout(r, 1000));
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

// Nhận giọng nói tiếng Việt. Bấm lần 1 = bắt đầu (xoá chữ cũ), bấm lần 2 = dừng.
// btn: nút mic để hiện trạng thái (đỏ nhấp nháy khi đang thu); onStatus(text): dòng trạng thái.
let active = null;
const MIC_ERR = {
  'not-allowed': 'Chưa cho phép dùng micro — bấm biểu tượng ổ khoá cạnh thanh địa chỉ để cho phép.',
  'service-not-allowed': 'Trình duyệt chặn nhận giọng nói — thử Chrome hoặc Safari.',
  'no-speech': 'Không nghe thấy gì — bấm mic rồi nói lại.',
  'audio-capture': 'Không tìm thấy micro trên máy.',
  network: 'Nhận giọng nói cần mạng — kiểm tra kết nối.',
};
export function listen(onText, { btn, onStatus } = {}) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { onStatus?.('Trình duyệt này chưa hỗ trợ nhận giọng nói — hãy gõ.'); return null; }
  if (active) { active.stop(); return null; }   // đang thu → bấm lại để dừng
  const r = new SR();
  r.lang = 'vi-VN'; r.interimResults = true; r.continuous = false;
  let got = false;
  const setRec = (on) => { if (!btn) return; btn.classList.toggle('rec', on); btn.setAttribute('aria-pressed', on); btn.title = on ? 'Đang nghe — bấm để dừng' : 'Nói'; };
  r.onstart = () => { setRec(true); onText('', false); onStatus?.('🔴 Đang nghe… nói xong tự dừng (bấm mic lần nữa để dừng ngay)'); };
  r.onresult = (e) => {
    got = true;
    onText([...e.results].map((x) => x[0].transcript).join(' '), e.results[e.results.length - 1].isFinal);
  };
  r.onerror = (e) => { if (e.error !== 'aborted') onStatus?.('⚠ ' + (MIC_ERR[e.error] || 'Lỗi micro: ' + e.error)); };
  r.onend = () => { active = null; setRec(false); if (got) onStatus?.('✓ Đã nghe xong — kiểm tra câu rồi bấm Điền'); };
  active = r;
  try { r.start(); } catch (e) { active = null; setRec(false); onStatus?.('⚠ Không bật được micro: ' + e.message); }
  return r;
}

// Thu nhỏ ảnh trên trình duyệt trước khi gửi (ảnh điện thoại 5-10MB → ~300KB). max = cạnh dài nhất (px).
export function shrinkImage(file, max = 1600, quality = 0.85) {
  return new Promise((resolve, reject) => {
    if (file.type && !file.type.startsWith('image/')) return reject(new Error(`"${file.name}" không phải ảnh`));
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);   // PNG trong suốt → nền trắng
      g.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      resolve({ ext: 'jpg', b64: c.toDataURL('image/jpeg', quality).split(',')[1] });
    };
    img.onerror = () => { URL.revokeObjectURL(img.src); reject(new Error('định dạng ảnh không hỗ trợ (dùng JPG/PNG)')); };
    img.src = URL.createObjectURL(file);
  });
}
