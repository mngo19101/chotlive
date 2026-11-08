@file:OptIn(ExperimentalFoundationApi::class)

package com.chotlive.app.ui

import android.bluetooth.BluetoothAdapter
import android.content.Intent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.chotlive.app.BuildConfig
import com.chotlive.app.data.AccentChoice
import com.chotlive.app.data.AccountAccess
import com.chotlive.app.data.AppearanceMode
import com.chotlive.app.data.AuthStorage
import com.chotlive.app.model.LiveComment
import com.chotlive.app.model.initialsOf
import com.chotlive.app.print.NearbyDevice
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

// MARK: - Tôi

@Composable
fun SettingsScreen() {
    val app = LocalApp.current
    val client = app.client
    val printer = app.printer
    val settings = app.settings
    val ui = LocalAppUI.current
    val currentKey = AuthStorage.accountKey(client.baseURL, client.username)

    Column(
        Modifier.fillMaxSize().background(C.bg).verticalScroll(rememberScrollState())
            .padding(start = Metrics.GUTTER.dp, end = Metrics.GUTTER.dp, top = 2.dp, bottom = 16.dp)
    ) {
        Box(Modifier.padding(bottom = 15.dp)) { PageHeader("Tài khoản và cài đặt", "Tôi") }
        SectionLabel("Tài khoản")
        client.access?.takeIf { it.status != "admin" }?.let { Box(Modifier.padding(bottom = 10.dp)) { AccessCard(it) } }
        Column(Modifier.fillMaxWidth().padding(bottom = 15.dp).cardStyle(22f)) {
            for (a in client.savedAccounts) {
                val active = a.key == currentKey
                Row(
                    Modifier.fillMaxWidth().height(68.5.dp).combinedClickable(
                        onClick = {
                            if (active) return@combinedClickable
                            if (client.liveState in listOf("connected", "connecting", "reconnecting")) {
                                ui.confirm = ConfirmItem("Đổi tài khoản?",
                                    "Server vẫn ghi tiếp live của tài khoản này. Máy sẽ chuyển sang dữ liệu của tài khoản kia.", "Đổi tài khoản") {
                                    client.switchAccount(a.key)
                                }
                            } else client.switchAccount(a.key)
                        },
                        onLongClick = {
                            if (!active) ui.confirm = ConfirmItem("Xoá tài khoản ${a.user}?", "Tài khoản này sẽ bị đăng xuất khỏi máy.", "Xoá tài khoản") {
                                client.forgetSavedAccount(a.key)
                            }
                        },
                    ).padding(horizontal = 17.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Avatar(initialsOf(a.user), a.key)
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                        T(a.user, 15f, BV.BOLD, maxLines = 1)
                        T(a.server.removePrefix("https://").removePrefix("http://"), 12f, BV.MEDIUM, C.muted, maxLines = 1)
                    }
                    if (active) T("Đang dùng", 12f, BV.SEMIBOLD, C.green, maxLines = 1)
                    CheckDot(active)
                }
                HairLine()
            }
            Row(
                Modifier.fillMaxWidth().height(60.dp).tap { ui.present { AddAppAccountSheet(client.baseURL) } }.padding(horizontal = 17.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                val dashColor = C.peachLine
                Box(Modifier.size(45.dp), contentAlignment = Alignment.Center) {
                    androidx.compose.foundation.Canvas(Modifier.fillMaxSize()) {
                        drawCircle(dashColor, style = Stroke(1.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(3.dp.toPx(), 3.dp.toPx()))))
                    }
                    Icon(IconName.PLUS, 20f, color = C.accent)
                }
                T("Thêm tài khoản", 15f, BV.BOLD, C.accent)
            }
        }

        SectionLabel("Cài đặt")
        Column(Modifier.fillMaxWidth().padding(bottom = 15.dp).cardStyle(22f)) {
            SettingRow(IconName.PRINTER, "Máy in", if (printer.isConnected) "Đã kết nối" else "Chưa kết nối",
                if (printer.isConnected) C.green else C.muted) { ui.push(Route.Printer) }
            HairLine()
            SettingRow(IconName.PALETTE, "Giao diện", settings.appearanceSummary, C.accent, isNew = !settings.appearanceSeen) { ui.push(Route.Appearance) }
            HairLine()
            SettingRow(IconName.TAG, "Từ khoá chốt đơn") { ui.push(Route.Keywords) }
            HairLine()
            SettingRow(IconName.BELL, "Thông báo") { ui.push(Route.Notifications) }
            HairLine()
            SettingRow(IconName.HELP, "Hỗ trợ", if (client.supportUnread > 0) "${client.supportUnread} tin mới" else null, C.red) { ui.push(Route.Help) }
        }

        Row(
            Modifier.fillMaxWidth().height(50.dp).capsule(C.card, C.line).tap {
                val count = client.savedAccounts.size
                val scope = if (count > 1) "Cả $count tài khoản trên máy sẽ được đăng xuất. " else ""
                ui.confirm = ConfirmItem("Đăng xuất?", scope + "Dữ liệu đã lưu trên máy vẫn được giữ lại.", "Đăng xuất") { client.logoutAll() }
            },
            horizontalArrangement = Arrangement.spacedBy(10.dp, Alignment.CenterHorizontally),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(IconName.LOGOUT, 17f, color = C.red)
            T("Đăng xuất", 15f, BV.BOLD, C.red)
        }
        Box(Modifier.fillMaxWidth().padding(top = 15.dp), contentAlignment = Alignment.Center) {
            T("Phiên bản ${BuildConfig.VERSION_NAME}", 12f, BV.MEDIUM, C.muted)
        }
    }
}

