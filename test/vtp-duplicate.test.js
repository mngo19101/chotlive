/**
 * BL-01 + BL-02: không tạo trùng vận đơn khi không rõ Viettel Post đã tạo hay chưa.
 * - BL-01: Viettel Post tạo vận đơn nhưng trả lời quá hạn chờ (hoặc đứt mạng giữa chừng). Đơn phải bị khoá ở trạng thái
 *   "chưa rõ", không cho tạo lại; phản hồi về muộn thì mã vận đơn được gắn vào đơn.
 * - BL-02: Viettel Post hiểu sai địa chỉ, tự huỷ thất bại. Đơn phải mang mã vận đơn với cờ "cần huỷ", không cho tạo
 *   vận đơn thứ hai cho tới khi huỷ xong.
 * Chạy server thật với Viettel Post giả, KHÔNG gọi dịch vụ ngoài.
 *
 * Mặc định hạn chờ rút còn 300ms (VTP_TIMEOUT_MS) cho nhanh. Đặt BL_REAL_TIMEOUT=1 để chạy với hạn chờ thật 20 giây
 * (Viettel Post giả trả lời sau 21,5 giây): dùng để tái hiện lỗi trên code chưa sửa.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chotlive-vtpdup-'));
const PORT = 4500 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const REAL = process.env.BL_REAL_TIMEOUT === '1';
const TIMEOUT_MS = REAL ? 20000 : 300;
/** Viettel Post giả trả lời tạo đơn chậm hơn hạn chờ ngần này. */
const SLOW_MS = REAL ? 21500 : 1200;
const WAIT = { timeout: REAL ? 120000 : 30000 };

/* ---------------------------- Viettel Post giả ---------------------------- */
const WARDS = [
  { WARDS_ID: 7969, WARDS_ID_NEW: 49357, WARDS_NAME: 'P.Thuỷ Xuân', WARDS_NAME_NEW: 'Phường Thuỷ Xuân', PROVINCE_ID_NEW: 37, PROVINCE_NAME_NEW: 'Thành phố Huế' },
  { WARDS_ID: 1, WARDS_ID_NEW: 49823, WARDS_NAME: 'P.Hàng Buồm', WARDS_NAME_NEW: 'Phường Hoàn Kiếm', PROVINCE_ID_NEW: 1, PROVINCE_NAME_NEW: 'Thành phố Hà Nội' }
];
const WARD_LIST = [...WARDS, ...Array.from({ length: 1000 }, (_, i) => ({ WARDS_ID: 100000 + i, WARDS_ID_NEW: 60000 + i, WARDS_NAME: 'X', WARDS_NAME_NEW: 'Xã X', PROVINCE_ID_NEW: 1, PROVINCE_NAME_NEW: 'Tỉnh X' }))];

/** Cách Viettel Post giả cư xử; mỗi test tự đặt lại. */
const vtp = {
  /** Mọi vận đơn "đã tạo bên Viettel Post": { code, cod, alive }. */
  waybills: [],
  createDelayMs: 0,
  /** 'ok' | 'drop' (tạo xong rồi đứt kết nối, không trả lời) | 'reject' (từ chối, không tạo) */
  create: 'ok',
  /** 'ok' | 'fail' | 'already' */
  cancel: 'ok',
  cancelCalls: 0,
  /** Lần tạo đang chờ trả lời: test đợi cái này để biết Viettel Post đã nhận yêu cầu. */
  onCreate: null
};
const alive = () => vtp.waybills.filter((w) => w.alive);
function resetVtp() {
  Object.assign(vtp, { createDelayMs: 0, create: 'ok', cancel: 'ok', onCreate: null });
}

