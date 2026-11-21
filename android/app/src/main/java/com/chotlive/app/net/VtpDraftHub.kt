package com.chotlive.app.net

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.chotlive.app.data.AppJson
import com.chotlive.app.model.Vtp
import com.chotlive.app.model.VtpDraftBody
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import java.util.UUID

sealed class VtpDraftApproveOutcome {
    data class Approved(val result: VtpDraftApproveResult) : VtpDraftApproveOutcome()
    data class Unavailable(val account: String, val reason: String) : VtpDraftApproveOutcome()
    data class Failed(val message: String, val blocked: Boolean) : VtpDraftApproveOutcome()
}

/**
 * Nhiều tài khoản Viettel Post đẩy nháp trên cùng máy, giống VtpDraftHub bên iPhone. Mỗi tài khoản là một
 * `VtpDraftClient` với phiên riêng; một tài khoản "đang dùng" để đẩy nháp (ghi nhớ riêng theo từng tài khoản
 * ChốtLive). Xoá hay duyệt nháp thì dùng đúng tài khoản đã đẩy nháp đó.
 */
class VtpDraftHub(
    appAccount: String?,
    private val secrets: VtpDraftSecrets,
    private val prefs: VtpDraftPrefs,
    private val keys: VtpDraftKeys,
    private val transport: VtpDraftTransport = VtpDraftHttp.live,
) {
    private object K {
        const val ACCOUNTS = "vtpDraft.accounts"
        const val CURRENT = "vtpDraft.current"
        const val CURRENT_BY_APP = "vtpDraft.currentByApp"
    }

    var clients by mutableStateOf(listOf<VtpDraftClient>()); private set
    var currentId by mutableStateOf(""); private set
    private var appAccount: String? = appAccount
    private var currentByApp = mutableMapOf<String, String>()

    private fun make(id: String) = VtpDraftClient(id, secrets, prefs, keys, transport)

    init {
        val rawIds = prefs.string(K.ACCOUNTS)?.let {
            try { AppJson.decodeFromString(ListSerializer(String.serializer()), it) } catch (e: Exception) { null }
        }?.distinct() ?: listOf("")
        var list = rawIds.ifEmpty { listOf("") }.map { make(it) }
        // Tài khoản thêm vào mà chưa đăng nhập xong (bấm Thêm rồi bỏ dở): bỏ khi mở lại app, chừa ít nhất một.
        val kept = list.filter { it.loggedIn }
        if (kept.isEmpty()) {
            list.drop(1).forEach { it.forget() }
            list = listOf(list[0])
        } else {
            list.filter { !it.loggedIn }.forEach { it.forget() }
            list = kept
        }
        clients = list
        currentByApp = prefs.string(K.CURRENT_BY_APP)?.let {
            try { AppJson.decodeFromString(MapSerializer(String.serializer(), String.serializer()), it).toMutableMap() } catch (e: Exception) { null }
        } ?: mutableMapOf()
        val forApp = appAccount?.let { currentByApp[it] }?.takeIf { id -> list.any { it.accountId == id && it.loggedIn } }
        val want = forApp ?: prefs.string(K.CURRENT)
        currentId = list.firstOrNull { it.accountId == want }?.accountId
            ?: list.firstOrNull { it.loggedIn }?.accountId
            ?: list[0].accountId
        persist()
    }

    val current: VtpDraftClient get() = clients.firstOrNull { it.accountId == currentId } ?: clients[0]
    val loggedInClients: List<VtpDraftClient> get() = clients.filter { it.loggedIn }
    val anyLoggedIn: Boolean get() = clients.any { it.loggedIn && !it.sessionExpired }

    fun select(id: String) {
        val c = clients.firstOrNull { it.accountId == id } ?: return
        var changed = false
        if (id != currentId) {
            currentId = id
            changed = true
        }
        val app = appAccount
        if (app != null && c.loggedIn && currentByApp[app] != id) {
            currentByApp[app] = id
            changed = true
        }
        if (changed) persist()
    }

    /** Khi đổi tài khoản ChốtLive: khôi phục tài khoản đẩy nháp tương ứng đã chọn trước đó. */
    fun switchAppAccount(account: String?) {
        appAccount = account
        val saved = account?.let { currentByApp[it] } ?: return
        if (clients.any { it.accountId == saved && it.loggedIn }) {
            if (currentId != saved) currentId = saved
            persist()
        }
    }

    /** Tài khoản đẩy nháp đang đăng nhập khớp với số điện thoại đối tác phần 1. */
    fun matchingPartner(partnerPhone: String?): VtpDraftClient? {
        if (partnerPhone.isNullOrEmpty()) return null
        fun matches(c: VtpDraftClient): Boolean {
            if (!c.loggedIn || c.sessionExpired) return false
            return VtpDraftClient.phonesMatch(partnerPhone, c.login.ifEmpty { c.userName }) == true
        }
        if (matches(current)) return current
        return clients.firstOrNull { matches(it) }
    }

    /** Tự chọn tài khoản khớp phần 1 nếu tài khoản ChốtLive hiện tại chưa gắn lựa chọn riêng hoặc tài khoản đang dùng chưa đăng nhập. */
    fun syncWithPartner(partnerPhone: String?) {
        if (partnerPhone.isNullOrEmpty()) return
        val app = appAccount
        val hasSavedForApp = app?.let { a -> currentByApp[a]?.let { id -> clients.any { it.accountId == id && it.loggedIn } } } == true
        if (hasSavedForApp && current.loggedIn) return
        val match = matchingPartner(partnerPhone) ?: return
        currentId = match.accountId
        if (app != null) currentByApp[app] = match.accountId
        persist()
    }

    /** Thêm một chỗ cho tài khoản mới (chưa đăng nhập) và chuyển sang đó. Có sẵn chỗ trống thì dùng lại. */
    fun addAccount() {
        clients.firstOrNull { !it.loggedIn && it.otpStep == null }?.let {
            select(it.accountId)
            return
        }
        var id: String
        do { id = "a" + UUID.randomUUID().toString().take(8).lowercase() } while (clients.any { it.accountId == id })
        clients = clients + make(id)
        currentId = id
        persist()
    }

    /** Bỏ tài khoản khỏi máy (xoá phiên). Còn tài khoản nào thì chuyển sang đó; hết thì để một chỗ trống. */
    fun remove(id: String) {
        val c = clients.firstOrNull { it.accountId == id } ?: return
        c.forget()
        var list = clients.filter { it.accountId != id }
        currentByApp = currentByApp.filterValues { it != id }.toMutableMap()
        if (list.isEmpty()) list = listOf(make(""))
        clients = list
        if (list.none { it.accountId == currentId }) {
            val saved = appAccount?.let { currentByApp[it] }?.takeIf { sid -> list.any { it.accountId == sid } }
            currentId = saved ?: (list.firstOrNull { it.loggedIn } ?: list[0]).accountId
        }
        persist()
    }

    /** Đăng nhập xong một tài khoản: chỗ cũ cùng tài khoản VTP (đăng nhập lại vào chỗ mới) thì bỏ. */
    fun didLogin(c: VtpDraftClient) {
        if (clients.none { it === c }) return
        if (!c.loggedIn || c.otpStep != null) return
        val dupes = clients.filter { it !== c && c.matchesSameAccount(it) }
        for (other in dupes) {
            for ((app, mapped) in currentByApp.toMap()) if (mapped == other.accountId) currentByApp[app] = c.accountId
            other.forget()
        }
        clients = clients.filter { o -> dupes.none { it === o } }
        currentId = c.accountId
        appAccount?.let { currentByApp[it] = c.accountId }
        persist()
    }

    /** Tài khoản đã đẩy nháp mang nhãn `draftAccount`. Nhãn rỗng (nháp rất cũ): tài khoản đang dùng. */
    fun client(draftAccount: String?): VtpDraftClient? {
        val a = draftAccount?.trim() ?: ""
        val cur = current
        if (a.isEmpty()) {
            if (cur.loggedIn && !cur.sessionExpired) return cur
            return loggedInClients.firstOrNull { !it.sessionExpired } ?: loggedInClients.firstOrNull()
        }
        if (cur.loggedIn && !cur.sessionExpired && cur.owns(a)) return cur
        loggedInClients.firstOrNull { !it.sessionExpired && it.owns(a) }?.let { return it }
        return clients.firstOrNull { it.owns(a) }
    }

    /** Mở app: làm mới phiên của MỌI tài khoản, và tải kho cho tài khoản đang dùng nếu chưa tải trong phiên này. */
    suspend fun refreshAll() {
        for (c in clients) if (c.loggedIn) c.refreshQuietly()
        val cur = current
        if (cur.loggedIn && !cur.sessionExpired && !cur.khoLoadedThisSession) cur.loadKho()
    }

    private class Resolved(val account: String, val client: VtpDraftClient?, val reason: String?)

    private fun resolve(code: String, g: Vtp.Group, action: String, prefixCode: Boolean): Resolved {
        val acc = (g.orders.mapNotNull { it.ship }.firstOrNull { it.draftCode == code }?.draftAccount ?: "").trim()
        val who = if (acc.isEmpty()) "tài khoản đã đẩy" else "tài khoản $acc"
        val c = client(acc)
        if (c == null || !c.loggedIn) {
            val lead = if (prefixCode) "Nháp $code đẩy bằng $who" else "Nháp đẩy bằng $who"
            return Resolved(acc, null, "$lead: đăng nhập tài khoản đó ở Tôi › ViettelPost (phần 2) để $action.")
        }
        if (c.sessionExpired) {
            return Resolved(acc, null, "Phiên của $who đã hết hạn: đăng nhập lại ở Tôi › ViettelPost (phần 2) để $action.")
        }
        return Resolved(acc, c, null)
    }

    /** Duyệt thẳng một nháp thành vận đơn chính thức bằng đúng tài khoản đã đẩy nháp đó. */
    suspend fun approveDraft(g: Vtp.Group, code: String): VtpDraftApproveOutcome {
        val r = resolve(code, g, "duyệt giữ nguyên mã vận đơn", true)
        val c = r.client ?: return VtpDraftApproveOutcome.Unavailable(r.account, r.reason ?: "")
        return try {
            VtpDraftApproveOutcome.Approved(c.approveDraft(code))
        } catch (e: VtpDraftError) {
            VtpDraftApproveOutcome.Failed(e.message ?: "Lỗi duyệt nháp", e is VtpDraftError.Blocked)
        } catch (e: Exception) {
            VtpDraftApproveOutcome.Failed(e.message ?: "Lỗi duyệt nháp", false)
        }
    }

    /** Xoá mọi nháp của một khách, mỗi mã bằng đúng tài khoản đã đẩy mã đó. Trả các mã chưa xoá được kèm lý do. */
    suspend fun deleteDrafts(g: Vtp.Group): List<Pair<String, String>> {
        val failed = mutableListOf<Pair<String, String>>()
        for (code in VtpDraftBody.codes(g)) {
            val r = resolve(code, g, "xoá", false)
            val c = r.client
            if (c == null) {
                failed += code to (r.reason ?: "")
                continue
            }
            try {
                c.deleteDraft(code)
            } catch (e: Exception) {
                failed += code to (e.message ?: "Lỗi không rõ")
                if (e is VtpDraftError.Blocked) break
            }
        }
        return failed
    }

    private fun persist() {
        prefs.setString(K.ACCOUNTS, AppJson.encodeToString(ListSerializer(String.serializer()), clients.map { it.accountId }))
        prefs.setString(K.CURRENT, currentId)
        prefs.setString(K.CURRENT_BY_APP, AppJson.encodeToString(MapSerializer(String.serializer(), String.serializer()), currentByApp))
    }
}
