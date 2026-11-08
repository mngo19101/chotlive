package com.chotlive.app.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.chotlive.app.BuildConfig
import com.chotlive.app.model.Clock
import com.chotlive.app.model.Customer
import com.chotlive.app.model.Order
import com.chotlive.app.model.compactMoney
import com.chotlive.app.model.fullDate
import com.chotlive.app.model.longWeekday
import com.chotlive.app.model.money
import com.chotlive.app.model.relativeDay
import com.chotlive.app.model.shortDate
import com.chotlive.app.model.timeText
import com.chotlive.app.model.weekdayLabel
import com.chotlive.app.net.LiveClient
import kotlinx.coroutines.launch
import java.time.LocalDate
import kotlin.math.roundToInt

/** Địa chỉ server gắn sẵn lúc build. null: bản thử nghiệm, màn đăng nhập cho nhập tay. */
val builtInServer: String? get() = LiveClient.normalize(BuildConfig.SERVER_URL).ifEmpty { null }

/** Phải khớp MIN_PASSWORD_LENGTH trong server.js. */
const val MIN_PASSWORD_LENGTH = 6

// MARK: - Đăng nhập

@Composable
fun LoginScreen() {
    val app = LocalApp.current
    val client = app.client
    var register by remember { mutableStateOf(false) }
    var server by remember { mutableStateOf(builtInServer ?: app.auth.server ?: "") }
    var user by remember { mutableStateOf("") }
    var pass by remember { mutableStateOf("") }
    var confirm by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    val canSubmit = !busy && server.isNotEmpty() && user.isNotEmpty() && pass.isNotEmpty() && (!register || confirm.isNotEmpty())
    val buttonTitle = if (busy) (if (register) "Đang tạo tài khoản..." else "Đang đăng nhập...")
    else (if (register) "Tạo tài khoản" else "Đăng nhập")

    fun submit() {
        if (register) {
            if (pass.length < MIN_PASSWORD_LENGTH) {
                error = "Mật khẩu phải có ít nhất $MIN_PASSWORD_LENGTH ký tự."
                return
            }
            if (pass != confirm) {
                error = "Mật khẩu nhập lại không khớp."
                return
            }
        }
        busy = true
        error = null
        scope.launch {
            try {
                if (register) client.register(server, user, pass, confirm) else client.login(server, user, pass)
            } catch (e: Exception) {
                error = e.message
            }
            busy = false
        }
    }

    BoxWithConstraints(Modifier.fillMaxSize().background(C.bg)) {
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState())
                .heightIn(min = maxHeight).padding(horizontal = Metrics.GUTTER.dp, vertical = 24.dp),
            verticalArrangement = Arrangement.spacedBy(Metrics.GAP.dp, Alignment.CenterVertically),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp),
                modifier = Modifier.padding(bottom = 6.dp)) {
                OnAccent {
                    Box(Modifier.size(68.dp).clip(rounded(20f)).background(C.orange), contentAlignment = Alignment.Center) {
                        T("CL", 26f, BV.HEAVY, C.ink, track = -0.5f)
                    }
                }
                Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    T("ChốtLive", 28f, BV.HEAVY, C.ink, track = -0.5f)
                    T(if (register) "Tạo tài khoản để bắt đầu chốt đơn" else "Chốt đơn TikTok Live, in tem tức thì",
                        14f, BV.MEDIUM, C.muted, align = TextAlign.Center)
                }
            }
            Row(Modifier.fillMaxWidth().capsule(C.card, C.line).padding(4.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                for ((title, isReg) in listOf("Đăng nhập" to false, "Đăng ký" to true)) {
                    val selected = register == isReg
                    OnAccent(selected) {
                        Box(
                            Modifier.weight(1f).height(40.dp).capsule(if (selected) C.orange else C.card)
                                .plainTap { register = isReg; error = null; confirm = "" },
                            contentAlignment = Alignment.Center,
                        ) { T(title, 14f, BV.BOLD, if (selected) C.ink else C.muted) }
                    }
                }
            }
            Column(Modifier.fillMaxWidth().cardStyle(24f).padding(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                // Bản phát hành đã gắn sẵn địa chỉ server nên người dùng không phải biết tới.
                if (builtInServer == null) {
                    LabeledField("Địa chỉ máy chủ", "https://ten-mien-cua-ban.vn", server, { server = it },
                        keyboard = KeyboardType.Uri, capitalize = false)
                }
                LabeledField("Tên tài khoản", "Tên tài khoản", user, { user = it }, capitalize = false)
                LabeledField("Mật khẩu", "Mật khẩu", pass, { pass = it }, password = true)
                if (register) LabeledField("Nhập lại mật khẩu", "Nhập lại mật khẩu", confirm, { confirm = it }, password = true)
            }
            error?.let { T(it, 13f, BV.MEDIUM, C.red, align = TextAlign.Center) }
            PrimaryButton(buttonTitle, enabled = canSubmit) { submit() }
            T(if (register) "Mật khẩu từ $MIN_PASSWORD_LENGTH ký tự trở lên."
            else "Quên mật khẩu? Liên hệ quản trị viên ChốtLive để được đặt lại.", 12f, BV.MEDIUM, C.muted, align = TextAlign.Center)
        }
    }
}

