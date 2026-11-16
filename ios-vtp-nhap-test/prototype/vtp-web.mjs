// Bản thử luồng web Viettel Post (đăng nhập + DPoP + lưu nháp) chạy trên máy của bạn, đi từ IP của bạn.
// Dùng để chốt giao thức trước khi viết app iOS "VTP Nháp Test". KHÔNG dùng cho app thật, KHÔNG gọi máy chủ ChotLive.
//
//   node ios-vtp-nhap-test/prototype/vtp-web.mjs login       đăng nhập (bạn tự gõ SĐT, mật khẩu, OTP)
//   node ios-vtp-nhap-test/prototype/vtp-web.mjs inventory   xem kho hàng (người gửi)
//   node ios-vtp-nhap-test/prototype/vtp-web.mjs draft       lưu 1 đơn nháp gửi cho chính shop (không gọi bưu tá)
//   node ios-vtp-nhap-test/prototype/vtp-web.mjs refresh     làm mới phiên bằng refresh token
//
// Phiên (khoá ký, token) lưu ở thư mục tạm của máy, không nằm trong repo. Mật khẩu và OTP không được lưu.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const SSO = 'https://oms-sso-2-api.viettelpost.vn';
const OTP = 'https://otp-verify.okd.viettelpost.vn';
const API = 'https://api.viettelpost.vn';
const SESSION = process.env.VTP_SESSION || path.join(os.tmpdir(), 'vtp-nhap-test-session.json');

// ---------- tiện ích ----------
const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const mask = (s) => String(s ?? '')
  .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, (m) => `<jwt ${m.length}>`)
  .replace(/(?<!\d)(0|\+?84)\d{8,10}(?!\d)/g, (m) => m.slice(0, 3) + '•••' + m.slice(-3));
const log = (label, obj) => console.log(`  ${label}: ${mask(typeof obj === 'string' ? obj : JSON.stringify(obj)).slice(0, 700)}`);

function ask(q, hidden = false) {
  return new Promise((resolve) => {
    if (!hidden) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      return rl.question(q, (a) => { rl.close(); resolve(a.trim()); });
    }
    process.stdout.write(q);
    const stdin = process.stdin;
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let s = '';
    const on = (ch) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') { stdin.setRawMode?.(false); stdin.pause(); stdin.off('data', on); process.stdout.write('\n'); return resolve(s); }
        if (c === '\u0003') process.exit(1);
        if (c === '\u007f' || c === '\b') s = s.slice(0, -1); else s += c;
      }
    };
    stdin.on('data', on);
  });
}

// ---------- phiên ----------
function loadSession() {
  try { return JSON.parse(fs.readFileSync(SESSION, 'utf8')); } catch { return null; }
}
function saveSession(s) {
  fs.writeFileSync(SESSION, JSON.stringify(s, null, 1), { mode: 0o600 });
}
function newSession() {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    deviceId: Date.now().toString(36) + Math.random().toString(36).slice(2),
    deviceToken: crypto.randomUUID(),
    keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' })
  };
}

// ---------- DPoP ----------
const nonces = new Map();
function proof(sess, method, url, accessToken) {
  const key = crypto.createPrivateKey(sess.keyPem);
  const { kty, crv, x, y } = crypto.createPublicKey(key).export({ format: 'jwk' });
  const u = new URL(url);
  const header = { typ: 'dpop+jwt', alg: 'ES256', jwk: { kty, crv, x, y } };
  const payload = { jti: crypto.randomUUID(), htm: method.toUpperCase(), htu: u.origin + u.pathname, iat: Math.floor(Date.now() / 1000) };
  if (accessToken) payload.ath = b64u(crypto.createHash('sha256').update(accessToken).digest());
  const n = nonces.get(u.origin);
  if (n) payload.nonce = n;
  const input = b64u(JSON.stringify(header)) + '.' + b64u(JSON.stringify(payload));
  const sig = crypto.sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' });
  return input + '.' + b64u(sig);
}

async function http(method, url, body, headers = {}) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/plain, */*', ...headers },
    body: body == null ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, headers: res.headers };
}

/** Gọi api.viettelpost.vn như web: header token + deviceId + X-Token (DPoP). Gặp yêu cầu nonce thì gửi lại 1 lần. */
async function api(sess, method, p, body, { token = sess.token, extra = {} } = {}) {
  const url = API + p;
  for (let attempt = 0; attempt < 2; attempt++) {
    const h = { deviceId: sess.deviceId, 'X-Token': proof(sess, method, url, token || undefined), ...extra };
    if (token) h.token = token;
    const r = await http(method, url, body, h);
    const n = r.headers.get('x-token-nonce');
    if (n) nonces.set(API, n);
    const key = r.json?.messageKey;
    if (attempt === 0 && n && (key === 'USE_DPOP_NONCE' || r.status === 401)) continue;
    return r;
  }
}

