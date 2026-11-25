package com.chotlive.app.ui

import kotlinx.coroutines.delay
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.JsonObject
import com.chotlive.app.net.vtpApproveDraft
import com.chotlive.app.net.vtpAdoptDraft
import com.chotlive.app.net.VtpDraftHub
import com.chotlive.app.net.VtpDraftClient
import com.chotlive.app.net.VtpDraftApproveOutcome
import com.chotlive.app.model.VtpDraftBody
import androidx.compose.foundation.horizontalScroll
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.runtime.mutableIntStateOf
import android.content.ClipData
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import com.chotlive.app.ChotLiveApp
import com.chotlive.app.model.Clock
import com.chotlive.app.model.Order
import com.chotlive.app.model.OrderStatus
import com.chotlive.app.model.ShipInfo
import com.chotlive.app.model.ShipState
import com.chotlive.app.model.Vtp
import com.chotlive.app.model.VtpQuote
import com.chotlive.app.model.VtpTrack
import com.chotlive.app.model.dayMonth
import com.chotlive.app.model.groupedNumber
import com.chotlive.app.model.money
import com.chotlive.app.model.timeText
import com.chotlive.app.net.VtpCreateResult
import com.chotlive.app.net.vtpConnected
import com.chotlive.app.net.vtpCreate
import com.chotlive.app.net.vtpQuote
import kotlinx.coroutines.launch
import java.io.File
import java.math.BigDecimal
import java.math.RoundingMode

// MARK: - Nhãn và nút dùng chung

/** Chữ trên nút giữa của thẻ đơn và trang chi tiết. */
fun shipButtonLabel(o: Order): String = when (Vtp.state(o)) {
    ShipState.ASK -> "Duyệt đơn"
    ShipState.HOLD -> "Gom sau"
    ShipState.READY -> "Sẵn sàng"
    ShipState.EXPORTED, ShipState.GONE ->
        if (VtpTrack.isReturned(o)) "Hoàn về" else if (o.status == OrderStatus.DELIVERED) "Đã giao" else "Đang giao"
}

@Composable
fun shipButtonColor(o: Order): Color = when (Vtp.state(o)) {
    ShipState.ASK, ShipState.HOLD -> C.ink
    ShipState.READY -> C.accent
    ShipState.EXPORTED, ShipState.GONE ->
        if (VtpTrack.isReturned(o)) C.red else if (o.status == OrderStatus.DELIVERED) C.green else C.accent
}

/** Nhãn trạng thái ở trang chi tiết đơn. */
@Composable
fun ShipBadge(order: Order, fontSize: Float = 12f, height: Float = 25f) {
    when (Vtp.state(order)) {
        ShipState.ASK -> Badge("Đơn mới", fontSize = fontSize, height = height, hPad = 12f)
        ShipState.HOLD -> Badge("Gom sau", C.gomInk, C.gomTag, fontSize, height, 12f)
        ShipState.READY -> Badge("Sẵn sàng", fontSize = fontSize, height = height, hPad = 12f)
        ShipState.EXPORTED, ShipState.GONE ->
            if (VtpTrack.isReturned(order)) Badge("Hoàn về", C.red, C.redSoft, fontSize, height, if (height >= 25) 12f else 8f)
            else StatusBadge(order.status, fontSize, height)
    }
}

/** Nút chọn 2 lựa chọn rộng hết hàng: nền xám, nút đang chọn trắng có bóng nhẹ. */
@Composable
fun SegmentPicker(options: List<Pair<String, String>>, selected: String, enabled: Boolean = true, onSelect: (String) -> Unit) {
    Row(Modifier.fillMaxWidth().height(44.dp).alpha(if (enabled) 1f else 0.6f).capsule(C.segTrack).padding(3.dp)) {
        for ((value, title) in options) {
            val on = value == selected
            Box(
                Modifier.weight(1f).fillMaxSize()
                    .then(if (on) Modifier.shadow(1.5.dp, Capsule) else Modifier)
                    .capsule(if (on) C.segOn else Color.Transparent)
                    .plainTap(enabled) { onSelect(value) },
                contentAlignment = Alignment.Center,
            ) {
                T(title, 14f, if (on) BV.BOLD else BV.SEMIBOLD, if (on) C.ink else C.muted, shrink = true, minScale = 0.85f)
            }
        }
    }
}

/** Nút X tròn 36 ở góc phải bảng dưới. */
@Composable
fun SheetClose(onClick: (() -> Unit)? = null) {
    val ui = LocalAppUI.current
    Box(Modifier.size(36.dp).clip(CircleShape).background(C.field).tap { if (onClick != null) onClick() else ui.dismissSheet() },
        contentAlignment = Alignment.Center) {
        Icon(IconName.CLOSE, 17f, 2.4f)
    }
}

/** Dấu tick tròn cam; rỗng khi chưa chọn hoặc không chọn được. */
@Composable
fun TickCircle(on: Boolean, enabled: Boolean = true) {
    if (on) {
        OnAccent {
            Box(Modifier.size(24.dp).clip(CircleShape).background(C.orange), contentAlignment = Alignment.Center) {
                Icon(IconName.CHECK, 13f, 3f)
            }
        }
    } else {
        Box(Modifier.size(24.dp).border(1.6.dp, if (enabled) C.faint else C.line, CircleShape))
    }
}

@Composable
private fun FieldLabel(s: String) = T(s, 12f, BV.SEMIBOLD, C.muted)

/** "1", "1,5": số gọn, dấu phẩy thập phân. */
private fun plainNumber(v: Double): String =
    BigDecimal(v).setScale(3, RoundingMode.HALF_UP).stripTrailingZeros().toPlainString().replace(".", ",")

/** "1kg", "1,5kg" */
fun weightText(g: Int): String = plainNumber(g / 1000.0) + "kg"

/** Nhãn nhỏ bo tròn trên thẻ ("gộp 2 đơn", "Sẵn sàng gửi"). */
@Composable
fun ShipTag(text: String, color: Color, fill: Color, size: Float = 12f, height: Float = 24f, hPad: Float = 10f, weight: BV = BV.SEMIBOLD) {
    Box(Modifier.height(height.dp).capsule(fill).padding(horizontal = hPad.dp), contentAlignment = Alignment.Center) {
        T(text, size, weight, color, shrink = true, minScale = 0.85f)
    }
}

// MARK: - Thanh Sẵn sàng xuất

