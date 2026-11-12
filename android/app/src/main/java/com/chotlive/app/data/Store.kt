package com.chotlive.app.data

import android.os.Handler
import android.os.Looper
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.chotlive.app.model.Clock
import com.chotlive.app.model.Customer
import com.chotlive.app.model.DateFilter
import com.chotlive.app.model.DeliveryAddress
import com.chotlive.app.model.LiveComment
import com.chotlive.app.model.LiveSession
import com.chotlive.app.model.Order
import com.chotlive.app.model.OrderItem
import com.chotlive.app.model.OrderStatus
import com.chotlive.app.model.PriceParser
import com.chotlive.app.model.ShipInfo
import com.chotlive.app.model.ShipState
import com.chotlive.app.model.TikTokAccount
import com.chotlive.app.model.Vtp
import java.io.File
import java.time.LocalDate
import java.util.UUID
import java.util.concurrent.Executors

/**
 * Lưu bình luận, khách hàng, phiên live... trên máy và đồng bộ với server.
 * Mỗi tài khoản có một file riêng: files/accounts/<mã tài khoản>/chotlive.json.
 * Mọi thay đổi chạy trên main thread; ghi file chạy ở luồng riêng.
 */
class Store(private val directory: File, account: String?) {
    var comments by mutableStateOf(listOf<LiveComment>()); private set
    var customers by mutableStateOf(listOf<Customer>()); private set
    var sessions by mutableStateOf(listOf<LiveSession>()); private set
    var accounts by mutableStateOf(listOf<TikTokAccount>()); private set
    var activeAccountId by mutableStateOf<String?>(null); private set
    var keywords by mutableStateOf(DEFAULT_KEYWORDS); private set
    /** Báo cho người dùng khi không đọc hoặc không ghi được dữ liệu. */
    var storageWarning by mutableStateOf<String?>(null)

    /** ID vừa bắt đầu live với "Lưu ID này cho lần sau" đang tắt. */
    var unsavedLiveId: String? = null

    /** Có thay đổi cần gửi lên server. */
    var onLocalChange: (() -> Unit)? = null
    var syncState = SyncState()
        private set

    private data class Sending(
        val id: Int, val customers: Set<String>, val items: Set<String>, val accounts: Set<String>,
        val accountsDirty: Boolean, val initial: Boolean,
    )

    /** Gói đang chờ server xác nhận. */
    private var sending: Sending? = null
    /** Đổi tiếp trong lúc chờ xác nhận thì vẫn phải gửi lại. */
    private var touchedWhileSending = mutableSetOf<String>()
    private var accountsTouchedWhileSending = false
    private var nextUpdateId = 1
    private var knownCommentIds = HashSet<String>()

    private val main = Handler(Looper.getMainLooper())
    private val saveRunnable = Runnable { save() }
    private val writer = Executors.newSingleThreadExecutor()
    private var accountKey: String? = account
    /** Có file chưa đọc được thì không ghi, tránh đè lên dữ liệu cũ. */
    private var saveBlocked = false
    @Volatile private var saveFailed = false

    private val fileUrl: File?
        get() = accountKey?.let { File(File(File(directory, "accounts"), AuthStorage.folderName(it)), FILE_NAME) }

    init {
        load()
    }

    /** Đăng nhập hoặc đăng xuất: ghi nốt dữ liệu tài khoản cũ rồi nạp dữ liệu tài khoản mới. */
    fun switchAccount(account: String?) {
        if (account == accountKey) return
        closeOpenSession()
        save()
        comments = emptyList()
        customers = emptyList()
        sessions = emptyList()
        accounts = emptyList()
        activeAccountId = null
        keywords = DEFAULT_KEYWORDS
        storageWarning = null
        unsavedLiveId = null
        syncState = SyncState()
        sending = null
        touchedWhileSending = mutableSetOf()
        accountsTouchedWhileSending = false
        knownCommentIds = HashSet()
        saveBlocked = false
        saveFailed = false
        accountKey = account
        load()
    }

    // MARK: - Bình luận

    val openSession: LiveSession? get() = sessions.firstOrNull { it.isLive }

    private fun refreshKnownCommentIds() {
        if (knownCommentIds.size != comments.size) knownCommentIds = comments.mapTo(HashSet()) { it.id }
    }

    private fun trimmed(list: List<LiveComment>): List<LiveComment> {
        if (list.size <= COMMENT_LIMIT) return list
        val cut = list.take(COMMENT_LIMIT)
        knownCommentIds = cut.mapTo(HashSet()) { it.id }
        return cut
    }

