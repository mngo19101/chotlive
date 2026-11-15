/** API Viettel Post: token shop tự tạo, máy chủ gọi API thay trình duyệt. */
import express from 'express';
import { createLimiter } from '../../rate-limit.js';
import * as vtp from '../../vtp.js';
import { getStateForUser } from '../states.js';
import { mutateState } from '../hub.js';
import { vtpStore, vtpWards } from '../vtp-stores.js';
import { requireAuth } from '../middleware.js';

const router = express.Router();

function vtpHookUrl(req, conn) {
  if (!conn?.hookId) return '';
  const host = req.get('host') || '';
  const local = /^(localhost|127\.|\[::1\])/.test(host);
  const base = process.env.PUBLIC_URL || (local ? `${req.protocol}://${host}` : `https://${host}`);
  return `${base.replace(/\/$/, '')}/api/vtp/webhook/${conn.hookId}`;
}

function vtpPublic(req, conn) {
  if (!conn?.siteToken) return { connected: false };
  return {
    connected: true,
    phone: vtp.maskPhone(conn.phone),
    sender: conn.sender
      ? { id: conn.sender.id, name: conn.sender.name, phone: conn.sender.phone, address: conn.sender.address }
      : null,
    hookUrl: vtpHookUrl(req, conn),
    lastHookAt: conn.lastHookAt || null,
    connectedAt: conn.connectedAt || null
  };
}

const vtpConnectTries = createLimiter({ max: 10, windowMs: 15 * 60 * 1000 });

router.get('/api/vtp/status', requireAuth, (req, res) => {
  res.json({ ok: true, ...vtpPublic(req, vtpStore.get(req.user.id)) });
});

router.post('/api/vtp/connect', requireAuth, async (req, res) => {
  const siteToken = String(req.body?.siteToken || '').trim();
  if (!siteToken) return res.status(400).json({ error: 'Chưa dán token' });
  if (vtpConnectTries.retryAfter(req.user.id) > 0) return res.status(429).json({ error: 'Thử quá nhiều lần, đợi 15 phút.' });
  vtpConnectTries.hit(req.user.id);
  const lg = await vtp.vtpLogin(siteToken);
  if (!lg.ok) return res.status(400).json({ error: `Token không dùng được: ${lg.error}` });
  const old = vtpStore.get(req.user.id);
  vtpStore.set(req.user.id, {
    siteToken,
    partnerToken: lg.token,
    phone: lg.phone,
    hookId: old?.hookId || vtp.newHookId(),
    connectedAt: Date.now(),
    sender: old?.phone === lg.phone ? old.sender || null : null
  });
  const inv = await vtp.vtpInventory(vtpStore, req.user.id);
  res.json({ ok: true, ...vtpPublic(req, vtpStore.get(req.user.id)), inventory: inv.ok ? inv.list : [] });
});

router.get('/api/vtp/inventory', requireAuth, async (req, res) => {
  const inv = await vtp.vtpInventory(vtpStore, req.user.id);
  if (!inv.ok) return res.status(400).json({ error: inv.error });
  res.json({ ok: true, list: inv.list });
});

router.post('/api/vtp/sender', requireAuth, async (req, res) => {
  const id = String(req.body?.id ?? '');
  const inv = await vtp.vtpInventory(vtpStore, req.user.id);
  if (!inv.ok) return res.status(400).json({ error: inv.error });
  const k = inv.list.find((x) => String(x.id) === id);
  if (!k) return res.status(404).json({ error: 'Không thấy điểm lấy hàng này' });
  vtpStore.set(req.user.id, { sender: k });
  res.json({ ok: true, ...vtpPublic(req, vtpStore.get(req.user.id)) });
});

router.post('/api/vtp/disconnect', requireAuth, (req, res) => {
  vtpStore.remove(req.user.id);
  res.json({ ok: true, connected: false });
});

const vtpCodeOk = (c) => /^[A-Za-z0-9-]{5,40}$/.test(String(c || ''));