/** `connected`: đã kết nối Viettel Post thì soát nháp rồi tạo vận đơn ("Soát & tạo") thay cho xuất Excel ("Xuất VTP"). */
@Composable
fun ReadyExportBanner(groups: List<Vtp.Group>, connected: Boolean, onExport: () -> Unit) {
    val start = Clock.startOfDay(Clock.today())
    val merged = groups.count { it.orders.size > 1 }
    val older = groups.count { g -> g.orders.any { it.lastTs < start } }
    val cod = groups.sumOf { it.summary.cod }
    val failed = if (connected) groups.count { g -> g.orders.any { VtpTrack.lastError(it) != null } } else 0
    val noPhone = if (connected) groups.count { it.summary.problems.contains("Thiếu số điện thoại") } else 0
    val parts = mutableListOf<String>()
    if (failed > 0) parts += "$failed khách tạo vận đơn lỗi"
    if (noPhone > 0) parts += "$noPhone khách thiếu SĐT"
    if (merged > 0) parts += "$merged khách gộp nhiều đơn"
    if (older > 0) parts += "$older khách có đơn duyệt từ ngày trước"
    parts += "Thu hộ ${money(cod)}"

    Row(
        Modifier.fillMaxWidth().cardStyle(18f, C.peachSoft, C.peachLine).padding(horizontal = 14.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            // Đã kết nối Viettel Post: đơn ở Chờ gửi là nháp sẵn, bấm Soát & tạo mở bảng nháp.
            T(if (connected) "${groups.size} nháp chờ tạo vận đơn" else "${groups.size} khách sẵn sàng xuất", 14f, BV.BOLD)
            T(parts.joinToString(" · "), 12f, BV.MEDIUM, C.muted, maxLines = 2, lineHeight = 16f)
        }
        OnAccent {
            Row(
                Modifier.height(40.dp).capsule(C.orange).tap(onClick = onExport).padding(horizontal = 15.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Icon(if (connected) IconName.TRUCK else IconName.DOWNLOAD, 15f, 2.4f)
                T(if (connected) "Soát & tạo" else "Xuất VTP", 14f, BV.BOLD, maxLines = 1)
            }
        }
    }
}

// MARK: - Bảng Duyệt đơn

/** Giá trị các ô lúc mở bảng Duyệt đơn, lấy từ cài đặt đã lưu trên các đơn. */
private class ReviewStart(focus: Order?, pending: List<Order>, draftIds: Set<String>?) {
    // Sửa nháp: chỉ lấy các đơn của nháp, đơn khác của khách vẫn hiện nhưng không tick sẵn.
    private val own = draftIds?.let { ids -> pending.filter { ids.contains(it.id) } } ?: emptyList()
    private val list = own.ifEmpty { pending }
    val checked: Set<String> = list.map { it.id }.toSet()
    val pay: String = (list + listOfNotNull(focus)).mapNotNull { it.ship?.pay }.let { pays ->
        if (pays.contains("paid") || pays.contains("shipOnly")) "paid" else "cod"
    }
    val payer: String = list.asReversed().mapNotNull { it.ship?.payer }.firstOrNull { it == "sender" || it == "receiver" }
        ?: if (pay == "cod") "receiver" else "sender"
    val deposit: String = list.sumOf { it.ship?.deposit ?: 0 }.toString()
    val fee: Int? = list.asReversed().firstNotNullOfOrNull { it.ship?.shipFee }
    val weight: String = plainNumber((list.mapNotNull { it.ship?.weightG }.filter { it > 0 }.maxOrNull() ?: Vtp.DEFAULT_WEIGHT_G) / 1000.0)
    private val sized = list.asReversed().mapNotNull { it.ship }.firstOrNull { it.lengthCm != null }
    val length: String = sized?.lengthCm?.toString() ?: ""
    val width: String = sized?.widthCm?.toString() ?: ""
    val height: String = sized?.heightCm?.toString() ?: ""
    /** Sửa nháp: COD đã sửa tay lúc duyệt thì giữ nguyên, không lặng lẽ quay về số tự cộng. */
    val manualCod: Int? = if (draftIds != null) list.asReversed().firstNotNullOfOrNull { it.ship?.codOverride } else null
    /** Giá trị đơn đã sửa tay lúc duyệt trước thì giữ nguyên. */
    val manualGoods: Int? = list.asReversed().firstNotNullOfOrNull { it.ship?.goodsOverride }
}

/**
 * `draftIds`: mở từ nút Sửa ở "Hàng & tiền" của một nháp vận đơn. Chỉ tick sẵn đúng các đơn của nháp đó,
 * giữ số COD đã sửa tay, và lưu xong thì quay lại nháp. null là duyệt đơn bình thường.
 */
@Composable
fun ShipReviewSheet(orderId: String, draftIds: Set<String>? = null) {
    val app = LocalApp.current
    val store = app.store
    val ui = LocalAppUI.current
    val all = remember(store.customers) { store.allOrders() }
    val focus = all.firstOrNull { it.id == orderId }
    val pending = remember(all, orderId) { focus?.let { Vtp.pendingOrders(it.customer.id, all) } ?: emptyList() }
    val isSent = focus != null && !Vtp.state(focus).isPending

    val start = remember { ReviewStart(focus, pending, draftIds) }
    var checked by remember { mutableStateOf(start.checked) }
    var pay by remember { mutableStateOf(start.pay) }
    var payer by remember { mutableStateOf(start.payer) }
    var depositText by remember { mutableStateOf(start.deposit) }
    var weightInput by remember { mutableStateOf(start.weight) }
    var lengthText by remember { mutableStateOf(start.length) }
    var widthText by remember { mutableStateOf(start.width) }
    var heightText by remember { mutableStateOf(start.height) }
    // Đã sửa tay ô COD: số sửa tay thắng số tự cộng cho tới khi bấm "Tự tính" hoặc đổi lựa chọn khác.
    var codEdited by remember { mutableStateOf(start.manualCod != null) }
    var codText by remember { mutableStateOf(start.manualCod?.let { groupedNumber(it) } ?: "") }
    // Giá trị đơn hàng: mặc định là tổng tiền các đơn đang tick; sửa tay (khách cọc, giảm giá...) thì thay tổng đó,
    // thu hộ tự tính lại = giá trị − tiền cọc, và là giá trị hàng khai với Viettel Post.
    var valueEdited by remember { mutableStateOf(start.manualGoods != null) }
    var valueText by remember { mutableStateOf(start.manualGoods?.let { groupedNumber(it) } ?: "") }

    fun digits(s: String): Int? = s.filter { it.isDigit() }.take(9).toIntOrNull()
    fun cm(s: String): Int? = s.filter { it.isDigit() }.take(4).toIntOrNull()?.takeIf { it > 0 }
    val deposit = digits(depositText) ?: 0
    val weightG = (weightInput.replace(",", ".").trim().toDoubleOrNull() ?: 0.0).let { kg ->
        if (kg > 0) Math.round(minOf(kg, 1000.0) * 1000).toInt() else Vtp.DEFAULT_WEIGHT_G
    }
    val codValue = if (codEdited) digits(codText) else null
    // Từ 10kg Viettel Post cần kích thước kiện: hiện 3 ô Dài / Rộng / Cao và bắt buộc nhập.
    val needsSize = weightG >= Vtp.SIZE_REQUIRED_G
    val sizeMissing = needsSize && (cm(lengthText) == null || cm(widthText) == null || cm(heightText) == null)
    val chosen = pending.filter { checked.contains(it.id) }
    val autoGoods = chosen.ifEmpty { listOfNotNull(focus) }.sumOf { maxOf(0, it.total) }
    val goodsValue = if (valueEdited) digits(valueText) ?: 0 else null

    /** Cài đặt đang chọn trong bảng, ghi vào đơn khi bấm nút. */
    fun patch(first: Boolean, cod: Int?) = ShipInfo(
        pay = pay, payer = payer, deposit = if (first) deposit else 0, shipFee = start.fee, codOverride = cod,
        goodsOverride = goodsValue, weightG = weightG,
        lengthCm = if (needsSize) cm(lengthText) else null, widthCm = if (needsSize) cm(widthText) else null,
        heightCm = if (needsSize) cm(heightText) else null,
    )

    // Tính thử đúng như lúc xuất: tiền cọc ở đơn đầu, các cài đặt khác ở mọi đơn. Kèm cả số thu hộ nhập tay,
    // để cảnh báo đơn dưới 17.000đ đúng với số sẽ gửi đi (autoCod không đổi theo số này).
    val trial = focus?.let { f ->
        val list = chosen.ifEmpty { listOf(f) }
        Vtp.summarize(list.mapIndexed { i, o -> Vtp.Line(o.total, o.productCount, patch(i == 0, codValue)) },
            f.customer.address, f.customer.nickname)
    }
    // Chưa sửa tay thì ô COD luôn hiện số tự cộng theo các lựa chọn đang có.
    val codShown = if (codEdited) codText else groupedNumber(trial?.autoCod ?: 0)

    /** Quay lại bảng Nháp vận đơn; `open` thì mở thẳng nháp của khách này. */
    fun backToDraft(open: Boolean) {
        val customerId = focus?.customer?.id
        ui.present(0.42f) { VtpExportSheet(if (open) customerId else null) }
    }

    fun apply(state: ShipState) {
        val ids = chosen.map { it.id }
        if (ids.isEmpty()) return ui.notify("Tick ít nhất một đơn.")
        if (state == ShipState.READY && sizeMissing) return ui.notify("Hàng từ 10kg phải nhập đủ kích thước dài, rộng, cao (cm).")
        // Đơn đang Chờ gửi mà bị bỏ tick: đưa về chưa duyệt, không thì lúc tạo vận đơn vẫn bị gộp chung và cộng tiền.
        val dropped = if (state == ShipState.READY) {
            pending.filter { !checked.contains(it.id) && Vtp.state(it) == ShipState.READY }.map { it.id }
        } else emptyList()
        store.approve(ids, state, patch(true, codValue), dropped)
        // Lưu thì mở lại nháp để soát tiếp.
        if (draftIds != null) backToDraft(state == ShipState.READY) else ui.dismissSheet()
    }

    Column(Modifier.fillMaxWidth().height(sheetHeight(LocalSheetMaxHeight.current * 0.1f))) {
        Row(Modifier.fillMaxWidth().padding(start = Metrics.GUTTER.dp, end = Metrics.GUTTER.dp, bottom = 12.dp),
            verticalAlignment = Alignment.CenterVertically) {
            T(if (draftIds == null) "Duyệt đơn" else "Sửa hàng & tiền", 20f, BV.HEAVY, C.ink, Modifier.weight(1f), track = -0.3f)
            // Đóng khi đang sửa nháp: không lưu gì, quay lại đúng nháp đó.
            if (draftIds == null) SheetClose() else SheetClose { backToDraft(true) }
        }
        if (focus == null) {
            Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                T("Đơn không còn tồn tại", 14f, BV.MEDIUM, C.muted)
            }
            return@Column
        }
        Column(
            Modifier.weight(1f).verticalScroll(rememberScrollState())
                .padding(start = Metrics.GUTTER.dp, end = Metrics.GUTTER.dp, bottom = 12.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            if (isSent) {
                SentBox(focus)
            } else {
                // Danh sách đơn
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    T(if (pending.size > 1) "GỘP ${pending.size} ĐƠN" else "ĐƠN DUYỆT", 12f, BV.BOLD, C.muted,
                        Modifier.padding(start = 4.dp), track = 0.4f)
                    Column(Modifier.fillMaxWidth().cardStyle(18f)) {
                        pending.forEachIndexed { i, o ->
                            if (i > 0) HairLine(Modifier.padding(start = 50.dp))
                            val on = checked.contains(o.id)
                            ReviewOrderRow(o, on) {
                                checked = if (on) checked - o.id else checked + o.id
                                valueEdited = false
                                codEdited = false
                            }
                        }
                    }
                    val warn = trial?.problems?.filter { !it.contains("kích thước") } ?: emptyList()
                    if (warn.isNotEmpty()) {
                        Row(Modifier.padding(horizontal = 4.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            T(warn.joinToString(" · "), 12.5f, BV.MEDIUM, C.red, Modifier.weight(1f, fill = false))
                            T("Sửa", 12.5f, BV.BOLD, C.accent, Modifier.plainTap {
                                ui.dismissSheet()
                                ui.push(Route.AddressEdit(focus.customer.id))
                            })
                        }
                    }
                }

                // Ô nhập
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    FieldLabel("Tiền hàng")
                    SegmentPicker(listOf("cod" to "Thu tiền hàng", "paid" to "Đã bank đủ"), pay) { v ->
                        pay = v
                        // Thu tiền hàng thì người nhận trả cước, đã bank đủ thì shop trả.
                        payer = if (v == "cod") "receiver" else "sender"
                        codEdited = false
                    }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        FieldLabel("Khách cọc")
                        ReviewInput(depositText, "0", KeyboardType.Number) {
                            depositText = it
                            codEdited = false
                        }
                    }
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        FieldLabel("Cân nặng (kg)")
                        ReviewInput(weightInput, "1", KeyboardType.Decimal) { weightInput = it }
                    }
                }
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.weight(1f)) { FieldLabel("Giá trị đơn hàng") }
                        if (valueEdited) T("Tổng các đơn", 12f, BV.BOLD, C.accent, Modifier.plainTap {
                            valueEdited = false
                            codEdited = false
                        })
                    }
                    ReviewInput(if (valueEdited) valueText else groupedNumber(autoGoods), "0", KeyboardType.Number) {
                        valueText = it
                        valueEdited = true
                        codEdited = false
                    }
                }
                if (needsSize) {
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        TA(annotated("Kích thước " to spanStyle(12f, BV.SEMIBOLD, C.muted), "*" to spanStyle(13f, BV.BOLD, C.red)))
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Box(Modifier.weight(1f)) { ReviewInput(lengthText, "Dài (cm)", KeyboardType.Number, 12f) { lengthText = it } }
                            Box(Modifier.weight(1f)) { ReviewInput(widthText, "Rộng (cm)", KeyboardType.Number, 12f) { widthText = it } }
                            Box(Modifier.weight(1f)) { ReviewInput(heightText, "Cao (cm)", KeyboardType.Number, 12f) { heightText = it } }
                        }
                        if (sizeMissing) T("Hàng từ 10kg phải nhập đủ dài, rộng, cao.", 12f, BV.MEDIUM, C.red)
                    }
                }
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.weight(1f)) { FieldLabel("Thu hộ COD") }
                        if (codEdited) T("Tự tính", 12f, BV.BOLD, C.accent, Modifier.plainTap { codEdited = false })
                    }
                    Box(Modifier.fillMaxWidth().height(50.dp).cardStyle(12f, C.peachSoft, C.peachLine).padding(horizontal = 14.dp),
                        contentAlignment = Alignment.CenterStart) {
                        PlainField(codShown, {
                            codText = it
                            codEdited = true
                        }, "0", 20f, BV.HEAVY, Modifier.fillMaxWidth(), KeyboardType.Number, capitalize = false)
                    }
                }
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    FieldLabel("Người trả cước")
                    SegmentPicker(listOf("receiver" to "Người nhận", "sender" to "Người gửi"), payer) { v ->
                        payer = v
                        codEdited = false
                    }
                    // Kể cả khi đã chọn người gửi trả hoặc tự nhập số thu hộ: báo rõ khách sẽ trả bao nhiêu.
                    if (trial != null && !trial.allPaid && (trial.shipFee > 0 || trial.forcedSender)) ForcedSenderWarning(trial)
                }
            }
        }

        // Nút cuối bảng
        Row(Modifier.fillMaxWidth().padding(start = Metrics.GUTTER.dp, end = Metrics.GUTTER.dp, top = 10.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            if (isSent) {
                // Vận đơn tạo qua API thì huỷ ở phần ViettelPost của chi tiết đơn, không hoàn tác ở đây.
                if (Vtp.state(focus) == ShipState.EXPORTED && focus.status == OrderStatus.SHIPPING && VtpTrack.code(focus) == null) {
                    OutlineButton("Hoàn tác xuất", Modifier.weight(1f), height = 52f) {
                        store.undoExport(focus)
                        ui.dismissSheet()
                    }
                }
                if (focus.status == OrderStatus.DELIVERED) {
                    OutlineButton("Chưa giao", Modifier.weight(1f), height = 52f) {
                        store.setDelivered(focus, false)
                        ui.dismissSheet()
                    }
                } else {
                    PrimaryButton("Đã giao", Modifier.weight(1f), fontSize = 15f) {
                        store.setDelivered(focus, true)
                        ui.dismissSheet()
                    }
                }
            } else {
                if (draftIds != null) {
                    // Mở từ nháp vận đơn: không để "Gom sau" ở đây (bấm nhầm là nháp biến mất), chỉ quay lại danh sách nháp.
                    OutlineButton("Quay lại", Modifier.weight(2f), height = 52f) { backToDraft(false) }
                } else {
                    OutlineButton("Gom sau", Modifier.weight(2f), height = 52f) { apply(ShipState.HOLD) }
                }
                PrimaryButton(if (draftIds == null) "Xác nhận gửi" else "Lưu thay đổi", Modifier.weight(3f), fontSize = 15f) {
                    apply(ShipState.READY)
                }
            }
        }
    }
}

