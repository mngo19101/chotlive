package com.chotlive.app

import com.chotlive.app.data.AppJson
import com.chotlive.app.model.AddressBook
import com.chotlive.app.model.Customer
import com.chotlive.app.model.DeliveryAddress
import com.chotlive.app.model.Order
import com.chotlive.app.model.OrderItem
import com.chotlive.app.model.ShipInfo
import com.chotlive.app.model.Vtp
import com.chotlive.app.model.VtpDraftBody
import com.chotlive.app.net.VtpDpop
import com.chotlive.app.net.VtpDraftApproveOutcome
import com.chotlive.app.net.VtpDraftApproveResult
import com.chotlive.app.net.VtpDraftClient
import com.chotlive.app.net.VtpDraftError
import com.chotlive.app.net.VtpDraftHub
import com.chotlive.app.net.VtpDraftKho
import com.chotlive.app.net.VtpDraftKey
import com.chotlive.app.net.VtpDraftMemoryKeys
import com.chotlive.app.net.VtpDraftMemoryStore
import com.chotlive.app.net.VtpDraftPlace
import com.chotlive.app.net.VtpDraftRaw
import com.chotlive.app.net.VtpDraftTransport
import com.chotlive.app.net.VtpJ
import com.chotlive.app.net.VtpMask
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.io.File
import java.io.IOException
import java.math.BigInteger
import java.net.UnknownHostException
import java.security.MessageDigest
import java.security.Signature

/** Phần đẩy nháp Viettel Post chạy trên máy, giống VtpDraftTests bên iPhone. Không gọi Viettel Post thật. */
class VtpDraftTest {
    class Req(val url: String, val body: String, val headers: Map<String, String>) {
        val path: String get() = java.net.URI(url).path
        val json: JsonObject get() = VtpJ.obj(VtpJ.parse(body)) ?: JsonObject(emptyMap())
    }

    class MockVtp {
        val requests = mutableListOf<Req>()
        /** Trả (mã HTTP, nội dung). Ném IOException để giả mất mạng. */
        var handler: (Req) -> Pair<Int, String> = { 200 to "{}" }
        val transport: VtpDraftTransport = { url, body, headers ->
            val r = Req(url, body, headers)
            requests += r
            yield()
            val (status, text) = handler(r)
            VtpDraftRaw(status, text, null)
        }
    }

    private fun jwt(expiresInSec: Long): String {
        val payload = VtpJ.b64u("""{"exp":${System.currentTimeMillis() / 1000 + expiresInSec},"sub":"test"}""".toByteArray())
        return VtpJ.b64u("""{"alg":"none"}""".toByteArray()) + "." + payload + ".c2ln"
    }

    private fun client(token: String?, mock: MockVtp, store: VtpDraftMemoryStore = VtpDraftMemoryStore(), refresh: String? = "rt-old"): VtpDraftClient {
        if (token != null) store.set("token", token)
        if (refresh != null) store.set("refresh", refresh)
        return VtpDraftClient("", store, store, VtpDraftMemoryKeys(), mock.transport)
    }

    @Before
    fun loadAddressBook() {
        AddressBook.source = { File("src/main/assets/AddressData.json").readText() }
    }

    // MARK: - DPoP

    @Test
    fun proofIsES256With64ByteSignatureAndAth() {
        val key = VtpDraftMemoryKeys().create("k")
        val proof = VtpDpop.proof(key, "post", "https://api.viettelpost.vn/api/tmdt/InsertOrderDraftForWeb?x=1", "abc.def.ghi", "n-1")
        val parts = proof.split(".")
        assertEquals(3, parts.size)
        val header = VtpJ.obj(VtpJ.parse(String(VtpJ.unb64u(parts[0])!!)))!!
        assertEquals("ES256", VtpJ.str(header["alg"]))
        assertEquals("dpop+jwt", VtpJ.str(header["typ"]))
        val jwk = VtpJ.obj(header["jwk"])!!
        assertEquals(32, VtpJ.unb64u(VtpJ.str(jwk["x"])!!)!!.size)
        assertEquals(32, VtpJ.unb64u(VtpJ.str(jwk["y"])!!)!!.size)
        val payload = VtpJ.obj(VtpJ.parse(String(VtpJ.unb64u(parts[1])!!)))!!
        assertEquals("POST", VtpJ.str(payload["htm"]))
        assertEquals("https://api.viettelpost.vn/api/tmdt/InsertOrderDraftForWeb", VtpJ.str(payload["htu"]))
        assertEquals("n-1", VtpJ.str(payload["nonce"]))
        assertEquals(VtpJ.b64u(MessageDigest.getInstance("SHA-256").digest("abc.def.ghi".toByteArray())), VtpJ.str(payload["ath"]))
        val sig = VtpJ.unb64u(parts[2])!!
        assertEquals(64, sig.size)
        assertTrue(verify(key, (parts[0] + "." + parts[1]).toByteArray(), sig))
    }

