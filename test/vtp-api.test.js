import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVtpWebhook, applyVtpStatus, vtpStatusKind, vtpEventTime, clipBytes, keepServerVtp } from '../vtp.js';

const mk = () => ({
  orders: [
    { id: 'a', status: 'shipping', printCount: 1, ship: { state: 'exported', vtpCode: '181' } },
    { id: 'b', status: 'shipping', printCount: 0, ship: { state: 'exported', vtpCode: '181' } },
    { id: 'c', status: 'shipping', ship: { state: 'exported', vtpCode: '999' } }
  ]
});

test('đọc webhook lồng DATA và phẳng', () => {
  assert.equal(parseVtpWebhook({ DATA: { ORDER_NUMBER: '181', ORDER_STATUS: '501' } }).status, 501);
  assert.equal(parseVtpWebhook({ ORDER_NUMBER: '7', STATUS_NAME: 'x' }).code, '7');
  assert.equal(parseVtpWebhook({ DATA: {} }), null);
});

test('phân loại trạng thái', () => {
  assert.equal(vtpStatusKind(501), 'delivered');
  assert.equal(vtpStatusKind(506), 'attention');
  assert.equal(vtpStatusKind(504), 'returned');
  assert.equal(vtpStatusKind(107), 'cancelled');
  assert.equal(vtpStatusKind(300), 'moving');
});

test('giao thành công chuyển mọi đơn của vận đơn sang Đã giao', () => {
  const s = mk();
  assert.equal(applyVtpStatus(s, { code: '181', status: 501, statusName: 'Phát thành công', note: '', location: '' }), 2);
  assert.deepEqual(s.orders.map((o) => o.status), ['done', 'done', 'shipping']);
});

test('vận đơn bị huỷ: đơn về Chờ gửi, giữ mã cũ', () => {
  const s = mk();
  applyVtpStatus(s, { code: '181', status: 107, statusName: 'Huỷ', note: '', location: '' });
  assert.equal(s.orders[0].ship.state, 'ready');
  assert.equal(s.orders[0].ship.vtpCode, undefined);
  assert.equal(s.orders[0].ship.vtpOldCode, '181');
  assert.equal(s.orders[0].status, 'printed');
  assert.equal(s.orders[1].status, 'new');
});

test('tồn kho: ghi lý do, vẫn Đang giao', () => {
  const s = mk();
  applyVtpStatus(s, { code: '999', status: 506, statusName: 'Tồn', note: 'Không nghe máy', location: 'BC Hải Châu' });
  assert.equal(s.orders[2].ship.vtpKind, 'attention');
  assert.equal(s.orders[2].ship.vtpNote, 'Không nghe máy · BC Hải Châu');
  assert.equal(s.orders[2].status, 'shipping');
});

test('đã ở trạng thái cuối thì bỏ qua bản tin đến sau', () => {
  const s = mk();
  applyVtpStatus(s, { code: '181', status: 501, statusName: 'Phát thành công', at: '10/11/2026 10:00:00', note: '', location: '' });
  assert.equal(applyVtpStatus(s, { code: '181', status: 506, statusName: 'Phát thất bại', at: '10/11/2026 11:00:00', note: 'x', location: '' }), 0);
  assert.equal(s.orders[0].ship.vtpKind, 'delivered');
  assert.equal(s.orders[0].status, 'done');
});

test('bản tin cũ đến lệch thứ tự không ghi đè bản mới', () => {
  const s = mk();
  applyVtpStatus(s, { code: '999', status: 500, statusName: 'Giao bưu tá đi phát', at: '10/11/2026 09:00:00', note: '', location: '' });
  assert.equal(applyVtpStatus(s, { code: '999', status: 200, statusName: 'Lấy hàng thành công', at: '09/11/2026 18:00:00', note: '', location: '' }), 0);
  assert.equal(s.orders[2].ship.vtpStatus, 500);
  assert.equal(vtpEventTime('22/01/2026 09:36:53'), Date.UTC(2026, 0, 22, 2, 36, 53));
  assert.equal(vtpEventTime(''), 0);
});

test('web gửi danh sách đơn: phần vận đơn giữ theo máy chủ, phần khác theo web', () => {
  const current = [
    { id: 'a', status: 'done', ship: { state: 'exported', pay: 'cod', vtpCode: '181', vtpStatus: 501, vtpStatusAt: 5, vtpKind: 'delivered' } },
    { id: 'b', status: 'printed', ship: { state: 'ready', vtpOldCode: '7', vtpStatus: 107, vtpStatusAt: 3, vtpKind: 'cancelled' } },
    { id: 'c', status: 'new', ship: { state: 'ready' } }
  ];
  const out = keepServerVtp(current, [
    // Web còn bản cũ "đang giao, chờ lấy hàng": máy chủ đã ghi giao xong.
    { id: 'a', status: 'shipping', nickname: 'A', ship: { state: 'exported', pay: 'bank', vtpCode: '181', vtpStatus: 0, vtpKind: 'created' } },
    // Web đã thấy vận đơn bị huỷ rồi hẹn gom đơn lại: thay đổi của web được nhận.
    { id: 'b', status: 'printed', ship: { state: 'hold', vtpOldCode: '7', vtpStatus: 107, vtpStatusAt: 3, vtpKind: 'cancelled' } },
    { id: 'c', status: 'printed', ship: { state: 'hold' } },
    { id: 'd', status: 'new' }
  ]);
  assert.deepEqual(out[0], { id: 'a', status: 'done', nickname: 'A', ship: { state: 'exported', pay: 'bank', vtpCode: '181', vtpStatus: 501, vtpStatusAt: 5, vtpKind: 'delivered' } });
  assert.equal(out[1].ship.state, 'hold');
  assert.equal(out[1].ship.vtpOldCode, '7');
  assert.deepEqual(out[2], { id: 'c', status: 'printed', ship: { state: 'hold' } });
  assert.deepEqual(out[3], { id: 'd', status: 'new' });
});

test('cắt chuỗi theo byte cho Viettel Post, không cắt giữa chữ có dấu', () => {
  assert.equal(clipBytes('abc', 150), 'abc');
  const s = 'Đường'.repeat(40); // mỗi chữ 2-3 byte
  const out = clipBytes(s, 150);
  assert.ok(Buffer.byteLength(out, 'utf8') <= 150);
  assert.ok(Buffer.byteLength(out + 'Đ', 'utf8') > 150 - 3);
  assert.ok(s.startsWith(out));
});
