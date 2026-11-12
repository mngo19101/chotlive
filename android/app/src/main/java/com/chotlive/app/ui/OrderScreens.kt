package com.chotlive.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.chotlive.app.data.Store
import com.chotlive.app.model.Clock
import com.chotlive.app.model.DateFilter
import com.chotlive.app.model.Order
import com.chotlive.app.model.OrderItem
import com.chotlive.app.model.OrderStatus
import com.chotlive.app.model.ShipState
import com.chotlive.app.model.Vtp
import com.chotlive.app.model.VtpTrack
import com.chotlive.app.model.dayMonth
import com.chotlive.app.model.fullDate
import com.chotlive.app.model.money
import com.chotlive.app.model.pillLabel
import com.chotlive.app.model.scopeLabel
import com.chotlive.app.model.shortDate
import com.chotlive.app.model.timeText
import com.chotlive.app.model.weekdayLabel
import com.chotlive.app.net.vtpConnected
import kotlinx.coroutines.launch
import java.util.UUID

fun confirmDelete(o: Order, store: Store, ui: AppUI, then: () -> Unit = {}) {
    // Vận đơn còn hiệu lực mà xoá đơn thì bưu tá vẫn tới lấy hàng, app lại không còn gì để theo dõi.
    val code = VtpTrack.code(o)
    if (code != null && o.status != OrderStatus.DELIVERED) {
        ui.notify("Đơn đang có vận đơn ${VtpTrack.pretty(code)}. Huỷ vận đơn ở chi tiết đơn trước rồi mới xoá đơn.")
        return
    }
    ui.confirm = ConfirmItem("Xoá đơn của ${o.customer.displayName}?", "Không thể khôi phục sau khi xoá.", "Xoá đơn") {
        store.deleteOrder(o)
        then()
    }
}

// MARK: - Đơn hàng

private fun matchesTab(o: Order, tab: Int): Boolean = when (tab) {
    1 -> Vtp.state(o) == ShipState.ASK
    2 -> Vtp.state(o) == ShipState.READY
    3 -> Vtp.state(o) == ShipState.HOLD
    4 -> o.status == OrderStatus.SHIPPING
    else -> true
}