@Composable
private fun ReviewOrderRow(o: Order, on: Boolean, onToggle: () -> Unit) {
    val st = Vtp.state(o)
    val title = if (st == ShipState.HOLD) "Đơn gom ${dayMonth(o.lastTs)}" else if (Clock.isToday(o.lastTs)) "Đơn hôm nay" else "Đơn ${dayMonth(o.lastTs)}"
    val sub = if (st == ShipState.HOLD) "Khách hẹn gom · ${o.productCount} sản phẩm"
    else "${timeText(o.lastTs)} · ${o.productCount} sản phẩm${if (st == ShipState.READY) " · đã duyệt" else ""}"
    Row(Modifier.fillMaxWidth().height(60.dp).plainTap(onClick = onToggle).padding(horizontal = 14.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        TickCircle(on)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            T(title, 15f, BV.BOLD, maxLines = 1)
            T(sub, 12f, BV.MEDIUM, if (st == ShipState.HOLD) C.gomInk else C.muted, maxLines = 1)
        }
        T(money(o.total), 15f, BV.HEAVY, if (on) C.ink else C.muted, maxLines = 1)
    }
}

@Composable
private fun SentBox(o: Order) {
    val day = o.ship?.exportedAt?.let { " ngày " + dayMonth(it) } ?: ""
    val code = VtpTrack.code(o)
    val text = when {
        code != null -> "Đã tạo vận đơn ${VtpTrack.pretty(code)}$day. In tem hoặc huỷ vận đơn ở chi tiết đơn."
        Vtp.state(o) == ShipState.EXPORTED -> "Đã xuất Viettel Post$day."
        else -> "Đơn đã chuyển ${if (o.status == OrderStatus.DELIVERED) "Đã giao" else "Đang giao"}."
    }
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(Modifier.fillMaxWidth().height(60.dp).cardStyle(18f).padding(horizontal = 14.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                T(o.code?.let { "Đơn $it" } ?: "Đơn ${dayMonth(o.lastTs)}", 15f, BV.BOLD, maxLines = 1)
                T("${o.productCount} sản phẩm · ${timeText(o.lastTs)} · ${dayMonth(o.lastTs)}", 12f, BV.MEDIUM, C.muted, maxLines = 1)
            }
            T(money(o.total), 15f, BV.HEAVY, maxLines = 1)
        }
        T(text, 13f, BV.MEDIUM, C.muted, Modifier.padding(horizontal = 4.dp))
    }
}

/** Đơn dưới 17.000đ mà chọn người nhận trả: vẫn cho chọn, khi xuất tự đổi người gửi trả và cộng ship vào COD. */
@Composable
private fun ForcedSenderWarning(t: Vtp.Summary) {
    val shape = rounded(12f)
    Row(
        Modifier.padding(top = 2.dp).fillMaxWidth().clip(shape).background(C.red.copy(alpha = 0.08f), shape)
            .border(1.dp, C.red.copy(alpha = 0.3f), shape).padding(horizontal = 12.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Icon(IconName.ALERT, 15f, 2.2f, C.red, Modifier.padding(top = 1.dp))
        T(
            if (t.shipFee > 0) "Thu hộ thấp hơn tiền ship: người gửi trả ship và cộng tiền ship vào thu hộ. Tạm tính ship ${money(t.shipFee)}, khách trả ${money(t.cod)}. Bước nháp vận đơn sẽ tính lại theo cước thật Viettel Post báo."
            else "Tiền hàng thấp hơn tiền ship: người gửi trả ship. Thu hộ giữ đúng ${money(t.cod)} bạn đã nhập.",
            12.5f, BV.MEDIUM, C.red, Modifier.weight(1f), lineHeight = 17f,
        )
    }
}

@Composable
private fun ReviewInput(value: String, placeholder: String, keyboard: KeyboardType, hPad: Float = 14f, onChange: (String) -> Unit) {
    Box(Modifier.fillMaxWidth().height(44.dp).cardStyle(12f).padding(horizontal = hPad.dp), contentAlignment = Alignment.CenterStart) {
        PlainField(value, onChange, placeholder, 16f, BV.SEMIBOLD, Modifier.fillMaxWidth(), keyboard, capitalize = false)
    }
}

// MARK: - Bảng Xuất Viettel Post / Nháp vận đơn

@Composable
private fun DetailBox(title: String, content: @Composable () -> Unit) {
    Column(Modifier.fillMaxWidth().cardStyle(16f).padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        T(title, 11.5f, BV.BOLD, C.muted, track = 0.4f)
        content()
    }
}

@Composable
private fun KV(k: String, v: String, strong: Boolean = false) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        T(k, 13f, BV.MEDIUM, C.muted, maxLines = 1)
        T(v, if (strong) 15f else 13f, if (strong) BV.HEAVY else BV.SEMIBOLD, C.ink, Modifier.weight(1f), align = TextAlign.End)
    }
}

