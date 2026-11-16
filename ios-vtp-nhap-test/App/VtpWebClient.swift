import CryptoKit
import Foundation

/// Gọi Viettel Post giống hệt trang viettelpost.vn, chạy ngay trên iPhone (đi từ IP của máy này):
/// đăng nhập SSO → OTP (nếu Viettel Post đòi) → đổi sang phiên web có chữ ký DPoP → lưu nháp.
/// Khoá ký P-256 tạo trên máy, nằm trong Keychain; máy chủ ChotLive không bao giờ thấy phiên này.
enum VtpEndpoints {
    static let sso = "https://oms-sso-2-api.viettelpost.vn"
    static let otp = "https://otp-verify.okd.viettelpost.vn"
    static let api = "https://api.viettelpost.vn"
    static let location = "https://location.viettelpost.vn/location/v1.0/address?system=VTP"
}

struct VtpOtpStep: Equatable {
    var function: String
    var verifyOtpKey: String?
    var phone: String
    var email: String
    var sentType: String?
}

struct VtpKho: Identifiable, Hashable {
    var id: String
    var cusId: Int
    var name: String
    var phone: String
    var address: String
    var province: Int
    var district: Int
    var ward: Int
}

struct VtpPlace {
    var province: Int
    var district: Int
    var ward: Int
    var formatted: String
    var confidence: Double
}

@MainActor
final class VtpWebClient: ObservableObject {
    @Published private(set) var token: String?
    @Published private(set) var refreshToken: String?
    @Published private(set) var userName: String
    @Published var otpStep: VtpOtpStep?
    @Published var busy = false
    @Published var lastError: String?
    @Published private(set) var kho: [VtpKho] = []

    let log: LogStore
    let deviceId: String
    private let deviceToken: String
    private let key: P256.Signing.PrivateKey
    private var nonce: String?

    var loggedIn: Bool { token != nil }

    init(log: LogStore) {
        self.log = log
        let d = UserDefaults.standard
        if let id = d.string(forKey: "vtp.deviceId") {
            deviceId = id
        } else {
            let id = String(Int(Date().timeIntervalSince1970 * 1000), radix: 36) + String(UUID().uuidString.prefix(8)).lowercased()
            d.set(id, forKey: "vtp.deviceId")
            deviceId = id
        }
        if let t = d.string(forKey: "vtp.deviceToken") {
            deviceToken = t
        } else {
            let t = UUID().uuidString.lowercased()
            d.set(t, forKey: "vtp.deviceToken")
            deviceToken = t
        }
        if let raw = Keychain.get("vtp.key"), let k = try? P256.Signing.PrivateKey(rawRepresentation: raw) {
            key = k
        } else {
            let k = P256.Signing.PrivateKey()
            Keychain.set(k.rawRepresentation, "vtp.key")
            key = k
        }
        userName = d.string(forKey: "vtp.userName") ?? ""
        token = Keychain.getString("vtp.token")
        refreshToken = Keychain.getString("vtp.refresh")
    }

    // MARK: - DPoP

    private func proof(_ method: String, _ url: URL, accessToken: String?) -> String {
        let raw = key.publicKey.rawRepresentation
        let jwk: [String: Any] = ["kty": "EC", "crv": "P-256", "x": raw.prefix(32).b64u, "y": raw.suffix(32).b64u]
        let header: [String: Any] = ["typ": "dpop+jwt", "alg": "ES256", "jwk": jwk]
        var payload: [String: Any] = [
            "jti": UUID().uuidString.lowercased(),
            "htm": method.uppercased(),
            "htu": "\(url.scheme ?? "https")://\(url.host ?? "")\(url.path)",
            "iat": Int(Date().timeIntervalSince1970)
        ]
        if let t = accessToken, !t.isEmpty { payload["ath"] = Data(SHA256.hash(data: Data(t.utf8))).b64u }
        if let n = nonce { payload["nonce"] = n }
        let input = J.data(header).b64u + "." + J.data(payload).b64u
        let sig = (try? key.signature(for: Data(input.utf8)).rawRepresentation) ?? Data()
        return input + "." + sig.b64u
    }

