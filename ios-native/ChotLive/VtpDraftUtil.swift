import CryptoKit
import Foundation
import Security

// Tiện ích cho phần "đẩy nháp Viettel Post" chạy trên máy (xem VtpDraftClient.swift).
// Tên đều có tiền tố VtpDraft/VtpJ/VtpMask để không đụng Keychain, Vtp, VtpApi sẵn có của app.

/// Đọc JSON lỏng của Viettel Post (số có thể là chuỗi, null...) mà không cần Codable cho từng kiểu.
enum VtpJ {
    static func obj(_ d: Data) -> Any? { try? JSONSerialization.jsonObject(with: d) }
    static func dict(_ v: Any?) -> [String: Any]? { v as? [String: Any] }
    static func data(_ v: Any) -> Data { (try? JSONSerialization.data(withJSONObject: v)) ?? Data() }

    static func str(_ v: Any?) -> String? {
        switch v {
        case let s as String: return s
        case let n as NSNumber: return n.stringValue
        default: return nil
        }
    }

    static func double(_ v: Any?) -> Double? {
        switch v {
        case let n as NSNumber: return n.doubleValue.isFinite ? n.doubleValue : nil
        case let s as String: return Double(s.trimmingCharacters(in: .whitespaces))
        default: return nil
        }
    }

    static func int(_ v: Any?) -> Int? {
        guard let d = double(v), abs(d) < 1e15 else { return nil }
        return Int(d.rounded())
    }

    static func bool(_ v: Any?) -> Bool {
        if let b = v as? Bool { return b }
        if let n = v as? NSNumber { return n.boolValue }
        if let s = v as? String { return s == "true" || s == "1" }
        return false
    }

    /// Viettel Post web coi là thành công khi `error` đúng bằng false (không thiếu, không null).
    static func isFalse(_ v: Any?) -> Bool {
        if let b = v as? Bool { return !b }
        if let n = v as? NSNumber { return n.intValue == 0 }
        return false
    }

    static func b64u(_ d: Data) -> String {
        d.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    static func unb64u(_ s: String) -> Data? {
        var t = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while t.count % 4 != 0 { t += "=" }
        return Data(base64Encoded: t)
    }

    /// Đọc trường `exp` (giây) của JWT, không kiểm chữ ký.
    static func jwtExpiry(_ token: String?) -> Date? {
        guard let t = token else { return nil }
        let parts = t.split(separator: ".")
        guard parts.count == 3, let d = unb64u(String(parts[1])),
              let exp = double(dict(obj(d))?["exp"]) else { return nil }
        return Date(timeIntervalSince1970: exp)
    }
}

/// Che token và số điện thoại trước khi ghi nhật ký hay hiện ra màn hình.
enum VtpMask {
    private static let phone = try! NSRegularExpression(pattern: "(?<!\\d)(?:0|\\+?84)\\d{8,10}(?!\\d)")
    private static let jwt = "eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+"
    private static let longHex = "(?<![A-Za-z0-9])[A-Fa-f0-9]{32,}(?![A-Za-z0-9])"

    static func text(_ s: String) -> String {
        var t = s.replacingOccurrences(of: jwt, with: "<token>", options: .regularExpression)
        t = t.replacingOccurrences(of: longHex, with: "<mã>", options: .regularExpression)
        let m = NSMutableString(string: t)
        for r in phone.matches(in: t, range: NSRange(location: 0, length: m.length)).reversed() {
            let p = m.substring(with: r.range)
            m.replaceCharacters(in: r.range, with: String(p.prefix(4)) + " *** " + String(p.suffix(3)))
        }
        return m as String
    }
}

enum VtpDraftError: LocalizedError, Equatable {
    case notLoggedIn
    case sessionExpired
    /// Cloudflare của Viettel Post chặn mạng này (403 trang HTML) hoặc báo gửi quá nhiều (429).
    case blocked
    case network(String)
    /// Lời Viettel Post báo, giữ nguyên để người dùng biết lý do thật.
    case server(String)

    var errorDescription: String? {
        switch self {
        case .notLoggedIn: return "Chưa đăng nhập Viettel Post trên máy này"
        case .sessionExpired: return "Phiên Viettel Post đã hết, đăng nhập lại"
        case .blocked: return "Viettel Post đang chặn kết nối từ mạng này, thử lại sau"
        case .network(let s): return s
        case .server(let s): return s
        }
    }
}

struct VtpDraftReply {
    let status: Int
    let json: Any?
    let text: String
    let nonce: String?
}

/// Gửi yêu cầu thật; test thay bằng hàm giả.
typealias VtpDraftTransport = (URLRequest) async throws -> (Data, URLResponse)

enum VtpDraftHttp {
    static let live: VtpDraftTransport = { req in try await URLSession.shared.data(for: req) }

