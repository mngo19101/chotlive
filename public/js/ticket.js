/**
 * Vẽ tem in khổ 80mm (576 điểm) / 58mm (384 điểm) lên canvas.
 * Hỗ trợ: In TikTok ID và danh sách từng sản phẩm đã mua của khách.
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
 * @param {{uniqueId:string, userId?:string, nickname?:string,
 *          items?:{name:string, price:number, comment?:string}[], total?:number, ts:number,
 *          liveComment?:string}} t  Có liveComment: in tem bình luận live (không có sản phẩm, giá).
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

  const isLive = t.liveComment != null;
  const custName = t.nickname && t.nickname !== t.uniqueId ? t.nickname : ('@' + t.uniqueId);

  // ===== ĐẦU TEM =====
  text((settings.shopName || 'susu').toUpperCase(), { w: 800, px: 52, align: 'center', gap: 0 });
  if (!isLive && settings.shopSub) text(settings.shopSub, { w: 400, px: 22, align: 'center', gap: 2 });
  dashed(16);

  if (isLive) {
    // ===== TEM BÌNH LUẬN LIVE =====
    text(`Tên TikTok: ${custName}`, { w: 800, px: 34, gap: 2 });
    text(`ID TikTok: @${t.uniqueId}`, { w: 600, px: 26, gap: 2 });
    text(`Giờ in: ${fmtTime(t.ts)}`, { w: 400, px: 24, gap: 0 });
    dashed(14);
    text('Bình luận:', { w: 400, px: 24, gap: 2 });
    text(t.liveComment, { w: 700, px: 34, gap: 0 });
  } else {
    // Thời gian
    if (settings.showTime !== false) {
      text(fmtTime(t.ts), { w: 400, px: 22, align: 'center', gap: 0 });
      dashed(16);
    }

    // ===== THÔNG TIN KHÁCH HÀNG =====
    text(custName, { w: 800, px: 38, gap: 2 });

    if (t.uniqueId && t.uniqueId !== custName) {
      text('@' + t.uniqueId, { w: 500, px: 24, gap: 2 });
    }

    // CarID TikTok / User ID
    if (t.userId) {
      text(`TikTok ID: ${t.userId}`, { w: 600, px: 24, gap: 2 });
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

    // ===== TỔNG TIỀN =====
    row('TỔNG CỘNG:', t.total ? formatVND(t.total) : '0đ', {
      lw: 800, lpx: 32, rw: 800, rpx: 52
    });
  }
  dashed(16);
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
