/** API Viettel Post: token shop tự tạo, máy chủ gọi API thay trình duyệt. */
import crypto from 'node:crypto';
import express from 'express';
import * as sqlite from '../../db.js';
import { createLimiter } from '../../rate-limit.js';
import * as vtp from '../../vtp.js';
import { db } from '../database.js';
import { usersDb } from '../accounts.js';
import { flushStates, getStateForUser, statesByUserId } from '../states.js';
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

// Bảng chọn dịch vụ cộng thêm: giá từng dịch vụ cho đúng đơn đang duyệt và gói đang chọn, chưa tạo đơn nào.
const vtpExtraTries = createLimiter({ max: 30, windowMs: 60 * 1000 });
router.post('/api/vtp/extras', requireAuth, async (req, res) => {
  const userId = req.user.id;
  const conn = vtpStore.get(userId);
  if (!conn?.siteToken) return res.status(400).json({ error: 'Chưa kết nối Viettel Post' });
  if (!conn.sender) return res.status(400).json({ error: 'Chưa chọn điểm lấy hàng' });
  // Mỗi lần mở bảng là 12 lần hỏi Viettel Post: chặn bấm liên tục.
  if (vtpExtraTries.retryAfter(userId) > 0) return res.status(429).json({ error: 'Hỏi giá quá nhiều lần, đợi một phút.' });
  vtpExtraTries.hit(userId);
  const service = String(req.body?.service || 'VSL9').slice(0, 10);
  const g = req.body?.group && typeof req.body.group === 'object' ? req.body.group : {};
  const r = await vtp.vtpExtraPrices(vtpStore, userId, g, service).catch((e) => ({ ok: false, error: String(e.message || e) }));
  if (!r.ok) return res.status(400).json({ error: r.error || 'Lỗi' });
  res.json({ ok: true, base: r.base, prices: r.prices });
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

const VTP_SYNC_PENDING_MSG = 'Máy chủ chưa nhận đủ đơn/món của khách này (đang đồng bộ). Đợi đồng bộ xong rồi gửi lại.';
const VTP_DRAFT_BATCH_RE = /^vtpd_[A-Za-z0-9_-]{1,40}$/;

function resolveGroupOrders(userId, g, { checkSync = true } = {}) {
  const serverOrders = getStateForUser(userId).orders || [];
  // Web gửi mã đơn; app iOS gửi mã món (app không biết mã đơn của máy chủ).
  const itemIds = new Set((Array.isArray(g?.itemIds) ? g.itemIds : []).map(String));
  const sentOrderIds = (Array.isArray(g?.orderIds) ? g.orderIds : []).map(String);
  const ids = [
    ...new Set([
      ...sentOrderIds,
      ...serverOrders
        .filter((o) => o.status !== 'cancelled' && (o.items || []).some((it) => itemIds.has(String(it.id))))
        .map((o) => String(o.id))
    ])
  ];
  if (checkSync) {
    // Món hoặc đơn client gửi mà máy chủ chưa có: thay đổi trên máy chưa đồng bộ xong. Không tạo vận đơn cho phần máy
    // chủ biết với tiền thu hộ tính cả phần chưa tới, kẻo món đó bị tách sang đơn mới và thu tiền hai lần (BL-10).
    const knownItems = new Set(
      serverOrders.filter((o) => o.status !== 'cancelled').flatMap((o) => (o.items || []).map((it) => String(it?.id)))
    );
    const knownOrders = new Set(serverOrders.map((o) => String(o.id)));
    if ([...itemIds].some((id) => !knownItems.has(id)) || sentOrderIds.some((id) => !knownOrders.has(id))) {
      return { error: VTP_SYNC_PENDING_MSG };
    }
  }
  const orders = serverOrders.filter((o) => ids.includes(String(o.id)));
  if (!orders.length) return { error: 'Không thấy đơn' };
  return { ids, orders, serverOrders };
}

function safeDraftCodGoods(orders, g) {
  let cod = null;
  let goods = null;
  if (g?.cod != null && g?.cod !== '') {
    const chk = vtp.checkGroupCod(orders, g.cod);
    if (chk.ok) {
      cod = chk.cod;
      goods = chk.goods;
    } else if (typeof g.cod === 'number' && Number.isInteger(g.cod) && g.cod >= 0 && g.cod <= vtp.MAX_COD) {
      cod = g.cod;
      if (g.goods != null && Number.isFinite(Number(g.goods))) {
        goods = Math.max(0, Math.round(Number(g.goods)));
      }
    }
  }
  return { cod, goods };
}

function settleAdoptedDraft(userId, { ids, code, fee, cod, goods, service, batchId, label }) {
  vtpJournal(userId, code, {
    source: 'draft',
    state: 'created',
    orderIds: ids,
    ref: label,
    cod,
    goods,
    fee: fee || null,
    service: service || null
  });
  let attached = [];
  mutateState(userId, 'vtp_draft_approved', '', null, (s) => {
    attached = vtp.applyVtpAdopted(s, ids, { code, fee, cod, goods, service, batchId });
  });
  vtpJournal(userId, code, attached.length ? { orderIds: attached } : { state: 'orphan' });
  flushStates();
  return attached;
}

async function vtpCreateHandler(req, res) {
  const userId = req.user.id;
  const conn = vtpStore.get(userId);
  if (!conn?.siteToken) return res.status(400).json({ error: 'Chưa kết nối Viettel Post' });
  if (!conn.sender) return res.status(400).json({ error: 'Chưa chọn điểm lấy hàng' });
  const service = String(req.body?.service || 'VSL9').slice(0, 10);
  const groups = Array.isArray(req.body?.groups) ? req.body.groups.slice(0, 100) : [];
  const batchId = 'vtp_' + Date.now().toString(36);
  const results = [];
  let stalled = false;
  for (const g of groups) {
    const resolved = resolveGroupOrders(userId, g, { checkSync: true });
    if (resolved.error) {
      results.push({ key: g?.key, ok: false, error: resolved.error });
      continue;
    }
    const { ids, orders } = resolved;
    // Lần tạo trước của một đơn trong nhóm chưa rõ kết quả: chưa cho tạo lại, kẻo ra hai vận đơn (BL-01).
    if (orders.some(vtp.vtpAttemptOpen)) {
      results.push({ key: g.key, ok: false, unknown: true, error: vtp.VTP_UNKNOWN_MSG });
      continue;
    }
    const existing = orders.find((o) => o.ship?.vtpCode);
    if (existing) {
      const { vtpCode, vtpFee, vtpCod, vtpGoods } = existing.ship;
      // Vận đơn trước tạo sai địa chỉ và chưa huỷ được: còn sống bên Viettel Post, phải huỷ xong mới tạo cái mới (BL-02).
      if (existing.ship.vtpKind === 'needsCancel') {
        const error = `Vận đơn ${vtpCode} tạo sai địa chỉ và chưa huỷ được. Huỷ vận đơn đó ở chi tiết đơn rồi mới gửi lại.`;
        results.push({ key: g.key, ok: false, needsCancel: true, code: vtpCode, error });
        continue;
      }
      results.push({ key: g.key, ok: true, code: vtpCode, already: true, fee: vtpFee ?? 0, cod: vtpCod ?? null, goods: vtpGoods ?? null });
      continue;
    }
    // Viettel Post vừa không trả lời kịp trong lô này: dừng gửi các khách còn lại, không khoá "chưa rõ" hàng loạt.
    if (stalled) {
      results.push({ key: g.key, ok: false, error: 'Chưa gửi: Viettel Post đang phản hồi chậm. Thử lại sau ít phút.' });
      continue;
    }
    // Tiền thu hộ và giá trị hàng lấy theo đơn trên máy chủ, không tin nguyên số client gửi (BL-03).
    const chk = vtp.checkGroupCod(orders, g.cod);
    if (!chk.ok) {
      // Ghi lý do vào đơn để thẻ đơn (web và app) hiện "Lỗi tạo vận đơn: …" cho tới lần gửi sau.
      mutateState(userId, 'vtp_error', '', null, (s) => {
        for (const o of s.orders || []) {
          if (!ids.includes(String(o.id))) continue;
          o.ship = { ...(o.ship || {}), vtpError: String(chk.error || 'Lỗi').slice(0, 200), vtpErrorAt: Date.now() };
        }
      });
      results.push({ key: g.key, ok: false, error: chk.error });
      continue;
    }
    // Đánh dấu "đang tạo" lên các đơn và ghi xuống đĩa TRƯỚC khi gọi Viettel Post: máy chủ có tắt giữa chừng thì
    // lúc lên lại vẫn biết đơn này có thể đã có vận đơn (BL-01).
    const attempt = { id: crypto.randomBytes(9).toString('base64url'), at: Date.now(), cod: chk.cod, goods: chk.goods, service };
    const label = String(g.ref || g.key || '').slice(0, 60);
    mutateState(userId, 'vtp_creating', '', null, (s) => vtp.markVtpCreating(s, ids, attempt));
    flushStates();
    const r = await vtp
      .vtpCreateOrder(vtpStore, userId, { ...g, cod: chk.cod, goods: chk.goods, senderPays: chk.senderPays }, service, vtpWards)
      .catch((e) => {
        console.warn(`[vtp] Tạo vận đơn ${label} lỗi bất ngờ:`, e.message);
        return { ok: false, unknown: true, error: vtp.VTP_UNKNOWN_MSG };
      });
    const { late, ...out } = r;
    if (!out.ok && !out.error) out.error = 'Lỗi';
    vtpSettle(userId, attempt, out, batchId, label, 'create', ids);
    if (late) {
      // Viettel Post trả lời muộn: ghi kết quả thật vào đơn (mã vận đơn, hoặc bỏ khoá nếu họ từ chối).
      vtpLateWaiting.add(attempt.id);
      late
        .then((final) => {
          // Tài khoản đã bị xoá trong lúc chờ: không dựng lại dữ liệu của tài khoản đó.
          if (!usersDb.users.some((u) => u.id === userId)) return;
          if (!final.unknown) vtpSettle(userId, attempt, final.ok || final.error ? final : { ...final, error: 'Lỗi' }, batchId, label + ' (trả lời muộn)', 'late', ids);
        })
        .catch((e) => console.warn(`[vtp] Lỗi ghi phản hồi muộn ${label}:`, e.message))
        .finally(() => vtpLateWaiting.delete(attempt.id));
    }
    if (out.unknown) stalled = true;
    results.push({ key: g.key, ...out });
  }
  res.json({ ok: true, results });
}

// App đã duyệt nháp thẳng trên thiết bị (UpdateOrder TYPE 1): ghi mã vận đơn vào máy chủ + sổ để đồng bộ, in tem và nhận webhook.
// Không đòi hỏi kết nối Phần 1 vì shop có thể chỉ đăng nhập Phần 2 hoặc dùng tài khoản Viettel Post thứ hai.
router.post('/api/vtp/adopt-draft', requireAuth, (req, res) =>
  vtpCreateTurn(req.user.id, () => {
    const userId = req.user.id;
    const service = String(req.body?.service || 'VSL9').slice(0, 10);
    const groups = Array.isArray(req.body?.groups) ? req.body.groups.slice(0, 100) : [];
    const defaultBatchId = 'vtpd_' + Date.now().toString(36);
    const results = [];
    for (const g of groups) {
      const code = String(g?.code || '').trim();
      if (!vtpCodeOk(code)) {
        results.push({ key: g?.key, ok: false, error: 'Mã vận đơn không hợp lệ' });
        continue;
      }
      const resolved = resolveGroupOrders(userId, g, { checkSync: false });
      if (resolved.error) {
        results.push({ key: g?.key, ok: false, error: resolved.error });
        continue;
      }
      const { ids, orders, serverOrders } = resolved;
      const idSet = new Set(ids.map(String));
      if (serverOrders.some((o) => !idSet.has(String(o.id)) && o.ship?.vtpCode === code)) {
        results.push({ key: g?.key, ok: false, error: `Mã vận đơn ${code} đã gắn với đơn khác trong app` });
        continue;
      }
      const existing = orders.find((o) => o.ship?.vtpCode);
      if (existing) {
        if (existing.ship.vtpCode === code) {
          results.push({
            key: g.key,
            ok: true,
            code,
            already: true,
            fromDraft: true,
            fee: existing.ship.vtpFee ?? 0,
            cod: existing.ship.vtpCod ?? null,
            goods: existing.ship.vtpGoods ?? null
          });
        } else {
          results.push({ key: g?.key, ok: false, error: `Đơn đã có vận đơn ${existing.ship.vtpCode}` });
        }
        continue;
      }
      const fee = Math.max(0, Math.round(Number(g?.fee) || 0));
      const { cod, goods } = safeDraftCodGoods(orders, g);
      const batchId = VTP_DRAFT_BATCH_RE.test(String(g?.batchId || '')) ? String(g.batchId) : defaultBatchId;
      const label = String(g?.ref || g?.key || '').slice(0, 60);
      settleAdoptedDraft(userId, { ids, code, fee, cod, goods, service, batchId, label });
      console.log(`[vtp] Ghi nhận nháp đã duyệt ${label} → ${code}`);
      results.push({ key: g.key, ok: true, code, fee, cod, goods, already: false, fromDraft: true });
    }
    res.json({ ok: true, results });
  })
);

// Dự phòng khi máy đang bấm không đăng nhập Phần 2 nhưng Phần 1 đang kết nối cùng tài khoản Viettel Post:
// máy chủ gọi UpdateOrder TYPE 1 thay thiết bị để duyệt nháp giữ nguyên mã vận đơn.
router.post('/api/vtp/approve-draft', requireAuth, (req, res) =>
  vtpCreateTurn(req.user.id, async () => {
    const userId = req.user.id;
    const conn = vtpStore.get(userId);
    if (!conn?.siteToken) return res.status(400).json({ error: 'Chưa kết nối Viettel Post' });
    const service = String(req.body?.service || 'VSL9').slice(0, 10);
    const groups = Array.isArray(req.body?.groups) ? req.body.groups.slice(0, 100) : [];
    const defaultBatchId = 'vtpd_' + Date.now().toString(36);
    const results = [];
    for (const g of groups) {
      const code = String(g?.code || '').trim();
      if (!vtpCodeOk(code)) {
        results.push({ key: g?.key, ok: false, error: 'Mã vận đơn không hợp lệ' });
        continue;
      }
      const resolved = resolveGroupOrders(userId, g, { checkSync: true });
      if (resolved.error) {
        results.push({ key: g?.key, ok: false, error: resolved.error });
        continue;
      }
      const { ids, orders, serverOrders } = resolved;
      if (orders.some(vtp.vtpAttemptOpen)) {
        results.push({ key: g.key, ok: false, unknown: true, error: vtp.VTP_UNKNOWN_MSG });
        continue;
      }
      const idSet = new Set(ids.map(String));
      if (serverOrders.some((o) => !idSet.has(String(o.id)) && o.ship?.vtpCode === code)) {
        results.push({ key: g?.key, ok: false, error: `Mã vận đơn ${code} đã gắn với đơn khác trong app` });
        continue;
      }
      const existing = orders.find((o) => o.ship?.vtpCode);
      if (existing) {
        const { vtpCode, vtpFee, vtpCod, vtpGoods, vtpKind } = existing.ship;
        if (vtpKind === 'needsCancel') {
          results.push({
            key: g.key,
            ok: false,
            needsCancel: true,
            code: vtpCode,
            error: `Vận đơn ${vtpCode} tạo sai địa chỉ và chưa huỷ được. Huỷ vận đơn đó ở chi tiết đơn rồi mới gửi lại.`
          });
        } else if (vtpCode === code) {
          results.push({
            key: g.key,
            ok: true,
            code: vtpCode,
            already: true,
            fromDraft: true,
            fee: vtpFee ?? 0,
            cod: vtpCod ?? null,
            goods: vtpGoods ?? null
          });
        } else {
          results.push({ key: g?.key, ok: false, error: `Đơn đã có vận đơn ${vtpCode}` });
        }
        continue;
      }
      const r = await vtp.vtpApproveDraft(vtpStore, userId, code);
      if (!r.ok) {
        mutateState(userId, 'vtp_error', '', null, (s) => {
          for (const o of s.orders || []) {
            if (!ids.includes(String(o.id))) continue;
            o.ship = { ...(o.ship || {}), vtpError: String(r.error || 'Lỗi').slice(0, 200), vtpErrorAt: Date.now() };
          }
        });
        results.push({ key: g.key, ok: false, error: r.error || 'Không duyệt được nháp' });
        continue;
      }
      const finalCode = r.code;
      const finalFee = r.fee > 0 ? r.fee : Math.max(0, Math.round(Number(g?.fee) || 0));
      const { cod, goods } = safeDraftCodGoods(orders, g);
      const batchId = VTP_DRAFT_BATCH_RE.test(String(g?.batchId || '')) ? String(g.batchId) : defaultBatchId;
      const label = String(g?.ref || g?.key || '').slice(0, 60);
      settleAdoptedDraft(userId, { ids, code: finalCode, fee: finalFee, cod, goods, service, batchId, label });
      console.log(`[vtp] Duyệt nháp ${label} → ${finalCode}`);
      results.push({ key: g.key, ok: true, code: finalCode, fee: finalFee, cod, goods, already: false, fromDraft: true });
    }
    res.json({ ok: true, results });
  })
);

/** Các lần tạo "chưa rõ" mà máy chủ còn đang nghe câu trả lời muộn của Viettel Post. */
const vtpLateWaiting = new Set();

/**
 * Sổ vận đơn (BL-08): ghi lỗi thì chỉ cảnh báo, không làm hỏng việc đang làm. Mã chưa có trong sổ (vận đơn tạo từ
 * trước khi có sổ) được ghi với nguồn "legacy".
 */
function vtpJournal(userId, code, w) {
  if (!code) return;
  try {
    const set = Object.fromEntries(Object.entries(w).filter(([, v]) => v !== undefined));
    const fresh = !sqlite.getWaybill(db, userId, code);
    sqlite.recordWaybill(db, userId, code, fresh ? { source: 'legacy', state: 'created', ...set } : set);
  } catch (e) {
    console.warn(`[vtp] Không ghi được sổ vận đơn ${code}:`, e.message);
  }
}

/** Ghi kết quả một lần tạo vận đơn vào các đơn của lần tạo đó, cho mọi máy thấy. */
function vtpSettle(userId, attempt, r, batchId, label, source = 'create', ids = []) {
  // Có mã thì ghi sổ TRƯỚC khi ghi đơn: đơn có bị đổi, xoá, hay máy chủ tắt ngay sau đó thì mã vẫn còn (BL-08).
  if (r.code) {
    vtpJournal(userId, r.code, {
      source,
      state: r.ok ? 'created' : r.needsCancel ? 'needsCancel' : r.cancelled ? 'cancelled' : 'created',
      orderIds: ids,
      attemptId: attempt.id || null,
      ref: label,
      cod: r.cod ?? attempt.cod ?? null,
      goods: r.goods ?? attempt.goods ?? null,
      fee: r.fee || null,
      service: attempt.service || null,
      note: r.cancelled ? 'Tự huỷ vì Viettel Post hiểu sai địa chỉ' : r.needsCancel ? String(r.note || '').slice(0, 300) : undefined
    });
  }
  let attached = [];
  const action = r.ok ? 'vtp_created' : r.unknown ? 'vtp_unknown' : r.needsCancel ? 'vtp_needs_cancel' : 'vtp_error';
  mutateState(userId, action, '', null, (s) => {
    attached = vtp.settleVtpCreate(s, attempt, r, { batchId });
  });
  const n = attached.length;
  if (r.code && (r.ok || r.needsCancel)) {
    vtpJournal(userId, r.code, n ? { orderIds: attached } : { state: 'orphan' });
    // Ghi đơn xuống đĩa ngay, không đợi lượt ghi 150ms (BL-08).
    flushStates();
  }
  if (r.ok) console.log(`[vtp] Tạo vận đơn ${label} → ${r.code}${r.parsed ? ` · VTP hiểu: ${r.parsed}` : ' · chưa đối chiếu được địa chỉ'}`);
  if (r.unknown) console.warn(`[vtp] Tạo vận đơn ${label}: CHƯA RÕ kết quả, đã khoá ${n} đơn chờ kiểm tra`);
  if (r.needsCancel) console.warn(`[vtp] Vận đơn ${r.code} (${label}) sai địa chỉ, CHƯA huỷ được: gắn vào ${n} đơn với cờ cần huỷ`);
  // Có mã mà không còn đơn nào nhận (đơn bị xoá, hoặc shop đã xử lý lần tạo này theo cách khác): để lại dấu vết.
  if (r.code && (r.ok || r.needsCancel) && !n) console.warn(`[vtp] Vận đơn ${r.code} (${label}) có bên Viettel Post nhưng không gắn được vào đơn nào trong app`);
  if (r.needsCancel && n) scheduleVtpCancelRetry(userId, r.code);
  return n;
}

// Tự huỷ vận đơn sai địa chỉ thất bại (BL-02): thử lại vài lần ở nền. Trong lúc đó đơn mang cờ "cần huỷ" để shop
// thấy và tự bấm Huỷ vận đơn; hết các lần thử mà chưa được thì cờ vẫn nằm đó.
const VTP_CANCEL_RETRY_MS = String(process.env.VTP_CANCEL_RETRY_MS || '60000,300000,900000').split(',').map(Number).filter((n) => n > 0);
function scheduleVtpCancelRetry(userId, code, i = 0) {
  if (i >= VTP_CANCEL_RETRY_MS.length) return;
  setTimeout(async () => {
    try {
      const waiting = () =>
        !!vtpStore.get(userId) && (getStateForUser(userId).orders || []).some((o) => o.ship?.vtpCode === code && o.ship.vtpKind === 'needsCancel');
      if (!waiting()) return;
      const r = await vtp.vtpCancel(vtpStore, userId, code, 'Viettel Post hiểu địa chỉ khác với địa chỉ shop nhập');
      if (!waiting()) return;
      if (!r.ok) return scheduleVtpCancelRetry(userId, code, i + 1);
      console.log(`[vtp] Đã tự huỷ lại vận đơn sai địa chỉ ${code}`);
      vtpJournal(userId, code, { state: 'cancelled', status: 107, statusName: 'Đã huỷ vận đơn sai địa chỉ' });
      mutateState(userId, 'vtp_cancelled', '', null, (s) =>
        vtp.applyVtpStatus(s, { code, status: 107, statusName: 'Đã huỷ vận đơn sai địa chỉ', note: '', location: '' })
      );
    } catch (e) {
      console.warn(`[vtp] Lỗi tự huỷ lại vận đơn ${code}:`, e.message);
    }
  }, VTP_CANCEL_RETRY_MS[i]).unref();
}

// Lần tạo "chưa rõ": shop kiểm trên viettelpost.vn rồi báo lại. Có vận đơn thì nhập mã (đơn nhận mã đó);
// không có thì xác nhận `none` để bỏ khoá và tạo lại. Web gửi mã đơn, app gửi mã món (như /api/vtp/create).
router.post('/api/vtp/settle', requireAuth, (req, res) =>
  vtpCreateTurn(req.user.id, () => {
    const userId = req.user.id;
    const all = getStateForUser(userId).orders || [];
    const orderIds = new Set((Array.isArray(req.body?.orderIds) ? req.body.orderIds : []).map(String));
    const itemIds = new Set((Array.isArray(req.body?.itemIds) ? req.body.itemIds : []).map(String));
    const hit = all.find(
      (o) => vtp.vtpAttemptOpen(o) && (orderIds.has(String(o.id)) || (o.items || []).some((it) => itemIds.has(String(it.id))))
    );
    if (!hit) return res.status(400).json({ error: 'Đơn này không còn chờ kiểm tra vận đơn' });
    const attempt = hit.ship.vtpAttempt || {};
    const code = String(req.body?.code || '').trim();
    if (code) {
      if (!vtpCodeOk(code)) return res.status(400).json({ error: 'Mã vận đơn không hợp lệ' });
      if (all.some((o) => o.ship?.vtpCode === code || o.ship?.vtpOldCode === code)) {
        return res.status(400).json({ error: `Mã vận đơn ${code} đã gắn với một đơn khác trong app` });
      }
      const ids = vtp.ordersOfAttempt(getStateForUser(userId), attempt);
      vtpSettle(userId, attempt, { ok: true, code, fee: 0, cod: attempt.cod, goods: attempt.goods }, 'vtp_' + Date.now().toString(36), 'shop nhập mã sau khi kiểm tra', 'shop', ids);
      return res.json({ ok: true, code });
    }
    if (req.body?.none !== true) return res.status(400).json({ error: 'Nhập mã vận đơn, hoặc xác nhận Viettel Post không có vận đơn này' });
    if (vtpLateWaiting.has(attempt.id)) {
      return res.status(409).json({ error: 'Viettel Post chưa trả lời xong lần tạo này. Đợi thêm vài phút rồi kiểm tra lại.' });
    }
    console.log(`[vtp] Shop xác nhận Viettel Post không có vận đơn của lần tạo ${attempt.id}: bỏ khoá`);
    vtpSettle(userId, attempt, { ok: false, error: '' }, '', 'shop kiểm tra');
    res.json({ ok: true });
  })
);

// Sổ vận đơn của tài khoản (BL-08), mới nhất trước: để đối soát với viettelpost.vn. `state=orphan|unmatched|…` để lọc.
router.get('/api/vtp/waybills', requireAuth, (req, res) => {
  const state = String(req.query?.state || '').replace(/[^a-zA-Z]/g, '').slice(0, 20);
  res.json({ ok: true, waybills: sqlite.listWaybills(db, req.user.id, { state, limit: Number(req.query?.limit) || 200 }) });
});

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
  vtpJournal(req.user.id, code, { state: force ? 'detached' : 'cancelled', status: force ? undefined : 107, statusName });
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
      const userId = found.userId;
      vtpStore.set(userId, { lastHookAt: Date.now() });
      const orders = getStateForUser(userId).orders || [];
      const holders = orders.filter((o) => o.ship?.vtpCode === ev.code).map((o) => String(o.id));
      const known = holders.length > 0 || orders.some((o) => o.ship?.vtpOldCode === ev.code);
      let n = 0;
      mutateState(userId, 'vtp_status', '', null, (s) => { n = vtp.applyVtpStatus(s, ev); });
      // Sổ vận đơn (BL-08): ghi trạng thái mới; mã chưa đơn nào biết thì ghi là "unmatched" để đối soát.
      if (vtpCodeOk(ev.code)) {
        const row = sqlite.getWaybill(db, userId, ev.code);
        const kind = vtp.vtpStatusKind(ev.status);
        const finalState = { delivered: 'delivered', cancelled: 'cancelled', returned: 'returned' }[kind];
        const unmatched = !known && (!row || row.state === 'unmatched');
        vtpJournal(userId, ev.code, {
          source: known ? 'legacy' : 'webhook',
          state: finalState || (unmatched ? 'unmatched' : row ? undefined : 'created'),
          orderIds: holders,
          status: ev.status,
          statusName: ev.statusName.slice(0, 120),
          ...(ev.cod != null && !row?.cod ? { cod: ev.cod } : {})
        });
        // Vận đơn lạ còn sống: có thể là vận đơn của lần tạo "chưa rõ" (BL-01). Gợi ý cho shop xác nhận, không tự gắn.
        if (unmatched && kind !== 'cancelled') {
          let hinted = [];
          mutateState(userId, 'vtp_hint', '', null, (s) => {
            hinted = vtp.addVtpHint(s, { code: ev.code, cod: ev.cod, statusName: ev.statusName });
          });
          if (hinted.length) console.log(`[vtp] webhook ${ev.code}: gợi ý cho ${hinted.length} đơn đang chờ kiểm tra vận đơn`);
        }
      }
      // Ghi lại mã + trạng thái để dò lỗi (không có dữ liệu cá nhân).
      console.log(`[vtp] webhook ${ev.code} → ${ev.status} ${ev.statusName}${n ? '' : ' (không có đơn nào trong app)'}`);
    } catch (e) {
      console.warn('[vtp] Lỗi ghi trạng thái webhook:', e.message);
    }
  });
});

// Máy chủ vừa lên lại. Lần tạo vận đơn dang dở từ trước (BL-01): không biết Viettel Post đã tạo chưa → khoá "chưa rõ".
// Vận đơn sai địa chỉ còn chờ huỷ (BL-02): thử huỷ lại ở nền.
export function resumeVtpAfterRestart() {
  for (const [uid, st] of Object.entries(statesByUserId)) {
    const orders = Array.isArray(st?.orders) ? st.orders : [];
    if (orders.some((o) => o?.ship?.vtpKind === 'creating')) {
      let n = 0;
      mutateState(uid, 'vtp_unknown', '', null, (s) => {
        n = vtp.sweepVtpCreating(s);
      });
      console.warn(`[vtp] ${uid}: ${n} đơn đang tạo vận đơn dở lúc máy chủ tắt, khoá chờ kiểm tra`);
    }
    const stuck = new Set(orders.filter((o) => o?.ship?.vtpKind === 'needsCancel' && o.ship.vtpCode).map((o) => o.ship.vtpCode));
    for (const code of stuck) scheduleVtpCancelRetry(uid, code);
  }
}

export default router;