@Composable
fun OrdersScreen() {
    val app = LocalApp.current
    val store = app.store
    val client = app.client
    val ui = LocalAppUI.current
    val scope = rememberCoroutineScope()
    var search by remember { mutableStateOf("") }
    // 0 tất cả (mọi ngày), 1 đơn mới, 2 chờ gửi, 3 gom sau, 4 đang giao (theo ngày đang chọn)
    var filter by remember { mutableIntStateOf(0) }
    var dateFilter by remember { mutableStateOf(DateFilter.make(DateFilter.Preset.TODAY)) }

    val every = remember(store.customers) { store.allOrders() }
    val scoped = remember(every, dateFilter) { every.filter { dateFilter.contains(it.lastTs) } }
    val groups = remember(every) { Vtp.readyGroups(every) }
    val counts = remember(scoped) { (1..4).map { tab -> VtpTrack.oneCardPerWaybill(scoped.filter { matchesTab(it, tab) }).size } }
    // Tab Tất cả: đơn mọi ngày, tìm cả đơn ngày cũ. Các tab khác: theo ngày đang chọn.
    val shown = remember(every, scoped, filter, search) {
        var l = (if (filter == 0) every else scoped).filter { matchesTab(it, filter) }
        val q = search.trim().lowercase()
        if (q.isNotEmpty()) {
            val compact = q.replace(" ", "")
            l = l.filter {
                it.customer.matchesName(q) || (it.code ?: "").lowercase().contains(q) ||
                    (it.customer.address?.phone ?: "").contains(q) || (it.ship?.vtpCode ?: "").lowercase().contains(compact)
            }
        }
        // Đơn Viettel Post báo giao hỏng / hoàn lên đầu.
        if (filter == 4) l = l.sortedWith(compareByDescending<Order> { VtpTrack.needsAction(it) }.thenByDescending { it.lastTs })
        // Nhiều đơn của khách gộp chung một vận đơn: một thẻ, tiền là tiền thu hộ của vận đơn.
        VtpTrack.oneCardPerWaybill(l)
    }

    LazyColumn(
        Modifier.fillMaxSize().background(C.bg),
        contentPadding = PaddingValues(start = Metrics.GUTTER.dp, end = Metrics.GUTTER.dp, top = 2.dp, bottom = 16.dp),
        verticalArrangement = Arrangement.spacedBy(11.dp),
    ) {
        item {
            Column(verticalArrangement = Arrangement.spacedBy(Metrics.GAP.dp), modifier = Modifier.padding(bottom = 3.dp)) {
                PageHeader(if (filter == 0) "${every.size} đơn · mọi ngày" else "${scoped.size} đơn · ${dateFilter.pillLabel}", "Đơn hàng") {
                    HeaderAddButton("Tạo đơn") { ui.push(Route.OrderCreate) }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    SearchField(search, { search = it }, Modifier.weight(1f),
                        if (client.vtpConnected) "Tìm tên, @tiktok, mã vận đơn" else "Tìm tên hoặc @tiktok")
                    CircleButton(IconName.FILTER) { ui.present(0.9f) { DateFilterSheet(dateFilter) { dateFilter = it } } }
                }
                // Cả 5 tab nằm gọn một hàng, không phải kéo ngang.
                Row(Modifier.fillMaxWidth().cardStyle(18f).padding(4.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    StatusTab("Tất cả", VtpTrack.oneCardPerWaybill(every).size, filter == 0, Modifier.weight(1f)) { filter = 0 }
                    listOf("Đơn mới", "Chờ gửi", "Gom sau", "Đang giao").forEachIndexed { i, t ->
                        StatusTab(t, counts[i], filter == i + 1, Modifier.weight(1f)) { filter = i + 1 }
                    }
                }
                if (groups.isNotEmpty()) {
                    ReadyExportBanner(groups, client.vtpConnected) { ui.present(0.42f) { VtpExportSheet() } }
                }
                if (filter == 4) {
                    val attention = shown.filter { VtpTrack.needsAction(it) }
                    if (attention.isNotEmpty()) VtpAttentionBanner(attention)
                }
                if (shown.isEmpty()) EmptyNote("Chưa có đơn nào. Bấm nút in trên một bình luận hoặc “Tạo đơn” để thêm đơn.")
            }
        }
        items(shown, key = { it.id }) { o ->
            OrderCard(o, every, onPrint = { scope.launch { ui.notify(app.printOrder(o)) } })
        }
    }
}

/** Một ô trong hàng tab trạng thái đơn: số đơn to ở trên, tên tab nhỏ ở dưới, chia đều chiều ngang. */
@Composable
private fun StatusTab(title: String, count: Int, selected: Boolean, modifier: Modifier, onClick: () -> Unit) {
    OnAccent(selected) {
        Column(
            modifier.height(48.dp).clip(rounded(14f)).background(if (selected) C.orange else androidx.compose.ui.graphics.Color.Transparent)
                .plainTap(onClick = onClick).padding(horizontal = 2.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(1.dp, Alignment.CenterVertically),
        ) {
            T("$count", 16f, BV.HEAVY, if (selected || count > 0) C.ink else C.muted, maxLines = 1, lineHeight = 19f)
            T(title, 11.5f, if (selected) BV.BOLD else BV.SEMIBOLD, if (selected) C.ink else C.muted, shrink = true, minScale = 0.75f, lineHeight = 14f)
        }
    }
}

@Composable
private fun OrderCard(o: Order, every: List<Order>, onPrint: () -> Unit) {
    val app = LocalApp.current
    val ui = LocalAppUI.current
    val st = Vtp.state(o)
    val older = remember(every, o.id) { if (st.isPending) Vtp.olderPending(o, every) else emptyList() }
    val hasOldGom = st == ShipState.ASK && older.isNotEmpty()
    val day = if (Clock.isToday(o.lastTs)) "" else " · ${dayMonth(o.lastTs)}"
    val code = VtpTrack.code(o)
    // Đã có vận đơn: tiền trên thẻ là tiền Viettel Post thu hộ (gồm COD nhập tay, cọc, các đơn gộp chung).
    val mates = remember(every, o.id) { VtpTrack.sameWaybill(o, every) }
    val amount = if (code != null) VtpTrack.waybillCod(mates) else o.total
    val products = mates.sumOf { it.productCount }
    val merged = if (mates.size > 1) " · gộp ${mates.size} đơn" else ""
    val openReview = { ui.present(0.42f) { ShipReviewSheet(o.id) } }
    Column(
        Modifier.fillMaxWidth().cardStyle(20f, if (hasOldGom) C.gomFill else C.card, if (hasOldGom) C.gomLine else C.line)
            .padding(start = 15.dp, end = 15.dp, top = 15.dp, bottom = 14.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Row(Modifier.fillMaxWidth().plainTap { ui.push(Route.Order(o.id)) }, verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Avatar(o.customer.initials, o.customer.id, 40f, 14f)
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    T(o.customer.displayName, 15f, BV.BOLD, modifier = Modifier.weight(1f), maxLines = 1)
                    T(money(amount), 17f, BV.HEAVY, C.ink, track = -0.4f, maxLines = 1)
                }
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    T("@${o.customer.uniqueId} · $products sản phẩm$merged · ${timeText(o.lastTs)}$day", 12f, BV.MEDIUM, C.muted,
                        Modifier.weight(1f), shrink = true, minScale = 0.8f)
                    if (st == ShipState.ASK) Badge("Đơn mới")
                    if (code != null) T("thu hộ", 11.5f, BV.SEMIBOLD, C.muted, maxLines = 1)
                }
            }
        }

        if (older.isNotEmpty() && !Vtp.alreadyMerged(o, older)) {
            // Bấm để thêm đơn này vào đơn đã gom trước đó: bảng Duyệt đơn tick sẵn mọi đơn chưa gửi của khách.
            Box(Modifier.plainTap(onClick = openReview)) {
                ShipTag(if (hasOldGom) "Có ${older.size} đơn gom từ ${dayMonth(older[0].lastTs)} · bấm để gộp"
                else "Còn ${older.size} đơn cũ từ ${dayMonth(older[0].lastTs)} · bấm để gộp", C.gomInk, C.gomTag)
            }
        } else if (older.isNotEmpty()) {
            ShipTag("Gửi chung với ${older.size} đơn từ ${dayMonth(older[0].lastTs)}", C.accent, C.peachSoft)
        } else if (st == ShipState.HOLD) {
            ShipTag("Khách hẹn gom sau", C.gomInk, C.gomTag)
        } else if (st == ShipState.READY) {
            ShipTag("Sẵn sàng gửi", C.accent, C.peachSoft)
        }
        val lastError = VtpTrack.lastError(o)
        val cancelled = VtpTrack.cancelledCode(o)
        if (code != null) {
            // Mã vận đơn + trạng thái Viettel Post trên thẻ đơn; đỏ khi cần xử lý.
            val bad = VtpTrack.needsAction(o)
            val done = o.status == OrderStatus.DELIVERED
            Row(Modifier.height(24.dp).capsule(if (bad) C.redSoft else if (done) C.greenSoft else C.peachSoft).padding(horizontal = 10.dp),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                T(VtpTrack.pretty(code), 12f, BV.HEAVY, C.ink, maxLines = 1)
                T("·", 12f, BV.BOLD, C.muted)
                Box(Modifier.weight(1f, fill = false)) {
                    T(VtpTrack.statusName(o), 12f, BV.SEMIBOLD, if (bad) C.red else if (done) C.green else C.accent, shrink = true, minScale = 0.8f)
                }
            }
        } else if (lastError != null) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Box(Modifier.weight(1f, fill = false)) { ShipTag("Lỗi tạo vận đơn: $lastError", C.red, C.redSoft) }
                T("Sửa", 12.5f, BV.BOLD, C.accent, Modifier.plainTap { ui.push(Route.AddressEdit(o.customer.id)) })
            }
        } else if (cancelled != null) {
            ShipTag("Vận đơn ${VtpTrack.pretty(cancelled)} đã huỷ · gửi lại", C.red, C.redSoft)
        }

        Row(Modifier.padding(top = 3.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            if (code != null) {
                OutlineButton("In tem", Modifier.weight(1f), IconName.PRINTER, filled = true) { VtpActions.printLabels(listOf(code), app, ui) }
                OutlineButton("Theo dõi", Modifier.weight(1f), IconName.TRUCK) { ui.push(Route.Order(o.id)) }
            } else {
                OutlineButton(if (o.isPrinted) "In lại" else "In đơn", Modifier.weight(1f), IconName.PRINTER, filled = !o.isPrinted, onClick = onPrint)
                OutlineButton(shipButtonLabel(o), Modifier.weight(1f), if (st == ShipState.ASK) IconName.CHECK else IconName.TRUCK,
                    shipButtonColor(o), onClick = openReview)
            }
            Box(Modifier.size(44.dp).clip(CircleShape).background(C.card).border(1.dp, C.line, CircleShape)
                .tap { ui.present { OrderActionSheet(o.id) } }, contentAlignment = Alignment.Center) {
                Icon(IconName.MORE, 20f, 2.6f)
            }
        }
    }
}

