import Foundation

/// Nhiều tài khoản Viettel Post đẩy nháp trên cùng máy. Mỗi tài khoản là một `VtpDraftClient` với phiên riêng
/// trong Keychain; một tài khoản "đang dùng" để đẩy nháp. Xoá nháp thì dùng đúng tài khoản đã đẩy nháp đó.
///
/// Danh sách chỉ lưu mã tài khoản trên máy (UserDefaults); tên, số, kho do từng client tự lưu.
@MainActor
final class VtpDraftHub: ObservableObject {
    private enum Keys {
        static let accounts = "vtpDraft.accounts"
        static let current = "vtpDraft.current"
    }

    @Published private(set) var clients: [VtpDraftClient]
    @Published private(set) var currentId: String

    private let secrets: VtpDraftSecrets
    private let defaults: UserDefaults
    private let transport: VtpDraftTransport

    init(secrets: VtpDraftSecrets = VtpDraftKeychain(), defaults: UserDefaults = .standard,
         transport: @escaping VtpDraftTransport = VtpDraftHttp.live) {
        self.secrets = secrets
        self.defaults = defaults
        self.transport = transport
        // Bản trước chỉ có một tài khoản, lưu ở khoá cũ: coi là tài khoản "" (đầu tiên).
        let ids = (defaults.stringArray(forKey: Keys.accounts) ?? [""])
        var list = ids.map { VtpDraftClient(accountId: $0, secrets: secrets, defaults: defaults, transport: transport) }
        // Tài khoản thêm vào mà chưa đăng nhập xong (bấm Thêm rồi bỏ dở): bỏ khi mở lại app, chừa ít nhất một.
        let kept = list.filter { $0.loggedIn }
        list = kept.isEmpty ? [list.first!] : kept
        clients = list
        let want = defaults.string(forKey: Keys.current)
        currentId = list.first { $0.accountId == want }?.accountId ?? list.first { $0.loggedIn }?.accountId ?? list[0].accountId
        persist()
    }

    var current: VtpDraftClient { clients.first { $0.accountId == currentId } ?? clients[0] }
    var loggedInClients: [VtpDraftClient] { clients.filter { $0.loggedIn } }
    var anyLoggedIn: Bool { clients.contains { $0.loggedIn && !$0.sessionExpired } }

    func select(_ id: String) {
        guard clients.contains(where: { $0.accountId == id }), id != currentId else { return }
        currentId = id
        persist()
    }

    /// Thêm một chỗ cho tài khoản mới (chưa đăng nhập) và chuyển sang đó để hiện ô đăng nhập.
    /// Đã có một chỗ trống chưa đăng nhập thì dùng lại chỗ đó.
    func addAccount() {
        if let empty = clients.first(where: { !$0.loggedIn && $0.otpStep == nil }) {
            select(empty.accountId)
            return
        }
        let id = "a" + String(Int(Date().timeIntervalSince1970 * 1000), radix: 36)
        clients.append(VtpDraftClient(accountId: id, secrets: secrets, defaults: defaults, transport: transport))
        currentId = id
        persist()
    }

    /// Bỏ tài khoản khỏi máy (xoá phiên). Còn lại tài khoản nào thì chuyển sang đó; hết thì để một chỗ trống.
    func remove(_ id: String) {
        guard let c = clients.first(where: { $0.accountId == id }) else { return }
        c.forget()
        clients.removeAll { $0.accountId == id }
        if clients.isEmpty {
            clients = [VtpDraftClient(accountId: "", secrets: secrets, defaults: defaults, transport: transport)]
        }
        if !clients.contains(where: { $0.accountId == currentId }) {
            currentId = (clients.first { $0.loggedIn } ?? clients[0]).accountId
        }
        persist()
    }

    /// Đăng nhập xong một tài khoản: tài khoản cũ cùng số (đăng nhập lại vào chỗ mới) thì bỏ chỗ cũ.
    func didLogin(_ c: VtpDraftClient) {
        let key = VtpDraftSection.phoneKey(c.login)
        guard key.count >= 9 else { return }
        for other in clients where other !== c && VtpDraftSection.phoneKey(other.login) == key {
            other.forget()
            clients.removeAll { $0 === other }
        }
        persist()
    }

    /// Tài khoản đã đẩy nháp mang nhãn `draftAccount`. Nhãn rỗng (nháp rất cũ): tài khoản đang dùng.
    func client(for draftAccount: String?) -> VtpDraftClient? {
        let a = (draftAccount ?? "").trimmingCharacters(in: .whitespaces)
        if a.isEmpty { return current.loggedIn ? current : nil }
        return clients.first { $0.owns(a) }
    }

    /// Mở app: làm mới phiên của MỌI tài khoản, để tài khoản lâu không đẩy cũng không tự hết hạn.
    func refreshAll() async {
        for c in clients where c.loggedIn { await c.refreshQuietly() }
    }

    /// Xoá mọi nháp của một khách, mỗi mã bằng đúng tài khoản đã đẩy mã đó.
    /// Trả các mã chưa xoá được kèm lý do; rỗng = đã xoá hết.
    func deleteDrafts(of g: Vtp.Group) async -> [(code: String, reason: String)] {
        var failed: [(code: String, reason: String)] = []
        for code in VtpDraftBody.codes(g) {
            let acc = g.orders.compactMap(\.ship).first { $0.draftCode == code }?.draftAccount
            guard let c = client(for: acc), c.loggedIn, !c.sessionExpired else {
                let who = (acc ?? "").isEmpty ? "tài khoản đã đẩy" : "tài khoản \(acc ?? "")"
                failed.append((code, "Nháp đẩy bằng \(who): đăng nhập tài khoản đó ở Tôi › ViettelPost (phần 2) để xoá."))
                continue
            }
            do {
                try await c.deleteDraft(code)
            } catch {
                failed.append((code, error.localizedDescription))
                if let e = error as? VtpDraftError, e == .blocked { break }
            }
        }
        return failed
    }

    private func persist() {
        defaults.set(clients.map(\.accountId), forKey: Keys.accounts)
        defaults.set(currentId, forKey: Keys.current)
    }
}
