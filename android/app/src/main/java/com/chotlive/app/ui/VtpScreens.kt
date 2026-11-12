package com.chotlive.app.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
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
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.chotlive.app.ChotLiveApp
import com.chotlive.app.model.Clock
import com.chotlive.app.model.Order
import com.chotlive.app.model.OrderStatus
import com.chotlive.app.model.Vtp
import com.chotlive.app.model.VtpTrack
import com.chotlive.app.model.dayMonth
import com.chotlive.app.model.money
import com.chotlive.app.model.timeText
import com.chotlive.app.net.VtpConnection
import com.chotlive.app.net.VtpCreateResult
import com.chotlive.app.net.refreshVtp
import com.chotlive.app.net.vtpCancel
import com.chotlive.app.net.vtpConnect
import com.chotlive.app.net.vtpConnected
import com.chotlive.app.net.vtpDisconnect
import com.chotlive.app.net.vtpPrintUrl
import com.chotlive.app.net.vtpResolve
import com.chotlive.app.net.vtpSenders
import com.chotlive.app.net.vtpSetSender
import kotlinx.coroutines.launch

// MARK: - In tem / theo dõi

object VtpActions {
    fun printLabels(codes: List<String>, app: ChotLiveApp, ui: AppUI) {
        if (codes.isEmpty()) return
        app.scope.launch {
            val (error, url) = app.client.vtpPrintUrl(codes, app.settings.vtpLabelSize)
            if (error != null) return@launch ui.notify(error)
            if (url == null) return@launch ui.notify("Viettel Post chưa trả về link in tem. Thử lại sau ít phút.")
            openUrl(app, url, ui)
        }
    }

    fun track(code: String, app: ChotLiveApp, ui: AppUI) = openUrl(app, VtpTrack.trackUrl(code), ui)

    fun copy(code: String, app: ChotLiveApp, ui: AppUI) {
        setClipboard(app, "Mã vận đơn", code)
        ui.notify("Đã sao chép mã vận đơn $code.")
    }

    fun setClipboard(context: Context, label: String, text: String) {
        (context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager)?.setPrimaryClip(ClipData.newPlainText(label, text))
    }

    fun clipboardText(context: Context): String? = try {
        (context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager)
            ?.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(context)?.toString()
    } catch (e: Exception) {
        null
    }

