import CryptoKit
import Foundation

/// Đẩy đơn NHÁP lên Viettel Post, chạy ngay trên iPhone (đi từ IP của máy này, không qua máy chủ ChốtLive).
///
/// Đi đúng đường trang viettelpost.vn: đăng nhập SSO → OTP nếu Viettel Post đòi → đổi sang phiên web có chữ ký
/// DPoP → lưu nháp. Đây là cổng web KHÔNG chính thức, Viettel Post có thể đổi bất cứ lúc nào. Tạo vận đơn thật
/// vẫn đi đường API đối tác qua máy chủ (VtpApi.swift), không dùng lớp này.
///
/// Khoá ký P-256, token và refresh token nằm trong Keychain; mật khẩu và OTP không lưu ở đâu cả.
struct VtpDraftOtpStep: Equatable {
    /// SSO_VERIFY_LOGIN (máy đăng nhập lần đầu) hoặc SSO_OTP_FALLBACK (Viettel Post đòi captcha).
    var function: String
    var verifyOtpKey: String?
    var phone: String
    var email: String
    /// Kênh đã gửi mã: PHONE (SMS) hoặc EMAIL. nil = chưa gửi.
    var sentType: String?
}

struct VtpDraftKho: Identifiable, Hashable {
    var id: String          // GROUPADDRESS_ID
    var cusId: Int
    var name: String
    var phone: String
    var address: String
    var province: Int
    var district: Int
    var ward: Int
}

struct VtpDraftPlace: Equatable {
    var province: Int
    var district: Int
    var ward: Int
    var formatted: String
    var confidence: Double
}

@MainActor
final class VtpDraftClient: ObservableObject {
    enum Endpoint {
        static let sso = "https://oms-sso-2-api.viettelpost.vn"
        static let otp = "https://otp-verify.okd.viettelpost.vn"
        static let api = "https://api.viettelpost.vn"
        static let location = "https://location.viettelpost.vn/location/v1.0/address?system=VTP"
    }

    /// deviceId, DeviceToken và khoá ký dùng chung cho mọi tài khoản trên máy (như một trình duyệt đăng nhập
    /// nhiều tài khoản). Phiên, tên, kho thì riêng từng tài khoản: tài khoản đầu tiên (`accountId` rỗng) giữ
    /// đúng tên khoá cũ để phiên đã đăng nhập từ bản trước vẫn dùng được.
    private enum Keys {
        static let deviceId = "vtpDraft.deviceId"
        static let deviceToken = "vtpDraft.deviceToken"
        static let key = "key"
    }

    private func dkey(_ name: String) -> String { accountId.isEmpty ? "vtpDraft.\(name)" : "vtpDraft.\(accountId).\(name)" }
    private func skey(_ name: String) -> String { accountId.isEmpty ? name : "\(accountId).\(name)" }

    @Published private(set) var loggedIn = false
    /// Tên đăng nhập Viettel Post (thường là số điện thoại). Hiện ra màn hình thì dùng `phone` (đã che).
    @Published private(set) var userName: String
    @Published private(set) var loading = false
    @Published private(set) var loadingKho = false
    @Published var lastError: String?
    @Published var otpStep: VtpDraftOtpStep?
    /// Viettel Post từ chối làm mới phiên: còn token cũ nhưng phải đăng nhập lại.
    @Published private(set) var sessionExpired = false
    @Published private(set) var kho: [VtpDraftKho] = []
    @Published var khoId: String? {
        didSet { defaults.set(khoId, forKey: dkey("khoId")) }
    }
    /// Tên đăng nhập đã gõ (thường là số điện thoại). Viettel Post trả `UserName` là họ tên, nên phải giữ riêng
    /// để so với tài khoản phần 1 và để hiện số đã che.
    @Published private(set) var login: String
    @Published private(set) var log: [VtpDraftLogEntry] = []