    static func send(_ transport: VtpDraftTransport, _ url: URL, body: Any?, headers: [String: String],
                     method: String = "POST") async throws -> VtpDraftReply {
        var req = URLRequest(url: url, timeoutInterval: 30)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("application/json, text/plain, */*", forHTTPHeaderField: "Accept")
        for (k, v) in headers { req.setValue(v, forHTTPHeaderField: k) }
        if let body { req.httpBody = VtpJ.data(body) }
        let pair: (Data, URLResponse)
        do {
            pair = try await transport(req)
        } catch let e as URLError {
            throw VtpDraftError.network(e.code == .notConnectedToInternet || e.code == .networkConnectionLost
                ? "Mất mạng, thử lại khi có mạng" : "Viettel Post không trả lời (\(e.code.rawValue)), thử lại sau")
        }
        let data = pair.0
        let h = pair.1 as? HTTPURLResponse
        let status = h?.statusCode ?? 0
        let json = VtpJ.obj(data)
        if status == 429 || (status == 403 && json == nil) { throw VtpDraftError.blocked }
        return VtpDraftReply(status: status, json: json, text: String(decoding: data, as: UTF8.self),
                             nonce: h?.value(forHTTPHeaderField: "X-Token-Nonce"))
    }
}

/// Chữ ký DPoP (X-Token) giống trang viettelpost.vn: JWT ES256, khoá P-256 của máy, ath = SHA-256 của token.
enum VtpDpop {
    static func proof(key: P256.Signing.PrivateKey, method: String, url: URL, accessToken: String?, nonce: String?,
                      jti: String = UUID().uuidString.lowercased(), iat: Date = Date()) -> String {
        let raw = key.publicKey.rawRepresentation
        let jwk: [String: Any] = ["kty": "EC", "crv": "P-256",
                                  "x": VtpJ.b64u(raw.prefix(32)), "y": VtpJ.b64u(raw.suffix(32))]
        let header: [String: Any] = ["typ": "dpop+jwt", "alg": "ES256", "jwk": jwk]
        var payload: [String: Any] = [:]
        payload["jti"] = jti
        payload["htm"] = method.uppercased()
        payload["htu"] = "\(url.scheme ?? "https")://\(url.host ?? "")\(url.path)"
        payload["iat"] = Int(iat.timeIntervalSince1970)
        if let t = accessToken, !t.isEmpty { payload["ath"] = ath(t) }
        if let n = nonce, !n.isEmpty { payload["nonce"] = n }
        let input = VtpJ.b64u(VtpJ.data(header)) + "." + VtpJ.b64u(VtpJ.data(payload))
        let sig = (try? key.signature(for: Data(input.utf8)).rawRepresentation) ?? Data()
        return input + "." + VtpJ.b64u(sig)
    }

    static func ath(_ token: String) -> String { VtpJ.b64u(Data(SHA256.hash(data: Data(token.utf8)))) }
}

/// Chỗ cất bí mật của phần đẩy nháp (khoá ký, token). Bản thật dùng Keychain; test dùng bộ nhớ.
protocol VtpDraftSecrets {
    func get(_ key: String) -> Data?
    func set(_ data: Data?, _ key: String)
}

struct VtpDraftKeychain: VtpDraftSecrets {
    var service = "com.chotlive.native.vtpdraft"

    private func query(_ key: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: key]
    }

    func get(_ key: String) -> Data? {
        var q = query(key)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess else { return nil }
        return out as? Data
    }

    func set(_ data: Data?, _ key: String) {
        let q = query(key)
        guard let data else {
            SecItemDelete(q as CFDictionary)
            return
        }
        let attrs: [String: Any] = [kSecValueData as String: data,
                                    kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        if SecItemUpdate(q as CFDictionary, attrs as CFDictionary) == errSecItemNotFound {
            _ = SecItemAdd(q.merging(attrs) { $1 } as CFDictionary, nil)
        }
    }
}

struct VtpDraftLogEntry: Identifiable {
    let id = UUID()
    let time: Date
    let title: String
    let detail: String
    let ok: Bool
}
