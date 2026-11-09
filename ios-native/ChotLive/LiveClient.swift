import Foundation

/// Đăng nhập server ChốtLive, nhận bình luận TikTok Live và đồng bộ dữ liệu qua WebSocket (/ws).
@MainActor
final class LiveClient: ObservableObject {
    @Published var loggedIn = false
    @Published var username = ""
    @Published var socketConnected = false
    @Published var liveState = "idle"      // idle | connecting | connected | error | ended | disconnected
    @Published var liveMessage = ""
    @Published var liveUsername = ""
    @Published var viewers = 0
    /// Các live server đang theo dõi cùng lúc.
    @Published private(set) var lives: [LiveInfo] = []
    /// Live vừa báo lỗi hoặc kết thúc, để màn Live mới hiện đúng thông báo.
    @Published private(set) var lastLiveEvent: (username: String, state: String, message: String)? = nil
    /// Số thiết bị đang mở cùng tài khoản trên cùng server.
    @Published private(set) var clientsCount = 0
    /// Server bản mới có đồng bộ dữ liệu; bản cũ chỉ gửi bình luận.
    @Published private(set) var serverSupportsSync = false
    /// Các tài khoản ChốtLive đã đăng nhập trên máy (gồm cả tài khoản đang dùng), để đổi qua lại không cần nhập lại mật khẩu.
    @Published private(set) var savedAccounts: [AuthStorage.SavedAccount] = []
    /// Dùng thử, gói hoặc đã hết hạn của tài khoản đang dùng.
    @Published private(set) var access: AccountAccess? {
        didSet {
            if let access, accessByAccount[currentAccountKey] != access {
                accessByAccount[currentAccountKey] = access
                saveAccessCache()
            }
            scheduleAccessCheck()
        }
    }
    /// Hạn dùng đã biết của từng tài khoản trên máy: đổi tài khoản thì hiện ngay thẻ đúng của tài khoản đó,
    /// không để thẻ của tài khoản cũ nhấp nháy rồi mới đổi khi server trả lời.
    /// Lưu cả xuống máy, để lần đầu đổi sang tài khoản sau khi mở lại app cũng không chờ server.
    private var accessByAccount: [String: AccountAccess] = [:]
    private static let accessCacheKey = "chotlive.accessByAccount"

    private func saveAccessCache() {
        defaults.set(accessByAccount.mapValues(\.dict), forKey: Self.accessCacheKey)
    }

    private func forgetAccess(_ key: String) {
        guard accessByAccount.removeValue(forKey: key) != nil else { return }
        saveAccessCache()
    }
    /// Thông báo vừa bị chặn theo dõi live vì hết hạn, hiện thành hộp thoại ở mọi màn hình.
    @Published var accessNotice: String?
    /// Số tin Admin trả lời mà khách chưa đọc.
    @Published private(set) var supportUnread = 0
    /// Tin chat hỗ trợ mới nhất vừa tới qua server (của cả hai phía), để màn chat tự thêm vào.
    @Published private(set) var lastSupportMessage: SupportMessage?
    /// Màn chat đang mở: tin Admin tới lúc này không cần báo.
    var supportChatOpen = false
    /// Kết nối Viettel Post của tài khoản (token lưu ở máy chủ ChốtLive). nil = chưa hỏi xong máy chủ.
    @Published var vtp: VtpConnection?

    var onChat: ((LiveComment) -> Void)?
    /// Báo đổi tài khoản trước khi nhận bình luận, để dữ liệu không rơi vào vùng của người khác.
    var onAccountChange: ((String?) -> Void)?
    /// Vừa nối server xong, kèm toàn bộ dữ liệu của tài khoản.
    var onHello: ((ServerSnapshot) -> Void)? {
        didSet {
            if let snap = pendingHello, let onHello {
                pendingHello = nil
                onHello(snap)
            }
        }
    }
    var onSnapshot: ((ServerSnapshot) -> Void)?
    var onSyncAck: ((Int) -> Void)?
    var onSocketClosed: (() -> Void)?

    private let defaults: UserDefaults
    private(set) var baseURL: String
    private var token: String
    private var task: URLSessionWebSocketTask?
    private var pingTimer: Timer?
    private var pendingHello: ServerSnapshot?
    private var syncWork: Task<Void, Never>?
    private var accessCheck: Task<Void, Never>?