    /// Số đăng nhập đã che ("0987 *** 321"); rỗng khi chưa biết (phiên từ bản cũ chưa lưu số).
    var phone: String {
        let raw = !login.isEmpty ? login : (userName.filter(\.isNumber).count >= 9 ? userName : "")
        return VtpMask.text(raw)
    }
    /// Họ tên Viettel Post trả về (khác số điện thoại).
    var displayName: String { userName.filter(\.isNumber).count >= 9 ? "" : userName }
    /// Nhãn ghi vào đơn khi đẩy nháp (`draftAccount`): số đã che, chưa biết số thì họ tên.
    var accountLabel: String { phone.isEmpty ? userName : phone }
    /// Nháp ghi `draftAccount` này có phải của tài khoản này không (nhãn cũ có thể là họ tên).
    func owns(_ draftAccount: String) -> Bool {
        let a = draftAccount.trimmingCharacters(in: .whitespaces)
        guard !a.isEmpty else { return false }
        return a == phone || a == userName || a == accountLabel
    }
    var selectedKho: VtpDraftKho? { kho.first { $0.id == khoId } ?? kho.first }
    var tokenExpiry: Date? { VtpJ.jwtExpiry(token) }

    /// Khoá phân biệt tài khoản trên máy này ("" = tài khoản đầu tiên, dùng khoá cũ).
    let accountId: String
    let deviceId: String
    private let deviceToken: String
    private let key: P256.Signing.PrivateKey
    private let secrets: VtpDraftSecrets
    private let defaults: UserDefaults
    private let transport: VtpDraftTransport
    private var token: String?
    private var refreshToken: String?
    private var nonce: String?
    private var refreshTask: Task<Void, Error>?

    init(accountId: String = "", secrets: VtpDraftSecrets = VtpDraftKeychain(), defaults: UserDefaults = .standard,
         transport: @escaping VtpDraftTransport = VtpDraftHttp.live) {
        self.accountId = accountId
        self.secrets = secrets
        self.defaults = defaults
        self.transport = transport
        if let id = defaults.string(forKey: Keys.deviceId) {
            deviceId = id
        } else {
            let id = String(Int(Date().timeIntervalSince1970 * 1000), radix: 36) + String(UUID().uuidString.prefix(8)).lowercased()
            defaults.set(id, forKey: Keys.deviceId)
            deviceId = id
        }
        if let t = defaults.string(forKey: Keys.deviceToken) {
            deviceToken = t
        } else {
            let t = UUID().uuidString.lowercased()
            defaults.set(t, forKey: Keys.deviceToken)
            deviceToken = t
        }
        if let raw = secrets.get(Keys.key), let k = try? P256.Signing.PrivateKey(rawRepresentation: raw) {
            key = k
        } else {
            let k = P256.Signing.PrivateKey()
            secrets.set(k.rawRepresentation, Keys.key)
            key = k
        }
        let dk = { (n: String) in accountId.isEmpty ? "vtpDraft.\(n)" : "vtpDraft.\(accountId).\(n)" }
        let sk = { (n: String) in accountId.isEmpty ? n : "\(accountId).\(n)" }
        userName = defaults.string(forKey: dk("userName")) ?? ""
        login = defaults.string(forKey: dk("login")) ?? ""
        khoId = defaults.string(forKey: dk("khoId"))
        token = secrets.get(sk("token")).map { String(decoding: $0, as: UTF8.self) }
        refreshToken = secrets.get(sk("refresh")).map { String(decoding: $0, as: UTF8.self) }
        loggedIn = token != nil
    }

    // MARK: - Đăng nhập

    func startLogin(user: String, password: String) async {
        let user = user.trimmingCharacters(in: .whitespaces)
        guard !user.isEmpty, !password.isEmpty else {
            lastError = "Nhập tên đăng nhập và mật khẩu Viettel Post"
            return
        }
        await run("Đăng nhập") {
            self.pendingUser = user
            var body: [String: Any] = ["clientId": "vtp.web", "clientSecret": "vtp.web", "deviceId": self.deviceId]
            body["username"] = user
            body["password"] = password
            let r = try await self.post(Endpoint.sso + "/api/v2/Login/PasswordCaptcha", body, headers: ["Token": ""])
            let j = VtpJ.dict(r.json) ?? [:]
            let ok = VtpJ.bool(j["status"])
            self.note("Đăng nhập SSO", r.text, ok: ok)
            let phone = VtpJ.str(j["phoneNumber"]) ?? user
            let email = VtpJ.str(j["email"]) ?? ""
            if ok, let at = VtpJ.str(j["accessToken"]), !at.isEmpty {
                try await self.finish(accessToken: at, user: user)
            } else if ok, VtpJ.bool(j["checkCaptcha"]) {
                self.otpStep = VtpDraftOtpStep(function: "SSO_OTP_FALLBACK", verifyOtpKey: nil, phone: phone, email: email)
            } else if ok, let k = VtpJ.str(j["verifyOtpKey"]), !k.isEmpty {
                self.otpStep = VtpDraftOtpStep(function: "SSO_VERIFY_LOGIN", verifyOtpKey: k, phone: phone, email: email)
            } else {
                throw VtpDraftError.server(VtpJ.str(j["errorMessage"]) ?? "Đăng nhập thất bại (HTTP \(r.status))")
            }
        }
    }

