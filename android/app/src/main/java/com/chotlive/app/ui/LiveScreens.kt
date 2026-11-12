@file:OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class)

package com.chotlive.app.ui

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
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
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.TimeInput
import androidx.compose.material3.TimePickerDefaults
import androidx.compose.material3.rememberTimePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.chotlive.app.data.CommentCursor
import com.chotlive.app.model.Clock
import com.chotlive.app.model.Customer
import com.chotlive.app.model.DateFilter
import com.chotlive.app.model.LiveComment
import com.chotlive.app.model.LiveSession
import com.chotlive.app.model.OrderItem
import com.chotlive.app.model.TikTokAccount
import com.chotlive.app.model.minuteText
import com.chotlive.app.model.money
import com.chotlive.app.model.pillLabel
import com.chotlive.app.model.scopeLabel
import com.chotlive.app.model.shortDate
import com.chotlive.app.model.timeText
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.time.LocalDate
import java.time.YearMonth

// MARK: - Bình luận: danh sách phiên live

@Composable
fun LiveScreen() {
    val app = LocalApp.current
    val store = app.store
    val ui = LocalAppUI.current
    var filter by remember { mutableStateOf(DateFilter.make(DateFilter.Preset.TODAY)) }
    val sessions = remember(store.sessions, filter) { store.sessions(filter) }
    val commentCount = sessions.sumOf { it.commentCount }

    Column(
        Modifier.fillMaxSize().background(C.bg).verticalScroll(rememberScrollState())
            .padding(start = Metrics.GUTTER.dp, end = Metrics.GUTTER.dp, top = 2.dp, bottom = 16.dp),
        verticalArrangement = Arrangement.spacedBy(Metrics.GAP.dp),
    ) {
        PageHeader("Các phiên live đã ghi lại", "Bình luận") {
            HeaderAddButton("Live mới") { ui.present(SHEET_DIM) { LiveNewSheet() } }
        }
        DateRow(filter) { filter = it }
        Row(Modifier.bleed().horizontalScroll(rememberScrollState()).padding(horizontal = Metrics.GUTTER.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            for ((t, p) in listOf("Hôm nay" to DateFilter.Preset.TODAY, "Hôm qua" to DateFilter.Preset.YESTERDAY,
                "7 ngày" to DateFilter.Preset.LAST7, "Tháng này" to DateFilter.Preset.THIS_MONTH)) {
                Chip(t, filter.preset == p) { filter = DateFilter.make(p) }
            }
        }
        // Thống kê
        Column(Modifier.fillMaxWidth().cardStyle(24f).padding(17.dp, 16.dp, 17.dp, 16.dp)) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    StatTile(IconName.RADIO, "${sessions.size}", "phiên live", Modifier.weight(1f))
                    StatTile(IconName.MESSAGE, "$commentCount", "bình luận", Modifier.weight(1f))
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    StatTile(IconName.USERS, "${store.customerCount(filter)}", "khách", Modifier.weight(1f))
                    StatTile(IconName.BAG, "${store.orders(filter).size}", "đơn", Modifier.weight(1f))
                }
            }
            Box(Modifier.padding(top = 12.dp)) {
                Timeline(sessions, showNow = filter.contains(Clock.now) && store.openSession != null)
            }
        }
        Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
            Row {
                T("Các phiên ${filter.scopeLabel}", 13f, BV.BOLD, modifier = Modifier.weight(1f), maxLines = 1)
                T("${sessions.size} phiên", 12f, BV.MEDIUM, C.muted)
            }
            if (sessions.isEmpty()) EmptyNote("Chưa có phiên live nào. Bấm “Live mới” để bắt đầu đọc bình luận.", 24f)
            Column(verticalArrangement = Arrangement.spacedBy(28.dp)) {
                for (s in sessions) SessionRow(s) { ui.push(Route.Session(s.id)) }
            }
        }
    }
}

@Composable
fun DateRow(filter: DateFilter, onChange: (DateFilter) -> Unit) {
    val ui = LocalAppUI.current
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        CircleButton(IconName.CHEVRON_LEFT) { onChange(filter.shifted(-1)) }
        Row(
            Modifier.weight(1f).height(44.dp).capsule(C.card, C.ink, 1.2f)
                .tap { ui.present(0.9f) { DateFilterSheet(filter, onChange) } }.padding(horizontal = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp, Alignment.CenterHorizontally),
        ) {
            Icon(IconName.CALENDAR, 17f)
            Box(Modifier.weight(1f, fill = false)) { T(filter.pillLabel, 14f, BV.BOLD, shrink = true) }
            Icon(IconName.CHEVRON_DOWN, 15f, 2.4f)
        }
        CircleButton(IconName.CHEVRON_RIGHT, enabled = filter.canGoNext) { onChange(filter.shifted(1)) }
    }
}