// MARK: - Sheet thao tác đơn

@Composable
fun OrderActionSheet(orderId: String) {
    val app = LocalApp.current
    val store = app.store
    val ui = LocalAppUI.current
    Column(Modifier.fillMaxWidth().padding(horizontal = Metrics.GUTTER.dp)) {
        val o = store.order(orderId)
        if (o != null) {
            Row(Modifier.padding(start = 4.dp, end = 4.dp, top = 8.dp, bottom = 12.dp), verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Avatar(o.customer.initials, o.customer.id, 40f, 14f)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    T(o.customer.displayName, 16f, BV.BOLD, maxLines = 1)
                    T("${o.productCount} sản phẩm · ${timeText(o.lastTs)}", 12f, BV.MEDIUM, C.muted)
                }
                T(money(o.total), 17f, BV.HEAVY, C.ink, track = -0.4f, maxLines = 1)
            }
            HairLine(Modifier.padding(bottom = 12.dp))
            ActionRow(IconName.CART, C.accent, C.peachSoft, "Sản phẩm (${o.productCount})", C.ink, "Xem và sửa sản phẩm trong đơn") {
                ui.dismissSheet()
                ui.push(Route.Order(o.id))
            }
            HairLine()
            ActionRow(IconName.MESSAGE, C.accent, C.peachSoft, "Bình luận", C.ink, "Xem các comment khách đã chốt đơn") {
                ui.dismissSheet()
                ui.push(Route.OrderComments(o.id))
            }
            HairLine()
            ActionRow(IconName.TRASH, C.red, C.redSoft, "Xoá đơn", C.red, "Không thể khôi phục sau khi xoá") {
                ui.dismissSheet()
                confirmDelete(o, store, ui)
            }
        }
        Box(Modifier.padding(top = 14.dp).fillMaxWidth().height(52.dp).capsule(C.field).tap { ui.dismissSheet() },
            contentAlignment = Alignment.Center) { T("Đóng", 15f, BV.BOLD) }
    }
}