// MARK: - Doanh số

@Composable
fun DashboardScreen() {
    val app = LocalApp.current
    val store = app.store
    val client = app.client
    var days by remember { mutableIntStateOf(7) }
    val today = Clock.today()

    val customers = store.customers
    val revenueToday = remember(customers, today) { store.revenue(today) }
    val prevDay = remember(customers, today) { store.revenue(today.minusDays(1)) }
    val deltaYesterday = if (prevDay > 0) ((revenueToday - prevDay).toDouble() / prevDay * 100).roundToInt() else null
    val previousMonth = today.minusMonths(1)
    val revenueMonth = remember(customers, today) { store.revenue(today, 31) }
    val prevMonth = remember(customers, today) { store.revenue(previousMonth, today.dayOfMonth) }
    val deltaMonth = if (prevMonth > 0) ((revenueMonth - prevMonth).toDouble() / prevMonth * 100).roundToInt() else null
    val newToday = customers.count { it.isNewToday }
    val todayCount = remember(customers, today) { store.customersToday().size }
    val series = remember(customers, today, days) {
        (days - 1 downTo 0).map { off -> today.minusDays(off.toLong()).let { it to store.revenue(it) } }
    }

    BoxWithConstraints(Modifier.fillMaxSize().background(C.bg)) {
        val chartHeight = maxOf(300.dp, maxHeight - 372.5.dp)
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = Metrics.GUTTER.dp, vertical = 2.dp),
            verticalArrangement = Arrangement.spacedBy(Metrics.GAP.dp),
        ) {
            PageHeader("${longWeekday(today)}, ${fullDate(today)}", "Doanh số") {
                if (client.liveState == "connected") {
                    Row(Modifier.height(36.dp).capsule(C.card, C.line).padding(horizontal = 13.dp),
                        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Box(Modifier.size(8.dp).clip(CircleShape).background(C.live))
                        T("Đang live", 13f, BV.BOLD, maxLines = 1)
                    }
                }
            }
            // Thẻ doanh thu hôm nay
            OnAccent {
                Column(Modifier.fillMaxWidth().clip(rounded(24f)).background(C.orange)
                    .padding(start = 22.dp, end = 22.dp, top = 20.dp, bottom = 21.dp)) {
                    T("Doanh thu hôm nay", 14f, BV.SEMIBOLD)
                    T(money(revenueToday), 40f, BV.HEAVY, C.ink, Modifier.padding(top = 2.dp), track = -1.5f, shrink = true)
                    Row(Modifier.padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        if (deltaYesterday != null) {
                            val up = deltaYesterday >= 0
                            Row(Modifier.height(23.dp).capsule(hex(0x0D1015)).padding(horizontal = 9.dp),
                                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                                Icon(if (up) IconName.CHEVRON_UP else IconName.CHEVRON_DOWN, 14f, 2.6f, if (up) C.greenBright else C.live)
                                T("${if (up) "+" else ""}$deltaYesterday%", 13f, BV.SEMIBOLD, if (up) C.greenBright else C.live)
                            }
                            T("so với hôm qua", 13f, BV.SEMIBOLD)
                        } else {
                            T("Chưa có dữ liệu hôm qua", 13f, BV.SEMIBOLD, modifier = Modifier.height(23.dp))
                        }
                    }
                }
            }
            Row(Modifier.fillMaxWidth().height(131.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Column(Modifier.weight(0.417f).fillMaxHeight().cardStyle(20f).padding(start = 17.dp, end = 17.dp, top = 17.dp, bottom = 12.dp)) {
                    Row(horizontalArrangement = Arrangement.spacedBy(9.dp)) {
                        Icon(IconName.USERS, 14f, color = C.muted, modifier = Modifier.padding(top = 2.dp))
                        T("Khách hôm\nnay", 13f, BV.MEDIUM, C.muted, lineHeight = 16f)
                    }
                    T("$todayCount", 30f, BV.HEAVY, C.ink, Modifier.padding(top = 8.dp), track = -1f)
                    T("$newToday khách mới", 12f, BV.SEMIBOLD, C.accent, Modifier.padding(top = 4.dp), maxLines = 1)
                }
                Column(Modifier.weight(0.583f).fillMaxHeight().cardStyle(20f).padding(start = 17.dp, end = 17.dp, top = 17.dp, bottom = 12.dp)) {
                    Row(horizontalArrangement = Arrangement.spacedBy(9.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(IconName.CALENDAR, 16f, color = C.muted)
                        T("Doanh thu tháng ${today.monthValue}", 13f, BV.MEDIUM, C.muted, shrink = true)
                    }
                    T(money(revenueMonth), 24f, BV.HEAVY, C.ink, Modifier.padding(top = 13.dp), track = -0.8f, shrink = true)
                    val pm = previousMonth.monthValue
                    if (deltaMonth != null) {
                        T("${if (deltaMonth >= 0) "+" else ""}$deltaMonth% so với tháng $pm", 12f, BV.SEMIBOLD,
                            if (deltaMonth >= 0) C.green else C.red, Modifier.padding(top = 4.dp), shrink = true)
                    } else {
                        T("Chưa có dữ liệu tháng $pm", 12f, BV.SEMIBOLD, C.muted, Modifier.padding(top = 4.dp), shrink = true)
                    }
                }
            }
            // Biểu đồ
            Column(Modifier.fillMaxWidth().height(chartHeight).cardStyle(24f).padding(start = 16.dp, end = 16.dp, top = 16.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    T("Doanh thu theo ngày", 15f, BV.BOLD, modifier = Modifier.weight(1f), shrink = true)
                    Row(Modifier.clip(rounded(13f)).background(C.track).padding(3.dp)) {
                        for ((title, value) in listOf("7 ngày" to 7, "30 ngày" to 30)) {
                            val sel = days == value
                            OnAccent(sel) {
                                Box(Modifier.height(28.dp).clip(rounded(10f)).background(if (sel) C.orange else C.track)
                                    .plainTap { days = value }.padding(horizontal = 13.dp), contentAlignment = Alignment.Center) {
                                    T(title, 12f, if (sel) BV.BOLD else BV.SEMIBOLD, if (sel) C.ink else C.muted, maxLines = 1)
                                }
                            }
                        }
                    }
                }
                Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                    BarChart(series, labelEveryBar = days == 7, Modifier.fillMaxWidth().height(170.dp))
                }
            }
            Gap(2f)
        }
    }
}