@Composable
private fun StatTile(icon: IconName, value: String, label: String, modifier: Modifier) {
    Row(
        modifier.height(44.dp).clip(rounded(14f)).background(C.field).padding(start = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Box(Modifier.size(28.dp).clip(CircleShape).background(C.peachSoft), contentAlignment = Alignment.Center) {
            Icon(icon, 13f, 2.3f, C.accent)
        }
        TA(annotated(value to spanStyle(16f, BV.HEAVY, C.ink), " $label" to spanStyle(12f, BV.MEDIUM, C.muted)))
    }
}

@Composable
private fun SessionRow(s: LiveSession, onClick: () -> Unit) {
    val store = LocalApp.current.store
    Row(horizontalArrangement = Arrangement.spacedBy(13.dp)) {
        Column(Modifier.width(50.dp).padding(top = if (s.isLive) 0.dp else 4.dp),
            horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(3.dp)) {
            T(timeText(s.start), 15f, BV.HEAVY, C.ink, track = -0.3f)
            Box(Modifier.width(3.dp).height(14.dp).background(C.bar))
            val end = s.end
            if (end != null) T(timeText(end), 14f, BV.MEDIUM, C.muted) else T("Đang live", 12f, BV.SEMIBOLD, C.red)
        }
        Row(
            Modifier.weight(1f).height(if (s.isLive) 70.dp else 67.dp)
                .cardStyle(18f, if (s.isLive) C.peachSoft else C.card, if (s.isLive) C.peachLine else C.line)
                .tap(onClick = onClick).padding(horizontal = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    T(s.title, 15f, BV.BOLD, maxLines = 1)
                    if (s.isLive) {
                        Row(Modifier.height(21.dp).capsule(C.card).padding(horizontal = 10.dp),
                            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                            Box(Modifier.size(6.dp).clip(CircleShape).background(C.live))
                            T("Live", 12f, BV.SEMIBOLD, C.red)
                        }
                    }
                    T(s.duration, 12f, BV.MEDIUM, C.muted, maxLines = 1)
                }
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    CountItem(IconName.MESSAGE, s.commentCount)
                    CountItem(IconName.USERS, store.sessionCustomerCount(s.id))
                    CountItem(IconName.BAG, store.sessionOrderCount(s.id))
                }
            }
            Icon(IconName.CHEVRON_RIGHT, 16f)
        }
    }
}

@Composable
private fun CountItem(icon: IconName, value: Int) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
        Icon(icon, 13f, color = C.muted)
        T("$value", 13f, BV.BOLD)
    }
}

/** Thanh 0h–24h: các đoạn cam là phiên live, vạch đỏ là hiện tại. */
@Composable
fun Timeline(sessions: List<LiveSession>, showNow: Boolean) {
    fun fraction(ms: Long) = Clock.minuteOfDay(ms) / 1440f
    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
        BoxWithConstraints(Modifier.fillMaxWidth().height(20.dp), contentAlignment = Alignment.CenterStart) {
            val w = maxWidth
            Box(Modifier.fillMaxWidth().height(14.dp).clip(Capsule).background(C.track))
            for (s in sessions) {
                val from = fraction(s.start)
                val to = maxOf(fraction(s.end ?: Clock.now), from)
                Box(Modifier.offset(x = w * from).width(maxOf(w * (to - from), 14.dp)).height(14.dp).clip(Capsule).background(C.orange))
            }
            if (showNow) {
                Box(Modifier.offset(x = w * fraction(Clock.now) - 1.5.dp).width(3.dp).height(20.dp).clip(rounded(1.5f)).background(C.live))
            }
        }
        Row {
            listOf("0h", "6h", "12h", "18h", "24h").forEachIndexed { i, label ->
                T(label, 11f, BV.MEDIUM, C.muted)
                if (i < 4) Box(Modifier.weight(1f))
            }
        }
    }
}

// MARK: - Xem lại thời điểm

