const pad = (n) => String(n).padStart(2, '0');

/** Làm tròn lên để chưa hết hạn thì không bao giờ hiện 0 giây. */
function split(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return {
    total,
    days: Math.floor(total / 86400),
    hours: Math.floor((total % 86400) / 3600),
    minutes: Math.floor((total % 3600) / 60),
    seconds: total % 60
  };
}

/** "2 ngày 23 giờ 04 phút 09 giây" */
export function countdownText(ms) {
  const { total, days, hours, minutes, seconds } = split(ms);
  const parts = [`${pad(seconds)} giây`];
  if (total >= 60) parts.unshift(`${pad(minutes)} phút`);
  if (total >= 3600) parts.unshift(`${hours} giờ`);
  if (days) parts.unshift(`${days} ngày`);
  return parts.join(' ');
}

/** "2 ngày 23:04:09", vừa một dòng ở thanh bên. */
export function countdownClock(ms) {
  const { days, hours, minutes, seconds } = split(ms);
  const clock = `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  return days ? `${days} ngày ${clock}` : clock;
}

/** Thời gian còn lại của gói, tính theo giờ: "20 ngày 3 giờ", "5 giờ", "dưới 1 giờ". */
export function remainingText(ms) {
  const hours = Math.floor(Math.max(0, ms) / 3600000);
  if (hours < 1) return 'dưới 1 giờ';
  const days = Math.floor(hours / 24);
  if (days < 1) return `${hours} giờ`;
  return hours % 24 ? `${days} ngày ${hours % 24} giờ` : `${days} ngày`;
}