    fun addComment(c: LiveComment, tiktok: String) {
        refreshKnownCommentIds()
        if (knownCommentIds.contains(c.id)) return
        var comment = c
        if (comment.sessionId == null) {
            // Server chưa gắn phiên (server bản cũ): tự ghi phiên trên máy như trước.
            if (openSession == null) beginSession(tiktok)
            comment = comment.copy(sessionId = openSession?.id)
        }
        knownCommentIds.add(comment.id)
        comments = trimmed(listOf(comment) + comments)
        val i = sessions.indexOfFirst { it.id == comment.sessionId }
        if (i >= 0) {
            sessions = sessions.toMutableList().also {
                it[i] = it[i].copy(commentCount = it[i].commentCount + 1, lastActivity = comment.ts)
            }
        }
        scheduleSave()
    }

    /** Bình luận lấy bù từ server (lúc máy mất mạng hoặc khoá màn hình). Bộ đếm phiên do server gửi. */
    fun addComments(batch: List<LiveComment>) {
        refreshKnownCommentIds()
        val fresh = batch.filter { !knownCommentIds.contains(it.id) }
        if (fresh.isEmpty()) return
        knownCommentIds.addAll(fresh.map { it.id })
        comments = trimmed((comments + fresh).sortedByDescending { it.ts })
        scheduleSave()
    }

    /** Bình luận chốt đơn: đã chốt tay, có từ khoá chốt, hoặc chỉ ghi mã. "Mã 130 giá sao" chỉ là hỏi giá. */
    fun isClosingComment(c: LiveComment): Boolean {
        if (c.printed) return true
        val text = PriceParser.stripAccents(c.text.lowercase())
        if (keywords.any { it.isNotEmpty() && text.contains(PriceParser.stripAccents(it.lowercase())) }) return true
        return PriceParser.isOnlyCodes(c.text)
    }

    // MARK: - Phiên live

    /** Đồng bộ phiên theo trạng thái kết nối từ server (chỉ server bản cũ). */
    fun syncLive(state: String, username: String) {
        when (state) {
            "connected" -> {
                openSession?.let { open ->
                    if (open.tiktok.equals(username, ignoreCase = true) || username.isEmpty()) return
                    closeOpenSession()
                }
                beginSession(username)
            }
            "idle", "ended", "error", "disconnected" -> closeOpenSession()
        }
    }

    private fun beginSession(tiktok: String) {
        val now = Clock.now
        // Rớt mạng ngắn rồi nối lại: tiếp tục phiên cũ thay vì tạo phiên mới.
        val i = sessions.indexOfFirst { s ->
            s.tiktok.equals(tiktok, ignoreCase = true) && (s.end?.let { now - it < 300_000 } ?: false)
        }
        sessions = if (i >= 0) {
            sessions.toMutableList().also { it[i] = it[i].copy(end = null) }
        } else {
            listOf(LiveSession(id = UUID.randomUUID().toString().uppercase(), tiktok = tiktok, start = now)) + sessions
        }
        if (tiktok.isNotEmpty() && tiktok.lowercase() != unsavedLiveId) {
            addAccount(tiktok, "", activate = activeAccountId == null)
        }
        save()
    }

    private fun closeOpenSession() {
        if (sessions.none { it.isLive }) return
        val now = Clock.now
        sessions = sessions.map { s ->
            if (!s.isLive) s else {
                // App bị tắt giữa phiên: lấy mốc hoạt động cuối thay vì lúc mở lại app.
                val last = s.lastActivity ?: s.start
                s.copy(end = if (now - last > 600_000) last else now)
            }
        }
        save()
    }

    /** Lần live gần nhất của một tài khoản. */
    fun lastSession(account: String): LiveSession? =
        sessions.filter { it.tiktok.lowercase() == account }.maxByOrNull { it.start }

    fun sessions(filter: DateFilter): List<LiveSession> = sessions.filter { filter.overlaps(it) }.sortedByDescending { it.start }

    fun comments(session: String): List<LiveComment> = comments.filter { it.sessionId == session }

    fun sessionCustomerCount(id: String): Int = customers.count { c -> c.items.any { it.sessionId == id } }

    fun sessionOrderCount(id: String): Int =
        customers.sumOf { c -> c.items.filter { it.sessionId == id }.map { it.groupId ?: it.id }.toSet().size }

    // MARK: - Khách & đơn

    private inline fun editCustomers(block: (MutableList<Customer>) -> Unit) {
        customers = customers.toMutableList().also(block)
    }

