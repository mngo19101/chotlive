/**
 * Làm sạch dữ liệu thiết bị gửi lên trước khi đưa vào server.
 * Một phần tử sai kiểu (null, số...) không được làm hỏng cả danh sách, càng không được làm sập server.
 */
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const onlyObjects = (list) => (Array.isArray(list) ? list.filter(isObject) : []);
const onlyIds = (list) => (Array.isArray(list) ? list.filter((v) => typeof v === 'string' || typeof v === 'number') : []);

export { isObject };

function cleanOrders(list) {
  return onlyObjects(list).map((o) => {
    if (o.items === undefined) return o;
    const items = onlyObjects(o.items);
    return Array.isArray(o.items) && items.length === o.items.length ? o : { ...o, items };
  });
}

const CLEANERS = {
  orders: cleanOrders,
  customers: onlyObjects,
  comments: onlyObjects,
  sessions: onlyObjects,
  accounts: onlyObjects
};

/** Dữ liệu `sync_update` / `/api/sync`, và cả dữ liệu đã lưu từ trước khi có bước lọc này. */
export function cleanState(state) {
  const out = { ...state };
  for (const [key, clean] of Object.entries(CLEANERS)) {
    if (Array.isArray(out[key])) out[key] = clean(out[key]);
    else delete out[key];
  }
  return out;
}

/** Dữ liệu `native_update` từ app iOS. */
export function cleanNativeUpdate(update) {
  const out = { ...update };
  for (const key of ['comments', 'sessions', 'accounts']) {
    if (out[key] !== undefined) out[key] = onlyObjects(out[key]);
  }
  for (const key of ['deletedItemIds', 'deletedAccountIds', 'printedCommentIds']) {
    if (out[key] !== undefined) out[key] = onlyIds(out[key]);
  }
  if (out.customers !== undefined) {
    out.customers = onlyObjects(out.customers).map((c) => ({ ...c, items: onlyObjects(c.items) }));
  }
  return out;
}