@Composable
private fun SettingRow(
    icon: IconName, title: String, trailing: String? = null, trailingColor: Color = C.muted, isNew: Boolean = false, onClick: () -> Unit,
) {
    Row(
        Modifier.fillMaxWidth().height(56.dp).tap(onClick = onClick).padding(horizontal = 17.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Box(Modifier.size(32.dp).clip(CircleShape).background(C.peachSoft), contentAlignment = Alignment.Center) {
            Icon(icon, 16f, 2.3f, C.accent)
        }
        T(title, 15f, BV.SEMIBOLD, modifier = Modifier.weight(1f), maxLines = 1)
        if (isNew) {
            OnAccent {
                Box(Modifier.height(18.dp).capsule(C.orange).padding(horizontal = 7.dp), contentAlignment = Alignment.Center) {
                    T("MỚI", 10f, BV.HEAVY)
                }
            }
        }
        if (trailing != null) T(trailing, 12f, BV.SEMIBOLD, trailingColor, maxLines = 1)
        Icon(IconName.CHEVRON_RIGHT, 16f, 2.4f, C.muted)
    }
}

/** Dùng thử, gói hoặc hết hạn của tài khoản đang dùng. Lúc dùng thử thì đếm ngược từng giây. */
@Composable
fun AccessCard(access: AccountAccess) {
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    if (access.status == "trial") {
        LaunchedEffect(access) {
            while (true) {
                now = System.currentTimeMillis()
                delay(1000)
            }
        }
    }
    when {
        access.status == "trial" -> AccessBox("Dùng thử miễn phí còn", AccountAccess.countdownText(access.endsAt, now), C.accent, C.peachSoft, C.peachLine)
        access.canFollowLive -> AccessBox("Gói đang dùng", "Còn ${AccountAccess.remainingText(access.endsAt, now)}", C.accent, C.peachSoft, C.peachLine)
        else -> AccessBox(if (access.code == "PLAN_EXPIRED") "Gói đã hết hạn" else "Đã hết dùng thử",
            access.message.ifEmpty { "Vui lòng mua gói để tiếp tục theo dõi live." }, C.red, C.redSoft, C.red.copy(alpha = 0.25f), wraps = true)
    }
}

@Composable
private fun AccessBox(title: String, value: String, color: Color, background: Color, border: Color, wraps: Boolean = false) {
    Row(
        Modifier.fillMaxWidth().clip(rounded(18f)).background(background).border(1.dp, border, rounded(18f)).padding(horizontal = 15.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Box(Modifier.size(32.dp).clip(CircleShape).background(C.card), contentAlignment = Alignment.Center) { Icon(IconName.CALENDAR, 16f, 2.3f, color) }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            T(title, 12.5f, BV.SEMIBOLD, color.copy(alpha = 0.85f), maxLines = 1)
            if (wraps) T(value, 14f, BV.BOLD, color) else T(value, 15f, BV.BOLD, color, shrink = true)
        }
    }
}

/** Thêm một tài khoản ChốtLive khác trên cùng máy. */
@Composable
fun AddAppAccountSheet(defaultServer: String) {
    val app = LocalApp.current
    val ui = LocalAppUI.current
    val scope = rememberCoroutineScope()
    var server by remember { mutableStateOf(builtInServer ?: defaultServer) }
    var user by remember { mutableStateOf("") }
    var pass by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val canSubmit = !busy && server.isNotBlank() && user.isNotEmpty() && pass.isNotEmpty()

    Column(Modifier.fillMaxWidth().padding(horizontal = Metrics.GUTTER.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Box(Modifier.padding(top = 6.dp)) { SheetTitle("Thêm tài khoản", "Đăng nhập một tài khoản ChốtLive khác") }
        if (builtInServer == null) {
            LabeledField("Địa chỉ máy chủ", "https://ten-mien-cua-ban.vn", server, { server = it }, KeyboardType.Uri, capitalize = false)
        }
        LabeledField("Tên tài khoản", "Tên tài khoản", user, { user = it }, capitalize = false)
        LabeledField("Mật khẩu", "Mật khẩu", pass, { pass = it }, password = true)
        error?.let { T(it, 13f, BV.MEDIUM, C.red) }
        PrimaryButton(if (busy) "Đang đăng nhập..." else "Đăng nhập", enabled = canSubmit) {
            busy = true
            error = null
            scope.launch {
                try {
                    app.client.login(server, user, pass)
                    ui.dismissSheet()
                } catch (e: Exception) {
                    error = e.message
                }
                busy = false
            }
        }
    }
}

// MARK: - Máy in

@Composable
fun PrinterScreen() {
    val app = LocalApp.current
    val printer = app.printer
    val settings = app.settings
    val ui = LocalAppUI.current
    val scope = rememberCoroutineScope()
    var shopName by remember { mutableStateOf(settings.shopName) }

    val enableBt = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) {
        printer.refreshStatus()
        if (printer.bluetoothEnabled && printer.hasPermissions()) printer.startScan()
    }
    val permissions = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        printer.refreshStatus()
        if (!printer.hasPermissions()) {
            ui.notify("Cần cho phép quyền “Thiết bị lân cận” (Bluetooth) để tìm và nối máy in. Bạn có thể bật trong Cài đặt › Ứng dụng › ChốtLive › Quyền.")
        } else if (!printer.bluetoothEnabled) {
            enableBt.launch(Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE))
        } else {
            printer.startScan()
        }
    }

    fun scan() {
        when {
            !printer.hasPermissions() -> permissions.launch(printer.requiredPermissions())
            !printer.bluetoothEnabled -> try {
                enableBt.launch(Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE))
            } catch (e: SecurityException) {
                permissions.launch(printer.requiredPermissions())
            }
            else -> printer.startScan()
        }
    }

    fun printTest() {
        val c = LiveComment(id = "test", uniqueId = "tai_khoan_mau", userId = "123456789", nickname = "Khách thử",
            text = "59", ts = System.currentTimeMillis(), price = 59000)
        scope.launch {
            val error = printer.sendAndWait(app.tickets.ticketBytes(c))
            ui.notify(error ?: "Đã gửi xong tem thử. Nếu không ra giấy, kiểm tra giấy và xem đã chọn đúng máy in chưa.")
        }
    }

    LaunchedEffect(Unit) { printer.refreshStatus() }

    SubPage("Máy in") {
        Column(
            Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(start = Metrics.GUTTER.dp, end = Metrics.GUTTER.dp, bottom = 16.dp),
            verticalArrangement = Arrangement.spacedBy(Metrics.GAP.dp),
        ) {
            Column(Modifier.fillMaxWidth().cardStyle(20f).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                T("Trạng thái", 15f, BV.BOLD)
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (printer.isConnecting) CircularProgressIndicator(Modifier.size(14.dp), C.muted, 2.dp)
                    T(printer.statusText, 13f, BV.MEDIUM, C.muted)
                }
                printer.connectedName?.let { n ->
                    T("Đang dùng: $n", 14f, BV.SEMIBOLD, C.green)
                }
                if (printer.hasPrinter) {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlineButton("In thử", Modifier.weight(1f), IconName.PRINTER, filled = true) { printTest() }
                        OutlineButton("Ngắt kết nối", Modifier.weight(1f), color = C.red) { printer.disconnect() }
                    }
                }
            }
            Column(Modifier.fillMaxWidth().cardStyle(20f).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                T("Máy in Bluetooth", 15f, BV.BOLD)
                OutlineButton(if (printer.isScanning) "Đang tìm..." else "Tìm máy in", Modifier.fillMaxWidth(), IconName.SEARCH,
                    filled = true, enabled = !printer.isScanning) { scan() }
                val likely = printer.devices.filter { it.likelyPrinter }
                val others = printer.devices.filter { !it.likelyPrinter }
                for (d in likely) DeviceRow(d) { printer.connect(d) }
                if (others.isNotEmpty()) {
                    T("Thiết bị khác, có thể không phải máy in", 13f, BV.MEDIUM, C.muted)
                    for (d in others) DeviceRow(d) { printer.connect(d) }
                }
                if (printer.hasScanned && !printer.isScanning && likely.isEmpty()) {
                    T("Không thấy máy in? Kiểm tra máy đã bật và không nối với điện thoại khác. Máy in Bluetooth Classic nên ghép đôi trước trong Cài đặt › Bluetooth của điện thoại (mã PIN thường là 0000 hoặc 1234).",
                        13f, BV.MEDIUM, C.muted)
                }
            }
            Column(Modifier.fillMaxWidth().cardStyle(20f).padding(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                T("Tem", 15f, BV.BOLD)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Chip("80mm", settings.paperWidth == 576) { settings.updatePaperWidth(576) }
                    Chip("58mm", settings.paperWidth == 384) { settings.updatePaperWidth(384) }
                }
                LabeledField("Tên shop trên tem", "ChốtLive", shopName, {
                    shopName = it
                    settings.updateShopName(it)
                })
            }
        }
    }
}

