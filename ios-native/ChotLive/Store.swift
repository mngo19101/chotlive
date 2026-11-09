import Foundation

/// Lưu bình luận, khách hàng, phiên live... trên máy và đồng bộ với server (xem ServerSync.swift).
/// Mỗi tài khoản có một file riêng: Documents/accounts/<mã tài khoản>/chotlive.json.
final class Store: ObservableObject {
    @Published var comments: [LiveComment] = []
    @Published var customers: [Customer] = []
    @Published var sessions: [LiveSession] = []
    @Published var accounts: [TikTokAccount] = []
    @Published var activeAccountId: String?
    @Published var keywords: [String] = Store.defaultKeywords
    /// Báo cho người dùng khi không đọc hoặc không ghi được dữ liệu.
    @Published var storageWarning: String?

    /// Tắt ghi file (bản demo chụp màn hình).
    var persistEnabled = true

    /// ID vừa bắt đầu live với "Lưu ID này cho lần sau" đang tắt.
    var unsavedLiveId: String?

    /// Có thay đổi cần gửi lên server.
    var onLocalChange: (() -> Void)?
    var syncState = SyncState()
    /// Gói đang chờ server xác nhận.
    private var sending: (id: Int, customers: Set<String>, items: Set<String>, accounts: Set<String>, accountsDirty: Bool, initial: Bool)?
    /// Đổi tiếp trong lúc chờ xác nhận thì vẫn phải gửi lại.
    private var touchedWhileSending: Set<String> = []
    private var accountsTouchedWhileSending = false
    private var nextUpdateId = 1
    private var knownCommentIds: Set<String> = []

    private static let defaultKeywords = ["chốt", "lấy"]
    /// Trên máy giữ chừng này bình luận mới nhất; toàn bộ lịch sử nằm trên server.
    static let commentLimit = 5000
    private static let fileName = "chotlive.json"

    private var saveWork: DispatchWorkItem?
    private var accountKey: String?
    /// Có file chưa đọc được thì không ghi, tránh đè lên dữ liệu cũ.
    private var saveBlocked = false
    private var saveFailed = false

    private let directory: URL
    private let defaults: UserDefaults
    private let legacyOwner: String?

    private var fileURL: URL? {
        accountKey.map {
            directory.appendingPathComponent("accounts").appendingPathComponent(AuthStorage.folderName(account: $0))
                .appendingPathComponent(Self.fileName)
        }
    }

