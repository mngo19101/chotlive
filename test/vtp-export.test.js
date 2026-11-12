import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildVtpRows,
  buildVtpXlsx,
  groupByCustomer,
  summarizeGroup,
  olderPendingOf,
  shipStateOf
} from '../public/js/vtp-export.js';
import { VTP_PROVINCES, VTP_WARDS_RAW, checkVtpAddress, vtpProvinceByName, vtpWardsOf } from '../public/js/vtp-address.js';
import { applyNativeUpdate } from '../native-sync.js';
import {
  VTP_OLD_PROVINCES,
  VTP_OLD_RAW,
  findVtpOldAddress,
  resolveVtpAddress,
  vtpOldDistrictsOf,
  vtpOldWardsOf
} from '../public/js/vtp-address-old.js';

const fnv = (s) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
};

const order = (over = {}) => ({
  id: 'o1',
  code: 'HD01',
  uniqueId: 'lan.anh',
  nickname: 'Lan Anh',
  status: 'new',
  ts: 1000,
  items: [{ name: 'Mã 24', price: 150000, qty: 1 }],
  ...over
});

const customer = {
  uniqueId: 'lan.anh',
  name: '🐨 Lan Anh 🍀',
  phone: '0912 345 678',
  province: 'TP.Hồ Chí Minh',
  ward: 'Phường Tân Định',
  street: '12 Trần Quang Khải',
  deliveryNote: 'Gọi trước khi giao'
};