@Composable
private fun DeviceRow(d: NearbyDevice, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().height(48.dp).tap(onClick = onClick), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
            T(d.name, 14f, BV.SEMIBOLD, maxLines = 1)
            val kind = listOfNotNull(
                if (d.ble) "Bluetooth LE" else null,
                if (d.classic) "Bluetooth Classic" else null,
                if (d.bonded) "đã ghép đôi" else null,
            ).joinToString(" · ")
            T(kind, 11.5f, BV.MEDIUM, C.muted, maxLines = 1)
        }
        Icon(IconName.CHEVRON_RIGHT, 16f, color = C.muted)
    }
}

// MARK: - Từ khoá chốt đơn

@Composable
fun KeywordsScreen() {
    val store = LocalApp.current.store
    var draft by remember { mutableStateOf("") }
    fun add() {
        val word = draft.trim().lowercase()
        draft = ""
        if (word.isEmpty() || store.keywords.contains(word)) return
        store.updateKeywords(store.keywords + word)
    }
    SubPage("Từ khoá chốt đơn") {
        Column(
            Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(start = Metrics.GUTTER.dp, end = Metrics.GUTTER.dp, bottom = 16.dp),
            verticalArrangement = Arrangement.spacedBy(Metrics.GAP.dp),
        ) {
            T("Bình luận chứa một trong các từ khoá này, hoặc chỉ ghi mã, được coi là bình luận chốt đơn.", 13f, BV.MEDIUM, C.muted)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.weight(1f).height(44.dp).cardStyle(14f).padding(horizontal = 15.dp), contentAlignment = Alignment.CenterStart) {
                    PlainField(draft, { draft = it }, "Thêm từ khoá", 15f, BV.SEMIBOLD, Modifier.fillMaxWidth(), capitalize = false, onDone = { add() })
                }
                CircleButton(IconName.PLUS) { add() }
            }
            Column(Modifier.fillMaxWidth().cardStyle(20f)) {
                store.keywords.forEachIndexed { i, k ->
                    if (i > 0) HairLine()
                    Row(Modifier.fillMaxWidth().height(52.dp).padding(horizontal = 17.dp), verticalAlignment = Alignment.CenterVertically) {
                        T(k, 15f, BV.SEMIBOLD, modifier = Modifier.weight(1f), maxLines = 1)
                        Box(Modifier.size(34.dp).clip(CircleShape).tap { store.updateKeywords(store.keywords.filter { it != k }) },
                            contentAlignment = Alignment.Center) { Icon(IconName.CLOSE, 16f, color = C.muted) }
                    }
                }
            }
        }
    }
}

