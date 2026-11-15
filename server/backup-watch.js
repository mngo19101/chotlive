/**
 * Tự sao lưu lên đám mây mỗi ngày và báo Admin qua Telegram khi sao lưu bị trễ.
 * Server chạy suốt nên việc hẹn giờ đặt ở đây, không cần Task Scheduler hay cron riêng.
 * Việc sao lưu chạy trong một tiến trình con (backup/cloud-backup.mjs) để không làm chậm bình luận đang về.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { configState, readStatus } from '../backup/core.js';

const HOUR = 60 * 60 * 1000;
const RETRY_MS = HOUR;
const ALERT_AGAIN_MS = 24 * HOUR;
const RUN_TIMEOUT_MS = 30 * 60 * 1000;

const fmtTime = (ms) => new Date(ms).toLocaleString('vi-VN');
const hoursAgo = (now, ms) => Math.max(1, Math.round((now - ms) / HOUR));

/** Đến giờ sao lưu chưa: chưa có bản nào hoặc bản gần nhất đã đủ cũ, và lần thử hỏng gần nhất đã cách đủ lâu. */
export function backupDue(status, cfg, now) {
  const lastOk = Number(status.lastSuccessAt) || 0;
  const lastTry = Number(status.lastAttemptAt) || 0;
  if (lastOk && now - lastOk < cfg.everyMs) return false;
  return !(lastTry > lastOk && now - lastTry < RETRY_MS);
}

/**
 * Có đang trễ không. Chưa từng có bản nào thì coi là trễ ngay khi lần thử đầu hỏng,
 * vì lúc đó shop chưa có bản sao nào trên đám mây.
 */
export function backupLate(status, cfg, now) {
  const lastOk = Number(status.lastSuccessAt) || 0;
  if (lastOk) return now - lastOk > cfg.alertMs;
  return Boolean(status.lastError);
}

export function lateMessage(status, cfg, now) {
  const lastOk = Number(status.lastSuccessAt) || 0;
  return [
    '⚠️ ChốtLive: sao lưu lên đám mây đang bị trễ.',
    lastOk ? `Bản sao gần nhất: ${fmtTime(lastOk)} (${hoursAgo(now, lastOk)} giờ trước).` : 'Chưa có bản sao nào trên đám mây.',
    status.lastError ? `Lỗi lần thử gần nhất: ${status.lastError}` : '',
    `Nơi lưu: ${cfg.remote}`,
    'Kiểm tra máy chạy server có mạng không và rclone còn đăng nhập Google Drive không. Server sẽ tự thử lại mỗi giờ.'
  ]
    .filter(Boolean)
    .join('\n');
}

const okMessage = (status, first) =>
  [
    first ? '✅ ChốtLive: đã bật sao lưu lên đám mây, bản đầu tiên đã lên.' : '✅ ChốtLive: sao lưu lên đám mây đã chạy lại bình thường.',
    `Bản sao mới nhất: ${status.lastFile} lúc ${fmtTime(status.lastSuccessAt)}.`,
    first ? 'Từ giờ nếu quá hạn mà không có bản sao mới, bạn sẽ nhận cảnh báo ở đây.' : ''
  ]
    .filter(Boolean)
    .join('\n');

/**
 * `runBackup()` chạy một lượt sao lưu (kết quả đọc lại từ file tình trạng).
 * `notify(text)` gửi tin cho Admin, trả về false nếu không gửi được.
 */
export function createBackupWatch({ cfg, runBackup, notify, now = () => Date.now(), log = console }) {
  const alertFile = path.join(cfg.dataDir, 'cloud-backup-alert.json');
  const readAlert = () => {
    try {
      return JSON.parse(fs.readFileSync(alertFile, 'utf8')) || {};
    } catch {
      return {};
    }
  };
  const writeAlert = (next) => {
    try {
      fs.writeFileSync(alertFile, JSON.stringify(next));
    } catch (err) {
      log.warn(`[backup] Không ghi được ${alertFile}: ${err.message}`);
    }
  };

  let busy = false;

  async function tick() {
    if (busy || !configState(cfg).enabled) return;
    busy = true;
    try {
      if (backupDue(readStatus(cfg.dataDir), cfg, now())) {
        try {
          await runBackup();
        } catch (err) {
          log.warn(`[backup] Lượt sao lưu lỗi: ${err.message}`);
        }
      }
      const status = readStatus(cfg.dataDir);
      const alert = readAlert();
      const t = now();
      if (backupLate(status, cfg, t)) {
        if (t - (Number(alert.alertedAt) || 0) < ALERT_AGAIN_MS) return;
        const text = lateMessage(status, cfg, t);
        log.warn(`[backup] ${text.replaceAll('\n', ' | ')}`);
        // Gửi không được thì lần kiểm tra sau gửi lại; không có Telegram thì chỉ ghi log mỗi ngày một lần.
        if ((await notify(text)) !== false) writeAlert({ ...alert, alertedAt: t });
      } else if (status.lastSuccessAt && (alert.alertedAt || !alert.firstOkSent)) {
        if ((await notify(okMessage(status, !alert.firstOkSent))) !== false) writeAlert({ firstOkSent: true, alertedAt: 0 });
      }
    } finally {
      busy = false;
    }
  }

  return { tick };
}

/** Chạy backup/cloud-backup.mjs trong tiến trình con, dùng đúng biến môi trường của server. */
function spawnBackup(rootDir, log) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--no-warnings', path.join(rootDir, 'backup', 'cloud-backup.mjs'), 'run'], {
      cwd: rootDir,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    let out = '';
    const keep = (d) => (out = (out + d).slice(-2000));
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => child.kill(), RUN_TIMEOUT_MS);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const lines = out.trim().split('\n').filter(Boolean);
      if (code === 0) {
        if (lines[0]) log.log(`[backup] ${lines[0]}`);
        resolve();
      } else {
        reject(new Error((lines[lines.length - 1] || `tiến trình sao lưu thoát với mã ${code}`).replace(/^Lỗi: /, '')));
      }
    });
  });
}

/** Gọi một lần lúc server khởi động. Chưa cấu hình thì không làm gì. */
export function startBackupWatch({ cfg, rootDir, notifyAdmin, log = console, firstDelayMs = 60 * 1000, everyMs = 10 * 60 * 1000 }) {
  const state = configState(cfg);
  if (!state.enabled) {
    if (state.problem) log.warn(`[backup] Sao lưu đám mây chưa chạy: ${state.problem}`);
    return null;
  }
  if (!notifyAdmin) log.warn('[backup] Chưa cấu hình bot Telegram: sao lưu vẫn chạy nhưng cảnh báo trễ chỉ ghi vào nhật ký.');
  const watch = createBackupWatch({
    cfg,
    runBackup: () => spawnBackup(rootDir, log),
    notify: async (text) => (notifyAdmin ? notifyAdmin(text) : true),
    log
  });
  const safeTick = () => watch.tick().catch((err) => log.warn(`[backup] ${err.message}`));
  setTimeout(safeTick, firstDelayMs).unref();
  setInterval(safeTick, everyMs).unref();
  log.log(`[backup] Tự sao lưu lên ${cfg.remote}, mỗi ${Math.round(cfg.everyMs / HOUR)} giờ một bản.`);
  return watch;
}
