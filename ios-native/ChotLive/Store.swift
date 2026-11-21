import Foundation

/// Lưu bình luận, khách hàng, phiên live... trên máy và đồng bộ với server (xem ServerSync.swift).
/// Mỗi tài khoản có một file riêng: Documents/accounts/<mã tài khoản>/chotlive.json.
final class Store: ObservableObject {
    @Published var comments: [LiveComment] = []
    @Published var customers: [Customer] = [] {
        didSet {
            ordersCache = nil
            readyGroupsCache = nil
        }
    }
    @Published var sessions: [LiveSession] = []
    @Published var accounts: [TikTokAccount] = []
    @Published var activeAccountId: String?
    @Published var keywords: [String] = Store.defaultKeywords {
        didSet { rebuildKeywordCache() }
    }
    static let autoClosingKey = "autoClosing"
    /// Tôi › Từ khoá chốt đơn › "Tự nhận bình luận chốt". Tắt thì chỉ bình luận đã in mới tính là chốt. Lưu trên máy này.
    @Published var autoClosing: Bool = UserDefaults.standard.object(forKey: Store.autoClosingKey) as? Bool ?? false {
        didSet {
            UserDefaults.standard.set(autoClosing, forKey: Store.autoClosingKey)
            closingCache.removeAll(keepingCapacity: true)
        }
    }
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
    private var ordersCache: [Order]?
    private var readyGroupsCache: (day: Date, groups: [Vtp.Group])?
    private var normalizedKeywords: [String] = Store.defaultKeywords.map { PriceParser.stripAccents($0.lowercased()) }
    private var closingCache: [String: Bool] = [:]
    private let writeQueue = DispatchQueue(label: "chotlive.store.write", qos: .utility)
    private var saveGeneration: UInt64 = 0

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
        closeOpenSession(persist: false)
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
        saveGeneration &+= 1
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

    private func rebuildKeywordCache() {
        normalizedKeywords = keywords.filter { !$0.isEmpty }.map { PriceParser.stripAccents($0.lowercased()) }
        closingCache.removeAll(keepingCapacity: true)
    }

    /// Bình luận chốt đơn: đã chốt tay, có từ khoá chốt, hoặc chỉ ghi mã. "Mã 130 giá sao" chỉ là hỏi giá.
    func isClosingComment(_ c: LiveComment) -> Bool {
        if c.printed { return true }
        if !autoClosing { return false }
        if let hit = closingCache[c.text] { return hit }
        let text = PriceParser.stripAccents(c.text.lowercased())
        let matched = normalizedKeywords.contains(where: { text.contains($0) }) || PriceParser.isOnlyCodes(c.text)
        if closingCache.count >= 10_000 { closingCache.removeAll(keepingCapacity: true) }
        closingCache[c.text] = matched
        return matched
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
        saveAsync()
    }

