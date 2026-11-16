import Foundation
import Security

/// Đọc JSON lỏng (số có thể là chuỗi, null...) mà không cần khai báo Codable cho từng kiểu.
enum J {
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
        return false
    }
}

extension Data {
    var b64u: String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    init?(b64u: String) {
        var s = b64u.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while s.count % 4 != 0 { s += "=" }
        self.init(base64Encoded: s)
    }
}

/// Che số điện thoại và token trước khi hiện trong nhật ký.
enum Mask {
    private static let phone = try! NSRegularExpression(pattern: "(?<!\\d)(?:0|\\+?84)\\d{8,10}(?!\\d)")

    static func text(_ s: String) -> String {
        let noJwt = s.replacingOccurrences(of: "eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+",
                                           with: "<token>", options: .regularExpression)
        let m = NSMutableString(string: noJwt)
        for r in phone.matches(in: noJwt, range: NSRange(location: 0, length: m.length)).reversed() {
            let p = m.substring(with: r.range)
            m.replaceCharacters(in: r.range, with: String(p.prefix(3)) + "•••" + String(p.suffix(3)))
        }
        return m as String
    }
}

/// Cắt chuỗi theo BYTE (Viettel Post giới hạn 150 byte), không cắt giữa ký tự.
func clipBytes(_ s: String, _ max: Int = 150) -> String {
    var out = ""
    for ch in s {
        if (out + String(ch)).utf8.count > max { break }
        out.append(ch)
    }
    return out
}

enum VtpError: LocalizedError {
    case msg(String)
    var errorDescription: String? {
        switch self { case .msg(let s): return s }
    }
}

// MARK: - HTTP

struct HttpReply {
    let status: Int
    let json: Any?
    let text: String
    let nonce: String?
}

enum Http {
    static func send(_ method: String, _ url: URL, body: Any? = nil, headers: [String: String] = [:]) async throws -> HttpReply {
        var req = URLRequest(url: url, timeoutInterval: 30)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("application/json, text/plain, */*", forHTTPHeaderField: "Accept")
        for (k, v) in headers { req.setValue(v, forHTTPHeaderField: k) }
        if let body { req.httpBody = J.data(body) }
        let (data, resp) = try await URLSession.shared.data(for: req)
        let h = resp as? HTTPURLResponse
        return HttpReply(status: h?.statusCode ?? 0, json: J.obj(data),
                         text: String(decoding: data, as: UTF8.self),
                         nonce: h?.value(forHTTPHeaderField: "X-Token-Nonce"))
    }
}

// MARK: - Keychain (có dự phòng UserDefaults nếu bản cài không có quyền Keychain)

enum Keychain {
    private static let service = "com.chotlive.vtpnhaptest"

    private static func query(_ key: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: key]
    }

    static func set(_ data: Data?, _ key: String) {
        SecItemDelete(query(key) as CFDictionary)
        UserDefaults.standard.removeObject(forKey: "kc." + key)
        guard let data else { return }
        var add = query(key)
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        if SecItemAdd(add as CFDictionary, nil) != errSecSuccess {
            UserDefaults.standard.set(data, forKey: "kc." + key)
        }
    }

    static func get(_ key: String) -> Data? {
        var q = query(key)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        if SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data { return d }
        return UserDefaults.standard.data(forKey: "kc." + key)
    }

    static func setString(_ s: String?, _ key: String) { set(s.map { Data($0.utf8) }, key) }
    static func getString(_ key: String) -> String? { get(key).map { String(decoding: $0, as: UTF8.self) } }
}

// MARK: - Nhật ký

struct LogEntry: Identifiable {
    let id = UUID()
    let time: Date
    let title: String
    let detail: String
    let ok: Bool
}

@MainActor
final class LogStore: ObservableObject {
    @Published var entries: [LogEntry] = []

    func add(_ title: String, _ detail: String = "", ok: Bool = true) {
        entries.insert(LogEntry(time: Date(), title: title, detail: Mask.text(String(detail.prefix(2000))), ok: ok), at: 0)
        if entries.count > 300 { entries.removeLast(entries.count - 300) }
    }

    var asText: String {
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss"
        return entries.reversed().map { "[\(f.string(from: $0.time))] \($0.ok ? "OK" : "LỖI") \($0.title)\n\($0.detail)" }
            .joined(separator: "\n\n")
    }
}
