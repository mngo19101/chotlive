import CryptoKit
import Foundation
import Security

/// Mỗi tài khoản có một mục token riêng trong Keychain, đặt tên theo accountKey.
enum Keychain {
    private static func query(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "com.chotlive.native.auth",
         kSecAttrAccount as String: account]
    }

    static func read(_ account: String) -> String? {
        var request = query(account)
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(request as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    @discardableResult
    static func write(_ account: String, _ value: String) -> Bool {
        let q = query(account)
        let attributes: [String: Any] = [
            kSecValueData as String: Data(value.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let status = SecItemUpdate(q as CFDictionary, attributes as CFDictionary)
        if status == errSecSuccess { return true }
        guard status == errSecItemNotFound else { return false }
        return SecItemAdd(q.merging(attributes) { $1 } as CFDictionary, nil) == errSecSuccess
    }

    static func delete(_ account: String) {
        SecItemDelete(query(account) as CFDictionary)
    }
}

/// Các phiên đăng nhập ChốtLive đã lưu trên máy — mỗi tài khoản một token riêng trong Keychain,
/// nên có thể đổi qua lại giữa nhiều tài khoản mà không cần nhập lại mật khẩu.
enum AuthStorage {
    struct SavedAccount: Codable, Identifiable, Equatable {
        var key: String
        var server: String
        var user: String
        var id: String { key }
    }

    static let serverKey = "serverURL"
    static let userKey = "authUser"
    private static let savedAccountsKey = "savedAppAccounts"
    private static let legacyTokenKey = "authToken"          // UserDefaults, trước khi có Keychain
    private static let legacyKeychainAccount = "authToken"   // Keychain dùng chung 1 mục, trước khi tách theo tài khoản
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

    /// internal (không private) để test dọn đúng mục Keychain đã ghi.
    static func tokenAccount(_ key: String) -> String { "token:" + key }

    // MARK: - Danh sách tài khoản đã lưu

    static func savedAccounts(_ defaults: UserDefaults = .standard) -> [SavedAccount] {
        guard let data = defaults.data(forKey: savedAccountsKey),
              let list = try? JSONDecoder().decode([SavedAccount].self, from: data) else { return [] }
        return list
    }

    private static func setSavedAccounts(_ list: [SavedAccount], _ defaults: UserDefaults) {
        if let data = try? JSONEncoder().encode(list) { defaults.set(data, forKey: savedAccountsKey) }
    }

    private static func rememberAccount(_ account: SavedAccount, _ defaults: UserDefaults) {
        var list = savedAccounts(defaults)
        list.removeAll { $0.key == account.key }
        list.append(account)
        setSavedAccounts(list, defaults)
    }

    /// Token đã lưu của một tài khoản (đang dùng hay không cũng vậy).
    static func token(for key: String) -> String? { Keychain.read(tokenAccount(key)) }

    // MARK: - Phiên đang dùng

    static func currentAccountKey(_ defaults: UserDefaults = .standard) -> String? {
        guard let server = defaults.string(forKey: serverKey), let user = defaults.string(forKey: userKey),
              !server.isEmpty, !user.isEmpty else { return nil }
        return accountKey(server: server, user: user)
    }

    /// Token của tài khoản đang đăng nhập trên máy, có di chuyển dữ liệu của các bản cũ khi cần.
    static func currentToken(_ defaults: UserDefaults = .standard) -> String {
        migrateLegacyIfNeeded(defaults)
        guard let key = currentAccountKey(defaults) else { return "" }
        return token(for: key) ?? ""
    }

    /// Lưu một phiên đăng nhập (đăng nhập lần đầu hoặc thêm tài khoản khác) và đặt làm tài khoản hiện tại.
    static func saveSession(server: String, user: String, token: String, _ defaults: UserDefaults = .standard) {
        let key = accountKey(server: server, user: user)
        defaults.set(server, forKey: serverKey)
        defaults.set(user, forKey: userKey)
        defaults.removeObject(forKey: legacyTokenKey)
        Keychain.write(tokenAccount(key), token)
        rememberAccount(SavedAccount(key: key, server: server, user: user), defaults)
    }

    /// Chuyển sang một tài khoản đã lưu (đã có token hợp lệ), không cần đăng nhập lại.
    @discardableResult
    static func switchCurrent(to key: String, _ defaults: UserDefaults = .standard) -> SavedAccount? {
        guard let account = savedAccounts(defaults).first(where: { $0.key == key }) else { return nil }
        defaults.set(account.server, forKey: serverKey)
        defaults.set(account.user, forKey: userKey)
        return account
    }

    /// Đăng xuất tài khoản đang dùng: xoá token và khỏi danh sách đã lưu, không đổi sang tài khoản khác.
    static func clearCurrentSession(_ defaults: UserDefaults = .standard) {
        if let key = currentAccountKey(defaults) {
            setSavedAccounts(savedAccounts(defaults).filter { $0.key != key }, defaults)
            Keychain.delete(tokenAccount(key))
        } else {
            // Chưa rõ tài khoản (ví dụ app vừa cài lại): dọn luôn mục Keychain cũ nếu còn sót.
            Keychain.delete(legacyKeychainAccount)
        }
        defaults.removeObject(forKey: legacyTokenKey)
    }

    /// Quên một tài khoản đã lưu khác — không tác động tới tài khoản đang dùng.
    static func forgetAccount(_ key: String, _ defaults: UserDefaults = .standard) {
        guard currentAccountKey(defaults) != key else { return }
        setSavedAccounts(savedAccounts(defaults).filter { $0.key != key }, defaults)
        Keychain.delete(tokenAccount(key))
    }

    // MARK: - Di chuyển dữ liệu từ bản cũ

    /// Token của bản cũ nằm chung một mục Keychain (hoặc UserDefaults ở bản cũ hơn nữa):
    /// chuyển sang mục riêng theo tài khoản rồi mới dùng được.
    private static func migrateLegacyIfNeeded(_ defaults: UserDefaults) {
        guard let key = currentAccountKey(defaults) else {
            Keychain.delete(legacyKeychainAccount)
            defaults.removeObject(forKey: legacyTokenKey)
            return
        }
        if token(for: key) != nil {
            if !savedAccounts(defaults).contains(where: { $0.key == key }),
               let server = defaults.string(forKey: serverKey), let user = defaults.string(forKey: userKey) {
                rememberAccount(SavedAccount(key: key, server: server, user: user), defaults)
            }
            return
        }
        let legacyFromDefaults = defaults.string(forKey: legacyTokenKey).flatMap { $0.isEmpty ? nil : $0 }
        guard let legacy = legacyFromDefaults ?? Keychain.read(legacyKeychainAccount),
              let server = defaults.string(forKey: serverKey), let user = defaults.string(forKey: userKey),
              Keychain.write(tokenAccount(key), legacy) else { return }
        defaults.removeObject(forKey: legacyTokenKey)
        Keychain.delete(legacyKeychainAccount)
        rememberAccount(SavedAccount(key: key, server: server, user: user), defaults)
    }

    // MARK: - Dữ liệu bản cũ hơn nữa (trước khi tách dữ liệu theo tài khoản)

    /// Chủ của file dữ liệu bản cũ, chốt một lần trước khi có ai đăng nhập ở bản này.
    /// Nil nghĩa là không rõ chủ: người đăng nhập đầu tiên nhận file.
    static func legacyOwner(_ defaults: UserDefaults = .standard) -> String? {
        if let saved = defaults.string(forKey: legacyOwnerKey) { return saved.isEmpty ? nil : saved }
        let owner = currentAccountKey(defaults)
        defaults.set(owner ?? "", forKey: legacyOwnerKey)
        return owner
    }
}
