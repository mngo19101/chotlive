package com.chotlive.app.net

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.chotlive.app.data.AppJson
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID

/*
 * Đẩy đơn NHÁP lên Viettel Post, chạy ngay trên điện thoại (đi từ IP của máy này, không qua máy chủ ChốtLive).
 *
 * Đi đúng đường trang viettelpost.vn: đăng nhập SSO → OTP nếu Viettel Post đòi → đổi sang phiên web có chữ ký
 * DPoP → lưu nháp. Đây là cổng web KHÔNG chính thức, Viettel Post có thể đổi bất cứ lúc nào. Tạo vận đơn thật
 * vẫn đi đường API đối tác qua máy chủ (VtpApi.kt), không dùng lớp này. Giống VtpDraftClient.swift.
 *
 * Khoá ký P-256 nằm trong Android Keystore; token và refresh token được mã hoá; mật khẩu và OTP không lưu ở đâu cả.
 */

data class VtpDraftOtpStep(
    /** SSO_VERIFY_LOGIN (máy đăng nhập lần đầu) hoặc SSO_OTP_FALLBACK (Viettel Post đòi captcha). */
    val function: String,
    val verifyOtpKey: String?,
    val phone: String,
    val email: String,
    /** Kênh đã gửi mã: PHONE (SMS) hoặc EMAIL. null = chưa gửi. */
    val sentType: String? = null,
)

@Serializable
data class VtpDraftKho(
    val id: String,
    val cusId: Int,
    val name: String,
    val phone: String,
    val address: String,
    val province: Int,
    val district: Int,
    val ward: Int,
)

data class VtpDraftPlace(val province: Int, val district: Int, val ward: Int, val formatted: String, val confidence: Double)

data class VtpDraftApproveResult(val code: String, val fee: Int)

