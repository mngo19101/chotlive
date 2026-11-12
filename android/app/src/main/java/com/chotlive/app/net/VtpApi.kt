package com.chotlive.app.net

import com.chotlive.app.data.arr
import com.chotlive.app.data.asObj
import com.chotlive.app.data.bool
import com.chotlive.app.data.num
import com.chotlive.app.data.obj
import com.chotlive.app.model.VtpQuote
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** Viettel Post trả mã số lúc là số, lúc là chuỗi. */
private fun JsonObject.text(k: String): String? = (this[k] as? JsonPrimitive)?.takeIf { it !is kotlinx.serialization.json.JsonNull }?.content

/**
 * Kết nối Viettel Post của tài khoản ChốtLive. Token do shop dán, máy chủ ChốtLive giữ và gọi API thay app,
 * nên dán một lần là dùng được trên cả web lẫn app. Máy chủ không bao giờ gửi token về máy.
 */
data class VtpConnection(
    val connected: Boolean = false,
    /** Số điện thoại tài khoản Viettel Post đã che bớt ("09•• ••• 454"). */
    val phone: String = "",
    val sender: Sender? = null,
    /** Địa chỉ dán vào partner2.viettelpost.vn để Viettel Post báo trạng thái đơn về. */
    val hookUrl: String = "",
    val lastHookAt: Long? = null,
    val connectedAt: Long? = null,
) {
    data class Sender(val id: String, val name: String, val phone: String, val address: String) {
        companion object {
            fun from(d: JsonObject?): Sender? {
                val id = d?.text("id")?.takeIf { it.isNotEmpty() } ?: return null
                return Sender(id, d.text("name") ?: "", d.text("phone") ?: "", d.text("address") ?: "")
            }
        }
    }

    companion object {
        fun from(d: JsonObject) = VtpConnection(
            connected = d.bool("connected") ?: false,
            phone = d.text("phone") ?: "",
            sender = Sender.from(d.obj("sender")),
            hookUrl = d.text("hookUrl") ?: "",
            lastHookAt = d.num("lastHookAt")?.toLong(),
            connectedAt = d.num("connectedAt")?.toLong(),
        )
    }
}

/** Kết quả tạo vận đơn cho một khách. */
data class VtpCreateResult(
    val key: String, val ok: Boolean, val code: String = "", val fee: Int = 0, val already: Boolean = false, val error: String = "",
) {
    companion object {
        fun from(d: JsonObject): VtpCreateResult {
            val ok = d.bool("ok") ?: false
            return VtpCreateResult(
                key = d.text("key") ?: "", ok = ok, code = d.text("code") ?: "", fee = d.num("fee")?.toInt() ?: 0,
                already = d.bool("already") ?: false, error = d.text("error") ?: if (ok) "" else "Lỗi không rõ",
            )
        }
    }
}

private fun quoteFrom(d: JsonObject): VtpQuote {
    val ok = d.bool("ok") ?: false
    return VtpQuote(ok, d.num("fee")?.toInt() ?: 0, d.text("parsed") ?: "", d.bool("addrOk"),
        d.text("error") ?: if (ok) "" else "Không tính được cước")
}

// MARK: - Gọi máy chủ ChốtLive

val LiveClient.vtpConnected: Boolean get() = vtp?.connected == true

private fun errorText(r: Pair<Int, JsonObject>?, fallback: String): String {
    r ?: return "Không kết nối được máy chủ ChốtLive. Kiểm tra mạng rồi thử lại."
    if (r.first == 404) return "Máy chủ ChốtLive chưa có tính năng Viettel Post. Cập nhật máy chủ rồi thử lại."
    return r.second.text("error") ?: fallback
}

private fun senders(a: JsonArray?): List<VtpConnection.Sender> = a?.mapNotNull { VtpConnection.Sender.from(it.asObj()) } ?: emptyList()

private val vtpScope = MainScope()

/** Hỏi máy chủ tài khoản đã kết nối Viettel Post chưa. */
fun LiveClient.refreshVtp() {
    val key = accountKey
    vtpScope.launch {
        val r = apiCall("/api/vtp/status") ?: return@launch
        if (r.first == 200 && accountKey == key) vtp = VtpConnection.from(r.second)
    }
}