    /// POST tới api.viettelpost.vn kèm token + deviceId + chữ ký DPoP; Viettel Post đòi nonce thì gửi lại 1 lần.
    private func api(_ path: String, body: Any, token tk: String?, extra: [String: String] = [:], retried: Bool = false) async throws -> HttpReply {
        guard let url = URL(string: VtpEndpoints.api + path) else { throw VtpError.msg("Sai đường dẫn") }
        var h = ["deviceId": deviceId, "X-Token": proof("POST", url, accessToken: tk)]
        if let tk, !tk.isEmpty { h["token"] = tk }
        for (k, v) in extra { h[k] = v }
        let r = try await Http.send("POST", url, body: body, headers: h)
        if let n = r.nonce { nonce = n }
        let mk = J.str(J.dict(r.json)?["messageKey"]) ?? ""
        if !retried, r.nonce != nil, mk == "USE_DPOP_NONCE" || r.status == 401 {
            return try await api(path, body: body, token: tk, extra: extra, retried: true)
        }
        return r
    }

    private func authed(_ path: String, body: () -> Any) async throws -> HttpReply {
        try await ensureFresh()
        guard let tk = token else { throw VtpError.msg("Chưa đăng nhập Viettel Post") }
        var r = try await api(path, body: body(), token: tk)
        if J.str(J.dict(r.json)?["messageKey"]) == "EXPIRED_TOKEN" {
            log.add("Phiên hết hạn, làm mới rồi gửi lại", ok: false)
            try await refresh()
            r = try await api(path, body: body(), token: token)
        }
        return r
    }

    // MARK: - Đăng nhập

    func startLogin(user: String, password: String) async {
        busy = true
        lastError = nil
        defer { busy = false }
        do {
            let body: [String: Any] = ["clientId": "vtp.web", "clientSecret": "vtp.web", "deviceId": deviceId,
                                       "username": user, "password": password]
            let r = try await Http.send("POST", URL(string: VtpEndpoints.sso + "/api/v2/Login/PasswordCaptcha")!,
                                        body: body, headers: ["Token": ""])
            let j = J.dict(r.json) ?? [:]
            log.add("Đăng nhập SSO", r.text, ok: J.bool(j["status"]))
            let phone = J.str(j["phoneNumber"]) ?? user
            let email = J.str(j["email"]) ?? ""
            if J.bool(j["status"]), let at = J.str(j["accessToken"]), !at.isEmpty {
                try await finish(accessToken: at)
                return
            }
            if J.bool(j["status"]), J.bool(j["checkCaptcha"]) {
                log.add("Viettel Post đòi captcha → chuyển sang đăng nhập bằng OTP")
                otpStep = VtpOtpStep(function: "SSO_OTP_FALLBACK", verifyOtpKey: nil, phone: phone, email: email)
                return
            }
            if J.bool(j["status"]), let k = J.str(j["verifyOtpKey"]), !k.isEmpty {
                otpStep = VtpOtpStep(function: "SSO_VERIFY_LOGIN", verifyOtpKey: k, phone: phone, email: email)
                return
            }
            throw VtpError.msg(J.str(j["errorMessage"]) ?? "Đăng nhập thất bại (HTTP \(r.status))")
        } catch {
            fail("Đăng nhập", error)
        }
    }

    /// `type`: PHONE (SMS), EMAIL, MOCHA — đúng tên các nút trên web.
    func sendOtp(_ type: String) async {
        guard var step = otpStep else { return }
        busy = true
        lastError = nil
        defer { busy = false }
        do {
            let account = type == "EMAIL" ? step.email : step.phone
            let r = try await Http.send("POST", URL(string: VtpEndpoints.otp + "/api/otp/sendOTP")!, body: [
                "function": step.function, "otpType": "NUMBER", "account": account, "type": type, "deviceId": ""
            ])
            let j = J.dict(r.json) ?? [:]
            log.add("Gửi OTP qua \(type)", r.text, ok: J.int(j["status"]) == 1)
            guard J.int(j["status"]) == 1 else { throw VtpError.msg(J.str(j["message"]) ?? "Không gửi được OTP") }
            step.sentType = type
            otpStep = step
        } catch {
            fail("Gửi OTP", error)
        }
    }