/** Tạo vận đơn cho từng khách; vận đơn nào tạo xong được ghi ngay vào đơn để không tạo trùng. */
// Nháp: cước dự tính và địa chỉ Viettel Post hiểu, chưa tạo đơn nào.
router.post('/api/vtp/quote', requireAuth, async (req, res) => {
  const userId = req.user.id;
  const conn = vtpStore.get(userId);
  if (!conn?.siteToken) return res.status(400).json({ error: 'Chưa kết nối Viettel Post' });
  if (!conn.sender) return res.status(400).json({ error: 'Chưa chọn điểm lấy hàng' });
  const service = String(req.body?.service || 'VSL9').slice(0, 10);
  const groups = Array.isArray(req.body?.groups) ? req.body.groups.slice(0, 100) : [];
  const results = new Array(groups.length);
  let next = 0;
  // Mỗi nháp 2 lần hỏi giá; chạy 4 nháp một lúc cho nhanh mà không dồn Viettel Post.
  await Promise.all(
    Array.from({ length: Math.min(4, groups.length) }, async () => {
      while (next < groups.length) {
        const i = next++;
        const g = groups[i] || {};
        const r = await vtp.vtpQuote(vtpStore, userId, g, service, vtpWards).catch((e) => ({ ok: false, error: String(e.message || e) }));
        results[i] = { key: g.key, ...r };
      }
    })
  );
  res.json({ ok: true, results });
});

// Mỗi tài khoản chỉ tạo vận đơn một lượt một lúc: yêu cầu bấm lại hoặc gửi từ máy khác phải chờ lượt
// trước xong, khi đó đơn đã có mã vận đơn và được trả về "already" thay vì tạo thêm vận đơn thứ hai.
const vtpCreateQueue = new Map();
function vtpCreateTurn(userId, fn) {
  const turn = (vtpCreateQueue.get(userId) || Promise.resolve()).then(fn, fn);
  const tail = turn.catch(() => {});
  vtpCreateQueue.set(userId, tail);
  tail.then(() => {
    if (vtpCreateQueue.get(userId) === tail) vtpCreateQueue.delete(userId);
  });
  return turn;
}

router.post('/api/vtp/create', requireAuth, (req, res) => vtpCreateTurn(req.user.id, () => vtpCreateHandler(req, res)));

async function vtpCreateHandler(req, res) {
  const userId = req.user.id;
  const conn = vtpStore.get(userId);
  if (!conn?.siteToken) return res.status(400).json({ error: 'Chưa kết nối Viettel Post' });
  if (!conn.sender) return res.status(400).json({ error: 'Chưa chọn điểm lấy hàng' });
  const service = String(req.body?.service || 'VSL9').slice(0, 10);
  const groups = Array.isArray(req.body?.groups) ? req.body.groups.slice(0, 100) : [];
  const batchId = 'vtp_' + Date.now().toString(36);
  const results = [];
  for (const g of groups) {
    // Web gửi mã đơn; app iOS gửi mã món (app không biết mã đơn của máy chủ).
    const itemIds = new Set((Array.isArray(g?.itemIds) ? g.itemIds : []).map(String));
    const ids = [
      ...new Set([
        ...(Array.isArray(g?.orderIds) ? g.orderIds : []).map(String),
        ...(getStateForUser(userId).orders || [])
          .filter((o) => o.status !== 'cancelled' && (o.items || []).some((it) => itemIds.has(String(it.id))))
          .map((o) => String(o.id))
      ])
    ];
    const orders = (getStateForUser(userId).orders || []).filter((o) => ids.includes(String(o.id)));
    if (!orders.length) {
      results.push({ key: g?.key, ok: false, error: 'Không thấy đơn' });
      continue;
    }
    const existing = orders.find((o) => o.ship?.vtpCode);
    if (existing) {
      results.push({ key: g.key, ok: true, code: existing.ship.vtpCode, already: true });
      continue;
    }
    const r = await vtp.vtpCreateOrder(vtpStore, userId, g, service, vtpWards);
    if (r.ok) {
      console.log(`[vtp] Tạo vận đơn ${String(g.ref || g.key || '').slice(0, 60)} → ${r.code}${r.parsed ? ` · VTP hiểu: ${r.parsed}` : ' · chưa đối chiếu được địa chỉ'}`);
      mutateState(userId, 'vtp_created', '', null, (s) => {
        for (const o of s.orders || []) {
          if (!ids.includes(String(o.id))) continue;
          o.ship = {
            ...(o.ship || {}),
            state: 'exported',
            exportedAt: Date.now(),
            batchId,
            vtpCode: r.code,
            vtpFee: r.fee,
            vtpService: service,
            vtpStatus: 0,
            vtpStatusName: 'Chờ lấy hàng',
            vtpStatusAt: Date.now(),
            vtpKind: 'created',
            vtpNote: '',
            vtpError: '',
            vtpErrorAt: null
          };
          o.status = 'shipping';
        }
      });
    } else {
      // Ghi lý do vào đơn để thẻ đơn (web và app) hiện "Lỗi tạo vận đơn: …" cho tới lần gửi sau.
      mutateState(userId, 'vtp_error', '', null, (s) => {
        for (const o of s.orders || []) {
          if (!ids.includes(String(o.id))) continue;
          o.ship = { ...(o.ship || {}), vtpError: String(r.error || 'Lỗi').slice(0, 200), vtpErrorAt: Date.now() };
        }
      });
    }
    results.push({ key: g.key, ...r });
  }
  res.json({ ok: true, results });
}

