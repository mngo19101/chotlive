/**
 * BL-03 + BL-11: tiền thu hộ (COD) gửi Viettel Post.
 * - Máy chủ không tin nguyên `cod` client gửi: sai kiểu / ngoài khoảng thì từ chối (không ép thành 0đ hay 450đ),
 *   lệch với số tính từ đơn trên máy chủ thì từ chối.
 * - Máy chủ lưu đúng số đã gửi Viettel Post (`vtpCod`, `vtpGoods`) vào order.ship; webhook đổi cước không đổi số đó.
 * Chạy server thật với Viettel Post giả, không gọi dịch vụ ngoài.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chotlive-vtpcod-'));
const PORT = 4400 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Mọi lần tạo vận đơn Viettel Post giả nhận được (nội dung gửi lên). */
const sent = [];
/** Mọi lần hỏi cước (báo giá) Viettel Post giả nhận được. */
const quoted = [];
const fakeVtp = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const send = (o) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(o));
    const okData = (data) => send({ status: 200, error: false, message: 'OK', data });
    if (req.url === '/wards') return send([]);
    if (req.url === '/v2/user/LoginVTP') return okData({ token: 'partner', phone: '0900000000', userId: 1 });
    if (req.url === '/v2/user/listInventory') return okData([{ groupaddressId: 1, name: 'Shop', phone: '0900000000', address: '1 Lê Lợi, Phường Thuận Hoá, TP.Huế' }]);
    if (req.url === '/v2/order/getPriceNlp' || req.url === '/v2/order/getPriceAllNlp') {
      quoted.push({ url: req.url, ...JSON.parse(body || '{}') });
      return okData({ MONEY_TOTAL: 22000 });
    }
    if (req.url === '/v2/order/createOrderNlp') {
      sent.push(JSON.parse(body || '{}'));
      return okData({ ORDER_NUMBER: 'COD' + (100000 + sent.length), MONEY_TOTAL: 25000 });
    }
    send({ status: 404, error: true, message: 'no' });
  });
});

let server;
let token;
async function api(pathname, body) {
  const res = await fetch(BASE + pathname, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, body: await res.json() };
}

before(async () => {
  await new Promise((r) => fakeVtp.listen(0, '127.0.0.1', r));
  const vtpBase = `http://127.0.0.1:${fakeVtp.address().port}`;
  server = spawn(process.execPath, ['--no-warnings', '--import', './test/fake-tiktok/register.js', 'server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATA_DIR, ADMIN_PASSWORD: 'admin-test', LAN_MODE: '', VTP_BASE: vtpBase, VTP_WARDS_URL: vtpBase + '/wards' },
    stdio: 'ignore'
  });
  for (let i = 0; i < 200; i++) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) break;
    } catch {}
    await sleep(40);
  }
  const reg = await api('/api/auth/register', { username: 'shop.cod', password: 'mat-khau', confirmPassword: 'mat-khau' });
  token = reg.body.token;
  assert.ok(token);
  assert.equal((await api('/api/vtp/connect', { siteToken: 'site' })).status, 200);
  assert.equal((await api('/api/vtp/sender', { id: 1 })).status, 200);
});

