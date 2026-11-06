import Foundation

struct LiveComment: Identifiable, Codable, Equatable {
    var id: String
    var uniqueId: String
    var userId: String
    var nickname: String
    var text: String
    var ts: Date
    var price: Int
    var printed: Bool = false
}

struct OrderItem: Identifiable, Codable, Equatable {
    var id: String          // = id bình luận
    var comment: String
    var price: Int
    var ts: Date
    var printed: Bool = false
    var delivered: Bool = false

    init(id: String, comment: String, price: Int, ts: Date, printed: Bool = false, delivered: Bool = false) {
        self.id = id; self.comment = comment; self.price = price; self.ts = ts
        self.printed = printed; self.delivered = delivered
    }

    // Tương thích dữ liệu cũ (chưa có printed / delivered)
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        comment = try c.decode(String.self, forKey: .comment)
        price = try c.decode(Int.self, forKey: .price)
        ts = try c.decode(Date.self, forKey: .ts)
        printed = try c.decodeIfPresent(Bool.self, forKey: .printed) ?? false
        delivered = try c.decodeIfPresent(Bool.self, forKey: .delivered) ?? false
    }
}

/// Đơn hàng = các món của 1 khách trong 1 ngày.
struct Order: Identifiable {
    var id: String { customer.id + "|" + String(Int(day.timeIntervalSince1970)) }
    var customer: Customer
    var day: Date
    var items: [OrderItem]

    var total: Int { items.reduce(0) { $0 + $1.price } }
    var lastTs: Date { items.map(\.ts).max() ?? day }
    var isPrinted: Bool { !items.isEmpty && items.allSatisfy(\.printed) }
    var isDelivered: Bool { !items.isEmpty && items.allSatisfy(\.delivered) }
}

struct Customer: Identifiable, Codable, Equatable {
    var id: String          // uniqueId viết thường (hoặc userId)
    var uniqueId: String
    var userId: String
    var nickname: String
    var items: [OrderItem]

    var total: Int { items.reduce(0) { $0 + $1.price } }
    var lastTs: Date { items.map(\.ts).max() ?? .distantPast }
    var itemsToday: [OrderItem] { items.filter { Calendar.current.isDateInToday($0.ts) } }
    var initials: String {
        let parts = nickname.split(separator: " ").prefix(2).compactMap { $0.first }
        let s = String(parts).uppercased()
        return s.isEmpty ? "?" : s
    }
}

struct Snapshot: Codable {
    var comments: [LiveComment] = []
    var customers: [Customer] = []
}
