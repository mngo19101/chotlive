import Combine
import Foundation

/// Nhiều tài khoản Viettel Post đẩy nháp trên cùng máy. Mỗi tài khoản là một `VtpDraftClient` với phiên riêng
/// trong Keychain; một tài khoản "đang dùng" để đẩy nháp (ghi nhớ riêng theo từng tài khoản ChốtLive).
/// Xoá nháp thì dùng đúng tài khoản đã đẩy nháp đó.
///
/// Danh sách chỉ lưu mã tài khoản trên máy (UserDefaults); tên, số, kho do từng client tự lưu.
@MainActor
final class VtpDraftHub: ObservableObject {
    private enum Keys {
        static let accounts = "vtpDraft.accounts"
        static let current = "vtpDraft.current"
        static let currentByApp = "vtpDraft.currentByApp"
    }

    @Published private(set) var clients: [VtpDraftClient]
    @Published private(set) var currentId: String

    private var appAccount: String?
    private var currentByApp: [String: String] = [:]
    private var clientCancellables: [AnyCancellable] = []

    private let secrets: VtpDraftSecrets
    private let defaults: UserDefaults
    private let transport: VtpDraftTransport

    init(appAccount: String? = nil, secrets: VtpDraftSecrets = VtpDraftKeychain(), defaults: UserDefaults = .standard,
         transport: @escaping VtpDraftTransport = VtpDraftHttp.live) {
        self.appAccount = appAccount
        self.secrets = secrets
        self.defaults = defaults
        self.transport = transport
        // Bản trước chỉ có một tài khoản, lưu ở khoá cũ: coi là tài khoản "" (đầu tiên).
        var seen = Set<String>()
        let rawIds = (defaults.stringArray(forKey: Keys.accounts) ?? [""]).filter { seen.insert($0).inserted }
        let ids = rawIds.isEmpty ? [""] : rawIds
        var list = ids.map { VtpDraftClient(accountId: $0, secrets: secrets, defaults: defaults, transport: transport) }
        // Tài khoản thêm vào mà chưa đăng nhập xong (bấm Thêm rồi bỏ dở): bỏ khi mở lại app, chừa ít nhất một.
        let kept = list.filter { $0.loggedIn }
        if kept.isEmpty {
            let first = list[0]
            for c in list.dropFirst() { c.forget() }
            list = [first]
        } else {
            for c in list where !c.loggedIn { c.forget() }
            list = kept
        }
        clients = list
        let byApp = (defaults.dictionary(forKey: Keys.currentByApp) as? [String: String]) ?? [:]
        currentByApp = byApp
        let forApp = appAccount.flatMap { byApp[$0] }
        let want = (forApp.flatMap { id in list.contains(where: { $0.accountId == id && $0.loggedIn }) ? id : nil })
            ?? defaults.string(forKey: Keys.current)
        currentId = list.first { $0.accountId == want }?.accountId
            ?? list.first { $0.loggedIn }?.accountId
            ?? list[0].accountId
        bindClients()
        persist()
    }

    private func bindClients() {
        clientCancellables = clients.map { c in
            c.objectWillChange.sink { [weak self] _ in
                self?.objectWillChange.send()
            }
        }
    }

    var current: VtpDraftClient { clients.first { $0.accountId == currentId } ?? clients[0] }
    var loggedInClients: [VtpDraftClient] { clients.filter { $0.loggedIn } }
    var anyLoggedIn: Bool { clients.contains { $0.loggedIn && !$0.sessionExpired } }

    func select(_ id: String) {
        guard let c = clients.first(where: { $0.accountId == id }) else { return }
        var changed = false
        if id != currentId {
            currentId = id
            changed = true
        }
        if let appAccount, c.loggedIn, currentByApp[appAccount] != id {
            currentByApp[appAccount] = id
            changed = true
        }
        if changed { persist() }
    }

    /// Khi đổi tài khoản ChốtLive: khôi phục tài khoản đẩy nháp tương ứng đã chọn trước đó.
    func switchAppAccount(_ account: String?) {
        appAccount = account
        if let account, let saved = currentByApp[account],
           clients.contains(where: { $0.accountId == saved && $0.loggedIn }) {
            if currentId != saved { currentId = saved }
            persist()
        }
    }

    /// Tìm tài khoản đẩy nháp đang đăng nhập khớp với số điện thoại đối tác phần 1.
    func matchingPartner(_ partnerPhone: String?) -> VtpDraftClient? {
        guard let partnerPhone, !partnerPhone.isEmpty else { return nil }
        let matches = { (c: VtpDraftClient) -> Bool in
            guard c.loggedIn && !c.sessionExpired else { return false }
            let raw = c.login.isEmpty ? c.userName : c.login
            return VtpDraftClient.phonesMatch(partnerPhone, raw) == true
        }
        if matches(current) { return current }
        return clients.first(where: matches)
    }

