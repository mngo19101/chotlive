/** Cấu hình lấy từ biến môi trường và các hằng số dùng chung của server. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Thư mục gốc của dự án: nơi có server.js, public/ và data/. */
export const ROOT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export const PORT = process.env.PORT || 3000;
/** Trên VPS đặt 127.0.0.1 để chỉ Caddy nối được vào, không ai đi vòng qua HTTPS. */
export const HOST = process.env.HOST || undefined;
/**
 * Chỉ bật khi server chạy trong cùng mạng với máy in (laptop, mini PC).
 * Tắt trên VPS: in LAN cho server tự mở kết nối tới địa chỉ nội bộ theo yêu cầu của người dùng.
 */
export const LAN_MODE = process.env.LAN_MODE === '1';
export const SIGN_API_KEY = process.env.SIGN_API_KEY || undefined;
export const MIN_PASSWORD_LENGTH = 6;
export const MAX_PASSWORD_LENGTH = 128;
export const MAX_USERNAME_LENGTH = 32;
/** Dữ liệu đồng bộ lần đầu của một shop lớn vẫn lọt, gói lớn hơn thì coi là bất thường. */
export const MAX_WS_MESSAGE_BYTES = 32 * 1024 * 1024;
export const TOKEN_TTL_MS = (Number(process.env.TOKEN_TTL_DAYS) || 30) * 24 * 60 * 60 * 1000;
/** Số bình luận mới nhất giữ sẵn trong dữ liệu đồng bộ. Toàn bộ nằm trong bảng live_comments. */
export const COMMENT_WINDOW = 500;
export const MAX_LIVES_PER_USER = 10;
export const SESSION_RESUME_MS = 5 * 60 * 1000;

export const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT_DIR, 'data');
export const USERS_FILE = path.join(DATA_DIR, 'users.json');
export const STATES_FILE = path.join(DATA_DIR, 'sync-states-by-user.json');