// ---------- đăng nhập ----------
// Kênh nhận OTP đúng như nút trên web: PHONE (SMS), EMAIL, MOCHA, TAMMI.
async function sendAndVerifyOtp(fn, phone, email) {
  let type = (await ask('Nhận OTP qua (PHONE=SMS / EMAIL / MOCHA) [PHONE]: ')).toUpperCase() || 'PHONE';
  if (type === 'SMS') type = 'PHONE';
  const account = type === 'EMAIL' ? email : phone;
  const sent = await http('POST', OTP + '/api/otp/sendOTP', { function: fn, otpType: 'NUMBER', account, type, deviceId: '' });
  log('sendOTP', sent.json ?? sent.text);
  if (sent.json?.status != 1) throw new Error('Không gửi được OTP');
  const otp = await ask('Nhập mã OTP: ');
  const ver = await http('POST', OTP + '/api/otp/verifyOTPV2', { function: fn, secretValue: null, otp, type, account, expiredType: null, deviceId: '' });
  log('verifyOTPV2', ver.json ?? ver.text);
  if (ver.json?.status != 1 || !ver.json.data) throw new Error('OTP sai hoặc hết hạn');
  return ver.json.data;
}

async function login() {
  const sess = newSession();
  const username = await ask('SĐT hoặc email Viettel Post: ');
  const password = await ask('Mật khẩu (không hiện): ', true);
  console.log('\n1) Đăng nhập SSO');
  const base = { clientId: 'vtp.web', clientSecret: 'vtp.web', deviceId: sess.deviceId, username, password };
  let r = await http('POST', SSO + '/api/v2/Login/PasswordCaptcha', base, { Token: '' });
  log('PasswordCaptcha', r.json ?? r.text);
  let j = r.json || {};
  let accessToken = j.status && j.accessToken ? j.accessToken : null;

  if (!accessToken && j.status && j.checkCaptcha) {
    console.log('\n→ Viettel Post đòi captcha. Chuyển sang đăng nhập bằng OTP (như web khi captcha không qua).');
    const account = j.phoneNumber || j.phone || username;
    const tokenOTP = await sendAndVerifyOtp('SSO_OTP_FALLBACK', account, j.email);
    r = await http('POST', SSO + '/api/v2/Login/otp-fallback', { userName: account, token: tokenOTP }, { Token: '' });
    log('otp-fallback', r.json ?? r.text);
    j = r.json || {};
    accessToken = j.status && j.accessToken ? j.accessToken : null;
  }
  if (!accessToken && j.status && j.verifyOtpKey) {
    console.log('\n→ Tài khoản bật xác minh 2 bước. Gửi OTP.');
    const tokenOTP = await sendAndVerifyOtp('SSO_VERIFY_LOGIN', j.phoneNumber || username, j.email);
    r = await http('POST', SSO + '/api/Login/LoginUserPassTwoFAVerifyOtp', { tokenOtp: tokenOTP, verifyOtpKey: j.verifyOtpKey, deviceId: sess.deviceId }, { token: '' });
    log('TwoFAVerifyOtp', r.json ?? r.text);
    accessToken = r.json?.accessToken || null;
  }
  if (!accessToken) throw new Error('Chưa lấy được accessToken SSO: ' + mask(j.errorMessage || r.text).slice(0, 200));

  console.log('\n2) Đổi sang phiên web (có DPoP)');
  const up = await api(sess, 'POST', '/api/user/ssoUpdateUser', {
    TokenSSO: accessToken, Type: 'VTP', Source: 3, DeviceName: 'VTP Nhap Test', DeviceToken: sess.deviceToken,
    deviceId: sess.deviceId, deviceType: 'WEB', browser: 'Chrome'
  }, { token: '' });
  log('ssoUpdateUser', up.json ?? up.text);
  const d = up.json?.data;
  if (up.json?.error || !d?.TokenKey) throw new Error('ssoUpdateUser thất bại');
  Object.assign(sess, { token: d.TokenKey, refreshToken: d.refreshToken, userId: d.UserId, partner: d.Partner, at: Date.now() });
  saveSession(sess);
  console.log(`\n✔ Đăng nhập xong. Phiên lưu tạm ở ${SESSION}`);
}

async function inventory(sess) {
  const r = await api(sess, 'POST', '/api/setting/listInventoryV2', { token: sess.token, deviceId: sess.deviceId });
  const list = Array.isArray(r.json) ? r.json : Array.isArray(r.json?.data) ? r.json.data : null;
  if (!list) { log('listInventoryV2', r.json ?? r.text); throw new Error('Không đọc được kho hàng'); }
  console.log(`✔ ${list.length} kho. Trường của kho đầu: ${Object.keys(list[0] || {}).join(', ')}`);
  return list;
}

