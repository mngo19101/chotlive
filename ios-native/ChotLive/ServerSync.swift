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

/// Quyền dùng của tài khoản do server tính. Chỉ để hiển thị: việc chặn theo dõi live nằm ở server.
struct AccountAccess: Equatable {
    var status: String     // admin | plan | trial | expired
    var canFollowLive: Bool
    var endsAt: Date?
    var code: String       // TRIAL_EXPIRED | PLAN_EXPIRED khi đã hết hạn
    var message: String

    init?(_ dict: [String: Any]) {
        guard let status = dict["status"] as? String else { return nil }
        self.status = status
        canFollowLive = (dict["canFollowLive"] as? Bool) ?? true
        endsAt = (dict["endsAt"] as? Double).map { Date(timeIntervalSince1970: $0 / 1000) }
        code = (dict["code"] as? String) ?? ""
        message = (dict["message"] as? String) ?? ""
    }

    init(status: String, canFollowLive: Bool, endsAt: Date?, code: String = "", message: String = "") {
        self.status = status
        self.canFollowLive = canFollowLive
        self.endsAt = endsAt
        self.code = code
        self.message = message
    }

    /// Thời gian dùng thử còn lại, đếm tới từng giây như trên web: "2 ngày 13 giờ 04 phút 09 giây".
    /// Bỏ các phần đầu bằng 0, nên lúc gần hết chỉ còn "04 phút 09 giây".
    static func countdownText(until end: Date?, now: Date) -> String {
        let total = Int(max(0, (end ?? now).timeIntervalSince(now)).rounded(.up))
        let days = total / 86400, hours = total % 86400 / 3600, minutes = total % 3600 / 60, seconds = total % 60
        let pad = { (n: Int) in n < 10 ? "0\(n)" : "\(n)" }
        var parts: [String] = []
        if days > 0 { parts.append("\(days) ngày") }
        if total >= 3600 { parts.append("\(hours) giờ") }
        if total >= 60 { parts.append("\(pad(minutes)) phút") }
        parts.append("\(pad(seconds)) giây")
        return parts.joined(separator: " ")
    }

    static func remainingText(until end: Date?, now: Date) -> String {
        let hours = Int(max(0, (end ?? now).timeIntervalSince(now)) / 3600)
        if hours < 1 { return "dưới 1 giờ" }
        if hours < 24 { return "\(hours) giờ" }
        return hours % 24 == 0 ? "\(hours / 24) ngày" : "\(hours / 24) ngày \(hours % 24) giờ"
    }
}

struct CommentsPage: Decodable {
    var comments: [LiveComment]
    var hasMore: Bool
}

/// Vị trí để lấy trang bình luận cũ hơn. Nhiều bình luận có thể trùng thời gian nên phải kèm id.
struct CommentCursor: Equatable {
    var ms: Int64
    var id: String

    /// Bình luận cuối cùng theo thứ tự của server: thời gian trước, id sau.
    static func oldest(in comments: [LiveComment]) -> CommentCursor? {
        comments
            .map { CommentCursor(ms: Int64(($0.ts.timeIntervalSince1970 * 1000).rounded()), id: $0.id) }
            .min { ($0.ms, $0.id) < ($1.ms, $1.id) }
    }

    var queryItems: [URLQueryItem] {
        [URLQueryItem(name: "before", value: String(ms)), URLQueryItem(name: "beforeId", value: id)]
    }
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

    /// Bình luận của một phiên, cũ trước: phần lưu trên máy cộng với phần cũ vừa tải từ server.
    /// Phần tải về chỉ để xem, không ghi vào máy, nên không đẩy bình luận mới ra khỏi giới hạn lưu.
    func sessionComments(_ id: String, older: [LiveComment]) -> [LiveComment] {
        let local = comments(session: id)
        let localIds = Set(local.map(\.id))
        var extra = older.filter { !localIds.contains($0.id) }
        if !extra.isEmpty {
            // Đã lưu thành đơn ở đâu đó thì hiện đúng như bình luận đã chốt, kể cả vừa in xong trên máy này.
            let ordered = Set(customers.flatMap(\.items).map { $0.commentId ?? $0.id })
            for i in extra.indices where ordered.contains(extra[i].id) { extra[i].printed = true }
        }
        return (local + extra).sorted { $0.ts < $1.ts }
    }
}