    /** Kiểm chữ ký r||s bằng khoá công khai (đổi lại sang DER như Java cần). */
    private fun verify(key: VtpDraftKey, data: ByteArray, raw: ByteArray): Boolean {
        fun der(n: ByteArray): ByteArray {
            val b = BigInteger(1, n).toByteArray()
            return byteArrayOf(0x02, b.size.toByte()) + b
        }
        val body = der(raw.copyOfRange(0, 32)) + der(raw.copyOfRange(32, 64))
        val s = Signature.getInstance("SHA256withECDSA")
        s.initVerify(key.publicKey)
        s.update(data)
        return s.verify(byteArrayOf(0x30, body.size.toByte()) + body)
    }

    @Test
    fun proofWithoutTokenHasNoAth() {
        val proof = VtpDpop.proof(VtpDraftMemoryKeys().create("k"), "POST", "https://api.viettelpost.vn/api/user/ssoUpdateUser", null, null)
        val payload = VtpJ.obj(VtpJ.parse(String(VtpJ.unb64u(proof.split(".")[1])!!)))!!
        assertNull(payload["ath"])
        assertNull(payload["nonce"])
    }

    // MARK: - Che nhật ký, JSON lỏng

    @Test
    fun maskHidesJwtPhoneAndSiteToken() {
        val s = VtpMask.text("token eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiIxIn0.abc_DEF-123 sđt 0987654321 +84912345678 key 0123456789ABCDEF0123456789ABCDEF đơn 157491796322")
        assertFalse(s.contains("eyJ"))
        assertFalse(s.contains("0987654321"))
        assertFalse(s.contains("84912345678"))
        assertFalse(s.contains("0123456789ABCDEF0123456789ABCDEF"))
        assertTrue(s.contains("0987 *** 321"))
        assertTrue("mã nháp 12 số không phải số điện thoại, phải giữ", s.contains("157491796322"))
    }

    @Test
    fun lenientJson() {
        assertEquals(12, VtpJ.int(JsonPrimitive("12")))
        assertEquals(8, VtpJ.int(JsonPrimitive(7.6)))
        assertNull(VtpJ.int(JsonPrimitive("abc")))
        assertEquals("157491796322", VtpJ.str(JsonPrimitive(157491796322L)))
        assertEquals(3.5, VtpJ.double(JsonPrimitive(" 3.5 "))!!, 0.0)
        assertTrue(VtpJ.bool(JsonPrimitive("true")))
        assertFalse(VtpJ.bool(kotlinx.serialization.json.JsonNull))
        assertTrue(VtpJ.isFalse(JsonPrimitive(false)))
        assertFalse("thiếu trường error không được coi là thành công", VtpJ.isFalse(null))
        val exp = VtpJ.jwtExpiry(jwt(3600))!!
        assertTrue(exp - System.currentTimeMillis() > 3_500_000)
        // 2026-01-01 00:00 UTC = 07:00 giờ Việt Nam.
        assertEquals("01/01/2026 07:00:00", VtpDraftClient.dateText(1_767_225_600_000L))
    }

    // MARK: - Phiên

    @Test
    fun networkFailureDuringRefreshKeepsOldSession() = runBlocking {
        val mock = MockVtp()
        mock.handler = { throw UnknownHostException() }
        val store = VtpDraftMemoryStore()
        val old = jwt(600) // còn 10 phút → phải làm mới trước
        val c = client(old, mock, store)
        c.loadKho()
        assertEquals("Mất mạng, thử lại khi có mạng", c.lastError)
        assertTrue(c.loggedIn)
        assertFalse(c.sessionExpired)
        assertEquals(old, store.get("token"))
        assertEquals("rt-old", store.get("refresh"))
    }

