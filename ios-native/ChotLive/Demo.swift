#if DEBUG
import SwiftUI

/// Dữ liệu demo giống mẫu thiết kế, chỉ có trong bản Debug để chụp màn hình so với mẫu.
/// Chạy với tham số: -demoScreen <tên màn> (xem danh sách trong show(ui:)).
enum Demo {
    static var screen: String? {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: "-demoScreen"), i + 1 < args.count else { return nil }
        return args[i + 1]
    }

    static var isActive: Bool { screen != nil }

    private static var cal: Calendar { Calendar.current }

    private static func date(_ month: Int, _ day: Int, _ hour: Int = 12, _ minute: Int = 0) -> Date {
        cal.date(from: DateComponents(year: 2026, month: month, day: day, hour: hour, minute: minute)) ?? Date()
    }

    @MainActor
    static func prepare(store: Store, client: LiveClient) {
        guard let screen else { return }
        Clock.fixed = date(10, 25, 20, 55)
        store.persistEnabled = false
        seed(store: store, fillToday: !["customers", "customerDetail"].contains(screen))
        client.liveState = screen == "liveNew" ? "idle" : "connected"
        client.liveUsername = "shophoahong.live"
        client.loggedIn = true
    }

    @MainActor
    static func show(ui: AppUI) {
        guard let screen else { return }
        switch screen {
        case "live": ui.tab = .comments
        case "dateFilter":
            ui.tab = .comments
            ui.present(dim: 0.9) { DateFilterSheet(filter: DateFilter.make(.today)) { _ in } }
        case "customers": ui.tab = .customers
        case "orders": ui.tab = .orders
        case "me": ui.tab = .me
        case "orderActions":
            ui.tab = .orders
            ui.present { OrderActionSheet(orderId: "linh.nguyen98|o25") }
        case "orderDetail":
            ui.tab = .orders
            ui.push(.order("linh.nguyen98|o25"))
        case "customerDetail":
            ui.tab = .customers
            ui.push(.customer("linh.nguyen98"))
        // Các màn không có trong PDF, chụp để kiểm tra hiển thị.
        case "liveNew":
            ui.tab = .comments
            ui.present(dim: AppSheet.dim) { LiveNewSheet() }
        case "areaPicker":
            ui.tab = .customers
            ui.push(.customer("linh.nguyen98"))
            ui.push(.addressEdit("linh.nguyen98"))
            ui.present(dim: AppSheet.dim) { AreaPickerSheet(region: "Phường Bến Nghé, Quận 1, TP. Hồ Chí Minh") { _ in } }
        case "session":
            ui.tab = .comments
            ui.push(.session("s-toi"))
        case "orderEdit":
            ui.tab = .orders
            ui.push(.orderEdit("linh.nguyen98|o25"))
        case "orderCreate":
            ui.tab = .orders
            ui.push(.orderCreate)
        case "orderComments":
            ui.tab = .orders
            ui.push(.orderComments("linh.nguyen98|o25"))
        case "addressEdit":
            ui.tab = .customers
            ui.push(.addressEdit("linh.nguyen98"))
        case "addAccount":
            ui.tab = .me
            ui.present { AddAccountSheet() }
        case "printer":
            ui.tab = .me
            ui.push(.printer)
        case "keywords":
            ui.tab = .me
            ui.push(.keywords)
        case "notifications":
            ui.tab = .me
            ui.push(.notifications)
        case "help":
            ui.tab = .me
            ui.push(.help)
        default: break
        }
    }

    private static func item(_ id: String, _ code: String, _ price: Int, _ ts: Date, group: String,
                             session: String? = nil, printed: Bool = false, delivered: Bool = false, shipping: Bool = false) -> OrderItem {
        OrderItem(id: id, comment: code, price: price, ts: ts, printed: printed, delivered: delivered,
                  shipping: shipping, sessionId: session, groupId: group)
    }

    /// Đơn gồm `count` sản phẩm có tổng đúng `total`.
    private static func order(_ prefix: String, count: Int, total: Int, ts: Date, delivered: Bool) -> [OrderItem] {
        let each = total / count
        return (0..<count).map { i in
            let price = i == 0 ? total - each * (count - 1) : each
            return item("\(prefix)-\(i)", "\(price / 1000)", price, ts, group: prefix, printed: delivered, delivered: delivered)
        }
    }

    private static func customer(_ handle: String, _ name: String, _ items: [OrderItem], address: DeliveryAddress? = nil) -> Customer {
        Customer(id: handle, uniqueId: handle, userId: "", nickname: name, items: items, address: address)
    }

    private static func seed(store: Store, fillToday: Bool) {
        let evening = LiveSession(id: "s-toi", tiktok: "shophoahong.live", start: date(10, 25, 19, 30), end: nil, commentCount: 214)
        let noon = LiveSession(id: "s-trua", tiktok: "shophoahong.live", start: date(10, 25, 12, 0), end: date(10, 25, 13, 40), commentCount: 96)
        let kho = LiveSession(id: "s-kho", tiktok: "khohanglinh", start: date(10, 23, 19, 0), end: date(10, 23, 20, 0))
        store.sessions = [evening, noon, kho]
        store.accounts = [
            TikTokAccount(id: "shophoahong.live", uniqueId: "shophoahong.live", displayName: "Shop Hoa Hồng"),
            TikTokAccount(id: "khohanglinh", uniqueId: "khohanglinh", displayName: "Kho Hàng Linh"),
        ]
        store.activeAccountId = "shophoahong.live"
        func comment(_ id: String, _ handle: String, _ name: String, _ text: String, _ h: Int, _ m: Int) -> LiveComment {
            LiveComment(id: id, uniqueId: handle, userId: "", nickname: name, text: text, ts: date(10, 25, h, m),
                        price: PriceParser.parse(text), sessionId: "s-toi")
        }
        // Mới nhất trước, như thứ tự lưu thật.
        store.comments = [
            comment("c6", "ngocanh_hue", "Ngọc Anh", "Xinh quá shop ơi", 20, 42),
            comment("c5", "linh.nguyen98", "Linh Nguyễn", "Chốt 120 với 180 nữa ạ", 20, 40),
            comment("c4", "thaovy.ht", "Thảo Vy", "Shop ship Huế mấy ngày vậy ạ", 20, 38),
            comment("c3", "linh.nguyen98", "Linh Nguyễn", "Mã 150 chốt nha shop ơi", 20, 36),
            comment("c2", "hoatran_shop", "Hoa Trần", "Mã 280 chốt ạ", 20, 15),
            comment("c1", "kimchi.shop", "Kim Chi", "Mã 130 giá sao shop ơi", 19, 58),
        ]

        func linhItem(_ id: String, _ code: String, _ price: Int, _ text: String, _ commentId: String) -> OrderItem {
            OrderItem(id: id, comment: text, price: price, ts: date(10, 25, 20, 42), sessionId: "s-toi", groupId: "o25",
                      code: code, commentId: commentId)
        }
        var linh: [OrderItem] = [
            linhItem("l1", "150", 150_000, "Mã 150 chốt nha shop ơi", "c3"),
            linhItem("l2", "120", 120_000, "Chốt 120 với 180 nữa ạ", "c5"),
            linhItem("l3", "180", 180_000, "Chốt 120 với 180 nữa ạ", "c5"),
        ]
        linh += order("l21", count: 4, total: 620_000, ts: date(10, 21, 19, 30), delivered: true)
        linh += order("l18", count: 2, total: 310_000, ts: date(10, 18, 20, 15), delivered: true)
        linh += order("l14", count: 5, total: 780_000, ts: date(10, 14, 21, 0), delivered: true)
        for i in 0..<8 {
            linh += order("lx\(i)", count: 1, total: i < 7 ? 160_000 : 170_000, ts: date(9, 20 - i, 20, 0), delivered: true)
        }

        var mai = [item("m1", "170", 170_000, date(10, 25, 13, 20), group: "m25", session: "s-trua", printed: true),
                   item("m2", "170b", 170_000, date(10, 25, 13, 20), group: "m25", session: "s-trua", printed: true)]
        for i in 0..<6 {
            mai += order("mx\(i)", count: 1, total: i < 5 ? 260_000 : 280_000, ts: date(9, 21 - i, 19, 0), delivered: true)
        }

        var customers: [Customer] = [
            customer("linh.nguyen98", "Linh Nguyễn", linh, address: DeliveryAddress(
                receiver: "Linh Nguyễn", phone: "0905 123 456", street: "25 Lê Lợi",
                region: "Phường Bến Nghé, Quận 1, TP. Hồ Chí Minh", note: "Giao giờ hành chính, gọi trước khi giao")),
            customer("hoatran_shop", "Hoa Trần", [item("h1", "280", 280_000, date(10, 25, 20, 15), group: "h25", session: "s-toi")]),
            customer("maipham.97", "Mai Phạm", mai),
            customer("thaovy.ht", "Thảo Vy", order("t", count: 1, total: 215_000, ts: date(10, 24, 21, 5), delivered: true)
                + (0..<3).flatMap { order("tx\($0)", count: 1, total: 215_000, ts: date(9, 10 + $0, 21, 0), delivered: true) }),
            customer("ngocanh_hue", "Ngọc Anh", order("n", count: 1, total: 240_000, ts: date(10, 24, 20, 30), delivered: true)
                + (0..<8).flatMap { order("nx\($0)", count: 1, total: 237_500, ts: date(9, 5 + $0, 20, 0), delivered: true) }),
            customer("bichngoc.mua", "Bích Ngọc", order("b", count: 1, total: 220_000, ts: date(10, 23, 20, 0), delivered: true)
                + (0..<2).flatMap { order("bx\($0)", count: 1, total: 210_000, ts: date(9, 15 + $0, 20, 0), delivered: true) }),
        ]

        // Khách cũ để đủ 128 khách.
        for i in 0..<122 {
            customers.append(customer("khach\(i)", "Khách \(i + 1)",
                                      order("old\(i)", count: 1, total: 100_000, ts: date(8, 1 + i % 28, 10, 0), delivered: true)))
        }

        if fillToday {
            var kim: [OrderItem] = [
                item("k1", "190", 190_000, date(10, 25, 19, 58), group: "k25", session: "s-toi"),
                item("k2", "200", 200_000, date(10, 25, 19, 58), group: "k25", session: "s-toi"),
            ]
            // Màn chi tiết phiên trong mẫu ghi Kim Chi là khách cũ.
            if screen == "session" { kim += order("kx", count: 1, total: 100_000, ts: date(9, 1, 20, 0), delivered: true) }
            customers.append(customer("kimchi.shop", "Kim Chi", kim))
            // Đơn hôm nay để đủ 50 đơn, 37 khách, doanh thu 4.860.000; xếp sau 4 đơn trong mẫu.
            // Trạng thái: 12 đơn mới, 31 đã in, 7 đang giao. Phiên tối 31 đơn / 22 khách, phiên trưa 19 đơn / 15 khách.
            for o in 0..<7 { customers.append(customer("moi\(o)", "Khách mới \(o + 1)", [])) } // cùng Hoa Trần, Kim Chi = 9 khách mới
            let target = 4_860_000 - 450_000 - 280_000 - 340_000 - 390_000
            let fillOrders = 46
            for i in 0..<fillOrders {
                let price = i == 0 ? target - (fillOrders - 1) * (target / fillOrders) : target / fillOrders
                let isNew = i < 9
                let isShipping = i >= 39
                var it = item("f\(i)", "\(price / 1000)", price, date(10, 25, 9, i % 60), group: "f\(i)",
                              session: i < 28 ? "s-toi" : "s-trua", printed: !isNew, shipping: isShipping)
                it.delivered = false
                let owner = i < 28 ? i % 19 : 19 + (i - 28) % 14
                let ownerId = owner < 7 ? "moi\(owner)" : "khach\(owner)"
                if let idx = customers.firstIndex(where: { $0.id == ownerId }) {
                    customers[idx].items.append(it)
                }
            }
            // Doanh thu các ngày trong biểu đồ và trong tháng.
            let daily: [(Int, Int)] = [(19, 3_190_000), (20, 4_120_000), (21, 2_590_000), (22, 5_320_000), (23, 3_900_000), (24, 4_120_000)]
            var fillDays: [OrderItem] = []
            for (day, amount) in daily {
                let known = customers.flatMap(\.items).filter { cal.isDate($0.ts, inSameDayAs: date(10, day)) }.reduce(0) { $0 + $1.lineTotal }
                fillDays.append(item("d\(day)", "x", amount - known, date(10, day, 18, 0), group: "d\(day)", printed: true, delivered: true))
            }
            let chartTotal = daily.reduce(0) { $0 + $1.1 } + 4_860_000
            let inOctober = customers.flatMap(\.items).filter { cal.component(.month, from: $0.ts) == 10 && cal.component(.day, from: $0.ts) < 19 }.reduce(0) { $0 + $1.lineTotal }
            fillDays.append(item("d-oct", "x", 68_450_000 - chartTotal - inOctober, date(10, 5, 18, 0), group: "d-oct", printed: true, delivered: true))
            // Tháng trước cùng kỳ: +12%.
            let inSeptember = customers.flatMap(\.items).filter { cal.component(.month, from: $0.ts) == 9 && cal.component(.day, from: $0.ts) <= 25 }.reduce(0) { $0 + $1.lineTotal }
            fillDays.append(item("d-sep", "x", 61_116_000 - inSeptember, date(9, 3, 18, 0), group: "d-sep", printed: true, delivered: true))
            customers.append(customer("khach-tong", "Khách tổng", fillDays))
        }

        store.customers = customers
    }
}
#endif
