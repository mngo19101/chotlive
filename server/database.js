/** Mở CSDL SQLite dùng chung cho cả server và dọn tin chat hỗ trợ cũ. */
import fs from 'node:fs';
import path from 'node:path';
import * as sqlite from '../db.js';
import * as support from '../support.js';
import { DATA_DIR } from './config.js';

if (!fs.existsSync(DATA_DIR)) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch {}
}

export const db = sqlite.openDb(path.join(DATA_DIR, 'susu.db'));
support.initSupport(db);
support.purgeOld(db);
setInterval(() => {
  try {
    support.purgeOld(db);
  } catch (err) {
    console.warn('[support] Lỗi dọn tin cũ:', err.message);
  }
}, 60 * 60 * 1000).unref();
