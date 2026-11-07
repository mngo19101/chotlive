/**
 * Đếm số lần thử theo từng khoá (IP, IP + tên tài khoản) trong một khoảng thời gian.
 * Lưu trong bộ nhớ: server chỉ chạy một tiến trình, khởi động lại thì đếm lại từ đầu.
 */
export function createLimiter({ max, windowMs, now = Date.now }) {
  const hits = new Map();

  const current = (key) => {
    const entry = hits.get(key);
    if (!entry) return null;
    if (now() - entry.startedAt >= windowMs) {
      hits.delete(key);
      return null;
    }
    return entry;
  };

  return {
    /** Số giây còn phải chờ; 0 nghĩa là chưa bị chặn. */
    retryAfter(key) {
      const entry = current(key);
      if (!entry || entry.count < max) return 0;
      return Math.ceil((entry.startedAt + windowMs - now()) / 1000);
    },
    hit(key) {
      const entry = current(key);
      if (entry) entry.count++;
      else hits.set(key, { count: 1, startedAt: now() });
    },
    reset(key) {
      hits.delete(key);
    },
    /** Bỏ các khoá đã hết hạn để bộ đếm không lớn mãi. */
    sweep() {
      for (const key of hits.keys()) current(key);
    },
    get size() {
      return hits.size;
    }
  };
}

export function waitMessage(seconds) {
  return `Bạn đã thử quá nhiều lần. Vui lòng thử lại sau ${Math.max(1, Math.ceil(seconds / 60))} phút.`;
}