    private fun openUrl(context: Context, url: String, ui: AppUI) {
        try {
            context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (e: Exception) {
            ui.notify("Không mở được trình duyệt trên máy này.")
        }
    }
}

private const val NEED_TOKEN = "Chưa kết nối Viettel Post. Vào Tôi › ViettelPost để dán token."

@Composable
private fun CardBox(fill: Color = C.card, border: Color = C.line, spacing: Float = 10f, pad: Float = 16f, content: @Composable () -> Unit) {
    Column(Modifier.fillMaxWidth().cardStyle(20f, fill, border).padding(pad.dp), verticalArrangement = Arrangement.spacedBy(spacing.dp)) {
        content()
    }
}

// MARK: - Tôi › ViettelPost

/** Dán token một lần. Chưa kết nối thì app vẫn y như cũ (xuất Excel); kết nối rồi thì gửi vận đơn thẳng lên Viettel Post. */
@Composable
fun VtpConnectScreen() {
    val app = LocalApp.current
    val client = app.client
    val settings = app.settings
    val ui = LocalAppUI.current
    var token by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var showSteps by remember { mutableStateOf(false) }
    var senders by remember { mutableStateOf(listOf<VtpConnection.Sender>()) }
    var loadingSenders by remember { mutableStateOf(false) }
    var senderError by remember { mutableStateOf<String?>(null) }
    val conn = client.vtp

    fun loadSenders() {
        if (loadingSenders) return
        loadingSenders = true
        app.scope.launch {
            val (error, list) = client.vtpSenders()
            loadingSenders = false
            senderError = error
            if (error == null) senders = list
        }
    }

    fun choose(k: VtpConnection.Sender) {
        if (client.vtp?.sender?.id == k.id) return
        app.scope.launch { ui.notify(client.vtpSetSender(k.id)) }
    }

    fun connect() {
        val t = token.trim()
        if (t.isEmpty()) return
        busy = true
        app.scope.launch {
            val (error, list) = client.vtpConnect(t)
            busy = false
            if (error != null) return@launch ui.notify(error)
            token = ""
            senders = list
            // Chỉ có một điểm lấy hàng thì chọn luôn.
            if (client.vtp?.sender == null && list.size == 1) choose(list[0])
        }
    }

    LaunchedEffect(Unit) { if (client.vtp == null) client.refreshVtp() }
    LaunchedEffect(client.vtpConnected) { if (client.vtpConnected && senders.isEmpty()) loadSenders() }

    SubPage("Kết nối ViettelPost") {
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState())
                .padding(start = Metrics.GUTTER.dp, end = Metrics.GUTTER.dp, bottom = 16.dp),
            verticalArrangement = Arrangement.spacedBy(Metrics.GAP.dp),
        ) {
            if (client.vtpConnected && conn != null) {
                // Đã kết nối
                CardBox(spacing = 12f) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        T("Trạng thái", 15f, BV.BOLD, modifier = Modifier.weight(1f))
                        Badge("Đã kết nối", C.green, C.greenSoft)
                    }
                    T("Tài khoản ${conn.phone.ifEmpty { "Viettel Post" }}", 13f, BV.MEDIUM, C.muted)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlineButton("Kiểm tra lại", Modifier.weight(1f), IconName.CHECK) {
                            client.refreshVtp()
                            loadSenders()
                        }
                        OutlineButton("Ngắt kết nối", Modifier.weight(1f), color = C.red) {
                            ui.confirm = ConfirmItem("Ngắt kết nối Viettel Post?",
                                "Máy chủ xoá token. Đơn đã tạo vẫn giữ mã vận đơn; muốn gửi tiếp phải dán token lại.", "Ngắt kết nối") {
                                app.scope.launch { ui.notify(client.vtpDisconnect()) }
                            }
                        }
                    }
                }

                // Điểm lấy hàng
                CardBox(spacing = 4f) {
                    Row(Modifier.padding(bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                        T("Điểm lấy hàng", 15f, BV.BOLD, modifier = Modifier.weight(1f))
                        if (loadingSenders) CircularProgressIndicator(Modifier.size(16.dp), color = C.orangeDeep, strokeWidth = 2.dp)
                    }
                    if (conn.sender == null) {
                        T("Chọn nơi bưu tá đến lấy hàng. Danh sách lấy từ tài khoản Viettel Post của bạn.", 12.5f, BV.MEDIUM, C.red,
                            Modifier.padding(bottom = 6.dp))
                    }
                    val list = senders.ifEmpty { listOfNotNull(conn.sender) }
                    if (list.isEmpty() && !loadingSenders) {
                        T(senderError ?: "Chưa có điểm lấy hàng. Thêm ở viettelpost.vn › Quản lý kho rồi bấm Kiểm tra lại.", 13f, BV.MEDIUM, C.muted)
                    }
                    list.forEachIndexed { i, k ->
                        if (i > 0) HairLine()
                        Row(Modifier.fillMaxWidth().plainTap { choose(k) }.padding(vertical = 10.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            Box(Modifier.padding(top = 2.dp)) { TickCircle(conn.sender?.id == k.id) }
                            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                T(k.name.ifEmpty { "Kho ${k.id}" }, 15f, BV.BOLD, maxLines = 1)
                                T(listOf(k.phone, k.address).filter { it.isNotEmpty() }.joinToString(" · "), 12f, BV.MEDIUM, C.muted, maxLines = 2)
                            }
                        }
                    }
                }

                // Mặc định khi gửi
                CardBox(spacing = 12f) {
                    T("Mặc định khi gửi", 15f, BV.BOLD)
                    T("Gói dịch vụ", 12f, BV.MEDIUM, C.muted)
                    OptionList(Vtp.services.map { it.first to "${it.first} · ${it.second}" }, settings.vtpService) { settings.updateVtpService(it) }
                    T("Khổ tem in", 12f, BV.MEDIUM, C.muted)
                    OptionList(VtpTrack.labelSizes, settings.vtpLabelSize) { settings.updateVtpLabelSize(it) }
                }

                // Tự cập nhật trạng thái
                CardBox {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        T("Tự cập nhật trạng thái", 15f, BV.BOLD, modifier = Modifier.weight(1f))
                        if (conn.lastHookAt != null) Badge("Đang chạy", C.green, C.greenSoft)
                    }
                    T(conn.lastHookAt?.let { "Cập nhật lần cuối ${ago(it)}" }
                        ?: "Chưa nhận cập nhật nào. Dán địa chỉ dưới vào partner2.viettelpost.vn › Bảng điều khiển › Thông tin tài khoản › Production › Cấu hình webhook để đơn tự chuyển Đang giao / Đã giao.",
                        12.5f, BV.MEDIUM, C.muted, lineHeight = 17f)
                    if (conn.hookUrl.isNotEmpty()) {
                        Row(Modifier.fillMaxWidth().height(44.dp).clip(rounded(12f)).background(C.field).padding(horizontal = 12.dp),
                            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            T(conn.hookUrl, 12f, BV.SEMIBOLD, C.ink, Modifier.weight(1f), maxLines = 1)
                            T("Sao chép", 13f, BV.BOLD, C.accent, Modifier.plainTap {
                                VtpActions.setClipboard(app, "Webhook", conn.hookUrl)
                                ui.notify("Đã sao chép địa chỉ webhook.")
                            })
                        }
                    }
                }
            } else {
                // Chưa kết nối
                CardBox(spacing = 8f) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        T("Trạng thái", 15f, BV.BOLD, modifier = Modifier.weight(1f))
                        Badge("Chưa kết nối", C.muted, C.grayBadge)
                    }
                    T("Tạo token tại viettelpost.vn › Cấu hình tài khoản › Thêm mới token, rồi dán vào đây.", 13f, BV.MEDIUM, C.muted)
                }
                CardBox {
                    T("Token ViettelPost", 12f, BV.MEDIUM, C.muted)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Box(Modifier.weight(1f).height(48.dp).cardStyle(14f, C.field).padding(horizontal = 15.dp), contentAlignment = Alignment.CenterStart) {
                            PlainField(token, { token = it }, "Dán token đã sao chép", 15f, BV.SEMIBOLD, Modifier.fillMaxWidth(),
                                capitalize = false, password = true)
                        }
                        Box(Modifier.width(60.dp).height(48.dp).cardStyle(14f).tap {
                            VtpActions.clipboardText(app)?.trim()?.takeIf { it.isNotEmpty() }?.let { token = it }
                        }, contentAlignment = Alignment.Center) { T("Dán", 14f, BV.BOLD, C.accent) }
                    }
                    T("Token được lưu trên máy chủ ChốtLive của bạn, không hiện lại trên máy và không gửi đi nơi khác ngoài Viettel Post. Dán một lần là dùng được cả trên web.",
                        12f, BV.MEDIUM, C.muted, lineHeight = 16.5f)
                    Row(Modifier.plainTap { showSteps = !showSteps }, verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        T("Cách lấy token", 13f, BV.BOLD, C.accent)
                        Icon(if (showSteps) IconName.CHEVRON_UP else IconName.CHEVRON_RIGHT, 13f, 2.4f, C.accent)
                    }
                    if (showSteps) {
                        Column(Modifier.fillMaxWidth().clip(rounded(14f)).background(C.field).padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            listOf(
                                "Đăng nhập viettelpost.vn bằng tài khoản shop.",
                                "Vào Cấu hình tài khoản › Thêm mới token, nhập mã OTP gửi về điện thoại.",
                                "Sao chép token vừa tạo, quay lại đây bấm “Dán” rồi “Lưu và kiểm tra kết nối”.",
                                "Muốn tạo vận đơn bằng app, tài khoản phải là đối tác (Partner) đã kích hoạt Production. Chưa có thì gọi Viettel Post 0862 235 888 nhờ kích hoạt.",
                            ).forEachIndexed { i, text ->
                                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                    Box(Modifier.size(20.dp).clip(CircleShape).background(C.peachSoft), contentAlignment = Alignment.Center) {
                                        T("${i + 1}", 11f, BV.BOLD, C.accent)
                                    }
                                    T(text, 13f, BV.MEDIUM, C.ink, Modifier.weight(1f), lineHeight = 18f)
                                }
                            }
                        }
                    }
                    Box(Modifier.padding(top = 4.dp)) {
                        PrimaryButton(if (busy) "Đang kiểm tra…" else "Lưu và kiểm tra kết nối", fontSize = 15f,
                            enabled = !busy && token.isNotBlank()) { connect() }
                    }
                }
            }
        }
    }
}

