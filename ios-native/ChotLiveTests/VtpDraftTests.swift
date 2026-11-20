import CryptoKit
import XCTest
@testable import ChotLive

/// Phần đẩy nháp Viettel Post chạy trên máy: chữ ký DPoP, che nhật ký, đọc JSON lỏng, giữ phiên khi mất mạng.
/// Không gọi Viettel Post thật: mọi yêu cầu đi qua MockVtp.
final class VtpDraftTests: XCTestCase {
    final class MemorySecrets: VtpDraftSecrets {
        var store: [String: Data] = [:]
        func get(_ key: String) -> Data? { store[key] }
        func set(_ data: Data?, _ key: String) { store[key] = data }
        func string(_ key: String) -> String? { store[key].map { String(decoding: $0, as: UTF8.self) } }
    }

    final class MockVtp {
        var requests: [URLRequest] = []
        /// Trả (mã HTTP, nội dung). Ném lỗi để giả mất mạng.
        var handler: (URLRequest) throws -> (Int, String) = { _ in (200, "{}") }

        var transport: VtpDraftTransport {
            { [unowned self] req in
                self.requests.append(req)
                let (status, text) = try self.handler(req)
                let resp = HTTPURLResponse(url: req.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
                return (Data(text.utf8), resp)
            }
        }
    }

    private func jwt(expiresIn seconds: TimeInterval) -> String {
        let payload = VtpJ.b64u(VtpJ.data(["exp": Int(Date().timeIntervalSince1970 + seconds), "sub": "test"]))
        return VtpJ.b64u(Data("{\"alg\":\"none\"}".utf8)) + "." + payload + ".c2ln"
    }

    @MainActor
    private func client(token: String?, refresh: String? = "rt-old", mock: MockVtp, secrets: MemorySecrets = MemorySecrets()) -> VtpDraftClient {
        if let token { secrets.set(Data(token.utf8), "token") }
        if let refresh { secrets.set(Data(refresh.utf8), "refresh") }
        let defaults = UserDefaults(suiteName: "vtpdraft-test-" + UUID().uuidString)!
        return VtpDraftClient(secrets: secrets, defaults: defaults, transport: mock.transport)
    }

    private func body(_ r: URLRequest) -> [String: Any] { VtpJ.dict(VtpJ.obj(r.httpBody ?? Data())) ?? [:] }

    // MARK: - DPoP

    func testProofIsES256With64ByteSignatureAndAth() throws {
        let key = P256.Signing.PrivateKey()
        let url = URL(string: "https://api.viettelpost.vn/api/tmdt/InsertOrderDraftForWeb?x=1")!
        let proof = VtpDpop.proof(key: key, method: "post", url: url, accessToken: "abc.def.ghi", nonce: "n-1")
        let parts = proof.split(separator: ".").map(String.init)
        XCTAssertEqual(parts.count, 3)

        let header = try XCTUnwrap(VtpJ.dict(VtpJ.obj(XCTUnwrap(VtpJ.unb64u(parts[0])))))
        XCTAssertEqual(header["alg"] as? String, "ES256")
        XCTAssertEqual(header["typ"] as? String, "dpop+jwt")
        let jwk = try XCTUnwrap(VtpJ.dict(header["jwk"]))
        XCTAssertEqual(VtpJ.unb64u(jwk["x"] as! String)?.count, 32)
        XCTAssertEqual(VtpJ.unb64u(jwk["y"] as! String)?.count, 32)

        let payload = try XCTUnwrap(VtpJ.dict(VtpJ.obj(XCTUnwrap(VtpJ.unb64u(parts[1])))))
        XCTAssertEqual(payload["htm"] as? String, "POST")
        XCTAssertEqual(payload["htu"] as? String, "https://api.viettelpost.vn/api/tmdt/InsertOrderDraftForWeb")
        XCTAssertEqual(payload["nonce"] as? String, "n-1")
        let expectedAth = VtpJ.b64u(Data(SHA256.hash(data: Data("abc.def.ghi".utf8))))
        XCTAssertEqual(payload["ath"] as? String, expectedAth)

        let sig = try XCTUnwrap(VtpJ.unb64u(parts[2]))
        XCTAssertEqual(sig.count, 64)
        let ecdsa = try P256.Signing.ECDSASignature(rawRepresentation: sig)
        XCTAssertTrue(key.publicKey.isValidSignature(ecdsa, for: Data((parts[0] + "." + parts[1]).utf8)))
    }