/** `openDetail`: mở thẳng nháp của khách này (dùng khi vừa sửa Hàng & tiền xong). */
@Composable
fun VtpExportSheet(openDetail: String? = null) {
    val app = LocalApp.current
    val store = app.store
    val client = app.client
    val settings = app.settings
    val ui = LocalAppUI.current
    var sending by remember { mutableStateOf(false) }
    // Kết quả lần tạo vận đơn vừa xong (cùng các khách đã gửi), hiện thay cho danh sách.
    var result by remember { mutableStateOf<Pair<List<Vtp.Group>, List<VtpCreateResult>>?>(null) }
    var selected by remember { mutableStateOf(setOf<String>()) }
    var touched by remember { mutableStateOf(false) }
    var picking by remember { mutableStateOf(false) }
    // Nháp đã hỏi cước, theo chữ ký nháp (VtpQuote.signature). Đang hỏi thì nằm trong `quoting`.
    var quotes by remember { mutableStateOf(mapOf<String, VtpQuote>()) }
    var quoting by remember { mutableStateOf(setOf<String>()) }
    // Nháp đang mở để soát chi tiết (mã khách); null là đang ở danh sách nháp.
    var detailId by remember { mutableStateOf(openDetail) }
    val hub = app.vtpDrafts
    // Lọc nhanh theo nháp: 0 tất cả, 1 chưa đẩy, 2 nháp VTP, 3 cần sửa.
    var draftFilter by remember { mutableIntStateOf(0) }
    var deletingDrafts by remember { mutableStateOf(false) }
    val clipboard = LocalClipboardManager.current
    val uri = LocalUriHandler.current

    val service = settings.vtpService
    val api = client.vtpConnected
    val hasSender = client.vtp?.sender != null
    val base = remember(store.customers) { Vtp.readyGroups(store.allOrders()) }

    // Đơn ở Chờ gửi là nháp sẵn. Viettel Post hiểu địa chỉ sang phường/tỉnh khác thì nháp đó chưa cho tạo.
    val groups = remember(base, quotes, service, api) {
        base.map { g ->
            val q = if (api) quotes[VtpQuote.signature(g, service)] else null
            if (q == null) g else {
                var out = g
                // Đã có cước thật: đơn thu hộ thấp hơn cước đó chuyển người gửi trả và cộng đúng cước đó vào thu hộ.
                if (q.ok && q.fee > 0) {
                    out = out.copy(baseSummary = g.summary,
                        summary = Vtp.summarize(Vtp.lines(g.orders), g.customer.address, g.customer.nickname, q.fee))
                }
                if (q.addrOk == false) {
                    out = out.copy(summary = out.summary.copy(
                        problems = out.summary.problems + "Viettel Post hiểu \"${q.parsed}\", khác địa chỉ trong app"))
                }
                out
            }
        }.sortedBy { it.isBad } // Đơn sẵn sàng lên đầu, đơn cần sửa xuống cuối; giữ nguyên thứ tự trong từng nhóm.
    }
    val visible = groups.filter { draftFilterMatches(it, draftFilter, service) }
    val okIds = visible.filter { !it.isBad }.map { it.id }.toSet()
    val chosen = if (touched) selected.intersect(okIds) else okIds

    fun quote(g: Vtp.Group): VtpQuote? = quotes[VtpQuote.signature(g, service)]
    fun isQuoting(g: Vtp.Group): Boolean = quoting.contains(VtpQuote.signature(g, service))

    // Hỏi cước cho mọi nháp đủ địa chỉ chưa có cước của gói đang chọn. Chạy ở phạm vi của app,
    // để lượt hỏi đang chạy không bị huỷ giữa chừng khi danh sách nháp đổi.
    val quoteKey = if (!api || !hasSender) "" else
        base.filter { !it.isBad }.map { VtpQuote.signature(it, service) }.sorted().joinToString(",")
    LaunchedEffect(quoteKey) {
        if (quoteKey.isEmpty()) return@LaunchedEffect
        val need = base.filter { !it.isBad }.map { VtpQuote.signature(it, service) to it }
            .filter { quotes[it.first] == null && !quoting.contains(it.first) }
        if (need.isEmpty()) return@LaunchedEffect
        val sigs = need.associate { it.second.id to it.first }
        quoting = quoting + sigs.values
        app.scope.launch {
            val (error, found) = client.vtpQuote(service, need.map { VtpTrack.payload(it.second) })
            quotes = quotes + sigs.map { (key, sig) -> sig to (found[key] ?: VtpQuote.failed(error ?: "Không tính được cước")) }
            quoting = quoting - sigs.values.toSet()
        }
    }

    /**
     * Duyệt một nháp thành vận đơn giữ nguyên mã: ưu tiên dùng đúng phiên phần 2 đã đẩy trên máy; máy này không
     * đăng nhập tài khoản đó mà phần 1 kết nối đúng cùng tài khoản thì nhờ máy chủ duyệt qua API đối tác.
     */
    suspend fun approveOneDraft(g: Vtp.Group, code: String, estimatedFee: Int, batchId: String): Pair<VtpCreateResult, Boolean> {
        when (val outcome = hub.approveDraft(g, code)) {
            is VtpDraftApproveOutcome.Approved -> {
                val approved = outcome.result
                val fee = if (approved.fee > 0) approved.fee else estimatedFee
                store.applyVtpCreated(g.orders, approved.code, fee, service, cod = g.summary.cod, goods = g.summary.goods,
                    fromDraft = true, batchId = batchId)
                val p = JsonObject(VtpTrack.payload(g) + mapOf("code" to JsonPrimitive(approved.code), "fee" to JsonPrimitive(fee),
                    "batchId" to JsonPrimitive(batchId)))
                // Báo máy chủ để đồng bộ, in tem và nhận cập nhật trạng thái; mất mạng thì thử lại một lần.
                if (client.vtpAdoptDraft(service, listOf(p)).first == 0) {
                    delay(1000)
                    client.vtpAdoptDraft(service, listOf(p))
                }
                return VtpCreateResult(g.id, true, approved.code, fee, cod = g.summary.cod, goods = g.summary.goods, fromDraft = true) to false
            }
            is VtpDraftApproveOutcome.Unavailable -> {
                val partner = client.vtp?.phone
                if (client.vtpConnected && !partner.isNullOrEmpty() &&
                    (outcome.account.isEmpty() || VtpDraftClient.phonesMatch(partner, outcome.account) == true)) {
                    val p = JsonObject(VtpTrack.payload(g) + mapOf("code" to JsonPrimitive(code), "fee" to JsonPrimitive(estimatedFee),
                        "batchId" to JsonPrimitive(batchId)))
                    val (status, error, results) = client.vtpApproveDraft(service, listOf(p))
                    val first = results.firstOrNull { it.key == g.id } ?: results.firstOrNull()
                    if (status == 200 && first != null) {
                        return if (first.ok && first.code.isNotEmpty()) {
                            store.applyVtpCreated(g.orders, first.code, first.fee, service, cod = first.cod, goods = first.goods,
                                fromDraft = true, batchId = batchId)
                            first.copy(fromDraft = true) to false
                        } else {
                            store.applyVtpError(g.orders, first.error)
                            first to false
                        }
                    }
                    if (status != 404 && error != null) {
                        store.applyVtpError(g.orders, error)
                        return VtpCreateResult(g.id, false, error = error) to false
                    }
                }
                store.applyVtpError(g.orders, outcome.reason)
                return VtpCreateResult(g.id, false, error = outcome.reason) to false
            }
            is VtpDraftApproveOutcome.Failed -> {
                store.applyVtpError(g.orders, outcome.message)
                return VtpCreateResult(g.id, false, error = outcome.message) to outcome.blocked
            }
        }
    }

    /**
     * Lên vận đơn: khách đã đẩy nháp khớp đơn hiện tại thì duyệt thẳng nháp (giữ nguyên mã nháp đã in); khách
     * chưa có nháp thì tạo vận đơn mới qua API đối tác (máy chủ ChốtLive). Nháp cũ thì báo đẩy lại trước.
     */
    fun create(list: List<Vtp.Group>) {
        if (list.isEmpty() || sending) return
        val draftItems = mutableListOf<Triple<Int, Vtp.Group, String>>()
        val staleItems = mutableListOf<Triple<Int, Vtp.Group, String>>()
        val apiItems = mutableListOf<Pair<Int, Vtp.Group>>()
        list.forEachIndexed { i, g ->
            when (val st = VtpDraftBody.status(g, service)) {
                is VtpDraftBody.Status.Pushed -> draftItems += Triple(i, g, st.code)
                is VtpDraftBody.Status.Stale -> staleItems += Triple(i, g, st.code)
                else -> apiItems += i to g
            }
        }
        if (apiItems.isNotEmpty() && (!api || !hasSender)) {
            ui.dismissSheet()
            ui.push(Route.Vtp)
            ui.notify(if (!api) "Kết nối Viettel Post (phần 1) để tạo vận đơn cho khách chưa đẩy nháp." else "Chọn điểm lấy hàng trước khi gửi.")
            return
        }
        sending = true
        val quoteFees = list.associate { g -> g.id to (quote(g)?.takeIf { it.ok }?.fee ?: 0) }
        app.scope.launch {
            client.vtpFlush(store)
            val byIndex = HashMap<Int, VtpCreateResult>()
            for ((i, g, code) in staleItems) {
                val msg = "Nháp $code là bản cũ (đơn đã sửa, thêm món hoặc khác gói dịch vụ). Bấm “Đẩy nháp VTP” để cập nhật nháp, hoặc “Xoá nháp” rồi mới tạo vận đơn."
                store.applyVtpError(g.orders, msg)
                byIndex[i] = VtpCreateResult(g.id, false, error = msg)
            }
            var blocked = false
            val batchPrefix = "vtpd_" + Clock.now.toString(36)
            draftItems.forEachIndexed { offset, (i, g, code) ->
                if (blocked) {
                    byIndex[i] = VtpCreateResult(g.id, false, error = "Viettel Post đang giới hạn gửi liên tục từ máy này, thử lại sau.")
                    return@forEachIndexed
                }
                if (offset > 0) delay(300)
                val (res, wasBlocked) = approveOneDraft(g, code, quoteFees[g.id] ?: 0, "${batchPrefix}_$offset")
                byIndex[i] = res
                if (wasBlocked) blocked = true
            }
            if (apiItems.isNotEmpty()) {
                val (error, results) = client.vtpCreate(service, apiItems.map { VtpTrack.payload(it.second) })
                if (error != null) {
                    if (draftItems.isEmpty() && staleItems.isEmpty()) {
                        sending = false
                        return@launch ui.notify(error)
                    }
                    for ((i, g) in apiItems) byIndex[i] = VtpCreateResult(g.id, false, error = error)
                } else {
                    // Máy chủ đã ghi mã vận đơn vào đơn; ghi luôn trên máy để không phải chờ đồng bộ.
                    for ((i, g) in apiItems) {
                        val res = results.firstOrNull { it.key == g.id }
                        if (res == null) {
                            byIndex[i] = VtpCreateResult(g.id, false, error = "Không nhận được phản hồi từ máy chủ")
                            continue
                        }
                        if (res.ok && res.code.isNotEmpty()) store.applyVtpCreated(g.orders, res.code, res.fee, service, cod = res.cod, goods = res.goods)
                        else if (!res.ok) store.applyVtpError(g.orders, res.error)
                        byIndex[i] = res
                    }
                }
            }
            sending = false
            result = list to list.indices.map { i -> byIndex[i] ?: VtpCreateResult(list[i].id, false, error = "Lỗi không rõ") }
        }
    }

    /** Nhãn nháp Viettel Post của khách: đã đẩy (giờ đẩy), nháp ở tài khoản khác, nháp cũ, lỗi đẩy, chưa đẩy. */
    @Composable
    fun draftTag(g: Vtp.Group): Triple<String, Color, Color>? = when (val st = VtpDraftBody.status(g, service)) {
        is VtpDraftBody.Status.Pushed -> {
            val acc = g.orders.mapNotNull { it.ship?.draftAccount }.firstOrNull { it.isNotEmpty() }
            if (hub.loggedInClients.size > 1 && acc != null && !hub.current.owns(acc)) Triple("Nháp · khác TK", C.gomInk, C.gomTag)
            else Triple("Nháp VTP" + (st.at?.let { " · ${timeText(it)}" } ?: ""), C.vtpInk, C.vtpSoft)
        }
        is VtpDraftBody.Status.Stale -> Triple("Nháp cũ", C.gomInk, C.gomTag)
        is VtpDraftBody.Status.Failed -> Triple("Lỗi đẩy nháp", C.red, C.redSoft)
        VtpDraftBody.Status.NotPushed -> if (hub.anyLoggedIn && !g.isBad) Triple("Chưa đẩy", C.muted, C.grayBadge) else null
    }

    fun matchesDraftFilter(g: Vtp.Group, f: Int) = draftFilterMatches(g, f, service)

    /** Đẩy các khách đã chọn vào mục Đơn nháp trên Viettel Post, từ máy này. Chưa đăng nhập phần 2 thì mở màn đăng nhập. */
    fun pushDrafts(list: List<Vtp.Group>) {
        if (list.isEmpty()) return
        // Tài khoản đang dùng chưa đăng nhập hoặc hết phiên mà có tài khoản khác còn phiên: dùng tài khoản đó.
        if (!hub.current.loggedIn || hub.current.sessionExpired) {
            hub.loggedInClients.firstOrNull { !it.sessionExpired }?.let { hub.select(it.accountId) }
        }
        if (!hub.current.loggedIn || hub.current.sessionExpired) {
            val expired = hub.current.sessionExpired
            ui.dismissSheet()
            ui.push(Route.VtpDraft)
            ui.notify(if (expired) "Phiên Viettel Post trên máy này đã hết. Đăng nhập lại rồi đẩy nháp."
                      else "Đăng nhập Viettel Post trên máy này (phần 2 · Đẩy nháp) rồi đẩy nháp.")
            return
        }
        val svc = service
        ui.present(0.42f) { VtpDraftPushSheet(list, svc) }
    }

    /** Xoá nháp trên Viettel Post. Chỉ bỏ nhãn trong app khi Viettel Post báo xoá được. */
    fun deleteDrafts(list: List<Vtp.Group>) {
        if (list.isEmpty() || deletingDrafts) return
        if (!hub.anyLoggedIn) {
            ui.dismissSheet()
            ui.push(Route.VtpDraft)
            ui.notify("Đăng nhập Viettel Post trên máy này (phần 2 · Đẩy nháp) rồi xoá nháp.")
            return
        }
        val count = list.sumOf { VtpDraftBody.codes(it).size }
        ui.confirm = ConfirmItem("Xoá $count nháp trên Viettel Post?",
            "Nháp bị xoá khỏi mục Đơn nháp trên viettelpost.vn. Đơn trong app vẫn ở Chờ gửi.", "Xoá nháp") {
            deletingDrafts = true
            app.scope.launch {
                val failed = mutableListOf<String>()
                for (g in list) {
                    // Mỗi mã nháp xoá bằng đúng tài khoản đã đẩy mã đó.
                    val left = hub.deleteDrafts(g)
                    val name = g.summary.receiver.ifEmpty { g.customer.nickname }
                    failed += left.map { "$name (${it.first}): ${it.second}" }
                    if (left.isEmpty()) store.clearDraft(g.orders)
                }
                deletingDrafts = false
                ui.notify(if (failed.isEmpty()) "Đã xoá nháp trên Viettel Post."
                          else "Chưa xoá được ${failed.size} nháp:\n" + failed.take(5).joinToString("\n"))
            }
        }
    }

    /** Sao chép mã nháp rồi mở viettelpost.vn để tìm trong mục Đơn nháp. */
    fun viewDraft(codes: List<String>) {
        clipboard.setText(AnnotatedString(codes.joinToString(" ")))
        ui.notify("Đã sao chép mã nháp. Trên viettelpost.vn mở Quản lý vận đơn › Đơn nháp rồi dán mã để tìm.")
        uri.openUri("https://viettelpost.vn/")
    }

    /** Bỏ nhãn nháp trong app, không gọi Viettel Post (dùng khi đã tự xoá nháp trên web). */
    fun clearDraftLabel(g: Vtp.Group) {
        ui.confirm = ConfirmItem("Bỏ nhãn nháp?", "Chỉ bỏ nhãn trong app. Nếu nháp còn trên viettelpost.vn thì phải tự xoá ở đó.", "Bỏ nhãn") {
            store.clearDraft(g.orders)
        }
    }

    fun export(list: List<Vtp.Group>) {
        if (list.isEmpty()) return
        val now = Clock.now
        val name = Vtp.fileName(now)
        val bytes = Vtp.xlsx(list, service)
        val file = try {
            ShareFile.write(app, name, bytes)
        } catch (e: Exception) {
            return ui.notify("Không tạo được file Excel: ${e.message ?: "lỗi ghi file"}")
        }
        store.markExported(list.flatMap { it.orders }, now)
        ui.dismissSheet()
        if (ShareFile.saveToDownloads(app, name, bytes)) {
            Toast.makeText(app, "Đã lưu $name vào thư mục Tải xuống", Toast.LENGTH_LONG).show()
        }
        ShareFile.present(app, file)
    }

    Box(Modifier.fillMaxWidth().height(sheetHeight(LocalSheetMaxHeight.current * 0.08f))) {
        val res = result
        val detail = detailId?.let { id -> groups.firstOrNull { it.id == id } }
        if (res != null) {
            VtpResultView(res.first, res.second)
        } else if (detail != null) {
            val pushed = VtpDraftBody.status(detail, service) is VtpDraftBody.Status.Pushed
            DraftDetail(detail, quote(detail), isQuoting(detail), service, sending,
                canCreate = api || (pushed && hub.anyLoggedIn), approve = pushed && hub.anyLoggedIn,
                onBack = { detailId = null }, onCreate = { create(listOf(detail)) }, onPush = { pushDrafts(listOf(detail)) },
                draftBox = {
                    DraftBox(detail, service, hub, deletingDrafts, onView = { viewDraft(it) }, onDelete = { deleteDrafts(listOf(detail)) },
                        onPush = { pushDrafts(listOf(detail)) }, onClear = { clearDraftLabel(detail) })
                })
        } else {
            val bad = groups.count { it.isBad }
            Column(Modifier.fillMaxSize()) {
                Row(Modifier.fillMaxWidth().padding(horizontal = Metrics.GUTTER.dp), verticalAlignment = Alignment.Top) {
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        T(if (api) "Nháp vận đơn" else "Xuất Viettel Post", 20f, BV.HEAVY, C.ink, track = -0.3f)
                        T(if (api) "${groups.size} nháp · ${groups.size - bad} sẵn sàng${if (bad > 0) " · $bad cần sửa" else ""}"
                        else "${groups.size - bad} khách sẵn sàng gửi${if (bad > 0) " · $bad khách cần sửa" else ""}",
                            13f, BV.MEDIUM, C.muted, shrink = true, minScale = 0.85f)
                    }
                    SheetClose()
                }
                // Hàng lọc nhanh theo nháp: chỉ hiện khi đã đăng nhập đẩy nháp hoặc có khách mang nhãn nháp.
                val showDrafts = hub.anyLoggedIn || groups.any { VtpDraftBody.status(it, service) !is VtpDraftBody.Status.NotPushed }
                if (showDrafts) {
                    Row(Modifier.padding(top = 12.dp).fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = Metrics.GUTTER.dp),
                        horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        for ((id, title) in listOf(0 to "Tất cả", 1 to "Chưa đẩy", 2 to "Nháp VTP", 3 to "Cần sửa")) {
                            val n = if (id == 0) groups.size else groups.count { matchesDraftFilter(it, id) }
                            val on = draftFilter == id
                            Box(Modifier.height(30.dp).capsule(if (on) C.ink else C.card, if (on) null else C.line).plainTap {
                                draftFilter = id
                                touched = false
                            }.padding(horizontal = 12.dp), contentAlignment = Alignment.Center) {
                                T("$title $n", 12.5f, BV.BOLD, if (on) C.card else C.muted, maxLines = 1)
                            }
                        }
                    }
                }
                Row(Modifier.fillMaxWidth().padding(start = (Metrics.GUTTER + 4).dp, end = (Metrics.GUTTER + 4).dp, top = 12.dp, bottom = 8.dp),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    T("ĐÃ CHỌN ${chosen.size}", 12f, BV.BOLD, C.muted, Modifier.weight(1f), track = 0.4f)
                    val withDraft = groups.filter { chosen.contains(it.id) && VtpDraftBody.codes(it).isNotEmpty() }
                    if (withDraft.isNotEmpty()) {
                        T(if (deletingDrafts) "Đang xoá…" else "Xoá nháp (${withDraft.size})", 13f, BV.BOLD, C.red,
                            Modifier.plainTap(!deletingDrafts) { deleteDrafts(withDraft) })
                    }
                    T(if (chosen.size == okIds.size && chosen.isNotEmpty()) "Bỏ chọn tất cả" else "Chọn tất cả", 13f, BV.BOLD,
                        if (okIds.isEmpty()) C.faint else C.accent, Modifier.plainTap(okIds.isNotEmpty()) {
                            selected = if (chosen.size == okIds.size) emptySet() else okIds
                            touched = true
                        })
                }
                Column(
                    Modifier.weight(1f).verticalScroll(rememberScrollState())
                        .padding(start = Metrics.GUTTER.dp, end = Metrics.GUTTER.dp, bottom = 12.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    if (groups.isEmpty()) EmptyNote("Chưa có đơn nào đã duyệt.")
                    if (api && groups.isNotEmpty()) {
                        T("Viettel Post chưa nhận đơn nào. Soát xong rồi mới bấm Tạo.", 12.5f, BV.MEDIUM, C.muted,
                            Modifier.padding(horizontal = 4.dp))
                    }
                    if (groups.isNotEmpty() && visible.isEmpty()) EmptyNote("Không có khách nào ở mục này.", 12f)
                    for (g in visible) {
                        androidx.compose.runtime.key(g.id) {
                            val on = chosen.contains(g.id)
                            DraftRow(g, on, api, quote(g), isQuoting(g), draftTag(g), detailLink = api || hub.anyLoggedIn, onToggle = {
                                if (!g.isBad) {
                                    selected = if (on) chosen - g.id else chosen + g.id
                                    touched = true
                                }
                            }, onDetail = { detailId = g.id })
                        }
                    }
                }

                // Chân bảng
                val picked = groups.filter { chosen.contains(it.id) }
                val total = picked.sumOf { it.summary.cod }
                val busy = api && picked.any { isQuoting(it) }
                val feeTotal = picked.sumOf { g -> quote(g)?.takeIf { it.ok }?.fee ?: 0 }
                val serviceName = (Vtp.services.firstOrNull { it.first == service } ?: Vtp.services[0]).let { "${it.first} · ${it.second}" }
                Column(Modifier.fillMaxWidth().background(C.card)) {
                    HairLine()
                    Column(Modifier.padding(start = Metrics.GUTTER.dp, end = Metrics.GUTTER.dp, top = 14.dp),
                        verticalArrangement = Arrangement.spacedBy(14.dp)) {
                        if (picking) {
                            Column(Modifier.fillMaxWidth().cardStyle(14f)) {
                                Vtp.services.forEachIndexed { i, s ->
                                    if (i > 0) HairLine()
                                    val on = s.first == service
                                    Row(Modifier.fillMaxWidth().height(46.dp).background(if (on) C.peachSoft else Color.Transparent)
                                        .tap {
                                            settings.updateVtpService(s.first)
                                            picking = false
                                        }.padding(horizontal = 14.dp), verticalAlignment = Alignment.CenterVertically) {
                                        T("${s.first} · ${s.second}", 14f, if (on) BV.BOLD else BV.SEMIBOLD, modifier = Modifier.weight(1f), maxLines = 1)
                                        if (on) Icon(IconName.CHECK, 14f, 2.8f, C.accent)
                                    }
                                }
                            }
                        }
                        Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                                FieldLabel("Dịch vụ")
                                Row(Modifier.height(38.dp).cardStyle(12f, C.field).tap { picking = !picking }.padding(horizontal = 12.dp),
                                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                                    Box(Modifier.weight(1f, fill = false)) { T(serviceName, 14f, BV.BOLD, shrink = true, minScale = 0.8f) }
                                    Icon(if (picking) IconName.CHEVRON_DOWN else IconName.CHEVRON_UP, 14f, color = C.muted)
                                }
                            }
                            Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                T(if (api) "Tổng thu hộ · ${chosen.size} khách" else "Tổng thu hộ", 12f, BV.SEMIBOLD, C.muted, maxLines = 1)
                                T(money(total), 22f, BV.HEAVY, C.ink, track = -0.4f, maxLines = 1)
                                if (api && feeTotal > 0) T("Cước dự tính ${money(feeTotal)}", 12f, BV.SEMIBOLD, C.muted, maxLines = 1)
                            }
                        }
                        // Mọi khách đã chọn đều có nháp khớp: duyệt nháp được cả khi chưa kết nối phần 1.
                        val allPushed = picked.isNotEmpty() && picked.all { VtpDraftBody.status(it, service) is VtpDraftBody.Status.Pushed }
                        val approveOnly = !api && hub.anyLoggedIn && allPushed
                        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            // Đẩy nháp: đơn vào mục Đơn nháp trên viettelpost.vn, Viettel Post chưa nhận đơn.
                            Row(Modifier.weight(1f).height(52.dp).alpha(if (chosen.isNotEmpty() && !sending) 1f else 0.5f)
                                .capsule(C.card, C.vtpBrand, 1.5f).tap(chosen.isNotEmpty() && !sending) { pushDrafts(picked) }
                                .padding(horizontal = 8.dp),
                                horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterHorizontally), verticalAlignment = Alignment.CenterVertically) {
                                Icon(IconName.ARROW_RIGHT, 14f, 2.4f, C.vtpBrand)
                                T("Đẩy nháp VTP", 14.5f, BV.BOLD, C.vtpBrand, shrink = true, minScale = 0.8f)
                            }
                            if (api || approveOnly) {
                                PrimaryButton(
                                    if (sending) (if (allPushed) "Đang duyệt…" else "Đang tạo…") else if (busy) "Đang tính cước…"
                                    else if (allPushed) "Duyệt ${chosen.size} nháp" else "Tạo ${chosen.size} vận đơn",
                                    Modifier.weight(1.3f), IconName.TRUCK, 15f, enabled = chosen.isNotEmpty() && !sending && !busy,
                                ) { create(picked) }
                            } else {
                                PrimaryButton("Xuất Excel · ${chosen.size}", Modifier.weight(1.3f), IconName.DOWNLOAD, 15f,
                                    enabled = chosen.isNotEmpty()) { export(picked) }
                            }
                        }
                        if (api || approveOnly) {
                            val can = chosen.isNotEmpty() && !sending
                            Box(Modifier.fillMaxWidth().padding(top = 0.dp), contentAlignment = Alignment.Center) {
                                T("Hoặc xuất file Excel như cũ", 13f, BV.BOLD, if (can) C.accent else C.faint,
                                    Modifier.plainTap(can) { export(picked) })
                            }
                        }
                    }
                }
            }
        }
    }
}

