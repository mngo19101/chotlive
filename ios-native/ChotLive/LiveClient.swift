import Foundation

/// Đăng nhập server ChốtLive + nhận bình luận TikTok Live qua WebSocket (/ws).
@MainActor
final class LiveClient: ObservableObject {
    @Published var loggedIn = false
    @Published var username = ""
    @Published var socketConnected = false
    @Published var liveState = "idle"      // idle | connecting | connected | error | ended | disconnected
    @Published var liveMessage = ""
    @Published var liveUsername = ""
    @Published var viewers = 0

    var onChat: ((LiveComment) -> Void)?
    /// Báo đổi tài khoản trước khi nhận bình luận, để dữ liệu không rơi vào vùng của người khác.
    var onAccountChange: ((String?) -> Void)?

    private let defaults: UserDefaults
    private(set) var baseURL: String
    private var token: String
    private var task: URLSessionWebSocketTask?
    private var pingTimer: Timer?

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        baseURL = defaults.string(forKey: AuthStorage.serverKey) ?? ""
        token = AuthStorage.token(defaults)
        username = defaults.string(forKey: AuthStorage.userKey) ?? ""
        if !token.isEmpty && !baseURL.isEmpty {
            loggedIn = true
            openSocket()
        }
    }

    static func normalize(_ raw: String) -> String {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        while s.hasSuffix("/") { s.removeLast() }
        if s.isEmpty { return s }
        if !s.contains("://") {
            let isIP = s.range(of: #"^\d{1,3}(\.\d{1,3}){3}"#, options: .regularExpression) != nil
            s = (isIP ? "http://" : "https://") + s
        }
        return s
    }

    // MARK: - Đăng nhập

    func login(server: String, user: String, password: String) async throws {
        let base = Self.normalize(server)
        guard let url = URL(string: base + "/api/auth/login") else { throw ClientError.msg("Địa chỉ server không hợp lệ") }
        var req = URLRequest(url: url, timeoutInterval: 20)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: ["username": user, "password": password])

        let (data, resp) = try await URLSession.shared.data(for: req)
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        guard (resp as? HTTPURLResponse)?.statusCode == 200, let tk = json["token"] as? String else {
            throw ClientError.msg(json["error"] as? String ?? "Đăng nhập thất bại")
        }
        baseURL = base
        token = tk
        username = ((json["user"] as? [String: Any])?["username"] as? String) ?? user
        AuthStorage.saveSession(server: base, user: username, token: tk, defaults)
        onAccountChange?(AuthStorage.accountKey(server: base, user: username))
        loggedIn = true
        openSocket()
    }

    func logout() {
        let t = token
        let base = baseURL
        if let url = URL(string: base + "/api/auth/logout"), !t.isEmpty {
            var req = URLRequest(url: url)
            req.httpMethod = "POST"
            req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
            URLSession.shared.dataTask(with: req).resume()
        }
        closeSocket()
        token = ""
        AuthStorage.clearToken(defaults)
        onAccountChange?(nil)
        loggedIn = false
        liveState = "idle"
    }

    // MARK: - TikTok Live

    func connectLive(tiktok: String) {
        liveState = "connecting"
        liveMessage = ""
        send(["type": "connect", "username": tiktok])
    }

    func disconnectLive() {
        send(["type": "disconnect"])
        liveState = "idle"
    }

    // MARK: - WebSocket

    private func openSocket() {
        closeSocket()
        guard var comps = URLComponents(string: baseURL), !token.isEmpty else { return }
        comps.scheme = (comps.scheme == "https") ? "wss" : "ws"
        comps.path = "/ws"
        comps.queryItems = [URLQueryItem(name: "token", value: token)]
        guard let url = comps.url else { return }
        let t = URLSession.shared.webSocketTask(with: url)
        task = t
        t.resume()
        receive(t)
        pingTimer = Timer.scheduledTimer(withTimeInterval: 20, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.send(["type": "ping"]) }
        }
    }

    private func closeSocket() {
        pingTimer?.invalidate()
        pingTimer = nil
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        socketConnected = false
    }

    private func send(_ obj: [String: Any]) {
        guard let task, let data = try? JSONSerialization.data(withJSONObject: obj),
              let s = String(data: data, encoding: .utf8) else { return }
        task.send(.string(s)) { _ in }
    }

    private func receive(_ t: URLSessionWebSocketTask) {
        t.receive { [weak self] result in
            Task { @MainActor in
                guard let self, self.task === t else { return }
                switch result {
                case .success(let msg):
                    self.socketConnected = true
                    switch msg {
                    case .string(let s): self.handle(Data(s.utf8))
                    case .data(let d): self.handle(d)
                    @unknown default: break
                    }
                    self.receive(t)
                case .failure:
                    self.socketClosed()
                }
            }
        }
    }

    private func socketClosed() {
        closeSocket()
        guard loggedIn else { return }
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            guard let self, self.loggedIn, self.task == nil else { return }
            self.openSocket()
        }
    }

    // Gán username trước state: nơi lắng nghe liveState cần đọc đúng tên tài khoản.
    private func applyLiveStatus(_ ls: [String: Any]) {
        liveUsername = (ls["username"] as? String) ?? ""
        liveState = (ls["state"] as? String) ?? "idle"
    }

    private func handle(_ data: Data) {
        guard let m = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let type = m["type"] as? String else { return }
        switch type {
        case "hello":
            if let ls = m["liveStatus"] as? [String: Any] { applyLiveStatus(ls) }
        case "status":
            liveMessage = (m["message"] as? String) ?? ""
            if let u = m["username"] as? String { liveUsername = u }
            liveState = (m["state"] as? String) ?? "idle"
        case "viewers":
            viewers = (m["count"] as? Int) ?? Int((m["count"] as? Double) ?? 0)
        case "chat":
            let text = (m["comment"] as? String) ?? ""
            let uid = (m["uniqueId"] as? String) ?? ""
            let c = LiveComment(
                id: (m["id"] as? String) ?? UUID().uuidString,
                uniqueId: uid,
                userId: (m["userId"] as? String) ?? "",
                nickname: (m["nickname"] as? String) ?? uid,
                text: text,
                ts: Date(),
                price: PriceParser.parse(text)
            )
            onChat?(c)
        case "account_locked", "password_changed_force_login", "auth_error":
            liveMessage = (m["message"] as? String) ?? "Phiên đăng nhập không còn hiệu lực"
            logout()
        default:
            break
        }
    }
}

enum ClientError: LocalizedError {
    case msg(String)
    var errorDescription: String? { if case .msg(let s) = self { return s } else { return nil } }
}