    /** Lưu bình luận vào khách (tạo khách nếu chưa có). Trả về các món của bình luận này;
     *  bình luận chốt nhiều mã ("Chốt 120 với 180") sinh ra nhiều món. */
    fun saveToCustomer(c: LiveComment): List<OrderItem> {
        val key = key(c.uniqueId, c.userId)
        val tokens = if (c.price > 0) PriceParser.orderTokens(c.text) else emptyList()
        var items: List<OrderItem> = if (tokens.size > 1) {
            tokens.mapIndexed { i, t ->
                OrderItem(
                    id = if (i == 0) c.id else "${c.id}#${i + 1}", comment = c.text, price = t.price, ts = c.ts,
                    sessionId = c.sessionId, groupId = c.sessionId, code = t.code, commentId = c.id,
                )
            }
        } else {
            listOf(
                OrderItem(
                    id = c.id, comment = c.text, price = c.price, ts = c.ts, sessionId = c.sessionId,
                    groupId = c.sessionId, code = tokens.firstOrNull()?.code, commentId = c.id,
                )
            )
        }

        val ci = comments.indexOfFirst { it.id == c.id }
        if (ci >= 0 && !comments[ci].printed) {
            comments = comments.toMutableList().also { it[ci] = it[ci].copy(printed = true) }
        }
        val idx = customers.indexOfFirst { it.id == key || (c.userId.isNotEmpty() && it.userId == c.userId) }
        if (idx >= 0) {
            val existing = customers[idx].items.filter { (it.commentId ?: it.id) == c.id }
            if (existing.isNotEmpty()) return existing
            // Đơn của phiên này đã gửi đi thì món mới phải sang đơn khác (xem `openGroupId`).
            val group = openGroupId(customers[idx], c.sessionId)
            if (group != c.sessionId) items = items.map { it.copy(groupId = group) }
            val added = items
            editCustomers { list ->
                val cur = list[idx]
                list[idx] = cur.copy(
                    items = cur.items + added,
                    userId = cur.userId.ifEmpty { c.userId },
                    nickname = c.nickname.ifEmpty { cur.nickname },
                )
            }
            clearManualCod(customers[idx].id)
        } else {
            editCustomers { it.add(Customer(id = key, uniqueId = c.uniqueId, userId = c.userId, nickname = c.nickname, items = items)) }
        }
        touchCustomer(customers.firstOrNull { cu -> cu.items.any { it.commentId == c.id || it.id == c.id } }?.id ?: key)
        save()
        return items
    }

    /**
     * Nhóm (đơn) nhận món mới của một phiên live. Bình thường là đơn của chính phiên đó. Đơn ấy đã gửi đi
     * (đang giao, đã giao, đã xuất, đã có vận đơn) thì gói hàng và tiền thu hộ đã chốt: món chốt thêm
     * vào đơn còn mở khác của phiên, chưa có thì mở đơn mới, để món đó vẫn được duyệt, gửi và thu tiền.
     */
    private fun openGroupId(customer: Customer, sessionId: String?): String? {
        sessionId ?: return null
        val mine = orders(customer).filter { o -> o.items.any { it.sessionId == sessionId && it.groupId != null } }
        if (mine.isEmpty()) return sessionId
        val open = mine.filter { Vtp.state(it).isPending && it.ship?.vtpCode.isNullOrEmpty() }
        if (open.any { it.key == sessionId }) return sessionId
        open.firstOrNull()?.items?.firstNotNullOfOrNull { it.groupId }?.let { return it }
        return sessionId + "~" + UUID.randomUUID().toString().take(8).lowercase()
    }

    /** Tên khách vừa bị bỏ số thu hộ nhập tay vì đơn đổi món; màn hình đọc một lần để báo. */
    private var codResetName: String? = null

    fun takeCodResetNotice(): String? {
        val name = codResetName ?: return null
        codResetName = null
        return "Đơn của $name vừa đổi món: đã bỏ tiền thu hộ nhập tay, tính lại theo hàng mới."
    }

    /**
     * Tiền thu hộ nhập tay là cho gói hàng cũ. Đơn chưa gửi của khách đổi món (thêm, sửa giá, bớt) thì bỏ số đó
     * ở mọi đơn chưa gửi của khách, để thu hộ tính lại theo hàng mới, giống web.
     */
    private fun clearManualCod(customerId: String) {
        val idx = customers.indexOfFirst { it.id == customerId }
        if (idx < 0) return
        val c = customers[idx]
        val pending = orders(c).filter { Vtp.state(it).isPending }.flatMap { o -> o.items.map { it.id } }.toSet()
        var cleared = false
        val items = c.items.map {
            val ship = it.ship
            if (ship?.codOverride != null && pending.contains(it.id)) {
                cleared = true
                it.copy(ship = ship.copy(codOverride = null))
            } else it
        }
        if (!cleared) return
        editCustomers { it[idx] = c.copy(items = items) }
        codResetName = c.displayName
    }

    fun deleteItem(customerId: String, itemId: String) {
        val idx = customers.indexOfFirst { it.id == customerId }
        if (idx < 0) return
        editCustomers { list ->
            val rest = list[idx].items.filter { it.id != itemId }
            if (rest.isEmpty()) list.removeAt(idx) else list[idx] = list[idx].copy(items = rest)
        }
        clearManualCod(customerId)
        touchCustomer(customerId, setOf(itemId))
        save()
    }