const fakeVtp = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    const json = body ? JSON.parse(body) : {};
    const send = (o) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(o));
    const okData = (data) => send({ status: 200, error: false, message: 'OK', data });
    if (req.url === '/wards') return send(WARD_LIST);
    if (req.url === '/v2/user/LoginVTP') return okData({ token: 'partner', phone: '0900000000', userId: 1 });
    if (req.url === '/v2/user/listInventory') return okData([{ groupaddressId: 1, name: 'Shop', phone: '0900000000', address: '1 Lê Lợi, Phường Thuận Hoá, TP.Huế' }]);
    if (req.url === '/v2/order/createOrderNlp') {
      if (vtp.create === 'reject') return send({ status: 200, error: true, message: 'Số điện thoại người nhận không hợp lệ' });
      // Viettel Post tạo vận đơn NGAY khi nhận yêu cầu; chỉ có câu trả lời là về chậm hoặc không về.
      const w = { code: 'VTP' + (1000 + vtp.waybills.length + 1), cod: json.MONEY_COLLECTION, alive: true };
      vtp.waybills.push(w);
      vtp.onCreate?.(w);
      const { create, createDelayMs } = vtp;
      if (create === 'drop') return setTimeout(() => req.socket.destroy(), 50);
      if (createDelayMs) await sleep(createDelayMs);
      const ward = /Hà Nội/.test(String(json.RECEIVER_ADDRESS)) ? 1 : 7969;
      if (res.destroyed) return;
      return okData({ ORDER_NUMBER: w.code, MONEY_TOTAL: 18480, RECEIVER_WARDS: ward });
    }
    if (req.url === '/v2/order/UpdateOrder') {
      vtp.cancelCalls += 1;
      const w = vtp.waybills.find((x) => x.code === json.ORDER_NUMBER);
      if (vtp.cancel === 'fail') return send({ status: 200, error: true, message: 'Hệ thống đang bận' });
      if (vtp.cancel === 'already' || (w && !w.alive)) return send({ status: 200, error: true, message: 'Đơn hàng đã hủy!' });
      if (w) w.alive = false;
      return send({ status: 200, error: false, message: 'OK', data: null });
    }
    send({ status: 404, error: true, message: 'no' });
  });
});

/* ------------------------------ Server thật ------------------------------- */
let server;
let token;
let vtpBase;
async function api(pathname, body) {
  const res = await fetch(BASE + pathname, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, body: await res.json() };
}

async function startServer() {
  server = spawn(process.execPath, ['--no-warnings', '--import', './test/fake-tiktok/register.js', 'server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(PORT), DATA_DIR, ADMIN_PASSWORD: 'admin-test', LAN_MODE: '', VTP_BASE: vtpBase, VTP_WARDS_URL: vtpBase + '/wards',
      ...(REAL ? {} : { VTP_TIMEOUT_MS: String(TIMEOUT_MS) }),
      // Phản hồi muộn được nghe thêm tối đa ngần này; tự thử huỷ lại sau 500ms rồi 500ms.
      VTP_LATE_MS: REAL ? '30000' : '4000',
      VTP_CANCEL_RETRY_MS: '500,500'
    },
    stdio: 'ignore'
  });
  for (let i = 0; i < 200; i++) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) return;
    } catch {}
    await sleep(40);
  }
  assert.fail('server không lên');
}
async function stopServer(signal = 'SIGTERM') {
  if (!server) return;
  const gone = new Promise((r) => server.once('exit', r));
  server.kill(signal);
  await Promise.race([gone, sleep(3000)]);
  if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
  server = null;
}

before(async () => {
  await new Promise((r) => fakeVtp.listen(0, '127.0.0.1', r));
  vtpBase = `http://127.0.0.1:${fakeVtp.address().port}`;
  await startServer();
  const reg = await api('/api/auth/register', { username: 'shop.dup', password: 'mat-khau', confirmPassword: 'mat-khau' });
  token = reg.body.token;
  assert.ok(token);
  assert.equal((await api('/api/vtp/connect', { siteToken: 'site' })).status, 200);
  assert.equal((await api('/api/vtp/sender', { id: 1 })).status, 200);
});