// MARK: - Thông báo

@Composable
fun NotificationsScreen() {
    val settings = LocalApp.current.settings
    SubPage("Thông báo") {
        Column(Modifier.padding(horizontal = Metrics.GUTTER.dp), verticalArrangement = Arrangement.spacedBy(Metrics.GAP.dp)) {
            T("Báo khi có bình luận chốt đơn trong lúc app đang mở.", 13f, BV.MEDIUM, C.muted)
            Column(Modifier.fillMaxWidth().cardStyle(20f)) {
                Row(Modifier.fillMaxWidth().height(56.dp).padding(horizontal = 17.dp), verticalAlignment = Alignment.CenterVertically) {
                    T("Âm thanh", 15f, BV.SEMIBOLD, modifier = Modifier.weight(1f))
                    Toggle(settings.notifySound) { settings.updateNotifySound(it) }
                }
                HairLine()
                Row(Modifier.fillMaxWidth().height(56.dp).padding(horizontal = 17.dp), verticalAlignment = Alignment.CenterVertically) {
                    T("Rung", 15f, BV.SEMIBOLD, modifier = Modifier.weight(1f))
                    Toggle(settings.notifyHaptic) { settings.updateNotifyHaptic(it) }
                }
            }
        }
    }
}

// MARK: - Giao diện