/** Một nháp trong danh sách: tên, tiền thu hộ, địa chỉ, cước dự tính. */
@Composable
private fun DraftRow(
    g: Vtp.Group, on: Boolean, api: Boolean, q: VtpQuote?, quoting: Boolean,
    /** Nhãn nháp Viettel Post (Nháp VTP, Nháp cũ, Lỗi đẩy nháp, Chưa đẩy). */
    draftTag: Triple<String, Color, Color>?,
    /** Hiện "Soát chi tiết ›" (khi có phần 1 hoặc đã đăng nhập đẩy nháp). */
    detailLink: Boolean,
    onToggle: () -> Unit, onDetail: () -> Unit,
) {
    val ui = LocalAppUI.current
    val s = g.summary
    val start = Clock.startOfDay(Clock.today())
    val olderDay = g.orders.firstOrNull { it.lastTs < start }?.let { dayMonth(it.lastTs) }
    Row(
        Modifier.fillMaxWidth().cardStyle(16f, if (g.isBad) C.badRow else C.card).plainTap(onClick = onToggle)
            .padding(horizontal = 14.dp, vertical = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Box(Modifier.padding(top = 1.dp)) { TickCircle(on && !g.isBad, !g.isBad) }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(5.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                T(s.receiver.ifEmpty { g.customer.nickname }, 15f, BV.BOLD, modifier = Modifier.weight(1f), maxLines = 1)
                T(money(s.cod), 15f, BV.HEAVY, if (g.isBad) C.muted else C.ink, maxLines = 1)
            }
            val tags = buildList {
                if (g.isBad) add(Triple("cần sửa", C.red, C.redSoft))
                if (draftTag != null) add(draftTag)
                if (g.orders.size > 1) add(Triple("gộp ${g.orders.size} đơn", C.gomInk, C.gomTag))
                if (olderDay != null) add(Triple("duyệt $olderDay", C.muted, C.grayBadge))
                if (s.allPaid) add(Triple("bank đủ", C.green, C.greenSoft))
                if (s.address.ok && s.address.isOld) add(Triple("địa chỉ cũ", C.muted, C.grayBadge))
            }
            if (tags.isNotEmpty()) {
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    for ((text, color, fill) in tags) ShipTag(text, color, fill, 11f, 20f, 8f, BV.BOLD)
                }
            }
            val contact = listOf(s.phone, s.address.line).filter { it.isNotEmpty() }.joinToString(" · ")
            if (contact.isNotEmpty()) T(contact, 12.5f, BV.MEDIUM, C.muted, lineHeight = 17f)
            if (g.isBad) {
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    T(s.problems.joinToString(" · "), 12.5f, BV.SEMIBOLD, C.red, Modifier.weight(1f, fill = false), lineHeight = 17f)
                    T("Sửa", 12.5f, BV.BOLD, C.accent, Modifier.plainTap {
                        ui.dismissSheet()
                        ui.push(Route.AddressEdit(g.customer.id))
                    })
                }
            } else {
                // Ô "Viettel Post hiểu": phường/tỉnh họ đọc ra từ dòng địa chỉ, hỏi trước khi tạo đơn.
                if (api) {
                    if (quoting) {
                        T("Đang tính cước và kiểm địa chỉ với Viettel Post…", 12f, BV.MEDIUM, C.muted)
                    } else if (q != null) {
                        if (q.parsed.isNotEmpty() && q.addrOk != false) {
                            Box(Modifier.fillMaxWidth().clip(rounded(10f)).background(C.greenSoft).padding(horizontal = 10.dp, vertical = 7.dp)) {
                                T("✓ Viettel Post hiểu: ${q.parsed} · đúng", 12f, BV.SEMIBOLD, C.green, lineHeight = 16f)
                            }
                        }
                        if (!q.ok) T(q.error, 12f, BV.SEMIBOLD, C.red)
                    }
                }
                val who = if (s.senderPays) "Shop trả ship" else "Khách trả ship"
                val small = if (s.shipFee > 0) {
                    " (${if (s.allPaid) "thu tiền ship" else "thu hộ thấp hơn ship"}, COD +${money(s.shipFee)}${if (s.feeIsReal) "" else " tạm tính"})"
                } else ""
                T(listOf(who + small, weightText(s.weightG), s.address.shortArea).filter { it.isNotEmpty() }.joinToString(" · "),
                    12f, BV.MEDIUM, C.muted, lineHeight = 16f)
                if (api || detailLink) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        val fee = if (!api) "" else if (quoting) "Đang tính cước…" else if (q?.ok == true) "Cước dự tính ${money(q.fee)}" else "Cước chưa tính"
                        T(fee, 12.5f, BV.BOLD, C.ink, Modifier.weight(1f), shrink = true, minScale = 0.8f)
                        T("Soát chi tiết ›", 12.5f, BV.BOLD, C.accent, Modifier.plainTap(onClick = onDetail), maxLines = 1)
                    }
                }
            }
            if (!g.isBad) {
                g.orders.firstNotNullOfOrNull { VtpTrack.lastError(it) }?.let {
                    T("Lần trước ViettelPost báo: $it", 12f, BV.SEMIBOLD, C.red, lineHeight = 16f)
                }
            }
            g.recentExported.firstOrNull()?.ship?.exportedAt?.let {
                T("Khách đã có vận đơn xuất ${dayMonth(it)}", 12f, BV.SEMIBOLD, C.gomInk)
            }
        }
    }
}

