import CryptoKit
import Foundation
import Security

/// Token đăng nhập nằm trong Keychain, chỉ dùng được trên máy này và không đi theo bản sao lưu.
enum Keychain {
    private static var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "com.chotlive.native.auth",
         kSecAttrAccount as String: "authToken"]
    }

    static func read() -> String? {
        var request = query
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(request as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    @discardableResult
    static func write(_ value: String) -> Bool {
        let attributes: [String: Any] = [
            kSecValueData as String: Data(value.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecSuccess { return true }
        guard status == errSecItemNotFound else { return false }
        return SecItemAdd(query.merging(attributes) { $1 } as CFDictionary, nil) == errSecSuccess
    }

    static func delete() {
        SecItemDelete(query as CFDictionary)
    }
}

/// Phiên đăng nhập đã lưu trên máy.
enum AuthStorage {
    static let serverKey = "serverURL"
    static let userKey = "authUser"
    private static let legacyTokenKey = "authToken"
    private static let legacyOwnerKey = "legacyDataOwner"

    /// Mỗi tài khoản trên mỗi server có một vùng dữ liệu riêng.
    static func accountKey(server: String, user: String) -> String {
        let clean = { (s: String) in s.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
        return clean(server) + "|" + clean(user)
    }

    /// Tên thư mục dữ liệu của tài khoản.
    static func folderName(account: String) -> String {
        SHA256.hash(data: Data(account.utf8)).prefix(16).map { String(format: "%02x", $0) }.joined()
    }

    /// Token đang lưu. Token của bản cũ nằm trong UserDefaults: chép được sang Keychain thì mới xoá.
    static func token(_ defaults: UserDefaults = .standard) -> String {
        // Không còn địa chỉ server nghĩa là app vừa cài lại, token sót trong Keychain không còn dùng được.
        guard !(defaults.string(forKey: serverKey) ?? "").isEmpty else {
            Keychain.delete()
            defaults.removeObject(forKey: legacyTokenKey)
            return ""
        }
        if let legacy = defaults.string(forKey: legacyTokenKey), !legacy.isEmpty {
            if Keychain.write(legacy) { defaults.removeObject(forKey: legacyTokenKey) }
            return legacy
        }
        return Keychain.read() ?? ""
    }

    /// Không ghi được Keychain thì phiên chỉ còn trong bộ nhớ: lần mở sau đăng nhập lại, không để lộ token.
    static func saveSession(server: String, user: String, token: String, _ defaults: UserDefaults = .standard) {
        defaults.set(server, forKey: serverKey)
        defaults.set(user, forKey: userKey)
        defaults.removeObject(forKey: legacyTokenKey)
        Keychain.write(token)
    }

    static func clearToken(_ defaults: UserDefaults = .standard) {
        Keychain.delete()
        defaults.removeObject(forKey: legacyTokenKey)
    }

    /// Tài khoản đang đăng nhập, nil nếu chưa đăng nhập.
    static func currentAccountKey(_ defaults: UserDefaults = .standard) -> String? {
        guard !token(defaults).isEmpty, let server = defaults.string(forKey: serverKey),
              let user = defaults.string(forKey: userKey) else { return nil }
        return accountKey(server: server, user: user)
    }

    /// Chủ của file dữ liệu bản cũ, chốt một lần trước khi có ai đăng nhập ở bản này.
    /// Nil nghĩa là không rõ chủ: người đăng nhập đầu tiên nhận file.
    static func legacyOwner(_ defaults: UserDefaults = .standard) -> String? {
        if let saved = defaults.string(forKey: legacyOwnerKey) { return saved.isEmpty ? nil : saved }
        var owner: String?
        if let server = defaults.string(forKey: serverKey), let user = defaults.string(forKey: userKey),
           !server.isEmpty, !user.isEmpty {
            owner = accountKey(server: server, user: user)
        }
        defaults.set(owner ?? "", forKey: legacyOwnerKey)
        return owner
    }
}