@Composable
fun DateFilterSheet(initial: DateFilter, onApply: (DateFilter) -> Unit) {
    val ui = LocalAppUI.current
    var filter by remember { mutableStateOf(initial) }
    var month by remember { mutableStateOf(YearMonth.from(initial.endDay)) }
    var editingFrom by remember { mutableStateOf<Boolean?>(null) }
    val today = Clock.today()

    Column(
        Modifier.fillMaxWidth().heightIn(max = sheetHeight(10.dp)).verticalScroll(rememberScrollState())
            .padding(horizontal = Metrics.GUTTER.dp)
    ) {
        Box(Modifier.padding(top = 8.dp, bottom = 15.dp)) { SheetTitle("Xem lại thời điểm") }
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            val rows = listOf(
                listOf("Hôm nay" to DateFilter.Preset.TODAY, "Hôm qua" to DateFilter.Preset.YESTERDAY, "7 ngày qua" to DateFilter.Preset.LAST7),
                listOf("30 ngày qua" to DateFilter.Preset.LAST30, "Tháng này" to DateFilter.Preset.THIS_MONTH, "Tháng trước" to DateFilter.Preset.LAST_MONTH),
            )
            for (row in rows) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    for ((title, preset) in row) {
                        val selected = filter.preset == preset
                        OnAccent(selected) {
                            Box(
                                Modifier.weight(1f).height(40.dp).capsule(if (selected) C.orange else C.card, if (selected) null else C.line)
                                    .tap {
                                        filter = DateFilter.make(preset).copy(fromMinute = filter.fromMinute, toMinute = filter.toMinute)
                                        month = YearMonth.from(filter.endDay)
                                    },
                                contentAlignment = Alignment.Center,
                            ) { T(title, 13f, if (selected) BV.BOLD else BV.SEMIBOLD, shrink = true) }
                        }
                    }
                }
            }
        }
        // Tháng
        val canNext = month.plusMonths(1).atDay(1) <= today
        Row(Modifier.padding(top = 22.dp, end = 9.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(22.dp)) {
            T("Tháng ${month.monthValue}, ${month.year}", 15f, BV.BOLD, modifier = Modifier.weight(1f))
            Box(Modifier.size(26.dp).plainTap { month = month.minusMonths(1) }, contentAlignment = Alignment.Center) { Icon(IconName.CHEVRON_LEFT, 18f) }
            Box(Modifier.size(26.dp).plainTap(enabled = canNext) { month = month.plusMonths(1) }, contentAlignment = Alignment.Center) {
                Icon(IconName.CHEVRON_RIGHT, 18f, color = if (canNext) C.ink else C.faint)
            }
        }
        Column(Modifier.padding(top = 9.dp)) {
            Row(Modifier.fillMaxWidth()) {
                for (d in listOf("T2", "T3", "T4", "T5", "T6", "T7", "CN")) {
                    Box(Modifier.weight(1f).height(20.dp), contentAlignment = Alignment.Center) { T(d, 12f, BV.SEMIBOLD, C.muted) }
                }
            }
            // Luôn 5–6 hàng, bắt đầu từ Thứ Hai.
            val first = month.atDay(1)
            val leading = first.dayOfWeek.value - 1
            val total = ((leading + month.lengthOfMonth() + 6) / 7) * 7
            val days = (0 until total).map { first.plusDays((it - leading).toLong()) }
            for (week in days.chunked(7)) {
                Row(Modifier.fillMaxWidth()) {
                    for (d in week) {
                        DayCell(d, month, filter, today, Modifier.weight(1f)) {
                            filter = DateFilter.single(d).copy(fromMinute = filter.fromMinute, toMinute = filter.toMinute)
                        }
                    }
                }
            }
        }
        T("Khung giờ trong ngày", 14f, BV.BOLD, modifier = Modifier.padding(top = 12.dp))
        Row(Modifier.padding(top = 7.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            for ((label, isFrom) in listOf("Từ" to true, "Đến" to false)) {
                val active = editingFrom == isFrom
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                    T(label, 12f, BV.MEDIUM, C.muted)
                    Box(
                        Modifier.fillMaxWidth().height(43.dp).cardStyle(14f, C.field, if (active) C.orange else C.line)
                            .plainTap { editingFrom = if (active) null else isFrom }.padding(start = 15.dp),
                        contentAlignment = Alignment.CenterStart,
                    ) { T(minuteText(if (isFrom) filter.fromMinute else filter.toMinute), 15f, BV.BOLD) }
                }
            }
        }
        editingFrom?.let { isFrom ->
            key(isFrom) {
                val start = if (isFrom) filter.fromMinute else filter.toMinute
                val state = rememberTimePickerState(start / 60, start % 60, is24Hour = true)
                LaunchedEffect(state.hour, state.minute) {
                    val m = state.hour * 60 + state.minute
                    filter = if (isFrom) filter.copy(fromMinute = m) else filter.copy(toMinute = m)
                }
                Box(Modifier.fillMaxWidth().padding(top = 10.dp), contentAlignment = Alignment.Center) {
                    TimeInput(state, colors = TimePickerDefaults.colors(
                        timeSelectorSelectedContainerColor = C.peachSoft,
                        timeSelectorUnselectedContainerColor = C.field,
                        timeSelectorSelectedContentColor = C.ink,
                        timeSelectorUnselectedContentColor = C.ink,
                    ))
                }
            }
        }
        Box(Modifier.padding(top = 16.dp)) {
            PrimaryButton("Áp dụng") {
                onApply(filter)
                ui.dismissSheet()
            }
        }
    }
}

@Composable
private fun DayCell(d: LocalDate, month: YearMonth, filter: DateFilter, today: LocalDate, modifier: Modifier, onClick: () -> Unit) {
    val inMonth = YearMonth.from(d) == month
    val future = d > today
    val isEdge = d == filter.startDay || d == filter.endDay
    val inRange = d >= filter.startDay && d <= filter.endDay
    val enabled = inMonth && !future
    Box(modifier.height(46.dp).plainTap(enabled, onClick), contentAlignment = Alignment.Center) {
        if (inMonth && isEdge) Box(Modifier.size(40.dp).clip(CircleShape).background(C.orange))
        else if (inMonth && inRange) Box(Modifier.size(40.dp).clip(CircleShape).background(C.peachSoft))
        OnAccent(inMonth && isEdge) {
            T("${d.dayOfMonth}", 15f, if (inMonth && isEdge) BV.HEAVY else BV.MEDIUM, if (enabled) C.ink else C.faint)
        }
    }
}

// MARK: - Live mới

/** Đọc tên tài khoản từ chữ người dùng nhập hoặc link phiên live. */
object LiveId {
    fun parse(raw: String): String? {
        val s = raw.trim()
        Regex("@[A-Za-z0-9._]+").find(s)?.let { return it.value.drop(1) }
        return if (Regex("^[A-Za-z0-9._]+$").matches(s)) s else null
    }
}