    fun deleteOrder(o: Order) {
        val idx = customers.indexOfFirst { it.id == o.customer.id }
        if (idx < 0) return
        val ids = o.items.map { it.id }.toSet()
        editCustomers { list ->
            val rest = list[idx].items.filter { !ids.contains(it.id) }
            if (rest.isEmpty()) list.removeAt(idx) else list[idx] = list[idx].copy(items = rest)
        }
        touchCustomer(o.customer.id, ids)
        save()
    }

    /** Thay toàn bộ sản phẩm của đơn bằng danh sách đã sửa. */
    fun updateOrder(o: Order, edited: List<OrderItem>) {
        val idx = customers.indexOfFirst { it.id == o.customer.id }
        if (idx < 0) return
        val ids = o.items.map { it.id }.toSet()
        editCustomers { list ->
            val rest = list[idx].items.filter { !ids.contains(it.id) } + edited
            if (rest.isEmpty()) list.removeAt(idx) else list[idx] = list[idx].copy(items = rest)
        }
        if (edited.sumOf { it.lineTotal } != o.total) clearManualCod(o.customer.id)
        touchCustomer(o.customer.id, ids - edited.map { it.id }.toSet())
        save()
    }

    /** Tạo đơn tay. Trả về id đơn. */
    fun createOrder(nickname: String, uniqueId: String, draft: List<OrderItem>): String {
        val handle = uniqueId.trim('@', ' ').lowercase()
        val name = nickname.trim()
        val cid = if (handle.isEmpty()) "manual-" + name.lowercase() else handle
        val group = "manual-" + UUID.randomUUID().toString().uppercase()
        val now = Clock.now
        val items = draft.map { it.copy(ts = now, groupId = group) }
        val idx = customers.indexOfFirst { it.id == cid }
        editCustomers { list ->
            if (idx >= 0) {
                val cur = list[idx]
                list[idx] = cur.copy(items = cur.items + items, nickname = name.ifEmpty { cur.nickname })
            } else {
                list.add(Customer(id = cid, uniqueId = handle, userId = "", nickname = name.ifEmpty { handle }, items = items))
            }
        }
        touchCustomer(cid)
        save()
        return "$cid|$group"
    }

    fun setAddress(a: DeliveryAddress, customerId: String) {
        val idx = customers.indexOfFirst { it.id == customerId }
        if (idx < 0) return
        editCustomers { it[idx] = it[idx].copy(address = a) }
        touchCustomer(customerId)
        save()
    }

    fun markPrinted(itemId: String) {
        var touched: String? = null
        editCustomers { list ->
            for (ci in list.indices) {
                val ii = list[ci].items.indexOfFirst { it.id == itemId }
                if (ii >= 0) {
                    list[ci] = list[ci].copy(items = list[ci].items.toMutableList().also { it[ii] = it[ii].copy(printed = true) })
                    touched = list[ci].id
                }
            }
        }
        touched?.let { touchCustomer(it) }
        save()
    }

    /** Giao hàng: chưa giao → đang giao → đã giao → (bấm lại) về chưa giao. */
    fun advanceDelivery(o: Order) {
        val ids = o.items.map { it.id }.toSet()
        val status = o.status
        editCustomers { list ->
            for (ci in list.indices) {
                if (list[ci].id != o.customer.id) continue
                list[ci] = list[ci].copy(items = list[ci].items.map { it ->
                    if (!ids.contains(it.id)) it else when (status) {
                        OrderStatus.NEW, OrderStatus.PRINTED -> it.copy(shipping = true, delivered = false)
                        OrderStatus.SHIPPING -> it.copy(shipping = false, delivered = true)
                        OrderStatus.DELIVERED -> it.copy(shipping = false, delivered = false)
                    }
                })
            }
        }
        touchCustomer(o.customer.id)
        save()
    }

    // MARK: - Duyệt đơn & Viettel Post

    /**
     * Ghi thông tin giao vào mọi món của từng đơn (id đơn → ship). `shipping`: true chuyển Đang giao,
     * false đưa về chưa giao, null giữ nguyên. Server đọc `ship` để web thấy đúng trạng thái.
     */
    fun setShip(changes: Map<String, ShipInfo>, shipping: Boolean? = null) {
        val touched = mutableSetOf<String>()
        for ((orderId, ship) in changes) {
            val o = order(orderId) ?: continue
            val ci = customers.indexOfFirst { it.id == o.customer.id }
            if (ci < 0) continue
            val ids = o.items.map { it.id }.toSet()
            editCustomers { list ->
                list[ci] = list[ci].copy(items = list[ci].items.map {
                    if (!ids.contains(it.id)) it
                    else if (shipping != null) it.copy(ship = ship, shipping = shipping, delivered = false)
                    else it.copy(ship = ship)
                })
            }
            touched.add(o.customer.id)
        }
        if (touched.isEmpty()) return
        touched.forEach { touchCustomer(it) }
        save()
    }

