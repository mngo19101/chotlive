/**
 * Bộ phát âm thanh & Giọng đọc Tiếng Việt (TTS) tự động đọc tên khách và món chốt
 * Dành cho người Livestream: Không cần nhìn màn hình vẫn nghe được đơn vừa chốt!
 */

let speechQueue = [];
let isSpeaking = false;
let audioCtx = null;

function getAudioContext() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
  return audioCtx;
}

/**
 * 1. ÂM THANH KACHING (TIỀN VÀO TÚI) KHI CÓ ĐƠN MỚI
 */
export function playCashChime(volume = 0.5) {
  try {
    const ctx = getAudioContext();
    const t = ctx.currentTime;

    // Chime 1
    const osc1 = ctx.createOscillator();
    const g1 = ctx.createGain();
    osc1.type = 'triangle';
    osc1.frequency.setValueAtTime(1046.5, t); // C6
    osc1.frequency.exponentialRampToValueAtTime(1318.5, t + 0.08); // E6
    g1.gain.setValueAtTime(0.01, t);
    g1.gain.linearRampToValueAtTime(volume * 0.25, t + 0.02);
    g1.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    osc1.connect(g1).connect(ctx.destination);
    osc1.start(t);
    osc1.stop(t + 0.35);

    // Chime 2
    const osc2 = ctx.createOscillator();
    const g2 = ctx.createGain();
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(2093.0, t + 0.08); // C7
    g2.gain.setValueAtTime(0.01, t + 0.08);
    g2.gain.linearRampToValueAtTime(volume * 0.35, t + 0.1);
    g2.gain.exponentialRampToValueAtTime(0.001, t + 0.55);
    osc2.connect(g2).connect(ctx.destination);
    osc2.start(t + 0.08);
    osc2.stop(t + 0.55);
  } catch {}
}

/**
 * 2. ÂM THANH TIẾNG MÁY IN NHIỆT KHI IN TEM
 */
export function playPrinterSound(volume = 0.3) {
  try {
    const ctx = getAudioContext();
    const t = ctx.currentTime;
    
    // Tiếng bíp kép
    [0, 0.09].forEach((dt, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = i ? 1500 : 1000;
      g.gain.setValueAtTime(0.001, t + dt);
      g.gain.linearRampToValueAtTime(volume * 0.2, t + dt + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dt + 0.08);
      o.connect(g).connect(ctx.destination);
      o.start(t + dt);
      o.stop(t + dt + 0.09);
    });
  } catch {}
}

/**
 * 3. ÂM THANH CẢNH BÁO BOM HÀNG HOẶC KHÁCH ĐẶC BIỆT
 */
export function playWarningSound() {
  try {
    const ctx = getAudioContext();
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(400, t);
    osc.frequency.linearRampToValueAtTime(300, t + 0.25);
    g.gain.setValueAtTime(0.2, t);
    g.gain.exponentialRampToValueAtTime(0.01, t + 0.25);
    osc.connect(g).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.25);
  } catch {}
}

/**
 * 4. ĐỌC ĐƠN HÀNG BẰNG GIỌNG NÓI TIẾNG VIỆT (TEXT-TO-SPEECH)
 */
function readPriceInWords(price) {
  const p = Number(price) || 0;
  if (!p) return '';
  if (p >= 1_000_000) {
    const tr = Math.floor(p / 1_000_000);
    const nghin = Math.round((p % 1_000_000) / 1000);
    if (nghin > 0) return `${tr} triệu ${nghin} nghìn`;
    return `${tr} triệu`;
  }
  if (p >= 1000) {
    return `${Math.round(p / 1000)} nghìn`;
  }
  return `${p} đồng`;
}

export function stopSpeaking() {
  speechQueue = [];
  isSpeaking = false;
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    try {
      window.speechSynthesis.cancel();
    } catch {}
  }
}

// Huỷ mọi tiến trình đọc giọng nói ngay khi khởi chạy
stopSpeaking();

export function speakOrder(customerName, productName, price) {
  // Đã tắt hoàn toàn tính năng đọc giọng nói theo yêu cầu
  stopSpeaking();
  return;
}