@Composable
private fun ActionRow(
    icon: IconName, tint: androidx.compose.ui.graphics.Color, fill: androidx.compose.ui.graphics.Color,
    title: String, titleColor: androidx.compose.ui.graphics.Color, subtitle: String, onClick: () -> Unit,
) {
    Row(Modifier.fillMaxWidth().height(63.dp).tap(onClick = onClick).padding(horizontal = 4.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Box(Modifier.size(40.dp).clip(CircleShape).background(fill), contentAlignment = Alignment.Center) { Icon(icon, 17f, 2.3f, tint) }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            T(title, 15f, BV.BOLD, titleColor)
            T(subtitle, 12f, BV.MEDIUM, C.muted, maxLines = 1)
        }
        Icon(IconName.CHEVRON_RIGHT, 16f, color = C.muted)
    }
}

// MARK: - Chi tiết đơn hàng

@Composable
fun OrderDetailScreen(orderId: String) {
    val app = LocalApp.current
    val store = app.store
    val ui = LocalAppUI.current
    val scope = rememberCoroutineScope()
    val o = store.order(orderId)
    SubPage("Chi tiết đơn hàng", trailing = { if (o != null) ShipBadge(o) }) {
        if (o == null) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { T("Đơn không còn tồn tại", 14f, BV.MEDIUM, C.muted) }
        } else {
            Column(
                Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(start = Metrics.GUTTER.dp, end = Metrics.GUTTER.dp, bottom = 12.dp),
                verticalArrangement = Arrangement.spacedBy(Metrics.GAP.dp),
            ) {
                Column(Modifier.fillMaxWidth().cardStyle(20f).padding(horizontal = 15.dp, vertical = 14.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Row(Modifier.fillMaxWidth().plainTap { ui.push(Route.Customer(o.customer.id)) }, verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        Avatar(o.customer.initials, o.customer.id, 52f, 18f)
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                                Box(Modifier.weight(1f, fill = false)) { T(o.customer.displayName, 17f, BV.BOLD, shrink = true, minScale = 0.85f) }
                                if (o.customer.isBigSpender) Badge("Mua nhiều")
                            }
                            T("@${o.customer.uniqueId} · ${store.orders(o.customer).size} đơn", 13f, BV.MEDIUM, C.muted, maxLines = 1)
                        }
                        Icon(IconName.CHEVRON_RIGHT, 16f, color = C.muted)
                    }
                    HairLine()
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Icon(IconName.CALENDAR, 15f, color = C.muted)
                        T("Tạo lúc ${timeText(o.firstTs)} · ${weekdayLabel(o.firstTs)} ${fullDate(o.firstTs)}", 13f, BV.MEDIUM, C.muted, shrink = true)
                    }
                }
                Column(Modifier.fillMaxWidth().cardStyle(20f).padding(start = 15.dp, end = 15.dp, top = 14.dp, bottom = 15.dp)) {
                    T("Sản phẩm (${o.productCount})", 14f, BV.BOLD, modifier = Modifier.padding(bottom = 3.dp))
                    o.items.forEachIndexed { index, it ->
                        if (index > 0) HairLine()
                        Row(Modifier.fillMaxWidth().height(42.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(11.dp)) {
                            Box(Modifier.size(22.dp).clip(CircleShape).background(C.field), contentAlignment = Alignment.Center) {
                                T("${index + 1}", 11f, BV.BOLD, C.muted)
                            }
                            T(it.productLabel, 14f, BV.BOLD, modifier = Modifier.widthIn(max = 140.dp), maxLines = 1)
                            T("${it.qty} × ${money(it.price)}", 12f, BV.MEDIUM, C.muted, Modifier.weight(1f), shrink = true)
                            T(money(it.lineTotal), 14f, BV.BOLD, maxLines = 1)
                        }
                    }
                    Row(Modifier.padding(top = 7.dp).fillMaxWidth().height(44.dp).clip(rounded(14f)).background(C.peachSoft).padding(horizontal = 14.dp),
                        verticalAlignment = Alignment.CenterVertically) {
                        T("Tổng tiền", 14f, BV.SEMIBOLD, modifier = Modifier.weight(1f))
                        T(money(o.total), 18f, BV.HEAVY, C.ink, track = -0.4f, maxLines = 1)
                    }
                }
                VtpOrderBox(o)
                val others = remember(store.customers, o.id) {
                    if (Vtp.state(o).isPending) Vtp.pendingOrders(o.customer.id, store.allOrders()).filter { it.id != o.id } else emptyList()
                }
                if (others.isNotEmpty()) GomCard(o, others)
            }
            Column(Modifier.padding(start = Metrics.GUTTER.dp, end = Metrics.GUTTER.dp, top = 4.dp, bottom = 10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                PrimaryButton("Chỉnh sửa đơn", icon = IconName.PENCIL, fontSize = 15f) { ui.push(Route.OrderEdit(o.id)) }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlineButton(shipButtonLabel(o), Modifier.weight(1f), if (Vtp.state(o) == ShipState.ASK) IconName.CHECK else IconName.TRUCK,
                        shipButtonColor(o), 48f) {
                        ui.present(0.42f) { ShipReviewSheet(o.id) }
                    }
                    OutlineButton(if (o.isPrinted) "In lại" else "In đơn", Modifier.weight(1f), IconName.PRINTER, height = 48f) {
                        scope.launch { ui.notify(app.printOrder(o)) }
                    }
                    OutlineButton("Xoá đơn", Modifier.weight(1f), IconName.TRASH, C.red, 48f) {
                        confirmDelete(o, store, ui) { ui.pop() }
                    }
                }
            }
        }
    }
}

