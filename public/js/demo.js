/** Dữ liệu giả lập: bình luận live và lịch sử các phiên cũ */
const NAMES = [
  ['Thương Phạm', 'thuongpham.95'], ['Nguyen Huu Phac', 'huuphac_dn'], ['Lan Anh', 'lananh.shop'],
  ['Mai Mai', 'maimai_2k'], ['Hạnh Nguyễn', 'hanh.nguyen88'], ['Tuấn Kiệt', 'tuankiet.hcm'],
  ['Ngọc Trâm', 'ngoctram_9x'], ['Bích Phượng', 'bichphuong.dn'], ['Cô Ba Sài Gòn', 'coba_saigon'],
  ['Minh Thư', 'minhthu.beauty'], ['Hồng Nhung', 'hongnhung1990'], ['Quỳnh Như', 'quynhnhu.vn'],
  ['Thảo Vy', 'thaovy_official'], ['Đức Anh', 'ducanh.2002'], ['Kim Chi', 'kimchi.store'],
];
const PRODUCTS = ['áo sơ mi lụa', 'chân váy chữ A', 'túi kẹp nách', 'quần jeans ống suông', 'đầm hoa nhí', 'áo khoác dạ', 'giày sneaker', 'set đồ ngủ', 'khăn len', 'áo thun basic'];
const DEAL = [
  (p, n) => `chốt ${n} ${p}`, (p, n) => `${n}k ${p} nha shop`, (p, n) => `lấy ${p} ${n}`,
  (p, n) => `cho em ${p} ${n}, sđt 09${rnd(10000000, 99999999)}`, (p, n) => `chốt đơn ${p} ${n}k ship Đà Nẵng`,
];
const CHAT = [
  'shop ơi còn size M không', 'xin giá áo này', 'mình ở Hà Nội ship mấy ngày vậy', 'đẹp quá', 'cho xin link', 'có màu khác không shop',
  'mặc vừa 55kg không ạ', 'hello shop', 'mới vào, đang bán gì vậy', 'freeship không shop', 'xem lại cái váy ban nãy đi', 'ib em nha',
  '❤️❤️❤️', 'đã thả tim', 'shop có COD không',
];

function rnd(a, b) { return Math.floor(Math.random() * (b - a + 1)) + a; }
const pick = (arr) => arr[rnd(0, arr.length - 1)];

function makeBase(ts) {
  const [nickname, uniqueId] = pick(NAMES);
  return { id: 'd' + ts.toString(36) + Math.random().toString(36).slice(2, 6), userId: String(7000000000 + NAMES.findIndex((n) => n[1] === uniqueId) * 1117), uniqueId, nickname, ts };
}

/** 1 bình luận live giả (tỉ lệ ~35% là tin chốt đơn) */
export function fakeLiveComment() {
  const base = makeBase(Date.now());
  const comment = Math.random() < 0.35 ? pick(DEAL)(pick(PRODUCTS), pick([99, 120, 150, 180, 200, 250, 300])) : pick(CHAT);
  return { ...base, comment };
}

/** Sinh các phiên live cũ trong N ngày gần đây. parse(comment) -> {price, productName, phone, quantity} */
export function fakeHistory(parse, days = 6) {
  const sessions = [];
  const comments = [];
  const now = new Date();
  for (let d = days; d >= 1; d--) {
    const liveCount = d % 3 === 0 ? 2 : 1;
    for (let k = 0; k < liveCount; k++) {
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - d, k === 0 ? 20 : 12, rnd(0, 20));
      const s = { id: `s_demo_${d}_${k}`, username: k === 0 ? 'susu.live' : 'susu.shop', startTs: start.getTime(), endTs: start.getTime(), count: 0, priceCount: 0 };
      const n = rnd(120, 260);
      let ts = start.getTime();
      for (let i = 0; i < n; i++) {
        ts += rnd(4, 45) * 1000;
        const base = makeBase(ts);
        const isDeal = Math.random() < 0.3;
        const comment = isDeal ? pick(DEAL)(pick(PRODUCTS), pick([99, 120, 150, 180, 200, 250, 300])) : pick(CHAT);
        const info = isDeal ? parse(comment) : {};
        comments.push({
          key: s.id + '|' + base.id, sessionId: s.id, ts, uniqueId: base.uniqueId, userId: base.userId, nickname: base.nickname,
          comment, price: info.price || 0, productName: info.productName || '', phone: info.phone || '', quantity: info.quantity || 1,
        });
        s.count++; if (info.price) s.priceCount++;
        s.endTs = ts;
      }
      sessions.push(s);
    }
  }
  return { sessions, comments };
}