private fun ago(ms: Long): String {
    val s = maxOf(0L, (Clock.now - ms) / 1000)
    return when {
        s < 60 -> "vừa xong"
        s < 3600 -> "${s / 60} phút trước"
        s < 86_400 -> "${s / 3600} giờ trước"
        else -> "${dayMonth(ms)} ${timeText(ms)}"
    }
}

/** Danh sách lựa chọn một dòng một mục, có dấu tick. */
@Composable
private fun OptionList(options: List<Pair<String, String>>, selected: String, onSelect: (String) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        for ((value, title) in options) {
            Row(Modifier.fillMaxWidth().height(36.dp).plainTap { onSelect(value) }, verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                TickCircle(value == selected)
                T(title, 14f, if (value == selected) BV.BOLD else BV.SEMIBOLD, maxLines = 1)
            }
        }
    }
}

// MARK: - Kết quả gửi (trong bảng Nháp vận đơn)

@Composable
fun VtpResultView(groups: List<Vtp.Group>, results: List<VtpCreateResult>) {
    val app = LocalApp.current
    val ui = LocalAppUI.current
    val okList = results.filter { it.ok }
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(start = Metrics.GUTTER.dp, end = Metrics.GUTTER.dp, bottom = 12.dp), verticalAlignment = Alignment.Top) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                T("Đã tạo ${okList.size}/${results.size} vận đơn", 20f, BV.HEAVY, C.ink, track = -0.3f)
                T(if (okList.isEmpty()) "Chưa tạo được vận đơn nào" else "${okList.size} khách đã chuyển sang Đang giao", 13f, BV.MEDIUM, C.muted)
            }
            SheetClose()
        }
        Column(
            Modifier.weight(1f).verticalScroll(rememberScrollState())
                .padding(start = Metrics.GUTTER.dp, end = Metrics.GUTTER.dp, bottom = 12.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Column(Modifier.fillMaxWidth().cardStyle(18f)) {
                results.forEachIndexed { i, r ->
                    if (i > 0) HairLine()
                    val g = groups.firstOrNull { it.id == r.key }
                    Row(Modifier.fillMaxWidth().background(if (r.ok) Color.Transparent else C.badRow).padding(horizontal = 14.dp, vertical = 12.dp),
                        horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        Box(Modifier.size(26.dp).clip(CircleShape).background(if (r.ok) C.greenSoft else C.redSoft), contentAlignment = Alignment.Center) {
                            if (r.ok) Icon(IconName.CHECK, 13f, 3f, C.green) else T("!", 14f, BV.HEAVY, C.red)
                        }
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            T(g?.let { it.summary.receiver.ifEmpty { it.customer.nickname } } ?: r.key, 15f, BV.BOLD, maxLines = 1)
                            if (r.ok) {
                                val extra = (if (r.fee > 0) " · cước ${money(r.fee)}" else "") + (if (r.already) " · đã có từ trước" else "")
                                T("Mã ${VtpTrack.pretty(r.code)}$extra", 13f, BV.SEMIBOLD, C.ink)
                            } else {
                                T("ViettelPost báo: ${r.error}", 12.5f, BV.SEMIBOLD, C.red, lineHeight = 17f)
                                if (g != null) {
                                    T("Sửa rồi thử lại", 12.5f, BV.BOLD, C.accent, Modifier.plainTap {
                                        ui.dismissSheet()
                                        ui.push(Route.AddressEdit(g.customer.id))
                                    })
                                }
                            }
                        }
                    }
                }
            }
            T("Đơn lỗi vẫn nằm ở “Chờ gửi”, sửa xong bấm Soát & tạo lại. Không tạo trùng vận đơn cho đơn đã thành công.",
                12.5f, BV.MEDIUM, C.muted, Modifier.padding(horizontal = 4.dp), lineHeight = 17f)
        }
        Column(Modifier.fillMaxWidth().background(C.card)) {
            HairLine()
            Column(Modifier.padding(start = Metrics.GUTTER.dp, end = Metrics.GUTTER.dp, top = 14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                if (okList.isNotEmpty()) {
                    PrimaryButton("In tem ${okList.size} vận đơn", icon = IconName.PRINTER, fontSize = 15f) {
                        VtpActions.printLabels(okList.map { it.code }, app, ui)
                    }
                }
                OutlineButton("Xong", Modifier.fillMaxWidth(), height = 52f) { ui.dismissSheet() }
            }
        }
    }
}