/** Các đơn chưa gửi khác của khách (đơn gom ngày trước…): xem nhanh và gộp đơn này vào chung một vận đơn. */
@Composable
private fun GomCard(o: Order, others: List<Order>) {
    val ui = LocalAppUI.current
    val merged = Vtp.alreadyMerged(o, others)
    Column(Modifier.fillMaxWidth().cardStyle(20f, C.gomFill, C.gomLine).padding(start = 15.dp, end = 15.dp, top = 14.dp, bottom = 15.dp)) {
        T("Đơn đã gom chưa gửi (${others.size})", 14f, BV.BOLD, C.gomInk, Modifier.padding(bottom = 3.dp))
        others.forEachIndexed { index, x ->
            if (index > 0) HairLine()
            Row(Modifier.fillMaxWidth().height(50.dp).plainTap { ui.push(Route.Order(x.id)) }, verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    T("Đơn ${dayMonth(x.lastTs)} · ${timeText(x.lastTs)}", 14f, BV.BOLD, maxLines = 1)
                    T("${x.productCount} sản phẩm · ${shipButtonLabel(x)}", 12f, BV.MEDIUM, C.muted, maxLines = 1)
                }
                T(money(x.total), 14f, BV.BOLD, maxLines = 1)
                Icon(IconName.CHEVRON_RIGHT, 14f, color = C.muted)
            }
        }
        Row(Modifier.padding(top = 7.dp).fillMaxWidth().height(44.dp).clip(rounded(14f)).background(C.gomTag).padding(horizontal = 14.dp),
            verticalAlignment = Alignment.CenterVertically) {
            T(if (merged) "Gửi chung, tổng" else "Tổng nếu gộp", 14f, BV.SEMIBOLD, modifier = Modifier.weight(1f))
            T(money(o.total + others.sumOf { it.total }), 18f, BV.HEAVY, C.ink, track = -0.4f, maxLines = 1)
        }
        if (!merged) {
            OutlineButton("Gộp vào đơn đã gom", Modifier.padding(top = 10.dp).fillMaxWidth(), IconName.TRUCK, C.gomInk) {
                ui.present(0.42f) { ShipReviewSheet(o.id) }
            }
        }
    }
}