/** Biểu đồ cột: 2 vạch đứt, trục đáy, cột hôm nay màu cam kèm số tiền. */
@Composable
fun BarChart(data: List<Pair<LocalDate, Int>>, labelEveryBar: Boolean, modifier: Modifier) {
    val line = C.line
    val bar = C.bar
    val deep = C.orangeDeep
    BoxWithConstraints(modifier) {
        val w = maxWidth
        val h = maxHeight
        val labelArea = 23.dp
        val top = 25.dp
        val plot = h - labelArea - top
        val maxValue = maxOf(data.maxOfOrNull { it.second } ?: 0, 1)
        val inset = if (data.size > 10) 0.dp else 1.dp
        val column = (w - inset * 2) / maxOf(data.size, 1)
        val barWidth = if (data.size > 10) maxOf(column - 3.dp, 2.dp) else minOf(29.dp, column - 8.dp)
        Canvas(Modifier.fillMaxSize()) {
            val dash = PathEffect.dashPathEffect(floatArrayOf(4.dp.toPx(), 4.dp.toPx()))
            val topPx = top.toPx()
            val plotPx = plot.toPx()
            for (y in listOf(topPx, topPx + plotPx / 2)) {
                drawLine(line, Offset(0f, y), Offset(size.width, y), 1.dp.toPx(), pathEffect = dash)
            }
            drawLine(line, Offset(0f, topPx + plotPx), Offset(size.width, topPx + plotPx), 1.dp.toPx())
            data.forEachIndexed { i, (_, v) ->
                val isToday = i == data.lastIndex
                val bh = maxOf(v.toFloat() / maxValue * plotPx * 0.95f, 3.dp.toPx())
                val cx = inset.toPx() + column.toPx() * (i + 0.5f)
                val bw = barWidth.toPx()
                val r = (if (data.size > 10) 3.dp else 7.dp).toPx()
                drawRoundRect(if (isToday) deep else bar, Offset(cx - bw / 2, topPx + plotPx - bh), Size(bw, bh), CornerRadius(r, r))
            }
        }
        data.forEachIndexed { i, (day, v) ->
            val isToday = i == data.lastIndex
            val cx = inset + column * (i + 0.5f)
            val bh = maxOf(plot * (v.toFloat() / maxValue * 0.95f), 3.dp)
            if (isToday && v > 0) {
                Box(Modifier.offset(x = minOf(cx, w - 20.dp) - 40.dp, y = top + plot - bh - 20.dp).width(80.dp), contentAlignment = Alignment.Center) {
                    T(compactMoney(v), 12f, BV.BOLD, C.accent, maxLines = 1)
                }
            }
            if (labelEveryBar || i % 5 == 4 || isToday) {
                Box(Modifier.offset(x = cx - 30.dp, y = top + plot + 6.dp).width(60.dp), contentAlignment = Alignment.Center) {
                    T(if (labelEveryBar) weekdayLabel(day) else shortDate(day), if (labelEveryBar) 12f else 10f,
                        if (isToday) BV.BOLD else BV.MEDIUM, if (isToday) C.ink else C.muted, maxLines = 1)
                }
            }
        }
    }
}