@Composable
fun AppearanceScreen() {
    val settings = LocalApp.current.settings
    LaunchedEffect(Unit) { if (!settings.appearanceSeen) settings.markAppearanceSeen() }
    SubPage("Giao diện", settings.appearanceSummary) {
        Column(
            Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(start = Metrics.GUTTER.dp, end = Metrics.GUTTER.dp, bottom = 20.dp),
            verticalArrangement = Arrangement.spacedBy(22.dp),
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                T("Chế độ nền", 13f, BV.BOLD, C.muted)
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    for (m in AppearanceMode.entries) ModeTile(m, settings.mode == m, Modifier.weight(1f)) { settings.updateMode(m) }
                }
                T("“Theo máy” tự đổi Sáng/Tối theo cài đặt của điện thoại.", 11f, BV.MEDIUM, C.muted)
            }
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    T("Màu chủ đạo", 13f, BV.BOLD, C.muted, Modifier.weight(1f))
                    T("Nút, chữ nhấn và thanh tab", 11f, BV.SEMIBOLD, C.muted)
                }
                Column(Modifier.fillMaxWidth().cardStyle(20f).padding(horizontal = 8.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    for (row in AccentChoice.entries.chunked(3)) {
                        Row {
                            for (a in row) AccentSwatch(a, settings.accent == a, Modifier.weight(1f)) { settings.updateAccent(a) }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ModeTile(m: AppearanceMode, selected: Boolean, modifier: Modifier, onClick: () -> Unit) {
    val icon = when (m) {
        AppearanceMode.LIGHT -> IconName.SUN
        AppearanceMode.DARK -> IconName.MOON
        AppearanceMode.SYSTEM -> IconName.SMARTPHONE
    }
    Column(
        modifier.cardStyle(16f, C.card, if (selected) C.orangeDeep else C.line).then(
            if (selected) Modifier.border(2.dp, C.orangeDeep, rounded(16f)) else Modifier
        ).tap(onClick = onClick).padding(start = 8.dp, end = 8.dp, top = 8.dp, bottom = 10.dp),
        verticalArrangement = Arrangement.spacedBy(9.dp),
    ) {
        Row(Modifier.fillMaxWidth().height(76.dp).clip(rounded(10f)).border(1.dp, C.line, rounded(10f))) {
            MiniPage(dark = m == AppearanceMode.DARK, Modifier.weight(1f))
            MiniPage(dark = m != AppearanceMode.LIGHT, Modifier.weight(1f))
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Icon(icon, 15f, 2.2f, if (selected) C.accent else C.muted)
            T(m.label, 13f, BV.BOLD, modifier = Modifier.weight(1f), shrink = true)
            CheckDot(selected, 18f, 11f)
        }
    }
}

@Composable
private fun MiniPage(dark: Boolean, modifier: Modifier) {
    val bg = hex(if (dark) 0x0F1115 else 0xF6F7F9)
    val card = hex(if (dark) 0x1A1D23 else 0xFFFFFF)
    Column(modifier.fillMaxSize().background(bg).padding(horizontal = 6.dp, vertical = 9.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Box(Modifier.fillMaxWidth().height(14.dp).clip(rounded(4f)).background(card))
        Box(Modifier.fillMaxWidth().padding(end = 10.dp).height(7.dp).clip(rounded(4f)).background(C.orange))
        Box(Modifier.fillMaxWidth().height(14.dp).clip(rounded(4f)).background(card))
    }
}

@Composable
private fun AccentSwatch(a: AccentChoice, selected: Boolean, modifier: Modifier, onClick: () -> Unit) {
    val p = a.palette
    Column(modifier.plainTap(onClick = onClick).padding(vertical = 8.dp), horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(5.dp)) {
        Box(Modifier.size(48.dp).then(if (selected) Modifier.border(2.dp, hex(p.deep), CircleShape) else Modifier), contentAlignment = Alignment.Center) {
            Box(Modifier.size(36.dp).clip(CircleShape).background(hex(p.fill)), contentAlignment = Alignment.Center) {
                if (selected) OnAccent { Icon(IconName.CHECK, 18f, 3f) }
            }
        }
        T(a.label, 12f, BV.BOLD, shrink = true)
        T(if (a == AccentChoice.VANG) "Mặc định" else " ", 10f, BV.SEMIBOLD, C.muted)
    }
}