    private var pendingUser = ""

    /// `type`: "PHONE" (SMS) hoặc "EMAIL", đúng tên kênh trên trang Viettel Post.
    func sendOtp(_ type: String) async {
        guard var step = otpStep else { return }
        await run("Gửi OTP") {
            let account = type == "EMAIL" ? step.email : step.phone
            var body: [String: Any] = ["function": step.function, "otpType": "NUMBER", "type": type, "deviceId": ""]
            body["account"] = account
            let r = try await self.post(Endpoint.otp + "/api/otp/sendOTP", body)
            let j = VtpJ.dict(r.json) ?? [:]
            let ok = VtpJ.int(j["status"]) == 1
            self.note("Gửi OTP qua \(type)", r.text, ok: ok)
            guard ok else { throw VtpDraftError.server(VtpJ.str(j["message"]) ?? "Không gửi được OTP") }
            step.sentType = type
            self.otpStep = step
        }
    }

    func verifyOtp(_ code: String) async {
        guard let step = otpStep, let type = step.sentType else {
            lastError = "Chưa gửi mã OTP"
            return
        }
        await run("Xác thực OTP") {
            let account = type == "EMAIL" ? step.email : step.phone
            var vb: [String: Any] = ["function": step.function, "type": type, "deviceId": ""]
            vb["otp"] = code.trimmingCharacters(in: .whitespaces)
            vb["account"] = account
            vb["secretValue"] = NSNull()
            vb["expiredType"] = NSNull()
            let v = try await self.post(Endpoint.otp + "/api/otp/verifyOTPV2", vb)
            let vj = VtpJ.dict(v.json) ?? [:]
            self.note("Xác thực OTP", v.text, ok: VtpJ.int(vj["status"]) == 1)
            guard VtpJ.int(vj["status"]) == 1, let tokenOTP = VtpJ.str(vj["data"]), !tokenOTP.isEmpty else {
                throw VtpDraftError.server(VtpJ.str(vj["message"]) ?? "OTP sai hoặc đã hết hạn")
            }
            let r: VtpDraftReply
            if step.function == "SSO_OTP_FALLBACK" {
                r = try await self.post(Endpoint.sso + "/api/v2/Login/otp-fallback",
                                        ["userName": account, "token": tokenOTP], headers: ["Token": ""])
            } else {
                var b: [String: Any] = ["tokenOtp": tokenOTP, "deviceId": self.deviceId]
                b["verifyOtpKey"] = step.verifyOtpKey ?? ""
                r = try await self.post(Endpoint.sso + "/api/Login/LoginUserPassTwoFAVerifyOtp", b, headers: ["token": ""])
            }
            let j = VtpJ.dict(r.json) ?? [:]
            self.note("Đăng nhập sau OTP", r.text, ok: VtpJ.str(j["accessToken"]) != nil)
            guard let at = VtpJ.str(j["accessToken"]), !at.isEmpty else {
                throw VtpDraftError.server(VtpJ.str(j["errorMessage"]) ?? "Chưa đăng nhập được sau OTP")
            }
            self.otpStep = nil
            try await self.finish(accessToken: at, user: self.pendingUser.isEmpty ? step.phone : self.pendingUser)
        }
    }

    func cancelOtp() { otpStep = nil }

