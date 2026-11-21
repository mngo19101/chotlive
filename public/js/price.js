/**
 * Hệ thống Bắt Giá Tiền & Bóc Tách Thông Tin Đơn Hàng Livestream Toàn Diện
 * Hỗ trợ:
 * 1. Bắt mọi dạng giá Tiếng Việt: 150k, 1tr1, 1tr250, 150 (tự nhân 1.000), 1.100.000đ
 * 2. Nhận diện số lượng: "chốt 2 cái 150k" -> quantity = 2, tổng = 300.000đ
 * 3. Chuẩn hóa SĐT với mọi định dạng: 0988 123 456, 098.812.3456, +84988...
 * 4. Nhận diện câu hỏi/tư vấn (tránh tạo đơn 0đ nhầm lẫn)
 */

/**
 * Độ dài tối đa của một bình luận được xử lý và lưu (TikTok cho khoảng 150 ký tự).
 * Một số regex bên dưới chạy chậm theo bình phương độ dài, nên phải cắt trước khi chạy.
 */
export const MAX_COMMENT_CHARS = 500;

export const stripAccents = (s) =>
  String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D');

/**
 * Sau "tr", "triệu", "củ" được cách một dấu cách trước phần lẻ: "1 triệu 2" = 1.200.000.
 * Không tính khi số đó là số lượng hoặc một giá khác: "1tr 2 cái", "1tr 200k".
 * Giống regex của PriceParser trên app iPhone và Android.
 */
const RE =
  /(?:(?<![a-z\d])|(?<=^l|[^a-z\d]l))(\d{1,3}(?:[.,]\d{3})+|\d+(?:[.,]\d+)?)\s*(k|tr(?:ieu)?|cu|nghin|ngan|vnd|d)?(?:(?<=tr|ieu|cu)\s(?=\d{1,3}(?!\d)(?![.,]\d)(?!\s*(?:cai|chiec|doi|bo|hop|set|kg|sp|goi|cap|chai|tui|lo|cuon|k|tr|cu|nghin|ngan|d|vnd)(?![a-z]))))?(\d{1,3})?(?![a-z\d])/g;

/**
 * Số điện thoại Việt Nam (0… hoặc +84…), kể cả viết tách bằng dấu cách, chấm, gạch:
 * "0912 345 678", "098.812.3456", "024 3826 1234". Phải đủ 10-11 số mới tính là số điện thoại.
 * Giống PHONE của PriceParser trên app iPhone và Android.
 */
const PHONE_RE = /(?<!\d)(?:\+84[\s.-]{0,3}|0)\d{2,3}[\s.-]{0,3}\d{3,4}[\s.-]{0,3}\d{3,4}(?!\d)/g;

/** Thay số điện thoại bằng "#" (giữ nguyên độ dài) để phần bắt giá không đọc nhầm thành giá. */
function maskPhones(s) {
  return s.replace(PHONE_RE, (m) => {
    const digits = m.replace(/\D/g, '').length - (m.startsWith('+') ? 1 : 0);
    return digits === 10 || digits === 11 ? '#'.repeat(m.length) : m;
  });
}

/** Số ngay sau "size", "sz", "sl", "số lượng" là size/số lượng: "size 38", "sl: 2". */
const SIZE_QTY_BEFORE = /(?<![a-z\d])(?:size|sz|sl|so luong)\s*:?\s*$/;
/** Số 1-2 chữ số ngay trước "cái", "đôi", "kg"... là số lượng/cân nặng: "lấy 2 cái", "50 kg". */
const QTY_AFTER = /^\s*(?:cai|chiec|doi|bo|hop|set|kg|sp|goi|cap|chai|tui|lo|cuon)(?![a-z\d])/;
/** Có "mã" đứng trước thì vẫn là mã: "mã 99 bộ đồ". */
const CODE_BEFORE = /(?<![a-z\d])ma\s*$/;

/** Số ở vị trí [start, end) của s là size hoặc số lượng, không phải giá. Giống isSizeOrQty trên app iPhone và Android. */
function isSizeOrQty(s, start, end, rawNum, unit) {
  if (unit) return false;
  const before = s.slice(0, start);
  if (SIZE_QTY_BEFORE.test(before)) return true;
  return /^\d{1,2}$/.test(rawNum) && QTY_AFTER.test(s.slice(end)) && !CODE_BEFORE.test(before);
}

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
  const { multiplier = 1000, minPrice = 1, maxPrice = 50000000 } = opts;
  if (!text) return { price: null, matchText: '', index: -1 };
  const s = maskPhones(stripAccents(String(text).toLowerCase()));
  let best = null;
  let bestMatch = '';
  let bestIndex = -1;

  for (const m of s.matchAll(RE)) {
    const [rawMatch, rawNum, unit = '', trail = ''] = m;
    const digitsOnly = rawNum.replace(/[.,]/g, '');
    if (digitsOnly.length >= 9) continue; // số điện thoại / mã đơn
    if (isSizeOrQty(s, m.index, m.index + rawMatch.length, rawNum, unit)) continue;

    const isGrouped = /^\d{1,3}(?:[.,]\d{3})+$/.test(rawNum);
    // "2.500k" là 2.500 nghìn; riêng "1.500tr" vẫn đọc là 1,5 triệu.
    let n = isGrouped && !/^(tr|trieu|cu)$/.test(unit)
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
      bestIndex = m.index;
    }
  }
  return { price: best, matchText: bestMatch, index: bestIndex };
}

/**
 * Bắt giá tiền từ bình luận
 */
export function parsePrice(text, opts = {}) {
  return parsePriceWithMatch(text, opts).price;
}

const CODE_FILLERS = /(?<![a-z\d])(?:ma|va|voi|l)(?![a-z\d])|[\s,;+&/.-]/g;

