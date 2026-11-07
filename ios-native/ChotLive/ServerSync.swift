import Foundation

/// Định dạng dữ liệu trao đổi với server khi đồng bộ (mốc thời gian tính bằng mili giây).
enum ServerSync {
    static var decoder: JSONDecoder {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .millisecondsSince1970
        return d
    }

    static var encoder: JSONEncoder {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .millisecondsSince1970
        return e
    }
}

/// Toàn bộ dữ liệu của tài khoản do server gửi xuống.
struct ServerSnapshot: Decodable, Equatable {
    var customers: [Customer] = []
    var sessions: [LiveSession] = []
    var accounts: [TikTokAccount] = []
    var activeAccountId: String?
    var printedCommentIds: [String]?
}

/// Thay đổi trên máy gửi lên server: chỉ gồm những gì vừa đổi.
struct SyncUpdate: Encodable {
    var type = "native_update"
    var id: Int
    var customers: [Customer]
    var deletedItemIds: [String]
    var accounts: [TikTokAccount]?
    var deletedAccountIds: [String]?
    var activeAccountId: String?
    /// Dữ liệu có sẵn trên máy từ trước khi đồng bộ, chỉ gửi ở lần đầu.
    var sessions: [LiveSession]?
    var comments: [LiveComment]?
}

/// Những thay đổi chưa được server xác nhận. Lưu cùng dữ liệu để tắt app giữa chừng vẫn gửi được sau.
struct SyncState: Codable, Equatable {
    var syncedOnce = false
    var dirtyCustomers: Set<String> = []
    var deletedItems: Set<String> = []
    var deletedAccounts: Set<String> = []
    var accountsDirty = false

    var hasChanges: Bool {
        !syncedOnce || !dirtyCustomers.isEmpty || !deletedItems.isEmpty || !deletedAccounts.isEmpty || accountsDirty
    }
}

/// Một live server đang theo dõi.
struct LiveInfo: Identifiable, Equatable {
    var username: String
    var state: String      // connecting | connected | reconnecting
    var message: String
    var viewers: Int
    var sessionId: String

    var id: String { username.lowercased() }

    init?(_ dict: [String: Any]) {
        guard let username = dict["username"] as? String, !username.isEmpty else { return nil }
        self.username = username
        state = (dict["state"] as? String) ?? "connecting"
        message = (dict["message"] as? String) ?? ""
        viewers = (dict["viewers"] as? Int) ?? Int((dict["viewers"] as? Double) ?? 0)
        sessionId = (dict["sessionId"] as? String) ?? ""
    }

    init(username: String, state: String, message: String = "", viewers: Int = 0, sessionId: String = "") {
        self.username = username
        self.state = state
        self.message = message
        self.viewers = viewers
        self.sessionId = sessionId
    }
}

struct CommentsPage: Decodable {
    var comments: [LiveComment]
    var hasMore: Bool
}

// MARK: - Đồng bộ trong Store

extension Store {
    /// Nhận dữ liệu mới nhất từ server. Những khách còn thay đổi chưa gửi xong thì giữ bản trên máy.
    func applyServer(_ snap: ServerSnapshot) {
        var sync = syncState
        let localIds = Set(customers.map(\.id))
        let protected = sync.syncedOnce ? sync.dirtyCustomers : sync.dirtyCustomers.union(localIds)

        var nextCustomers: [Customer] = []
        for var c in snap.customers where !protected.contains(c.id) {
            let hadItems = !c.items.isEmpty
            c.items.removeAll { sync.deletedItems.contains($0.id) }
            if hadItems && c.items.isEmpty { continue }
            nextCustomers.append(c)
        }
        nextCustomers.append(contentsOf: customers.filter { protected.contains($0.id) })
        if nextCustomers != customers { customers = nextCustomers }

        // Phiên: server là bản chuẩn. Phiên chỉ có trên máy thì giữ lại; nếu còn mở thì đã cũ, đóng lại.
        let serverIds = Set(snap.sessions.map(\.id))
        var nextSessions = snap.sessions
        for var s in sessions where !serverIds.contains(s.id) {
            if s.isLive { s.end = s.lastActivity ?? s.start }
            nextSessions.append(s)
        }
        nextSessions.sort { $0.start > $1.start }
        if nextSessions != sessions { sessions = nextSessions }

        if sync.syncedOnce && !sync.accountsDirty {
            if snap.accounts != accounts { accounts = snap.accounts }
            let active = snap.activeAccountId ?? accounts.first?.id
            if active != activeAccountId { activeAccountId = active }
        } else {
            let mine = Set(accounts.map(\.id))
            let added = snap.accounts.filter { !mine.contains($0.id) && !sync.deletedAccounts.contains($0.id) }
            if !added.isEmpty { accounts.append(contentsOf: added) }
            if activeAccountId == nil {
                let wanted = snap.activeAccountId.flatMap { id in accounts.contains { $0.id == id } ? id : nil }
                activeAccountId = wanted ?? accounts.first?.id
            }
        }

        if let printed = snap.printedCommentIds, !printed.isEmpty {
            let ids = Set(printed)
            for i in comments.indices where !comments[i].printed && ids.contains(comments[i].id) {
                comments[i].printed = true
            }
        }
        // Khách đã xoá hết món trên máy thì không còn gì để bảo vệ nữa.
        sync.dirtyCustomers = sync.dirtyCustomers.filter { id in
            customers.contains { $0.id == id } || inFlightCustomerIds.contains(id)
        }
        syncState = sync
        saveSoon()
    }

    /// Gói các thay đổi chưa gửi. Mỗi lúc chỉ gửi một gói; nil nếu không có gì hoặc đang chờ xác nhận.
    func makeSyncUpdate() -> SyncUpdate? {
        guard !isAwaitingAck, syncState.hasChanges else { return nil }
        let initial = !syncState.syncedOnce
        if initial {
            syncState.dirtyCustomers.formUnion(customers.map(\.id))
            syncState.accountsDirty = syncState.accountsDirty || !accounts.isEmpty
        }
        let ids = syncState.dirtyCustomers
        let update = SyncUpdate(
            id: beginSending(),
            customers: customers.filter { ids.contains($0.id) },
            deletedItemIds: Array(syncState.deletedItems),
            accounts: syncState.accountsDirty ? accounts : nil,
            deletedAccountIds: syncState.deletedAccounts.isEmpty ? nil : Array(syncState.deletedAccounts),
            activeAccountId: syncState.accountsDirty ? activeAccountId : nil,
            sessions: initial ? sessions : nil,
            comments: initial ? comments : nil
        )
        return update
    }

    /// Lần đầu trên máy mới thì chưa có mốc: lấy phần mới nhất.
    var latestCommentDate: Date? { comments.map(\.ts).max() }
}
