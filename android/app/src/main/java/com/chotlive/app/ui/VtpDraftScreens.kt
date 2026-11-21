package com.chotlive.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.chotlive.app.ChotLiveApp
import com.chotlive.app.model.Vtp
import com.chotlive.app.model.VtpDraftBody
import com.chotlive.app.net.VtpDraftClient
import com.chotlive.app.net.VtpDraftError
import com.chotlive.app.net.VtpDraftHub
import com.chotlive.app.net.VtpDraftKho
import com.chotlive.app.net.VtpMask
import com.chotlive.app.net.vtpConnected
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** Tiêu đề hai phần trong màn Kết nối ViettelPost: "1 Tạo vận đơn", "2 Đẩy nháp". */
@Composable
fun VtpSectionHeader(number: Int, title: String, hint: String, color: Color = C.accent) {
    Row(Modifier.fillMaxWidth().padding(top = 6.dp), verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Box(Modifier.size(22.dp).clip(rounded(7f)).background(color), contentAlignment = Alignment.Center) {
            T("$number", 12f, BV.HEAVY, Color.White)
        }
        T(title, 15f, BV.HEAVY, modifier = Modifier.weight(1f))
        T(hint, 12f, BV.SEMIBOLD, C.muted, maxLines = 1)
    }
}

@Composable
private fun DraftCard(spacing: Float = 12f, content: @Composable () -> Unit) {
    Column(Modifier.fillMaxWidth().cardStyle(20f).padding(16.dp), verticalArrangement = Arrangement.spacedBy(spacing.dp)) { content() }
}

@Composable
private fun ErrorText(c: VtpDraftClient) {
    val e = c.lastError
    if (!e.isNullOrEmpty()) T(e, 12.5f, BV.SEMIBOLD, C.red)
}

/** Phần 2 đăng nhập khác số với tài khoản đối tác ở phần 1: nháp và vận đơn sẽ nằm ở hai tài khoản. */
private fun partnerMismatch(app: ChotLiveApp, active: VtpDraftClient, prefix: Boolean): String? {
    val partner = app.client.vtp?.phone
    if (!app.client.vtpConnected || partner.isNullOrEmpty()) return null
    if (VtpDraftClient.phonesMatch(partner, active.login.ifEmpty { active.userName }) != false) return null
    val shown = active.phone.ifEmpty { active.accountLabel }
    return if (prefix) "Tài khoản đang dùng để đẩy nháp ($shown) khác phần 1 (${VtpMask.text(partner)}). Nháp sẽ nằm ở tài khoản khác với vận đơn."
    else "Khác phần 1 (${VtpMask.text(partner)}): nháp sẽ vào tài khoản $shown."
}

// MARK: - Tôi › ViettelPost › phần 2 "Đẩy nháp"

/**
 * Đăng nhập tài khoản Viettel Post NGAY TRÊN MÁY này để đẩy đơn nháp. Khác phần 1 (token đối tác lưu trên máy
 * chủ để tạo vận đơn): phiên này chỉ nằm trên điện thoại, mật khẩu và OTP không lưu ở đâu.
 */