    /**
     * Bảng Duyệt đơn: chuyển các đơn được tick sang Chờ gửi (`ready`) hoặc Gom sau (`hold`).
     * Tiền cọc ghi ở đơn đầu tiên, các cài đặt khác ghi ở mọi đơn, giống web.
     * `dropped`: đơn đã duyệt nhưng bị bỏ tick, đưa về chưa duyệt để không còn gộp chung vận đơn.
     */
    fun approve(orderIds: List<String>, state: ShipState, base: ShipInfo, dropped: List<String> = emptyList()) {
        val changes = LinkedHashMap<String, ShipInfo>()
        for (id in dropped) {
            val s = order(id)?.ship ?: continue
            changes[id] = s.copy(state = ShipState.ASK.raw, deposit = 0, codOverride = null)
        }
        orderIds.forEachIndexed { i, id ->
            // Giữ mã vận đơn đã huỷ và lỗi lần gửi trước: lần gửi sau cần biết để không trùng mã đơn.
            val old = order(id)?.ship
            changes[id] = base.copy(
                state = state.raw,
                deposit = if (i > 0) 0 else base.deposit,
                vtpOldCode = old?.vtpOldCode, vtpKind = old?.vtpKind, vtpError = old?.vtpError, vtpErrorAt = old?.vtpErrorAt,
                exportedAt = null, batchId = null,
            )
        }
        setShip(changes)
    }

    /** Đã xuất file Viettel Post: các đơn chuyển Đang giao và rời khỏi thanh Sẵn sàng xuất. */
    fun markExported(orders: List<Order>, now: Long = Clock.now) {
        val batch = "vtp_" + now.toString(36)
        setShip(orders.associate { o ->
            o.id to (o.ship ?: ShipInfo()).copy(state = ShipState.EXPORTED.raw, exportedAt = now, batchId = batch)
        }, shipping = true)
    }

    /** Hoàn tác xuất: đơn cùng lần xuất của khách về lại Chờ gửi. */
    fun undoExport(o: Order) {
        val batch = o.ship?.batchId
        val list = orders(o.customer).filter { it.id == o.id || (batch != null && it.ship?.batchId == batch) }
        setShip(list.associate { x ->
            x.id to (x.ship ?: ShipInfo()).copy(state = ShipState.READY.raw, exportedAt = null, batchId = null)
        }, shipping = false)
    }

    /** Đang giao ↔ Đã giao. */
    fun setDelivered(o: Order, delivered: Boolean) {
        val ids = o.items.map { it.id }.toSet()
        val ci = customers.indexOfFirst { it.id == o.customer.id }
        if (ci < 0) return
        editCustomers { list ->
            list[ci] = list[ci].copy(items = list[ci].items.map {
                if (ids.contains(it.id)) it.copy(delivered = delivered, shipping = !delivered) else it
            })
        }
        touchCustomer(o.customer.id)
        save()
    }

    // Ghi kết quả Viettel Post lên máy ngay, không chờ máy chủ đồng bộ về.

    fun applyVtpCreated(orders: List<Order>, code: String, fee: Int, service: String, now: Long = Clock.now) {
        val batch = "vtp_" + now.toString(36)
        setShip(orders.associate { o ->
            o.id to (o.ship ?: ShipInfo()).copy(
                state = ShipState.EXPORTED.raw, exportedAt = now, batchId = batch,
                vtpCode = code, vtpFee = fee, vtpService = service, vtpStatus = 0, vtpStatusName = "Chờ lấy hàng",
                vtpStatusAt = now, vtpKind = "created", vtpNote = null, vtpError = null, vtpErrorAt = null,
            )
        }, shipping = true)
    }

    fun applyVtpError(orders: List<Order>, error: String, now: Long = Clock.now) {
        setShip(orders.associate { o -> o.id to (o.ship ?: ShipInfo()).copy(vtpError = error, vtpErrorAt = now) })
    }

    /** Huỷ vận đơn xong: đơn về Chờ gửi, giữ mã cũ để tra (giống máy chủ). */
    fun applyVtpCancelled(code: String, name: String = "Shop đã huỷ vận đơn") {
        val now = Clock.now
        setShip(allOrders().filter { it.ship?.vtpCode == code }.associate { o ->
            o.id to (o.ship ?: ShipInfo()).copy(
                state = ShipState.READY.raw, vtpOldCode = code, vtpCode = null, vtpKind = "cancelled", vtpStatus = 107,
                vtpStatusName = name, vtpStatusAt = now, exportedAt = null, batchId = null,
            )
        }, shipping = false)
    }

    /** type 3: đã yêu cầu phát lại, type 2: đã đồng ý hoàn về shop. */
    fun applyVtpResolved(code: String, type: Int) {
        val now = Clock.now
        setShip(allOrders().filter { it.ship?.vtpCode == code }.associate { o ->
            o.id to (o.ship ?: ShipInfo()).copy(
                vtpKind = "moving", vtpStatusName = if (type == 3) "Đã yêu cầu phát lại" else "Đã đồng ý hoàn", vtpStatusAt = now,
            )
        })
    }