    private func closeOpenSession(persist: Bool = true) {
        guard sessions.contains(where: \.isLive) else { return }
        let now = Clock.now
        var next = sessions
        for i in next.indices where next[i].isLive {
            // App bị tắt giữa phiên: lấy mốc hoạt động cuối thay vì lúc mở lại app.
            let last = next[i].lastActivity ?? next[i].start
            next[i].end = now.timeIntervalSince(last) > 600 ? last : now
        }
        sessions = next
        if persist { saveAsync() }
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
        var items: [OrderItem]
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
            // Đơn của phiên này đã gửi đi thì món mới phải sang đơn khác (xem `openGroupId`).
            let group = openGroupId(of: customers[idx], sessionId: c.sessionId)
            if group != c.sessionId { for i in items.indices { items[i].groupId = group } }
            customers[idx].items.append(contentsOf: items)
            clearManualCod(customerIndex: idx)
            if customers[idx].userId.isEmpty { customers[idx].userId = c.userId }
            if !c.nickname.isEmpty { customers[idx].nickname = c.nickname }
        } else {
            customers.append(Customer(id: key, uniqueId: c.uniqueId, userId: c.userId, nickname: c.nickname, items: items))
        }
        touchCustomer(customers.first { $0.items.contains { $0.commentId == c.id || $0.id == c.id } }?.id ?? key)
        saveAsync()
        return items
    }

    /// Nhóm (đơn) nhận món mới của một phiên live. Bình thường là đơn của chính phiên đó. Đơn ấy đã gửi đi
    /// (đang giao, đã giao, đã xuất, đã có vận đơn) thì gói hàng và tiền thu hộ đã chốt: món chốt thêm
    /// vào đơn còn mở khác của phiên, chưa có thì mở đơn mới, để món đó vẫn được duyệt, gửi và thu tiền.
    private func openGroupId(of customer: Customer, sessionId: String?) -> String? {
        guard let sessionId else { return nil }
        let mine = orders(of: customer).filter { o in o.items.contains { $0.sessionId == sessionId && $0.groupId != nil } }
        guard !mine.isEmpty else { return sessionId }
        // Đơn đang chờ rõ kết quả tạo vận đơn cũng coi như đã gửi: Viettel Post có thể đã tạo với số thu hộ cũ.
        let open = mine.filter { Vtp.state($0).isPending && ($0.ship?.vtpCode ?? "").isEmpty && !VtpTrack.unknown($0) }
        if open.contains(where: { $0.key == sessionId }) { return sessionId }
        if let group = open.first?.items.compactMap(\.groupId).first { return group }
        return sessionId + "~" + UUID().uuidString.prefix(8).lowercased()
    }

    /// Tên khách vừa bị bỏ số thu hộ nhập tay vì đơn đổi món; màn hình đọc một lần để báo.
    private var codResetName: String?

    func takeCodResetNotice() -> String? {
        defer { codResetName = nil }
        return codResetName.map { "Đơn của \($0) vừa đổi món: đã bỏ tiền thu hộ nhập tay, tính lại theo hàng mới." }
    }

    /// Tiền thu hộ nhập tay là cho gói hàng cũ. Đơn chưa gửi của khách đổi món (thêm, sửa giá, bớt) thì bỏ số đó
    /// ở mọi đơn chưa gửi của khách, để thu hộ tính lại theo hàng mới, giống web.
    private func clearManualCod(customerIndex idx: Int) {
        let pending = Set(orders(of: customers[idx]).filter { Vtp.state($0).isPending }.flatMap { $0.items.map(\.id) })
        var cleared = false
        for ii in customers[idx].items.indices
        where pending.contains(customers[idx].items[ii].id) && customers[idx].items[ii].ship?.codOverride != nil {
            customers[idx].items[ii].ship?.codOverride = nil
            cleared = true
        }
        if cleared { codResetName = customers[idx].displayName }
    }

    func deleteItem(customerId: String, itemId: String) {
        guard let idx = customers.firstIndex(where: { $0.id == customerId }) else { return }
        customers[idx].items.removeAll { $0.id == itemId }
        clearManualCod(customerIndex: idx)
        if customers[idx].items.isEmpty { customers.remove(at: idx) }
        touchCustomer(customerId, deletedItems: [itemId])
        saveAsync()
    }

    /// Khách của bình luận, cùng cách nhận khách như `saveToCustomer`.
    func customer(of c: LiveComment) -> Customer? {
        let key = Self.key(uniqueId: c.uniqueId, userId: c.userId)
        return customers.first { $0.id == key || (!c.userId.isEmpty && $0.userId == c.userId) }
    }

    /// Các món đã bấm in cho khách của bình luận này trong phiên, mới nhất trước.
    func printedItems(of c: LiveComment, sessionId: String) -> [OrderItem] {
        guard let owner = customer(of: c) else { return [] }
        return owner.items.filter { $0.sessionId == sessionId }.sorted { $0.ts > $1.ts }
    }

    /// Bản lưu để hoàn tác khi bỏ một món in nhầm.
    struct RemovedItem: Equatable {
        var customer: Customer
        var item: OrderItem
        var index: Int
    }

    /// Bỏ một món in nhầm (khách nhường cho người khác). Trả về bản lưu để hoàn tác.
    @discardableResult
    func removePrintedItem(customerId: String, itemId: String) -> RemovedItem? {
        guard let idx = customers.firstIndex(where: { $0.id == customerId }),
              let ii = customers[idx].items.firstIndex(where: { $0.id == itemId }) else { return nil }
        let removed = RemovedItem(customer: customers[idx], item: customers[idx].items[ii], index: ii)
        deleteItem(customerId: customerId, itemId: itemId)
        return removed
    }

    /// Trả lại món vừa bỏ, đúng chỗ cũ trong đơn của khách.
    func restore(_ r: RemovedItem) {
        // Còn nằm trong danh sách xoá chưa gửi thì server sẽ bỏ món này đi, nên rút ra trước.
        syncState.deletedItems.remove(r.item.id)
        if let idx = customers.firstIndex(where: { $0.id == r.customer.id }) {
            guard !customers[idx].items.contains(where: { $0.id == r.item.id }) else { return }
            customers[idx].items.insert(r.item, at: min(r.index, customers[idx].items.count))
        } else {
            var c = r.customer
            c.items = [r.item]
            customers.append(c)
        }
        touchCustomer(r.customer.id)
        saveAsync()
    }

    func deleteOrder(_ o: Order) {
        guard let idx = customers.firstIndex(where: { $0.id == o.customer.id }) else { return }
        let ids = Set(o.items.map(\.id))
        customers[idx].items.removeAll { ids.contains($0.id) }
        if customers[idx].items.isEmpty { customers.remove(at: idx) }
        touchCustomer(o.customer.id, deletedItems: ids)
        saveAsync()
    }

    /// Thay toàn bộ sản phẩm của đơn bằng danh sách đã sửa.
    func updateOrder(_ o: Order, items edited: [OrderItem]) {
        guard let idx = customers.firstIndex(where: { $0.id == o.customer.id }) else { return }
        let ids = Set(o.items.map(\.id))
        customers[idx].items.removeAll { ids.contains($0.id) }
        customers[idx].items.append(contentsOf: edited)
        if edited.reduce(0, { $0 + $1.lineTotal }) != o.total { clearManualCod(customerIndex: idx) }
        if customers[idx].items.isEmpty { customers.remove(at: idx) }
        touchCustomer(o.customer.id, deletedItems: ids.subtracting(edited.map(\.id)))
        saveAsync()
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
        saveAsync()
        return cid + "|" + group
    }

    func setAddress(_ a: DeliveryAddress, customerId: String) {
        guard let idx = customers.firstIndex(where: { $0.id == customerId }) else { return }
        customers[idx].address = a
        touchCustomer(customerId)
        saveAsync()
    }

    func markPrinted(itemId: String) {
        var next = customers
        var touched: [String] = []
        for ci in next.indices {
            if let ii = next[ci].items.firstIndex(where: { $0.id == itemId }) {
                next[ci].items[ii].printed = true
                touched.append(next[ci].id)
            }
        }
        guard !touched.isEmpty else { return }
        customers = next
        touched.forEach { touchCustomer($0) }
        saveAsync()
    }

    /// Giao hàng: chưa giao → đang giao → đã giao → (bấm lại) về chưa giao.
    func advanceDelivery(_ o: Order) {
        let ids = Set(o.items.map(\.id))
        let status = o.status
        var next = customers
        var changed = false
        for ci in next.indices where next[ci].id == o.customer.id {
            for ii in next[ci].items.indices where ids.contains(next[ci].items[ii].id) {
                changed = true
                switch status {
                case .new, .printed:
                    next[ci].items[ii].shipping = true
                    next[ci].items[ii].delivered = false
                case .shipping:
                    next[ci].items[ii].shipping = false
                    next[ci].items[ii].delivered = true
                case .delivered:
                    next[ci].items[ii].shipping = false
                    next[ci].items[ii].delivered = false
                }
            }
        }
        if changed { customers = next }
        touchCustomer(o.customer.id)
        saveAsync()
    }

    // MARK: - Duyệt đơn & Viettel Post

    /// Ghi thông tin giao vào mọi món của từng đơn (id đơn → ship). `shipping`: true chuyển Đang giao,
    /// false đưa về chưa giao, nil giữ nguyên. Server đọc `ship` để web thấy đúng trạng thái.
    func setShip(_ changes: [String: ShipInfo], shipping: Bool? = nil) {
        var orderLookup: [String: (customerId: String, itemIds: Set<String>)] = [:]
        for orderId in changes.keys {
            if let o = order(id: orderId) {
                orderLookup[orderId] = (o.customer.id, Set(o.items.map(\.id)))
            }
        }
        guard !orderLookup.isEmpty else { return }
        var next = customers
        var touched: Set<String> = []
        for (orderId, ship) in changes {
            guard let info = orderLookup[orderId],
                  let ci = next.firstIndex(where: { $0.id == info.customerId }) else { continue }
            for ii in next[ci].items.indices where info.itemIds.contains(next[ci].items[ii].id) {
                next[ci].items[ii].ship = ship
                if let shipping {
                    next[ci].items[ii].shipping = shipping
                    next[ci].items[ii].delivered = false
                }
            }
            touched.insert(info.customerId)
        }
        guard !touched.isEmpty else { return }
        customers = next
        touched.forEach { touchCustomer($0) }
        saveAsync()
    }

    /// Bảng Duyệt đơn: chuyển các đơn được tick sang Chờ gửi (`ready`) hoặc Gom sau (`hold`).
    /// Tiền cọc ghi ở đơn đầu tiên, các cài đặt khác ghi ở mọi đơn, giống web.
    /// `dropped`: đơn đã duyệt nhưng bị bỏ tick, đưa về chưa duyệt để không còn gộp chung vận đơn.
    func approve(_ orderIds: [String], state: ShipState, base: ShipInfo, dropped: [String] = []) {
        var changes: [String: ShipInfo] = [:]
        for id in dropped {
            guard var s = order(id: id)?.ship else { continue }
            s.state = ShipState.ask.rawValue
            s.deposit = 0
            s.codOverride = nil
            changes[id] = s
        }
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
                // Giữ mã nháp Viettel Post: sửa đơn xong vẫn phải biết nháp cũ để xoá hoặc báo "nháp cũ".
                s.draftCode = old.draftCode
                s.draftAt = old.draftAt
                s.draftHash = old.draftHash
                s.draftAccount = old.draftAccount
                s.draftError = old.draftError
                s.draftErrorAt = old.draftErrorAt
            }
            s.exportedAt = nil
            s.batchId = nil
            changes[id] = s
        }
        setShip(changes)
    }

    // MARK: - Nháp Viettel Post (đẩy từ máy)

    /// Đẩy nháp thành công: mọi đơn của khách trong lần đẩy mang cùng mã nháp và băm nội dung đã gửi.
    func markDraft(_ orders: [Order], code: String, hash: String, account: String, at now: Date = Clock.now) {
        editDraft(orders) { s in
            s.draftCode = code
            s.draftHash = hash
            s.draftAccount = account
            s.draftAt = (now.timeIntervalSince1970 * 1000).rounded()
            s.draftError = nil
            s.draftErrorAt = nil
        }
    }

    /// Đẩy nháp lỗi: ghi lý do, KHÔNG đụng mã nháp cũ (nếu có) để còn xoá được.
    func markDraftError(_ orders: [Order], error: String, at now: Date = Clock.now) {
        editDraft(orders) { s in
            s.draftError = String(error.prefix(200))
            s.draftErrorAt = (now.timeIntervalSince1970 * 1000).rounded()
        }
    }

    /// Bỏ nhãn nháp (đã xoá trên Viettel Post, hoặc người dùng tự xoá trên web): đơn về "Chưa đẩy".
    func clearDraft(_ orders: [Order]) {
        editDraft(orders) { s in
            s.draftCode = nil
            s.draftHash = nil
            s.draftAccount = nil
            s.draftAt = nil
            s.draftError = nil
            s.draftErrorAt = nil
        }
    }

    private func editDraft(_ orders: [Order], _ edit: (inout ShipInfo) -> Void) {
        var changes: [String: ShipInfo] = [:]
        for o in orders {
            var s = order(id: o.id)?.ship ?? o.ship ?? ShipInfo()
            edit(&s)
            changes[o.id] = s
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
        var next = customers
        for ii in next[ci].items.indices where ids.contains(next[ci].items[ii].id) {
            next[ci].items[ii].delivered = delivered
            next[ci].items[ii].shipping = !delivered
        }
        customers = next
        touchCustomer(o.customer.id)
        saveAsync()
    }

    /// Mọi đơn, mới nhất trước.
    func allOrders() -> [Order] {
        if let cached = ordersCache { return cached }
        let built = customers.flatMap(orders(of:)).sorted { $0.lastTs > $1.lastTs }
        ordersCache = built
        return built
    }

    /// Các khách có đơn đã duyệt Chờ gửi (`ready`), cache theo ngày hiện tại cho tới khi `customers` đổi.
    func readyGroups() -> [Vtp.Group] {
        let today = Calendar.current.startOfDay(for: Clock.now)
        if Clock.fixed == nil, let cached = readyGroupsCache, cached.day == today {
            return cached.groups
        }
        let built = Vtp.readyGroups(allOrders())
        if Clock.fixed == nil { readyGroupsCache = (today, built) }
        return built
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

    /// Doanh thu từng ngày trong `days` ngày kết thúc ở `today`, từ cũ tới mới (duyệt một lượt).
    func dailyRevenues(days: Int, through today: Date) -> [(Date, Int)] {
        guard days > 0 else { return [] }
        let cal = Calendar.current
        let targetDays = (0..<days).reversed().map { off in
            cal.date(byAdding: .day, value: -off, to: today) ?? today
        }
        let earliest = cal.startOfDay(for: targetDays[0])
        let latest = cal.date(byAdding: .day, value: 1, to: cal.startOfDay(for: today)) ?? today
        var totals: [Date: Int] = [:]
        for c in customers {
            for it in c.items where it.ts >= earliest && it.ts < latest {
                totals[cal.startOfDay(for: it.ts), default: 0] += it.lineTotal
            }
        }
        return targetDays.map { d in (d, totals[cal.startOfDay(for: d)] ?? 0) }
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
        saveAsync()
    }

    func selectAccount(_ id: String) {
        activeAccountId = id
        touchAccounts()
        saveAsync()
    }

    func removeAccount(_ id: String) {
        accounts.removeAll { $0.id == id }
        if activeAccountId == id { activeAccountId = accounts.first?.id }
        syncState.deletedAccounts.insert(id)
        touchAccounts()
        saveAsync()
    }

    func setKeywords(_ list: [String]) {
        keywords = list
        saveAsync()
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

    /// Server từ chối gói (gửi quá nhanh, dữ liệu quá lớn): thôi chờ xác nhận, thay đổi còn nguyên để gửi lại sau.
    /// Trả về false nếu lời từ chối là của một gói cũ, không phải gói đang chờ.
    @discardableResult
    func syncRejected(id: Int?) -> Bool {
        guard let sent = sending, id == nil || sent.id == id else { return false }
        syncInterrupted()
        return true
    }

    func saveSoon() { scheduleSave() }

    // MARK: - Lưu trữ

    static func key(uniqueId: String, userId: String) -> String {
        let u = uniqueId.lowercased()
        return u.isEmpty ? userId : u
    }

    private func load() {
        guard let url = fileURL else { return }
        writeQueue.sync {}
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
        ordersCache = nil
        readyGroupsCache = nil
        rebuildKeywordCache()
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

    /// Bình luận về dồn dập nên gom ghi file; thao tác của người dùng cũng ghi ở hàng đợi nền.
    private func scheduleSave() {
        saveWork?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.saveAsync() }
        saveWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 1, execute: work)
    }

    private func makeSnapshotForDisk() -> (Snapshot, URL)? {
        saveWork?.cancel()
        saveWork = nil
        guard persistEnabled, !saveBlocked, let url = fileURL else { return nil }
        let snap = Snapshot(comments: comments, customers: customers, sessions: sessions, accounts: accounts,
                            activeAccountId: activeAccountId, keywords: keywords, sync: syncState)
        return (snap, url)
    }

    private static func write(_ snap: Snapshot, to url: URL) -> Bool {
        do {
            let data = try JSONEncoder().encode(snap)
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try data.write(to: url, options: .atomic)
            return true
        } catch {
            return false
        }
    }

    private func reportSaveResult(_ ok: Bool) {
        if ok {
            saveFailed = false
        } else {
            // Báo một lần cho mỗi đợt lỗi, bình luận về liên tục cũng không hiện lại.
            if !saveFailed { storageWarning = "Không lưu được dữ liệu. Bạn hãy kiểm tra dung lượng trống của máy." }
            saveFailed = true
        }
    }

    private func saveAsync() {
        guard let (snap, url) = makeSnapshotForDisk() else { return }
        saveGeneration &+= 1
        let gen = saveGeneration
        writeQueue.async { [weak self] in
            let ok = Self.write(snap, to: url)
            DispatchQueue.main.async {
                guard let self, self.saveGeneration == gen else { return }
                self.reportSaveResult(ok)
            }
        }
    }

    func save() {
        guard let (snap, url) = makeSnapshotForDisk() else { return }
        saveGeneration &+= 1
        let ok = writeQueue.sync { Self.write(snap, to: url) }
        reportSaveResult(ok)
    }
}
