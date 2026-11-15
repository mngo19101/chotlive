/**
 * Lệnh sao lưu lên đám mây. Xem hướng dẫn trong backup/README.md.
 *   run                    sao lưu ngay một bản (server tự gọi lệnh này mỗi ngày)
 *   status                 xem lần sao lưu gần nhất
 *   list                   liệt kê các bản sao đang có trên đám mây
 *   test-restore [tên]     tải một bản về, giải mã, kiểm tra. KHÔNG đụng tới dữ liệu đang dùng
 *   restore [tên] --yes    thay dữ liệu đang dùng bằng một bản sao (phải tắt server trước)
 * Không ghi tên thì dùng bản mới nhất.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appRunning, createContext, replaceDb, updateState } from '../sync/core.js';
import { configState, countsOf, countsText, fetchBackup, listRemote, loadConfig, readStatus, runBackup } from './core.js';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cfg = loadConfig(process.env, rootDir);

const fmtTime = (ms) => (ms ? new Date(ms).toLocaleString('vi-VN') : 'chưa có');
const fmtSize = (bytes) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

function requireEnabled() {
  const state = configState(cfg);
  if (state.enabled) return;
  console.error(state.problem || 'Chưa bật sao lưu đám mây. Làm theo backup/README.md để đặt BACKUP_RCLONE_REMOTE và BACKUP_PASSPHRASE.');
  process.exit(1);
}

const liveDbFile = () => path.join(cfg.dataDir, 'susu.db');

const commands = {
  async run() {
    requireEnabled();
    const r = await runBackup(cfg);
    console.log(`Đã sao lưu lên ${cfg.remote}: ${r.name} (${fmtSize(r.size)})`);
    console.log(`Trong bản sao: ${countsText(r.counts)}`);
    console.log(`Trên đám mây đang giữ ${r.kept} bản${r.removed ? `, vừa dọn ${r.removed} bản cũ` : ''}.`);
  },

  status() {
    const state = configState(cfg);
    if (!state.enabled) console.log(state.problem || 'Chưa bật sao lưu đám mây.');
    const st = readStatus(cfg.dataDir);
    console.log(`Lần sao lưu thành công gần nhất: ${fmtTime(st.lastSuccessAt)}${st.lastFile ? ` (${st.lastFile}, ${fmtSize(st.lastSize || 0)})` : ''}`);
    if (st.lastCounts) console.log(`Trong bản đó: ${countsText(st.lastCounts)}`);
    console.log(`Lần thử gần nhất: ${fmtTime(st.lastAttemptAt)}`);
    if (st.lastError) console.log(`Lỗi gần nhất (${fmtTime(st.lastErrorAt)}): ${st.lastError}`);
  },

  async list() {
    requireEnabled();
    const remote = await listRemote(cfg);
    if (!remote.length) return console.log(`Chưa có bản sao nào trong ${cfg.remote}.`);
    console.log(`${remote.length} bản sao trong ${cfg.remote} (mới nhất trước):`);
    for (const f of remote) console.log(`  ${f.name}  ${fmtSize(f.size).padStart(9)}  ${fmtTime(f.at)}`);
  },

  async 'test-restore'([name]) {
    requireEnabled();
    console.log('Đang tải bản sao từ đám mây về để thử...');
    const got = await fetchBackup(cfg, name);
    try {
      console.log(`Bản sao: ${got.entry.name} (${fmtSize(got.entry.size)}), tạo lúc ${fmtTime(got.entry.at)}`);
      console.log('Tải về: được. Giải mã bằng mật khẩu sao lưu: được. Kiểm tra CSDL: không lỗi.');
      console.log(`Trong bản sao:       ${countsText(got.counts)}`);
      if (fs.existsSync(liveDbFile())) console.log(`Dữ liệu đang dùng:   ${countsText(countsOf(liveDbFile()))}`);
      console.log('Kết luận: bản sao này khôi phục được. Dữ liệu đang dùng không bị đụng tới.');
    } finally {
      got.cleanup();
    }
  },

  async restore(args) {
    requireEnabled();
    const name = args.find((a) => !a.startsWith('--'));
    if (!args.includes('--yes')) {
      console.error('Lệnh này THAY dữ liệu đang dùng bằng một bản sao trên đám mây.');
      console.error('Tắt server trước, rồi chạy lại kèm --yes. Muốn chỉ thử mà không thay gì thì dùng lệnh test-restore.');
      process.exit(1);
    }
    const ctx = createContext({ dataDir: cfg.dataDir, config: { appPort: cfg.appPort } });
    if (await appRunning(ctx)) {
      console.error('Server ChốtLive đang chạy. Hãy tắt server rồi chạy lại lệnh này.');
      process.exit(1);
    }
    console.log('Đang tải bản sao từ đám mây...');
    const got = await fetchBackup(cfg, name);
    try {
      const hadData = fs.existsSync(ctx.dbFile);
      replaceDb(ctx, got.dbFile);
      // Giống lệnh khôi phục của sync: bản vừa khôi phục không được tự đè sang máy kia.
      if (fs.existsSync(ctx.stateFile)) updateState(ctx, { base: null, pending: null, force: null });
      console.log(`Đã khôi phục từ ${got.entry.name} (tạo lúc ${fmtTime(got.entry.at)}).`);
      console.log(`Dữ liệu sau khi khôi phục: ${countsText(got.counts)}`);
      if (hadData) console.log('Dữ liệu trước đó được giữ lại trong data/sync/before-replace.');
      console.log('Giờ có thể bật lại server.');
    } finally {
      got.cleanup();
    }
  }
};

const [name = '', ...args] = process.argv.slice(2);
const command = commands[name];
if (!command) {
  console.error('Lệnh: run | status | list | test-restore [tên] | restore [tên] --yes');
  process.exit(1);
}
try {
  await command(args);
} catch (err) {
  console.error(`Lỗi: ${err.message || err}`);
  process.exit(1);
}