const pick = (o, ...ks) => { for (const k of ks) if (o?.[k] != null && o[k] !== '') return o[k]; return null; };

async function draft(sess) {
  const k = (await inventory(sess))[0];
  const kho = {
    id: pick(k, 'GROUPADDRESS_ID', 'groupaddressId', 'id'), cus: pick(k, 'CUS_ID', 'cusId'),
    name: pick(k, 'NAME', 'name'), phone: pick(k, 'PHONE', 'phone'), addr: pick(k, 'ADDRESS', 'address'),
    p: pick(k, 'PROVINCE_ID', 'provinceId'), d: pick(k, 'DISTRICT_ID', 'districtId'), w: pick(k, 'WARDS_ID', 'wardsId')
  };
  log('kho', kho);
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const body = {
    ORDER_REFERENCE: 'TEST-' + Date.now(), ORDER_TYPE: 1, TYPE: 12,
    DELIVERY_DATE: `${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
    GROUPADDRESS_ID: String(kho.id), CUS_ID: Number(kho.cus),
    SENDER_FULLNAME: kho.name, SENDER_ADDRESS: kho.addr, SENDER_PHONE: kho.phone, SENDER_EMAIL: '',
    SENDER_WARD: String(kho.w), SENDER_DISTRICT: String(kho.d), SENDER_PROVINCE: String(kho.p), SENDER_LATITUDE: 0, SENDER_LONGITUDE: 0,
    RECEIVER_FULLNAME: 'TEST NHAP APP', RECEIVER_ADDRESS: kho.addr, RECEIVER_PHONE: kho.phone, RECEIVER_EMAIL: '',
    RECEIVER_WARD: Number(kho.w), RECEIVER_DISTRICT: Number(kho.d), RECEIVER_PROVINCE: Number(kho.p), RECEIVER_LATITUDE: 0, RECEIVER_LONGITUDE: 0,
    PRODUCT_NAME: 'Test', PRODUCT_DESCRIPTION: '', PRODUCT_QUANTITY: 1, PRODUCT_PRICE: 10000, PRODUCT_WEIGHT: 200,
    PRODUCT_WIDTH: 0, PRODUCT_HEIGHT: 0, PRODUCT_LENGTH: 0, PRODUCT_TYPE: 'HH',
    ORDER_PAYMENT: 1, ORDER_SERVICE: 'STK', ORDER_SERVICE_ADD: '', ORDER_VOUCHER: '', ORDER_NOTE: 'Thu nhap tu app test', DELIVERY_CODE: -1,
    MONEY_COLLECTION: 0, MONEY_TOTALFEE: 0, MONEY_FEECOD: 0, MONEY_FEEVAS: 0, MONEY_FEEINSURRANCE: 0, MONEY_FEE: 0,
    MONEY_FEEOTHER: 0, MONEY_TOTALVAT: 0, MONEY_TOTAL: 0,
    LIST_ITEM: [{ ORDER_NUMBER_ITEM: 1, PRODUCT_NAME: 'Test', PRODUCT_QUANTITY: 1, PRODUCT_WEIGHT: 200, PRODUCT_PRICE: 10000 }],
    OPTION_LOCATION: 0, REMOVE_PICKUP_DATE: true, XMG_EXTRA_MONEY: 0, ORDER_NUMBER: '', deviceId: sess.deviceId
  };
  const r = await api(sess, 'POST', '/api/tmdt/InsertOrderDraftForWeb', body);
  log('InsertOrderDraftForWeb', r.json ?? r.text);
  console.log(r.json && !r.json.error ? '\n✔ ĐÃ LƯU NHÁP. Xem ở viettelpost.vn › Quản lý vận đơn › Đơn nháp.' : '\n✘ Chưa lưu được nháp.');
}

async function refresh(sess) {
  const r = await api(sess, 'POST', '/api/sessions/refresh/v1', {}, { extra: { 'refresh-token': sess.refreshToken } });
  log('refresh', r.json ?? r.text);
  const d = r.json?.data;
  if (r.json?.error || !d?.token) throw new Error('Làm mới thất bại');
  Object.assign(sess, { token: d.token, refreshToken: d.refreshToken || sess.refreshToken, at: Date.now() });
  saveSession(sess);
  console.log('✔ Đã làm mới phiên');
}

const cmd = process.argv[2];
try {
  if (cmd === 'login') await login();
  else {
    const sess = loadSession();
    if (!sess?.token) throw new Error('Chưa đăng nhập. Chạy: login');
    if (cmd === 'inventory') await inventory(sess);
    else if (cmd === 'draft') await draft(sess);
    else if (cmd === 'refresh') await refresh(sess);
    else console.log('Lệnh: login | inventory | draft | refresh');
  }
} catch (e) {
  console.log('\n✘ ' + mask(e.message));
  process.exitCode = 1;
}
