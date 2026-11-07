/**
 * Sao lưu CSDL khi server đang chạy và chỉ giữ các bản gần nhất.
 *   node deploy/backup.mjs [thư mục dữ liệu] [thư mục sao lưu] [số bản giữ lại]
 * VACUUM INTO tạo một bản nguyên vẹn dù server vẫn đang ghi.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dataDir = path.resolve(process.argv[2] || process.env.DATA_DIR || 'data');
const backupDir = path.resolve(process.argv[3] || path.join(dataDir, 'backups'));
const keep = Number(process.argv[4]) || 14;

const source = path.join(dataDir, 'susu.db');
if (!fs.existsSync(source)) {
  console.error(`Không thấy CSDL: ${source}`);
  process.exit(1);
}
fs.mkdirSync(backupDir, { recursive: true });

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const target = path.join(backupDir, `susu-${stamp}.db`);
const temp = `${target}.tmp`;
fs.rmSync(temp, { force: true });

const db = new DatabaseSync(source);
try {
  db.exec('PRAGMA busy_timeout = 15000');
  db.prepare('VACUUM INTO ?').run(temp);
} finally {
  db.close();
}

const copy = new DatabaseSync(temp, { readOnly: true });
const check = copy.prepare('PRAGMA integrity_check').get();
copy.close();
if (check.integrity_check !== 'ok') {
  fs.rmSync(temp, { force: true });
  console.error('Bản sao lưu bị lỗi, giữ nguyên các bản cũ.');
  process.exit(1);
}
fs.renameSync(temp, target);

const old = fs
  .readdirSync(backupDir)
  .filter((f) => /^susu-\d{8}-\d{6}\.db$/.test(f))
  .sort()
  .reverse()
  .slice(keep);
for (const f of old) fs.rmSync(path.join(backupDir, f));

console.log(`Đã sao lưu: ${target}`);