    func testProofWithoutTokenHasNoAth() throws {
        let proof = VtpDpop.proof(key: P256.Signing.PrivateKey(), method: "POST",
                                  url: URL(string: "https://api.viettelpost.vn/api/user/ssoUpdateUser")!, accessToken: nil, nonce: nil)
        let payload = try XCTUnwrap(VtpJ.dict(VtpJ.obj(XCTUnwrap(VtpJ.unb64u(String(proof.split(separator: ".")[1]))))))
        XCTAssertNil(payload["ath"])
        XCTAssertNil(payload["nonce"])
    }

    // MARK: - Che nhật ký, JSON lỏng

    func testMaskHidesJwtPhoneAndSiteToken() {
        let s = VtpMask.text("token eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiIxIn0.abc_DEF-123 sđt 0987654321 +84912345678 key 0123456789ABCDEF0123456789ABCDEF đơn 157491796322")
        XCTAssertFalse(s.contains("eyJ"))
        XCTAssertFalse(s.contains("0987654321"))
        XCTAssertFalse(s.contains("84912345678"))
        XCTAssertFalse(s.contains("0123456789ABCDEF0123456789ABCDEF"))
        XCTAssertTrue(s.contains("0987 *** 321"))
        XCTAssertTrue(s.contains("157491796322"), "mã nháp 12 số không phải số điện thoại, phải giữ")
    }

    func testLenientJson() {
        XCTAssertEqual(VtpJ.int("12"), 12)
        XCTAssertEqual(VtpJ.int(NSNumber(value: 7.6)), 8)
        XCTAssertNil(VtpJ.int("abc"))
        XCTAssertEqual(VtpJ.str(NSNumber(value: 157491796322)), "157491796322")
        XCTAssertEqual(VtpJ.double(" 3.5 "), 3.5)
        XCTAssertTrue(VtpJ.bool("true"))
        XCTAssertFalse(VtpJ.bool(NSNull()))
        XCTAssertTrue(VtpJ.isFalse(false))
        XCTAssertFalse(VtpJ.isFalse(nil), "thiếu trường error không được coi là thành công")
        let exp = VtpJ.jwtExpiry(jwt(expiresIn: 3600))
        XCTAssertNotNil(exp)
        XCTAssertGreaterThan(exp!.timeIntervalSinceNow, 3500)
        // 2026-01-01 00:00 UTC = 07:00 giờ Việt Nam (năm 1970 Việt Nam còn dùng UTC+8 nên không lấy mốc 0).
        XCTAssertEqual(VtpDraftClient.dateText(Date(timeIntervalSince1970: 1_767_225_600)), "01/01/2026 07:00:00")
    }

    // MARK: - Phiên

    @MainActor
    func testNetworkFailureDuringRefreshKeepsOldSession() async {
        let mock = MockVtp()
        mock.handler = { _ in throw URLError(.notConnectedToInternet) }
        let secrets = MemorySecrets()
        let old = jwt(expiresIn: 600)   // còn 10 phút → phải làm mới trước
        let c = client(token: old, mock: mock, secrets: secrets)
        await c.loadKho()
        XCTAssertEqual(c.lastError, "Mất mạng, thử lại khi có mạng")
        XCTAssertTrue(c.loggedIn)
        XCTAssertFalse(c.sessionExpired)
        XCTAssertEqual(secrets.string("token"), old)
        XCTAssertEqual(secrets.string("refresh"), "rt-old")
    }