router.post('/api/vtp/print', requireAuth, async (req, res) => {
  const codes = (Array.isArray(req.body?.codes) ? req.body.codes : []).filter(vtpCodeOk).slice(0, 100);
  if (!codes.length) return res.status(400).json({ error: 'Chưa có mã vận đơn' });
  const r = await vtp.vtpPrintLinks(vtpStore, req.user.id, codes);
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.json({ ok: true, links: r.links });
});

router.post('/api/vtp/cancel', requireAuth, async (req, res) => {
  const code = String(req.body?.code || '');
  if (!vtpCodeOk(code)) return res.status(400).json({ error: 'Mã vận đơn không hợp lệ' });
  // force: shop đã kiểm trên viettelpost.vn, chỉ gỡ mã vận đơn khỏi đơn trong app, không gọi Viettel Post.
  const force = req.body?.force === true;
  const r = force ? { ok: true } : await vtp.vtpCancel(vtpStore, req.user.id, code);
  if (!r.ok) return res.status(400).json({ error: r.error });
  const statusName = force ? 'Shop gỡ vận đơn khỏi app' : r.already ? 'Viettel Post báo đã huỷ' : 'Shop đã huỷ vận đơn';
  if (force || r.already) console.log(`[vtp] ${statusName}: ${code}`);
  mutateState(req.user.id, 'vtp_cancelled', '', null, (s) =>
    vtp.applyVtpStatus(s, { code, status: 107, statusName, note: '', location: '' })
  );
  res.json({ ok: true, already: !!r.already, forced: force });
});

router.post('/api/vtp/resolve', requireAuth, async (req, res) => {
  const code = String(req.body?.code || '');
  const type = Number(req.body?.type);
  if (!vtpCodeOk(code) || ![2, 3].includes(type)) return res.status(400).json({ error: 'Yêu cầu không hợp lệ' });
  const r = await vtp.vtpResolve(vtpStore, req.user.id, code, type, String(req.body?.note || ''));
  if (!r.ok) return res.status(400).json({ error: r.error });
  mutateState(req.user.id, 'vtp_resolve', '', null, (s) => {
    for (const o of s.orders || []) {
      if (o.ship?.vtpCode !== code) continue;
      o.ship = {
        ...o.ship,
        vtpKind: 'moving',
        vtpStatusName: type === 3 ? 'Đã yêu cầu phát lại' : 'Đã đồng ý hoàn',
        vtpStatusAt: Date.now()
      };
    }
  });
  res.json({ ok: true });
});

// Viettel Post gọi vào đây mỗi khi vận đơn đổi trạng thái. Phải trả 200 thật nhanh; gửi trùng thì bỏ qua.
const vtpSeen = new Map();
router.post('/api/vtp/webhook/:hookId', (req, res) => {
  res.status(200).json({ status: 200, error: false, message: 'OK' });
  const found = vtpStore.byHook(String(req.params.hookId || ''));
  if (!found) return;
  const ev = vtp.parseVtpWebhook(req.body);
  if (!ev) return;
  const dedupe = `${found.userId}|${ev.code}|${ev.status}|${ev.at}`;
  if (vtpSeen.has(dedupe)) return;
  vtpSeen.set(dedupe, Date.now());
  if (vtpSeen.size > 5000) for (const k of [...vtpSeen.keys()].slice(0, 1000)) vtpSeen.delete(k);
  setImmediate(() => {
    try {
      vtpStore.set(found.userId, { lastHookAt: Date.now() });
      let n = 0;
      mutateState(found.userId, 'vtp_status', '', null, (s) => { n = vtp.applyVtpStatus(s, ev); });
      // Ghi lại mã + trạng thái để dò lỗi (không có dữ liệu cá nhân).
      console.log(`[vtp] webhook ${ev.code} → ${ev.status} ${ev.statusName}${n ? '' : ' (không có đơn nào trong app)'}`);
    } catch (e) {
      console.warn('[vtp] Lỗi ghi trạng thái webhook:', e.message);
    }
  });
});

export default router;
