// Kiểm tra đầy đủ API ViettelPost bằng token tạo ở viettelpost.vn › Cấu hình tài khoản.
//
// Phần A: chỉ đọc (không đụng tới đơn nào).
// Phần B: tuỳ chọn – tạo 1 đơn THỬ gửi cho chính shop, thu hộ 0đ, lấy link in tem rồi HUỶ NGAY.
//         Chỉ chạy khi bạn gõ đúng chữ TAO. Huỷ được vì bưu tá chưa lấy hàng.
//
// Token không in ra màn hình, không ghi xuống đĩa.
// Chạy: node scripts/vtp-api-test.mjs
const BASE = 'https://partner.viettelpost.vn';

// ---------- nhập từ bàn phím ----------
function ask(prompt, hidden = false) {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    const stdin = process.stdin;
    const raw = stdin.isTTY;
    if (raw) stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let s = '';
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          if (raw) stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          return resolve(s.trim());
        }
        if (ch === '\u0003') { process.stdout.write('\n'); process.exit(1); }
        if (ch === '\u007f' || ch === '\b') {
          if (s.length) { s = s.slice(0, -1); if (!hidden) process.stdout.write('\b \b'); }
        } else {
          s += ch;
          if (!hidden) process.stdout.write(ch);
        }
      }
    };
    stdin.on('data', onData);
  });
}

// ---------- gọi API ----------
async function call(method, path, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Token = token;
  try {
    const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { http: res.status, json, text: text.slice(0, 400) };
  } catch (e) {
    return { http: 0, json: null, text: String(e) };
  }
}
const ok = (r) => r.http === 200 && r.json && r.json.error === false;
const why = (r) => (r.json?.message && typeof r.json.message === 'string' ? r.json.message : `HTTP ${r.http} ${r.text}`);
const money = (n) => (Number(n) || 0).toLocaleString('vi-VN') + ' đ';
const results = [];
function line(pass, title, detail = '') {
  results.push({ pass, title });
  console.log(`${pass ? '✓' : '✗'} ${title}${detail ? ' — ' + detail : ''}`);
}
const listOf = (j) => Array.isArray(j) ? j
  : Array.isArray(j?.RESULT) ? j.RESULT
  : Array.isArray(j?.data) ? j.data
  : Array.isArray(j?.data?.RESULT) ? j.data.RESULT : null;

// =====================================================================
console.log('\nKIỂM TRA API VIETTELPOST\n');
const siteToken = await ask('Dán token từ viettelpost.vn (sẽ không hiện chữ), rồi Enter: ', true);
if (!siteToken) { console.log('Chưa nhập token.'); process.exit(1); }

console.log('\nNhập địa chỉ lấy hàng của shop (dùng để tính cước đúng; Enter để bỏ qua):');
const shopAddress = await ask('  Địa chỉ shop: ');

console.log('\n=== PHẦN A · CHỈ ĐỌC ===\n');

// A1. Đăng nhập
const login = await call('POST', '/v2/user/LoginVTP', { body: { token: siteToken } });
if (!ok(login) || !login.json.data?.token) {
  line(false, 'A1. Đăng nhập API bằng token', why(login));
  console.log('\nToken không dùng được. Dừng.');
  process.exit(1);
}
const T = login.json.data.token;
const phone = String(login.json.data.phone ?? '');
line(true, 'A1. Đăng nhập API bằng token', `tài khoản ${phone.slice(0, 2)}•••${phone.slice(-3)}`);

// A2. Điểm lấy hàng
const inv = await call('GET', '/v2/user/listInventory', { token: T });
const invList = ok(inv) ? listOf(inv.json) : null;
if (invList) {
  line(true, 'A2. Danh sách điểm lấy hàng (người gửi)', `${invList.length} điểm`);
  invList.slice(0, 3).forEach((k, i) => {
    const addr = String(k.address ?? k.ADDRESS ?? '');
    console.log(`     ${i + 1}. ${k.name ?? k.NAME ?? '(không tên)'} · ${addr.split(',').slice(-1)[0].trim()}`);
  });
} else {
  line(false, 'A2. Danh sách điểm lấy hàng', why(inv));
}

