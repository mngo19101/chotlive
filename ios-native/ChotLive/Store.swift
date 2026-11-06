import Foundation

/// Lưu bình luận + khách hàng ngay trên máy (JSON trong Documents).
final class Store: ObservableObject {
    @Published var comments: [LiveComment] = []
    @Published var customers: [Customer] = []

    private let fileURL: URL = {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("chotlive.json")
    }()

    init() { load() }

    func addComment(_ c: LiveComment) {
        guard !comments.contains(where: { $0.id == c.id }) else { return }
        comments.insert(c, at: 0)
        if comments.count > 300 { comments.removeLast(comments.count - 300) }
        save()
    }

    /// Lưu bình luận vào khách (tạo khách nếu chưa có). Trả về món vừa lưu.
    @discardableResult
    func saveToCustomer(_ c: LiveComment) -> OrderItem {
        let key = Self.key(uniqueId: c.uniqueId, userId: c.userId)
        let item = OrderItem(id: c.id, comment: c.text, price: c.price, ts: c.ts)

        if let idx = customers.firstIndex(where: { $0.id == key || (!c.userId.isEmpty && $0.userId == c.userId) }) {
            if let existing = customers[idx].items.first(where: { $0.id == c.id }) { return existing }
            customers[idx].items.append(item)
            if customers[idx].userId.isEmpty { customers[idx].userId = c.userId }
            if !c.nickname.isEmpty { customers[idx].nickname = c.nickname }
        } else {
            customers.append(Customer(id: key, uniqueId: c.uniqueId, userId: c.userId, nickname: c.nickname, items: [item]))
        }
        if let i = comments.firstIndex(where: { $0.id == c.id }) { comments[i].printed = true }
        save()
        return item
    }

    func deleteItem(customerId: String, itemId: String) {
        guard let idx = customers.firstIndex(where: { $0.id == customerId }) else { return }
        customers[idx].items.removeAll { $0.id == itemId }
        if customers[idx].items.isEmpty { customers.remove(at: idx) }
        save()
    }

    func markPrinted(itemId: String) {
        for ci in customers.indices {
            if let ii = customers[ci].items.firstIndex(where: { $0.id == itemId }) {
                customers[ci].items[ii].printed = true
            }
        }
        save()
    }

    func setDelivered(_ value: Bool, itemIds: [String]) {
        for ci in customers.indices {
            for ii in customers[ci].items.indices where itemIds.contains(customers[ci].items[ii].id) {
                customers[ci].items[ii].delivered = value
            }
        }
        save()
    }

    /// Đơn hàng theo ngày (mỗi khách mỗi ngày = 1 đơn), mới nhất trước.
    func orders(on day: Date? = nil) -> [Order] {
        let cal = Calendar.current
        var result: [Order] = []
        for cust in customers {
            let groups = Dictionary(grouping: cust.items) { cal.startOfDay(for: $0.ts) }
            for (d, its) in groups where day == nil || cal.isDate(d, inSameDayAs: day!) {
                result.append(Order(customer: cust, day: d, items: its.sorted { $0.ts > $1.ts }))
            }
        }
        return result.sorted { $0.lastTs > $1.lastTs }
    }

    func revenue(on day: Date) -> Int {
        orders(on: day).reduce(0) { $0 + $1.total }
    }

    func customersToday() -> [Customer] {
        customers.filter { !$0.itemsToday.isEmpty }.sorted { $0.lastTs > $1.lastTs }
    }

    static func key(uniqueId: String, userId: String) -> String {
        let u = uniqueId.lowercased()
        return u.isEmpty ? userId : u
    }

    private func load() {
        guard let data = try? Data(contentsOf: fileURL),
              let snap = try? JSONDecoder().decode(Snapshot.self, from: data) else { return }
        comments = snap.comments
        customers = snap.customers
    }

    private func save() {
        let snap = Snapshot(comments: comments, customers: customers)
        if let data = try? JSONEncoder().encode(snap) {
            try? data.write(to: fileURL, options: .atomic)
        }
    }
}
