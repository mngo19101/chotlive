/**
 * rclone giả cho test: "đám mây" là thư mục FAKE_RCLONE_DIR, remote tên `fake:`.
 * Chỉ có các lệnh backup/core.js dùng: lsjson, copyto, deletefile. Có file FAIL trong thư mục thì mọi lệnh báo lỗi.
 */
import fs from 'node:fs';
import path from 'node:path';

const root = process.env.FAKE_RCLONE_DIR;
const args = process.argv.slice(2);
if (args[0] === '--config') args.splice(0, 2);
const [cmd, a, b] = args;
const fail = (msg, code = 1) => {
  console.error(`2026/01/01 00:00:00 ERROR : ${msg}`);
  process.exit(code);
};
const local = (p) => (p.startsWith('fake:') ? path.join(root, p.slice(5)) : p);

if (!root) fail('thiếu FAKE_RCLONE_DIR');
if (fs.existsSync(path.join(root, 'FAIL'))) fail('mất mạng (giả lập)');
if (cmd === 'lsjson') {
  if (!a.startsWith('fake:')) fail("didn't find section in config file");
  const dir = local(a);
  if (!fs.existsSync(dir)) fail('directory not found', 3);
  const rows = fs.readdirSync(dir).map((n) => ({ Name: n, Size: fs.statSync(path.join(dir, n)).size, IsDir: false }));
  console.log(JSON.stringify(rows));
} else if (cmd === 'copyto') {
  if (!fs.existsSync(local(a))) fail('directory not found', 3);
  fs.mkdirSync(path.dirname(local(b)), { recursive: true });
  fs.copyFileSync(local(a), local(b));
} else if (cmd === 'deletefile') {
  fs.rmSync(local(a));
} else {
  fail(`lệnh chưa hỗ trợ: ${cmd}`);
}