    @Test
    fun rejectedRefreshMarksSessionExpiredWithoutDroppingIt() = runBlocking {
        val mock = MockVtp()
        mock.handler = { 200 to """{"error":true,"message":"Refresh token hết hạn"}""" }
        val store = VtpDraftMemoryStore()
        val c = client(jwt(-60), mock, store)
        c.loadKho()
        assertTrue(c.sessionExpired)
        assertTrue(c.loggedIn)
        assertEquals("rt-old", store.get("refresh"))
        try {
            c.insertDraft(JsonObject(emptyMap()))
            fail("phiên chết thì không được gửi nháp")
        } catch (e: VtpDraftError) {
            assertEquals(VtpDraftError.SessionExpired, e)
        }
    }

    @Test
    fun refreshThenLoadKho() = runBlocking {
        val mock = MockVtp()
        val fresh = jwt(12 * 3600)
        mock.handler = { r ->
            when (r.path) {
                "/api/sessions/refresh/v1" -> {
                    assertEquals("rt-old", r.headers["refresh-token"])
                    200 to """{"error":false,"data":{"token":"$fresh","refreshToken":"rt-new"}}"""
                }
                "/api/setting/listInventoryV2" -> {
                    assertEquals(fresh, r.headers["token"])
                    assertNotNull(r.headers["X-Token"])
                    assertNotNull(r.headers["deviceId"])
                    200 to """[{"GROUPADDRESS_ID":"123","CUS_ID":"45","NAME":"Shop Thu","PHONE":"0900000000","ADDRESS":"12 Trần Hưng Đạo","PROVINCE_ID":"1","DISTRICT_ID":2,"WARDS_ID":3}]"""
                }
                else -> { fail("không mong đợi ${r.path}"); 404 to "{}" }
            }
        }
        val store = VtpDraftMemoryStore()
        val c = client(jwt(60), mock, store)
        c.loadKho()
        assertNull(c.lastError)
        assertEquals(fresh, store.get("token"))
        assertEquals("rt-new", store.get("refresh"))
        assertEquals(45, c.kho.first().cusId)
        assertEquals(1, c.kho.first().province)
        assertEquals("123", c.khoId)
        // Kho lưu lại: mở app lần sau vẫn thấy.
        assertEquals(listOf("123"), VtpDraftClient("", store, store, VtpDraftMemoryKeys(), mock.transport).kho.map { it.id })
    }

    @Test
    fun concurrentCallsRefreshOnlyOnce() = runBlocking {
        val mock = MockVtp()
        val fresh = jwt(12 * 3600)
        mock.handler = { r ->
            if (r.path == "/api/sessions/refresh/v1") 200 to """{"error":false,"data":{"token":"$fresh","refreshToken":"rt-new"}}"""
            else 200 to """{"error":false,"data":{"ORDER_NUMBER":"1"}}"""
        }
        val c = client(jwt(60), mock)
        val a = async { c.insertDraft(JsonObject(emptyMap())) }
        val b = async { c.insertDraft(JsonObject(emptyMap())) }
        a.await(); b.await()
        assertEquals(1, mock.requests.count { it.path == "/api/sessions/refresh/v1" })
    }

    // MARK: - Lưu, xoá, duyệt nháp

    @Test
    fun cloudflareBlockStopsWithClearError() = runBlocking {
        val mock = MockVtp()
        mock.handler = { 403 to "<!DOCTYPE html><title>Attention Required! | Cloudflare</title>" }
        val c = client(jwt(3600), mock)
        try {
            c.insertDraft(buildJsonObject { put("RECEIVER_FULLNAME", "A") })
            fail("phải báo bị chặn")
        } catch (e: VtpDraftError) {
            assertEquals(VtpDraftError.Blocked, e)
        }
        assertEquals("bị chặn thì không thử lại dồn dập", 1, mock.requests.size)
    }