/** Soát một nháp trước khi tạo vận đơn. */
@Composable
private fun DraftDetail(
    g: Vtp.Group, q: VtpQuote?, busy: Boolean, service: String, sending: Boolean,
    /** Có nút tạo / duyệt (phần 1 đã kết nối, hoặc nháp khớp và máy đã đăng nhập đẩy nháp). */
    canCreate: Boolean,
    /** Nút chính là duyệt nháp (giữ nguyên mã nháp) thay vì tạo vận đơn mới. */
    approve: Boolean,
    onBack: () -> Unit, onCreate: () -> Unit, onPush: () -> Unit,
    draftBox: @Composable () -> Unit,
) {
    val ui = LocalAppUI.current
    val s = g.summary
    val name = s.receiver.ifEmpty { g.customer.nickname }
    val codes = g.orders.mapNotNull { it.code }.filter { it.isNotEmpty() }.joinToString(" + ")
    val parsed = q?.parsed ?: ""
    val mismatch = q?.addrOk == false
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(start = Metrics.GUTTER.dp, end = Metrics.GUTTER.dp, bottom = 12.dp), verticalAlignment = Alignment.Top) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                T("Nháp · $name", 20f, BV.HEAVY, C.ink, track = -0.3f, shrink = true, minScale = 0.8f)
                if (codes.isNotEmpty()) T(codes, 12.5f, BV.MEDIUM, C.muted, maxLines = 2)
            }
            SheetClose()
        }
        Column(
            Modifier.weight(1f).verticalScroll(rememberScrollState())
                .padding(start = Metrics.GUTTER.dp, end = Metrics.GUTTER.dp, bottom = 12.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            DetailBox("NGƯỜI NHẬN") {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    T(name, 16f, BV.BOLD, modifier = Modifier.weight(1f), maxLines = 1)
                    T("Sửa", 13f, BV.BOLD, C.accent, Modifier.plainTap {
                        ui.dismissSheet()
                        ui.push(Route.AddressEdit(g.customer.id))
                    })
                }
                T(s.phone.ifEmpty { "Chưa có số điện thoại" }, 13.5f, BV.SEMIBOLD, if (s.phone.isEmpty()) C.red else C.ink)
                KV("App ghi", s.address.line.ifEmpty { "Chưa có địa chỉ" })
                if (busy) {
                    KV("VTP hiểu", "Đang kiểm…")
                } else if (parsed.isNotEmpty()) {
                    KV("VTP hiểu", parsed)
                    T(if (mismatch) "Khác phường hoặc tỉnh. Sửa địa chỉ trước khi tạo." else "✓ Khớp phường và tỉnh",
                        12.5f, BV.BOLD, if (mismatch) C.red else C.green)
                } else if (!g.isBad) {
                    T("Chưa đối chiếu được địa chỉ với Viettel Post.", 12.5f, BV.SEMIBOLD, C.muted)
                }
                if (g.isBad) T(s.problems.joinToString(" · "), 12.5f, BV.SEMIBOLD, C.red)
            }
            DetailBox("HÀNG & TIỀN") {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    T("Tên hàng", 13f, BV.MEDIUM, C.muted, maxLines = 1)
                    T("${Vtp.GOODS_NAME} · ${maxOf(s.qty, 1)} món", 13f, BV.SEMIBOLD, C.ink, Modifier.weight(1f), maxLines = 1, align = TextAlign.End)
                    // Sửa cân nặng, kích thước, COD, tiền cọc, người trả cước của đúng các đơn trong nháp này.
                    val last = g.orders.lastOrNull()
                    if (last != null && !sending) {
                        T("Sửa", 13f, BV.BOLD, C.accent, Modifier.plainTap {
                            val ids = g.orders.map { it.id }.toSet()
                            ui.present(0.42f) { ShipReviewSheet(last.id, ids) }
                        })
                    }
                }
                KV("Giá trị hàng", money(s.goods))
                KV("Người trả cước", if (s.senderPays) "Shop (người gửi)" else "Người nhận")
                KV("Trọng lượng", weightText(s.weightG))
                s.size?.let { KV("Kích thước", "${it.first} × ${it.second} × ${it.third} cm") }
                HairLine()
                if (s.shipFee > 0) KV(if (s.feeIsReal) "Tiền ship cộng vào thu hộ" else "Tiền ship cộng vào thu hộ (tạm tính)", money(s.shipFee))
                KV("Thu hộ (COD)", money(s.cod), strong = true)
            }
            draftBox()
            if (q != null || busy || (canCreate && !approve)) DetailBox("CƯỚC DỰ TÍNH · $service") {
                if (busy) {
                    T("Đang tính cước…", 13f, BV.MEDIUM, C.muted)
                } else if (q?.ok == true) {
                    KV("Tổng cước", money(q.fee), strong = true)
                    T("Chưa tạo đơn. Cước thật do Viettel Post chốt khi nhận hàng.", 12f, BV.MEDIUM, C.muted)
                } else {
                    T(q?.error ?: "Cước chưa tính", 13f, BV.SEMIBOLD, if (q == null) C.muted else C.red)
                }
            }
            DetailBox("GHI CHÚ CHO BƯU TÁ") {
                T(s.note.ifEmpty { "Trống" }, 13.5f, BV.MEDIUM, if (s.note.isEmpty()) C.muted else C.ink)
            }
        }
        Column(Modifier.fillMaxWidth().background(C.card)) {
            HairLine()
            Row(Modifier.padding(start = Metrics.GUTTER.dp, end = Metrics.GUTTER.dp, top = 14.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlineButton("Để nháp", Modifier.weight(1f), height = 52f, onClick = onBack)
                if (canCreate) {
                    PrimaryButton(
                        if (sending) (if (approve) "Đang duyệt nháp…" else "Đang tạo vận đơn…") else if (busy && !approve) "Đang tính cước…"
                        else if (approve) "Duyệt nháp lên đơn" else "Tạo vận đơn này",
                        Modifier.weight(2f), IconName.TRUCK, 15f, enabled = !g.isBad && !sending && (approve || !busy), onClick = onCreate)
                } else {
                    PrimaryButton("Đẩy nháp VTP", Modifier.weight(2f), IconName.ARROW_RIGHT, 15f, enabled = !g.isBad && !sending, onClick = onPush)
                }
            }
        }
    }
}

