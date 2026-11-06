/**
 * Vẽ tem in khổ 80mm (576 điểm) / 58mm (384 điểm) lên canvas.
 * Hỗ trợ: In TikTok CarID / UserID, SĐT, danh sách từng sản phẩm đã mua của khách.
 */
import { formatVND } from './price.js';

const FONT = '"Be Vietnam Pro", "Segoe UI", Arial, sans-serif';
let fontReady = null;

export function ensureFonts() {
  if (!fontReady) {
    fontReady = Promise.all([
      document.fonts.load(`400 24px ${FONT}`),
      document.fonts.load(`600 24px ${FONT}`),
      document.fonts.load(`800 24px ${FONT}`),
    ]).catch(() => {});
  }
  return fontReady;
}

function wrap(ctx, text, maxWidth) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    const test = line ? line + ' ' + w : w;
    if (ctx.measureText(test).width <= maxWidth) { line = test; continue; }
    if (line) lines.push(line);
    if (ctx.measureText(w).width > maxWidth) {
      let chunk = '';
      for (const ch of w) {
        if (ctx.measureText(chunk + ch).width > maxWidth) { lines.push(chunk); chunk = ch; }
        else chunk += ch;
      }
      line = chunk;
    } else line = w;
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

const pad2 = (n) => String(n).padStart(2, '0');
function fmtTime(ts) {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())} ${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
}

/**
 * @param {object} settings
 * @param {{code:string, uniqueId:string, userId?:string, nickname?:string, phone?:string,
 *          items:{name:string, price:number, comment?:string}[], total:number, ts:number}} t
 * @returns {HTMLCanvasElement}
 */
