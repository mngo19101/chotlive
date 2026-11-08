/**
 * Header bảo mật cho mọi trả lời của server.
 * Server được mở thẳng ra Internet qua Tailscale Funnel, không có Caddy đứng trước (Caddy chỉ dùng trên VPS),
 * nên server tự đặt các header này.
 *
 * - CSP chỉ cho chạy script nằm trong /js của chính server: lỡ có chỗ chèn được HTML (tên khách TikTok,
 *   tin nhắn hỗ trợ...) thì script lạ cũng không chạy được để lấy token trong localStorage.
 *   connect-src để rộng vì web cho phép tự nhập địa chỉ server khác (Tôi › Đồng bộ Web & App).
 * - frame-ancestors / X-Frame-Options: trang khác không nhúng được trang này để lừa bấm nút khoá, xoá tài khoản.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob:",
  'connect-src * data: blob:',
  "frame-src 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'"
].join('; ');

export function securityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  // Chỉ khi đi qua HTTPS (Funnel, Caddy): trình duyệt nhớ luôn dùng HTTPS, không bị hạ xuống http.
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  next();
}