    func verifyOtp(_ code: String) async {
        guard let step = otpStep, let type = step.sentType else { return }
        busy = true
        lastError = nil
        defer { busy = false }
        do {
            let account = type == "EMAIL" ? step.email : step.phone
            let v = try await Http.send("POST", URL(string: VtpEndpoints.otp + "/api/otp/verifyOTPV2")!, body: [
                "function": step.function, "secretValue": NSNull(), "otp": code, "type": type,
                "account": account, "expiredType": NSNull(), "deviceId": ""
            ] as [String: Any])
            let vj = J.dict(v.json) ?? [:]
            log.add("Xác thực OTP", v.text, ok: J.int(vj["status"]) == 1)
            guard J.int(vj["status"]) == 1, let tokenOTP = J.str(vj["data"]) else {
                throw VtpError.msg(J.str(vj["message"]) ?? "OTP sai hoặc hết hạn")
            }
            let r: HttpReply
            if step.function == "SSO_OTP_FALLBACK" {
                r = try await Http.send("POST", URL(string: VtpEndpoints.sso + "/api/v2/Login/otp-fallback")!,
                                        body: ["userName": account, "token": tokenOTP], headers: ["Token": ""])
            } else {
                r = try await Http.send("POST", URL(string: VtpEndpoints.sso + "/api/Login/LoginUserPassTwoFAVerifyOtp")!,
                                        body: ["tokenOtp": tokenOTP, "verifyOtpKey": step.verifyOtpKey ?? "", "deviceId": deviceId],
                                        headers: ["token": ""])
            }
            let j = J.dict(r.json) ?? [:]
            log.add("Đăng nhập sau OTP", r.text, ok: J.str(j["accessToken"]) != nil)
            guard let at = J.str(j["accessToken"]), !at.isEmpty else {
                throw VtpError.msg(J.str(j["errorMessage"]) ?? "Chưa đăng nhập được sau OTP")
            }
            otpStep = nil
            try await finish(accessToken: at)
        } catch {
            fail("OTP", error)
        }
    }

    private func finish(accessToken: String) async throws {
        let r = try await api("/api/user/ssoUpdateUser", body: [
            "TokenSSO": accessToken, "Type": "VTP", "Source": 3, "DeviceName": "VTP Nhap Test (iPhone)",
            "DeviceToken": deviceToken, "deviceId": deviceId, "deviceType": "WEB", "browser": "Safari"
        ] as [String: Any], token: nil)
        let j = J.dict(r.json) ?? [:]
        log.add("Đổi sang phiên web (DPoP)", r.text, ok: !J.bool(j["error"]))
        guard !J.bool(j["error"]), let d = J.dict(j["data"]), let tk = J.str(d["TokenKey"]) else {
            throw VtpError.msg(J.str(j["message"]) ?? "Không đổi được sang phiên web")
        }
        save(token: tk, refresh: J.str(d["refreshToken"]))
        userName = J.str(d["UserName"]) ?? ""
        UserDefaults.standard.set(userName, forKey: "vtp.userName")
        await loadKho()
    }

    func logout() {
        save(token: nil, refresh: nil)
        kho = []
        otpStep = nil
        log.add("Đã xoá phiên Viettel Post trên máy")
    }

    private func save(token t: String?, refresh rt: String?) {
        token = t
        refreshToken = rt
        Keychain.setString(t, "vtp.token")
        Keychain.setString(rt, "vtp.refresh")
    }

    private func fail(_ what: String, _ error: Error) {
        lastError = error.localizedDescription
        log.add("Lỗi: \(what)", error.localizedDescription, ok: false)
    }

    // MARK: - Phiên

    /// Hạn của token (giây) đọc từ JWT.
    var tokenExpiry: Date? {
        guard let t = token, t.split(separator: ".").count == 3,
              let d = Data(b64u: String(t.split(separator: ".")[1])),
              let exp = J.double(J.dict(J.obj(d))?["exp"]) else { return nil }
        return Date(timeIntervalSince1970: exp)
    }

