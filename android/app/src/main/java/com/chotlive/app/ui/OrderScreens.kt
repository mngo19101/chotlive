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
import com.chotlive.app.model.fullDate
import com.chotlive.app.model.money
import com.chotlive.app.model.pillLabel
import com.chotlive.app.model.scopeLabel
import com.chotlive.app.model.shortDate
import com.chotlive.app.model.timeText
import com.chotlive.app.model.weekdayLabel
import kotlinx.coroutines.launch
import java.util.UUID

fun deliveryLabel(o: Order): String = when (o.status) {
    OrderStatus.NEW, OrderStatus.PRINTED -> "Giao hàng"
    OrderStatus.SHIPPING -> "Đang giao"
    OrderStatus.DELIVERED -> "Đã giao"
}

fun confirmDelete(o: Order, store: Store, ui: AppUI, then: () -> Unit = {}) {
    ui.confirm = ConfirmItem("Xoá đơn của ${o.customer.nickname}?", "Không thể khôi phục sau khi xoá.", "Xoá đơn") {
        store.deleteOrder(o)
        then()
    }
}

// MARK: - Đơn hàng

@Composable
fun OrdersScreen() {
    val app = LocalApp.current
    val store = app.store
    val ui = LocalAppUI.current
    val scope = rememberCoroutineScope()
    var search by remember { mutableStateOf("") }
    var filter by remember { mutableIntStateOf(0) } // 0 tất cả, 1 mới, 2 đã in, 3 đang giao, 4 đã giao
    var dateFilter by remember { mutableStateOf(DateFilter.make(DateFilter.Preset.TODAY)) }

    fun matches(o: Order, tab: Int) = when (tab) {
        1 -> o.status == OrderStatus.NEW
        2 -> o.status == OrderStatus.PRINTED
        3 -> o.status == OrderStatus.SHIPPING
        4 -> o.status == OrderStatus.DELIVERED
        else -> true
    }

    val all = remember(store.customers, dateFilter) { store.orders(dateFilter) }
    val list = remember(all, filter, search) {
        var l = all.filter { matches(it, filter) }
        val q = search.trim().lowercase()
        if (q.isNotEmpty()) l = l.filter { it.customer.nickname.lowercase().contains(q) || it.customer.uniqueId.lowercase().contains(q) }
        l
    }
    val date = if (dateFilter.isSingleDay) "${weekdayLabel(dateFilter.startDay)} ${shortDate(dateFilter.startDay)}" else dateFilter.pillLabel

    LazyColumn(
        Modifier.fillMaxSize().background(C.bg),
        contentPadding = PaddingValues(start = Metrics.GUTTER.dp, end = Metrics.GUTTER.dp, top = 2.dp, bottom = 16.dp),
        verticalArrangement = Arrangement.spacedBy(11.dp),
    ) {
        item {
            Column(verticalArrangement = Arrangement.spacedBy(Metrics.GAP.dp), modifier = Modifier.padding(bottom = 3.dp)) {
                PageHeader("${all.size} đơn ${dateFilter.scopeLabel} · $date", "Đơn hàng") {
                    HeaderAddButton("Tạo đơn") { ui.push(Route.OrderCreate) }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    SearchField(search, { search = it }, Modifier.weight(1f))
                    CircleButton(IconName.FILTER) { ui.present(0.9f) { DateFilterSheet(dateFilter) { dateFilter = it } } }
                }
                Row(Modifier.bleed().horizontalScroll(rememberScrollState()).padding(horizontal = Metrics.GUTTER.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    listOf("Tất cả", "Đơn mới", "Đã in", "Đang giao", "Đã giao").forEachIndexed { i, t ->
                        Chip("$t · ${all.count { matches(it, i) }}", filter == i) { filter = i }
                    }
                }
                if (list.isEmpty()) EmptyNote("Chưa có đơn nào. Bấm nút in trên một bình luận hoặc “Tạo đơn” để thêm đơn.")
            }
        }
        items(list, key = { it.id }) { o ->
            OrderCard(o, onPrint = { scope.launch { ui.notify(app.printOrder(o)) } })
        }
    }
}

@Composable
private fun OrderCard(o: Order, onPrint: () -> Unit) {
    val app = LocalApp.current
    val ui = LocalAppUI.current
    Column(
        Modifier.fillMaxWidth().cardStyle(20f).padding(start = 15.dp, end = 15.dp, top = 15.dp, bottom = 14.dp),
        verticalArrangement = Arrangement.spacedBy(15.dp),
    ) {
        Row(Modifier.fillMaxWidth().plainTap { ui.push(Route.Order(o.id)) }, verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Avatar(o.customer.initials, o.customer.id, 40f, 14f)
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    T(o.customer.nickname, 15f, BV.BOLD, modifier = Modifier.weight(1f), maxLines = 1)
                    T(money(o.total), 17f, BV.HEAVY, C.ink, track = -0.4f, maxLines = 1)
                }
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    T("@${o.customer.uniqueId} · ${o.productCount} sản phẩm · ${timeText(o.lastTs)}", 12f, BV.MEDIUM, C.muted,
                        Modifier.weight(1f), shrink = true)
                    StatusBadge(o.status)
                }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            OutlineButton("In đơn", Modifier.weight(1f), IconName.PRINTER, filled = !o.isPrinted, onClick = onPrint)
            OutlineButton(deliveryLabel(o), Modifier.weight(1f), IconName.TRUCK, if (o.status == OrderStatus.DELIVERED) C.green else null) {
                app.store.advanceDelivery(o)
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
                    T(o.customer.nickname, 16f, BV.BOLD, maxLines = 1)
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
    SubPage("Chi tiết đơn hàng", trailing = { if (o != null) StatusBadge(o.status, 12f, 25f) }) {
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
                                Box(Modifier.weight(1f, fill = false)) { T(o.customer.nickname, 17f, BV.BOLD, shrink = true) }
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
            }
            Column(Modifier.padding(start = Metrics.GUTTER.dp, end = Metrics.GUTTER.dp, top = 4.dp, bottom = 10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                PrimaryButton("Chỉnh sửa đơn", icon = IconName.PENCIL, fontSize = 15f) { ui.push(Route.OrderEdit(o.id)) }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlineButton(deliveryLabel(o), Modifier.weight(1f), IconName.TRUCK, if (o.status == OrderStatus.DELIVERED) C.green else null, 48f) {
                        store.advanceDelivery(o)
                    }
                    OutlineButton("In đơn", Modifier.weight(1f), IconName.PRINTER, height = 48f) {
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
                if (order != null) store.updateOrder(order, items.toList())
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
