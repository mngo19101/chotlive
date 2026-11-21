/**
 * Ghi nhớ những gì đã đổi trên máy mà server chưa xác nhận đã nhận.
 * Nhờ đó khi có mạng lại, dữ liệu server tải về không xoá mất đơn vừa tạo lúc mất mạng;
 * ngược lại đơn thiết bị khác tạo trong lúc đó cũng không bị máy này ghi đè.
 *
 * Chỉ lưu danh sách mã, nội dung đã nằm sẵn trong dữ liệu lưu trên máy.
 */
export const TRACKED = ['orders', 'customers', 'accounts'];

/** Danh sách mới đưa lên đầu, riêng ID TikTok thêm vào cuối như khi tạo. */
const APPEND_NEW = new Set(['accounts']);

/** Cài đặt riêng của từng máy, không gửi lên server. */
const DEVICE_SETTINGS = new Set(['serverUrl', 'accounts']);

export function emptyPending(owner = '') {
  return { owner, changes: {}, settings: [] };
}

/** Các mục cài đặt máy này vừa đổi mà server chưa nhận. */
export const pendingSettingKeys = (pending) => (Array.isArray(pending?.settings) ? pending.settings : []);

export function snapshotOf(state) {
  const snap = {};
  for (const coll of TRACKED) {
    const byId = new Map();
    for (const it of Array.isArray(state?.[coll]) ? state[coll] : []) {
      if (it && it.id != null) byId.set(String(it.id), JSON.stringify(it));
    }
    snap[coll] = byId;
  }
  // Cài đặt cũng tính theo từng mục: gửi cả bộ thì máy đang giữ bản cũ sẽ ghi đè mục máy khác vừa đổi.
  const settings = new Map();
  for (const [k, v] of Object.entries(state?.settings || {})) {
    if (!DEVICE_SETTINGS.has(k)) settings.set(k, JSON.stringify(v));
  }
  snap.settings = settings;
  return snap;
}

/** So hai ảnh chụp rồi cộng dồn phần khác vào `pending`. Trả về true nếu có thay đổi mới. */
export function recordChanges(pending, base, next) {
  let changed = false;
  for (const coll of TRACKED) {
    const upsert = new Set(pending.changes[coll]?.upsert || []);
    const remove = new Set(pending.changes[coll]?.remove || []);
    for (const [id, json] of next[coll]) {
      if (base[coll].get(id) === json) continue;
      upsert.add(id);
      remove.delete(id);
      changed = true;
    }
    for (const id of base[coll].keys()) {
      if (next[coll].has(id)) continue;
      remove.add(id);
      upsert.delete(id);
      changed = true;
    }
    if (upsert.size || remove.size) pending.changes[coll] = { upsert: [...upsert], remove: [...remove] };
    else delete pending.changes[coll];
  }
  const keys = new Set(pendingSettingKeys(pending));
  for (const [k, json] of next.settings || []) {
    if (base.settings?.get(k) === json || keys.has(k)) continue;
    keys.add(k);
    changed = true;
  }
  pending.settings = [...keys];
  return changed;
}

export function countPending(pending) {
  let n = 0;
  for (const c of Object.values(pending?.changes || {})) n += c.upsert.length + c.remove.length;
  return n + pendingSettingKeys(pending).length;
}

/**
 * Danh sách từ server + thay đổi chưa gửi của máy này.
 * Bản ghi không bị máy này đụng tới thì theo server, kể cả bản ghi thiết bị khác vừa thêm hay xoá.
 */
export function overlayPending(coll, remote, local, pending) {
  const change = pending?.changes?.[coll];
  if (!change) return remote;
  const removed = new Set(change.remove);
  const mine = new Map();
  const wanted = new Set(change.upsert);
  for (const it of Array.isArray(local) ? local : []) {
    if (it && wanted.has(String(it.id))) mine.set(String(it.id), it);
  }
  const seen = new Set();
  const merged = [];
  for (const it of remote) {
    const id = String(it?.id);
    if (removed.has(id)) continue;
    seen.add(id);
    merged.push(mine.get(id) || it);
  }
  const added = [...mine.entries()].filter(([id]) => !seen.has(id)).map(([, it]) => it);
  return APPEND_NEW.has(coll) ? [...merged, ...added] : [...added, ...merged];
}