// MARK: - Chi tiết đơn: phần vận đơn

@Composable
fun VtpOrderBox(order: Order) {
    val app = LocalApp.current
    val client = app.client
    val store = app.store
    val ui = LocalAppUI.current
    var busy by remember { mutableStateOf(false) }
    val code = VtpTrack.code(order)
    val old = VtpTrack.cancelledCode(order)
    val lastError = VtpTrack.lastError(order)

    if (code == null) {
        if (old != null) {
            CardBox(C.badRow, C.red.copy(alpha = 0.3f), 6f, 15f) {
                T("Vận đơn ${VtpTrack.pretty(old)} đã huỷ", 14f, BV.BOLD, C.red)
                T("Đơn đã về Chờ gửi. Bấm Soát & tạo ở tab Đơn hàng để tạo vận đơn mới.", 12.5f, BV.MEDIUM, C.muted)
            }
        } else if (lastError != null) {
            CardBox(C.badRow, C.red.copy(alpha = 0.3f), 6f, 15f) {
                T("Lỗi tạo vận đơn", 14f, BV.BOLD, C.red)
                T("ViettelPost báo: $lastError", 12.5f, BV.MEDIUM, C.red)
                T("Sửa địa chỉ", 13f, BV.BOLD, C.accent, Modifier.plainTap { ui.push(Route.AddressEdit(order.customer.id)) })
            }
        }
        return
    }

    val bad = VtpTrack.needsAction(order)
    val s = order.ship
    val at = s?.vtpStatusAt
    val delivered = order.status == OrderStatus.DELIVERED

    fun openRedeliver(prefill: String) {
        if (!client.vtpConnected) return ui.notify(NEED_TOKEN)
        val name = order.customer.displayName
        ui.present(0.42f) { VtpRedeliverSheet(code, name, prefill) }
    }

    CardBox(if (bad) C.badRow else C.card, if (bad) C.red.copy(alpha = 0.35f) else C.line, 12f, 15f) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Icon(IconName.TRUCK, 16f, 2.3f, C.accent)
            // Chữ "ViettelPost" luôn một dòng; trạng thái dài ("Tiếp nhận đơn hàng từ đối tác") tự thu nhỏ/cắt.
            T("ViettelPost", 15f, BV.BOLD, maxLines = 1)
            Box(Modifier.weight(1f), contentAlignment = Alignment.CenterEnd) {
                Box(Modifier.height(24.dp).capsule(if (bad) C.redSoft else if (delivered) C.greenSoft else C.peachSoft)
                    .padding(horizontal = 10.dp), contentAlignment = Alignment.Center) {
                    T(if (bad) "Cần xử lý" else VtpTrack.statusName(order), 12f, BV.SEMIBOLD,
                        if (bad) C.red else if (delivered) C.green else C.accent, shrink = true, minScale = 0.75f)
                }
            }
        }
        if (bad) {
            Column(Modifier.fillMaxWidth().clip(rounded(14f)).background(C.redSoft).padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                T(VtpTrack.statusName(order), 14f, BV.BOLD, C.red)
                s?.vtpNote?.takeIf { it.isNotEmpty() }?.let { T("Lý do từ ViettelPost: $it", 12.5f, BV.MEDIUM, C.ink) }
                if (at != null) T("${dayMonth(at)} ${timeText(at)}", 12f, BV.MEDIUM, C.muted)
            }
        }
        Row(Modifier.fillMaxWidth().height(60.dp).clip(rounded(14f)).background(C.field).tap { VtpActions.copy(code, app, ui) }
            .padding(horizontal = 14.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                T("Mã vận đơn · chạm để sao chép", 12f, BV.MEDIUM, C.muted)
                T(VtpTrack.pretty(code), 18f, BV.HEAVY, C.ink, track = 0.3f, maxLines = 1)
            }
            Icon(IconName.COPY, 17f, color = C.muted)
        }
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            val mates = VtpTrack.sameWaybill(order, store.allOrders())
            InfoLine("Thu hộ (COD)", money(VtpTrack.waybillCod(mates)))
            if (mates.size > 1) InfoLine("Gộp", "${mates.size} đơn · ${money(mates.sumOf { it.total })} tiền hàng")
            s?.vtpFee?.takeIf { it > 0 }?.let { InfoLine("Cước", money(it)) }
            s?.vtpService?.takeIf { it.isNotEmpty() }?.let { InfoLine("Gói", it) }
            if (!bad) InfoLine("Trạng thái", VtpTrack.statusName(order) + (at?.let { " · ${dayMonth(it)} ${timeText(it)}" } ?: ""))
            if (!bad) s?.vtpNote?.takeIf { it.isNotEmpty() }?.let { InfoLine("Hành trình", it) }
            s?.exportedAt?.let { InfoLine("Tạo vận đơn", "${dayMonth(it)} ${timeText(it)}") }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlineButton("In tem", Modifier.weight(1f), IconName.PRINTER, filled = true) { VtpActions.printLabels(listOf(code), app, ui) }
            OutlineButton("Theo dõi", Modifier.weight(1f), IconName.TRUCK) { VtpActions.track(code, app, ui) }
        }
        if (bad) {
            Column {
                T("Gửi yêu cầu cho ViettelPost", 13f, BV.BOLD, C.muted, Modifier.padding(bottom = 4.dp))
                ActionLine("Yêu cầu phát lại", "Kèm ghi chú cho bưu tá") { openRedeliver("") }
                HairLine()
                ActionLine("Đổi số điện thoại / địa chỉ", "Khi khách báo sai thông tin, ghi kèm yêu cầu phát lại") {
                    openRedeliver("Khách đổi thông tin nhận: ")
                }
                HairLine()
                ActionLine("Duyệt hoàn về shop", "Đơn chuyển sang “Đang hoàn”", C.red) {
                    if (!client.vtpConnected) return@ActionLine ui.notify(NEED_TOKEN)
                    ui.confirm = ConfirmItem("Đồng ý hoàn đơn ${VtpTrack.pretty(code)}?",
                        "Viettel Post sẽ hoàn hàng về shop. Không giao lại cho khách nữa.", "Duyệt hoàn") {
                        app.scope.launch {
                            client.vtpResolve(code, 2, "")?.let { return@launch ui.notify(it) }
                            store.applyVtpResolved(code, 2)
                            ui.notify("Đã gửi yêu cầu hoàn về shop.")
                        }
                    }
                }
            }
            T("Khi ViettelPost báo “Giao thành công”, đơn tự chuyển Đã giao.", 12f, BV.MEDIUM, C.muted)
        }
        if (VtpTrack.canCancel(order)) {
            OutlineButton(if (busy) "Đang huỷ…" else "Huỷ vận đơn", Modifier.fillMaxWidth(), color = C.red, enabled = !busy) {
                if (!client.vtpConnected) return@OutlineButton ui.notify(NEED_TOKEN)
                ui.confirm = ConfirmItem("Huỷ vận đơn ${VtpTrack.pretty(code)}?",
                    "Chỉ huỷ được khi bưu tá chưa lấy hàng. Đơn sẽ về lại Chờ gửi.", "Huỷ vận đơn") {
                    busy = true
                    app.scope.launch {
                        val (error, already) = client.vtpCancel(code)
                        busy = false
                        if (error != null) {
                            // Viettel Post không huỷ được: cho gỡ mã khỏi đơn sau khi shop tự kiểm trên viettelpost.vn.
                            ui.confirm = ConfirmItem("Viettel Post không huỷ được",
                                "Viettel Post báo: $error\n\nVào viettelpost.vn kiểm vận đơn ${VtpTrack.pretty(code)}. Nếu đơn đã huỷ ở đó " +
                                    "(hoặc bạn vừa huỷ tay), bấm Gỡ khỏi app để đơn về Chờ gửi.", "Gỡ khỏi app") {
                                busy = true
                                app.scope.launch {
                                    val (e2, _) = client.vtpCancel(code, force = true)
                                    busy = false
                                    if (e2 != null) return@launch ui.notify(e2)
                                    store.applyVtpCancelled(code, "Shop gỡ vận đơn khỏi app")
                                    ui.notify("Đã gỡ vận đơn khỏi đơn, đơn về Chờ gửi.")
                                }
                            }
                            return@launch
                        }
                        store.applyVtpCancelled(code, if (already) "Viettel Post báo đã huỷ" else "Shop đã huỷ vận đơn")
                        ui.notify(if (already) "Viettel Post báo vận đơn này đã huỷ từ trước. Đơn về Chờ gửi."
                        else "Đã huỷ vận đơn, đơn về Chờ gửi.")
                    }
                }
            }
        }
    }
}

