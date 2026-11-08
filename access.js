/**
 * Quyền dùng app: dùng thử, gói do admin cấp, và cách tính IP khi giới hạn tạo tài khoản.
 * Mọi mốc thời gian đều do server đặt và tính theo đồng hồ của server; thiết bị chỉ được xem kết quả.
 */
import net from 'node:net';

export const DAY_MS = 24 * 60 * 60 * 1000;
export const TRIAL_DAYS = 3;
export const TRIAL_MS = TRIAL_DAYS * DAY_MS;
export const PLAN_MONTH_DAYS = 30;
export const MAX_PLAN_MONTHS = 36;
export const MAX_ACCOUNTS_PER_IP = 2;
/** Admin vừa cấp nhiều lần vẫn phải giới hạn được, tránh số quá lớn làm sai ngày hết hạn. */
export const MAX_PLAN_TOTAL_MS = 10 * 365 * DAY_MS;

export const TRIAL_EXPIRED_MESSAGE = `Đã hết ${TRIAL_DAYS} ngày dùng thử. Vui lòng mua gói để tiếp tục theo dõi live.`;
export const PLAN_EXPIRED_MESSAGE = 'Gói của bạn đã hết hạn. Vui lòng mua gói để tiếp tục theo dõi live.';
export const IP_LIMIT_MESSAGE = `Mạng này đã tạo đủ ${MAX_ACCOUNTS_PER_IP} tài khoản. Vui lòng đăng nhập tài khoản đã có hoặc liên hệ Admin.`;

const isTime = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Thiếu mốc thời gian thì coi là hết hạn: tài khoản không có trialEndsAt không được thành dùng miễn phí mãi.
 * Tài khoản cũ được server đặt mốc lúc khởi động (xem startTrialForOldAccounts).
 */
export function accessOf(user, now = Date.now()) {
  const trialEndsAt = isTime(user?.trialEndsAt) ? user.trialEndsAt : null;
  const planEndsAt = isTime(user?.planEndsAt) ? user.planEndsAt : null;
  const base = { trialEndsAt, planEndsAt };

  if (user?.role === 'admin') {
    return { ...base, status: 'admin', canFollowLive: true, endsAt: null, code: '', message: '' };
  }
  if (planEndsAt !== null && now < planEndsAt) {
    return { ...base, status: 'plan', canFollowLive: true, endsAt: planEndsAt, code: '', message: '' };
  }
  if (trialEndsAt !== null && now < trialEndsAt) {
    return { ...base, status: 'trial', canFollowLive: true, endsAt: trialEndsAt, code: '', message: '' };
  }
  const planEnded = planEndsAt !== null;
  return {
    ...base,
    status: 'expired',
    canFollowLive: false,
    endsAt: null,
    code: planEnded ? 'PLAN_EXPIRED' : 'TRIAL_EXPIRED',
    message: planEnded ? PLAN_EXPIRED_MESSAGE : TRIAL_EXPIRED_MESSAGE
  };
}

export function validPlanMonths(months) {
  return Number.isInteger(months) && months >= 1 && months <= MAX_PLAN_MONTHS;
}

/** Còn hạn thì cộng nối tiếp, đã hết hạn thì tính từ lúc cấp. Trả về mốc hết hạn mới. */
export function extendedPlanEnd(currentEnd, months, now = Date.now()) {
  const from = isTime(currentEnd) && currentEnd > now ? currentEnd : now;
  return Math.min(from + months * PLAN_MONTH_DAYS * DAY_MS, now + MAX_PLAN_TOTAL_MS);
}

/** "::ffff:1.2.3.4" là IPv4; IPv6 thì lấy /64 vì một nhà mạng cấp nguyên dải đó cho một thuê bao. */
export function ipKey(rawIp) {
  let ip = String(rawIp || '').trim().toLowerCase();
  if (!ip) return 'unknown';
  const zone = ip.indexOf('%');
  if (zone >= 0) ip = ip.slice(0, zone);
  if (ip.startsWith('::ffff:') && net.isIPv4(ip.slice(7))) return ip.slice(7);
  if (!net.isIPv6(ip)) return ip;

  const [head, tail] = ip.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  // Phần IPv4 ở cuối chiếm hai nhóm nhưng nằm ngoài 4 nhóm đầu, chỉ cần tính đúng số nhóm.
  const rightLength = right.reduce((sum, part) => sum + (part.includes('.') ? 2 : 1), 0);
  const missing = ip.includes('::') ? Array(Math.max(0, 8 - left.length - rightLength)).fill('0') : [];
  const groups = [...left, ...missing, ...right].slice(0, 4).map((g) => g.replace(/^0+(?=.)/, ''));
  return `${groups.join(':')}::/64`;
}

/** Biến môi trường luôn là chuỗi, mà Express hiểu chuỗi "1" là một địa chỉ IP chứ không phải số lớp proxy. */
export function parseTrustProxy(value) {
  const text = String(value ?? '').trim();
  if (!text) return 'loopback';
  return /^\d+$/.test(text) ? Number(text) : text;
}