// MARK: - Sửa / tạo đơn

/** Một dòng sản phẩm trong màn sửa đơn. */
@Composable
fun ItemEditor(item: OrderItem, onChange: (OrderItem) -> Unit, onDelete: () -> Unit) {
    var priceText by remember(item.id) { mutableStateOf(if (item.price > 0) item.price.toString() else "") }
    var codeText by remember(item.id) { mutableStateOf(item.codeText) }
    Column(Modifier.fillMaxWidth().cardStyle(18f).padding(14.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                T("Mã sản phẩm", 12f, BV.MEDIUM, C.muted)
                Box(Modifier.fillMaxWidth().height(44.dp).cardStyle(14f, C.field).padding(horizontal = 13.dp), contentAlignment = Alignment.CenterStart) {
                    PlainField(codeText, {
                        codeText = it
                        onChange(item.copy(code = it))
                    }, "150", 15f, BV.SEMIBOLD, Modifier.fillMaxWidth(), capitalize = false)
                }
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                T("Đơn giá (₫)", 12f, BV.MEDIUM, C.muted)
                Box(Modifier.fillMaxWidth().height(44.dp).cardStyle(14f, C.field).padding(horizontal = 13.dp), contentAlignment = Alignment.CenterStart) {
                    PlainField(priceText, { v ->
                        priceText = v
                        onChange(item.copy(price = v.filter { it.isDigit() }.take(9).toIntOrNull() ?: 0))
                    }, "150000", 15f, BV.SEMIBOLD, Modifier.fillMaxWidth(), KeyboardType.Number, capitalize = false)
                }
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            T("Số lượng", 13f, BV.MEDIUM, C.muted)
            Box(Modifier.size(34.dp).clip(CircleShape).background(C.field).tap { onChange(item.copy(qty = maxOf(item.qty - 1, 1))) },
                contentAlignment = Alignment.Center) { Icon(IconName.MINUS, 16f) }
            Box(Modifier.width(20.dp), contentAlignment = Alignment.Center) { T("${item.qty}", 15f, BV.BOLD) }
            Box(Modifier.size(34.dp).clip(CircleShape).background(C.field).tap { onChange(item.copy(qty = item.qty + 1)) },
                contentAlignment = Alignment.Center) { Icon(IconName.PLUS, 16f) }
            Box(Modifier.weight(1f))
            Box(Modifier.size(34.dp).clip(CircleShape).background(C.redSoft).tap(onClick = onDelete), contentAlignment = Alignment.Center) {
                Icon(IconName.TRASH, 17f, color = C.red)
            }
        }
    }
}