/**
 * Bình luận chỉ ghi mã/giá, ví dụ "280", "mã 150, 180". "Mã 130 giá sao" là hỏi giá nên không tính.
 * Giống PriceParser.isOnlyCodes của app iPhone và Android.
 */
export function isOnlyCodes(text, opts = {}) {
  const s = maskPhones(stripAccents(String(text || '').toLowerCase()));
  let found = false;
  const rest = s.replace(RE, (match) => {
    if (!parsePrice(match, opts)) return match;
    found = true;
    return ' ';
  });
  return found && rest.replace(CODE_FILLERS, '') === '';
}

/** Giá nhập tay */
export function parsePriceInput(text, multiplier = 1000) {
  if (text === '' || text == null) return 0;
  const v = parsePrice(String(text), { multiplier, minPrice: 1, maxPrice: 1e12 });
  return v ?? 0;
}

const MONEY_INPUT_RE = /^(\d{1,3}(?:[.,]\d{3})+|\d+(?:[.,]\d+)?)(k|tr(?:ieu)?|cu|nghin|ngan|vnd|d)?(\d{1,3})?$/;

/**
 * Ô nhập số tiền (thu hộ, tiền cọc): số thuần là đồng ("150" = 150đ), dấu chấm/phẩy là nhóm nghìn
 * ("150.000" = 150.000đ), nhận "150k", "1.5tr". Trống hoặc không hợp lệ (số âm, "150.5") trả null.
 */
export function parseMoneyInput(text) {
  const s = stripAccents(String(text ?? '').toLowerCase()).replace(/\s+/g, '');
  const m = MONEY_INPUT_RE.exec(s);
  if (!m) return null;
  const [, rawNum, unit = ''] = m;
  const bigUnit = /^(k|tr|trieu|cu|nghin|ngan)$/.test(unit);
  if (!bigUnit && /[.,]/.test(rawNum) && !/^\d{1,3}(?:[.,]\d{3})+$/.test(rawNum)) return null;
  return parsePriceWithMatch(s, { multiplier: 1, minPrice: 0, maxPrice: 1e12 }).price;
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
 * Trích xuất thông tin: Tên sản phẩm, Số lượng, SĐT, Loại bình luận (địa chỉ do shop tự nhập)
 */
const QTY_UNIT = '(?:cái|chiếc|đôi|bộ|hộp|set|kg)';
const QTY_RE = new RegExp(`(?:chốt|lấy|mua|cho em|cho e|cho chị|cho c)\\s+(\\d{1,2})(\\s*${QTY_UNIT})?(?![\\p{L}\\d])`, 'iu');
/** "350k x2", "x 3", "×2": số lượng ghi sau chữ x. */
const TIMES_QTY_RE = /(?:^|[\s\dk])[x×]\s?(\d{1,2})(?!\d)/i;

/**
 * Số lượng trong bình luận. Số ngay sau "chốt/lấy/mua" chỉ là số lượng khi có chữ "cái/đôi..." đi kèm,
 * hoặc khi bỏ số đó đi vẫn còn nguyên giá: "chốt 2 áo 150k" là 2 cái, còn "chốt 99" là giá 99k, 1 cái.
 */
function quantityOf(str) {
  const m = QTY_RE.exec(str);
  if (m) {
    const n = Math.max(1, parseInt(m[1], 10));
    if (m[2]) return n;
    const at = m.index + m[0].length - m[1].length;
    const rest = str.slice(0, at) + str.slice(at + m[1].length);
    const full = parsePrice(str);
    if (full && parsePrice(rest) === full) return n;
  }
  const t = TIMES_QTY_RE.exec(str);
  return t ? Math.max(1, parseInt(t[1], 10)) : 1;
}

export function extractProductInfo(comment = '', price = 0) {
  const text = String(comment).normalize('NFC').trim().slice(0, MAX_COMMENT_CHARS);
  let str = text;
  const isQuestion = isInquiry(str);

  // 1. Tìm số điện thoại (hỗ trợ dấu cách, dấu chấm, +84)
  const phoneMatch = str.match(/(?:(?:\+|00)84|0)(?:[\s.-]*\d){9,10}/);
  let phone = '';
  if (phoneMatch) {
    phone = phoneMatch[0].replace(/[\s.-]/g, '').replace(/^\+84/, '0');
    str = str.replace(phoneMatch[0], '').replace(/(?:s[đd]t|sdt|phone|tel|alo)[:\s]*/gi, '');
  }

  // 2. Nhận diện số lượng: "chốt 2 cái", "lấy 3 đôi", "cho e 2 áo"
  const quantity = quantityOf(str);

  // 3. Chỉ xoá cụm giá tiền đã nhận diện (giữ nguyên size 2, max 3).
  // Số đứng sau "mã" là mã sản phẩm: "chốt mã 268" giữ tên "Mã 268".
  // Vị trí lấy từ chuỗi đã bỏ dấu: chuỗi NFC bỏ dấu vẫn đủ số ký tự nên cắt thẳng trên chuỗi gốc được.
  const { matchText, index } = parsePriceWithMatch(str);
  if (matchText && index >= 0 && !CODE_BEFORE.test(stripAccents(str.slice(0, index)).toLowerCase())) {
    str = str.slice(0, index) + str.slice(index + matchText.length);
  }
  str = str.replace(TIMES_QTY_RE, (m) => m.replace(/[x×]\s?\d{1,2}$/i, ''));

  // 4. Làm sạch từ khóa chốt đơn thông dụng
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
    cleaned = text;
  }

  return {
    productName: cleaned || 'Sản phẩm livestream',
    phone,
    quantity,
    isInquiry: isQuestion && !price,
  };
}