@Composable
fun VtpDraftSection() {
    val app = LocalApp.current
    val hub = app.vtpDrafts
    val ui = LocalAppUI.current
    val uri = LocalUriHandler.current
    val active = hub.current
    var user by remember(hub.currentId) { mutableStateOf("") }
    var password by remember(hub.currentId) { mutableStateOf("") }
    var code by remember(hub.currentId) { mutableStateOf("") }
    var sentAt by remember(hub.currentId) { mutableLongStateOf(0L) }
    val adding = !active.loggedIn && hub.loggedInClients.any { it !== active }

    /** Tài khoản đầu tiên: gợi ý số ở phần 1 (chỉ khi chưa che). Tài khoản thêm sau: để trống cho gõ số khác. */
    fun prefillUser() {
        if (user.isNotEmpty()) return
        if (active.login.isNotEmpty()) {
            user = active.login
        } else if (hub.loggedInClients.isEmpty()) {
            val p = app.client.vtp?.phone
            if (p != null && !p.contains("•") && !p.contains("*") && p.count { it.isDigit() } >= 9) user = p
        }
    }

    /** Chưa tự chọn kho: lấy kho trùng điểm lấy hàng ở phần 1, chỉ khi tài khoản đẩy nháp trùng phần 1 (hoặc chưa rõ số). */
    fun matchKhoToSender() {
        if (active.khoPicked) return
        val s = app.client.vtp?.sender ?: return
        val partner = app.client.vtp?.phone
        if (!partner.isNullOrEmpty() && VtpDraftClient.phonesMatch(partner, active.login.ifEmpty { active.userName }) == false) return
        fun norm(x: String) = x.lowercase().filter { it.isLetterOrDigit() }
        val k = active.kho.firstOrNull { s.address.isNotEmpty() && norm(it.address) == norm(s.address) }
            ?: active.kho.firstOrNull { s.name.isNotEmpty() && norm(it.name) == norm(s.name) }
        if (k != null && k.id != active.khoId) active.suggestKho(k.id)
    }

    fun afterLogin(c: VtpDraftClient) = hub.didLogin(c)

    LaunchedEffect(hub.currentId, active.loggedIn) {
        prefillUser()
        if (active.loggedIn && !active.sessionExpired && (active.kho.isEmpty() || !active.khoLoadedThisSession)) active.loadKho()
        matchKhoToSender()
    }
    LaunchedEffect(active.kho) { matchKhoToSender() }

    Column(verticalArrangement = Arrangement.spacedBy(Metrics.GAP.dp)) {
        if (hub.clients.size > 1) {
            DraftCard(4f) {
                Row(Modifier.padding(bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    T("Tài khoản đẩy nháp", 15f, BV.BOLD, modifier = Modifier.weight(1f))
                    T("chạm để dùng", 12f, BV.SEMIBOLD, C.muted)
                }
                for (c in hub.clients) VtpDraftAccountRow(c, c.accountId == hub.currentId) { hub.select(c.accountId) }
                if (hub.clients.all { it.loggedIn }) {
                    Row(Modifier.plainTap { hub.addAccount() }.padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Icon(IconName.PLUS, 14f, 2.4f, C.accent)
                        T("Thêm tài khoản Viettel Post", 13.5f, BV.BOLD, C.accent)
                    }
                }
            }
        }

        val step = active.otpStep
        if (step != null) {
            // OTP
            val hasPhone = step.phone.count { it.isDigit() } >= 9
            val hasEmail = step.email.isNotEmpty()
            DraftCard {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    T("Xác minh thiết bị", 15f, BV.BOLD, modifier = Modifier.weight(1f))
                    Badge("Bước 2/2", C.accent, C.peachSoft)
                }
                T(if (step.function == "SSO_OTP_FALLBACK") "Viettel Post cần xác minh bằng mã OTP thay cho mã captcha. Chọn nơi nhận mã:"
                  else "Viettel Post thấy máy này đăng nhập lần đầu nên cần mã OTP. Chọn nơi nhận mã:", 12.5f, BV.MEDIUM, C.muted)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    @Composable
                    fun channel(type: String, title: String, modifier: Modifier) {
                        val on = step.sentType == type
                        Box(modifier.height(40.dp).clip(rounded(12f)).background(if (on) C.peachSoft else C.field).plainTap {
                            if (active.loading) return@plainTap
                            val c = active
                            app.scope.launch {
                                c.sendOtp(type)
                                if (hub.currentId == c.accountId && c.otpStep?.sentType == type) sentAt = System.currentTimeMillis()
                            }
                        }, contentAlignment = Alignment.Center) { T(title, 13f, BV.BOLD, if (on) C.accent else C.ink, shrink = true, minScale = 0.8f) }
                    }
                    if (hasPhone || !hasEmail) channel("PHONE", "SMS " + VtpMask.text(step.phone), Modifier.weight(1f))
                    if (hasEmail) channel("EMAIL", "Email " + VtpDraftClient.maskEmail(step.email), Modifier.weight(1f))
                }
                if (step.sentType != null) {
                    LabeledField("Mã OTP", "6 số", code, { code = it }, KeyboardType.NumberPassword, capitalize = false)
                    // Gửi lại mã sau 60 giây, đếm ngược từng giây.
                    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
                    LaunchedEffect(sentAt) {
                        while (true) {
                            now = System.currentTimeMillis()
                            if (now - sentAt > 61_000) break
                            delay(1000)
                        }
                    }
                    val left = maxOf(0L, 60 - (now - sentAt) / 1000)
                    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                        if (left > 0) T("Gửi lại mã sau 0:%02d".format(left), 12.5f, BV.SEMIBOLD, C.muted)
                        else T("Gửi lại mã", 13f, BV.BOLD, C.accent, Modifier.plainTap {
                            val c = active
                            val type = step.sentType
                            app.scope.launch {
                                c.sendOtp(type)
                                if (hub.currentId == c.accountId) sentAt = System.currentTimeMillis()
                            }
                        })
                    }
                }
                ErrorText(active)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlineButton("Huỷ", Modifier.weight(1f)) {
                        active.cancelOtp()
                        code = ""
                    }
                    PrimaryButton(if (active.loading) "Đang xác nhận…" else "Xác nhận", Modifier.weight(1f), fontSize = 15f, height = 44f,
                        enabled = !active.loading && step.sentType != null && code.count { it.isDigit() } >= 4) {
                        val digits = code.filter { it.isDigit() }
                        val c = active
                        app.scope.launch {
                            c.verifyOtp(digits)
                            if (hub.currentId == c.accountId && c.otpStep == null) code = ""
                            afterLogin(c)
                        }
                    }
                }
            }
        } else if (!active.loggedIn || active.sessionExpired) {
            // Chưa đăng nhập / phiên hết
            DraftCard {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    T(if (adding) "Thêm tài khoản" else if (active.sessionExpired) "Đăng nhập lại" else "Đăng nhập trên máy này",
                        15f, BV.BOLD, modifier = Modifier.weight(1f))
                    if (active.sessionExpired) Badge("Cần đăng nhập lại", C.red, C.redSoft) else Badge("Chưa đăng nhập", C.muted, C.grayBadge)
                }
                T(when {
                    adding -> "Đăng nhập thêm một tài khoản Viettel Post để đẩy nháp. Tài khoản đang có vẫn giữ phiên. Mật khẩu chỉ gửi thẳng tới Viettel Post. Lần đầu Viettel Post sẽ gửi mã OTP."
                    active.sessionExpired -> "Phiên Viettel Post của tài khoản này đã hết hạn. Nhập mật khẩu để đăng nhập lại."
                    else -> "Nên dùng cùng tài khoản Viettel Post ở phần 1. Mật khẩu chỉ gửi thẳng tới Viettel Post, không lưu trên máy chủ ChốtLive. Lần đầu trên máy này Viettel Post sẽ gửi mã OTP."
                }, 12.5f, BV.MEDIUM, C.muted)
                LabeledField("Số điện thoại / tên đăng nhập", "0987…", user, { user = it }, KeyboardType.Email, capitalize = false)
                LabeledField("Mật khẩu Viettel Post", "Mật khẩu", password, { password = it }, capitalize = false, password = true)
                ErrorText(active)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (adding) OutlineButton("Huỷ", Modifier.weight(1f)) { hub.remove(active.accountId) }
                    PrimaryButton(if (active.loading) "Đang đăng nhập…" else "Đăng nhập", Modifier.weight(1f), fontSize = 15f,
                        height = if (adding) 44f else 52f, enabled = !active.loading && user.isNotBlank() && password.isNotEmpty()) {
                        val u = user
                        val p = password
                        val c = active
                        // Mật khẩu chỉ cần cho một lần gửi: xoá khỏi ô ngay sau khi lấy ra.
                        password = ""
                        app.scope.launch {
                            c.startLogin(u, p)
                            afterLogin(c)
                        }
                    }
                }
            }
        }

        if (active.loggedIn) {
            // Đã đăng nhập
            DraftCard {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    T("Đăng nhập trên máy này", 15f, BV.BOLD, modifier = Modifier.weight(1f))
                    if (!active.sessionExpired) Badge("Đã đăng nhập", C.green, C.greenSoft)
                }
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    VtpLogo(36f)
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        T(active.displayName.ifEmpty { active.phone.ifEmpty { "Tài khoản Viettel Post" } }, 14f, BV.BOLD, maxLines = 1)
                        T(active.phone.ifEmpty { "Chưa biết số: đăng xuất rồi đăng nhập lại một lần" }, 12f, BV.MEDIUM, C.muted, shrink = true, minScale = 0.8f)
                    }
                }
                KhoList(active)
                Row(verticalAlignment = Alignment.CenterVertically) {
                    T("Phiên", 13f, BV.MEDIUM, C.muted, Modifier.weight(1f))
                    T(if (active.sessionExpired) "đã hết, đăng nhập lại" else "tự làm mới", 13f, BV.BOLD, if (active.sessionExpired) C.red else C.ink)
                }
                ErrorText(active)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlineButton("Mở viettelpost.vn", Modifier.weight(1f)) { uri.openUri("https://viettelpost.vn/") }
                    OutlineButton("Đăng xuất", Modifier.weight(1f), color = C.red) {
                        val id = active.accountId
                        val name = active.accountLabel
                        ui.confirm = ConfirmItem("Đăng xuất ${name.ifEmpty { "Viettel Post" }} trên máy này?",
                            "Tài khoản này không đẩy hay xoá nháp được tới khi đăng nhập lại. Nháp đã đẩy và vận đơn không bị ảnh hưởng.",
                            "Đăng xuất") { hub.remove(id) }
                    }
                }
            }
            partnerMismatch(app, active, prefix = true)?.let { warn ->
                Column(Modifier.fillMaxWidth().clip(rounded(20f)).background(C.gomTag.copy(alpha = 0.6f)).padding(14.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        T("Khác tài khoản", 14f, BV.BOLD, modifier = Modifier.weight(1f))
                        Badge("Cảnh báo", C.gomInk, C.gomTag)
                    }
                    T(warn, 12.5f, BV.SEMIBOLD, C.gomInk)
                    hub.matchingPartner(app.client.vtp?.phone)?.let { match ->
                        T("Chuyển sang ${match.accountLabel}", 13f, BV.BOLD, C.accent, Modifier.plainTap { hub.select(match.accountId) })
                    }
                }
            }
            if (hub.clients.size == 1) {
                Row(Modifier.fillMaxWidth().height(46.dp).cardStyle(16f).plainTap { hub.addAccount() }.padding(horizontal = 16.dp),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Icon(IconName.PLUS, 14f, 2.4f, C.accent)
                    T("Thêm tài khoản Viettel Post khác", 13.5f, BV.BOLD, C.accent)
                }
            }
        }
    }
}