// A3. Danh mục địa danh mới (V3) và cũ (V2)
const prov = await call('GET', '/v3/categories/listProvinceNew', { token: T });
const provList = ok(prov) ? listOf(prov.json) : null;
const hanoi = provList?.find((p) => /hà nội/i.test(p.PROVINCE_NAME ?? ''));
line(!!provList, 'A3. Tỉnh/thành theo địa giới MỚI', provList ? `${provList.length} tỉnh/thành` : why(prov));
if (hanoi) {
  const w = await call('GET', `/v3/categories/listWardsNew?provinceId=${hanoi.PROVINCE_ID}`, { token: T });
  const wl = ok(w) ? listOf(w.json) : null;
  line(!!wl, 'A4. Phường/xã MỚI của Hà Nội', wl ? `${wl.length} phường/xã` : why(w));
}
const oldProv = await call('GET', '/v2/categories/listProvinceById?provinceId=-1', { token: T });
const oldList = ok(oldProv) ? listOf(oldProv.json) : null;
line(!!oldList, 'A5. Tỉnh/thành theo địa giới CŨ', oldList ? `${oldList.length} tỉnh/thành (vẫn dùng được cho địa chỉ cũ)` : why(oldProv));

// A6. ViettelPost tự hiểu địa chỉ dạng chữ: cũ (có quận) và mới
const from = shopAddress || 'Cầu Giấy, Hà Nội';
const samples = [
  ['địa chỉ CŨ', '12 ngõ 5 Trần Quốc Hoàn, P. Nghĩa Đô, Q. Cầu Giấy, Hà Nội'],
  ['địa chỉ MỚI', '12 ngõ 5 Trần Quốc Hoàn, Phường Nghĩa Đô, Thành phố Hà Nội'],
  ['viết tắt, không dấu', 'so 3 ngo 12 dinh cong hoang mai ha noi']
];
let priceList = null;
for (const [label, addr] of samples) {
  const r = await call('POST', '/v2/order/getPriceAllNlp', {
    token: T,
    body: { SENDER_ADDRESS: from, RECEIVER_ADDRESS: addr, PRODUCT_TYPE: 'HH', PRODUCT_WEIGHT: 1000,
            PRODUCT_PRICE: 300000, MONEY_COLLECTION: 300000, TYPE: 1, PRODUCT_LENGTH: 0, PRODUCT_WIDTH: 0, PRODUCT_HEIGHT: 0 }
  });
  const ra = r.json?.RECEIVER_ADDRESS ?? r.json?.data?.RECEIVER_ADDRESS;
  const list = listOf(r.json);
  if (r.http === 200 && ra && ra.PROVINCE_ID) {
    line(true, `A6. Hiểu ${label}`, `tỉnh ${ra.PROVINCE_ID} · quận ${ra.DISTRICT_ID ?? '-'} · phường ${ra.WARD_ID ?? '-'}`);
    if (!priceList && list) priceList = list;
  } else {
    line(false, `A6. Hiểu ${label}`, why(r));
  }
}

// A7. Bảng cước các gói
if (priceList) {
  line(true, 'A7. Bảng cước các gói (1kg, thu hộ 300.000đ)', `${priceList.length} gói${shopAddress ? '' : ' · gửi từ Cầu Giấy vì chưa nhập địa chỉ shop'}`);
  priceList.slice(0, 10).forEach((s) =>
    console.log(`     · ${String(s.MA_DV_CHINH ?? '?').padEnd(5)} ${String(s.TEN_DICHVU ?? '').padEnd(28)} ${money(s.GIA_CUOC).padStart(10)}  ${s.THOI_GIAN ?? ''}`));
} else {
  line(false, 'A7. Bảng cước các gói', 'không lấy được');
}

// A8. Cước riêng gói VSL9 (gói mặc định của app)
const one = await call('POST', '/v2/order/getPriceNlp', {
  token: T,
  body: { SENDER_ADDRESS: from, RECEIVER_ADDRESS: samples[1][1], PRODUCT_TYPE: 'HH', PRODUCT_WEIGHT: 1000,
          PRODUCT_PRICE: 300000, MONEY_COLLECTION: 300000, NATIONAL_TYPE: 1, ORDER_SERVICE: 'VSL9', ORDER_SERVICE_ADD: '',
          PRODUCT_LENGTH: 0, PRODUCT_WIDTH: 0, PRODUCT_HEIGHT: 0 }
});
if (ok(one)) {
  const d = one.json.data ?? {};
  line(true, 'A8. Cước gói VSL9', `${money(d.MONEY_TOTAL)} (chính ${money(d.MONEY_TOTAL_FEE)} · thu hộ ${money(d.MONEY_COLLECTION_FEE)} · VAT ${money(d.MONEY_VAT)})`);
} else {
  line(false, 'A8. Cước gói VSL9', why(one));
}

// =====================================================================
console.log('\n=== PHẦN B · TẠO ĐƠN THỬ RỒI HUỶ (tuỳ chọn) ===\n');
console.log('Sẽ tạo 1 đơn gửi CHO CHÍNH SHOP, thu hộ 0đ, ghi chú "ĐƠN THỬ API", rồi huỷ ngay.');
console.log('Đơn đã huỷ vẫn hiện trong danh sách đơn trên viettelpost.vn với trạng thái "Đối tác yêu cầu huỷ".');
const go = await ask('Gõ TAO rồi Enter để chạy, hoặc chỉ Enter để bỏ qua: ');