@Composable
fun OrderEditScreen(orderId: String) {
    val app = LocalApp.current
    val store = app.store
    val ui = LocalAppUI.current
    val order = store.order(orderId)
    val items = remember { mutableStateListOf<OrderItem>().also { it.addAll(order?.items ?: emptyList()) } }
    SubPage("Chỉnh sửa đơn") {
        Column(
            Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(start = Metrics.GUTTER.dp, end = Metrics.GUTTER.dp, bottom = 12.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            for ((i, it) in items.withIndex()) {
                androidx.compose.runtime.key(it.id) {
                    ItemEditor(it, { v -> items[i] = v }) { items.removeAt(i) }
                }
            }
            OutlineButton("Thêm sản phẩm", Modifier.fillMaxWidth(), IconName.PLUS, height = 48f) {
                val template = order?.items?.lastOrNull()
                items.add(OrderItem(id = UUID.randomUUID().toString().uppercase(), comment = "", price = 0, ts = template?.ts ?: Clock.now,
                    sessionId = template?.sessionId, groupId = template?.groupId))
            }
        }
        Box(Modifier.padding(horizontal = Metrics.GUTTER.dp, vertical = 12.dp)) {
            PrimaryButton(if (items.isEmpty()) "Lưu (đơn sẽ bị xoá)" else "Lưu đơn · ${money(items.sumOf { it.lineTotal })}") {
                if (order != null) {
                    // Đơn đã có vận đơn thì tiền thu hộ đã gửi Viettel Post: đổi món ở đây không đổi được số đó.
                    val code = VtpTrack.code(order)
                    if (code != null && order.status != OrderStatus.DELIVERED && items.sumOf { it.lineTotal } != order.total) {
                        ui.notify("Đơn đã có vận đơn ${VtpTrack.pretty(code)}, tiền thu hộ đã gửi Viettel Post. Huỷ vận đơn ở chi tiết đơn rồi mới sửa món.")
                        return@PrimaryButton
                    }
                    store.updateOrder(order, items.toList())
                    ui.notify(store.takeCodResetNotice())
                }
                ui.pop()
            }
        }
    }
}

@Composable
fun OrderCreateScreen() {
    val app = LocalApp.current
    val store = app.store
    val ui = LocalAppUI.current
    var nickname by remember { mutableStateOf("") }
    var handle by remember { mutableStateOf("") }
    val items = remember { mutableStateListOf(OrderItem(id = UUID.randomUUID().toString().uppercase(), ts = Clock.now)) }
    val canSave = items.isNotEmpty() && !(nickname.isBlank() && handle.isBlank())
    SubPage("Tạo đơn") {
        Column(
            Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(start = Metrics.GUTTER.dp, end = Metrics.GUTTER.dp, bottom = 12.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Column(Modifier.fillMaxWidth().cardStyle(18f).padding(14.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                LabeledField("Tên khách", "Linh Nguyễn", nickname, { nickname = it })
                LabeledField("Tài khoản TikTok", "@linh.nguyen98", handle, { handle = it }, capitalize = false)
            }
            for ((i, it) in items.withIndex()) {
                androidx.compose.runtime.key(it.id) {
                    ItemEditor(it, { v -> items[i] = v }) { items.removeAt(i) }
                }
            }
            OutlineButton("Thêm sản phẩm", Modifier.fillMaxWidth(), IconName.PLUS, height = 48f) {
                items.add(OrderItem(id = UUID.randomUUID().toString().uppercase(), ts = Clock.now))
            }
        }
        Box(Modifier.padding(horizontal = Metrics.GUTTER.dp, vertical = 12.dp)) {
            PrimaryButton("Tạo đơn · ${money(items.sumOf { it.lineTotal })}", enabled = canSave) {
                val id = store.createOrder(nickname, handle, items.toList())
                ui.pop()
                ui.push(Route.Order(id))
            }
        }
    }
}