class VtpDraftClient(
    /** Khoá phân biệt tài khoản trên máy này ("" = tài khoản đầu tiên). */
    val accountId: String = "",
    private val secrets: VtpDraftSecrets,
    private val prefs: VtpDraftPrefs,
    private val keys: VtpDraftKeys,
    private val transport: VtpDraftTransport = VtpDraftHttp.live,
) {
    object Endpoint {
        const val SSO = "https://oms-sso-2-api.viettelpost.vn"
        const val OTP = "https://otp-verify.okd.viettelpost.vn"
        const val API = "https://api.viettelpost.vn"
        const val LOCATION = "https://location.viettelpost.vn/location/v1.0/address?system=VTP"
    }

    private fun dkey(name: String) = if (accountId.isEmpty()) "vtpDraft.$name" else "vtpDraft.$accountId.$name"
    private fun skey(name: String) = if (accountId.isEmpty()) name else "$accountId.$name"
    private val keyAlias get() = "chotlive.vtpdraft." + accountId.ifEmpty { "main" }

    var loggedIn by mutableStateOf(false); private set
    /** Tên Viettel Post trả về (thường là họ tên). Hiện ra màn hình thì dùng `phone` (đã che). */
    var userName by mutableStateOf(""); private set
    var loading by mutableStateOf(false); private set
    var loadingKho by mutableStateOf(false); private set
    var lastError by mutableStateOf<String?>(null)
    var otpStep by mutableStateOf<VtpDraftOtpStep?>(null)
    /** Viettel Post từ chối làm mới phiên: còn token cũ nhưng phải đăng nhập lại. */
    var sessionExpired by mutableStateOf(false); private set
    var kho by mutableStateOf(listOf<VtpDraftKho>()); private set
    var khoId by mutableStateOf<String?>(null); private set
    var khoPicked by mutableStateOf(false); private set
    /** Tên đăng nhập đã gõ (thường là số điện thoại), để so với phần 1 và hiện số đã che. */
    var login by mutableStateOf(""); private set
    /** UserId Viettel Post trả từ `ssoUpdateUser`, để nhận ra cùng một tài khoản dù gõ email hay số. */
    var vtpUserId by mutableStateOf(""); private set
    var log by mutableStateOf(listOf<VtpDraftLogEntry>()); private set
    var khoLoadedThisSession = false; private set

    var deviceId: String; private set
    private var deviceToken: String
    private var key: VtpDraftKey
    private var token: String? = null
    private var refreshToken: String? = null
    private var nonce: String? = null
    private val refreshLock = Mutex()
    private var forgotten = false
    private var pendingUser = ""
    private var pendingPhone = ""

    init {
        token = secrets.get(skey("token"))
        refreshToken = secrets.get(skey("refresh"))
        loggedIn = token != null
        deviceId = prefs.string(dkey("deviceId")) ?: newDeviceId().also { prefs.setString(dkey("deviceId"), it) }
        deviceToken = prefs.string(dkey("deviceToken")) ?: UUID.randomUUID().toString().lowercase().also { prefs.setString(dkey("deviceToken"), it) }
        key = keys.load(keyAlias) ?: keys.create(keyAlias)
        userName = prefs.string(dkey("userName")) ?: ""
        login = prefs.string(dkey("login")) ?: ""
        vtpUserId = prefs.string(dkey("vtpUserId")) ?: ""
        khoId = prefs.string(dkey("khoId"))
        khoPicked = prefs.bool(dkey("khoPicked"))
        if (token != null) {
            prefs.string(dkey("kho"))?.let { raw ->
                kho = try { AppJson.decodeFromString(ListSerializer(VtpDraftKho.serializer()), raw) } catch (e: Exception) { emptyList() }
            }
        }
    }

    private fun newDeviceId() = System.currentTimeMillis().toString(36) + UUID.randomUUID().toString().take(8).lowercase()

    /** Số đăng nhập đã che ("0987 *** 321"); rỗng khi chưa biết. */
    val phone: String get() {
        val raw = login.ifEmpty { if (userName.count { it.isDigit() } >= 9) userName else "" }
        val normalized = if (raw.count { it.isDigit() } >= 9) normalizePhone(raw) else raw
        return VtpMask.text(normalized)
    }
    /** Họ tên Viettel Post trả về (khác số điện thoại). */
    val displayName: String get() = if (userName.count { it.isDigit() } >= 9) "" else userName
    /** Nhãn ghi vào đơn khi đẩy nháp (`draftAccount`): số đã che, chưa biết số thì họ tên. */
    val accountLabel: String get() = phone.ifEmpty { userName }
    val selectedKho: VtpDraftKho? get() = kho.firstOrNull { it.id == khoId } ?: kho.firstOrNull()

    /** Nháp ghi `draftAccount` này có phải của tài khoản này không. */
    fun owns(draftAccount: String): Boolean {
        val a = draftAccount.trim()
        if (a.isEmpty()) return false
        if (a == phone || a == userName || a == accountLabel) return true
        if (login.isNotEmpty() && a.equals(login, ignoreCase = true)) return true
        val ref = login.ifEmpty { userName }
        return phonesMatch(a, ref) ?: false
    }

    /** Hai chỗ có phải cùng một tài khoản Viettel Post không (theo UserId, SĐT hoặc tên đăng nhập). */
    fun matchesSameAccount(other: VtpDraftClient): Boolean {
        if (vtpUserId.isNotEmpty() && other.vtpUserId.isNotEmpty()) return vtpUserId == other.vtpUserId
        val ka = phoneKey(login.ifEmpty { userName })
        val kb = phoneKey(other.login.ifEmpty { other.userName })
        if (ka.length >= 9 && kb.length >= 9) return ka == kb
        if (login.isNotEmpty() && other.login.isNotEmpty()) return login.equals(other.login, ignoreCase = true)
        return false
    }

    fun pickKho(id: String) {
        khoId = id
        khoPicked = true
        prefs.setString(dkey("khoId"), id)
        prefs.setBool(dkey("khoPicked"), true)
    }

    /** Chọn kho tự động (không đánh dấu là người dùng đã chọn). */
    fun suggestKho(id: String) {
        khoId = id
        prefs.setString(dkey("khoId"), id)
    }

    // MARK: - Đăng nhập

    suspend fun startLogin(user: String, password: String) {
        val u = user.trim()
        if (u.isEmpty() || password.isEmpty()) {
            lastError = "Nhập tên đăng nhập và mật khẩu Viettel Post"
            return
        }
        run("Đăng nhập") {
            pendingUser = u
            pendingPhone = ""
            val body = buildJsonObject {
                put("clientId", "vtp.web"); put("clientSecret", "vtp.web"); put("deviceId", deviceId)
                put("username", u); put("password", password)
            }
            val r = post(Endpoint.SSO + "/api/v2/Login/PasswordCaptcha", body, mapOf("Token" to ""))
            val j = VtpJ.obj(r.json) ?: JsonObject(emptyMap())
            val ok = VtpJ.bool(j["status"])
            note("Đăng nhập SSO", r.text, ok)
            val phoneNo = VtpJ.str(j["phoneNumber"]) ?: u
            val email = VtpJ.str(j["email"]) ?: ""
            if (phoneNo.count { it.isDigit() } >= 9) pendingPhone = phoneNo
            val at = VtpJ.str(j["accessToken"])
            val k = VtpJ.str(j["verifyOtpKey"])
            when {
                ok && !at.isNullOrEmpty() -> finish(at, u)
                ok && VtpJ.bool(j["checkCaptcha"]) -> otpStep = VtpDraftOtpStep("SSO_OTP_FALLBACK", null, phoneNo, email)
                ok && !k.isNullOrEmpty() -> otpStep = VtpDraftOtpStep("SSO_VERIFY_LOGIN", k, phoneNo, email)
                else -> throw VtpDraftError.Server(VtpJ.str(j["errorMessage"]) ?: "Đăng nhập thất bại (HTTP ${r.status})")
            }
        }
    }

    /** `type`: "PHONE" (SMS) hoặc "EMAIL", đúng tên kênh trên trang Viettel Post. */
    suspend fun sendOtp(type: String) {
        val step = otpStep ?: return
        run("Gửi OTP") {
            val account = if (type == "EMAIL") step.email else step.phone
            val body = buildJsonObject {
                put("function", step.function); put("otpType", "NUMBER"); put("type", type); put("deviceId", "")
                put("account", account)
            }
            val r = post(Endpoint.OTP + "/api/otp/sendOTP", body)
            val j = VtpJ.obj(r.json) ?: JsonObject(emptyMap())
            val ok = VtpJ.int(j["status"]) == 1
            note("Gửi OTP qua $type", r.text, ok)
            if (!ok) throw VtpDraftError.Server(VtpJ.str(j["message"]) ?: "Không gửi được OTP")
            otpStep = step.copy(sentType = type)
        }
    }

    suspend fun verifyOtp(code: String) {
        val step = otpStep
        val type = step?.sentType
        if (step == null || type == null) {
            lastError = "Chưa gửi mã OTP"
            return
        }
        run("Xác thực OTP") {
            val account = if (type == "EMAIL") step.email else step.phone
            val vb = buildJsonObject {
                put("function", step.function); put("type", type); put("deviceId", "")
                put("otp", code.trim()); put("account", account)
                put("secretValue", JsonNull); put("expiredType", JsonNull)
            }
            val v = post(Endpoint.OTP + "/api/otp/verifyOTPV2", vb)
            val vj = VtpJ.obj(v.json) ?: JsonObject(emptyMap())
            note("Xác thực OTP", v.text, VtpJ.int(vj["status"]) == 1)
            val tokenOtp = VtpJ.str(vj["data"])
            if (VtpJ.int(vj["status"]) != 1 || tokenOtp.isNullOrEmpty()) {
                throw VtpDraftError.Server(VtpJ.str(vj["message"]) ?: "OTP sai hoặc đã hết hạn")
            }
            val r = if (step.function == "SSO_OTP_FALLBACK") {
                post(Endpoint.SSO + "/api/v2/Login/otp-fallback",
                    buildJsonObject { put("userName", account); put("token", tokenOtp) }, mapOf("Token" to ""))
            } else {
                post(Endpoint.SSO + "/api/Login/LoginUserPassTwoFAVerifyOtp", buildJsonObject {
                    put("tokenOtp", tokenOtp); put("deviceId", deviceId); put("verifyOtpKey", step.verifyOtpKey ?: "")
                }, mapOf("token" to ""))
            }
            val j = VtpJ.obj(r.json) ?: JsonObject(emptyMap())
            val at = VtpJ.str(j["accessToken"])
            note("Đăng nhập sau OTP", r.text, at != null)
            if (at.isNullOrEmpty()) throw VtpDraftError.Server(VtpJ.str(j["errorMessage"]) ?: "Chưa đăng nhập được sau OTP")
            otpStep = null
            finish(at, pendingUser.ifEmpty { step.phone })
        }
    }

    fun cancelOtp() { otpStep = null }

    /** Đổi token SSO sang phiên web (token gắn với khoá ký của máy qua DPoP). */
    private suspend fun finish(accessToken: String, user: String) {
        if (forgotten) return
        val body = buildJsonObject {
            put("TokenSSO", accessToken); put("Type", "VTP"); put("Source", 3)
            put("DeviceName", "ChotLive (Android)"); put("DeviceToken", deviceToken); put("deviceId", deviceId)
            put("deviceType", "WEB"); put("browser", "Chrome")
        }
        val r = api("/api/user/ssoUpdateUser", body, null)
        if (forgotten) return
        val j = VtpJ.obj(r.json) ?: JsonObject(emptyMap())
        note("Đổi sang phiên web", r.text, !VtpJ.bool(j["error"]))
        val d = VtpJ.obj(j["data"])
        val tk = VtpJ.str(d?.get("TokenKey"))
        if (VtpJ.bool(j["error"]) || d == null || tk.isNullOrEmpty()) {
            throw VtpDraftError.Server(VtpJ.str(j["message"]) ?: "Không đổi được sang phiên web Viettel Post")
        }
        val newUserId = VtpJ.str(d["UserId"]) ?: VtpJ.str(d["USER_ID"]) ?: ""
        // Số đăng nhập: ưu tiên số Viettel Post trả về, sau đó số từ bước SSO, cuối cùng là chuỗi người dùng đã gõ.
        val phoneNo = VtpJ.str(d["Phone"]) ?: VtpJ.str(d["PHONE"]) ?: pendingPhone
        val newLogin = if (phoneNo.count { it.isDigit() } >= 9) normalizePhone(phoneNo) else user
        val changedAccount = (vtpUserId.isNotEmpty() && newUserId.isNotEmpty() && vtpUserId != newUserId) ||
            (phoneKey(login).length >= 9 && phoneKey(newLogin).length >= 9 && phoneKey(login) != phoneKey(newLogin))
        if (changedAccount) {
            kho = emptyList()
            khoId = null
            khoPicked = false
            khoLoadedThisSession = false
            prefs.setString(dkey("kho"), null)
            prefs.setString(dkey("khoId"), null)
            prefs.setBool(dkey("khoPicked"), false)
        }
        save(tk, VtpJ.str(d["refreshToken"]))
        val name = VtpJ.str(d["UserName"]) ?: VtpJ.str(d["Phone"]) ?: user
        userName = name
        prefs.setString(dkey("userName"), name)
        login = newLogin
        prefs.setString(dkey("login"), newLogin)
        vtpUserId = newUserId
        prefs.setString(dkey("vtpUserId"), newUserId.ifEmpty { null })
        pendingUser = ""
        pendingPhone = ""
        loadKho()
    }

    /** Bỏ hẳn tài khoản khỏi máy: xoá phiên, tên, kho, mã máy và khoá ký của chỗ này. */
    fun forget() {
        forgotten = true
        save(null, null)
        for (n in listOf("userName", "login", "vtpUserId", "khoId", "khoPicked", "kho")) prefs.setString(dkey(n), null)
        // Tài khoản đầu tiên giữ mã máy và khoá ký để lần sau Viettel Post vẫn nhận ra máy; tài khoản thêm sau xoá luôn.
        if (accountId.isNotEmpty()) {
            for (n in listOf("deviceId", "deviceToken")) prefs.setString(dkey(n), null)
            keys.delete(keyAlias)
        }
        userName = ""
        login = ""
        vtpUserId = ""
        kho = emptyList()
        khoId = null
        khoPicked = false
        khoLoadedThisSession = false
        otpStep = null
        lastError = null
        pendingUser = ""
        pendingPhone = ""
    }

    // MARK: - Phiên

    val tokenExpiry: Long? get() = VtpJ.jwtExpiry(token)

    /** Làm mới khi token còn dưới 30 phút (hoặc đã hết). Gọi trước mọi lệnh tới Viettel Post. */
    suspend fun ensureFresh() {
        if (token == null) throw VtpDraftError.NotLoggedIn
        if (sessionExpired) throw VtpDraftError.SessionExpired
        val exp = tokenExpiry
        if (exp != null && exp - System.currentTimeMillis() < 30 * 60_000L) refresh()
    }

    /** Gọi khi mở app: làm mới nếu sắp hết, lỗi thì im lặng (đã hiện ở trạng thái phiên). */
    suspend fun refreshQuietly() {
        if (!loggedIn || sessionExpired) return
        try { ensureFresh() } catch (e: Exception) { }
    }

    /**
     * Mỗi lúc chỉ một lần làm mới: refresh token có thể chỉ dùng được một lần. Ai chờ sau mà token đã đổi thì thôi.
     * Mất mạng hay Viettel Post không trả lời: giữ nguyên phiên cũ. Chỉ ghi đè khi Viettel Post trả thành công.
     */
    private suspend fun refresh() {
        val before = token
        refreshLock.withLock {
            if (token != null && token != before) return
            doRefresh()
        }
    }

    private suspend fun doRefresh() {
        val tk = token ?: throw VtpDraftError.NotLoggedIn
        val rt = refreshToken
        if (rt.isNullOrEmpty()) {
            sessionExpired = true
            throw VtpDraftError.SessionExpired
        }
        val r = api("/api/sessions/refresh/v1", JsonObject(emptyMap()), tk, mapOf("refresh-token" to rt))
        val j = VtpJ.obj(r.json) ?: JsonObject(emptyMap())
        val d = VtpJ.obj(j["data"])
        val nt = VtpJ.str(d?.get("token")) ?: VtpJ.str(d?.get("TokenKey"))
        note("Làm mới phiên", r.text, nt != null)
        if (VtpJ.bool(j["error"]) || nt.isNullOrEmpty()) {
            // Viettel Post trả lời rõ là không làm mới được: phiên đã chết, giữ token để hiện "cần đăng nhập lại".
            if (r.json != null || r.status == 401 || r.status == 403) sessionExpired = true
            throw VtpDraftError.SessionExpired
        }
        save(nt, VtpJ.str(d?.get("refreshToken")) ?: rt)
    }

    private fun save(t: String?, rt: String?) {
        token = t
        refreshToken = rt
        secrets.set(skey("token"), t)
        secrets.set(skey("refresh"), rt)
        loggedIn = t != null
        sessionExpired = false
    }

    // MARK: - Dữ liệu

    suspend fun loadKho() {
        if (!loggedIn || sessionExpired || loadingKho) return
        loadingKho = true
        try {
            val r = authed("/api/setting/listInventoryV2") {
                buildJsonObject { put("token", token ?: ""); put("deviceId", deviceId) }
            }
            val dict = VtpJ.obj(r.json)
            val arr = (r.json as? JsonArray) ?: (dict?.get("data") as? JsonArray)
            if (arr != null && !VtpJ.bool(dict?.get("error"))) {
                val parsed = arr.mapNotNull { parseKho(VtpJ.obj(it)) }
                kho = parsed
                if (khoId == null || parsed.none { it.id == khoId }) {
                    khoId = parsed.firstOrNull()?.id
                    prefs.setString(dkey("khoId"), khoId)
                }
                prefs.setString(dkey("kho"), AppJson.encodeToString(ListSerializer(VtpDraftKho.serializer()), parsed))
                khoLoadedThisSession = true
                lastError = null
                note("Kho hàng Viettel Post: ${parsed.size}", parsed.joinToString("\n") { "${it.name} · ${it.address}" }, parsed.isNotEmpty())
            } else if (r.status == 401 || VtpJ.str(dict?.get("messageKey")) == "EXPIRED_TOKEN") {
                sessionExpired = true
                throw VtpDraftError.SessionExpired
            } else {
                throw VtpDraftError.Server(VtpJ.str(dict?.get("message")) ?: "Không đọc được danh sách kho (HTTP ${r.status})")
            }
        } catch (e: Exception) {
            fail("Đọc kho hàng", e)
        } finally {
            loadingKho = false
        }
    }

    /** Địa chỉ chữ → mã tỉnh/quận/phường Viettel Post (dịch vụ địa chỉ công khai, hiểu cả địa chỉ mới 2 cấp). */
    suspend fun locate(address: String): VtpDraftPlace {
        val r = post(Endpoint.LOCATION, buildJsonObject { put("address", address) })
        val j = VtpJ.obj(r.json) ?: JsonObject(emptyMap())
        val p = VtpJ.int(j["vtpL1"]) ?: 0
        val d = VtpJ.int(j["vtpL2"]) ?: 0
        val w = VtpJ.int(j["vtpL3"]) ?: 0
        if (p <= 0 || d <= 0 || w <= 0) throw VtpDraftError.Server("Viettel Post không nhận ra địa chỉ: $address")
        return VtpDraftPlace(p, d, w, VtpJ.str(j["formattedAddress"]) ?: address, VtpJ.double(j["confidence"]) ?: 0.0)
    }

    /** Lưu một đơn nháp; trả mã nháp (ORDER_NUMBER) Viettel Post cấp. */
    suspend fun insertDraft(body: JsonObject): String {
        val b = JsonObject(body + ("deviceId" to kotlinx.serialization.json.JsonPrimitive(deviceId)))
        val r = authed("/api/tmdt/InsertOrderDraftForWeb") { b }
        val j = VtpJ.obj(r.json) ?: JsonObject(emptyMap())
        val code = VtpJ.str(VtpJ.obj(j["data"])?.get("ORDER_NUMBER"))
        note("Lưu nháp", r.text, code != null)
        if (VtpJ.bool(j["error"]) || code.isNullOrEmpty()) {
            throw VtpDraftError.Server(VtpJ.str(j["message"]) ?: "Viettel Post không lưu nháp (HTTP ${r.status})")
        }
        return code
    }

    /** Xoá nháp: trang web gọi UpdateOrder với TYPE 11 (DELETE_ORDER). Lỗi nào cũng trả nguyên lời Viettel Post. */
    suspend fun deleteDraft(code: String) {
        updateOrder(code, 11, "Xoá nháp")
    }

    /** Duyệt nháp thành vận đơn: UpdateOrder TYPE 1 như nút "Duyệt đơn" trên web, giữ nguyên mã nháp. */
    suspend fun approveDraft(code: String): VtpDraftApproveResult {
        val trimmed = code.trim()
        val j = updateOrder(trimmed, 1, "Duyệt nháp")
        val data = VtpJ.obj(j["data"])
        val returned = VtpJ.str(data?.get("ORDER_NUMBER"))?.trim()
        val fee = maxOf(0, VtpJ.int(data?.get("MONEY_TOTAL")) ?: 0)
        return VtpDraftApproveResult(returned?.ifEmpty { null } ?: trimmed, fee)
    }

    private suspend fun updateOrder(code: String, type: Int, label: String): JsonObject {
        val c = code.trim()
        if (c.isEmpty()) throw VtpDraftError.Server("Thiếu mã nháp")
        val r = authed("/api/tmdt/UpdateOrder") {
            buildJsonObject { put("TYPE", type); put("ORDER_NUMBER", c); put("NOTE", ""); put("DATE", dateText(System.currentTimeMillis())) }
        }
        val j = VtpJ.obj(r.json) ?: JsonObject(emptyMap())
        val ok = VtpJ.isFalse(j["error"])
        note("$label $c", r.text, ok)
        if (!ok) throw VtpDraftError.Server(VtpJ.str(j["message"]) ?: "Viettel Post không nhận lệnh ${label.lowercase()} (HTTP ${r.status})")
        return j
    }

    // MARK: - Gửi

    private suspend fun post(url: String, body: JsonElement, headers: Map<String, String> = emptyMap()): VtpDraftReply =
        VtpDraftHttp.send(transport, url, body, headers + ("Content-Type" to "application/json"))

    /** POST tới api.viettelpost.vn kèm token + deviceId + DPoP. Viettel Post đòi nonce thì gửi lại một lần. */
    private suspend fun api(path: String, body: JsonElement, tk: String?, extra: Map<String, String> = emptyMap(),
                            retried: Boolean = false): VtpDraftReply {
        val url = Endpoint.API + path
        val h = HashMap<String, String>()
        h["Content-Type"] = "application/json"
        h["deviceId"] = deviceId
        h["X-Token"] = VtpDpop.proof(key, "POST", url, tk, nonce)
        if (!tk.isNullOrEmpty()) h["token"] = tk
        h.putAll(extra)
        val r = VtpDraftHttp.send(transport, url, body, h)
        if (!r.nonce.isNullOrEmpty()) nonce = r.nonce
        val mk = VtpJ.str(VtpJ.obj(r.json)?.get("messageKey")) ?: ""
        if (!retried && r.nonce != null && (mk == "USE_DPOP_NONCE" || r.status == 401)) {
            return api(path, body, tk, extra, true)
        }
        return r
    }

    private fun expired(r: VtpDraftReply) = VtpJ.str(VtpJ.obj(r.json)?.get("messageKey")) == "EXPIRED_TOKEN" || r.status == 401

    /** Lệnh cần đăng nhập: làm mới trước nếu sắp hết hạn; Viettel Post báo hết hạn thì làm mới rồi gửi lại một lần. */
    private suspend fun authed(path: String, body: () -> JsonElement): VtpDraftReply {
        ensureFresh()
        val tk = token ?: throw VtpDraftError.NotLoggedIn
        var r = api(path, body(), tk)
        if (expired(r)) {
            note("Phiên hết hạn, làm mới rồi gửi lại", "", false)
            refresh()
            r = api(path, body(), token)
            if (expired(r)) {
                sessionExpired = true
                throw VtpDraftError.SessionExpired
            }
        }
        return r
    }

    // MARK: - Trạng thái và nhật ký

    private suspend fun run(what: String, work: suspend () -> Unit) {
        loading = true
        lastError = null
        try { work() } catch (e: Exception) { fail(what, e) } finally { loading = false }
    }

    private fun fail(what: String, e: Exception) {
        val msg = e.message ?: "Lỗi không rõ"
        lastError = msg
        note("Lỗi: $what", msg, false)
    }

    /** Mọi dòng nhật ký đều qua VtpMask: không có token hay số điện thoại đầy đủ. */
    private fun note(title: String, detail: String, ok: Boolean = true) {
        val e = VtpDraftLogEntry(System.currentTimeMillis(), VtpMask.text(title), VtpMask.text(detail.take(1500)), ok)
        log = (listOf(e) + log).take(200)
    }

    companion object {
        fun parseKho(k: JsonObject?): VtpDraftKho? {
            k ?: return null
            val id = VtpJ.str(k["GROUPADDRESS_ID"])
            if (id.isNullOrEmpty()) return null
            return VtpDraftKho(id, VtpJ.int(k["CUS_ID"]) ?: 0, VtpJ.str(k["NAME"]) ?: "", VtpJ.str(k["PHONE"]) ?: "",
                VtpJ.str(k["ADDRESS"]) ?: "", VtpJ.int(k["PROVINCE_ID"]) ?: 0, VtpJ.int(k["DISTRICT_ID"]) ?: 0,
                VtpJ.int(k["WARDS_ID"]) ?: 0)
        }

        fun dateText(ms: Long): String = SimpleDateFormat("dd/MM/yyyy HH:mm:ss", Locale.US).apply {
            timeZone = TimeZone.getTimeZone("Asia/Ho_Chi_Minh")
        }.format(Date(ms))

        /** Chuẩn hoá số điện thoại Việt Nam về dạng 0xxxxxxxxx; chuỗi không phải SĐT giữ nguyên. */
        fun normalizePhone(s: String): String {
            val trimmed = s.trim()
            if (trimmed.isEmpty() || trimmed.any { it !in "0123456789+-.() " }) return trimmed
            var digits = trimmed.filter { it.isDigit() }
            if (digits.startsWith("84") && digits.length in 10..11) digits = "0" + digits.drop(2)
            if (digits.length in 9..11 && digits.startsWith("0")) return digits
            return trimmed
        }

        /** 9 số cuối của số điện thoại, để so 0987… với +84987…. */
        fun phoneKey(s: String): String = s.filter { it.isDigit() }.takeLast(9)

        private sealed class Parsed {
            class Full(val digits: String) : Parsed()
            class Masked(val prefix: String, val suffix: String) : Parsed()
        }

        private fun parsePhone(s: String): Parsed? {
            val t = s.trim()
            if (t.isEmpty()) return null
            val first = t.indexOfFirst { it == '•' || it == '*' }
            if (first >= 0) {
                val last = t.indexOfLast { it == '•' || it == '*' }
                if (t.any { it !in "0123456789+-.() •*" }) return null
                val rawPrefix = t.substring(0, first).trim()
                val rawSuffix = t.substring(last + 1).trim()
                var prefix = rawPrefix.filter { it.isDigit() }
                if ((rawPrefix.startsWith("+84") || rawPrefix.startsWith("84")) && prefix.startsWith("84")) prefix = "0" + prefix.drop(2)
                val suffix = rawSuffix.filter { it.isDigit() }
                if (prefix.length < 2 || suffix.length < 3) return null
                return Parsed.Masked(prefix, suffix)
            }
            if (t.any { it !in "0123456789+-.() " }) return null
            val digits = normalizePhone(t).filter { it.isDigit() }
            if (digits.length < 9) return null
            return Parsed.Full(if (digits.length == 9 && !digits.startsWith("0")) "0$digits" else digits)
        }

        /** So hai số điện thoại kể cả khi một hoặc hai số đã bị che. null nếu một trong hai không phải số điện thoại. */
        fun phonesMatch(a: String, b: String): Boolean? {
            val pa = parsePhone(a) ?: return null
            val pb = parsePhone(b) ?: return null
            return when {
                pa is Parsed.Full && pb is Parsed.Full -> pa.digits.takeLast(9) == pb.digits.takeLast(9)
                pa is Parsed.Full && pb is Parsed.Masked -> pa.digits.startsWith(pb.prefix) && pa.digits.endsWith(pb.suffix)
                pa is Parsed.Masked && pb is Parsed.Full -> pb.digits.startsWith(pa.prefix) && pb.digits.endsWith(pa.suffix)
                pa is Parsed.Masked && pb is Parsed.Masked -> {
                    val pl = minOf(pa.prefix.length, pb.prefix.length)
                    val sl = minOf(pa.suffix.length, pb.suffix.length)
                    pa.prefix.take(pl) == pb.prefix.take(pl) && pa.suffix.takeLast(sl) == pb.suffix.takeLast(sl)
                }
                else -> null
            }
        }

        fun maskEmail(e: String): String {
            val parts = e.split("@", limit = 2)
            if (parts.size != 2 || parts[0].isEmpty()) return e
            return "${parts[0][0]}***@${parts[1]}"
        }
    }
}