@Composable
private fun InfoLine(k: String, v: String) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        T(k, 13f, BV.MEDIUM, C.muted, maxLines = 1)
        T(v, 13f, BV.SEMIBOLD, C.ink, Modifier.weight(1f), align = TextAlign.End)
    }
}

@Composable
private fun ActionLine(title: String, sub: String, color: Color = C.ink, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().plainTap(onClick = onClick).padding(vertical = 10.dp), verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            T(title, 14f, BV.BOLD, color)
            T(sub, 12f, BV.MEDIUM, C.muted, maxLines = 2)
        }
        Icon(IconName.CHEVRON_RIGHT, 15f, color = C.muted)
    }
}

// MARK: - Yêu cầu phát lại

private val quickNotes = listOf("Giao sau 17h", "Gọi trước khi giao", "Giao giờ hành chính", "Giao cuối tuần")

@Composable
fun VtpRedeliverSheet(code: String, name: String, prefill: String = "") {
    val app = LocalApp.current
    val ui = LocalAppUI.current
    var note by remember { mutableStateOf(prefill) }
    var picked by remember { mutableStateOf(setOf<String>()) }
    var busy by remember { mutableStateOf(false) }

    Column(Modifier.fillMaxWidth().padding(start = Metrics.GUTTER.dp, end = Metrics.GUTTER.dp, bottom = 8.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Row(verticalAlignment = Alignment.Top) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                T("Yêu cầu phát lại", 20f, BV.HEAVY, C.ink, track = -0.3f)
                T("$name · ${VtpTrack.pretty(code)}", 13f, BV.MEDIUM, C.muted, maxLines = 1)
            }
            SheetClose()
        }
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            T("Ghi chú cho bưu tá", 12f, BV.SEMIBOLD, C.muted)
            Box(Modifier.fillMaxWidth().heightIn(min = 84.dp).cardStyle(14f, C.field).padding(14.dp)) {
                PlainField(note, { note = it.take(150) }, "Ví dụ: gọi sau 17h, khách đi làm ban ngày.", 15f, BV.SEMIBOLD,
                    Modifier.fillMaxWidth(), singleLine = false, maxLines = 5)
            }
        }
        // Chip chọn nhiều, xếp 2 cột.
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            for (pair in quickNotes.chunked(2)) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    for (q in pair) {
                        val on = picked.contains(q)
                        OnAccent(on) {
                            Box(Modifier.weight(1f).height(38.dp).capsule(if (on) C.orange else C.card, if (on) null else C.line)
                                .plainTap { picked = if (on) picked - q else picked + q }.padding(horizontal = 8.dp),
                                contentAlignment = Alignment.Center) {
                                T(q, 13f, if (on) BV.BOLD else BV.SEMIBOLD, shrink = true, minScale = 0.8f)
                            }
                        }
                    }
                }
            }
        }
        T("Yêu cầu gửi thẳng lên ViettelPost. Kết quả giao lại sẽ tự hiện trong đơn.", 12.5f, BV.MEDIUM, C.muted)
        PrimaryButton(if (busy) "Đang gửi…" else "Gửi yêu cầu", fontSize = 15f, enabled = !busy) {
            busy = true
            val text = (quickNotes.filter { picked.contains(it) } + note.trim()).filter { it.isNotEmpty() }.joinToString(". ").take(150)
            app.scope.launch {
                val error = app.client.vtpResolve(code, 3, text)
                busy = false
                if (error != null) return@launch ui.notify(error)
                app.store.applyVtpResolved(code, 3)
                ui.dismissSheet()
                ui.notify("Đã gửi yêu cầu phát lại cho ViettelPost.")
            }
        }
    }
}

// MARK: - Tab Đang giao: đơn cần xử lý

@Composable
fun VtpAttentionBanner(orders: List<Order>) {
    val codes = orders.mapNotNull { VtpTrack.code(it) }.toSet()
    Column(Modifier.fillMaxWidth().cardStyle(18f, C.badRow, C.red.copy(alpha = 0.35f)).padding(horizontal = 14.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(3.dp)) {
        T("${codes.size} đơn cần xử lý · xếp lên đầu", 14f, BV.BOLD, C.red)
        T(orders.take(3).joinToString(" · ") { "${it.customer.displayName}: ${VtpTrack.statusName(it)}" }, 12f, BV.MEDIUM, C.muted, maxLines = 2)
    }
}