// MARK: - Khách hàng

@Composable
fun CustomersScreen() {
    val app = LocalApp.current
    val store = app.store
    val ui = LocalAppUI.current
    var search by remember { mutableStateOf("") }
    var filter by remember { mutableIntStateOf(0) } // 0 tất cả, 1 mới hôm nay, 2 mua nhiều

    val customers = store.customers
    val list = remember(customers, filter, search) {
        var l = customers.sortedByDescending { it.lastTs }
        when (filter) {
            1 -> l = l.filter { it.isNewToday }
            2 -> l = l.filter { it.isBigSpender }.sortedByDescending { it.total }
        }
        val q = search.trim().lowercase()
        if (q.isNotEmpty()) l = l.filter { it.nickname.lowercase().contains(q) || it.uniqueId.lowercase().contains(q) }
        l
    }

    LazyColumn(
        Modifier.fillMaxSize().background(C.bg),
        contentPadding = PaddingValues(start = Metrics.GUTTER.dp, end = Metrics.GUTTER.dp, top = 2.dp, bottom = 16.dp),
        verticalArrangement = Arrangement.spacedBy(8.5.dp),
    ) {
        item {
            Column(verticalArrangement = Arrangement.spacedBy(Metrics.GAP.dp), modifier = Modifier.padding(bottom = 6.dp)) {
                PageHeader("${customers.size} khách · ${customers.count { it.isNewToday }} khách mới hôm nay", "Khách hàng")
                SearchField(search, { search = it }, Modifier.fillMaxWidth())
                Row(Modifier.bleed().horizontalScroll(rememberScrollState()).padding(horizontal = Metrics.GUTTER.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Chip("Tất cả", filter == 0) { filter = 0 }
                    Chip("Mới hôm nay", filter == 1) { filter = 1 }
                    Chip("Mua nhiều", filter == 2) { filter = 2 }
                }
                if (list.isEmpty()) EmptyNote("Chưa có khách. Bấm nút in trên một bình luận để lưu khách.")
            }
        }
        items(list, key = { it.id }) { c -> CustomerRow(c, store.orders(c).size) { ui.push(Route.Customer(c.id)) } }
    }
}

@Composable
private fun CustomerRow(c: Customer, orderCount: Int, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().height(69.dp).cardStyle(18f).tap(onClick = onClick).padding(horizontal = 15.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Avatar(c.initials, c.id)
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.weight(1f, fill = false)) { T(c.nickname, 15f, BV.BOLD, shrink = true) }
                if (c.isBigSpender) {
                    Box(Modifier.padding(start = 7.dp)) { Badge("Mua nhiều") }
                } else if (c.isNewToday) {
                    Box(Modifier.padding(start = 7.dp)) { Badge("Mới", C.green, C.greenSoft) }
                }
                Box(Modifier.weight(1f, fill = true))
                T(money(c.total), 14f, BV.HEAVY, maxLines = 1)
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                T("@${c.uniqueId} · ${relativeDay(c.lastTs)}", 12f, BV.MEDIUM, C.muted, Modifier.weight(1f), maxLines = 1)
                T("$orderCount đơn", 12f, BV.MEDIUM, C.muted, maxLines = 1)
            }
        }
    }
}