@Composable
fun LiveNewSheet() {
    val app = LocalApp.current
    val client = app.client
    val store = app.store
    val ui = LocalAppUI.current
    val clipboard = LocalClipboardManager.current
    var input by remember { mutableStateOf("") }
    var rememberId by remember { mutableStateOf(true) }
    /** ID vừa bấm theo dõi, đang chờ server nối xong. */
    var pendingId by remember { mutableStateOf<String?>(null) }
    var timeoutMessage by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    val isConnecting = if (!client.serverSupportsSync) client.liveState == "connecting"
    else pendingId?.let { client.live(it)?.state != "connected" } ?: false
    val errorMessage: String? = run {
        val access = client.access
        if (access != null && !access.canFollowLive) return@run access.message
        timeoutMessage?.let { return@run it }
        if (client.serverSupportsSync) {
            val e = client.lastLiveEvent ?: return@run null
            if ((e.state == "error" || e.state == "ended") && e.message.isNotEmpty()) {
                if (e.username.isEmpty()) e.message else "@${e.username}: ${e.message}"
            } else null
        } else {
            val failed = client.liveState in listOf("error", "ended", "disconnected") && client.liveMessage.isNotEmpty()
            if (failed) client.liveMessage else null
        }
    }
    val liveId = LiveId.parse(input)
    val inputEmpty = input.isBlank()
    val inputInvalid = !inputEmpty && liveId == null
    val highlighted = store.accounts.firstOrNull { it.id == store.activeAccountId }
    val canStart = !isConnecting && (if (inputEmpty) highlighted != null else liveId != null)
    val saved = store.accounts.sortedByDescending { store.lastSession(it.id)?.start ?: Long.MIN_VALUE }

    // Live vừa bấm đã nối xong: mở luôn phiên của nó.
    LaunchedEffect(client.lives, pendingId) {
        val id = pendingId ?: return@LaunchedEffect
        val live = client.lives.firstOrNull { it.id == id.lowercase() } ?: return@LaunchedEffect
        if (live.state != "connected") return@LaunchedEffect
        pendingId = null
        ui.dismissSheet()
        if (live.sessionId.isNotEmpty()) ui.push(Route.Session(live.sessionId))
    }
    // Live vừa bấm không vào được: mở lại nút để người dùng thử ID khác.
    LaunchedEffect(client.lastLiveEvent?.seq) {
        val e = client.lastLiveEvent ?: return@LaunchedEffect
        if (e.username.equals(pendingId, ignoreCase = true)) pendingId = null
    }
    // Server bản cũ: mỗi tài khoản chỉ một live.
    LaunchedEffect(client.liveState) {
        if (client.serverSupportsSync || client.liveState != "connected" || pendingId == null) return@LaunchedEffect
        ui.dismissSheet()
        store.openSession?.let { ui.push(Route.Session(it.id)) }
    }

    /** Chờ quá lâu mà server không trả lời thì mở lại nút và báo lỗi. */
    fun watchPending(id: String) {
        timeoutMessage = null
        if (!client.socketConnected) {
            pendingId = null
            timeoutMessage = "Chưa nối được tới server. Kiểm tra mạng rồi thử lại."
            return
        }
        scope.launch {
            delay(45_000)
            if (pendingId.equals(id, ignoreCase = true) && client.live(id)?.state != "connected") {
                pendingId = null
                timeoutMessage = "TikTok phản hồi quá lâu. Kiểm tra @$id có đang live không rồi thử lại."
            }
        }
    }

    fun start(account: TikTokAccount) {
        if (isConnecting) return
        store.unsavedLiveId = null
        // Đang theo dõi live khác thì giữ nguyên ID đang chọn.
        if (client.lives.isEmpty()) store.selectAccount(account.id)
        pendingId = account.uniqueId
        client.connectLive(account.uniqueId)
        watchPending(account.uniqueId)
    }

    fun startNew(id: String) {
        val running = client.live(id)
        if (running != null && running.state == "connected" && running.sessionId.isNotEmpty()) {
            ui.dismissSheet()
            ui.push(Route.Session(running.sessionId))
            return
        }
        if (rememberId) {
            store.unsavedLiveId = null
            store.addAccount(id, "", activate = true)
        } else {
            store.unsavedLiveId = id.lowercase()
        }
        pendingId = id
        client.connectLive(id)
        watchPending(id)
    }

    fun lastLiveText(a: TikTokAccount): String {
        val handle = "@" + a.uniqueId
        val start = store.lastSession(a.id)?.start ?: return handle
        return when {
            Clock.isToday(start) -> "$handle · hôm nay ${timeText(start)}"
            Clock.isYesterday(start) -> "$handle · hôm qua ${timeText(start)}"
            else -> "$handle · ${shortDate(start)}"
        }
    }

    fun isLive(a: TikTokAccount): Boolean = client.live(a.uniqueId) != null ||
        (!client.serverSupportsSync && client.liveState != "idle" && a.uniqueId.equals(client.liveUsername, ignoreCase = true))

    Column(Modifier.fillMaxWidth().height(sheetHeight(60.dp))) {
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(start = Metrics.GUTTER.dp, end = Metrics.GUTTER.dp, bottom = 12.dp)) {
            Box(Modifier.padding(top = 7.dp)) { SheetTitle("Live mới", "Chọn ID đã lưu hoặc nhập ID TikTok Live mới", 23f) }
            if (client.lives.isNotEmpty()) {
                Column(Modifier.padding(top = 17.8.dp), verticalArrangement = Arrangement.spacedBy(9.dp)) {
                    Row {
                        T("Đang theo dõi", 15f, BV.BOLD, modifier = Modifier.weight(1f))
                        T("${client.lives.size} live", 12.5f, BV.MEDIUM, C.muted)
                    }
                    for (live in client.lives) {
                        Row(
                            Modifier.fillMaxWidth().height(58.dp).cardStyle(18f)
                                .tap {
                                    if (live.sessionId.isNotEmpty()) {
                                        ui.dismissSheet()
                                        ui.push(Route.Session(live.sessionId))
                                    }
                                }.padding(horizontal = 14.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(10.dp),
                        ) {
                            Box(Modifier.size(8.dp).clip(CircleShape).background(if (live.state == "connected") C.green else C.orange))
                            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                                T("@" + live.username, 14.5f, BV.BOLD, maxLines = 1)
                                T(if (live.state == "connected") "${live.viewers} người xem" else "Đang nối lại...", 12.5f, BV.MEDIUM, C.muted, maxLines = 1)
                            }
                            Box(Modifier.width(64.dp).height(34.dp).capsule(C.card, C.line).tap { client.disconnectLive(live.username) },
                                contentAlignment = Alignment.Center) { T("Dừng", 13.5f, BV.BOLD, C.red) }
                        }
                    }
                }
            }
            if (saved.isNotEmpty()) {
                Row(Modifier.padding(top = 17.8.dp)) {
                    T("ID đã lưu", 15f, BV.BOLD, modifier = Modifier.weight(1f))
                    T("Bấm để bắt đầu ngay · giữ để xoá", 12.5f, BV.MEDIUM, C.muted)
                }
                Column(Modifier.padding(top = 15.dp), verticalArrangement = Arrangement.spacedBy(11.dp)) {
                    for (a in saved) {
                        val active = a.id == store.activeAccountId
                        val following = client.live(a.uniqueId)
                        Row(
                            Modifier.fillMaxWidth().heightIn(min = 69.3.dp)
                                .cardStyle(22f, if (active) C.peachRow else C.card, if (active) C.peachLine else C.line)
                                .combinedClickable(
                                    onClick = {
                                        if (following != null) {
                                            if (following.sessionId.isNotEmpty()) {
                                                ui.dismissSheet()
                                                ui.push(Route.Session(following.sessionId))
                                            }
                                        } else start(a)
                                    },
                                    onLongClick = {
                                        if (!isLive(a)) {
                                            ui.confirm = ConfirmItem("Xoá ID này?", "@${a.uniqueId} sẽ bị xoá khỏi danh sách ID đã lưu.", "Xoá") {
                                                store.removeAccount(a.id)
                                            }
                                        }
                                    },
                                )
                                .padding(horizontal = 15.dp, vertical = 11.6.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Avatar(a.initials, a.id, 44f, 15f)
                            Column(Modifier.weight(1f).padding(start = 12.dp, end = 8.dp), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                                T(a.displayName, 16.2f, BV.BOLD, maxLines = 1)
                                T(lastLiveText(a), 13f, BV.MEDIUM, C.muted, maxLines = 2)
                            }
                            OnAccent(active) {
                                Box(Modifier.width(88.dp).height(36.dp).capsule(if (active) C.orange else C.card, if (active) null else C.line),
                                    contentAlignment = Alignment.Center) {
                                    T(if (following == null) "Bắt đầu" else "Đang live", 15f, BV.BOLD, maxLines = 1)
                                }
                            }
                        }
                    }
                }
                Row(Modifier.padding(top = 16.4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    HairLine(Modifier.weight(1f))
                    T("hoặc nhập ID mới", 12.5f, BV.SEMIBOLD, C.muted)
                    HairLine(Modifier.weight(1f))
                }
            }
            TA(annotated("ID TikTok Live " to spanStyle(13f, BV.SEMIBOLD, C.muted), "*" to spanStyle(14f, BV.BOLD, C.red)),
                Modifier.padding(top = if (saved.isEmpty()) 20.dp else 16.8.dp))
            Row(
                Modifier.padding(top = 6.4.dp).fillMaxWidth().height(51.5.dp).cardStyle(22f, C.field).padding(start = 17.dp, end = 9.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                T("@", 16f, BV.BOLD, C.muted)
                PlainField(input, { input = it }, "ten.tai.khoan", 16f, BV.SEMIBOLD, Modifier.weight(1f), capitalize = false)
                Box(Modifier.width(54.dp).height(36.dp).capsule(C.grayBadge).tap {
                    clipboard.getText()?.text?.let { t -> input = LiveId.parse(t) ?: t.trim() }
                }, contentAlignment = Alignment.Center) { T("Dán", 13.5f, BV.BOLD) }
            }
            if (inputInvalid) {
                T("Không đọc được tên tài khoản. Hãy nhập tên dạng ten.tai.khoan.", 12.5f, BV.MEDIUM, C.red, Modifier.padding(top = 5.6.dp))
            } else {
                T("Nhập tên tài khoản đang live hoặc dán link phiên live.", 12.5f, BV.MEDIUM, C.muted, Modifier.padding(top = 5.6.dp))
            }
            errorMessage?.let { T(it, 12.5f, BV.MEDIUM, C.red, Modifier.padding(top = 4.dp)) }
            Row(Modifier.padding(top = 16.5.dp, start = 2.dp, end = 2.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    T("Lưu ID này cho lần sau", 15f, BV.BOLD)
                    T("Lần sau chỉ cần bấm vào ID đã lưu", 13f, BV.MEDIUM, C.muted)
                }
                Toggle(rememberId) { rememberId = it }
            }
        }
        HairLine()
        Box(Modifier.padding(start = Metrics.GUTTER.dp, end = Metrics.GUTTER.dp, top = 13.dp)) {
            PrimaryButton(
                if (isConnecting) "Đang kết nối..." else if (client.lives.isEmpty()) "Bắt đầu live" else "Theo dõi thêm live này",
                fontSize = 18f, height = 55.5f, enabled = canStart,
            ) {
                if (liveId != null) startNew(liveId) else highlighted?.let { start(it) }
            }
        }
    }
}

// MARK: - Chi tiết phiên live

@Composable
fun SessionDetailScreen(sessionId: String) {
    val app = LocalApp.current
    val store = app.store
    val client = app.client
    val ui = LocalAppUI.current
    val scope = rememberCoroutineScope()
    var tab by remember { mutableIntStateOf(0) } // 0 tất cả, 1 chốt đơn, 2 khách mới
    var searching by remember { mutableStateOf(false) }
    var search by remember { mutableStateOf("") }
    var pending by remember { mutableIntStateOf(0) }
    /** Bình luận cũ vừa tải từ server, chỉ giữ khi đang mở màn này. */
    var older by remember { mutableStateOf(listOf<LiveComment>()) }
    var loadingOlder by remember { mutableStateOf(false) }
    var olderExhausted by remember { mutableStateOf(false) }
    val listState = rememberLazyListState()

    val session = store.sessions.firstOrNull { it.id == sessionId }
    val all = remember(store.comments, store.customers, older) { store.sessionComments(sessionId, older) }
    val map = remember(store.customers) { store.customers.associateBy { it.id } }
    fun owner(c: LiveComment): Customer? = map[com.chotlive.app.data.Store.key(c.uniqueId, c.userId)]
    fun isNew(cu: Customer?): Boolean {
        if (cu == null || session == null || cu.items.isEmpty()) return false
        return Clock.day(cu.firstTs) == Clock.day(session.start)
    }
    val closingCount = remember(all, store.keywords) { all.count { store.isClosingComment(it) } }
    val newCustomers = remember(all, map) { all.mapNotNull { c -> owner(c)?.takeIf { isNew(it) }?.id }.toSet().size }
    val shown = remember(all, tab, search, map, store.keywords) {
        var list = all
        when (tab) {
            1 -> list = list.filter { store.isClosingComment(it) }
            2 -> list = list.filter { isNew(owner(it)) }
        }
        val q = search.trim().lowercase()
        if (q.isNotEmpty()) list = list.filter {
            it.nickname.lowercase().contains(q) || it.uniqueId.lowercase().contains(q) || it.text.lowercase().contains(q)
        }
        list
    }
    // Mới nhất nằm trên cùng: còn thấy phần đầu danh sách nghĩa là đang xem bình luận mới.
    val atTop by remember { derivedStateOf { listState.firstVisibleItemIndex == 0 } }

    suspend fun loadOlder() {
        if (loadingOlder) return
        loadingOlder = true
        val page = client.fetchOlderComments(sessionId, CommentCursor.oldest(all))
        loadingOlder = false
        if (page == null) {
            ui.notify("Không tải được bình luận cũ. Kiểm tra kết nối rồi thử lại.")
            return
        }
        older = older + page.comments
        olderExhausted = !page.hasMore
    }

    // Phiên cũ đã hết bình luận trên máy: tự tải luôn, khỏi thấy màn trống.
    LaunchedEffect(client.serverSupportsSync) {
        if (client.serverSupportsSync && all.isEmpty() && (session?.commentCount ?: 0) > 0) loadOlder()
    }
    var lastCount by remember { mutableIntStateOf(session?.commentCount ?: 0) }
    LaunchedEffect(session?.commentCount) {
        val value = session?.commentCount ?: 0
        val delta = value - lastCount
        lastCount = value
        // Đang cuộn xuống đọc thì danh sách giữ nguyên chỗ, chỉ báo số bình luận mới phía trên.
        if (delta > 0 && !atTop) pending += delta
    }
    LaunchedEffect(atTop) { if (atTop) pending = 0 }

    val subtitle = session?.let { s ->
        val end = s.end
        if (end != null) "${timeText(s.start)} – ${timeText(end)} · ${s.duration}" else "Từ ${timeText(s.start)} · ${s.duration}"
    } ?: ""

    SubPage(
        session?.title ?: "Phiên live", subtitle,
        accessory = if (session?.isLive == true) ({
            Row(Modifier.height(24.dp).capsule(C.redSoft).padding(horizontal = 9.dp),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                Box(Modifier.size(7.dp).clip(CircleShape).background(C.live.copy(alpha = 0.4f)))
                T("Live", 13f, BV.BOLD, C.red)
            }
        }) else null,
        headerBottom = 16f,
        trailing = {
            CircleButton(IconName.SEARCH) {
                searching = !searching
                if (!searching) search = ""
            }
        },
    ) {
        Box(Modifier.weight(1f)) {
            LazyColumn(
                Modifier.fillMaxSize(),
                state = listState,
                contentPadding = PaddingValues(start = Metrics.GUTTER.dp, end = Metrics.GUTTER.dp, bottom = 56.dp),
                verticalArrangement = Arrangement.spacedBy(9.dp),
            ) {
                item(key = "header") {
                    Column(verticalArrangement = Arrangement.spacedBy(13.5.dp), modifier = Modifier.padding(bottom = 4.5.dp)) {
                        if (searching) SearchField(search, { search = it }, Modifier.fillMaxWidth())
                        if (session != null) SessionSummary(session)
                        Row(Modifier.bleed().horizontalScroll(rememberScrollState()).padding(horizontal = Metrics.GUTTER.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            TabChip("Tất cả", session?.commentCount ?: all.size, tab == 0) { tab = 0 }
                            TabChip("Chốt đơn", closingCount, tab == 1) { tab = 1 }
                            TabChip("Khách mới", newCustomers, tab == 2) { tab = 2 }
                        }
                        if (shown.isEmpty()) {
                            val empty = if (loadingOlder) "Đang tải bình luận..." else if (session?.isLive == true) "Đang chờ bình luận..." else "Không có bình luận phù hợp."
                            EmptyNote(empty, 24f)
                        }
                    }
                }
                items(shown, key = { it.id }) { c ->
                    val cu = owner(c)
                    CommentRow(c, store.isClosingComment(c), cu, isNew(cu)) {
                        scope.launch { ui.notify(app.printComment(c)) }
                    }
                }
                // Bình luận cũ nằm dưới cùng nên nút tải phần cũ cũng ở dưới.
                item(key = "older") {
                    val total = session?.commentCount
                    if (total != null && total > all.size) {
                        Column(verticalArrangement = Arrangement.spacedBy(8.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                            val note = when {
                                olderExhausted -> "Đã hiện hết ${all.size} bình luận server còn lưu, trên tổng $total bình luận của phiên."
                                !client.serverSupportsSync -> "Đang hiện ${all.size}/$total bình luận. Cần kết nối server để xem phần cũ hơn."
                                search.isNotEmpty() || tab != 0 -> "Đã tải ${all.size}/$total bình luận. Chỉ lọc và tìm trong phần đã tải."
                                else -> "Đang hiện ${all.size}/$total bình luận."
                            }
                            T(note, 12.5f, BV.MEDIUM, C.muted, align = TextAlign.Center)
                            if (client.serverSupportsSync && !olderExhausted) {
                                Row(Modifier.fillMaxWidth().height(44.dp).capsule(C.card, C.line).tap(!loadingOlder) { scope.launch { loadOlder() } },
                                    horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally),
                                    verticalAlignment = Alignment.CenterVertically) {
                                    if (loadingOlder) CircularProgressIndicator(Modifier.size(16.dp), C.muted, 2.dp)
                                    T(if (loadingOlder) "Đang tải..." else "Xem bình luận cũ hơn", 13.5f, BV.BOLD)
                                }
                            }
                        }
                    }
                }
            }
            if (pending > 0) {
                Row(
                    Modifier.align(Alignment.BottomCenter).padding(bottom = 12.dp).shadow(10.dp, Capsule).height(40.dp)
                        .capsule(C.ink).tap {
                            pending = 0
                            scope.launch { listState.animateScrollToItem(0) }
                        }.padding(horizontal = 18.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Icon(IconName.ARROW_DOWN, 15f, 2.4f, C.bg, Modifier.rotate(180f))
                    T("$pending bình luận mới", 13.5f, BV.BOLD, C.bg)
                }
            }
        }
    }
}

@Composable
private fun SessionSummary(s: LiveSession) {
    val app = LocalApp.current
    val client = app.client
    val store = app.store
    val ui = LocalAppUI.current
    Column(Modifier.fillMaxWidth().cardStyle(24f).padding(start = 6.dp, end = 6.dp, top = 12.dp, bottom = 11.dp),
        verticalArrangement = Arrangement.spacedBy(9.dp)) {
        Row(Modifier.padding(start = 13.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (s.isLive) Box(Modifier.size(8.dp).clip(CircleShape).background(C.live))
            T(if (s.tiktok.isEmpty()) "Tài khoản TikTok" else "@${s.tiktok}", 13.5f, BV.MEDIUM, C.muted, maxLines = 1)
            if (s.isLive && client.live(s.tiktok)?.state == "reconnecting") T("· đang nối lại", 12.5f, BV.MEDIUM, C.accent, maxLines = 1)
            Box(Modifier.weight(1f))
            if (s.isLive && client.live(s.tiktok) != null) {
                Box(Modifier.padding(end = 13.dp).plainTap {
                    val tiktok = s.tiktok
                    ui.confirm = ConfirmItem("Dừng theo dõi live này?", "@$tiktok sẽ không được ghi bình luận nữa. Các live khác vẫn chạy.", "Dừng") {
                        client.disconnectLive(tiktok)
                    }
                }) { T("Dừng", 13f, BV.BOLD, C.red) }
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            SummaryStat("${s.commentCount}", "bình luận", Modifier.weight(1f))
            VLine(44f)
            SummaryStat("${store.sessionCustomerCount(s.id)}", "khách", Modifier.weight(1f))
            VLine(44f)
            SummaryStat("${store.sessionOrderCount(s.id)}", "đơn", Modifier.weight(1f))
        }
    }
}

@Composable
private fun SummaryStat(value: String, label: String, modifier: Modifier) {
    Column(modifier, horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(2.dp)) {
        T(value, 23f, BV.HEAVY, C.ink, track = -0.4f, maxLines = 1)
        T(label, 12.5f, BV.MEDIUM, C.muted, maxLines = 1)
    }
}

@Composable
private fun TabChip(title: String, count: Int, selected: Boolean, onClick: () -> Unit) {
    OnAccent(selected) {
        Row(
            Modifier.height(38.dp).capsule(if (selected) C.orange else C.card, if (selected) null else C.line).tap(onClick = onClick)
                .padding(horizontal = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            T(title, 14.4f, BV.BOLD)
            T("$count", 13f, if (selected) BV.BOLD else BV.MEDIUM, if (selected) C.ink else C.muted)
        }
    }
}

@Composable
fun CommentRow(c: LiveComment, closing: Boolean, customer: Customer?, isNew: Boolean, onPrint: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().cardStyle(20f, if (closing) C.peachRow else C.card, if (closing) C.peachLine else C.line)
            .padding(horizontal = 13.dp, vertical = 9.5.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(9.7.dp),
    ) {
        Avatar(com.chotlive.app.model.initialsOf(c.nickname), c.uniqueId, 34f, 12.5f)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(if (closing) 3.4.dp else 2.dp)) {
            Row(Modifier.height(20.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                // Tên được ưu tiên chỗ (như layoutPriority bên iPhone); @tiktok chỉ lấy phần còn thừa.
                // Không đặt nhiều ô weight ngang hàng: Row chia đều nên tên chỉ còn một phần ba hàng.
                Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                    val hasBadge = customer?.isBigSpender == true || isNew
                    Box(if (hasBadge) Modifier.weight(1f, fill = false) else Modifier) {
                        T(c.nickname, 13.4f, BV.BOLD, maxLines = 1)
                    }
                    when {
                        customer?.isBigSpender == true -> Badge("Mua nhiều", C.accentDeep, C.peachCode, 11f, 20f, 6f)
                        isNew -> Badge("Mới", C.green, C.greenSoft, 11f, 20f, 6f)
                        else -> Box(Modifier.weight(1f, fill = false)) { T("@" + c.uniqueId, 11f, BV.MEDIUM, C.muted, maxLines = 1) }
                    }
                }
                T(timeText(c.ts), 11f, BV.MEDIUM, C.muted, maxLines = 1)
                if (closing) {
                    OnAccent {
                        Box(Modifier.size(18.dp).clip(CircleShape).background(C.orange), contentAlignment = Alignment.Center) {
                            Icon(IconName.CHECK, 10f, 3f)
                        }
                    }
                }
            }
            CommentText(c.text, 14f, closing)
        }
        Box(Modifier.size(34.dp).clip(CircleShape).background(C.card).border(1.dp, C.line, CircleShape).tap(onClick = onPrint),
            contentAlignment = Alignment.Center) { Icon(IconName.PRINTER, 15f, 2.2f) }
    }
}

// MARK: - Bình luận chốt đơn của một đơn

@Composable
fun OrderCommentsScreen(orderId: String) {
    val app = LocalApp.current
    val store = app.store
    val ui = LocalAppUI.current
    val order = store.order(orderId)
    SubPage("Bình luận chốt đơn", order?.let { "Đơn của ${it.customer.nickname} · ${timeText(it.lastTs)}" }, headerBottom = 20f) {
        if (order == null) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { T("Đơn không còn tồn tại", 14f, BV.MEDIUM, C.muted) }
        } else {
            data class Group(val id: String, val text: String, val ts: Long, val items: List<OrderItem>)
            // Đơn tạo tay không có bình luận.
            val groups = order.items.filter { it.comment.isNotEmpty() }.groupBy { it.commentId ?: it.id }.map { (key, items) ->
                val source = store.comments.firstOrNull { it.id == key }
                Group(key, source?.text ?: items[0].comment, source?.ts ?: items[0].ts, items)
            }.sortedBy { it.ts }
            Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(start = Metrics.GUTTER.dp, end = Metrics.GUTTER.dp, bottom = 16.dp)) {
                Column(Modifier.fillMaxWidth().cardStyle(24f).padding(start = 19.dp, end = 19.dp, top = 16.dp, bottom = 17.2.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(11.dp)) {
                        Avatar(order.customer.initials, order.customer.id, 48f, 17f)
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(0.5.dp)) {
                            T(order.customer.nickname, 17.5f, BV.BOLD, shrink = true, minScale = 0.85f)
                            T("@" + order.customer.uniqueId, 13.5f, BV.MEDIUM, C.muted, maxLines = 1)
                        }
                        Badge("${groups.size} bình luận", C.accentDeep, C.peachTint, 12.5f, 28f, 10f)
                    }
                    HairLine(Modifier.padding(top = 14.6.dp))
                    Row(Modifier.padding(top = 13.5.dp)) {
                        val s = store.sessions.firstOrNull { it.id == order.items.firstOrNull()?.sessionId }
                        if (s != null) {
                            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.6.dp)) {
                                T("Phiên live", 12.5f, BV.SEMIBOLD, C.muted)
                                T("${s.title} · ${timeText(s.start)}", 15f, BV.BOLD, shrink = true)
                            }
                        } else Box(Modifier.weight(1f))
                        Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(1.6.dp)) {
                            T("Giá trị đơn", 12.5f, BV.SEMIBOLD, C.muted)
                            T("${order.productCount} sản phẩm · ${money(order.total)}", 15f, BV.BOLD, maxLines = 1)
                        }
                    }
                }
                Row(Modifier.padding(start = 4.dp, end = 4.dp, top = 15.dp)) {
                    T("Các bình luận đã chốt", 16.2f, BV.BOLD, modifier = Modifier.weight(1f), maxLines = 1)
                    T("Theo thời gian", 13.2f, BV.MEDIUM, C.muted)
                }
                Column(Modifier.padding(top = 17.dp), verticalArrangement = Arrangement.spacedBy(17.dp)) {
                    for (g in groups) {
                        Row {
                            T(timeText(g.ts), 15.5f, BV.HEAVY, C.ink, Modifier.width(60.dp).padding(top = 16.dp), track = -0.2f)
                            Column(Modifier.weight(1f).cardStyle(22f).padding(16.5.dp, 15.dp, 16.5.dp, 15.dp),
                                verticalArrangement = Arrangement.spacedBy(13.dp)) {
                                CommentText(g.text, 16f)
                                Column(verticalArrangement = Arrangement.spacedBy(7.dp)) {
                                    for (it in g.items) {
                                        Row(Modifier.fillMaxWidth().height(33.5.dp).capsule(C.field).padding(horizontal = 14.dp),
                                            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                            Icon(IconName.ARROW_RIGHT, 14f, 2.3f, C.accent)
                                            T(it.productLabel, 13.1f, BV.BOLD, maxLines = 1)
                                            T("${it.qty} × ${money(it.price)}", 13f, BV.MEDIUM, C.muted, Modifier.weight(1f), shrink = true)
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            FooterBar { PrimaryButton("Xem chi tiết đơn", fontSize = 18f, height = 55.5f) { ui.push(Route.Order(order.id)) } }
        }
    }
}
