/**
 * Lệnh đồng bộ hai máy. Xem hướng dẫn trong sync/README.md.
 *   agent          chạy nền: đồng bộ định kỳ (Task Scheduler gọi lệnh này khi bật máy)
 *   before-start   chạy ngay trước `npm start`; không có cấu hình thì bỏ qua, lỗi cũng không chặn server
 *   init           tạo cấu hình lần đầu (thêm --hub trên mini PC, --key <mã> nếu chưa có cấu hình)
 *   set-peer <địa chỉ>     thêm mini PC và thử kết nối
 *   status         xem tình trạng
 *   list           liệt kê các bản sao đang giữ
 *   restore <file> khôi phục từ một bản sao (phải tắt server trước)
 *   keep-mine      khi có xung đột: dùng bản máy này cho cả hai máy
 *   use-peer       khi có xung đột: dùng bản của máy kia cho cả hai máy
 *   show-key       in mã kết nối
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appRunning, createContext, inspectDb, log, readState, replaceDb, runCycle, startHub, updateState, verifySnapshot } from './core.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const configFile = process.env.SYNC_CONFIG ? path.resolve(process.env.SYNC_CONFIG) : path.join(here, 'config.json');
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(here, '..', 'data');

const readConfig = () => JSON.parse(fs.readFileSync(configFile, 'utf8'));
const writeConfig = (cfg) => fs.writeFileSync(configFile, `${JSON.stringify(cfg, null, 2)}\n`);
const context = () => createContext({ dataDir, config: readConfig() });

function requireConfig() {
  if (fs.existsSync(configFile)) return;
  console.error('Chưa có cấu hình. Chạy: node sync/sync.js init');
  process.exit(1);
}

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((a) => a.family === 'IPv4' && !a.internal)
    .map((a) => a.address);
}

const fmtTime = (ms) => (ms ? new Date(ms).toLocaleString('vi-VN') : 'chưa có');

const commands = {
  init(args) {
    const hub = args.includes('--hub');
    const keyArg = args.includes('--key') ? args[args.indexOf('--key') + 1] : '';
    const existing = fs.existsSync(configFile) ? readConfig() : null;
    if (hub && !existing && !keyArg) {
      console.error('Mini PC cần mã kết nối của laptop: node sync/sync.js init --hub --key <mã>');
      process.exit(1);
    }
    const cfg = {
      key: keyArg || existing?.key || randomBytes(32).toString('hex'),
      peerAddress: hub ? '' : existing?.peerAddress || '',
      peerPort: existing?.peerPort || 3100,
      serve: hub,
      port: existing?.port || 3100,
      intervalMinutes: existing?.intervalMinutes || 5,
      appPort: existing?.appPort || Number(process.env.PORT) || 3000
    };
    writeConfig(cfg);
    console.log(`Đã lưu cấu hình: ${configFile}`);
    if (hub) {
      console.log(`Tên máy: ${os.hostname()}`);
      console.log(`Địa chỉ IP: ${lanAddresses().join(', ') || 'không tìm thấy'}`);
    }
  },

  async 'set-peer'([address]) {
    requireConfig();
    if (!/^[\w.-]+(:\d+)?$/.test(address || '')) {
      console.error('Địa chỉ không hợp lệ. Ví dụ: node sync/sync.js set-peer 192.168.1.50');
      process.exit(1);
    }
    writeConfig({ ...readConfig(), peerAddress: address, serve: false });
    console.log(`Đã lưu mini PC: ${address}. Đang thử kết nối...`);
    const r = await runCycle(context());
    console.log(`[${r.code}] ${r.message}`);
  },

  async status() {
    requireConfig();
    const ctx = context();
    const st = readState(ctx);
    const local = inspectDb(ctx.dbFile);
    console.log(`Máy này: ${ctx.name} (${local.rows} dòng dữ liệu)`);
    console.log(`Vai trò: ${ctx.config.serve ? `mini PC, nhận kết nối ở cổng ${ctx.config.port}` : 'laptop, chủ động kết nối'}`);
    if (!ctx.config.serve) console.log(`Mini PC: ${ctx.config.peerAddress || 'chưa thêm'}`);
    console.log(`Server ChốtLive trên máy này: ${(await appRunning(ctx)) ? 'đang chạy' : 'đang tắt'}`);
    console.log(`Lần chạy gần nhất: ${fmtTime(st.last?.at)} - ${st.last?.message || 'chưa chạy'}`);
    console.log(`Lần đồng bộ thành công gần nhất: ${fmtTime(st.lastOkAt)}`);
    if (st.pending) console.log(`Đang chờ áp dụng: bản từ ${st.pending.from} (cần tắt server rồi npm start)`);
  },

  list() {
    requireConfig();
    const ctx = context();
    const labels = { received: 'Nhận từ máy kia', own: 'Tự lưu trên máy này', 'before-replace': 'Lưu trước khi bị thay' };
    for (const [dir, label] of Object.entries(labels)) {
      const full = path.join(ctx.workDir, dir);
      const files = fs.readdirSync(full).filter((f) => f.endsWith('.db')).sort().reverse();
      console.log(`\n${label}:`);
      if (!files.length) console.log('  (chưa có)');
      for (const f of files) {
        const file = path.join(full, f);
        console.log(`  ${file}  (${(fs.statSync(file).size / 1024 / 1024).toFixed(1)} MB)`);
      }
    }
  },

  async restore([file]) {
    requireConfig();
    if (!file || !fs.existsSync(file)) {
      console.error('Thiếu file. Xem danh sách bằng: node sync/sync.js list');
      process.exit(1);
    }
    const ctx = context();
    if (await appRunning(ctx)) {
      console.error('Server ChốtLive đang chạy. Hãy tắt server rồi chạy lại lệnh này.');
      process.exit(1);
    }
    const info = verifySnapshot(file);
    replaceDb(ctx, file);
    // Dữ liệu vừa khôi phục không được tự đè sang máy kia: người dùng phải chọn bằng keep-mine.
    updateState(ctx, { base: null, pending: null, force: null });
    log(ctx, `Đã khôi phục từ ${file}`);
    console.log(`Đã khôi phục ${info.rows} dòng dữ liệu. Bản cũ được lưu trong data/sync/before-replace.`);
    console.log('Muốn đưa bản này sang cả máy kia thì chạy thêm: node sync/sync.js keep-mine');
  },

  async 'keep-mine'() {
    requireConfig();
    updateState(context(), { force: 'mine' });
    const r = await runCycle(context());
    console.log(`[${r.code}] ${r.message}`);
  },

  async 'use-peer'() {
    requireConfig();
    updateState(context(), { force: 'peer' });
    const r = await runCycle(context());
    console.log(`[${r.code}] ${r.message}`);
  },

  'show-key'() {
    requireConfig();
    console.log(readConfig().key);
  },

  async 'before-start'() {
    if (!fs.existsSync(configFile)) return;
    // Mạng chậm cũng không được giữ server chờ lâu. Việc thay file là đồng bộ nên hẹn giờ không cắt ngang được.
    setTimeout(() => process.exit(0), 20000).unref();
    try {
      const r = await runCycle(context());
      if (['adopted', 'uploaded', 'conflict', 'guard-peer-shrank', 'guard-local-shrank'].includes(r.code)) {
        console.log(`[sync] ${r.message}`);
      }
    } catch (err) {
      console.error(`[sync] ${err.message}`);
    }
  },

  async agent() {
    requireConfig();
    const first = context();
    log(first, `Bắt đầu chạy nền trên ${first.name}`);
    if (first.config.serve) {
      await startHub(first);
      log(first, `Đang nhận kết nối ở cổng ${first.config.port}`);
    }
    const tick = async () => {
      let code = 'error';
      let minutes = 5;
      try {
        // Đọc lại cấu hình mỗi lượt để thêm mini PC xong là có tác dụng, không cần khởi động lại.
        const ctx = context();
        minutes = Number(ctx.config.intervalMinutes) || 5;
        ({ code } = await runCycle(ctx));
      } catch (err) {
        log(first, `Lỗi lượt đồng bộ: ${err.message}`);
      }
      // Mới bật máy mạng có thể chưa lên, nên khi chưa kết nối được thì thử lại sớm.
      setTimeout(tick, code === 'offline' ? 60000 : minutes * 60000);
    };
    await tick();
  }
};

const [command = 'status', ...args] = process.argv.slice(2);
if (!commands[command]) {
  console.error(`Không có lệnh "${command}". Các lệnh: ${Object.keys(commands).join(', ')}`);
  process.exit(1);
}
await commands[command](args);