test('danh mục Viettel Post: đủ 34 tỉnh và 3.321 phường/xã, đúng chuỗi gốc', () => {
  assert.equal(VTP_PROVINCES.length, 34);
  const total = VTP_PROVINCES.reduce((s, [id]) => s + vtpWardsOf(id).length, 0);
  assert.equal(total, 3321);
  // Mã băm FNV-1a của chuỗi lấy từ api.viettelpost.vn ngày 08/11/2026.
  let h = 2166136261;
  for (let i = 0; i < VTP_WARDS_RAW.length; i++) {
    h ^= VTP_WARDS_RAW.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  assert.equal(h, 1330529362);
  assert.ok(vtpWardsOf(2).includes('Phường Tân Định'));
  assert.ok(vtpWardsOf(4).includes('Đặc khu Hoàng Sa'));
});

test('tên tỉnh gõ tay vẫn tìm ra tỉnh Viettel Post; địa chỉ phải chọn đúng danh mục', () => {
  assert.equal(vtpProvinceByName('TP. Hồ Chí Minh')[1], 'TP.Hồ Chí Minh');
  // Chỉ để chọn sẵn khi mở bảng chọn; giá trị lưu vẫn là đúng tên Viettel Post "T.Thanh Hoá".
  assert.equal(vtpProvinceByName('Thanh Hóa')[1], 'T.Thanh Hoá');
  assert.equal(vtpProvinceByName('Bình Dương'), null); // tỉnh cũ đã sáp nhập: phải chọn lại
  assert.equal(checkVtpAddress(customer).ok, true);
  assert.equal(checkVtpAddress({ ...customer, ward: 'Phường Bến Nghé' }).ok, false);
  assert.equal(checkVtpAddress({ ...customer, street: ' ' }).ok, false);
});

test('đơn chưa có ship là chưa hỏi; đơn đã giao từ app không còn chờ gửi', () => {
  assert.equal(shipStateOf(order()), 'ask');
  assert.equal(shipStateOf(order({ status: 'shipping' })), 'gone');
  assert.equal(shipStateOf(order({ status: 'shipping', ship: { state: 'ready' } })), 'gone');
  assert.equal(shipStateOf(order({ status: 'cancelled', ship: { state: 'ready' } })), 'none');
  assert.equal(shipStateOf(order({ ship: { state: 'hold' } })), 'hold');
});

test('đơn cũ gom sau và đơn mới của cùng khách gộp thành một vận đơn, cộng tiền thu hộ', () => {
  const old = order({ id: 'o_old', code: 'HD05', ts: 500, ship: { state: 'ready', pay: 'cod' } });
  const now = order({ id: 'o_new', code: 'HD08', ts: 900, items: [{ name: 'Mã 30', price: 100000, qty: 2 }], ship: { state: 'ready', pay: 'cod' } });
  const other = order({ id: 'o_x', uniqueId: 'khac', ship: { state: 'ready' } });
  const groups = groupByCustomer([now, other, old], [customer], 'ready');
  const g = groups.find((x) => x.key === 'lan.anh');
  assert.deepEqual(g.orders.map((o) => o.id), ['o_old', 'o_new']);
  assert.equal(g.cod, 350000);
  assert.equal(g.qty, 3);
  assert.equal(g.receiver, 'Lan Anh');
  assert.equal(g.phone, '0912345678');
  assert.deepEqual(g.problems, []);
  // Khách không có hồ sơ địa chỉ thì bị chặn xuất.
  assert.ok(groups.find((x) => x.key === 'khac').problems.length > 0);
});

test('khách đã bank đủ: thu hộ 0đ, người gửi trả cước', () => {
  const g = groupByCustomer([order({ ship: { state: 'ready', pay: 'paid' } })], [customer], 'ready')[0];
  const row = buildVtpRows([g])[7];
  assert.equal(row[8], 150000); // giá trị hàng vẫn giữ để khai giá
  assert.equal(row[9], 0);
  assert.equal(row[18], 'Người gửi trả');
});

test('dòng Excel đúng thứ tự cột của file mẫu Viettel Post', () => {
  const g = groupByCustomer([order({ ship: { state: 'ready', pay: 'cod', weightG: 1500 } })], [customer], 'ready')[0];
  const rows = buildVtpRows([g]);
  assert.equal(rows[6][2], 'Tên người nhận (*)');
  assert.equal(rows[6][21], 'Thời gian giao');
  assert.deepEqual(rows[7].slice(0, 13), [
    1,
    'HD01',
    'Lan Anh',
    '0912345678',
    '12 Trần Quang Khải, Phường Tân Định, TP.Hồ Chí Minh',
    'Quần áo',
    1,
    1500,
    150000,
    150000,
    'Bưu kiện',
    null,
    'VSL9'
  ]);
  assert.equal(rows[7][13], null); // không dịch vụ cộng thêm (không SMS)
  assert.equal(rows[7][18], 'Người nhận trả');
  assert.equal(rows[7][19], 'Gọi trước khi giao');
  const bytes = buildVtpXlsx([g]);
  assert.equal(String.fromCharCode(bytes[0], bytes[1]), 'PK');
});

test('một khách một vận đơn: chỉ gộp đơn đã duyệt, đơn chưa duyệt / hẹn gom chỉ báo', () => {
  const held = order({ id: 'h', code: 'HD02', ts: 100, ship: { state: 'hold', pay: 'cod' } });
  const asked = order({ id: 'n', code: 'HD09', ts: 900 });
  const ready = order({ id: 'r', code: 'HD05', ts: 500, ship: { state: 'ready', pay: 'cod' } });
  const ready2 = order({ id: 'r2', code: 'HD07', ts: 700, ship: { state: 'ready', pay: 'cod' } });
  const sent = order({ id: 's', ts: 50, status: 'shipping', ship: { state: 'exported', exportedAt: 1 } });
  const onlyHeld = order({ id: 'x', uniqueId: 'khac', ship: { state: 'hold' } });
  const groups = groupByCustomer([asked, ready, ready2, held, sent, onlyHeld], [customer], 'ready');
  assert.equal(groups.length, 1); // khách chỉ có đơn gom sau thì chưa xuất
  const g = groups[0];
  assert.deepEqual(g.orders.map((o) => o.id), ['r', 'r2']);
  assert.deepEqual(g.otherPending.map((o) => o.id), ['h', 'n']);
  assert.equal(g.cod, 300000);
  assert.equal(buildVtpRows(groups)[7][1], 'HD05+HD07');
});

test('duyệt bank đủ + người gửi trả: đơn cũ bỏ tick không làm sai tiền thu hộ', () => {
  const old = order({ id: 'old', ts: 100, ship: { state: 'hold', pay: 'cod' } });
  const now = order({ id: 'now', ts: 900, ship: { state: 'ready', pay: 'paid', payer: 'sender' } });
  const g = groupByCustomer([now], [customer], 'ready', [old, now])[0];
  assert.deepEqual(g.orders.map((o) => o.id), ['now']);
  assert.equal(g.cod, 0);
  assert.equal(g.senderPays, true);
});

test('gộp đơn đã bank với đơn chưa trả: chỉ thu hộ phần chưa trả, khách trả ship', () => {
  const paidOld = order({ id: 'p', ts: 100, ship: { state: 'ready', pay: 'paid' } });
  const fresh = order({ id: 'f', ts: 200, items: [{ name: 'Mã 7', price: 80000, qty: 1 }], ship: { state: 'ready', pay: 'cod' } });
  const g = groupByCustomer([paidOld, fresh], [customer], 'ready')[0];
  assert.equal(g.pay, 'cod');
  assert.equal(g.goods, 230000);
  assert.equal(g.cod, 80000);
});

test('báo khi khách vừa có vận đơn xuất gần đây, tránh thành 2 lần ship', () => {
  const sent = order({ id: 's', status: 'shipping', ship: { state: 'exported', exportedAt: Date.now() - 3600000 } });
  const fresh = order({ id: 'f', ts: 2000, ship: { state: 'ready', pay: 'cod' } });
  const g = groupByCustomer([sent, fresh], [customer], 'ready')[0];
  assert.deepEqual(g.recentExported.map((o) => o.id), ['s']);
});

test('nhãn đơn cũ chỉ đếm đơn chưa gửi cũ hơn của cùng khách', () => {
  const a = order({ id: 'a', ts: 100, ship: { state: 'hold' } });
  const b = order({ id: 'b', ts: 200 });
  const sent = order({ id: 'c', ts: 50, status: 'shipping' });
  assert.deepEqual(olderPendingOf([a, b, sent], b).map((o) => o.id), ['a']);
  assert.deepEqual(olderPendingOf([a, b, sent], a), []);
});

test('danh mục cũ Viettel Post: 63 tỉnh, 701 quận/huyện, 10.396 phường/xã, đúng chuỗi gốc', () => {
  assert.equal(VTP_OLD_PROVINCES.length, 63);
  let d = 0;
  let w = 0;
  for (const [id] of VTP_OLD_PROVINCES) {
    for (const dist of vtpOldDistrictsOf(id)) {
      d += 1;
      w += vtpOldWardsOf(id, dist).length;
    }
  }
  assert.equal(d, 701);
  assert.equal(w, 10396);
  assert.equal(fnv(VTP_OLD_RAW), 3483464);
  assert.ok(vtpOldWardsOf(2, 'Q.1').includes('P.Bến Nghé'));
});

test('địa chỉ cũ viết kiểu nào cũng ra đúng tên Viettel Post và phường mới tương ứng', () => {
  // Cách viết lấy từ các đơn thật trong tài khoản Viettel Post (chỉ phần khu vực).
  const r = findVtpOldAddress({ ward: 'PHƯỜNG 10', district: 'QUẬN 10', province: 'THÀNH PHỐ HỒ CHÍ MINH' });
  assert.deepEqual([r.ward, r.district, r.province], ['P.10', 'Q.10', 'TP.Hồ Chí Minh']);
  assert.equal(r.newWard, 'Phường Vườn Lài');
  const hue = findVtpOldAddress({ ward: 'Phường Phú Bài', district: 'Thị xã Hương Thuỷ', province: 'TỈNH Thừa Thiên Huế' });
  assert.equal(hue.province, 'T.Thừa Thiên - Huế');
  assert.equal(hue.newProvince, 'TP.Huế');
  // Viettel Post viết "T.Nam Ðịnh" bằng chữ Ð lạ; gõ Đ thường vẫn nhận.
  assert.equal(findVtpOldAddress({ ward: 'Xã Trung Nghĩa', district: 'Huyện Ý Yên', province: 'Tỉnh Nam Định' }).province, 'T.Nam Ðịnh');
  // Xã đã lên phường: đơn cũ ghi X., danh mục ghi P.
  assert.equal(findVtpOldAddress({ ward: 'X.Bình Khê', district: 'TX.Đông Triều', province: 'T.Quảng Ninh' }).ward, 'P.Bình Khê');
  // "Quận 1" không được khớp nhầm phường "Phường 1" ở quận khác.
  assert.equal(findVtpOldAddress({ ward: 'Phường 1', district: 'Quận 1', province: 'TP. Hồ Chí Minh' }), null);
  assert.equal(findVtpOldAddress({ ward: 'X.Điền Lộc', district: 'H.Phong Điền', province: 'T.Thừa Thiên - Huế' }), null);
});

test('xuất Excel: địa chỉ cũ ghi 3 cấp đúng tên Viettel Post, địa chỉ mới 2 cấp', () => {
  const oldCust = { ...customer, ward: 'Phường Bến Nghé', district: 'Quận 1', province: 'TP. Hồ Chí Minh' };
  const g = groupByCustomer([order({ ship: { state: 'ready', pay: 'cod' } })], [oldCust], 'ready')[0];
  assert.deepEqual(g.problems, []);
  assert.equal(g.address.mode, 'old');
  assert.equal(buildVtpRows([g])[7][4], '12 Trần Quang Khải, P.Bến Nghé, Q.1, TP.Hồ Chí Minh');
  // Tên tỉnh viết theo app điện thoại ("TP. Hồ Chí Minh") vẫn ra tên Viettel Post.
  const r = resolveVtpAddress({ ...customer, province: 'TP. Hồ Chí Minh', district: '' });
  assert.equal(r.line, '12 Trần Quang Khải, Phường Tân Định, TP.Hồ Chí Minh');
  assert.equal(resolveVtpAddress({ ...oldCust, ward: 'Phường Tân Định 9' }).ok, false);
});

test('app gửi khu vực mới "Phường, Tỉnh": phần trước tỉnh là phường, không phải quận', () => {
  const state = { orders: [], customers: [] };
  applyNativeUpdate(state, {
    customers: [
      {
        id: 'lan.anh',
        uniqueId: 'lan.anh',
        nickname: 'Lan Anh',
        items: [],
        address: { receiver: 'Lan Anh', phone: '0912345678', street: '12 Trần Quang Khải', region: 'Phường Tân Định, TP.Hồ Chí Minh', note: '' }
      }
    ]
  });
  const c = state.customers[0];
  assert.equal(c.ward, 'Phường Tân Định');
  assert.equal(c.district, '');
  assert.equal(c.province, 'TP.Hồ Chí Minh');
});

test('đơn thu hộ dưới 17.000đ: người gửi trả cước, cộng 17.000đ vào tiền thu hộ', () => {
  const small = order({ items: [{ name: 'Mã 1', price: 10000, qty: 1 }], ship: { state: 'ready', pay: 'cod', payer: 'sender' } });
  const g = groupByCustomer([small], [customer], 'ready')[0];
  const row = buildVtpRows([g])[7];
  assert.equal(row[9], 27000);
  assert.equal(row[18], 'Người gửi trả');
  const big = order({ items: [{ name: 'Mã 1', price: 17000, qty: 1 }], ship: { state: 'ready', pay: 'cod', payer: 'sender' } });
  const rec = order({ items: [{ name: 'Mã 1', price: 10000, qty: 1 }], ship: { state: 'ready', pay: 'cod' } });
  const gr = groupByCustomer([rec], [customer], 'ready')[0];
  // Chọn người nhận trả nhưng đơn dưới 17.000đ: vẫn xuất người gửi trả, cộng phí ship vào COD.
  assert.equal(gr.cod, 27000);
  assert.equal(gr.senderPays, true);
  assert.equal(gr.forcedSender, true);
  assert.equal(buildVtpRows([gr])[7][18], 'Người gửi trả');
  const g2 = groupByCustomer([big], [customer], 'ready')[0];
  assert.equal(g2.cod, 17000);
  assert.equal(buildVtpRows([g2])[7][18], 'Người gửi trả');
});

test('đơn 0đ: người gửi trả thì thu hộ đúng phí ship; đã bank đủ + người nhận trả ship thì thu hộ 17.000đ, người gửi trả cước', () => {
  const zero = order({ items: [{ name: 'Mã 1', price: 0, qty: 1 }], ship: { state: 'ready', pay: 'cod', payer: 'sender' } });
  const g0 = groupByCustomer([zero], [customer], 'ready')[0];
  assert.equal(g0.cod, 17000);
  assert.equal(g0.senderPays, true);
  // Đã bank đủ + chọn người nhận trả ship: xuất người gửi trả cước, thu hộ 17.000đ tiền ship.
  const bank = order({ ship: { state: 'ready', pay: 'paid', payer: 'receiver' } });
  const g1 = groupByCustomer([bank], [customer], 'ready')[0];
  assert.equal(g1.cod, 17000);
  assert.equal(g1.senderPays, true);
  assert.equal(buildVtpRows([g1])[7][18], 'Người gửi trả');
  // Đã bank đủ + người gửi trả: COD 0đ.
  const bankSender = order({ ship: { state: 'ready', pay: 'paid', payer: 'sender' } });
  assert.equal(groupByCustomer([bankSender], [customer], 'ready')[0].cod, 0);
});

test('khách cọc trừ vào COD, nhập tay COD, chọn người trả cước', () => {
  const dep = order({ ship: { state: 'ready', pay: 'cod', deposit: 50000 } });
  assert.equal(groupByCustomer([dep], [customer], 'ready')[0].cod, 100000);
  const dep2 = order({ ship: { state: 'ready', pay: 'cod', deposit: 140000, payer: 'sender' } });
  const g2 = groupByCustomer([dep2], [customer], 'ready')[0];
  assert.equal(g2.cod, 27000); // còn 10.000đ < 17.000đ: cộng phí ship
  assert.equal(g2.senderPays, true);
  const manual = order({ ship: { state: 'ready', pay: 'cod', codOverride: 123000, payer: 'receiver' } });
  const g3 = groupByCustomer([manual], [customer], 'ready')[0];
  assert.equal(g3.cod, 123000);
  assert.equal(g3.senderPays, false);
  const sender = order({ ship: { state: 'ready', pay: 'cod', payer: 'sender' } });
  const g4 = groupByCustomer([sender], [customer], 'ready')[0];
  assert.equal(g4.cod, 150000);
  assert.equal(buildVtpRows([g4])[7][18], 'Người gửi trả');
});

test('thu hộ nhập tay dưới 17.000đ: người gửi trả cước, cộng 17.000đ vào số đã nhập', () => {
  // Hàng 150.000đ, nhập tay thu hộ 10.000đ, chọn người nhận trả: xuất người gửi trả, khách trả 27.000đ.
  const low = order({ ship: { state: 'ready', pay: 'cod', codOverride: 10000, payer: 'receiver' } });
  const g = groupByCustomer([low], [customer], 'ready')[0];
  assert.equal(g.cod, 27000);
  assert.equal(g.shipFee, 17000);
  assert.equal(g.senderPays, true);
  assert.equal(g.forcedSender, true);
  assert.equal(buildVtpRows([g])[7][18], 'Người gửi trả');
  // Nhập tay 0đ cũng vậy: khách trả đúng tiền ship.
  const zero = order({ ship: { state: 'ready', pay: 'cod', codOverride: 0, payer: 'sender' } });
  assert.equal(groupByCustomer([zero], [customer], 'ready')[0].cod, 17000);
  // Đơn nhỏ đã cộng ship (10.000 + 17.000) mà nhập tay đúng 27.000đ: giữ nguyên, không cộng lần nữa.
  const kept = order({ items: [{ name: 'Mã 1', price: 10000, qty: 1 }], ship: { state: 'ready', pay: 'cod', codOverride: 27000 } });
  const gk = groupByCustomer([kept], [customer], 'ready')[0];
  assert.equal(gk.cod, 27000);
  assert.equal(gk.senderPays, true);
  // Nhập tay đúng 17.000đ trở lên thì giữ nguyên người trả cước đã chọn.
  const edge = order({ ship: { state: 'ready', pay: 'cod', codOverride: 17000, payer: 'receiver' } });
  const ge = groupByCustomer([edge], [customer], 'ready')[0];
  assert.equal(ge.cod, 17000);
  assert.equal(ge.senderPays, false);
});

test('đơn hôm nay kéo theo đơn đã duyệt của ngày trước khi xuất, khách không có đơn hôm nay thì không', () => {
  const old = order({ id: 'old', ts: 100, ship: { state: 'ready', pay: 'cod' } });
  const today = order({ id: 'today', ts: 900, ship: { state: 'ready', pay: 'cod' } });
  const otherOld = order({ id: 'x', uniqueId: 'khac', ts: 100, ship: { state: 'ready' } });
  const all = [old, today, otherOld];
  const groups = groupByCustomer([today], [customer], 'ready', all);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].orders.map((o) => o.id), ['old', 'today']);
});