    init(account: String? = AuthStorage.currentAccountKey(),
         directory: URL = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0],
         defaults: UserDefaults = .standard) {
        self.directory = directory
        self.defaults = defaults
        legacyOwner = AuthStorage.legacyOwner(defaults)
        accountKey = account
        load()
    }

    /// Đăng nhập hoặc đăng xuất: ghi nốt dữ liệu tài khoản cũ rồi nạp dữ liệu tài khoản mới.
    func switchAccount(_ account: String?) {
        guard account != accountKey else { return }
        closeOpenSession()
        save()
        comments = []
        customers = []
        sessions = []
        accounts = []
        activeAccountId = nil
        keywords = Self.defaultKeywords
        storageWarning = nil
        unsavedLiveId = nil
        syncState = SyncState()
        sending = nil
        touchedWhileSending = []
        accountsTouchedWhileSending = false
        knownCommentIds = []
        saveBlocked = false
        saveFailed = false
        accountKey = account
        load()
    }

    // MARK: - Bình luận

    var openSession: LiveSession? { sessions.first(where: \.isLive) }

    private func refreshKnownCommentIds() {
        if knownCommentIds.count != comments.count { knownCommentIds = Set(comments.map(\.id)) }
    }

    private func trimComments() {
        if comments.count > Self.commentLimit {
            comments.removeLast(comments.count - Self.commentLimit)
            knownCommentIds = Set(comments.map(\.id))
        }
    }

    func addComment(_ c: LiveComment, tiktok: String) {
        refreshKnownCommentIds()
        guard !knownCommentIds.contains(c.id) else { return }
        var comment = c
        if comment.sessionId == nil {
            // Server chưa gắn phiên (server bản cũ): tự ghi phiên trên máy như trước.
            if openSession == nil { beginSession(tiktok: tiktok) }
            comment.sessionId = openSession?.id
        }
        comments.insert(comment, at: 0)
        knownCommentIds.insert(comment.id)
        trimComments()
        if let i = sessions.firstIndex(where: { $0.id == comment.sessionId }) {
            sessions[i].commentCount += 1
            sessions[i].lastActivity = comment.ts
        }
        scheduleSave()
    }

    /// Bình luận lấy bù từ server (lúc máy mất mạng hoặc khoá màn hình). Bộ đếm phiên do server gửi.
    func addComments(_ batch: [LiveComment]) {
        refreshKnownCommentIds()
        let fresh = batch.filter { !knownCommentIds.contains($0.id) }
        guard !fresh.isEmpty else { return }
        comments = (comments + fresh).sorted { $0.ts > $1.ts }
        knownCommentIds.formUnion(fresh.map(\.id))
        trimComments()
        scheduleSave()
    }

    /// Bình luận chốt đơn: đã chốt tay, có từ khoá chốt, hoặc chỉ ghi mã. "Mã 130 giá sao" chỉ là hỏi giá.
    func isClosingComment(_ c: LiveComment) -> Bool {
        if c.printed { return true }
        let text = PriceParser.stripAccents(c.text.lowercased())
        if keywords.contains(where: { !$0.isEmpty && text.contains(PriceParser.stripAccents($0.lowercased())) }) { return true }
        return PriceParser.isOnlyCodes(c.text)
    }

    // MARK: - Phiên live

    /// Đồng bộ phiên theo trạng thái kết nối từ server.
    func syncLive(state: String, username: String) {
        switch state {
        case "connected":
            if let open = openSession {
                if open.tiktok.lowercased() == username.lowercased() || username.isEmpty { return }
                closeOpenSession()
            }
            beginSession(tiktok: username)
        case "idle", "ended", "error", "disconnected":
            closeOpenSession()
        default:
            break
        }
    }

    private func beginSession(tiktok: String) {
        let now = Clock.now
        // Rớt mạng ngắn rồi nối lại: tiếp tục phiên cũ thay vì tạo phiên mới.
        if let i = sessions.firstIndex(where: {
            $0.tiktok.lowercased() == tiktok.lowercased() && ($0.end.map { now.timeIntervalSince($0) < 300 } ?? false)
        }) {
            sessions[i].end = nil
        } else {
            sessions.insert(LiveSession(id: UUID().uuidString, tiktok: tiktok, start: now), at: 0)
        }
        if !tiktok.isEmpty && tiktok.lowercased() != unsavedLiveId {
            addAccount(uniqueId: tiktok, displayName: "", activate: activeAccountId == nil)
        }
        save()
    }

    private func closeOpenSession() {
        guard sessions.contains(where: \.isLive) else { return }
        let now = Clock.now
        for i in sessions.indices where sessions[i].isLive {
            // App bị tắt giữa phiên: lấy mốc hoạt động cuối thay vì lúc mở lại app.
            let last = sessions[i].lastActivity ?? sessions[i].start
            sessions[i].end = now.timeIntervalSince(last) > 600 ? last : now
        }
        save()
    }

    /// Lần live gần nhất của một tài khoản.
    func lastSession(account id: String) -> LiveSession? {
        sessions.filter { $0.tiktok.lowercased() == id }.max { $0.start < $1.start }
    }

    func sessions(in filter: DateFilter) -> [LiveSession] {
        sessions.filter(filter.overlaps).sorted { $0.start > $1.start }
    }

    func comments(session id: String) -> [LiveComment] { comments.filter { $0.sessionId == id } }

    func sessionCustomerCount(_ id: String) -> Int {
        customers.filter { c in c.items.contains { $0.sessionId == id } }.count
    }

    func sessionOrderCount(_ id: String) -> Int {
        customers.reduce(0) { sum, c in
            sum + Set(c.items.filter { $0.sessionId == id }.map { $0.groupId ?? $0.id }).count
        }
    }

    // MARK: - Khách & đơn

    /// Lưu bình luận vào khách (tạo khách nếu chưa có). Trả về các món của bình luận này;
    /// bình luận chốt nhiều mã ("Chốt 120 với 180") sinh ra nhiều món.
    @discardableResult
    func saveToCustomer(_ c: LiveComment) -> [OrderItem] {
        let key = Self.key(uniqueId: c.uniqueId, userId: c.userId)
        let tokens = c.price > 0 ? PriceParser.orderTokens(c.text) : []
        let items: [OrderItem]
        if tokens.count > 1 {
            items = tokens.enumerated().map { i, t in
                OrderItem(id: i == 0 ? c.id : "\(c.id)#\(i + 1)", comment: c.text, price: t.price, ts: c.ts,
                          sessionId: c.sessionId, groupId: c.sessionId, code: t.code, commentId: c.id)
            }
        } else {
            items = [OrderItem(id: c.id, comment: c.text, price: c.price, ts: c.ts, sessionId: c.sessionId,
                               groupId: c.sessionId, code: tokens.first?.code, commentId: c.id)]
        }

        if let i = comments.firstIndex(where: { $0.id == c.id }) { comments[i].printed = true }
        if let idx = customers.firstIndex(where: { $0.id == key || (!c.userId.isEmpty && $0.userId == c.userId) }) {
            let existing = customers[idx].items.filter { ($0.commentId ?? $0.id) == c.id }
            if !existing.isEmpty { return existing }
            customers[idx].items.append(contentsOf: items)
            if customers[idx].userId.isEmpty { customers[idx].userId = c.userId }
            if !c.nickname.isEmpty { customers[idx].nickname = c.nickname }
        } else {
            customers.append(Customer(id: key, uniqueId: c.uniqueId, userId: c.userId, nickname: c.nickname, items: items))
        }
        touchCustomer(customers.first { $0.items.contains { $0.commentId == c.id || $0.id == c.id } }?.id ?? key)
        save()
        return items
    }

    func deleteItem(customerId: String, itemId: String) {
        guard let idx = customers.firstIndex(where: { $0.id == customerId }) else { return }
        customers[idx].items.removeAll { $0.id == itemId }
        if customers[idx].items.isEmpty { customers.remove(at: idx) }
        touchCustomer(customerId, deletedItems: [itemId])
        save()
    }

    func deleteOrder(_ o: Order) {
        guard let idx = customers.firstIndex(where: { $0.id == o.customer.id }) else { return }
        let ids = Set(o.items.map(\.id))
        customers[idx].items.removeAll { ids.contains($0.id) }
        if customers[idx].items.isEmpty { customers.remove(at: idx) }
        touchCustomer(o.customer.id, deletedItems: ids)
        save()
    }

    /// Thay toàn bộ sản phẩm của đơn bằng danh sách đã sửa.
    func updateOrder(_ o: Order, items edited: [OrderItem]) {
        guard let idx = customers.firstIndex(where: { $0.id == o.customer.id }) else { return }
        let ids = Set(o.items.map(\.id))
        customers[idx].items.removeAll { ids.contains($0.id) }
        customers[idx].items.append(contentsOf: edited)
        if customers[idx].items.isEmpty { customers.remove(at: idx) }
        touchCustomer(o.customer.id, deletedItems: ids.subtracting(edited.map(\.id)))
        save()
    }

    /// Tạo đơn tay. Trả về id đơn.
    @discardableResult
    func createOrder(nickname: String, uniqueId: String, items draft: [OrderItem]) -> String {
        let handle = uniqueId.trimmingCharacters(in: CharacterSet(charactersIn: "@ ")).lowercased()
        let name = nickname.trimmingCharacters(in: .whitespaces)
        let cid = handle.isEmpty ? "manual-" + name.lowercased() : handle
        let group = "manual-" + UUID().uuidString
        let now = Clock.now
        let items = draft.map { d -> OrderItem in
            var it = d
            it.ts = now
            it.groupId = group
            return it
        }
        if let idx = customers.firstIndex(where: { $0.id == cid }) {
            customers[idx].items.append(contentsOf: items)
            if !name.isEmpty { customers[idx].nickname = name }
        } else {
            customers.append(Customer(id: cid, uniqueId: handle, userId: "", nickname: name.isEmpty ? handle : name, items: items))
        }
        touchCustomer(cid)
        save()
        return cid + "|" + group
    }

    func setAddress(_ a: DeliveryAddress, customerId: String) {
        guard let idx = customers.firstIndex(where: { $0.id == customerId }) else { return }
        customers[idx].address = a
        touchCustomer(customerId)
        save()
    }

    func markPrinted(itemId: String) {
        for ci in customers.indices {
            if let ii = customers[ci].items.firstIndex(where: { $0.id == itemId }) {
                customers[ci].items[ii].printed = true
                touchCustomer(customers[ci].id)
            }
        }
        save()
    }

    /// Giao hàng: chưa giao → đang giao → đã giao → (bấm lại) về chưa giao.
    func advanceDelivery(_ o: Order) {
        let ids = Set(o.items.map(\.id))
        let status = o.status
        for ci in customers.indices where customers[ci].id == o.customer.id {
            for ii in customers[ci].items.indices where ids.contains(customers[ci].items[ii].id) {
                switch status {
                case .new, .printed:
                    customers[ci].items[ii].shipping = true
                    customers[ci].items[ii].delivered = false
                case .shipping:
                    customers[ci].items[ii].shipping = false
                    customers[ci].items[ii].delivered = true
                case .delivered:
                    customers[ci].items[ii].shipping = false
                    customers[ci].items[ii].delivered = false
                }
            }
        }
        touchCustomer(o.customer.id)
        save()
    }

    // MARK: - Duyệt đơn & Viettel Post

    /// Ghi thông tin giao vào mọi món của từng đơn (id đơn → ship). `shipping`: true chuyển Đang giao,
    /// false đưa về chưa giao, nil giữ nguyên. Server đọc `ship` để web thấy đúng trạng thái.
    func setShip(_ changes: [String: ShipInfo], shipping: Bool? = nil) {
        var touched: Set<String> = []
        for (orderId, ship) in changes {
            guard let o = order(id: orderId), let ci = customers.firstIndex(where: { $0.id == o.customer.id }) else { continue }
            let ids = Set(o.items.map(\.id))
            for ii in customers[ci].items.indices where ids.contains(customers[ci].items[ii].id) {
                customers[ci].items[ii].ship = ship
                if let shipping {
                    customers[ci].items[ii].shipping = shipping
                    customers[ci].items[ii].delivered = false
                }
            }
            touched.insert(o.customer.id)
        }
        guard !touched.isEmpty else { return }
        touched.forEach { touchCustomer($0) }
        save()
    }

    /// Bảng Duyệt đơn: chuyển các đơn được tick sang Chờ gửi (`ready`) hoặc Gom sau (`hold`).
    /// Tiền cọc ghi ở đơn đầu tiên, các cài đặt khác ghi ở mọi đơn, giống web.
    func approve(_ orderIds: [String], state: ShipState, base: ShipInfo) {
        var changes: [String: ShipInfo] = [:]
        for (i, id) in orderIds.enumerated() {
            var s = base
            s.state = state.rawValue
            if i > 0 { s.deposit = 0 }
            // Giữ mã vận đơn đã huỷ và lỗi lần gửi trước: lần gửi sau cần biết để không trùng mã đơn.
            if let old = order(id: id)?.ship {
                s.vtpOldCode = old.vtpOldCode
                s.vtpKind = old.vtpKind
                s.vtpError = old.vtpError
                s.vtpErrorAt = old.vtpErrorAt
            }
            s.exportedAt = nil
            s.batchId = nil
            changes[id] = s
        }
        setShip(changes)
    }

    /// Đã xuất file Viettel Post: các đơn chuyển Đang giao và rời khỏi thanh Sẵn sàng xuất.
    func markExported(_ orders: [Order], at now: Date = Clock.now) {
        let batch = "vtp_" + String(Int(now.timeIntervalSince1970 * 1000), radix: 36)
        var changes: [String: ShipInfo] = [:]
        for o in orders {
            var s = o.ship ?? ShipInfo()
            s.state = ShipState.exported.rawValue
            s.exportedAt = (now.timeIntervalSince1970 * 1000).rounded()
            s.batchId = batch
            changes[o.id] = s
        }
        setShip(changes, shipping: true)
    }

    /// Hoàn tác xuất: đơn cùng lần xuất của khách về lại Chờ gửi.
    func undoExport(_ o: Order) {
        let batch = o.ship?.batchId
        let list = orders(of: o.customer).filter { $0.id == o.id || (batch != nil && $0.ship?.batchId == batch) }
        var changes: [String: ShipInfo] = [:]
        for x in list {
            var s = x.ship ?? ShipInfo()
            s.state = ShipState.ready.rawValue
            s.exportedAt = nil
            s.batchId = nil
            changes[x.id] = s
        }
        setShip(changes, shipping: false)
    }

    /// Đang giao ↔ Đã giao.
    func setDelivered(_ o: Order, _ delivered: Bool) {
        let ids = Set(o.items.map(\.id))
        guard let ci = customers.firstIndex(where: { $0.id == o.customer.id }) else { return }
        for ii in customers[ci].items.indices where ids.contains(customers[ci].items[ii].id) {
            customers[ci].items[ii].delivered = delivered
            customers[ci].items[ii].shipping = !delivered
        }
        touchCustomer(o.customer.id)
        save()
    }

    /// Mọi đơn, mới nhất trước.
    func allOrders() -> [Order] {
        customers.flatMap(orders(of:)).sorted { $0.lastTs > $1.lastTs }
    }

    func orders(of customer: Customer) -> [Order] {
        let cal = Calendar.current
        let groups = Dictionary(grouping: customer.items) { item -> String in
            item.groupId ?? "day-\(Int(cal.startOfDay(for: item.ts).timeIntervalSince1970))"
        }
        return groups.map { key, its in
            Order(key: key, customer: customer, items: its.sorted { $0.ts < $1.ts })
        }.sorted { $0.lastTs > $1.lastTs }
    }

    func orders(in filter: DateFilter) -> [Order] {
        allOrders().filter { filter.contains($0.lastTs) }
    }

    func order(id: String) -> Order? {
        for c in customers where id.hasPrefix(c.id + "|") {
            if let o = orders(of: c).first(where: { $0.id == id }) { return o }
        }
        return nil
    }

    func customerCount(in filter: DateFilter) -> Int {
        customers.filter { c in c.items.contains { filter.contains($0.ts) } }.count
    }

    func revenue(on day: Date) -> Int {
        let cal = Calendar.current
        return customers.reduce(0) { sum, c in
            sum + c.items.filter { cal.isDate($0.ts, inSameDayAs: day) }.reduce(0) { $0 + $1.lineTotal }
        }
    }

    /// Doanh thu từ đầu tháng của `date` tới hết ngày thứ `throughDay` trong tháng.
    func revenue(monthOf date: Date, throughDay: Int) -> Int {
        let cal = Calendar.current
        return customers.reduce(0) { sum, c in
            sum + c.items.filter {
                cal.isDate($0.ts, equalTo: date, toGranularity: .month) && cal.component(.day, from: $0.ts) <= throughDay
            }.reduce(0) { $0 + $1.lineTotal }
        }
    }

    func customersToday() -> [Customer] {
        customers.filter { !$0.itemsToday.isEmpty }
    }

    // MARK: - Tài khoản TikTok

    var activeAccount: TikTokAccount? { accounts.first { $0.id == activeAccountId } }

    func addAccount(uniqueId: String, displayName: String, activate: Bool) {
        let handle = uniqueId.trimmingCharacters(in: CharacterSet(charactersIn: "@ "))
        guard !handle.isEmpty else { return }
        let id = handle.lowercased()
        let name = displayName.trimmingCharacters(in: .whitespaces)
        if let i = accounts.firstIndex(where: { $0.id == id }) {
            if !name.isEmpty { accounts[i].displayName = name }
        } else {
            accounts.append(TikTokAccount(id: id, uniqueId: handle, displayName: name.isEmpty ? handle : name))
        }
        if activate || activeAccountId == nil { activeAccountId = id }
        syncState.deletedAccounts.remove(id)
        touchAccounts()
        save()
    }

    func selectAccount(_ id: String) {
        activeAccountId = id
        touchAccounts()
        save()
    }

    func removeAccount(_ id: String) {
        accounts.removeAll { $0.id == id }
        if activeAccountId == id { activeAccountId = accounts.first?.id }
        syncState.deletedAccounts.insert(id)
        touchAccounts()
        save()
    }

    func setKeywords(_ list: [String]) {
        keywords = list
        save()
    }

    // MARK: - Theo dõi thay đổi để gửi lên server

    private func touchCustomer(_ id: String, deletedItems: Set<String> = []) {
        syncState.dirtyCustomers.insert(id)
        syncState.deletedItems.formUnion(deletedItems)
        if sending != nil { touchedWhileSending.insert(id) }
        onLocalChange?()
    }

    private func touchAccounts() {
        syncState.accountsDirty = true
        if sending != nil { accountsTouchedWhileSending = true }
        onLocalChange?()
    }

    var isAwaitingAck: Bool { sending != nil }
    var inFlightCustomerIds: Set<String> { sending?.customers ?? [] }

    /// Đánh dấu gói sắp gửi; trả về mã gói. Thay đổi chỉ được xoá khi server xác nhận.
    func beginSending() -> Int {
        let id = nextUpdateId
        nextUpdateId += 1
        sending = (id, syncState.dirtyCustomers, syncState.deletedItems, syncState.deletedAccounts,
                   syncState.accountsDirty, !syncState.syncedOnce)
        touchedWhileSending = []
        accountsTouchedWhileSending = false
        return id
    }

    /// Server đã nhận gói. Nếu vẫn còn thay đổi mới thì trả về true để gửi tiếp.
    @discardableResult
    func acknowledgeSync(id: Int) -> Bool {
        guard let sent = sending, sent.id == id else { return syncState.hasChanges }
        syncState.dirtyCustomers.subtract(sent.customers.subtracting(touchedWhileSending))
        syncState.deletedItems.subtract(sent.items)
        syncState.deletedAccounts.subtract(sent.accounts)
        if sent.accountsDirty && !accountsTouchedWhileSending { syncState.accountsDirty = false }
        if sent.initial { syncState.syncedOnce = true }
        sending = nil
        touchedWhileSending = []
        accountsTouchedWhileSending = false
        saveSoon()
        return syncState.hasChanges
    }

    /// Mất kết nối trước khi được xác nhận: thay đổi vẫn còn nguyên, gửi lại khi nối lại.
    func syncInterrupted() {
        sending = nil
        touchedWhileSending = []
        accountsTouchedWhileSending = false
    }

    func saveSoon() { scheduleSave() }

    // MARK: - Lưu trữ

    static func key(uniqueId: String, userId: String) -> String {
        let u = uniqueId.lowercased()
        return u.isEmpty ? userId : u
    }

    private func load() {
        guard let url = fileURL else { return }
        let adopted = adoptLegacyFile(to: url)
        if FileManager.default.fileExists(atPath: url.path) { read(url) }
        if adopted { migrateLegacy() }
    }

    /// Không đọc được file thì không ghi đè: lỗi đọc thì tạm ngừng lưu, file hỏng thì cất riêng rồi bắt đầu lại.
    private func read(_ url: URL) {
        let data: Data
        do {
            data = try Data(contentsOf: url)
        } catch {
            saveBlocked = true
            storageWarning = "Không đọc được dữ liệu đã lưu. App tạm ngừng lưu để giữ nguyên dữ liệu cũ, bạn hãy mở lại app."
            return
        }
        guard let snap = try? JSONDecoder().decode(Snapshot.self, from: data) else {
            quarantine(url)
            return
        }
        comments = snap.comments
        customers = snap.customers
        sessions = snap.sessions
        accounts = snap.accounts
        activeAccountId = snap.activeAccountId
        if let k = snap.keywords { keywords = k }
        syncState = snap.sync ?? SyncState()
        knownCommentIds = Set(snap.comments.map(\.id))
    }

    private func quarantine(_ url: URL) {
        let name = "chotlive.loi-\(Int(Date().timeIntervalSince1970))-\(UUID().uuidString.prefix(8)).json"
        do {
            try FileManager.default.moveItem(at: url, to: url.deletingLastPathComponent().appendingPathComponent(name))
            storageWarning = "Dữ liệu đã lưu bị lỗi nên app bắt đầu với dữ liệu trống. Bản cũ vẫn được giữ trên máy, chưa bị xoá."
        } catch {
            saveBlocked = true
            storageWarning = "Dữ liệu đã lưu bị lỗi. App tạm ngừng lưu để giữ nguyên dữ liệu cũ."
        }
    }

    /// File của bản cũ thuộc về người đã đăng nhập trước khi cập nhật, tài khoản khác không được nhận.
    private func adoptLegacyFile(to url: URL) -> Bool {
        let manager = FileManager.default
        let legacy = directory.appendingPathComponent(Self.fileName)
        guard manager.fileExists(atPath: legacy.path), !manager.fileExists(atPath: url.path) else { return false }
        if let legacyOwner, legacyOwner != accountKey { return false }
        do {
            try manager.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try manager.moveItem(at: legacy, to: url)
            return true
        } catch {
            saveBlocked = true
            storageWarning = "Không chuyển được dữ liệu cũ. App tạm ngừng lưu để giữ nguyên dữ liệu cũ, bạn hãy mở lại app."
            return false
        }
    }

    /// Dữ liệu từ bản cũ: gom bình luận chưa có phiên thành một phiên cho mỗi ngày.
    private func migrateLegacy() {
        let cal = Calendar.current
        let tiktok = defaults.string(forKey: "tiktokName") ?? ""
        defaults.removeObject(forKey: "tiktokName")
        if accounts.isEmpty && !tiktok.isEmpty {
            addAccount(uniqueId: tiktok, displayName: "", activate: true)
        }
        let orphans = comments.filter { $0.sessionId == nil }
        guard !orphans.isEmpty else { return }
        for (day, group) in Dictionary(grouping: orphans, by: { cal.startOfDay(for: $0.ts) }) {
            let id = "legacy-\(Int(day.timeIntervalSince1970))"
            let times = group.map(\.ts)
            sessions.append(LiveSession(id: id, tiktok: tiktok, start: times.min() ?? day, end: times.max() ?? day,
                                        commentCount: group.count, lastActivity: times.max()))
            let ids = Set(group.map(\.id))
            for i in comments.indices where ids.contains(comments[i].id) { comments[i].sessionId = id }
            for ci in customers.indices {
                for ii in customers[ci].items.indices
                where customers[ci].items[ii].groupId == nil && cal.isDate(customers[ci].items[ii].ts, inSameDayAs: day) {
                    customers[ci].items[ii].sessionId = id
                    customers[ci].items[ii].groupId = id
                }
            }
        }
        sessions.sort { $0.start > $1.start }
        save()
    }

    /// Bình luận về dồn dập nên gom ghi file; thao tác của người dùng thì ghi ngay.
    private func scheduleSave() {
        saveWork?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.save() }
        saveWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 1, execute: work)
    }

    func save() {
        saveWork?.cancel()
        saveWork = nil
        guard persistEnabled, !saveBlocked, let url = fileURL else { return }
        let snap = Snapshot(comments: comments, customers: customers, sessions: sessions, accounts: accounts,
                            activeAccountId: activeAccountId, keywords: keywords, sync: syncState)
        do {
            let data = try JSONEncoder().encode(snap)
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try data.write(to: url, options: .atomic)
            saveFailed = false
        } catch {
            // Báo một lần cho mỗi đợt lỗi, bình luận về liên tục cũng không hiện lại.
            if !saveFailed { storageWarning = "Không lưu được dữ liệu. Bạn hãy kiểm tra dung lượng trống của máy." }
            saveFailed = true
        }
    }
}