@Composable
fun VtpLogo(size: Float = 38f) {
    Box(Modifier.size(size.dp).clip(rounded(size * 0.29f)).background(C.vtpBrand), contentAlignment = Alignment.Center) {
        T("VTP", 12f, BV.HEAVY, Color.White)
    }
}

@Composable
private fun KhoList(active: VtpDraftClient) {
    val app = LocalApp.current
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            T("Kho lấy hàng cho nháp", 12f, BV.MEDIUM, C.muted, Modifier.weight(1f))
            if (active.loadingKho) CircularProgressIndicator(Modifier.size(14.dp), C.muted, 2.dp)
            else T("Tải lại", 12.5f, BV.BOLD, C.accent, Modifier.plainTap { app.scope.launch { active.loadKho() } })
        }
        if (active.kho.isEmpty() && !active.loadingKho) {
            T("Chưa đọc được kho. Thêm kho ở viettelpost.vn › Quản lý kho rồi bấm Tải lại.", 12.5f, BV.MEDIUM, C.muted)
        }
        for (k in active.kho) {
            Row(Modifier.fillMaxWidth().plainTap { active.pickKho(k.id) }.padding(vertical = 6.dp),
                horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Box(Modifier.padding(top = 2.dp)) { TickCircle(active.selectedKho?.id == k.id) }
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    T(k.name.ifEmpty { "Kho ${k.id}" }, 14f, BV.BOLD, maxLines = 1)
                    T(k.address, 12f, BV.MEDIUM, C.muted, maxLines = 2)
                }
            }
        }
    }
}