test('hàng từ 10kg: kích thước dài/rộng/cao ghi vào cột Dài, Rộng, Cao', () => {
  const o = { id: 'k1', code: 'HD1', uniqueId: 'kg', status: 'new', ts: 1, items: [{ price: 100000, qty: 1 }],
    ship: { state: 'ready', weightG: 12000, lengthCm: 50, widthCm: 40, heightCm: 30 } };
  const cust = { uniqueId: 'kg', name: 'Khách', phone: '0912345678', province: 'TP.Hà Nội', ward: 'Phường Cầu Giấy', street: '1 Trần Thái Tông' };
  const [g] = groupByCustomer([o], [cust], 'ready');
  assert.deepEqual(g.size, [50, 40, 30]);
  const row = buildVtpRows([g])[7];
  assert.deepEqual(row.slice(15, 18), [50, 40, 30]);
  assert.equal(row[7], 12000);
});

test('có cước thật Viettel Post: thu hộ thấp hơn cước đó thì người gửi trả cước, cộng đúng cước đó vào thu hộ', () => {
  const sum = (o, realFee) => summarizeGroup({ orders: [o], customer }, { realFee });
  // Hàng 17.500đ, cước thật 18.480đ: thấp hơn cước nên người gửi trả, khách trả 17.500 + 18.480.
  const near = order({ items: [{ name: 'Mã 1', price: 17500, qty: 1 }], ship: { state: 'ready', pay: 'cod', payer: 'receiver' } });
  assert.equal(sum(near).senderPays, false); // chưa có cước thật: tạm tính theo 17.000đ, chưa đổi
  const real = sum(near, 18480);
  assert.equal(real.senderPays, true);
  assert.equal(real.forcedSender, true);
  assert.equal(real.shipFee, 18480);
  assert.equal(real.cod, 35980);
  assert.equal(real.feeIsReal, true);
  // Hàng 10.000đ: cộng cước thật, không còn cộng 17.000đ cố định.
  const small = order({ items: [{ name: 'Mã 1', price: 10000, qty: 1 }], ship: { state: 'ready', pay: 'cod' } });
  assert.equal(sum(small).cod, 27000);
  assert.equal(sum(small, 18480).cod, 28480);
  // Hàng cao hơn cước thật: không đổi gì.
  const big = order({ ship: { state: 'ready', pay: 'cod', payer: 'receiver' } });
  assert.equal(sum(big, 18480).cod, 150000);
  assert.equal(sum(big, 18480).senderPays, false);
  // Thu hộ nhập tay thấp hơn cước thật: cộng cước thật vào số đã nhập.
  const manual = order({ ship: { state: 'ready', pay: 'cod', payer: 'receiver', codOverride: 18000 } });
  assert.equal(sum(manual, 18480).cod, 36480);
  assert.equal(sum(manual, 18480).senderPays, true);
  // Cước thật rẻ hơn 17.000đ: ngưỡng vẫn là 17.000đ, tiền cộng vào là cước thật.
  const cheap = order({ items: [{ name: 'Mã 1', price: 16900, qty: 1 }], ship: { state: 'ready', pay: 'cod' } });
  assert.equal(sum(cheap, 16800).cod, 33700);
  // Đã bank đủ, người nhận trả ship: thu hộ đúng cước thật.
  const bank = order({ ship: { state: 'ready', pay: 'paid', payer: 'receiver' } });
  assert.equal(sum(bank, 18480).cod, 18480);
});
