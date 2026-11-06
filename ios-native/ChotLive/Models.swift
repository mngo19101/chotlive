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
}

struct Snapshot: Codable {
    var comments: [LiveComment] = []
    var customers: [Customer] = []
}
