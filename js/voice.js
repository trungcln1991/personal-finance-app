// Vòng nghe liên tục cho chế độ "Giao tiếp": mic mở suốt cuộc trò chuyện, người dùng NGỪNG NÓI
// ~1,5 giây là coi như nói xong → gửi. Không phụ thuộc cờ isFinal (Safari/iPhone nhiều khi không bao giờ bật).
// mute(true) khi app đang đọc to/đang nghĩ → bỏ qua mọi thứ mic nghe được (tránh tự nghe tiếng loa của mình).
// Phải gọi start() TRONG thao tác bấm của người dùng (trình duyệt chỉ cho mở mic khi có cử chỉ).
export function createVoiceLoop({ onUtterance, onInterim, onState, silenceMs = 1500 }) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  let rec = null, active = false, muted = false, buf = '', interim = '', timer = null, fails = 0;

  const text = () => `${buf} ${interim}`.replace(/\s+/g, ' ').trim();
  function flush() {
    clearTimeout(timer);
    const t = text(); buf = ''; interim = '';
    if (t && !muted) onUtterance(t);
  }
  function create() {
    rec = new SR();
    rec.lang = 'vi-VN'; rec.continuous = true; rec.interimResults = true;
    rec.onstart = () => { fails = 0; onState('listening'); };
    rec.onresult = (e) => {
      if (muted) return;
      interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) buf += ' ' + r[0].transcript; else interim += ' ' + r[0].transcript;
      }
      onInterim(text());
      clearTimeout(timer);
      timer = setTimeout(flush, silenceMs);   // im lặng đủ lâu = nói xong
    };
    rec.onerror = (e) => {
      if (['not-allowed', 'service-not-allowed', 'audio-capture'].includes(e.error)) { active = false; onState('error', e.error); }
    };
    rec.onend = () => {
      if (text()) flush();
      if (!active) { onState('stopped'); return; }
      // Trình duyệt tự tắt mic sau 1 lúc → bật lại. iPhone có thể không cho (cần chạm lại) → báo 'paused'.
      setTimeout(() => {
        if (!active) return;
        try { rec.start(); } catch { if (++fails > 2) { active = false; onState('paused'); } }
      }, 250);
    };
  }
  return {
    start() { if (active) return; active = true; if (!rec) create(); try { rec.start(); } catch { /* đã chạy */ } },
    stop() { active = false; clearTimeout(timer); buf = ''; interim = ''; try { rec?.abort(); } catch {} },
    mute(on) { muted = on; if (on) { clearTimeout(timer); buf = ''; interim = ''; } },
    get active() { return active; },
  };
}