    private var currentAccountKey: String { AuthStorage.accountKey(server: baseURL, user: username) }

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        let tk = AuthStorage.currentToken(defaults) // chạy di chuyển dữ liệu bản cũ nếu cần
        baseURL = defaults.string(forKey: AuthStorage.serverKey) ?? ""
        username = defaults.string(forKey: AuthStorage.userKey) ?? ""
        token = tk
        savedAccounts = AuthStorage.savedAccounts(defaults)
        let cached = defaults.dictionary(forKey: Self.accessCacheKey) as? [String: [String: Any]] ?? [:]
        accessByAccount = cached.compactMapValues(AccountAccess.init)
        access = accessByAccount[currentAccountKey]
        if !tk.isEmpty && !baseURL.isEmpty {
            loggedIn = true
            openSocket()
        }
    }

    nonisolated static func normalize(_ raw: String) -> String {
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
        try await authenticate(server: server, path: "/api/auth/login", user: user,
                               body: ["username": user, "password": password],
                               failure: "Đăng nhập thất bại")
    }

    /// Tạo tài khoản mới; server trả về phiên đăng nhập nên vào app được ngay.
    func register(server: String, user: String, password: String, confirmPassword: String) async throws {
        try await authenticate(server: server, path: "/api/auth/register", user: user,
                               body: ["username": user, "password": password, "confirmPassword": confirmPassword],
                               failure: "Đăng ký thất bại")
    }

    private func authenticate(server: String, path: String, user: String, body: [String: String], failure: String) async throws {
        let base = Self.normalize(server)
        guard let url = URL(string: base + path), url.host != nil else { throw ClientError.msg("Địa chỉ server không hợp lệ") }
        var req = URLRequest(url: url, timeoutInterval: 20)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: body)

        let reply: (Data, URLResponse)
        do {
            reply = try await URLSession.shared.data(for: req)
        } catch {
            throw ClientError.msg("Không kết nối được máy chủ. Vui lòng kiểm tra mạng rồi thử lại.")
        }
        let (data, resp) = reply
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        guard (resp as? HTTPURLResponse)?.statusCode == 200, let tk = json["token"] as? String else {
            throw ClientError.msg(json["error"] as? String ?? failure)
        }
        baseURL = base
        token = tk
        username = ((json["user"] as? [String: Any])?["username"] as? String) ?? user
        access = ((json["user"] as? [String: Any])?["access"] as? [String: Any]).flatMap { AccountAccess($0) }
        AuthStorage.saveSession(server: base, user: username, token: tk, defaults)
        savedAccounts = AuthStorage.savedAccounts(defaults)
        onAccountChange?(AuthStorage.accountKey(server: base, user: username))
        loggedIn = true
        openSocket()
    }

    /// Đăng xuất tài khoản đang dùng. Dữ liệu đã lưu trên máy vẫn được giữ lại, chỉ không hiện trong
    /// danh sách tài khoản đã lưu nữa — đăng nhập lại từ đầu mới dùng được.
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
        forgetAccess(currentAccountKey)
        token = ""
        AuthStorage.clearCurrentSession(defaults)
        savedAccounts = AuthStorage.savedAccounts(defaults)
        onAccountChange?(nil)
        loggedIn = false
        liveState = "idle"
        resetLiveInfo()
    }

    /// Nút Đăng xuất: đăng xuất mọi tài khoản trên máy, để sau màn đăng nhập danh sách chỉ còn tài khoản vừa vào.
    func logoutAll() {
        // forgetSavedAccount bỏ qua tài khoản đang dùng; logout() lo tài khoản đó.
        for account in savedAccounts { forgetSavedAccount(account.key) }
        logout()
    }

    private func resetLiveInfo() {
        lives = []
        lastLiveEvent = nil
        clientsCount = 0
        serverSupportsSync = false
        access = nil
        accessNotice = nil
        supportUnread = 0
        lastSupportMessage = nil
        vtp = nil
    }

    /// Chuyển sang một tài khoản đã lưu khác, không cần nhập lại mật khẩu.
    func switchAccount(to key: String) {
        guard key != currentAccountKey, let account = AuthStorage.switchCurrent(to: key, defaults),
              let tk = AuthStorage.token(for: key) else { return }
        closeSocket()
        baseURL = account.server
        username = account.user
        token = tk
        savedAccounts = AuthStorage.savedAccounts(defaults)
        onAccountChange?(key)
        loggedIn = true
        liveState = "idle"
        liveMessage = ""
        liveUsername = ""
        viewers = 0
        resetLiveInfo()
        // Sau resetLiveInfo (nó xoá access về nil): hiện ngay thẻ hạn dùng đã biết của tài khoản mới,
        // không để thẻ biến mất rồi hiện lại làm cả trang Tôi nhảy lên xuống.
        access = accessByAccount[key]
        openSocket()
    }

    /// Quên một tài khoản đã lưu khác — không tác động tới tài khoản đang dùng.
    func forgetSavedAccount(_ key: String) {
        guard key != currentAccountKey else { return }
        if let t = AuthStorage.token(for: key), let account = savedAccounts.first(where: { $0.key == key }),
           let url = URL(string: account.server + "/api/auth/logout") {
            var req = URLRequest(url: url)
            req.httpMethod = "POST"
            req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
            URLSession.shared.dataTask(with: req).resume()
        }
        AuthStorage.forgetAccount(key, defaults)
        forgetAccess(key)
        savedAccounts = AuthStorage.savedAccounts(defaults)
    }

    // MARK: - TikTok Live

    /// Thêm một live để theo dõi; các live đang theo dõi vẫn chạy tiếp.
    func connectLive(tiktok: String) {
        if !serverSupportsSync { liveState = "connecting" }
        liveMessage = ""
        lastLiveEvent = nil
        send(["type": "connect", "username": tiktok])
    }

    /// Dừng đúng một live. Không truyền tên thì dừng tất cả.
    func disconnectLive(_ username: String? = nil) {
        if let username {
            send(["type": "disconnect", "username": username])
        } else {
            send(["type": "disconnect"])
        }
        if !serverSupportsSync { liveState = "idle" }
    }

    func live(for tiktok: String) -> LiveInfo? {
        lives.first { $0.username.lowercased() == tiktok.lowercased() }
    }

    // MARK: - Đồng bộ dữ liệu

    /// Gom các thay đổi gần nhau rồi gửi một lần.
    func scheduleSync(_ store: Store) {
        syncWork?.cancel()
        syncWork = Task { @MainActor [weak self, weak store] in
            try? await Task.sleep(nanoseconds: 300_000_000)
            guard !Task.isCancelled, let self, let store else { return }
            self.flushSync(store)
        }
    }

    func flushSync(_ store: Store) {
        guard serverSupportsSync, task != nil, let update = store.makeSyncUpdate() else { return }
        guard let data = try? ServerSync.encoder.encode(update), let text = String(data: data, encoding: .utf8) else {
            store.syncInterrupted()
            return
        }
        task?.send(.string(text)) { _ in }
    }

    /// Lấy bù những bình luận có trong lúc app không nối được (khoá màn hình, mất mạng).
    func catchUpComments(into store: Store) async {
        guard serverSupportsSync else { return }
        // Lùi lại một chút để không sót bình luận về sát lúc mất kết nối; trùng thì tự bỏ qua.
        var since = store.latestCommentDate?.addingTimeInterval(-120)
        for _ in 0..<10 {
            guard let page = await fetchComments(since: since) else { return }
            store.addComments(page.comments)
            guard page.hasMore, since != nil, let last = page.comments.map(\.ts).max() else { return }
            since = last
        }
    }

    /// Lấy một trang bình luận cũ hơn của phiên để xem. Không có vị trí thì lấy từ mới nhất.
    func fetchOlderComments(sessionId: String, before: CommentCursor?) async -> CommentsPage? {
        guard serverSupportsSync else { return nil }
        let query = [URLQueryItem(name: "sessionId", value: sessionId)] + (before?.queryItems ?? [])
        return await fetchComments(query, limit: 200)
    }

    private func fetchComments(since: Date?) async -> CommentsPage? {
        let query = since.map { [URLQueryItem(name: "since", value: String(Int64($0.timeIntervalSince1970 * 1000)))] } ?? []
        return await fetchComments(query, limit: 1000)
    }

    private func fetchComments(_ extra: [URLQueryItem], limit: Int) async -> CommentsPage? {
        guard var comps = URLComponents(string: baseURL + "/api/comments") else { return nil }
        comps.queryItems = [URLQueryItem(name: "format", value: "native"), URLQueryItem(name: "limit", value: String(limit))] + extra
        guard let url = comps.url else { return nil }
        var req = URLRequest(url: url, timeoutInterval: 30)
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        guard let (data, resp) = try? await URLSession.shared.data(for: req),
              (resp as? HTTPURLResponse)?.statusCode == 200 else { return nil }
        guard var page = try? ServerSync.decoder.decode(CommentsPage.self, from: data) else { return nil }
        // Giá tính theo cùng quy tắc với bình luận nhận trực tiếp trên app.
        for i in page.comments.indices { page.comments[i].price = PriceParser.parse(page.comments[i].text) }
        return page
    }

    // MARK: - Chat với Admin

    private func supportCall(_ path: String, method: String = "GET", body: [String: Any]? = nil) async -> (Int, [String: Any])? {
        guard loggedIn, !token.isEmpty, let url = URL(string: baseURL + path) else { return nil }
        var req = URLRequest(url: url, timeoutInterval: 20)
        req.httpMethod = method
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        }
        guard let (data, resp) = try? await URLSession.shared.data(for: req),
              let code = (resp as? HTTPURLResponse)?.statusCode else { return nil }
        return (code, (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:])
    }

    /// Gọi API của máy chủ ChốtLive bằng phiên đăng nhập hiện tại. nil = không tới được máy chủ.
    func apiCall(_ path: String, method: String = "GET", body: [String: Any]? = nil,
                 timeout: TimeInterval = 20) async -> (Int, [String: Any])? {
        guard loggedIn, !token.isEmpty, let url = URL(string: baseURL + path) else { return nil }
        var req = URLRequest(url: url, timeoutInterval: timeout)
        req.httpMethod = method
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        }
        guard let (data, resp) = try? await URLSession.shared.data(for: req),
              let code = (resp as? HTTPURLResponse)?.statusCode else { return nil }
        return (code, (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:])
    }

    /// Hỏi số tin chưa đọc (lúc mở app hoặc vừa nối lại server, phòng khi lỡ tin lúc mất kết nối).
    func refreshSupportUnread() {
        Task { @MainActor [weak self] in
            guard let self, let (code, json) = await self.supportCall("/api/support/sessions"), code == 200 else { return }
            self.setSupportUnread((json["unread"] as? Int) ?? 0)
        }
    }

    /// Mọi phiên kèm toàn bộ tin nhắn (mới nhất trước).
    func fetchSupportThreads() async -> [SupportThread]? {
        guard let (code, json) = await supportCall("/api/support/sessions?full=1"), code == 200 else { return nil }
        setSupportUnread((json["unread"] as? Int) ?? supportUnread)
        return (json["sessions"] as? [[String: Any]])?.compactMap { d in
            guard let s = SupportSession(d) else { return nil }
            let msgs = (d["messages"] as? [[String: Any]])?.compactMap { SupportMessage($0) } ?? []
            return SupportThread(session: s, messages: msgs)
        } ?? []
    }

    func endSupportSession() async {
        _ = await supportCall("/api/support/end", method: "POST", body: [:])
    }

    func fetchSupportSessions() async -> [SupportSession]? {
        guard let (code, json) = await supportCall("/api/support/sessions"), code == 200 else { return nil }
        setSupportUnread((json["unread"] as? Int) ?? supportUnread)
        return (json["sessions"] as? [[String: Any]])?.compactMap { SupportSession($0) } ?? []
    }

    /// Không truyền `sessionId` thì lấy phiên mới nhất.
    func fetchSupportMessages(sessionId: String?) async -> (SupportSession?, [SupportMessage])? {
        let path = "/api/support/messages" + (sessionId.map { "?sessionId=" + $0 } ?? "")
        guard let (code, json) = await supportCall(path), code == 200 else { return nil }
        let session = (json["session"] as? [String: Any]).flatMap { SupportSession($0) }
        let messages = (json["messages"] as? [[String: Any]])?.compactMap { SupportMessage($0) } ?? []
        return (session, messages)
    }

    func sendSupport(_ text: String) async throws -> SupportMessage {
        guard let (code, json) = await supportCall("/api/support/messages", method: "POST", body: ["text": text]) else {
            throw ClientError.msg("Không gửi được, vui lòng kiểm tra mạng rồi thử lại.")
        }
        guard code == 200, let m = (json["message"] as? [String: Any]).flatMap({ SupportMessage($0) }) else {
            throw ClientError.msg(json["error"] as? String ?? "Không gửi được tin nhắn.")
        }
        return m
    }

    func markSupportRead() async {
        setSupportUnread(0)
        _ = await supportCall("/api/support/read", method: "POST", body: [:])
    }

    /// Chỉ gán khi số thật sự đổi: gán lại cùng số vẫn làm mọi màn hình đang dùng LiveClient vẽ lại.
    private func setSupportUnread(_ n: Int) {
        if supportUnread != n { supportUnread = n }
    }

    private func handleSupport(_ m: [String: Any]) {
        guard let raw = m["message"] as? [String: Any], let msg = SupportMessage(raw) else { return }
        lastSupportMessage = msg
        guard msg.sender == "admin" else { return }
        if supportChatOpen {
            Task { await markSupportRead() }
        } else {
            setSupportUnread((m["unread"] as? Int) ?? (supportUnread + 1))
            SupportNotifier.shared.notify(text: msg.text)
        }
    }

    // MARK: - Dùng thử và gói

    /// Hỏi lại server thời hạn dùng của tài khoản. Server chỉ tự báo khi đang theo dõi live,
    /// nên lúc mở lại app và lúc hết giờ dùng thử phải tự hỏi.
    func refreshAccess() {
        guard loggedIn, !token.isEmpty, let url = URL(string: baseURL + "/api/auth/me") else { return }
        let key = currentAccountKey
        var req = URLRequest(url: url, timeoutInterval: 20)
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        Task { @MainActor [weak self] in
            let reply = try? await URLSession.shared.data(for: req)
            guard let self, self.currentAccountKey == key else { return }
            if let (data, resp) = reply, (resp as? HTTPURLResponse)?.statusCode == 200,
               let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
               let raw = (json["user"] as? [String: Any])?["access"] as? [String: Any] {
                self.access = AccountAccess(raw)
            } else {
                self.scheduleAccessCheck() // mất mạng lúc vừa hết giờ: thử lại sau
            }
        }
    }

    /// Hỏi lại ngay sau mốc hết hạn; đã quá mốc mà server vẫn chưa báo hết thì hỏi lại mỗi 5 giây.
    private func scheduleAccessCheck() {
        accessCheck?.cancel()
        accessCheck = nil
        guard let a = access, a.canFollowLive, a.status != "admin", let end = a.endsAt else { return }
        let delay = max(5, end.timeIntervalSinceNow + 1)
        accessCheck = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            guard !Task.isCancelled else { return }
            self?.refreshAccess()
        }
    }

    /// App quay lại màn hình: kiểm tra kết nối còn sống không, để nối lại ngay thay vì chờ tự phát hiện.
    func checkSocket() {
        guard loggedIn else { return }
        refreshAccess()
        guard let t = task else {
            openSocket()
            return
        }
        t.sendPing { [weak self] error in
            guard error != nil else { return }
            Task { @MainActor in
                guard let self, self.task === t else { return }
                self.socketClosed()
            }
        }
    }

    // MARK: - WebSocket

    private func openSocket() {
        closeSocket()
        guard var comps = URLComponents(string: baseURL), !token.isEmpty else { return }
        comps.scheme = (comps.scheme == "https") ? "wss" : "ws"
        comps.path = "/ws"
        comps.queryItems = [URLQueryItem(name: "token", value: token), URLQueryItem(name: "native", value: "1")]
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
        onSocketClosed?()
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

    /// Trạng thái chung cho các màn chỉ cần biết "có đang live không".
    private func applyLives(_ raw: [[String: Any]]) {
        let next = raw.compactMap { LiveInfo($0) }
        if next != lives { lives = next }
        viewers = next.reduce(0) { $0 + $1.viewers }
        let lead = next.first { $0.state == "connected" } ?? next.first
        liveUsername = lead?.username ?? ""
        let state = lead?.state ?? "idle"
        if state != liveState { liveState = state }
    }

    private struct SnapshotEnvelope: Decodable {
        var snapshot: ServerSnapshot?
    }

    private func decodeSnapshot(_ data: Data) -> ServerSnapshot? {
        // Lỗi đọc dữ liệu từ server: giữ nguyên dữ liệu trên máy, lần sau server gửi lại.
        (try? ServerSync.decoder.decode(SnapshotEnvelope.self, from: data))?.snapshot
    }

    private func handle(_ data: Data) {
        guard let m = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let type = m["type"] as? String else { return }
        switch type {
        case "hello":
            let version = (m["version"] as? Int) ?? 0
            serverSupportsSync = version >= 4
            if let n = m["clientsCount"] as? Int { clientsCount = n }
            if let raw = (m["user"] as? [String: Any])?["access"] as? [String: Any] { access = AccountAccess(raw) }
            if serverSupportsSync, let raw = m["lives"] as? [[String: Any]] {
                applyLives(raw)
            } else if let ls = m["liveStatus"] as? [String: Any] {
                applyLiveStatus(ls)
            }
            if serverSupportsSync, let snap = decodeSnapshot(data) {
                if let onHello { onHello(snap) } else { pendingHello = snap }
            }
            refreshSupportUnread()
            refreshVtp()
        case "lives":
            if let raw = m["lives"] as? [[String: Any]] { applyLives(raw) }
        case "native_state":
            if let snap = decodeSnapshot(data) { onSnapshot?(snap) }
        case "native_ack":
            if let n = m["clientsCount"] as? Int { clientsCount = n }
            if let id = m["id"] as? Int { onSyncAck?(id) }
        case "clients_count":
            if let n = m["clientsCount"] as? Int { clientsCount = n }
        case "access":
            if let raw = m["access"] as? [String: Any] { access = AccountAccess(raw) }
        case "status":
            let state = (m["state"] as? String) ?? "idle"
            let username = (m["username"] as? String) ?? ""
            liveMessage = (m["message"] as? String) ?? ""
            if let code = m["code"] as? String, code == "TRIAL_EXPIRED" || code == "PLAN_EXPIRED" {
                accessNotice = liveMessage
            }
            if serverSupportsSync {
                if state == "error" || state == "ended" {
                    lastLiveEvent = (username, state, liveMessage)
                }
            } else {
                if !username.isEmpty { liveUsername = username }
                liveState = state
            }
        case "viewers":
            let count = (m["count"] as? Int) ?? Int((m["count"] as? Double) ?? 0)
            if serverSupportsSync, let username = m["username"] as? String,
               let i = lives.firstIndex(where: { $0.username == username }) {
                lives[i].viewers = count
                viewers = lives.reduce(0) { $0 + $1.viewers }
            } else {
                viewers = count
            }
        case "chat":
            let text = (m["comment"] as? String) ?? ""
            let uid = (m["uniqueId"] as? String) ?? ""
            let c = LiveComment(
                id: (m["id"] as? String) ?? UUID().uuidString,
                uniqueId: uid,
                userId: (m["userId"] as? String) ?? "",
                nickname: (m["nickname"] as? String) ?? uid,
                text: text,
                ts: (m["ts"] as? Double).map { Date(timeIntervalSince1970: $0 / 1000) } ?? Date(),
                price: PriceParser.parse(text),
                sessionId: (m["sessionId"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            )
            onChat?(c)
        case "support_message":
            handleSupport(m)
        case "account_locked", "password_changed_force_login", "auth_error":
            liveMessage = (m["message"] as? String) ?? "Phiên đăng nhập không còn hiệu lực"
            logout()
        default:
            break
        }
    }
}

#if DEBUG
extension LiveClient {
    /// Dữ liệu demo cho màn Tôi (chụp màn hình), không đụng tới Keychain/UserDefaults thật.
    func setDemoAccounts(_ accounts: [AuthStorage.SavedAccount], current: AuthStorage.SavedAccount) {
        savedAccounts = accounts
        baseURL = current.server
        username = current.user
    }

    func setDemoAccess(_ demo: AccountAccess) {
        access = demo
    }
}
#endif

enum ClientError: LocalizedError {
    case msg(String)
    var errorDescription: String? { if case .msg(let s) = self { return s } else { return nil } }
}