    /** Mọi đơn, mới nhất trước. */
    fun allOrders(): List<Order> = customers.flatMap { orders(it) }.sortedByDescending { it.lastTs }

    fun orders(customer: Customer): List<Order> =
        customer.items.groupBy { it.groupId ?: "day-${Clock.startOfDay(Clock.day(it.ts)) / 1000}" }
            .map { (key, its) -> Order(key, customer, its.sortedBy { it.ts }) }
            .sortedByDescending { it.lastTs }

    fun orders(filter: DateFilter): List<Order> = allOrders().filter { filter.contains(it.lastTs) }

    fun order(id: String): Order? {
        for (c in customers) {
            if (!id.startsWith(c.id + "|")) continue
            orders(c).firstOrNull { it.id == id }?.let { return it }
        }
        return null
    }

    fun customerCount(filter: DateFilter): Int = customers.count { c -> c.items.any { filter.contains(it.ts) } }

    fun revenue(day: LocalDate): Int =
        customers.sumOf { c -> c.items.filter { Clock.day(it.ts) == day }.sumOf { it.lineTotal } }

    /** Doanh thu từ đầu tháng của `date` tới hết ngày thứ `throughDay` trong tháng. */
    fun revenue(monthOf: LocalDate, throughDay: Int): Int =
        customers.sumOf { c ->
            c.items.filter {
                val d = Clock.day(it.ts)
                d.year == monthOf.year && d.monthValue == monthOf.monthValue && d.dayOfMonth <= throughDay
            }.sumOf { it.lineTotal }
        }

    fun customersToday(): List<Customer> = customers.filter { it.itemsToday.isNotEmpty() }

    // MARK: - Tài khoản TikTok

    val activeAccount: TikTokAccount? get() = accounts.firstOrNull { it.id == activeAccountId }

    fun addAccount(uniqueId: String, displayName: String, activate: Boolean) {
        val handle = uniqueId.trim('@', ' ')
        if (handle.isEmpty()) return
        val id = handle.lowercase()
        val name = displayName.trim()
        val i = accounts.indexOfFirst { it.id == id }
        accounts = if (i >= 0) {
            if (name.isNotEmpty()) accounts.toMutableList().also { it[i] = it[i].copy(displayName = name) } else accounts
        } else {
            accounts + TikTokAccount(id = id, uniqueId = handle, displayName = name.ifEmpty { handle })
        }
        if (activate || activeAccountId == null) activeAccountId = id
        syncState = syncState.copy(deletedAccounts = syncState.deletedAccounts - id)
        touchAccounts()
        save()
    }

    fun selectAccount(id: String) {
        activeAccountId = id
        touchAccounts()
        save()
    }

    fun removeAccount(id: String) {
        accounts = accounts.filter { it.id != id }
        if (activeAccountId == id) activeAccountId = accounts.firstOrNull()?.id
        syncState = syncState.copy(deletedAccounts = syncState.deletedAccounts + id)
        touchAccounts()
        save()
    }

    fun updateKeywords(list: List<String>) {
        keywords = list
        save()
    }

    // MARK: - Theo dõi thay đổi để gửi lên server

    private fun touchCustomer(id: String, deletedItems: Set<String> = emptySet()) {
        syncState = syncState.copy(
            dirtyCustomers = syncState.dirtyCustomers + id,
            deletedItems = syncState.deletedItems + deletedItems,
        )
        if (sending != null) touchedWhileSending.add(id)
        onLocalChange?.invoke()
    }

    private fun touchAccounts() {
        syncState = syncState.copy(accountsDirty = true)
        if (sending != null) accountsTouchedWhileSending = true
        onLocalChange?.invoke()
    }

    val isAwaitingAck: Boolean get() = sending != null
    val inFlightCustomerIds: Set<String> get() = sending?.customers ?: emptySet()

    /** Đánh dấu gói sắp gửi; trả về mã gói. Thay đổi chỉ được xoá khi server xác nhận. */
    private fun beginSending(): Int {
        val id = nextUpdateId++
        sending = Sending(id, syncState.dirtyCustomers, syncState.deletedItems, syncState.deletedAccounts,
            syncState.accountsDirty, !syncState.syncedOnce)
        touchedWhileSending = mutableSetOf()
        accountsTouchedWhileSending = false
        return id
    }

