/** Hàm nhỏ dùng chung: chặn lỗi lan ra ngoài và đọc file JSON của bản cũ. */
import fs from 'node:fs';
import path from 'node:path';

/**
 * Lỗi khi xử lý một tin nhắn hay một sự kiện chỉ được ảnh hưởng tới chính nó:
 * server chạy chung cho mọi shop, không thể để một gói dữ liệu sai làm ngắt tất cả.
 */
export function safely(label, fn, onError) {
  return (...args) => {
    try {
      return fn(...args);
    } catch (err) {
      console.error(`[${label}]`, err);
      try {
        onError?.(...args);
      } catch {}
    }
  };
}

export function readLegacyJson(file) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.warn(`[migrate] Không đọc được ${path.basename(file)}:`, err.message);
  }
  return null;
}

export function archiveLegacyFile(file) {
  try {
    if (fs.existsSync(file)) fs.renameSync(file, `${file}.migrated`);
  } catch {}
}
