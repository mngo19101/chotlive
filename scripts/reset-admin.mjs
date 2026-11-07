/**
 * Đặt lại mật khẩu tài khoản admin theo biến ADMIN_PASSWORD (trong .env).
 * Tắt server trước khi chạy, rồi bật lại:
 *   node --env-file=.env scripts/reset-admin.mjs
 * Đăng nhập được rồi thì xoá dòng ADMIN_PASSWORD khỏi .env.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(root, 'data');
const password = process.env.ADMIN_PASSWORD || '';
if (password.length < 6) {
  console.error('ADMIN_PASSWORD chưa đặt hoặc ngắn hơn 6 ký tự. Kiểm tra file .env.');
  process.exit(1);
}

const db = new DatabaseSync(path.join(dataDir, 'susu.db'));
const rows = db.prepare('SELECT id, data FROM users').all();
const row = rows.find((r) => JSON.parse(r.data).role === 'admin');
if (!row) {
  console.error('Không thấy tài khoản admin trong dữ liệu.');
  process.exit(1);
}
const user = JSON.parse(row.data);
const salt = crypto.randomBytes(16).toString('hex');
user.passwordHash = `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;
user.locked = false;
db.prepare('UPDATE users SET data = ? WHERE id = ?').run(JSON.stringify(user), row.id);
console.log(`Đã đặt lại mật khẩu cho tài khoản "${user.username}". Giờ đăng nhập bằng mật khẩu trong ADMIN_PASSWORD, rồi xoá dòng đó khỏi .env.`);
db.close();