    /// Đổi token SSO sang phiên web (token gắn với khoá ký của máy qua DPoP).
    private func finish(accessToken: String, user: String) async throws {
        var body: [String: Any] = ["TokenSSO": accessToken, "Type": "VTP", "Source": 3]
        body["DeviceName"] = "ChotLive (iPhone)"
        body["DeviceToken"] = deviceToken
        body["deviceId"] = deviceId
        body["deviceType"] = "WEB"
        body["browser"] = "Safari"
        let r = try await api("/api/user/ssoUpdateUser", body: body, token: nil)
        let j = VtpJ.dict(r.json) ?? [:]
        note("Đổi sang phiên web", r.text, ok: !VtpJ.bool(j["error"]))
        guard !VtpJ.bool(j["error"]), let d = VtpJ.dict(j["data"]), let tk = VtpJ.str(d["TokenKey"]), !tk.isEmpty else {
            throw VtpDraftError.server(VtpJ.str(j["message"]) ?? "Không đổi được sang phiên web Viettel Post")
        }
        save(token: tk, refresh: VtpJ.str(d["refreshToken"]))
        let name = VtpJ.str(d["UserName"]) ?? VtpJ.str(d["Phone"]) ?? user
        userName = name
        defaults.set(name, forKey: dkey("userName"))
        // Số đăng nhập: ưu tiên số Viettel Post trả về, không có thì đúng chuỗi người dùng đã gõ.
        let phoneNo = VtpJ.str(d["Phone"]) ?? VtpJ.str(d["PHONE"]) ?? ""
        login = phoneNo.filter(\.isNumber).count >= 9 ? phoneNo : user
        defaults.set(login, forKey: dkey("login"))
        pendingUser = ""
        await loadKho()
    }

    /// Xoá phiên trên máy này. Khoá ký và deviceId giữ lại để lần sau Viettel Post vẫn nhận ra máy.
    func logout() {
        save(token: nil, refresh: nil)
        kho = []
        otpStep = nil
        lastError = nil
        note("Đã đăng xuất Viettel Post trên máy này", "")
    }

    // MARK: - Phiên

    /// Làm mới khi token còn dưới 30 phút (hoặc đã hết). Gọi trước mọi lệnh tới Viettel Post.
    func ensureFresh() async throws {
        guard token != nil else { throw VtpDraftError.notLoggedIn }
        if sessionExpired { throw VtpDraftError.sessionExpired }
        if let exp = tokenExpiry, exp.timeIntervalSinceNow < 30 * 60 { try await refresh() }
    }

    /// Gọi khi mở app: làm mới nếu sắp hết, lỗi thì im lặng (đã hiện ở trạng thái phiên).
    func refreshQuietly() async {
        guard loggedIn, !sessionExpired else { return }
        try? await ensureFresh()
    }

    /// Bỏ hẳn tài khoản khỏi máy: xoá phiên, tên, kho. Khoá ký dùng chung nên giữ lại.
    func forget() {
        save(token: nil, refresh: nil)
        for n in ["userName", "login", "khoId"] { defaults.removeObject(forKey: dkey(n)) }
        userName = ""
        login = ""
        kho = []
    }

    func refreshNow() async {
        await run("Làm mới phiên") { try await self.refresh() }
    }

    /// Mỗi lúc chỉ một lần làm mới: refresh token có thể chỉ dùng được một lần.
    /// Mất mạng hay Viettel Post không trả lời: giữ nguyên phiên cũ. Chỉ ghi đè khi Viettel Post trả thành công.
    private func refresh() async throws {
        if let t = refreshTask { return try await t.value }
        let t = Task { @MainActor in try await self.doRefresh() }
        refreshTask = t
        defer { refreshTask = nil }
        try await t.value
    }

    private func doRefresh() async throws {
        guard let tk = token, let rt = refreshToken, !rt.isEmpty else { throw VtpDraftError.notLoggedIn }
        let r = try await api("/api/sessions/refresh/v1", body: [String: Any](), token: tk, extra: ["refresh-token": rt])
        let j = VtpJ.dict(r.json) ?? [:]
        let d = VtpJ.dict(j["data"])
        let nt = VtpJ.str(d?["token"]) ?? VtpJ.str(d?["TokenKey"])
        note("Làm mới phiên", r.text, ok: nt != nil)
        guard !VtpJ.bool(j["error"]), let nt, !nt.isEmpty else {
            // Viettel Post trả lời rõ là không làm mới được: phiên đã chết, giữ token để hiện "cần đăng nhập lại".
            if r.json != nil { sessionExpired = true }
            throw VtpDraftError.sessionExpired
        }
        save(token: nt, refresh: VtpJ.str(d?["refreshToken"]) ?? rt)
    }