/** Dán token: máy chủ đăng nhập thử Viettel Post, được thì lưu và trả về danh sách điểm lấy hàng. */
suspend fun LiveClient.vtpConnect(token: String): Pair<String?, List<VtpConnection.Sender>> {
    val r = apiCall("/api/vtp/connect", "POST", buildJsonObject { put("siteToken", token) }, 40)
    if (r == null || r.first != 200 || r.second.bool("ok") != true) return errorText(r, "Token không dùng được") to emptyList()
    vtp = VtpConnection.from(r.second)
    return null to senders(r.second.arr("inventory"))
}

suspend fun LiveClient.vtpSenders(): Pair<String?, List<VtpConnection.Sender>> {
    val r = apiCall("/api/vtp/inventory", timeoutSec = 30)
    if (r == null || r.first != 200) return errorText(r, "Không lấy được điểm lấy hàng") to emptyList()
    return null to senders(r.second.arr("list"))
}

suspend fun LiveClient.vtpSetSender(id: String): String? {
    val r = apiCall("/api/vtp/sender", "POST", buildJsonObject { put("id", id) }, 30)
    if (r == null || r.first != 200) return errorText(r, "Không chọn được điểm lấy hàng")
    vtp = VtpConnection.from(r.second)
    return null
}

suspend fun LiveClient.vtpDisconnect(): String? {
    val r = apiCall("/api/vtp/disconnect", "POST", JsonObject(emptyMap()))
    if (r == null || r.first != 200) return errorText(r, "Không ngắt được kết nối")
    vtp = VtpConnection(connected = false)
    return null
}

private fun groupsBody(service: String, groups: List<JsonObject>) = buildJsonObject {
    put("service", service)
    put("groups", JsonArray(groups))
}

/** Tạo vận đơn cho nhiều khách một lần. Máy chủ ghi mã vận đơn vào đơn ngay khi tạo xong, nên gửi lại không bị trùng. */
suspend fun LiveClient.vtpCreate(service: String, groups: List<JsonObject>): Pair<String?, List<VtpCreateResult>> {
    val r = apiCall("/api/vtp/create", "POST", groupsBody(service, groups), 30L + groups.size * 15)
    if (r == null || r.first != 200) return errorText(r, "Không tạo được vận đơn") to emptyList()
    return null to (r.second.arr("results")?.mapNotNull { it.asObj()?.let(VtpCreateResult::from) } ?: emptyList())
}

/** Nháp: cước dự tính và địa chỉ Viettel Post hiểu cho từng khách, theo `key` của khách. Chưa tạo đơn nào. */
suspend fun LiveClient.vtpQuote(service: String, groups: List<JsonObject>): Pair<String?, Map<String, VtpQuote>> {
    val r = apiCall("/api/vtp/quote", "POST", groupsBody(service, groups), 20L + groups.size * 5)
    if (r == null || r.first != 200) return errorText(r, "Không tính được cước") to emptyMap()
    val out = HashMap<String, VtpQuote>()
    r.second.arr("results")?.forEach { e ->
        val d = e.asObj() ?: return@forEach
        d.text("key")?.let { out[it] = quoteFrom(d) }
    }
    return null to out
}

/** Link in tem của các vận đơn theo khổ giấy đã chọn. */
suspend fun LiveClient.vtpPrintUrl(codes: List<String>, size: String): Pair<String?, String?> {
    val unique = codes.filter { it.isNotEmpty() }.distinct()
    val r = apiCall("/api/vtp/print", "POST", buildJsonObject { put("codes", JsonArray(unique.map { JsonPrimitive(it) })) }, 30)
    val links = r?.takeIf { it.first == 200 }?.second?.obj("links") ?: return errorText(r, "Không lấy được tem") to null
    return null to (links.text(size) ?: links.text("a6") ?: "").takeIf { it.startsWith("http") }
}

suspend fun LiveClient.vtpCancel(code: String): String? {
    val r = apiCall("/api/vtp/cancel", "POST", buildJsonObject { put("code", code) }, 30)
    return if (r == null || r.first != 200) errorText(r, "Không huỷ được vận đơn") else null
}

/** type 3: phát lại, type 2: đồng ý hoàn về shop. */
suspend fun LiveClient.vtpResolve(code: String, type: Int, note: String): String? {
    val r = apiCall("/api/vtp/resolve", "POST", buildJsonObject { put("code", code); put("type", type); put("note", note) }, 30)
    return if (r == null || r.first != 200) errorText(r, "Viettel Post không nhận yêu cầu") else null
}