/** Một dòng trong danh sách tài khoản đẩy nháp. */
@Composable
fun VtpDraftAccountRow(c: VtpDraftClient, on: Boolean, select: () -> Unit) {
    val title = if (!c.loggedIn && c.userName.isEmpty()) {
        c.otpStep?.phone?.takeIf { it.isNotEmpty() }?.let { VtpMask.text(it) } ?: "Tài khoản mới"
    } else c.displayName.ifEmpty { c.phone.ifEmpty { "Tài khoản Viettel Post" } }
    val subtitle = listOf(if (c.displayName.isEmpty()) "" else c.phone, c.selectedKho?.name ?: "").filter { it.isNotEmpty() }.joinToString(" · ")
    Row(Modifier.fillMaxWidth().plainTap(onClick = select).padding(vertical = 7.dp), verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        TickCircle(on)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            T(title, 14f, BV.BOLD, maxLines = 1)
            if (subtitle.isNotEmpty()) T(subtitle, 12f, BV.MEDIUM, C.muted, shrink = true, minScale = 0.8f)
        }
        when {
            !c.loggedIn && c.otpStep != null -> Badge("Đang nhập OTP", C.accent, C.peachSoft)
            !c.loggedIn -> Badge("Chưa đăng nhập", C.muted, C.grayBadge)
            c.sessionExpired -> Badge("Cần đăng nhập lại", C.red, C.redSoft)
        }
    }
}

