/**
 * Hệ thống Bắt Giá Tiền & Bóc Tách Thông Tin Đơn Hàng Livestream Toàn Diện
 * Hỗ trợ:
 * 1. Bắt mọi dạng giá Tiếng Việt: 150k, 1tr1, 1tr250, 150 (tự nhân 1.000), 1.100.000đ
 * 2. Nhận diện số lượng: "chốt 2 cái 150k" -> quantity = 2, tổng = 300.000đ
 * 3. Chuẩn hóa SĐT với mọi định dạng: 0988 123 456, 098.812.3456, +84988...
 * 4. Nhận diện địa chỉ giao hàng trong bình luận
 * 5. Nhận diện câu hỏi/tư vấn (tránh tạo đơn 0đ nhầm lẫn)
 */

export const stripAccents = (s) =>
  String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D');

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const RE =
  /(?<![a-z\d])(\d{1,3}(?:[.,]\d{3})+|\d+(?:[.,]\d+)?)\s*(k|tr(?:ieu)?|cu|nghin|ngan|vnd|d)?(\d{1,3})?(?![a-z\d])/g;

const INQUIRY_RE =
  /(?:bao nhieu|bn\b|co duoc|khong|k a|k shop|xem lai|con size|khi nao|may ngay|ship ve|tu van|hoi |o dau|co hop k)/i;

/**
 * Kiểm tra xem bình luận có phải là câu hỏi tư vấn hay không
 */
export function isInquiry(comment = '') {
  if (!comment) return false;
  return INQUIRY_RE.test(stripAccents(comment));
}

/**
 * Bắt giá tiền cùng cụm từ khớp từ bình luận
 */
export function parsePriceWithMatch(text, opts = {}) {
  const { multiplier = 1000, minPrice = 10000, maxPrice = 50000000 } = opts;
  if (!text) return { price: null, matchText: '' };
  const s = stripAccents(String(text).toLowerCase());
  let best = null;
  let bestMatch = '';

  for (const m of s.matchAll(RE)) {
    const [rawMatch, rawNum, unit = '', trail = ''] = m;
    const digitsOnly = rawNum.replace(/[.,]/g, '');
    if (digitsOnly.length >= 9) continue; // số điện thoại / mã đơn

    const isGrouped = /^\d{1,3}(?:[.,]\d{3})+$/.test(rawNum);
    let n = isGrouped && !/^(k|tr|trieu|cu)$/.test(unit)
      ? Number(digitsOnly)
      : Number(rawNum.replace(',', '.'));
    if (!Number.isFinite(n)) continue;

    let v;
    if (unit === 'k' || unit === 'nghin' || unit === 'ngan') {
      if (trail) continue;
      v = n * 1000;
    } else if (unit === 'tr' || unit === 'trieu' || unit === 'cu') {
      v = n * 1_000_000 + (trail ? Number('0.' + trail) * 1_000_000 : 0);
    } else {
      if (trail) continue;
      v = n >= 1000 ? n : n * multiplier;
    }
    v = Math.round(v);
    if (v < minPrice || v > maxPrice) continue;
    if (best === null || v > best) {
      best = v;
      bestMatch = rawMatch;
    }
  }
  return { price: best, matchText: bestMatch };
}

/**
 * Bắt giá tiền từ bình luận
 */
export function parsePrice(text, opts = {}) {
  return parsePriceWithMatch(text, opts).price;
}

/** Giá nhập tay */
export function parsePriceInput(text, multiplier = 1000) {
  if (text === '' || text == null) return 0;
  const v = parsePrice(String(text), { multiplier, minPrice: 1, maxPrice: 1e12 });
  return v ?? 0;
}

export function formatVND(n) {
  return (Number(n) || 0).toLocaleString('vi-VN') + 'đ';
}

/**
 * Định dạng SĐT đẹp mắt: 0988 123 456
 */
export function formatPhone(p) {
  if (!p) return '';
  const digits = String(p).replace(/\D/g, '');
  if (digits.length === 10) {
    return `${digits.slice(0, 4)} ${digits.slice(4, 7)} ${digits.slice(7)}`;
  }
  return p;
}

/**
 * Trích xuất đầy đủ thông tin: Tên sản phẩm, Số lượng, Đơn giá, SĐT, Địa chỉ, Loại bình luận
 */
export function extractProductInfo(comment = '', price = 0) {
  let str = String(comment).trim();
  const isQuestion = isInquiry(str);

  // 1. Tìm số điện thoại (hỗ trợ dấu cách, dấu chấm, +84)
  const phoneMatch = str.match(/(?:(?:\+|00)84|0)(?:[\s.-]*\d){9,10}/);
  let phone = '';
  if (phoneMatch) {
    phone = phoneMatch[0].replace(/[\s.-]/g, '').replace(/^\+84/, '0');
    str = str.replace(phoneMatch[0], '').replace(/(?:s[đd]t|sdt|phone|tel|alo)[:\s]*/gi, '');
  }

  // 2. Nhận diện số lượng: "chốt 2 cái", "lấy 3 đôi", "cho e 2 áo"
  const qtyMatch = str.match(/(?:chốt|lấy|mua|cho em|cho e|cho chị|cho c)\s+(\d{1,2})\s*(?:cái|chiếc|đôi|bộ|hộp|set|kg)?\b/i);
  const quantity = qtyMatch ? Math.max(1, parseInt(qtyMatch[1], 10)) : 1;

  // 3. Tìm địa chỉ nếu có
  const addrMatch = str.match(/(?:địa chỉ|đ\/c|dc|giao về|giao tai|o tai|o|ship ve|tai)[:\s]*([^,;]+(?:hcm|hà nội|hn|đà nẵng|quận|huyện|phường|xã|đường|thôn|ấp|tp)[^,;]*)/i);
  const address = addrMatch ? addrMatch[1].trim() : '';
  if (address) {
    str = str.replace(addrMatch[0], '');
  }

  // 4. Chỉ xoá cụm giá tiền đã nhận diện (giữ nguyên size 2, max 3)
  const { matchText } = parsePriceWithMatch(str);
  if (matchText) {
    str = str.replace(new RegExp(escapeRegExp(matchText), 'i'), '');
  }

  // 5. Làm sạch từ khóa chốt đơn thông dụng
  let cleaned = str
    .replace(/^([!@#.,\-_]+)/, '')
    .replace(/(?:^|\s+)(chốt|chot|lấy thêm|lấy|lay them|lay|cho em|cho e|cho chị|cho c|mua|ship|order)(?:\s+\d{1,2}\s*(?:cái|chiếc|đôi|bộ|hộp|set|kg)?)?(?=\s+|$)/gi, ' ')
    .replace(/(?:^|\s+)(giá|gia|nha shop|nhe shop|nha|nhé|nhe|ạ|a|ơi|oi|cho|em|chị|mình|minh|shop)(?=\s+|$)/gi, ' ')
    .replace(/[,\-:;]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Viết hoa chữ cái đầu
  if (cleaned.length >= 2) {
    cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  } else {
    cleaned = comment.trim();
  }

  return {
    productName: cleaned || 'Sản phẩm livestream',
    phone,
    address,
    quantity,
    isInquiry: isQuestion && !price,
  };
}