    /** Server đã nhận gói. Nếu vẫn còn thay đổi mới thì trả về true để gửi tiếp. */
    fun acknowledgeSync(id: Int): Boolean {
        val sent = sending
        if (sent == null || sent.id != id) return syncState.hasChanges
        var s = syncState
        s = s.copy(
            dirtyCustomers = s.dirtyCustomers - (sent.customers - touchedWhileSending),
            deletedItems = s.deletedItems - sent.items,
            deletedAccounts = s.deletedAccounts - sent.accounts,
        )
        if (sent.accountsDirty && !accountsTouchedWhileSending) s = s.copy(accountsDirty = false)
        if (sent.initial) s = s.copy(syncedOnce = true)
        syncState = s
        sending = null
        touchedWhileSending = mutableSetOf()
        accountsTouchedWhileSending = false
        scheduleSave()
        return syncState.hasChanges
    }

    /** Mất kết nối trước khi được xác nhận: thay đổi vẫn còn nguyên, gửi lại khi nối lại. */
    fun syncInterrupted() {
        sending = null
        touchedWhileSending = mutableSetOf()
        accountsTouchedWhileSending = false
    }

    /**
     * Server từ chối gói (gửi quá nhanh, dữ liệu quá lớn): thôi chờ xác nhận, thay đổi còn nguyên để gửi lại sau.
     * Trả về false nếu lời từ chối là của một gói cũ, không phải gói đang chờ.
     */
    fun syncRejected(id: Int?): Boolean {
        val sent = sending ?: return false
        if (id != null && sent.id != id) return false
        syncInterrupted()
        return true
    }

    /** Nhận dữ liệu mới nhất từ server. Những khách còn thay đổi chưa gửi xong thì giữ bản trên máy. */
    fun applyServer(snap: ServerSnapshot) {
        var sync = syncState
        val localIds = customers.map { it.id }.toSet()
        val protected = if (sync.syncedOnce) sync.dirtyCustomers else sync.dirtyCustomers + localIds

        val next = mutableListOf<Customer>()
        for (c in snap.customers) {
            if (protected.contains(c.id)) continue
            val hadItems = c.items.isNotEmpty()
            val items = c.items.filter { !sync.deletedItems.contains(it.id) }
            if (hadItems && items.isEmpty()) continue
            next.add(if (items.size == c.items.size) c else c.copy(items = items))
        }
        next.addAll(customers.filter { protected.contains(it.id) })
        if (next != customers) customers = next

        // Phiên: server là bản chuẩn. Phiên chỉ có trên máy thì giữ lại; nếu còn mở thì đã cũ, đóng lại.
        val serverIds = snap.sessions.map { it.id }.toSet()
        val nextSessions = snap.sessions.toMutableList()
        for (s in sessions) {
            if (serverIds.contains(s.id)) continue
            nextSessions.add(if (s.isLive) s.copy(end = s.lastActivity ?: s.start) else s)
        }
        nextSessions.sortByDescending { it.start }
        if (nextSessions != sessions) sessions = nextSessions

        if (sync.syncedOnce && !sync.accountsDirty) {
            if (snap.accounts != accounts) accounts = snap.accounts
            val active = snap.activeAccountId ?: accounts.firstOrNull()?.id
            if (active != activeAccountId) activeAccountId = active
        } else {
            val mine = accounts.map { it.id }.toSet()
            val added = snap.accounts.filter { !mine.contains(it.id) && !sync.deletedAccounts.contains(it.id) }
            if (added.isNotEmpty()) accounts = accounts + added
            if (activeAccountId == null) {
                val wanted = snap.activeAccountId?.takeIf { id -> accounts.any { it.id == id } }
                activeAccountId = wanted ?: accounts.firstOrNull()?.id
            }
        }

        val printed = snap.printedCommentIds
        if (!printed.isNullOrEmpty()) {
            val ids = printed.toSet()
            if (comments.any { !it.printed && ids.contains(it.id) }) {
                comments = comments.map { if (!it.printed && ids.contains(it.id)) it.copy(printed = true) else it }
            }
        }
        // Khách đã xoá hết món trên máy thì không còn gì để bảo vệ nữa.
        sync = sync.copy(dirtyCustomers = sync.dirtyCustomers.filter { id ->
            customers.any { it.id == id } || inFlightCustomerIds.contains(id)
        }.toSet())
        syncState = sync
        scheduleSave()
    }

    /** Gói các thay đổi chưa gửi. Mỗi lúc chỉ gửi một gói; null nếu không có gì hoặc đang chờ xác nhận. */
    fun makeSyncUpdate(): SyncUpdate? {
        if (isAwaitingAck || !syncState.hasChanges) return null
        val initial = !syncState.syncedOnce
        if (initial) {
            syncState = syncState.copy(
                dirtyCustomers = syncState.dirtyCustomers + customers.map { it.id },
                accountsDirty = syncState.accountsDirty || accounts.isNotEmpty(),
            )
        }
        val ids = syncState.dirtyCustomers
        val accountsDirty = syncState.accountsDirty
        val deletedItems = syncState.deletedItems.toList()
        val deletedAccounts = syncState.deletedAccounts
        return SyncUpdate(
            id = beginSending(),
            customers = customers.filter { ids.contains(it.id) },
            deletedItemIds = deletedItems,
            accounts = if (accountsDirty) accounts else null,
            deletedAccountIds = if (deletedAccounts.isEmpty()) null else deletedAccounts.toList(),
            activeAccountId = if (accountsDirty) activeAccountId else null,
            sessions = if (initial) sessions else null,
            comments = if (initial) comments else null,
        )
    }