after(async () => {
  if (server) {
    const gone = new Promise((r) => server.once('exit', r));
    server.kill('SIGTERM');
    await Promise.race([gone, sleep(3000)]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
  fakeVtp.close();
  await sleep(100);
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

let seq = 0;
const T0 = Date.now() - 3600_000;
function order(id, items, ship = {}, extra = {}) {
  seq += 1;
  return {
    id, code: 'HD' + id, uniqueId: extra.uniqueId || 'khach.' + id, nickname: 'Khách ' + id, status: 'printed', ts: T0 + seq * 1000,
    total: items.reduce((s, [price, qty = 1]) => s + price * qty, 0),
    items: items.map(([price, qty = 1], i) => ({ id: `${id}_it${i}`, name: 'Mã ' + price / 1000, price, qty })),
    ship: { state: 'ready', pay: 'cod', ...ship },
    ...extra
  };
}
async function putOrders(list) {
  const prev = (await api('/api/state')).body;
  const keep = ((prev.state || prev).orders || []).filter((o) => !list.some((x) => x.id === o.id));
  assert.equal((await api('/api/sync', { state: { orders: [...keep, ...list], customers: [] } })).status, 200);
}
const group = (key, orderIds, cod, more = {}) => ({
  key, orderIds, ref: key, receiver: 'Lan', phone: '0363000000', address: '12 Lê Lợi, Phường Thuỷ Xuân, TP.Huế',
  goodsName: 'Quần áo', qty: 1, weightG: 500, goods: 0, cod, ...more
});
const findOrder = async (id) => {
  const s = (await api('/api/state')).body;
  return (s.state || s).orders.find((o) => o.id === id);
};

test('COD sai kiểu hoặc ngoài khoảng: máy chủ từ chối, không tạo vận đơn, không ép về 0đ/450đ', async () => {
  await putOrders([order('bad', [[450000]])]);
  const bad = [null, '450.000', -1, '', 450000.5, 1e12, '450000', undefined, NaN, true, [450000], { v: 450000 }];
  for (const cod of bad) {
    const before = sent.length;
    const r = await api('/api/vtp/create', { service: 'VSL9', groups: [group('bad', ['bad'], cod)] });
    assert.equal(r.status, 200);
    const res = r.body.results[0];
    assert.equal(res.ok, false, `cod=${JSON.stringify(cod)} phải bị từ chối`);
    assert.match(res.error, /thu hộ/i);
    assert.equal(sent.length, before, `cod=${JSON.stringify(cod)}: không được gọi Viettel Post`);
  }
  const o = await findOrder('bad');
  assert.equal(o.ship.vtpCode, undefined);
  assert.match(o.ship.vtpError, /thu hộ/i, 'thẻ đơn hiện lý do');
});

test('COD đúng kiểu nhưng khác số tính từ đơn trên máy chủ: từ chối', async () => {
  await putOrders([order('lech', [[450000]])]);
  const before = sent.length;
  const r = await api('/api/vtp/create', { service: 'VSL9', groups: [group('lech', ['lech'], 450)] });
  assert.equal(r.body.results[0].ok, false);
  assert.match(r.body.results[0].error, /450\.000/, 'báo số máy chủ tính được');
  assert.equal(sent.length, before);
});

test('COD đúng: gửi đúng số, lưu vtpCod/vtpGoods; webhook đổi cước không đổi số đã lưu', async () => {
  await putOrders([order('dung', [[150000], [300000]])]);
  const r = await api('/api/vtp/create', { service: 'VSL9', groups: [group('dung', ['dung'], 450000, { goods: 1 })] });
  const res = r.body.results[0];
  assert.equal(res.ok, true, res.error);
  assert.equal(res.cod, 450000);
  const body = sent.at(-1);
  assert.equal(body.MONEY_COLLECTION, 450000);
  assert.equal(body.PRODUCT_PRICE, 450000, 'giá trị hàng lấy theo đơn trên máy chủ, không theo client');
  assert.equal(body.ORDER_PAYMENT, 2);
  let o = await findOrder('dung');
  assert.equal(o.ship.vtpCode, res.code);
  assert.equal(o.ship.vtpCod, 450000);
  assert.equal(o.ship.vtpGoods, 450000);

  const hook = new URL((await api('/api/vtp/status')).body.hookUrl).pathname;
  await api(hook, { DATA: { ORDER_NUMBER: res.code, ORDER_STATUS: 103, STATUS_NAME: 'Giao cho bưu cục', MONEY_TOTAL: 31000, ORDER_STATUSDATE: '11/11/2026 10:00:00' } });
  for (let i = 0; i < 100 && (await findOrder('dung')).ship.vtpStatus !== 103; i++) await sleep(40);
  o = await findOrder('dung');
  assert.equal(o.ship.vtpStatus, 103);
  assert.equal(o.ship.vtpCod, 450000, 'cước đổi nhưng số thu hộ đã gửi giữ nguyên');

  // Bấm lại: trả "already" kèm đúng số đã lưu.
  const again = await api('/api/vtp/create', { service: 'VSL9', groups: [group('dung', ['dung'], 450000)] });
  assert.equal(again.body.results[0].already, true);
  assert.equal(again.body.results[0].cod, 450000);
});

test('đơn nhỏ tính theo cước thật vừa báo giá: nhận COD = tiền hàng + cước đó, người gửi trả cước', async () => {
  await putOrders([order('nho', [[10000]])]);
  const r = await api('/api/vtp/create', { service: 'VSL9', groups: [group('nho', ['nho'], 32000, { senderPays: false })] });
  assert.equal(r.body.results[0].ok, true, r.body.results[0].error);
  const body = sent.at(-1);
  assert.equal(body.MONEY_COLLECTION, 32000);
  assert.equal(body.ORDER_PAYMENT, 3, 'đơn nhỏ: người gửi trả cước theo tính toán của máy chủ');
  assert.equal((await findOrder('nho')).ship.vtpCod, 32000);
  // Không báo giá được: tạm tính 17.000đ.
  await putOrders([order('nho2', [[10000]])]);
  assert.equal((await api('/api/vtp/create', { service: 'VSL9', groups: [group('nho2', ['nho2'], 27000)] })).body.results[0].ok, true);
  // Cước suy ra âm hoặc vô lý: từ chối.
  await putOrders([order('nho3', [[10000]])]);
  assert.equal((await api('/api/vtp/create', { service: 'VSL9', groups: [group('nho3', ['nho3'], 9000)] })).body.results[0].ok, false);
  assert.equal((await api('/api/vtp/create', { service: 'VSL9', groups: [group('nho3', ['nho3'], 50_000_000)] })).body.results[0].ok, false);
});

test('gộp nhiều đơn (có cọc, có đơn đã bank): COD theo cả nhóm, mọi đơn lưu cùng số đã gửi', async () => {
  const u = { uniqueId: 'khach.gop' };
  await putOrders([
    order('g1', [[100000]], { deposit: 20000 }, u),
    order('g2', [[50000], [25000, 2]], {}, u),
    order('g3', [[80000]], { pay: 'paid' }, u)
  ]);
  // Chưa bank: 100.000 + 100.000 - cọc 20.000 = 180.000
  const wrong = await api('/api/vtp/create', { service: 'VSL9', groups: [group('gop', ['g1', 'g2', 'g3'], 260000)] });
  assert.equal(wrong.body.results[0].ok, false, 'cộng cả đơn đã bank là sai');
  const r = await api('/api/vtp/create', { service: 'VSL9', groups: [group('gop', ['g1', 'g2', 'g3'], 180000)] });
  assert.equal(r.body.results[0].ok, true, r.body.results[0].error);
  assert.equal(sent.at(-1).MONEY_COLLECTION, 180000);
  assert.equal(sent.at(-1).PRODUCT_PRICE, 280000);
  for (const id of ['g1', 'g2', 'g3']) assert.equal((await findOrder(id)).ship.vtpCod, 180000, id);
});

test('COD sửa tay trong nháp vận đơn: chỉ nhận số đã sửa (đã đồng bộ lên máy chủ)', async () => {
  await putOrders([order('tay', [[150000]], { codOverride: 200000 })]);
  const auto = await api('/api/vtp/create', { service: 'VSL9', groups: [group('tay', ['tay'], 150000)] });
  assert.equal(auto.body.results[0].ok, false, 'số tự tính cũ không còn đúng khi đã sửa tay');
  const r = await api('/api/vtp/create', { service: 'VSL9', groups: [group('tay', ['tay'], 200000)] });
  assert.equal(r.body.results[0].ok, true, r.body.results[0].error);
  assert.equal(sent.at(-1).MONEY_COLLECTION, 200000);
  assert.equal((await findOrder('tay')).ship.vtpCod, 200000);
  // Sửa tay dưới ngưỡng ship: người gửi trả cước, cộng cước vào số đã sửa.
  await putOrders([order('tay2', [[150000]], { codOverride: 5000 })]);
  const s = await api('/api/vtp/create', { service: 'VSL9', groups: [group('tay2', ['tay2'], 5000 + 17000)] });
  assert.equal(s.body.results[0].ok, true, s.body.results[0].error);
  assert.equal(sent.at(-1).ORDER_PAYMENT, 3);
});

test('app gửi mã món (itemIds) thay vì mã đơn: tính COD từ đơn chứa các món đó', async () => {
  await putOrders([order('app', [[120000]])]);
  const g = group('app', [], 120000);
  delete g.orderIds;
  g.itemIds = ['app_it0'];
  const r = await api('/api/vtp/create', { service: 'VSL9', groups: [g] });
  assert.equal(r.body.results[0].ok, true, r.body.results[0].error);
  assert.equal((await findOrder('app')).ship.vtpCod, 120000);
});

test('web gửi lại bản đơn cũ (chưa có vtpCod): máy chủ giữ số đã lưu', async () => {
  const stale = { ...(await findOrder('dung')) };
  stale.ship = { state: 'ready', pay: 'cod' };
  stale.status = 'printed';
  await putOrders([stale]);
  assert.equal((await findOrder('dung')).ship.vtpCod, 450000);
});

test('đồng bộ xuống app mang vtpCod/vtpGoods; đơn cũ chưa lưu thì không có (app tự tính như trước)', async () => {
  const { nativeShipOut } = await import('../native-sync.js');
  const { keepServerVtp } = await import('../vtp.js');
  const out = nativeShipOut({ state: 'exported', vtpCode: 'X12345', vtpFee: 25000, vtpCod: 32000, vtpGoods: 10000 });
  assert.equal(out.vtpCod, 32000);
  assert.equal(out.vtpGoods, 10000);
  const legacy = nativeShipOut({ state: 'exported', vtpCode: 'X12345', vtpFee: 25000 });
  assert.equal('vtpCod' in legacy, false);
  const kept = keepServerVtp([{ id: 'a', ship: { vtpCode: 'X', vtpCod: 1000, vtpGoods: 900 } }], [{ id: 'a', ship: { vtpCode: 'X' } }]);
  assert.equal(kept[0].ship.vtpCod, 1000);
  assert.equal(kept[0].ship.vtpGoods, 900);
});

test('checkGroupCod: hàm thuần', async () => {
  const { checkGroupCod } = await import('../vtp.js');
  const o = (total, ship = {}, ts = 1) => ({ id: 'x' + ts, ts, items: [{ price: total, qty: 1 }], ship: { pay: 'cod', ...ship } });
  assert.deepEqual(
    (({ ok, cod, goods, senderPays }) => ({ ok, cod, goods, senderPays }))(checkGroupCod([o(450000)], 450000)),
    { ok: true, cod: 450000, goods: 450000, senderPays: false }
  );
  assert.equal(checkGroupCod([o(450000)], 450).ok, false);
  assert.equal(checkGroupCod([o(450000)], '450000').ok, false);
  assert.equal(checkGroupCod([o(450000)], null).ok, false);
  // Đơn mới nhất thắng khi các đơn đặt khác nhau, dù thứ tự truyền vào là mới trước.
  assert.equal(checkGroupCod([o(100000, { codOverride: 90000 }, 2), o(100000, { codOverride: 70000 }, 1)], 90000).ok, true);
  // Đã bank đủ + người nhận trả ship: chỉ thu cước.
  assert.equal(checkGroupCod([o(100000, { pay: 'paid', payer: 'receiver' })], 22000).ok, true);
  assert.equal(checkGroupCod([o(100000, { pay: 'paid', payer: 'sender' })], 0).ok, true);
  assert.equal(checkGroupCod([o(100000, { pay: 'paid', payer: 'sender' })], 22000).ok, false);
});

test('đơn từ app (đồng bộ qua native-sync): COD app tính khớp số máy chủ tính, cọc không bị cộng hai lần', async () => {
  const { checkGroupCod } = await import('../vtp.js');
  const { applyNativeUpdate } = await import('../native-sync.js');
  const ready = (over = {}) => ({ state: 'ready', pay: 'cod', ...over });
  const it = (id, price, groupId, ts, ship, qty = 1) => ({
    id, comment: 'Chốt', price, qty, ts, printed: true, delivered: false, shipping: false, sessionId: groupId, groupId, commentId: id, ship
  });
  const st = { orders: [], customers: [] };
  // App: phiên s1 hai món 120.000 + 80.000, cọc 50.000 (app gửi cùng `ship` trên mọi món của đơn); phiên s2 một món 60.000 x2.
  applyNativeUpdate(st, {
    customers: [{
      id: 'mai.pham', uniqueId: 'mai.pham', userId: '1', nickname: 'Mai',
      items: [
        it('m1', 120000, 's1', 1794000500000, ready({ deposit: 50000 })),
        it('m2', 80000, 's1', 1794000600000, ready({ deposit: 50000 })),
        it('m3', 60000, 's2', 1794100000000, ready(), 2)
      ]
    }]
  });
  const orders = st.orders.filter((o) => o.items.some((x) => ['m1', 'm2', 'm3'].includes(String(x.id))));
  assert.equal(orders.length, 2);
  // App (VtpExport.summarize): 200.000 + 120.000 - cọc 50.000.
  const r = checkGroupCod(orders, 270000);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.goods, 320000);
});

test('báo giá: COD sai kiểu hoặc ngoài khoảng thì báo lỗi, không hỏi Viettel Post với COD bị ép về 0đ/450đ', async () => {
  const q = (cod) => api('/api/vtp/quote', { service: 'VSL9', groups: [group('q', ['q'], cod)] });
  for (const cod of [null, '450.000', -1, '', 450000.5, 1e12, '450000', undefined, true]) {
    const before = quoted.length;
    const r = await q(cod);
    assert.equal(r.status, 200);
    const res = r.body.results[0];
    assert.equal(res.ok, false, `cod=${JSON.stringify(cod)} phải bị từ chối`);
    assert.match(res.error, /thu hộ/i);
    assert.equal(quoted.length, before, `cod=${JSON.stringify(cod)}: không được hỏi Viettel Post`);
  }
  const ok = await q(450000);
  assert.equal(ok.body.results[0].ok, true, ok.body.results[0].error);
  assert.equal(ok.body.results[0].fee, 22000);
  const asked = quoted.filter((x) => x.url === '/v2/order/getPriceNlp').at(-1);
  assert.equal(asked.MONEY_COLLECTION, 450000, 'hỏi cước đúng số thu hộ');
  // 0đ (đơn đã chuyển khoản, shop trả ship) vẫn hợp lệ.
  assert.equal((await q(0)).body.results[0].ok, true);
});

/*
 * BL-10: app bấm tạo vận đơn khi món mới chốt chưa đồng bộ lên máy chủ. Máy chủ không được tạo vận đơn cho phần nó
 * biết với tiền thu hộ gồm cả món nó chưa có (với đơn nhỏ, phần chênh lọt qua như "cước thật"), kẻo món đó bị tách
 * sang đơn mới và thu tiền hai lần.
 */
test('BL-10: app gửi mã món máy chủ chưa có: từ chối, không gọi Viettel Post, không gắn mã', async () => {
  await putOrders([order('bl10a', [[30000]])]);
  const before = sent.length;
  // App tính COD cho A (30k) + M (50k) chưa đồng bộ = 80k. Máy chủ chỉ có A: phần 50k chênh từng lọt qua như
  // "cước thật" của đơn nhỏ (A < 50k nên thu hộ = 30k + 50k).
  const g = group('bl10', [], 80000);
  delete g.orderIds;
  g.itemIds = ['bl10a_it0', 'bl10m_it0'];
  const r = await api('/api/vtp/create', { service: 'VSL9', groups: [g] });
  assert.equal(r.body.results[0].ok, false);
  assert.match(r.body.results[0].error, /đồng bộ/);
  assert.equal(sent.length, before, 'không được gọi Viettel Post');
  const a = await findOrder('bl10a');
  assert.equal(a.ship.vtpCode, undefined);
  assert.equal(a.ship.vtpAttempt, undefined);

  // Món M lên tới máy chủ (cùng đơn A) thì tạo được, COD đủ cả hai món.
  const both = order('bl10a', [[30000], [50000]]);
  both.items[1].id = 'bl10m_it0';
  await putOrders([both]);
  const ok = await api('/api/vtp/create', { service: 'VSL9', groups: [g] });
  assert.equal(ok.body.results[0].ok, true, ok.body.results[0].error);
  assert.equal(sent.at(-1).MONEY_COLLECTION, 80000);
});

test('BL-10: web gửi mã đơn máy chủ chưa có: từ chối cả nhóm, không tạo vận đơn cho phần còn lại', async () => {
  await putOrders([order('bl10b', [[300000]])]);
  const before = sent.length;
  const r = await api('/api/vtp/create', { service: 'VSL9', groups: [group('bl10b', ['bl10b', 'bl10ghost'], 300000)] });
  assert.equal(r.body.results[0].ok, false);
  assert.match(r.body.results[0].error, /đồng bộ/);
  assert.equal(sent.length, before);
  assert.equal((await findOrder('bl10b')).ship.vtpCode, undefined);
});