    private func save(token t: String?, refresh rt: String?) {
        token = t
        refreshToken = rt
        secrets.set(t.map { Data($0.utf8) }, skey("token"))
        secrets.set(rt.map { Data($0.utf8) }, skey("refresh"))
        loggedIn = t != nil
        sessionExpired = false
    }

    // MARK: - Dữ liệu

    func loadKho() async {
        guard loggedIn, !loadingKho else { return }
        loadingKho = true
        defer { loadingKho = false }
        do {
            let r = try await authed("/api/setting/listInventoryV2") { ["token": self.token ?? "", "deviceId": self.deviceId] }
            let arr = (r.json as? [[String: Any]]) ?? (VtpJ.dict(r.json)?["data"] as? [[String: Any]]) ?? []
            kho = arr.compactMap(Self.parseKho)
            if khoId == nil || !kho.contains(where: { $0.id == khoId }) { khoId = kho.first?.id }
            note("Kho hàng Viettel Post: \(kho.count)", kho.map { "\($0.name) · \($0.address)" }.joined(separator: "\n"),
                 ok: !kho.isEmpty)
        } catch {
            fail("Đọc kho hàng", error)
        }
    }

    nonisolated static func parseKho(_ k: [String: Any]) -> VtpDraftKho? {
        guard let id = VtpJ.str(k["GROUPADDRESS_ID"]), !id.isEmpty else { return nil }
        return VtpDraftKho(id: id, cusId: VtpJ.int(k["CUS_ID"]) ?? 0, name: VtpJ.str(k["NAME"]) ?? "",
                           phone: VtpJ.str(k["PHONE"]) ?? "", address: VtpJ.str(k["ADDRESS"]) ?? "",
                           province: VtpJ.int(k["PROVINCE_ID"]) ?? 0, district: VtpJ.int(k["DISTRICT_ID"]) ?? 0,
                           ward: VtpJ.int(k["WARDS_ID"]) ?? 0)
    }

    /// Địa chỉ chữ → mã tỉnh/quận/phường Viettel Post (dịch vụ địa chỉ công khai, hiểu cả địa chỉ mới 2 cấp).
    func locate(_ address: String) async throws -> VtpDraftPlace {
        let r = try await post(Endpoint.location, ["address": address])
        let j = VtpJ.dict(r.json) ?? [:]
        guard let p = VtpJ.int(j["vtpL1"]), let d = VtpJ.int(j["vtpL2"]), let w = VtpJ.int(j["vtpL3"]),
              p > 0, d > 0, w > 0 else {
            throw VtpDraftError.server("Viettel Post không nhận ra địa chỉ: \(address)")
        }
        return VtpDraftPlace(province: p, district: d, ward: w, formatted: VtpJ.str(j["formattedAddress"]) ?? address,
                             confidence: VtpJ.double(j["confidence"]) ?? 0)
    }

    /// Lưu một đơn nháp; trả mã nháp (ORDER_NUMBER) Viettel Post cấp.
    func insertDraft(_ body: [String: Any]) async throws -> String {
        var b = body
        b["deviceId"] = deviceId
        let r = try await authed("/api/tmdt/InsertOrderDraftForWeb") { b }
        let j = VtpJ.dict(r.json) ?? [:]
        let code = VtpJ.str(VtpJ.dict(j["data"])?["ORDER_NUMBER"])
        note("Lưu nháp", r.text, ok: code != nil)
        guard !VtpJ.bool(j["error"]), let code, !code.isEmpty else {
            throw VtpDraftError.server(VtpJ.str(j["message"]) ?? "Viettel Post không lưu nháp (HTTP \(r.status))")
        }
        return code
    }

    /// Xoá nháp: trang web gọi UpdateOrder với TYPE 11 (DELETE_ORDER).
    /// CHƯA TEST THẬT với Viettel Post: lỗi nào cũng trả nguyên lời Viettel Post, không tự coi là đã xoá.
    func deleteDraft(_ code: String) async throws {
        try await updateOrder(code, type: 11, label: "Xoá nháp")
    }

    /// Duyệt nháp thành vận đơn: UpdateOrder TYPE 1 (ORDER_APPROVAL) như nút "Duyệt đơn" trên web.
    /// CHƯA TEST THẬT với nháp: chưa rõ mã vận đơn sau khi duyệt có trùng mã nháp không.
    func approveDraft(_ code: String) async throws {
        try await updateOrder(code, type: 1, label: "Duyệt nháp")
    }