    /** Lần đầu trên máy mới thì chưa có mốc: lấy phần mới nhất. */
    val latestCommentDate: Long? get() = comments.maxOfOrNull { it.ts }

    /** Bình luận của một phiên, mới nhất trước: phần lưu trên máy cộng với phần cũ vừa tải từ server. */
    fun sessionComments(id: String, older: List<LiveComment>): List<LiveComment> {
        val local = comments(id)
        val localIds = local.map { it.id }.toSet()
        var extra = older.filter { !localIds.contains(it.id) }
        if (extra.isNotEmpty()) {
            // Đã lưu thành đơn ở đâu đó thì hiện đúng như bình luận đã chốt.
            val ordered = customers.flatMap { it.items }.map { it.commentId ?: it.id }.toSet()
            extra = extra.map { if (ordered.contains(it.id)) it.copy(printed = true) else it }
        }
        return (local + extra).sortedByDescending { it.ts }
    }

    // MARK: - Lưu trữ

    private fun load() {
        val f = fileUrl ?: return
        if (!f.exists()) return
        val text = try {
            f.readText()
        } catch (e: Exception) {
            saveBlocked = true
            storageWarning = "Không đọc được dữ liệu đã lưu. App tạm ngừng lưu để giữ nguyên dữ liệu cũ, bạn hãy mở lại app."
            return
        }
        val snap = try {
            AppJson.decodeFromString(LocalSnapshot.serializer(), text)
        } catch (e: Exception) {
            quarantine(f)
            return
        }
        comments = snap.comments
        customers = snap.customers
        sessions = snap.sessions
        accounts = snap.accounts
        activeAccountId = snap.activeAccountId
        snap.keywords?.let { keywords = it }
        syncState = snap.sync ?: SyncState()
        knownCommentIds = snap.comments.mapTo(HashSet()) { it.id }
    }

    private fun quarantine(f: File) {
        val name = "chotlive.loi-${System.currentTimeMillis() / 1000}-${UUID.randomUUID().toString().take(8)}.json"
        if (f.renameTo(File(f.parentFile, name))) {
            storageWarning = "Dữ liệu đã lưu bị lỗi nên app bắt đầu với dữ liệu trống. Bản cũ vẫn được giữ trên máy, chưa bị xoá."
        } else {
            saveBlocked = true
            storageWarning = "Dữ liệu đã lưu bị lỗi. App tạm ngừng lưu để giữ nguyên dữ liệu cũ."
        }
    }

    /** Bình luận về dồn dập nên gom ghi file; thao tác của người dùng thì ghi ngay. */
    private fun scheduleSave() {
        main.removeCallbacks(saveRunnable)
        main.postDelayed(saveRunnable, 1000)
    }

    fun saveSoon() = scheduleSave()

    fun save() {
        main.removeCallbacks(saveRunnable)
        if (saveBlocked) return
        val f = fileUrl ?: return
        val snap = LocalSnapshot(comments, customers, sessions, accounts, activeAccountId, keywords, syncState)
        writer.execute {
            try {
                val data = AppJson.encodeToString(LocalSnapshot.serializer(), snap)
                f.parentFile?.mkdirs()
                val tmp = File(f.parentFile, f.name + ".tmp")
                tmp.writeText(data)
                if (!tmp.renameTo(f)) {
                    f.delete()
                    if (!tmp.renameTo(f)) throw java.io.IOException("rename")
                }
                saveFailed = false
            } catch (e: Exception) {
                // Báo một lần cho mỗi đợt lỗi, bình luận về liên tục cũng không hiện lại.
                if (!saveFailed) main.post { storageWarning = "Không lưu được dữ liệu. Bạn hãy kiểm tra dung lượng trống của máy." }
                saveFailed = true
            }
        }
    }

    /** Chờ ghi file xong (dùng trong test). */
    internal fun awaitWrites() {
        writer.submit {}.get()
    }

    companion object {
        val DEFAULT_KEYWORDS = listOf("chốt", "lấy")
        /** Trên máy giữ chừng này bình luận mới nhất; toàn bộ lịch sử nằm trên server. */
        const val COMMENT_LIMIT = 5000
        private const val FILE_NAME = "chotlive.json"

        fun key(uniqueId: String, userId: String): String {
            val u = uniqueId.lowercase()
            return u.ifEmpty { userId }
        }
    }
}