    /// Tự chọn tài khoản đẩy nháp khớp với phần 1 nếu tài khoản ChốtLive hiện tại chưa gắn lựa chọn riêng
    /// hoặc tài khoản đẩy nháp hiện tại chưa đăng nhập.
    func syncWithPartner(phone partnerPhone: String?) {
        guard let partnerPhone, !partnerPhone.isEmpty else { return }
        let hasSavedForApp = appAccount.flatMap { app in
            currentByApp[app].flatMap { id in clients.first(where: { $0.accountId == id && $0.loggedIn }) }
        } != nil
        guard !hasSavedForApp || !current.loggedIn, let match = matchingPartner(partnerPhone) else { return }
        currentId = match.accountId
        if let appAccount { currentByApp[appAccount] = match.accountId }
        persist()
    }

    /// Thêm một chỗ cho tài khoản mới (chưa đăng nhập) và chuyển sang đó để hiện ô đăng nhập.
    /// Đã có một chỗ trống chưa đăng nhập thì dùng lại chỗ đó.
    func addAccount() {
        if let empty = clients.first(where: { !$0.loggedIn && $0.otpStep == nil }) {
            select(empty.accountId)
            return
        }
        var id = ""
        repeat {
            id = "a" + String(UUID().uuidString.prefix(8)).lowercased()
        } while clients.contains(where: { $0.accountId == id })
        clients.append(VtpDraftClient(accountId: id, secrets: secrets, defaults: defaults, transport: transport))
        currentId = id
        bindClients()
        persist()
    }

    /// Bỏ tài khoản khỏi máy (xoá phiên). Còn lại tài khoản nào thì chuyển sang đó; hết thì để một chỗ trống.
    func remove(_ id: String) {
        guard let c = clients.first(where: { $0.accountId == id }) else { return }
        c.forget()
        clients.removeAll { $0.accountId == id }
        currentByApp = currentByApp.filter { $0.value != id }
        if clients.isEmpty {
            clients = [VtpDraftClient(accountId: "", secrets: secrets, defaults: defaults, transport: transport)]
        }
        if !clients.contains(where: { $0.accountId == currentId }) {
            let saved = appAccount.flatMap { currentByApp[$0] }
                .flatMap { sid in clients.first(where: { $0.accountId == sid })?.accountId }
            currentId = saved ?? (clients.first { $0.loggedIn } ?? clients[0]).accountId
        }
        bindClients()
        persist()
    }

    /// Đăng nhập xong một tài khoản: tài khoản cũ cùng tài khoản VTP (đăng nhập lại vào chỗ mới) thì bỏ chỗ cũ.
    func didLogin(_ c: VtpDraftClient) {
        guard clients.contains(where: { $0 === c }) else { return }
        for other in clients where other !== c && c.matchesSameAccount(as: other) {
            for (app, mapped) in currentByApp where mapped == other.accountId {
                currentByApp[app] = c.accountId
            }
            other.forget()
            clients.removeAll { $0 === other }
        }
        currentId = c.accountId
        if let appAccount { currentByApp[appAccount] = c.accountId }
        bindClients()
        persist()
    }

    /// Tài khoản đã đẩy nháp mang nhãn `draftAccount`. Nhãn rỗng (nháp rất cũ): tài khoản đang dùng.
    func client(for draftAccount: String?) -> VtpDraftClient? {
        let a = (draftAccount ?? "").trimmingCharacters(in: .whitespaces)
        if a.isEmpty {
            if current.loggedIn && !current.sessionExpired { return current }
            return loggedInClients.first(where: { !$0.sessionExpired }) ?? loggedInClients.first
        }
        if current.loggedIn && !current.sessionExpired && current.owns(a) { return current }
        if let active = loggedInClients.first(where: { !$0.sessionExpired && $0.owns(a) }) { return active }
        return clients.first { $0.owns(a) }
    }

    /// Mở app: làm mới phiên của MỌI tài khoản, và tải kho cho tài khoản đang dùng nếu chưa tải trong phiên này.
    func refreshAll() async {
        for c in clients where c.loggedIn { await c.refreshQuietly() }
        if current.loggedIn && !current.sessionExpired && !current.khoLoadedThisSession {
            await current.loadKho()
        }
    }

    /// Xoá mọi nháp của một khách, mỗi mã bằng đúng tài khoản đã đẩy mã đó.
    /// Trả các mã chưa xoá được kèm lý do; rỗng = đã xoá hết.
    func deleteDrafts(of g: Vtp.Group) async -> [(code: String, reason: String)] {
        var failed: [(code: String, reason: String)] = []
        for code in VtpDraftBody.codes(g) {
            let acc = g.orders.compactMap(\.ship).first { $0.draftCode == code }?.draftAccount
            let who = (acc ?? "").isEmpty ? "tài khoản đã đẩy" : "tài khoản \(acc ?? "")"
            guard let c = client(for: acc), c.loggedIn else {
                failed.append((code, "Nháp đẩy bằng \(who): đăng nhập tài khoản đó ở Tôi › ViettelPost (phần 2) để xoá."))
                continue
            }
            guard !c.sessionExpired else {
                failed.append((code, "Phiên của \(who) đã hết hạn: đăng nhập lại ở Tôi › ViettelPost (phần 2) để xoá."))
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
        defaults.set(currentByApp, forKey: Keys.currentByApp)
    }
}