    @Test
    fun insertDraftReturnsOrderNumberAndSendsDeviceId() = runBlocking {
        val mock = MockVtp()
        mock.handler = { 200 to """{"error":false,"data":{"ORDER_NUMBER":157491796322}}""" }
        val c = client(jwt(3600), mock)
        assertEquals("157491796322", c.insertDraft(buildJsonObject { put("TYPE", 12) }))
        val sent = mock.requests[0].json
        assertEquals(c.deviceId, VtpJ.str(sent["deviceId"]))
        assertEquals(12, VtpJ.int(sent["TYPE"]))
    }

    @Test
    fun deleteDraftSendsType11AndSurfacesViettelPostMessage() = runBlocking {
        val mock = MockVtp()
        mock.handler = { 200 to """{"error":true,"message":"Không tìm thấy đơn hàng"}""" }
        val c = client(jwt(3600), mock)
        try {
            c.deleteDraft("157491796322")
            fail("Viettel Post báo lỗi thì không được coi là đã xoá")
        } catch (e: VtpDraftError) {
            assertEquals("Không tìm thấy đơn hàng", e.message)
        }
        val sent = mock.requests[0].json
        assertEquals("/api/tmdt/UpdateOrder", mock.requests[0].path)
        assertEquals(11, VtpJ.int(sent["TYPE"]))
        assertEquals("157491796322", VtpJ.str(sent["ORDER_NUMBER"]))
        assertNotNull(VtpJ.str(sent["DATE"]))
    }

    @Test
    fun approveDraftUsesType1AndReturnsCodeAndFee() = runBlocking {
        val mock = MockVtp()
        mock.handler = { 200 to """{"error":false,"message":"OK"}""" }
        val c = client(jwt(3600), mock)
        assertEquals(VtpDraftApproveResult("157491796322", 0), c.approveDraft("157491796322"))
        assertEquals(1, VtpJ.int(mock.requests[0].json["TYPE"]))
        mock.handler = { 200 to """{"error":false,"data":{"ORDER_NUMBER":"157800001111","MONEY_TOTAL":24500}}""" }
        assertEquals(VtpDraftApproveResult("157800001111", 24500), c.approveDraft("157800001111"))
    }

    @Test
    fun logNeverHoldsTokensOrFullPhones() = runBlocking {
        val mock = MockVtp()
        val tk = jwt(3600)
        mock.handler = { 200 to """{"error":false,"data":{"ORDER_NUMBER":"9","echo":"$tk 0987654321"}}""" }
        val c = client(tk, mock)
        c.insertDraft(JsonObject(emptyMap()))
        val all = c.log.joinToString("") { it.title + it.detail }
        assertFalse(all.contains(tk))
        assertFalse(all.contains("0987654321"))
    }

    @Test
    fun notLoggedIn() = runBlocking {
        val c = client(null, MockVtp(), refresh = null)
        assertFalse(c.loggedIn)
        try {
            c.insertDraft(JsonObject(emptyMap()))
            fail()
        } catch (e: VtpDraftError) {
            assertEquals(VtpDraftError.NotLoggedIn, e)
        }
    }

    @Test
    fun loginWithOtpThenWebSession() = runBlocking {
        val mock = MockVtp()
        val tk = jwt(12 * 3600)
        mock.handler = { r ->
            when (r.path) {
                "/api/v2/Login/PasswordCaptcha" -> 200 to """{"status":true,"verifyOtpKey":"k1","phoneNumber":"0987654321","email":"a@b.vn"}"""
                "/api/otp/sendOTP" -> 200 to """{"status":1}"""
                "/api/otp/verifyOTPV2" -> 200 to """{"status":1,"data":"otp-token"}"""
                "/api/Login/LoginUserPassTwoFAVerifyOtp" -> 200 to """{"accessToken":"sso"}"""
                "/api/user/ssoUpdateUser" -> 200 to """{"error":false,"data":{"TokenKey":"$tk","refreshToken":"rt","UserName":"Shop Thu","UserId":"77","Phone":"0987654321"}}"""
                "/api/setting/listInventoryV2" -> 200 to """[]"""
                else -> 404 to "{}"
            }
        }
        val store = VtpDraftMemoryStore()
        val c = client(null, mock, store, refresh = null)
        c.startLogin("0987654321", "mk")
        assertEquals("SSO_VERIFY_LOGIN", c.otpStep?.function)
        c.sendOtp("PHONE")
        assertEquals("PHONE", c.otpStep?.sentType)
        c.verifyOtp("123456")
        assertNull(c.lastError)
        assertTrue(c.loggedIn)
        assertNull(c.otpStep)
        assertEquals(tk, store.get("token"))
        assertEquals("0987 *** 321", c.phone)
        assertEquals("Shop Thu", c.displayName)
        assertTrue(c.owns("0987 *** 321"))
        // Mật khẩu không được lưu ở đâu.
        assertFalse(store.map.values.any { it.contains("mk") && it.length == 2 })
    }