@Composable
fun CustomerDetailScreen(customerId: String) {
    val app = LocalApp.current
    val store = app.store
    val ui = LocalAppUI.current
    SubPage("Hồ sơ khách hàng") {
        val c = store.customers.firstOrNull { it.id == customerId }
        if (c == null) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { T("Khách không còn tồn tại", 14f, BV.MEDIUM, C.muted) }
            return@SubPage
        }
        val orders = remember(c) { store.orders(c) }
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(start = Metrics.GUTTER.dp, end = Metrics.GUTTER.dp, bottom = 16.dp),
            verticalArrangement = Arrangement.spacedBy(Metrics.GAP.dp),
        ) {
            // Hồ sơ
            Column(Modifier.fillMaxWidth().cardStyle(20f).padding(start = 17.dp, end = 17.dp, top = 18.dp, bottom = 17.dp),
                verticalArrangement = Arrangement.spacedBy(13.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(13.dp)) {
                    Avatar(c.initials, c.id, 56f, 19f)
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            Box(Modifier.weight(1f, fill = false)) { T(c.nickname, 18f, BV.BOLD, shrink = true) }
                            if (c.isBigSpender) Badge("Mua nhiều")
                        }
                        T("@" + c.uniqueId, 13f, BV.MEDIUM, C.muted, maxLines = 1)
                    }
                }
                HairLine()
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Summary(money(c.total), "Tổng chi tiêu", Modifier.weight(1f))
                    VLine(36f)
                    Summary("${orders.size}", "Số đơn", Modifier.weight(1f))
                    VLine(36f)
                    Summary(shortDate(c.lastTs), "Mua gần nhất", Modifier.weight(1f))
                }
            }
            // Địa chỉ
            val a = c.address ?: com.chotlive.app.model.DeliveryAddress()
            Column(Modifier.fillMaxWidth().cardStyle(20f).padding(start = 17.dp, end = 17.dp, top = 15.dp, bottom = 7.dp)) {
                Row(Modifier.padding(bottom = 7.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(9.dp)) {
                    Icon(IconName.PIN, 17f, color = C.accent)
                    T("Địa chỉ nhận hàng", 15f, BV.BOLD, modifier = Modifier.weight(1f), maxLines = 1)
                    Row(Modifier.height(35.dp).capsule(C.field).tap { ui.push(Route.AddressEdit(c.id)) }.padding(horizontal = 15.dp),
                        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Icon(IconName.PENCIL, 13f, 2.3f)
                        T("Sửa", 13f, BV.BOLD)
                    }
                }
                AddressRow("Người nhận", a.receiver.ifEmpty { c.nickname })
                HairLine()
                AddressRow("Số điện thoại", a.phone)
                HairLine()
                AddressRow("Địa chỉ", a.street)
                HairLine()
                AddressRow("Phường / Quận\n/ Tỉnh", a.region)
                HairLine()
                AddressRow("Ghi chú giao", a.note)
            }
            // Lịch sử
            Column(Modifier.fillMaxWidth().cardStyle(20f).padding(start = 17.dp, end = 17.dp, top = 15.dp, bottom = 8.dp)) {
                Row(Modifier.padding(bottom = 5.dp)) {
                    T("Lịch sử mua hàng", 15f, BV.BOLD, modifier = Modifier.weight(1f))
                    T("${orders.size} đơn", 12f, BV.MEDIUM, C.muted)
                }
                orders.forEachIndexed { i, o ->
                    if (i > 0) HairLine()
                    HistoryRow(o) { ui.push(Route.Order(o.id)) }
                }
            }
        }
    }
}

@Composable
private fun Summary(value: String, label: String, modifier: Modifier) {
    Column(modifier, horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(2.dp)) {
        T(value, 16f, BV.HEAVY, C.ink, track = -0.3f, shrink = true)
        T(label, 11f, BV.MEDIUM, C.muted, maxLines = 1)
    }
}

@Composable
private fun AddressRow(label: String, value: String) {
    Row(Modifier.fillMaxWidth().padding(vertical = 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        T(label, 13f, BV.MEDIUM, C.muted, Modifier.width(100.dp))
        T(value.ifEmpty { "Chưa có" }, 14f, BV.SEMIBOLD, if (value.isEmpty()) C.faint else C.ink, Modifier.weight(1f))
    }
}

@Composable
private fun HistoryRow(o: Order, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().plainTap(onClick = onClick).padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.width(64.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            T(shortDate(o.lastTs), 15f, BV.HEAVY, C.ink, track = -0.4f)
            T(timeText(o.lastTs), 11f, BV.MEDIUM, C.muted)
        }
        T("${o.productCount} sản phẩm", 13f, BV.MEDIUM, C.muted, Modifier.weight(1f), maxLines = 1)
        Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(3.dp)) {
            T(money(o.total), 14f, BV.HEAVY, maxLines = 1)
            StatusBadge(o.status)
        }
    }
}
