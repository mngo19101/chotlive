import Foundation

/// Đồng hồ của app. Bản demo chụp màn hình cố định thời gian để so với mẫu thiết kế.
enum Clock {
    static var fixed: Date?
    static var now: Date { fixed ?? Date() }
    static func isToday(_ d: Date) -> Bool { Calendar.current.isDate(d, inSameDayAs: now) }
    static func isYesterday(_ d: Date) -> Bool {
        guard let y = Calendar.current.date(byAdding: .day, value: -1, to: now) else { return false }
        return Calendar.current.isDate(d, inSameDayAs: y)
    }
}

struct LiveComment: Identifiable, Codable, Equatable {
    var id: String
    var uniqueId: String
    var userId: String
    var nickname: String
    var text: String
    var ts: Date
    var price: Int
    var printed: Bool = false
    var sessionId: String? = nil
}

/// Một phiên live đã ghi lại (từ lúc kết nối tới lúc ngắt).
struct LiveSession: Identifiable, Codable, Equatable {
    var id: String
    var tiktok: String
    var start: Date
    var end: Date?
    var commentCount: Int = 0
    var lastActivity: Date?

    var isLive: Bool { end == nil }

    var title: String {
        switch Calendar.current.component(.hour, from: start) {
        case 5..<11: return "Phiên sáng"
        case 11..<14: return "Phiên trưa"
        case 14..<18: return "Phiên chiều"
        default: return "Phiên tối"
        }
    }

    var duration: String {
        let mins = max(Int((end ?? Clock.now).timeIntervalSince(start) / 60), 0)
        return mins >= 60 ? "\(mins / 60)g \(mins % 60)p" : "\(mins)p"
    }
}

struct OrderItem: Identifiable, Codable, Equatable {
    var id: String          // = id bình luận
    var comment: String
    var price: Int
    var ts: Date
    var printed: Bool = false
    var delivered: Bool = false
    var shipping: Bool = false
    var qty: Int = 1
    /// Phiên live mà món này được chốt.
    var sessionId: String? = nil
    /// Các món cùng groupId của 1 khách gộp thành 1 đơn. nil = gộp theo ngày (dữ liệu cũ).
    var groupId: String? = nil

    var lineTotal: Int { price * max(qty, 1) }

    init(id: String, comment: String, price: Int, ts: Date, printed: Bool = false, delivered: Bool = false,
         shipping: Bool = false, qty: Int = 1, sessionId: String? = nil, groupId: String? = nil) {
        self.id = id; self.comment = comment; self.price = price; self.ts = ts
        self.printed = printed; self.delivered = delivered; self.shipping = shipping
        self.qty = qty; self.sessionId = sessionId; self.groupId = groupId
    }

    // Tương thích dữ liệu cũ (chưa có các trường mới)
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        comment = try c.decode(String.self, forKey: .comment)
        price = try c.decode(Int.self, forKey: .price)
        ts = try c.decode(Date.self, forKey: .ts)
        printed = try c.decodeIfPresent(Bool.self, forKey: .printed) ?? false
        delivered = try c.decodeIfPresent(Bool.self, forKey: .delivered) ?? false
        shipping = try c.decodeIfPresent(Bool.self, forKey: .shipping) ?? false
        qty = try c.decodeIfPresent(Int.self, forKey: .qty) ?? 1
        sessionId = try c.decodeIfPresent(String.self, forKey: .sessionId)
        groupId = try c.decodeIfPresent(String.self, forKey: .groupId)
    }
}

enum OrderStatus: Equatable {
    case new, printed, shipping, delivered

    var label: String {
        switch self {
        case .new: return "Đơn mới"
        case .printed: return "Đã in"
        case .shipping: return "Đang giao"
        case .delivered: return "Đã giao"
        }
    }
}

/// Đơn hàng = các món của 1 khách trong 1 phiên live (hoặc 1 đơn tạo tay).
struct Order: Identifiable {
    var key: String
    var customer: Customer
    var items: [OrderItem]

    var id: String { customer.id + "|" + key }
    var total: Int { items.reduce(0) { $0 + $1.lineTotal } }
    var productCount: Int { items.reduce(0) { $0 + max($1.qty, 1) } }
    var lastTs: Date { items.map(\.ts).max() ?? .distantPast }
    var firstTs: Date { items.map(\.ts).min() ?? .distantPast }
    var isPrinted: Bool { !items.isEmpty && items.allSatisfy(\.printed) }

    var status: OrderStatus {
        guard !items.isEmpty else { return .new }
        if items.allSatisfy(\.delivered) { return .delivered }
        if items.allSatisfy({ $0.shipping || $0.delivered }) { return .shipping }
        if items.allSatisfy(\.printed) { return .printed }
        return .new
    }
}

struct DeliveryAddress: Codable, Equatable {
    var receiver = ""
    var phone = ""
    var street = ""
    var region = ""
    var note = ""
}

struct Customer: Identifiable, Codable, Equatable {
    var id: String          // uniqueId viết thường (hoặc userId)
    var uniqueId: String
    var userId: String
    var nickname: String
    var items: [OrderItem]
    var address: DeliveryAddress? = nil

    var total: Int { items.reduce(0) { $0 + $1.lineTotal } }
    var lastTs: Date { items.map(\.ts).max() ?? .distantPast }
    var firstTs: Date { items.map(\.ts).min() ?? .distantPast }
    var itemsToday: [OrderItem] { items.filter { Clock.isToday($0.ts) } }
    var isNewToday: Bool { !items.isEmpty && Clock.isToday(firstTs) }
    var isBigSpender: Bool { total >= Customer.bigSpender }
    var initials: String { initialsOf(nickname) }