/** Dòng thứ hai bên phải mục ViettelPost ở Tôi: phiên đẩy nháp trên máy này. */
fun draftStatus(hub: VtpDraftHub): Pair<String, Boolean?> {
    val all = hub.loggedInClients
    if (all.isEmpty()) return "Nháp: chưa đăng nhập" to null
    if (all.any { it.sessionExpired }) return "Nháp: cần đăng nhập lại" to false
    return (if (all.size > 1) "Nháp: ${all.size} tài khoản" else "Nháp: đã đăng nhập") to true
}

// MARK: - Bảng "Đẩy N khách vào nháp"

private class PushOutcome(
    val id: String, val name: String, var code: String? = null, var error: String? = null,
    var skipped: Boolean = false, var note: String? = null,
)

/**
 * Đẩy lần lượt từng khách vào mục Đơn nháp trên viettelpost.vn, từ máy này. Viettel Post CHƯA nhận đơn, chưa
 * gọi bưu tá. Khách có nháp cũ (đã sửa sau khi đẩy) thì xoá nháp cũ rồi đẩy mới.
 */
@Composable
fun VtpDraftPushSheet(groups: List<Vtp.Group>, service: String) {
    val app = LocalApp.current
    val hub = app.vtpDrafts
    val store = app.store
    val ui = LocalAppUI.current
    val uri = LocalUriHandler.current
    val active = hub.current
    var running by remember { mutableStateOf(false) }
    var stopRequested by remember { mutableStateOf(false) }
    var done by remember { mutableIntStateOf(0) }
    var outcomes by remember { mutableStateOf(listOf<PushOutcome>()) }
    var finished by remember { mutableStateOf(false) }
    /** Dừng cả lượt vì lỗi chung (bị chặn, hết phiên): lý do hiện trên cùng. */
    var haltReason by remember { mutableStateOf<String?>(null) }
    var menu by remember { mutableStateOf(false) }
    val okCount = outcomes.count { it.code != null && !it.skipped }
    val svc = service.ifEmpty { Vtp.DEFAULT_SERVICE }

    LaunchedEffect(active.accountId) {
        if (active.loggedIn && !active.sessionExpired && (active.kho.isEmpty() || !active.khoLoadedThisSession)) active.loadKho()
    }

    /** Một khách: kiểm lỗi, xoá nháp cũ nếu đã sửa, tra mã địa chỉ, lưu nháp, ghi vào đơn. Lỗi chung trả lý do để dừng cả lượt. */
    suspend fun pushOne(g: Vtp.Group, client: VtpDraftClient, kho: VtpDraftKho, account: String): Pair<PushOutcome, String?> {
        val out = PushOutcome(g.customer.id, g.summary.receiver.ifEmpty { g.customer.nickname })
        val problems = VtpDraftBody.problems(g)
        if (problems.isNotEmpty()) {
            out.error = problems.joinToString(" · ")
            return out to null
        }
        var stale = false
        when (val st = VtpDraftBody.status(g, service)) {
            is VtpDraftBody.Status.Pushed -> {
                // Đã có nháp khớp nhưng ở tài khoản khác: đẩy sang tài khoản đang chọn (xoá nháp ở tài khoản cũ).
                val acc = g.orders.mapNotNull { it.ship }.firstOrNull { it.draftCode == st.code }?.draftAccount ?: ""
                if (acc.isEmpty() || client.owns(acc)) {
                    out.code = st.code
                    out.skipped = true
                    return out to null
                }
                stale = true
            }
            is VtpDraftBody.Status.Stale -> stale = true
            else -> {}
        }
        return try {
            // Kiểm tra phiên và địa chỉ trước khi xoá nháp cũ: tránh mất nháp cũ khi địa chỉ lỗi hoặc phiên hết hạn.
            client.ensureFresh()
            val place = client.locate(VtpDraftBody.addressLine(g))
            if (stale) {
                val leftover = hub.deleteDrafts(g)
                if (leftover.isEmpty()) store.clearDraft(g.orders)
                else out.note = "Chưa xoá được nháp cũ ${leftover.joinToString(", ") { it.first }} trên Viettel Post, hãy xoá tay trên web."
            }
            val code = client.insertDraft(VtpDraftBody.make(g, kho, place, service))
            store.markDraft(g.orders, code, VtpDraftBody.hash(g, service), account)
            out.code = code
            out to null
        } catch (e: VtpDraftError) {
            val msg = e.message ?: "Lỗi"
            out.error = msg
            if (e is VtpDraftError.Blocked || e is VtpDraftError.SessionExpired || e is VtpDraftError.NotLoggedIn) out to msg
            else {
                store.markDraftError(g.orders, msg)
                out to null
            }
        } catch (e: Exception) {
            val msg = e.message ?: "Lỗi"
            out.error = msg
            store.markDraftError(g.orders, msg)
            out to null
        }
    }

    fun start() {
        val kho = active.selectedKho
        if (running || !active.loggedIn || active.sessionExpired || kho == null) return
        running = true
        stopRequested = false
        done = 0
        outcomes = emptyList()
        haltReason = null
        // Giữ đúng tài khoản lúc bấm Đẩy cho cả lượt (đổi tài khoản giữa chừng không ảnh hưởng).
        val client = active
        val account = client.accountLabel
        app.scope.launch {
            for ((i, g) in groups.withIndex()) {
                if (stopRequested) break
                val (o, halt) = pushOne(g, client, kho, account)
                outcomes = outcomes + o
                done = i + 1
                if (halt != null) {
                    haltReason = halt
                    break
                }
                // Giãn cách nhỏ giữa các khách: Viettel Post chặn nếu gửi dồn dập.
                delay(400)
            }
            running = false
            finished = true
        }
    }

    Column(Modifier.fillMaxWidth().heightIn(max = sheetHeight(120.dp))) {
        Row(Modifier.padding(horizontal = Metrics.GUTTER.dp).padding(bottom = 12.dp), verticalAlignment = Alignment.Top) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                T(if (finished) "Đã đẩy $okCount/${groups.size} khách" else "Đẩy ${groups.size} khách vào nháp", 20f, BV.HEAVY, C.ink, track = -0.3f)
                T("Dịch vụ $svc", 12.5f, BV.MEDIUM, C.muted)
            }
            if (!running) {
                Box(Modifier.size(36.dp).clip(androidx.compose.foundation.shape.CircleShape).background(C.field).plainTap { ui.dismissSheet() },
                    contentAlignment = Alignment.Center) { Icon(IconName.CLOSE, 17f, 2.4f) }
            }
        }
        Column(
            Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()).padding(horizontal = Metrics.GUTTER.dp).padding(bottom = 12.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            if (!finished && !running) {
                T("Đơn vào mục Đơn nháp trên viettelpost.vn. Viettel Post CHƯA nhận đơn, chưa gọi bưu tá. Bạn duyệt lại trên web Viettel Post, hoặc quay lại đây bấm Lên vận đơn.",
                    13.5f, BV.MEDIUM, C.muted)
            }
            // Tài khoản và kho
            val khoText = if (active.loadingKho && active.selectedKho == null) "đang tải kho…" else active.selectedKho?.name ?: "chưa có kho"
            Column(Modifier.fillMaxWidth().clip(rounded(14f)).background(C.field)) {
                Row(Modifier.fillMaxWidth().padding(12.dp), verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(11.dp)) {
                    VtpLogo()
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        T(active.displayName.ifEmpty { active.phone.ifEmpty { "Tài khoản Viettel Post" } }, 14f, BV.BOLD, maxLines = 1)
                        T(listOf(if (active.displayName.isEmpty()) "" else active.phone, khoText).filter { it.isNotEmpty() }.joinToString(" · "),
                            12f, BV.MEDIUM, C.muted, maxLines = 1)
                    }
                    if (!running && !finished) {
                        T("Đổi", 13f, BV.BOLD, C.accent, Modifier.plainTap {
                            if (hub.loggedInClients.size > 1 || active.kho.size > 1) menu = !menu
                            else {
                                ui.dismissSheet()
                                ui.push(Route.VtpDraft)
                            }
                        })
                    }
                }
                // Nhiều tài khoản hoặc nhiều kho: đổi ngay trong bảng, không phải rời bảng.
                if (menu && !running && !finished) {
                    Column(Modifier.fillMaxWidth().padding(start = 12.dp, end = 12.dp, bottom = 10.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        if (hub.loggedInClients.size > 1) {
                            T("Tài khoản đẩy nháp", 12f, BV.SEMIBOLD, C.muted, Modifier.padding(top = 4.dp))
                            for (c in hub.loggedInClients) {
                                val base = if (c.displayName.isEmpty()) c.accountLabel else "${c.displayName} · ${c.phone}"
                                Row(Modifier.fillMaxWidth().plainTap { hub.select(c.accountId) }.padding(vertical = 6.dp),
                                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                    TickCircle(c.accountId == hub.currentId)
                                    T(if (c.sessionExpired) "$base (hết phiên)" else base, 13.5f, BV.SEMIBOLD, maxLines = 1)
                                }
                            }
                        }
                        if (active.kho.size > 1) {
                            T("Kho lấy hàng", 12f, BV.SEMIBOLD, C.muted, Modifier.padding(top = 4.dp))
                            for (k in active.kho) {
                                Row(Modifier.fillMaxWidth().plainTap { active.pickKho(k.id) }.padding(vertical = 6.dp),
                                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                    TickCircle(k.id == active.selectedKho?.id)
                                    T(k.name.ifEmpty { "Kho ${k.id}" }, 13.5f, BV.SEMIBOLD, maxLines = 1)
                                }
                            }
                        }
                        T("Quản lý tài khoản…", 13f, BV.BOLD, C.accent, Modifier.padding(top = 6.dp).plainTap {
                            ui.dismissSheet()
                            ui.push(Route.VtpDraft)
                        })
                    }
                }
            }
            if (!running && !finished) {
                partnerMismatch(app, active, prefix = false)?.let { warn ->
                    Column(Modifier.fillMaxWidth().clip(rounded(12f)).background(C.gomTag.copy(alpha = 0.6f)).padding(horizontal = 12.dp, vertical = 9.dp),
                        verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        T(warn, 12f, BV.SEMIBOLD, C.gomInk)
                        hub.matchingPartner(app.client.vtp?.phone)?.let { match ->
                            T("Chuyển sang ${match.accountLabel}", 12.5f, BV.BOLD, C.accent, Modifier.plainTap { hub.select(match.accountId) })
                        }
                    }
                }
            }
            if (running || finished) {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Row {
                        T("Đã đẩy $done/${groups.size}", 13f, BV.BOLD, modifier = Modifier.weight(1f))
                        T(if (finished) "Xong" else "Đang đẩy…", 13f, BV.BOLD, if (finished) C.green else C.muted)
                    }
                    Box(Modifier.fillMaxWidth().height(8.dp).clip(Capsule).background(C.track)) {
                        Box(Modifier.fillMaxWidth(if (groups.isEmpty()) 0f else done / groups.size.toFloat()).height(8.dp).clip(Capsule).background(C.green))
                    }
                }
            }
            haltReason?.let { T(it, 13f, BV.BOLD, C.red) }
            if (outcomes.isNotEmpty()) {
                Column(Modifier.fillMaxWidth().cardStyle(16f)) {
                    outcomes.forEachIndexed { i, o ->
                        if (i > 0) HairLine()
                        val failed = o.error != null
                        Row(Modifier.fillMaxWidth().padding(vertical = 10.dp, horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            T(if (failed) "✕" else if (o.skipped) "–" else "✓", 14f, BV.HEAVY,
                                if (failed) C.red else if (o.skipped) C.muted else C.green, Modifier.width(18.dp))
                            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                T(o.name, 14f, BV.BOLD, maxLines = 1)
                                when {
                                    o.error != null -> T(o.error!!, 12.5f, BV.SEMIBOLD, C.red)
                                    o.code != null -> T((if (o.skipped) "Đã có nháp " else "Mã nháp ") + o.code, 12.5f, BV.MEDIUM, C.muted)
                                }
                                o.note?.let { T(it, 12f, BV.SEMIBOLD, C.gomInk) }
                            }
                            if (failed && !running) {
                                T("Sửa", 13f, BV.BOLD, C.accent, Modifier.plainTap {
                                    ui.dismissSheet()
                                    ui.push(Route.AddressEdit(o.id))
                                })
                            }
                        }
                    }
                }
            }
        }
        // Chân bảng
        Column(Modifier.fillMaxWidth().padding(horizontal = Metrics.GUTTER.dp).padding(top = 14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            when {
                running -> OutlineButton(if (stopRequested) "Đang dừng…" else "Dừng sau khách này", color = C.red, height = 52f) { stopRequested = true }
                finished -> Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    OutlineButton("Đóng", Modifier.weight(1f), height = 52f) { ui.dismissSheet() }
                    PrimaryButton("Mở viettelpost.vn", Modifier.weight(1f), fontSize = 15f) { uri.openUri("https://viettelpost.vn/") }
                }
                else -> {
                    val canPush = groups.isNotEmpty() && active.loggedIn && !active.sessionExpired && active.selectedKho != null
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        OutlineButton("Huỷ", Modifier.weight(1f), height = 52f) { ui.dismissSheet() }
                        PrimaryButton("Đẩy ${groups.size} khách", Modifier.weight(2f), fontSize = 15f, enabled = canPush) { start() }
                    }
                    when {
                        active.sessionExpired -> Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            T("Phiên tài khoản này đã hết hạn.", 12.5f, BV.SEMIBOLD, C.red)
                            T("Đăng nhập lại", 12.5f, BV.BOLD, C.accent, Modifier.plainTap {
                                ui.dismissSheet()
                                ui.push(Route.VtpDraft)
                            })
                        }
                        active.loadingKho && active.selectedKho == null -> T("Đang tải kho lấy hàng…", 12.5f, BV.MEDIUM, C.muted)
                        active.selectedKho == null -> Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            T("Chưa có kho lấy hàng cho nháp.", 12.5f, BV.SEMIBOLD, C.red)
                            T("Tải lại kho", 12.5f, BV.BOLD, C.accent, Modifier.plainTap {
                                val c = active
                                app.scope.launch { c.loadKho() }
                            })
                        }
                    }
                }
            }
        }
    }
}