    private func ensureFresh() async throws {
        guard token != nil else { throw VtpError.msg("Chưa đăng nhập Viettel Post") }
        if let exp = tokenExpiry, exp.timeIntervalSinceNow < 30 * 60 { try await refresh() }
    }

    func refresh() async throws {
        guard let tk = token, let rt = refreshToken else { throw VtpError.msg("Chưa đăng nhập Viettel Post") }
        let r = try await api("/api/sessions/refresh/v1", body: [String: Any](), token: tk, extra: ["refresh-token": rt])
        let j = J.dict(r.json) ?? [:]
        log.add("Làm mới phiên", r.text, ok: !J.bool(j["error"]))
        guard !J.bool(j["error"]), let d = J.dict(j["data"]), let nt = J.str(d["token"]) else {
            throw VtpError.msg("Làm mới phiên thất bại, đăng nhập lại")
        }
        save(token: nt, refresh: J.str(d["refreshToken"]) ?? rt)
    }

    func refreshNow() async {
        busy = true
        defer { busy = false }
        do { try await refresh() } catch { fail("Làm mới phiên", error) }
    }

    // MARK: - Dữ liệu

    func loadKho() async {
        do {
            let r = try await authed("/api/setting/listInventoryV2") { ["token": self.token ?? "", "deviceId": self.deviceId] }
            let arr = (r.json as? [[String: Any]]) ?? (J.dict(r.json)?["data"] as? [[String: Any]]) ?? []
            kho = arr.compactMap { k in
                guard let id = J.str(k["GROUPADDRESS_ID"]) else { return nil }
                return VtpKho(id: id, cusId: J.int(k["CUS_ID"]) ?? 0, name: J.str(k["NAME"]) ?? "",
                              phone: J.str(k["PHONE"]) ?? "", address: J.str(k["ADDRESS"]) ?? "",
                              province: J.int(k["PROVINCE_ID"]) ?? 0, district: J.int(k["DISTRICT_ID"]) ?? 0,
                              ward: J.int(k["WARDS_ID"]) ?? 0)
            }
            log.add("Kho hàng Viettel Post: \(kho.count)", kho.map { "\($0.name) · \($0.address)" }.joined(separator: "\n"), ok: !kho.isEmpty)
        } catch {
            fail("Đọc kho hàng", error)
        }
    }

    /// Đổi địa chỉ chữ thành mã tỉnh/quận/phường của Viettel Post (dịch vụ địa chỉ công khai của họ, nhận cả địa chỉ mới 2 cấp).
    func locate(_ address: String) async throws -> VtpPlace {
        let r = try await Http.send("POST", URL(string: VtpEndpoints.location)!, body: ["address": address])
        let j = J.dict(r.json) ?? [:]
        guard let p = J.int(j["vtpL1"]), let d = J.int(j["vtpL2"]), let w = J.int(j["vtpL3"]), p > 0, d > 0, w > 0 else {
            throw VtpError.msg("Viettel Post không hiểu địa chỉ: \(address)")
        }
        return VtpPlace(province: p, district: d, ward: w, formatted: J.str(j["formattedAddress"]) ?? address,
                        confidence: J.double(j["confidence"]) ?? 0)
    }

    /// Lưu một đơn nháp; trả mã nháp Viettel Post cấp.
    func insertDraft(_ body: [String: Any]) async throws -> String {
        var b = body
        b["deviceId"] = deviceId
        let r = try await authed("/api/tmdt/InsertOrderDraftForWeb") { b }
        let j = J.dict(r.json) ?? [:]
        log.add("Lưu nháp", r.text, ok: !J.bool(j["error"]))
        guard !J.bool(j["error"]), let code = J.str(J.dict(j["data"])?["ORDER_NUMBER"]) else {
            throw VtpError.msg(J.str(j["message"]) ?? "Viettel Post không lưu nháp (HTTP \(r.status))")
        }
        return code
    }
}