/** Ô "Nháp Viettel Post" trong chi tiết khách: mã nháp, giờ đẩy, tài khoản, và các nút đẩy / xoá / xem. */
@Composable
private fun DraftBox(
    g: Vtp.Group, service: String, hub: VtpDraftHub, deleting: Boolean,
    onView: (List<String>) -> Unit, onDelete: () -> Unit, onPush: () -> Unit, onClear: () -> Unit,
) {
    val st = VtpDraftBody.status(g, service)
    val codes = VtpDraftBody.codes(g)
    val ship = g.orders.mapNotNull { it.ship }.firstOrNull { !it.draftCode.isNullOrEmpty() }
    val otherAccount = ship?.draftAccount?.takeIf {
        st is VtpDraftBody.Status.Pushed && hub.loggedInClients.size > 1 && it.isNotEmpty() && !hub.current.owns(it)
    }
    val enabled = !g.isBad && !deleting
    DetailBox("NHÁP VIETTEL POST") {
        when (st) {
            VtpDraftBody.Status.NotPushed ->
                T("Chưa đẩy nháp. Bấm Đẩy nháp để đơn vào mục Đơn nháp trên viettelpost.vn (chưa gọi bưu tá).", 12.5f, BV.MEDIUM, C.muted)
            is VtpDraftBody.Status.Failed -> T("Lần đẩy trước lỗi: ${st.error}", 12.5f, BV.SEMIBOLD, C.red)
            else -> {
                KV("Mã nháp", codes.joinToString(", "), strong = true)
                ship?.draftAt?.let { KV("Đẩy lúc", "${timeText(it)} ${dayMonth(it)}") }
                ship?.draftAccount?.takeIf { it.isNotEmpty() }?.let { KV("Tài khoản", it) }
                when {
                    st is VtpDraftBody.Status.Stale ->
                        T("Nháp trên Viettel Post là bản cũ: đơn đã sửa hoặc thêm đơn sau khi đẩy. Đẩy lại để thay.", 12.5f, BV.BOLD, C.gomInk)
                    otherAccount != null ->
                        T("Nháp đang nằm ở $otherAccount, khác tài khoản đang chọn (${hub.current.accountLabel}).", 12.5f, BV.BOLD, C.gomInk)
                    else -> T("✓ Khớp với đơn hiện tại", 12.5f, BV.BOLD, C.green)
                }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            when (st) {
                is VtpDraftBody.Status.Pushed -> {
                    OutlineButton("Xem trên VTP", Modifier.weight(1f), enabled = enabled) { onView(codes) }
                    OutlineButton(if (deleting) "Đang xoá…" else "Xoá nháp", Modifier.weight(1f), color = C.red, enabled = enabled, onClick = onDelete)
                }
                is VtpDraftBody.Status.Stale -> {
                    OutlineButton("Đẩy lại nháp", Modifier.weight(1f), color = C.vtpBrand, enabled = enabled, onClick = onPush)
                    OutlineButton(if (deleting) "Đang xoá…" else "Xoá nháp", Modifier.weight(1f), color = C.red, enabled = enabled, onClick = onDelete)
                }
                else -> OutlineButton("Đẩy nháp VTP", Modifier.weight(1f), color = C.vtpBrand, enabled = enabled, onClick = onPush)
            }
        }
        if (otherAccount != null) OutlineButton("Chuyển sang TK đang dùng", color = C.vtpBrand, enabled = enabled, onClick = onPush)
        if (codes.isNotEmpty()) T("Bỏ nhãn nháp (đã tự xoá trên web)", 12.5f, BV.BOLD, C.muted, Modifier.plainTap(onClick = onClear))
    }
}

// MARK: - Lưu và chia sẻ file

/** Ghi file Excel ra máy rồi mở bảng chia sẻ của Android để gửi đi hoặc lưu chỗ khác. */
object ShareFile {
    private const val XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

    fun write(context: Context, name: String, bytes: ByteArray): File {
        val dir = File(context.cacheDir, "exports").apply { mkdirs() }
        // Dọn file xuất cũ hơn một ngày.
        dir.listFiles()?.filter { System.currentTimeMillis() - it.lastModified() > 86_400_000L }?.forEach { it.delete() }
        return File(dir, name).apply { writeBytes(bytes) }
    }

    /** Lưu thêm một bản vào thư mục Tải xuống (Android 10 trở lên, không cần xin quyền). */
    fun saveToDownloads(context: Context, name: String, bytes: ByteArray): Boolean {
        if (Build.VERSION.SDK_INT < 29) return false
        return try {
            val values = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, name)
                put(MediaStore.Downloads.MIME_TYPE, XLSX)
                put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
            }
            val uri = context.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: return false
            context.contentResolver.openOutputStream(uri)?.use { it.write(bytes) } ?: return false
            true
        } catch (e: Exception) {
            false
        }
    }

    fun present(context: Context, file: File) {
        try {
            val uri = FileProvider.getUriForFile(context, context.packageName + ".files", file)
            val send = Intent(Intent.ACTION_SEND).setType(XLSX).putExtra(Intent.EXTRA_STREAM, uri)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            send.clipData = ClipData.newRawUri(file.name, uri)
            context.startActivity(Intent.createChooser(send, "Gửi file Viettel Post")
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION))
        } catch (e: Exception) {
            Toast.makeText(context, "Không mở được bảng chia sẻ. File vẫn nằm trong thư mục Tải xuống.", Toast.LENGTH_LONG).show()
        }
    }
}

/** Lọc nhanh theo nháp: 1 chưa đẩy, 2 nháp VTP (kể cả nháp cũ), 3 cần sửa; còn lại là tất cả. */
private fun draftFilterMatches(g: Vtp.Group, f: Int, service: String): Boolean {
    val st = VtpDraftBody.status(g, service)
    return when (f) {
        1 -> st is VtpDraftBody.Status.NotPushed && !g.isBad
        2 -> st is VtpDraftBody.Status.Pushed || st is VtpDraftBody.Status.Stale
        3 -> st is VtpDraftBody.Status.Failed || g.isBad
        else -> true
    }
}