    private func updateOrder(_ code: String, type: Int, label: String) async throws {
        let code = code.trimmingCharacters(in: .whitespaces)
        guard !code.isEmpty else { throw VtpDraftError.server("Thiếu mã nháp") }
        let r = try await authed("/api/tmdt/UpdateOrder") {
            var b: [String: Any] = ["TYPE": type, "ORDER_NUMBER": code, "NOTE": ""]
            b["DATE"] = Self.dateText(Date())
            return b
        }
        let j = VtpJ.dict(r.json) ?? [:]
        let ok = VtpJ.isFalse(j["error"])
        note("\(label) \(code)", r.text, ok: ok)
        guard ok else {
            throw VtpDraftError.server(VtpJ.str(j["message"]) ?? "Viettel Post không nhận lệnh \(label.lowercased()) (HTTP \(r.status))")
        }
    }

    nonisolated static func dateText(_ d: Date) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "Asia/Ho_Chi_Minh")
        f.dateFormat = "dd/MM/yyyy HH:mm:ss"
        return f.string(from: d)
    }

    // MARK: - Gửi

    private func post(_ url: String, _ body: Any, headers: [String: String] = [:]) async throws -> VtpDraftReply {
        guard let u = URL(string: url) else { throw VtpDraftError.server("Sai đường dẫn") }
        return try await VtpDraftHttp.send(transport, u, body: body, headers: headers)
    }

    /// POST tới api.viettelpost.vn kèm token + deviceId + DPoP. Viettel Post đòi nonce thì gửi lại một lần.
    private func api(_ path: String, body: Any, token tk: String?, extra: [String: String] = [:],
                     retried: Bool = false) async throws -> VtpDraftReply {
        guard let url = URL(string: Endpoint.api + path) else { throw VtpDraftError.server("Sai đường dẫn") }
        var h = ["deviceId": deviceId]
        h["X-Token"] = VtpDpop.proof(key: key, method: "POST", url: url, accessToken: tk, nonce: nonce)
        if let tk, !tk.isEmpty { h["token"] = tk }
        for (k, v) in extra { h[k] = v }
        let r = try await VtpDraftHttp.send(transport, url, body: body, headers: h)
        if let n = r.nonce, !n.isEmpty { nonce = n }
        let mk = VtpJ.str(VtpJ.dict(r.json)?["messageKey"]) ?? ""
        if !retried, r.nonce != nil, mk == "USE_DPOP_NONCE" || r.status == 401 {
            return try await api(path, body: body, token: tk, extra: extra, retried: true)
        }
        return r
    }

    /// Lệnh cần đăng nhập: làm mới trước nếu sắp hết hạn; Viettel Post báo hết hạn thì làm mới rồi gửi lại một lần.
    private func authed(_ path: String, body: () -> Any) async throws -> VtpDraftReply {
        try await ensureFresh()
        guard let tk = token else { throw VtpDraftError.notLoggedIn }
        var r = try await api(path, body: body(), token: tk)
        if VtpJ.str(VtpJ.dict(r.json)?["messageKey"]) == "EXPIRED_TOKEN" || r.status == 401 {
            note("Phiên hết hạn, làm mới rồi gửi lại", "", ok: false)
            try await refresh()
            r = try await api(path, body: body(), token: token)
        }
        return r
    }

    // MARK: - Trạng thái và nhật ký

    private func run(_ what: String, _ work: @escaping () async throws -> Void) async {
        loading = true
        lastError = nil
        defer { loading = false }
        do { try await work() } catch { fail(what, error) }
    }

    private func fail(_ what: String, _ error: Error) {
        lastError = error.localizedDescription
        note("Lỗi: \(what)", error.localizedDescription, ok: false)
    }

    /// Mọi dòng nhật ký đều qua VtpMask: không có token hay số điện thoại đầy đủ.
    private func note(_ title: String, _ detail: String, ok: Bool = true) {
        let e = VtpDraftLogEntry(time: Date(), title: VtpMask.text(title),
                                 detail: VtpMask.text(String(detail.prefix(1500))), ok: ok)
        log.insert(e, at: 0)
        if log.count > 200 { log.removeLast(log.count - 200) }
    }
}