after(async () => {
  await stopServer();
  fakeVtp.closeAllConnections?.();
  fakeVtp.close();
  await sleep(100);
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

/* -------------------------------- Dữ liệu --------------------------------- */
let seq = 0;
const T0 = Date.now() - 3600_000;
function order(id, price = 150000, extra = {}) {
  seq += 1;
  return {
    id, code: 'HD' + id, uniqueId: extra.uniqueId || 'khach.' + id, nickname: 'Khách ' + id, status: 'printed', ts: T0 + seq * 1000, total: price,
    items: [{ id: `${id}_it`, name: 'Mã ' + price / 1000, price, qty: 1 }], ship: { state: 'ready', pay: 'cod' }, ...extra
  };
}
async function putOrders(list) {
  const prev = (await api('/api/state')).body;
  const keep = ((prev.state || prev).orders || []).filter((o) => !list.some((x) => x.id === o.id));
  assert.equal((await api('/api/sync', { state: { orders: [...keep, ...list], customers: [] } })).status, 200);
}
const HUE = '12 Lê Lợi, Phường Thuỷ Xuân, TP.Huế';
const group = (key, orderIds, cod, more = {}) => ({
  key, orderIds, ref: key, receiver: 'Lan', phone: '0363000000', address: HUE,
  goodsName: 'Quần áo', qty: 1, weightG: 500, goods: cod, cod, ...more
});
const create = async (...groups) => (await api('/api/vtp/create', { service: 'VSL9', groups })).body.results;
const findOrder = async (id) => {
  const s = (await api('/api/state')).body;
  return (s.state || s).orders.find((o) => o.id === id);
};
const until = async (fn, label, ms = REAL ? 40000 : 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(50);
  }
  assert.fail(`Quá giờ chờ: ${label}`);
};

/* ============================== Tái hiện lỗi ============================== */

test('BL-01: Viettel Post tạo vận đơn nhưng trả lời quá hạn chờ; shop bấm lại KHÔNG ra vận đơn thứ hai', WAIT, async () => {
  resetVtp();
  await putOrders([order('slow')]);
  vtp.createDelayMs = SLOW_MS;
  const n0 = vtp.waybills.length;

  const [first] = await create(group('slow', ['slow'], 150000));
  assert.equal(first.ok, false, 'hết hạn chờ thì chưa có mã để trả');
  assert.equal(vtp.waybills.length, n0 + 1, 'Viettel Post đã tạo vận đơn A');

  // Shop thấy báo lỗi, bấm tạo lại ngay.
  const [second] = await create(group('slow', ['slow'], 150000));
  assert.equal(vtp.waybills.length, n0 + 1, 'bấm lại thì Viettel Post KHÔNG được nhận thêm vận đơn thứ hai cho cùng đơn');
  assert.equal(second.ok, false);
  assert.equal(first.unknown, true, 'kết quả báo rõ là "chưa rõ", không phải thất bại');
  assert.equal(second.unknown, true);

  // Câu trả lời về muộn: mã vận đơn A được gắn vào đơn, đơn sang Đang giao.
  const code = vtp.waybills.at(-1).code;
  await until(async () => (await findOrder('slow')).ship.vtpCode === code, 'gắn mã từ phản hồi muộn');
  const o = await findOrder('slow');
  assert.equal(o.status, 'shipping');
  assert.equal(o.ship.state, 'exported');
  assert.equal(o.ship.vtpKind, 'created');
  assert.equal(o.ship.vtpCod, 150000);
  assert.equal(o.ship.vtpError, '');

  vtp.createDelayMs = 0;
  const [third] = await create(group('slow', ['slow'], 150000));
  assert.equal(third.already, true);
  assert.equal(third.code, code);
  assert.equal(vtp.waybills.length, n0 + 1);
});

test('BL-02: Viettel Post hiểu sai địa chỉ, tự huỷ thất bại; đơn giữ mã với cờ "cần huỷ", KHÔNG tạo được vận đơn thứ hai', WAIT, async () => {
  resetVtp();
  await putOrders([order('addr')]);
  vtp.cancel = 'fail';
  const n0 = vtp.waybills.length;
  const wrong = group('addr', ['addr'], 150000, { address: '12 Hàng Buồm, Phường Thuỷ Xuân, TP.Huế (Hà Nội)', expect: { province: 'TP.Huế', ward: 'Phường Thuỷ Xuân' } });

  const [first] = await create(wrong);
  assert.equal(first.ok, false);
  assert.equal(vtp.waybills.length, n0 + 1);
  const code = vtp.waybills.at(-1).code;
  assert.equal(vtp.waybills.at(-1).alive, true, 'vận đơn sai địa chỉ còn sống bên Viettel Post');

  // Shop sửa địa chỉ rồi tạo lại.
  const [second] = await create(group('addr', ['addr'], 150000));
  assert.equal(vtp.waybills.length, n0 + 1, 'vận đơn trước chưa huỷ được thì KHÔNG được tạo vận đơn thứ hai');
  assert.equal(second.ok, false);
  assert.match(second.error, new RegExp(code), 'báo rõ mã vận đơn cần huỷ');

  let o = await findOrder('addr');
  assert.equal(o.ship.vtpCode, code, 'đơn mang mã vận đơn còn sống');
  assert.equal(o.ship.vtpKind, 'needsCancel');
  assert.equal(o.status, 'shipping', 'đơn nằm ở Đang giao để shop thấy và huỷ');
  assert.match(o.ship.vtpNote, /Hoàn Kiếm/);

  // Thử huỷ lại (bấm tay): Viettel Post nhận, đơn về Chờ gửi và được tạo vận đơn mới.
  vtp.cancel = 'ok';
  assert.equal((await api('/api/vtp/cancel', { code })).status, 200);
  o = await findOrder('addr');
  assert.equal(o.ship.vtpCode, undefined);
  assert.equal(o.ship.vtpOldCode, code);
  assert.equal(o.ship.state, 'ready');
  const [third] = await create(group('addr', ['addr'], 150000));
  assert.equal(third.ok, true, third.error);
  assert.equal(alive().filter((w) => w.code === code || w.code === third.code).length, 1, 'chỉ còn một vận đơn sống cho đơn này');
});

/* ================================ Thử biên ================================ */

test('đứt mạng sau khi Viettel Post đã tạo: khoá "chưa rõ"; shop nhập mã tìm thấy trên Viettel Post thì đơn nhận mã đó', WAIT, async () => {
  resetVtp();
  await putOrders([order('drop')]);
  vtp.create = 'drop';
  const n0 = vtp.waybills.length;
  const [first] = await create(group('drop', ['drop'], 150000));
  assert.equal(first.ok, false);
  assert.equal(first.unknown, true);
  vtp.create = 'ok';
  const [second] = await create(group('drop', ['drop'], 150000));
  assert.equal(second.unknown, true);
  assert.equal(vtp.waybills.length, n0 + 1, 'không tạo thêm');
  let o = await findOrder('drop');
  assert.equal(o.ship.vtpKind, 'unknown');
  assert.equal(o.ship.vtpCode, undefined);
  assert.equal(o.ship.state, 'ready');
  assert.match(o.ship.vtpError, /chưa rõ/i);

  const code = vtp.waybills.at(-1).code;
  assert.equal((await api('/api/vtp/settle', { orderIds: ['drop'], code: 'x' })).status, 400, 'mã sai dạng');
  const r = await api('/api/vtp/settle', { orderIds: ['drop'], code });
  assert.equal(r.status, 200);
  o = await findOrder('drop');
  assert.equal(o.ship.vtpCode, code);
  assert.equal(o.ship.vtpKind, 'created');
  assert.equal(o.ship.vtpCod, 150000, 'giữ đúng số thu hộ đã gửi Viettel Post');
  assert.equal(o.status, 'shipping');
  assert.equal(o.ship.vtpAttempt, undefined);
  assert.equal((await api('/api/vtp/settle', { orderIds: ['drop'], none: true })).status, 400, 'đơn không còn chờ kiểm tra');
});

test('"chưa rõ": shop xác nhận Viettel Post không có vận đơn thì được tạo lại; khi còn đang nghe phản hồi muộn thì chưa cho', WAIT, async () => {
  resetVtp();
  await putOrders([order('none'), order('wait')]);
  vtp.create = 'drop';
  await create(group('none', ['none'], 150000));
  vtp.waybills.at(-1).alive = false; // coi như Viettel Post thật ra không giữ vận đơn này
  vtp.create = 'ok';
  assert.equal((await api('/api/vtp/settle', { orderIds: ['none'] })).status, 400, 'phải nói rõ: có mã, hoặc không có');
  assert.equal((await api('/api/vtp/settle', { orderIds: ['none'], none: true })).status, 200);
  let o = await findOrder('none');
  assert.equal(o.ship.vtpKind, undefined);
  assert.equal(o.ship.vtpError, '');
  const [again] = await create(group('none', ['none'], 150000));
  assert.equal(again.ok, true, again.error);

  // Viettel Post còn đang xử lý (chưa trả lời): chưa cho xác nhận "không có".
  vtp.createDelayMs = SLOW_MS;
  const [w] = await create(group('wait', ['wait'], 150000));
  assert.equal(w.unknown, true);
  const early = await api('/api/vtp/settle', { orderIds: ['wait'], none: true });
  assert.equal(early.status, 409);
  await until(async () => !!(await findOrder('wait')).ship.vtpCode, 'phản hồi muộn');
});

test('hai yêu cầu tạo cùng lúc cho cùng đơn khi Viettel Post chậm: chỉ một lần gọi Viettel Post', WAIT, async () => {
  resetVtp();
  await putOrders([order('race')]);
  vtp.createDelayMs = SLOW_MS;
  const n0 = vtp.waybills.length;
  const [[a], [b]] = await Promise.all([create(group('race', ['race'], 150000)), create(group('race', ['race'], 150000))]);
  assert.equal(vtp.waybills.length, n0 + 1);
  assert.deepEqual([a.unknown, b.unknown], [true, true]);
  await until(async () => (await findOrder('race')).ship.vtpCode === vtp.waybills.at(-1).code, 'phản hồi muộn');
});

test('gộp nhiều đơn một vận đơn: cả nhóm bị khoá, tạo riêng một đơn trong nhóm cũng không được; phản hồi muộn gắn mã cho cả nhóm', WAIT, async () => {
  resetVtp();
  await putOrders([order('m1', 100000, { uniqueId: 'khach.gop' }), order('m2', 200000, { uniqueId: 'khach.gop' })]);
  vtp.createDelayMs = SLOW_MS;
  const n0 = vtp.waybills.length;
  const [first] = await create(group('gop', ['m1', 'm2'], 300000));
  assert.equal(first.unknown, true);
  const [one] = await create(group('m2', ['m2'], 200000));
  assert.equal(one.unknown, true);
  assert.equal(vtp.waybills.length, n0 + 1);
  const code = vtp.waybills.at(-1).code;
  await until(async () => (await findOrder('m2')).ship.vtpCode === code, 'phản hồi muộn');
  const [o1, o2] = [await findOrder('m1'), await findOrder('m2')];
  assert.equal(o1.ship.vtpCode, code);
  assert.equal(o1.ship.vtpCod, 300000);
  assert.equal(o2.ship.vtpCod, 300000);
  assert.equal(o1.ship.batchId, o2.ship.batchId);
});

test('Viettel Post phản hồi chậm giữa lô: các khách sau chưa gửi, không bị khoá hàng loạt', WAIT, async () => {
  resetVtp();
  await putOrders([order('b1'), order('b2')]);
  vtp.createDelayMs = SLOW_MS;
  const n0 = vtp.waybills.length;
  const [r1, r2] = await create(group('b1', ['b1'], 150000), group('b2', ['b2'], 150000));
  assert.equal(r1.unknown, true);
  assert.equal(r2.ok, false);
  assert.equal(r2.unknown, undefined);
  assert.equal(vtp.waybills.length, n0 + 1, 'khách thứ hai chưa được gửi sang Viettel Post');
  assert.equal((await findOrder('b2')).ship.vtpKind, undefined);
  await until(async () => !!(await findOrder('b1')).ship.vtpCode, 'phản hồi muộn');
  vtp.createDelayMs = 0;
  const [again] = await create(group('b2', ['b2'], 150000));
  assert.equal(again.ok, true, again.error);
});

test('Viettel Post từ chối rõ ràng (trả lỗi): không khoá, sửa xong tạo lại được như cũ', WAIT, async () => {
  resetVtp();
  await putOrders([order('rej')]);
  vtp.create = 'reject';
  const n0 = vtp.waybills.length;
  const [first] = await create(group('rej', ['rej'], 150000));
  assert.equal(first.ok, false);
  assert.equal(first.unknown, undefined);
  assert.equal(first.error, 'Số điện thoại người nhận không hợp lệ');
  let o = await findOrder('rej');
  assert.equal(o.ship.vtpKind, undefined);
  assert.equal(o.ship.vtpAttempt, undefined);
  assert.equal(o.ship.vtpError, 'Số điện thoại người nhận không hợp lệ');
  vtp.create = 'ok';
  const [second] = await create(group('rej', ['rej'], 150000));
  assert.equal(second.ok, true, second.error);
  assert.equal(vtp.waybills.length, n0 + 1);
  o = await findOrder('rej');
  assert.equal(o.ship.vtpAttempt, undefined, 'không để lại dấu lần tạo');
});

test('cần huỷ: huỷ vận đơn mà Viettel Post báo đã huỷ từ trước thì đơn về Chờ gửi; huỷ lần nữa không lỗi', WAIT, async () => {
  resetVtp();
  await putOrders([order('twice')]);
  vtp.cancel = 'fail';
  await create(group('twice', ['twice'], 150000, { address: '12 Hàng Buồm, Phường Thuỷ Xuân, TP.Huế (Hà Nội)', expect: { province: 'TP.Huế', ward: 'Phường Thuỷ Xuân' } }));
  const code = vtp.waybills.at(-1).code;
  assert.equal((await findOrder('twice')).ship.vtpKind, 'needsCancel');
  // Webhook "đã tiếp nhận" về sau đó không được xoá cờ cần huỷ.
  const hook = new URL((await api('/api/vtp/status')).body.hookUrl).pathname;
  await api(hook, { DATA: { ORDER_NUMBER: code, ORDER_STATUS: 100, STATUS_NAME: 'Tiếp nhận đơn hàng từ đối tác', ORDER_STATUSDATE: '15/11/2026 10:00:00' } });
  await until(async () => (await findOrder('twice')).ship.vtpStatus === 100, 'ghi webhook');
  assert.equal((await findOrder('twice')).ship.vtpKind, 'needsCancel');

  vtp.cancel = 'already';
  const r = await api('/api/vtp/cancel', { code });
  assert.equal(r.status, 200);
  assert.equal(r.body.already, true);
  const o = await findOrder('twice');
  assert.equal(o.ship.vtpCode, undefined);
  assert.equal(o.ship.vtpOldCode, code);
  assert.equal(o.ship.vtpKind, 'cancelled');
  const again = await api('/api/vtp/cancel', { code });
  assert.equal(again.status, 200);
  assert.equal(again.body.already, true);
  assert.equal((await findOrder('twice')).ship.vtpOldCode, code);
});

test('cần huỷ: máy chủ tự thử huỷ lại ở nền, huỷ được thì đơn tự về Chờ gửi', WAIT, async () => {
  resetVtp();
  await putOrders([order('auto')]);
  vtp.cancel = 'fail';
  await create(group('auto', ['auto'], 150000, { address: '12 Hàng Buồm, Phường Thuỷ Xuân, TP.Huế (Hà Nội)', expect: { province: 'TP.Huế', ward: 'Phường Thuỷ Xuân' } }));
  const w = vtp.waybills.at(-1);
  assert.equal((await findOrder('auto')).ship.vtpCode, w.code);
  vtp.cancel = 'ok';
  await until(async () => (await findOrder('auto')).ship.vtpOldCode === w.code, 'tự huỷ lại');
  assert.equal(w.alive, false);
  const o = await findOrder('auto');
  assert.equal(o.ship.vtpCode, undefined);
  assert.equal(o.ship.state, 'ready');
});

test('máy chủ tắt đột ngột giữa lúc đang gọi Viettel Post: khởi động lại đơn ở trạng thái "chưa rõ", không tạo lại được', WAIT, async () => {
  resetVtp();
  await putOrders([order('crash')]);
  await sleep(400); // để lần ghi đơn mới xuống đĩa xong
  vtp.createDelayMs = 60000;
  const n0 = vtp.waybills.length;
  const got = new Promise((r) => (vtp.onCreate = r));
  const pending = create(group('crash', ['crash'], 150000)).catch(() => null);
  await got; // Viettel Post đã nhận yêu cầu và tạo vận đơn
  await stopServer('SIGKILL');
  await pending;
  resetVtp();

  await startServer();
  const o = await findOrder('crash');
  assert.ok(o, 'đơn còn đó');
  assert.equal(o.ship.vtpKind, 'unknown', 'dấu "đang tạo" đã ghi xuống đĩa trước khi gọi Viettel Post');
  assert.equal(o.ship.vtpCode, undefined);
  const [again] = await create(group('crash', ['crash'], 150000));
  assert.equal(again.unknown, true);
  assert.equal(vtp.waybills.length, n0 + 1, 'không tạo vận đơn thứ hai sau khi khởi động lại');
  // Shop kiểm trên Viettel Post, nhập mã.
  const code = vtp.waybills.at(-1).code;
  assert.equal((await api('/api/vtp/settle', { orderIds: ['crash'], code })).status, 200);
  assert.equal((await findOrder('crash')).ship.vtpCode, code);
});

test('chưa nối được tới Viettel Post (chưa gửi gì đi): là thất bại rõ ràng, không khoá', async () => {
  // Cổng đóng: mở rồi đóng ngay để chắc không ai nghe.
  const closed = await new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
  const prev = process.env.VTP_BASE;
  process.env.VTP_BASE = `http://127.0.0.1:${closed}`;
  const mod = await import('../vtp.js?closed-port');
  process.env.VTP_BASE = prev;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vtp-closed-'));
  try {
    const store = mod.createVtpStore(dir);
    store.set('u1', { siteToken: 's', partnerToken: 'p', sender: { name: 'Shop', phone: '0900000000', address: '1 Lê Lợi, Phường Thuận Hoá, TP.Huế' } });
    const r = await mod.vtpCreateOrder(store, 'u1', group('x', ['x'], 150000), 'VSL9', null);
    assert.equal(r.ok, false);
    assert.equal(r.unknown, undefined);
    assert.equal(r.late, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