    @Test
    fun phonesMatchHandlesMaskedAndNormalizedFormats() {
        assertEquals(true, VtpDraftClient.phonesMatch("+84 987 654 321", "0987654321"))
        assertEquals(true, VtpDraftClient.phonesMatch("0987 *** 321", "0987654321"))
        assertEquals(true, VtpDraftClient.phonesMatch("090•••222", "0900000222"))
        assertEquals(false, VtpDraftClient.phonesMatch("0987 *** 321", "0912345678"))
        assertNull(VtpDraftClient.phonesMatch("shop@vtp.vn", "0987654321"))
        assertEquals("0987654321", VtpDraftClient.normalizePhone("+84987654321"))
    }

    // MARK: - Nhiều tài khoản

    private fun loggedInSlot(store: VtpDraftMemoryStore, id: String, phone: String) {
        val p = if (id.isEmpty()) "" else "$id."
        val d = if (id.isEmpty()) "vtpDraft." else "vtpDraft.$id."
        store.set("${p}token", jwt(3600))
        store.set("${p}refresh", "rt")
        store.set("${d}login", phone)
        store.set("${d}userName", phone)
    }

    private fun group(ship: ShipInfo?): Vtp.Group {
        val c = Customer(id = "lan", uniqueId = "lan", userId = "", nickname = "Lan",
            address = DeliveryAddress(receiver = "Lan", phone = "0912345678", street = "12 Trần Thái Tông", region = "Phường Cầu Giấy, TP.Hà Nội"))
        val o = Order("s1", c, listOf(OrderItem(id = "i1", comment = "chốt", price = 150_000, ts = 1_000, groupId = "s1",
            ship = ship ?: ShipInfo(state = "ready", pay = "cod"), orderCode = "HD1")))
        return Vtp.readyGroups(listOf(o)).first()
    }

    @Test
    fun deleteUsesTheAccountThatPushedTheDraftAndReportsMissingAccount() = runBlocking {
        val mock = MockVtp()
        mock.handler = { 200 to """{"error":false}""" }
        val store = VtpDraftMemoryStore()
        loggedInSlot(store, "", "0900000001")
        loggedInSlot(store, "a2", "0900000002")
        store.set("vtpDraft.accounts", """["","a2"]""")
        val hub = VtpDraftHub("app", store, store, VtpDraftMemoryKeys(), mock.transport)
        assertEquals(2, hub.loggedInClients.size)
        hub.select("")
        val g = group(ShipInfo(state = "ready", pay = "cod", draftCode = "111", draftAccount = "0900 *** 002"))
        assertTrue(hub.deleteDrafts(g).isEmpty())
        val tokenOfA2 = store.get("a2.token")
        assertEquals(tokenOfA2, mock.requests.last().headers["token"])

        val other = group(ShipInfo(state = "ready", pay = "cod", draftCode = "222", draftAccount = "0911 *** 999"))
        val before = mock.requests.size
        val left = hub.deleteDrafts(other)
        assertEquals(listOf("222"), left.map { it.first })
        assertEquals("không có tài khoản đó thì không gửi gì", before, mock.requests.size)
        val outcome = hub.approveDraft(other, "222")
        assertTrue(outcome is VtpDraftApproveOutcome.Unavailable)
    }

    @Test
    fun addAccountThenAbandonLeavesNoEmptySlot() {
        val store = VtpDraftMemoryStore()
        loggedInSlot(store, "", "0900000001")
        val hub = VtpDraftHub("app", store, store, VtpDraftMemoryKeys(), MockVtp().transport)
        hub.addAccount()
        assertEquals(2, hub.clients.size)
        assertFalse(hub.current.loggedIn)
        // Mở lại app: chỗ chưa đăng nhập bị bỏ.
        val again = VtpDraftHub("app", store, store, VtpDraftMemoryKeys(), MockVtp().transport)
        assertEquals(1, again.clients.size)
        assertTrue(again.current.loggedIn)
    }

