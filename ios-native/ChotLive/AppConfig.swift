import Foundation

enum AppConfig {
    /// Địa chỉ server gắn sẵn lúc build (biến CHOTLIVE_SERVER_URL trong workflow build IPA).
    /// Nil khi build không đặt biến này (bản thử nghiệm): màn đăng nhập sẽ cho nhập tay.
    static var builtInServer: String? {
        let raw = Bundle.main.object(forInfoDictionaryKey: "ChotLiveServerURL") as? String ?? ""
        let server = LiveClient.normalize(raw)
        return server.isEmpty || server.contains("$(") ? nil : server
    }

    /// Phải khớp MIN_PASSWORD_LENGTH trong server.js.
    static let minPasswordLength = 6
}
