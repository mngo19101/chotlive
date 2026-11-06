export const COLLECTIONS = ['orders', 'customers', 'comments', 'sessions', 'accounts'];
export const SCALAR_KEYS = [
  'isCleanAccount',
  'settings',
  'seq',
  'salesMetrics',
  'prints',
  'selectedCustomerUniqueId',
  'activeSessionId'
];

export function snapCollections(state) {
  const cols = {};
  let valid = true;
  for (const c of COLLECTIONS) {
    const arr = Array.isArray(state?.[c]) ? state[c] : [];
    const ids = [];
    const json = new Map();
    const items = new Map();
    arr.forEach((it, i) => {
      let id = it && it.id != null ? String(it.id) : null;
      if (id === null || json.has(id)) {
        valid = false;
        id = `#${i}`;
        while (json.has(id)) id += '_';
      }
      ids.push(id);
      json.set(id, JSON.stringify(it));
      items.set(id, it);
    });
    cols[c] = { ids, json, items };
  }
  return { cols, valid };
}

export function diffCollections(prev, next) {
  if (!prev.valid || !next.valid) return null;
  const out = {};
  for (const c of COLLECTIONS) {
    const p = prev.cols[c];
    const n = next.cols[c];
    const upsert = [];
    for (const id of n.ids) {
      if (p.json.get(id) !== n.json.get(id)) upsert.push(n.items.get(id));
    }
    const sameIds = p.ids.length === n.ids.length && p.ids.every((x, i) => x === n.ids[i]);
    if (upsert.length || !sameIds) {
      out[c] = sameIds ? { upsert } : { upsert, ids: n.ids };
    }
  }
  return out;
}

export function snapScalars(state) {
  const out = {};
  for (const k of SCALAR_KEYS) out[k] = JSON.stringify(state?.[k] ?? null);
  return out;
}

export function diffScalars(prev, state) {
  const out = {};
  for (const k of SCALAR_KEYS) {
    if (prev[k] !== JSON.stringify(state?.[k] ?? null)) out[k] = state?.[k];
  }
  return out;
}