    @Test
    fun switchAppAccountRestoresChoiceAndSyncsWithPartner() {
        val store = VtpDraftMemoryStore()
        loggedInSlot(store, "", "0900000001")
        loggedInSlot(store, "a2", "0900000002")
        store.set("vtpDraft.accounts", """["","a2"]""")
        val hub = VtpDraftHub("shopA", store, store, VtpDraftMemoryKeys(), MockVtp().transport)
        hub.select("a2")
        hub.switchAppAccount("shopB")
        hub.syncWithPartner("0900 *** 001")
        assertEquals("", hub.currentId)
        hub.switchAppAccount("shopA")
        assertEquals("a2", hub.currentId)
    }

    // MARK: - Nội dung nháp

    @Test
    fun paymentMatchesServerRules() {
        assertEquals(3, VtpDraftBody.payment(100, true))
        assertEquals(2, VtpDraftBody.payment(100, false))
        assertEquals(1, VtpDraftBody.payment(0, true))
        assertEquals(4, VtpDraftBody.payment(0, false))
    }

    @Test
    fun bodyUsesSummaryMoneyAndPlaceCodes() {
        val g = group(null)
        val kho = VtpDraftKho("9", 45, "Shop Thu", "0900000000", "1 Lê Lợi", 1, 2, 3)
        val b = VtpDraftBody.make(g, kho, VtpDraftPlace(10, 20, 30, "", 1.0), "")
        assertEquals("VSL9", VtpJ.str(b["ORDER_SERVICE"]))
        assertEquals(g.summary.cod, VtpJ.int(b["MONEY_COLLECTION"]))
        assertEquals(g.summary.goods, VtpJ.int(b["PRODUCT_PRICE"]))
        assertEquals(10, VtpJ.int(b["RECEIVER_PROVINCE"]))
        assertEquals("1", VtpJ.str(b["SENDER_PROVINCE"]))
        assertEquals("HD1", VtpJ.str(b["ORDER_REFERENCE"]))
        assertEquals(12, VtpJ.int(b["TYPE"]))
    }

    @Test
    fun clipCountsBytesNotCharacters() {
        assertEquals("ăăă", VtpDraftBody.clip("ăăăă", 6))
        assertEquals("abc", VtpDraftBody.clip("abc", 150))
        assertEquals("", VtpDraftBody.clip("😀", 3))
    }

    @Test
    fun statusFollowsHash() {
        val plain = group(null)
        assertEquals(VtpDraftBody.Status.NotPushed, VtpDraftBody.status(plain, ""))
        val h = VtpDraftBody.hash(plain, "")
        val pushed = group(ShipInfo(state = "ready", pay = "cod", draftCode = "111", draftHash = h, draftAt = 5))
        assertEquals(VtpDraftBody.Status.Pushed("111", 5), VtpDraftBody.status(pushed, ""))
        assertTrue(VtpDraftBody.status(pushed, "SCN") is VtpDraftBody.Status.Stale)
        val failed = group(ShipInfo(state = "ready", pay = "cod", draftError = "Sai địa chỉ"))
        assertEquals(VtpDraftBody.Status.Failed("Sai địa chỉ"), VtpDraftBody.status(failed, ""))
        val withWaybill = group(ShipInfo(state = "ready", pay = "cod", vtpCode = "V1"))
        assertTrue(VtpDraftBody.problems(withWaybill).contains("Khách đã có vận đơn"))
    }

    @Test
    fun draftFieldsSurviveJsonAndAreOmittedWhenUnused() {
        val s = ShipInfo(state = "ready", draftCode = "111", draftAt = 1_700_000_000_000, draftHash = "ab", draftAccount = "0900 *** 001")
        val back = AppJson.decodeFromString(ShipInfo.serializer(), AppJson.encodeToString(ShipInfo.serializer(), s))
        assertEquals(s, back)
        assertFalse(AppJson.encodeToString(ShipInfo.serializer(), ShipInfo(state = "ready")).contains("draft"))
    }
}