if (go !== 'TAO') {
  console.log('Bỏ qua phần B.');
} else {
  const sName = await ask('  Tên shop (người gửi): ');
  const sPhone = await ask('  SĐT shop: ');
  const sAddr = shopAddress || await ask('  Địa chỉ lấy hàng: ');
  if (!sName || !sPhone || !sAddr) {
    console.log('Thiếu thông tin, bỏ qua phần B.');
  } else {
    const ref = 'TEST' + Date.now().toString().slice(-8);
    const order = {
      ORDER_NUMBER: ref,
      SENDER_FULLNAME: sName, SENDER_PHONE: sPhone, SENDER_ADDRESS: sAddr,
      RECEIVER_FULLNAME: sName, RECEIVER_PHONE: sPhone, RECEIVER_ADDRESS: sAddr,
      PRODUCT_NAME: 'Don thu API ChotLive', PRODUCT_QUANTITY: 1, PRODUCT_PRICE: 10000, PRODUCT_WEIGHT: 200,
      PRODUCT_LENGTH: 0, PRODUCT_WIDTH: 0, PRODUCT_HEIGHT: 0, PRODUCT_TYPE: 'HH',
      ORDER_PAYMENT: 1, ORDER_SERVICE: 'VSL9', ORDER_SERVICE_ADD: null,
      ORDER_NOTE: 'ĐƠN THỬ API - SẼ HUỶ NGAY, KHÔNG LẤY HÀNG',
      MONEY_COLLECTION: 0, EXTRA_MONEY: 0, CHECK_UNIQUE: true,
      PRODUCT_DETAIL: [{ PRODUCT_NAME: 'Don thu API ChotLive', PRODUCT_QUANTITY: 1, PRODUCT_PRICE: 10000, PRODUCT_WEIGHT: 200 }]
    };
    let created = await call('POST', '/v2/order/createOrderNlp', { token: T, body: order });
    if (!ok(created)) {
      // Gói VSL9 có thể chưa bật cho tài khoản: thử lại với gói tiêu chuẩn.
      console.log(`  (VSL9 lỗi: ${why(created)} → thử gói STK)`);
      created = await call('POST', '/v2/order/createOrderNlp', { token: T, body: { ...order, ORDER_SERVICE: 'STK' } });
    }
    const bill = created.json?.data?.ORDER_NUMBER;
    if (!ok(created) || !bill) {
      line(false, 'B1. Tạo đơn', why(created));
    } else {
      const d = created.json.data;
      line(true, 'B1. Tạo đơn', `mã vận đơn ${bill} · cước ${money(d.MONEY_TOTAL)} · mã chia chọn ${d.SORT_CODE ?? '-'}`);

      // B2. Link in tem
      const pc = await call('POST', '/v2/order/printing-code', {
        token: T, body: { EXPIRY_TIME: Date.now() + 3600_000, ORDER_ARRAY: [bill] }
      });
      if (ok(pc) && pc.json.message) {
        const code = encodeURIComponent(pc.json.message);
        line(true, 'B2. Lấy link in tem', 'mở link dưới đây để xem tem (A6), hết hạn sau 1 giờ');
        console.log(`     https://digitalize.viettelpost.vn/DigitalizePrint/report.do?type=2&bill=${code}&showPostage=1`);
      } else {
        line(false, 'B2. Lấy link in tem', why(pc));
      }

      // B3. Huỷ ngay
      const cancel = await call('POST', '/v2/order/UpdateOrder', {
        token: T, body: { TYPE: 4, ORDER_NUMBER: bill, NOTE: 'Đơn thử API ChotLive' }
      });
      if (ok(cancel)) {
        line(true, 'B3. Huỷ đơn thử', cancel.json.message || 'đã huỷ');
      } else {
        line(false, 'B3. Huỷ đơn thử', why(cancel));
        console.log(`\n  !!! CHƯA HUỶ ĐƯỢC. Vào viettelpost.vn tìm mã ${bill} và bấm Huỷ đơn bằng tay. !!!`);
      }
    }
  }
}

// =====================================================================
const pass = results.filter((r) => r.pass).length;
console.log(`\n=== KẾT QUẢ: ${pass}/${results.length} bước thành công ===`);
const bad = results.filter((r) => !r.pass);
if (bad.length) bad.forEach((r) => console.log(`   chưa được: ${r.title}`));
console.log('Token chỉ nằm trong bộ nhớ lúc chạy, không lưu lại.\n');