    /// Mức chi tiêu được gắn nhãn "Mua nhiều".
    static let bigSpender = 3_000_000
}

struct TikTokAccount: Identifiable, Codable, Equatable {
    var id: String          // uniqueId viết thường
    var uniqueId: String
    var displayName: String

    var initials: String { initialsOf(displayName) }
}

func initialsOf(_ name: String) -> String {
    let words = name.split(separator: " ")
    if words.count >= 2 {
        return String(words.prefix(2).compactMap(\.first)).uppercased()
    }
    let s = String(name.prefix(2)).uppercased()
    return s.isEmpty ? "?" : s
}

/// Khoảng thời gian đang xem (dùng chung cho Bình luận và Đơn hàng).
struct DateFilter: Equatable {
    enum Preset: Equatable { case today, yesterday, last7, last30, thisMonth, lastMonth, custom }

    var preset: Preset = .today
    var startDay: Date
    var endDay: Date
    var fromMinute = 0
    var toMinute = 1439

    private static var cal: Calendar { Calendar.current }

    static func make(_ preset: Preset, now: Date = Clock.now) -> DateFilter {
        let cal = Self.cal
        let today = cal.startOfDay(for: now)
        func day(_ off: Int) -> Date { cal.date(byAdding: .day, value: off, to: today) ?? today }
        let month = cal.dateInterval(of: .month, for: today)?.start ?? today
        switch preset {
        case .today, .custom:
            return DateFilter(preset: preset, startDay: today, endDay: today)
        case .yesterday:
            return DateFilter(preset: preset, startDay: day(-1), endDay: day(-1))
        case .last7:
            return DateFilter(preset: preset, startDay: day(-6), endDay: today)
        case .last30:
            return DateFilter(preset: preset, startDay: day(-29), endDay: today)
        case .thisMonth:
            return DateFilter(preset: preset, startDay: month, endDay: today)
        case .lastMonth:
            let prev = cal.date(byAdding: .month, value: -1, to: month) ?? month
            let last = cal.date(byAdding: .day, value: -1, to: month) ?? month
            return DateFilter(preset: preset, startDay: prev, endDay: last)
        }
    }

    static func single(_ d: Date) -> DateFilter {
        let day = cal.startOfDay(for: d)
        if Clock.isToday(day) { return make(.today) }
        if Clock.isYesterday(day) { return make(.yesterday) }
        return DateFilter(preset: .custom, startDay: day, endDay: day)
    }

    var isSingleDay: Bool { Self.cal.isDate(startDay, inSameDayAs: endDay) }
    var spanDays: Int { (Self.cal.dateComponents([.day], from: startDay, to: endDay).day ?? 0) + 1 }
    var canGoNext: Bool { Self.cal.startOfDay(for: endDay) < Self.cal.startOfDay(for: Clock.now) }

    /// Lùi / tiến đúng bằng độ dài khoảng đang xem.
    func shifted(_ direction: Int) -> DateFilter {
        let offset = direction * spanDays
        guard let s = Self.cal.date(byAdding: .day, value: offset, to: startDay),
              let e = Self.cal.date(byAdding: .day, value: offset, to: endDay) else { return self }
        var next = isSingleDay ? DateFilter.single(s) : DateFilter(preset: .custom, startDay: s, endDay: e)
        next.fromMinute = fromMinute
        next.toMinute = toMinute
        return next
    }

    private func minutes(_ d: Date) -> Int {
        let c = Self.cal.dateComponents([.hour, .minute], from: d)
        return (c.hour ?? 0) * 60 + (c.minute ?? 0)
    }

    private func dayInRange(_ d: Date) -> Bool {
        let day = Self.cal.startOfDay(for: d)
        return day >= Self.cal.startOfDay(for: startDay) && day <= Self.cal.startOfDay(for: endDay)
    }

    func contains(_ d: Date) -> Bool {
        guard dayInRange(d) else { return false }
        let m = minutes(d)
        return m >= fromMinute && m <= toMinute
    }

    func overlaps(_ s: LiveSession) -> Bool {
        guard dayInRange(s.start) else { return false }
        let from = minutes(s.start)
        let to = max(minutes(s.end ?? Clock.now), from)
        return from <= toMinute && to >= fromMinute
    }
}

struct Snapshot: Codable {
    var comments: [LiveComment] = []
    var customers: [Customer] = []
    var sessions: [LiveSession] = []
    var accounts: [TikTokAccount] = []
    var activeAccountId: String?
    var keywords: [String]?

    init(comments: [LiveComment], customers: [Customer], sessions: [LiveSession], accounts: [TikTokAccount],
         activeAccountId: String?, keywords: [String]?) {
        self.comments = comments; self.customers = customers; self.sessions = sessions
        self.accounts = accounts; self.activeAccountId = activeAccountId; self.keywords = keywords
    }

    // Tương thích file lưu của phiên bản cũ (chỉ có comments + customers)
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        comments = try c.decodeIfPresent([LiveComment].self, forKey: .comments) ?? []
        customers = try c.decodeIfPresent([Customer].self, forKey: .customers) ?? []
        sessions = try c.decodeIfPresent([LiveSession].self, forKey: .sessions) ?? []
        accounts = try c.decodeIfPresent([TikTokAccount].self, forKey: .accounts) ?? []
        activeAccountId = try c.decodeIfPresent(String.self, forKey: .activeAccountId)
        keywords = try c.decodeIfPresent([String].self, forKey: .keywords)
    }
}