    @MainActor
    func testRejectedRefreshMarksSessionExpiredWithoutDroppingIt() async {
        let mock = MockVtp()
        mock.handler = { _ in (200, #"{"error":true,"message":"Refresh token hết hạn"}"#) }
        let secrets = MemorySecrets()
        let c = client(token: jwt(expiresIn: -60), mock: mock, secrets: secrets)
        await c.loadKho()
        XCTAssertTrue(c.sessionExpired)
        XCTAssertTrue(c.loggedIn)
        XCTAssertEqual(secrets.string("refresh"), "rt-old")
        do {
            _ = try await c.insertDraft([:])
            XCTFail("phiên chết thì không được gửi nháp")
        } catch {
            XCTAssertEqual(error as? VtpDraftError, .sessionExpired)
        }
    }

    @MainActor
    func testRefreshThenLoadKho() async {
        let mock = MockVtp()
        let fresh = jwt(expiresIn: 12 * 3600)
        mock.handler = { req in
            switch req.url!.path {
            case "/api/sessions/refresh/v1":
                XCTAssertEqual(req.value(forHTTPHeaderField: "refresh-token"), "rt-old")
                return (200, #"{"error":false,"data":{"token":"\#(fresh)","refreshToken":"rt-new"}}"#)
            case "/api/setting/listInventoryV2":
                XCTAssertEqual(req.value(forHTTPHeaderField: "token"), fresh)
                XCTAssertNotNil(req.value(forHTTPHeaderField: "X-Token"))
                XCTAssertNotNil(req.value(forHTTPHeaderField: "deviceId"))
                return (200, #"[{"GROUPADDRESS_ID":"123","CUS_ID":"45","NAME":"Shop Thu","PHONE":"0900000000","ADDRESS":"12 Trần Hưng Đạo","PROVINCE_ID":"1","DISTRICT_ID":2,"WARDS_ID":3}]"#)
            default:
                XCTFail("không mong đợi \(req.url!.path)")
                return (404, "{}")
            }
        }
        let secrets = MemorySecrets()
        let c = client(token: jwt(expiresIn: 60), mock: mock, secrets: secrets)
        await c.loadKho()
        XCTAssertNil(c.lastError)
        XCTAssertEqual(secrets.string("token"), fresh)
        XCTAssertEqual(secrets.string("refresh"), "rt-new")
        XCTAssertEqual(c.kho.first?.cusId, 45)
        XCTAssertEqual(c.kho.first?.province, 1)
        XCTAssertEqual(c.khoId, "123")
    }

    @MainActor
    func testConcurrentCallsRefreshOnlyOnce() async throws {
        let mock = MockVtp()
        let fresh = jwt(expiresIn: 12 * 3600)
        mock.handler = { req in
            if req.url!.path == "/api/sessions/refresh/v1" {
                return (200, #"{"error":false,"data":{"token":"\#(fresh)","refreshToken":"rt-new"}}"#)
            }
            return (200, #"{"error":false,"data":{"ORDER_NUMBER":"1"}}"#)
        }
        let c = client(token: jwt(expiresIn: 60), mock: mock)
        async let a = c.insertDraft([:])
        async let b = c.insertDraft([:])
        _ = try await (a, b)
        XCTAssertEqual(mock.requests.filter { $0.url!.path == "/api/sessions/refresh/v1" }.count, 1)
    }

    // MARK: - Lưu, xoá, duyệt nháp

    @MainActor
    func testCloudflareBlockStopsWithClearError() async {
        let mock = MockVtp()
        mock.handler = { _ in (403, "<!DOCTYPE html><title>Attention Required! | Cloudflare</title>") }
        let c = client(token: jwt(expiresIn: 3600), mock: mock)
        do {
            _ = try await c.insertDraft(["RECEIVER_FULLNAME": "A"])
            XCTFail("phải báo bị chặn")
        } catch {
            XCTAssertEqual(error as? VtpDraftError, .blocked)
        }
        XCTAssertEqual(mock.requests.count, 1, "bị chặn thì không thử lại dồn dập")
    }

    @MainActor
    func testInsertDraftReturnsOrderNumberAndSendsDeviceId() async throws {
        let mock = MockVtp()
        mock.handler = { _ in (200, #"{"error":false,"data":{"ORDER_NUMBER":157491796322}}"#) }
        let c = client(token: jwt(expiresIn: 3600), mock: mock)
        let code = try await c.insertDraft(["TYPE": 12])
        XCTAssertEqual(code, "157491796322")
        let sent = body(mock.requests[0])
        XCTAssertEqual(sent["deviceId"] as? String, c.deviceId)
        XCTAssertEqual(VtpJ.int(sent["TYPE"]), 12)
    }

    @MainActor
    func testDeleteDraftSendsType11AndSurfacesViettelPostMessage() async {
        let mock = MockVtp()
        mock.handler = { _ in (200, #"{"error":true,"message":"Không tìm thấy đơn hàng"}"#) }
        let c = client(token: jwt(expiresIn: 3600), mock: mock)
        do {
            try await c.deleteDraft("157491796322")
            XCTFail("Viettel Post báo lỗi thì không được coi là đã xoá")
        } catch {
            XCTAssertEqual(error as? VtpDraftError, .server("Không tìm thấy đơn hàng"))
        }
        let sent = body(mock.requests[0])
        XCTAssertEqual(mock.requests[0].url?.path, "/api/tmdt/UpdateOrder")
        XCTAssertEqual(VtpJ.int(sent["TYPE"]), 11)
        XCTAssertEqual(sent["ORDER_NUMBER"] as? String, "157491796322")
        XCTAssertNotNil(sent["DATE"] as? String)
    }

    @MainActor
    func testApproveDraftUsesType1() async throws {
        let mock = MockVtp()
        mock.handler = { _ in (200, #"{"error":false,"message":"OK"}"#) }
        let c = client(token: jwt(expiresIn: 3600), mock: mock)
        try await c.approveDraft("157491796322")
        XCTAssertEqual(VtpJ.int(body(mock.requests[0])["TYPE"]), 1)
    }

    @MainActor
    func testLogNeverHoldsTokensOrFullPhones() async throws {
        let mock = MockVtp()
        let tk = jwt(expiresIn: 3600)
        mock.handler = { _ in (200, #"{"error":false,"data":{"ORDER_NUMBER":"9","echo":"\#(tk) 0987654321"}}"#) }
        let c = client(token: tk, mock: mock)
        _ = try await c.insertDraft([:])
        let all = c.log.map { $0.title + $0.detail }.joined()
        XCTAssertFalse(all.contains(tk))
        XCTAssertFalse(all.contains("0987654321"))
    }

    @MainActor
    func testNotLoggedIn() async {
        let c = client(token: nil, refresh: nil, mock: MockVtp())
        XCTAssertFalse(c.loggedIn)
        do {
            _ = try await c.insertDraft([:])
            XCTFail()
        } catch {
            XCTAssertEqual(error as? VtpDraftError, .notLoggedIn)
        }
    }

    @MainActor
    func testKhoCachePersistsAndFailureDoesNotWipeCache() async {
        let mock = MockVtp()
        mock.handler = { _ in
            (200, #"[{"GROUPADDRESS_ID":"123","CUS_ID":"45","NAME":"Kho A","PHONE":"0900000000","ADDRESS":"1 Lê Lợi","PROVINCE_ID":"1","DISTRICT_ID":2,"WARDS_ID":3}]"#)
        }
        let secrets = MemorySecrets()
        let defaults = UserDefaults(suiteName: "vtpdraft-kho-" + UUID().uuidString)!
        let tk = jwt(expiresIn: 3600)
        secrets.set(Data(tk.utf8), "token")
        secrets.set(Data("rt-old".utf8), "refresh")
        let c = VtpDraftClient(secrets: secrets, defaults: defaults, transport: mock.transport)
        await c.loadKho()
        XCTAssertEqual(c.kho.map(\.id), ["123"])
        XCTAssertTrue(c.khoLoadedThisSession)
        XCTAssertNil(c.lastError)

        // Mở lại app với máy chủ lỗi: vẫn giữ kho đã cache và báo lỗi rõ ràng.
        let failMock = MockVtp()
        failMock.handler = { _ in (500, #"{"error":true,"message":"Lỗi hệ thống"}"#) }
        let relaunched = VtpDraftClient(secrets: secrets, defaults: defaults, transport: failMock.transport)
        XCTAssertEqual(relaunched.kho.map(\.id), ["123"])
        XCTAssertFalse(relaunched.khoLoadedThisSession)
        await relaunched.loadKho()
        XCTAssertEqual(relaunched.kho.map(\.id), ["123"])
        XCTAssertEqual(relaunched.lastError, "Lỗi hệ thống")
        XCTAssertFalse(relaunched.khoLoadedThisSession)
    }

    @MainActor
    func testPersistent401MarksSessionExpired() async {
        let mock = MockVtp()
        let fresh = jwt(expiresIn: 3600)
        mock.handler = { req in
            if req.url!.path == "/api/sessions/refresh/v1" {
                return (200, #"{"error":false,"data":{"token":"\#(fresh)","refreshToken":"rt-new"}}"#)
            }
            return (401, #"{"error":true,"messageKey":"EXPIRED_TOKEN","message":"Hết phiên"}"#)
        }
        let c = client(token: jwt(expiresIn: 3600), mock: mock)
        do {
            _ = try await c.insertDraft([:])
            XCTFail("401 lặp lại phải đánh dấu hết phiên")
        } catch {
            XCTAssertEqual(error as? VtpDraftError, .sessionExpired)
            XCTAssertTrue(c.sessionExpired)
        }
    }

    @MainActor
    func testReloginWithDifferentAccountClearsOldKho() async {
        let mock = MockVtp()
        let tk1 = jwt(expiresIn: 3600), tk2 = jwt(expiresIn: 3600)
        mock.handler = { req in
            let reqBody = VtpJ.dict(VtpJ.obj(req.httpBody ?? Data())) ?? [:]
            switch req.url!.path {
            case "/api/v2/Login/PasswordCaptcha":
                let isSecond = VtpJ.str(reqBody["username"]) == "0900000222"
                let phone = isSecond ? "0900000222" : "0900000111"
                let sso = isSecond ? "sso-2" : "sso-1"
                return (200, #"{"status":true,"accessToken":"\#(sso)","phoneNumber":"\#(phone)"}"#)
            case "/api/user/ssoUpdateUser":
                let isSecond = VtpJ.str(reqBody["TokenSSO"]) == "sso-2"
                let uid = isSecond ? "200" : "100"
                let phone = isSecond ? "0900000222" : "0900000111"
                let tk = isSecond ? tk2 : tk1
                let label = isSecond ? "Shop 2" : "Shop 1"
                return (200, #"{"error":false,"data":{"TokenKey":"\#(tk)","refreshToken":"rt","UserName":"\#(label)","Phone":"\#(phone)","UserId":"\#(uid)"}}"#)
            case "/api/setting/listInventoryV2":
                let isSecond = VtpJ.str(reqBody["token"]) == tk2
                let kid = isSecond ? "222" : "111"
                let label = isSecond ? "Kho 2" : "Kho 1"
                return (200, #"[{"GROUPADDRESS_ID":"\#(kid)","CUS_ID":1,"NAME":"\#(label)","PHONE":"0900000000","ADDRESS":"A","PROVINCE_ID":1,"DISTRICT_ID":2,"WARDS_ID":3}]"#)
            default:
                return (404, "{}")
            }
        }
        let secrets = MemorySecrets()
        let defaults = UserDefaults(suiteName: "vtpdraft-switch-" + UUID().uuidString)!
        let c = VtpDraftClient(secrets: secrets, defaults: defaults, transport: mock.transport)
        await c.startLogin(user: "0900000111", password: "pw")
        c.pickKho("111")
        XCTAssertTrue(c.khoPicked)
        XCTAssertEqual(c.kho.map(\.id), ["111"])

        // Đăng nhập đè bằng tài khoản Viettel Post khác trên cùng slot: xoá kho và lựa chọn kho cũ.
        await c.startLogin(user: "0900000222", password: "pw")
        XCTAssertEqual(c.kho.map(\.id), ["222"])
        XCTAssertEqual(c.khoId, "222")
        XCTAssertFalse(c.khoPicked)
    }
}