export function renderTicket(settings, t) {
  const W = Number(settings.paper) === 58 ? 384 : 576;
  const S = (W / 576) * (Number(settings.fontScale) || 1);
  const M = Math.round(18 * (W / 576));
  const CW = W - M * 2;

  const items = t.items || [{ name: 'Sản phẩm', price: t.total || 0 }];

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = 3000 + items.length * 240;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#000';
  ctx.textBaseline = 'top';

  let y = Math.round(12 * S);
  const font = (w, px) => { ctx.font = `${w} ${Math.round(px * S)}px ${FONT}`; return Math.round(px * S); };
  
  const text = (str, { w = 400, px = 26, align = 'left', gap = 6, maxW = CW, indent = 0 } = {}) => {
    const size = font(w, px);
    for (const line of wrap(ctx, str, maxW)) {
      ctx.textAlign = align;
      const x = align === 'center' ? W / 2 : align === 'right' ? W - M - indent : M + indent;
      ctx.fillText(line, x, y);
      y += Math.round(size * 1.22);
    }
    y += Math.round(gap * S);
  };

  const dashed = (gap = 14) => {
    y += Math.round(gap * S * 0.4);
    ctx.save();
    ctx.setLineDash([Math.round(10 * S), Math.round(7 * S)]);
    ctx.lineWidth = Math.max(2, Math.round(2 * S));
    ctx.beginPath(); ctx.moveTo(M, y); ctx.lineTo(W - M, y); ctx.stroke();
    ctx.restore();
    y += Math.round(gap * S);
  };

  const row = (left, right, { lw = 600, lpx = 26, rw = 800, rpx = 26 } = {}) => {
    const rs = font(rw, rpx);
    ctx.textAlign = 'right';
    const rWidth = ctx.measureText(right).width;
    ctx.fillText(right, W - M, y);
    const ls = font(lw, lpx);
    ctx.textAlign = 'left';
    const lines = wrap(ctx, left, CW - rWidth - 16 * S);
    lines.forEach((l, i) => ctx.fillText(l, M, y + i * Math.round(ls * 1.22)));
    y += Math.max(Math.round(rs * 1.22), lines.length * Math.round(ls * 1.22)) + Math.round(6 * S);
  };

  // ===== ĐẦU TEM =====
  text((settings.shopName || 'susu').toUpperCase(), { w: 800, px: 52, align: 'center', gap: 0 });
  if (settings.shopSub) text(settings.shopSub, { w: 400, px: 22, align: 'center', gap: 2 });
  dashed(16);

  // Mã đơn + thời gian
  row(`ĐƠN ${t.code}`, settings.showTime !== false ? fmtTime(t.ts) : '', { lw: 800, lpx: 32, rw: 400, rpx: 22 });
  dashed(16);

  // ===== THÔNG TIN KHÁCH HÀNG =====
  const custName = t.nickname && t.nickname !== t.uniqueId ? t.nickname : ('@' + t.uniqueId);
  text(custName, { w: 800, px: 38, gap: 2 });
  
  if (t.uniqueId && t.uniqueId !== custName) {
    text('@' + t.uniqueId, { w: 500, px: 24, gap: 2 });
  }

  // CarID TikTok / User ID
  if (t.userId) {
    text(`TikTok ID: ${t.userId}`, { w: 600, px: 24, gap: 2 });
  }

  // Số điện thoại nếu có
  if (t.phone) {
    text(`SĐT: ${t.phone}`, { w: 800, px: 28, gap: 4 });
  }

  // Địa chỉ giao hàng nếu có
  if (t.address) {
    text(`Đ/C: ${t.address}`, { w: 600, px: 24, gap: 4 });
  }

  y += Math.round(6 * S);
  dashed(14);

  // ===== DANH SÁCH TỪNG SẢN PHẨM MUA =====
  text(`DANH SÁCH SẢN PHẨM (${items.length} món):`, { w: 700, px: 24, gap: 6 });

  items.forEach((it, i) => {
    const itemName = it.name || it.content || `Sản phẩm ${i + 1}`;
    const itemQty = (it.qty && it.qty > 1) ? ` (×${it.qty})` : '';
    const itemPrice = it.price ? formatVND(it.price * (it.qty || 1)) : '0đ';
    row(`${i + 1}. ${itemName}${itemQty}`, itemPrice, {
      lw: 500, lpx: 26, rw: 700, rpx: 26
    });
    if (it.comment) {
      text(`Bình luận: "${it.comment}"`, { w: 600, px: 24, gap: 6, indent: 14, maxW: CW - 14 });
    }
  });

  dashed(16);

  // Tiền phụ thu / Giảm giá nếu có
  if (t.shippingFee) {
    row('Phí vận chuyển:', formatVND(t.shippingFee), { lw: 500, lpx: 24, rw: 700, rpx: 24 });
  }
  if (t.discount) {
    row('Giảm giá ưu đãi:', '-' + formatVND(t.discount), { lw: 500, lpx: 24, rw: 700, rpx: 24 });
  }

  // ===== TỔNG TIỀN =====
  row('TỔNG CỘNG:', t.total ? formatVND(t.total) : '0đ', {
    lw: 800, lpx: 32, rw: 800, rpx: 52
  });
  dashed(16);

  // In mã vạch quét đơn (Barcode Code39)
  const barH = Math.round(38 * S);
  const barW = Math.min(CW, Math.round(360 * S));
  const barX = Math.round((W - barW) / 2);
  const codeStr = '*' + (t.code || 'HD0001') + '*';
  const totalBars = codeStr.length * 8;
  const unitW = barW / totalBars;

  ctx.fillStyle = '#000';
  for (let c = 0; c < codeStr.length; c++) {
    const val = codeStr.charCodeAt(c);
    for (let b = 0; b < 7; b++) {
      if ((val >> (b % 6)) & 1) {
        ctx.fillRect(barX + (c * 8 + b) * unitW, y, unitW * 0.95, barH);
      }
    }
  }
  y += barH + Math.round(6 * S);
  text(t.code, { w: 600, px: 20, align: 'center', gap: 6 });

  // Lời cảm ơn
  if (settings.footer) text(settings.footer, { w: 400, px: 22, align: 'center', gap: 0 });
  y += Math.round(24 * S);

  // Cắt và chuyển sang 1-bit đen trắng cho máy in nhiệt
  const H = Math.ceil(y / 8) * 8;
  const out = document.createElement('canvas');
  out.width = W; out.height = H;
  const octx = out.getContext('2d');
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    const v = lum < 150 ? 0 : 255;
    d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
  }
  octx.putImageData(img, 0, 0);
  return out;
}
