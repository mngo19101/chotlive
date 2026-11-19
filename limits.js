/**
 * Giới hạn dữ liệu một tài khoản được gửi lên server.
 * Server mở ra Internet và ai cũng tự đăng ký được, nên một tài khoản dùng thử
 * không được làm đầy ổ cứng hay bộ nhớ của máy chạy server.
 * Các mức đều rộng hơn nhiều so với một shop thật (vài trăm KB mỗi tài khoản).
 * Gói bị từ chối vẫn được ghi phần bình luận (xem saveDeviceCommentsOnly), nên bình luận có hạn mức riêng bên dưới.
 */
const MB = 1024 * 1024;

/** Ký tự tối đa của một bình luận (dùng chung với web). */
export { MAX_COMMENT_CHARS } from './public/js/price.js';
/** Số bình luận tối đa trong một gói: app chỉ gửi bình luận ở lần đồng bộ đầu, tối đa 5.000. */
export const MAX_COMMENTS_PER_MESSAGE = 5000;
/** Một bình luận (đã cắt nội dung) dài hơn mức này khi lưu dạng JSON là bất thường, bị bỏ. */
export const MAX_COMMENT_RECORD_CHARS = 4096;
/**
 * Bình luận mới (chưa có trên server) thiết bị được gửi lên trong một ngày. Bình luận live do server tự
 * nhận từ TikTok không tính; bình luận app gửi phần lớn đã có sẵn trên server nên cũng không tính.
 */
export const MAX_DEVICE_COMMENTS_PER_DAY = 20000;

/** Gói gửi lên trong một phút của một tài khoản: số lần và tổng dung lượng. */
export const SYNC_MESSAGES_PER_MINUTE = 600;
export const SYNC_BYTES_PER_MINUTE = 64 * MB;
/** Gói gửi khi chưa đăng nhập chỉ cần chứa token. */
export const MAX_UNAUTHENTICATED_WS_BYTES = 64 * 1024;
/** Mọi API trừ đồng bộ và in LAN. */
export const SMALL_JSON_LIMIT = '100kb';
export const SYNC_JSON_LIMIT = '10mb';

export const SYNC_TOO_FAST_MESSAGE = 'Thiết bị gửi dữ liệu quá nhiều trong một phút, vui lòng thử lại sau ít phút.';
