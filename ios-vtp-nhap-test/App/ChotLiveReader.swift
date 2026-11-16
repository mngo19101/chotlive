import Foundation

/// Đọc đơn từ máy chủ ChotLive (AWS) — CHỈ ĐỌC.
/// App test chỉ được gọi đúng hai lệnh: đăng nhập và đọc dữ liệu. Mọi lệnh khác bị chặn ngay trong app,
/// nên không thể sửa, xoá hay đồng bộ gì lên máy chủ.
@MainActor
final class ChotLiveReader: ObservableObject {
    static let defaultServer = "https://chotlive.52-64-216-229.sslip.io"
    static let allowed: Set<String> = ["POST /api/auth/login", "GET /api/state"]

    @Published var server: String { didSet { UserDefaults.standard.set(server, forKey: "cl.server") } }
    @Published private(set) var user: String
    @Published private(set) var customers: [CLCustomer] = []
    @Published private(set) var loadedAt: Date?
    @Published var busy = false
    @Published var lastError: String?
    @Published private(set) var token: String?

    let log: LogStore
    var loggedIn: Bool { token != nil }

    init(log: LogStore) {
        self.log = log
        server = UserDefaults.standard.string(forKey: "cl.server") ?? Self.defaultServer
        user = UserDefaults.standard.string(forKey: "cl.user") ?? ""
        token = Keychain.getString("cl.token")
    }

    private func call(_ method: String, _ path: String, body: Any? = nil) async throws -> HttpReply {
        guard Self.allowed.contains("\(method) \(path)") else {
            throw VtpError.msg("Bị chặn: app test chỉ được đọc dữ liệu (\(method) \(path))")
        }
        let base = server.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard let url = URL(string: base + path), url.scheme == "https" else { throw VtpError.msg("Địa chỉ máy chủ phải là https://") }
        var h: [String: String] = [:]
        if let token { h["Authorization"] = "Bearer \(token)" }
        return try await Http.send(method, url, body: body, headers: h)
    }

    func login(user u: String, password: String) async {
        busy = true
        lastError = nil
        defer { busy = false }
        do {
            let r = try await call("POST", "/api/auth/login", body: ["username": u, "password": password])
            let j = J.dict(r.json) ?? [:]
            guard r.status == 200, let tk = J.str(j["token"]) else {
                throw VtpError.msg(J.str(j["error"]) ?? "Đăng nhập ChotLive thất bại (HTTP \(r.status))")
            }
            token = tk
            Keychain.setString(tk, "cl.token")
            user = J.str(J.dict(j["user"])?["username"]) ?? u
            UserDefaults.standard.set(user, forKey: "cl.user")
            apply(J.dict(j["state"]))
            log.add("ChotLive: đăng nhập \(user)", "Đọc được \(customers.count) khách")
        } catch {
            lastError = error.localizedDescription
            log.add("Lỗi: đăng nhập ChotLive", error.localizedDescription, ok: false)
        }
    }

    func reload() async {
        busy = true
        lastError = nil
        defer { busy = false }
        do {
            let r = try await call("GET", "/api/state")
            if r.status == 401 {
                forget()
                throw VtpError.msg("Phiên ChotLive hết hạn, đăng nhập lại")
            }
            guard r.status == 200 else { throw VtpError.msg("Máy chủ trả HTTP \(r.status)") }
            apply(J.dict(J.dict(r.json)?["state"]))
            log.add("ChotLive: tải lại đơn", "\(customers.count) khách")
        } catch {
            lastError = error.localizedDescription
            log.add("Lỗi: tải đơn ChotLive", error.localizedDescription, ok: false)
        }
    }

    /// Chỉ quên phiên trên máy này (không gọi máy chủ).
    func forget() {
        token = nil
        Keychain.setString(nil, "cl.token")
        customers = []
        loadedAt = nil
    }

    private func apply(_ state: [String: Any]?) {
        let list = (state?["customers"] as? [[String: Any]]) ?? []
        customers = list.compactMap(CLCustomer.init)
        loadedAt = Date()
    }
}

// MARK: - Dữ liệu ChotLive (chỉ các trường cần cho vận đơn)

struct CLShip {
    var state, pay, payer: String?
    var deposit, shipFee, codOverride, weightG, lengthCm, widthCm, heightCm: Int?

    init?(_ d: [String: Any]?) {
        guard let d else { return nil }
        state = J.str(d["state"]); pay = J.str(d["pay"]); payer = J.str(d["payer"])
        deposit = J.int(d["deposit"]); shipFee = J.int(d["shipFee"]); codOverride = J.int(d["codOverride"])
        weightG = J.int(d["weightG"]); lengthCm = J.int(d["lengthCm"]); widthCm = J.int(d["widthCm"]); heightCm = J.int(d["heightCm"])
    }
}

struct CLItem {
    var id: String
    var price: Int
    var qty: Int
    var ts: Double
    var delivered: Bool
    var shipping: Bool
    var groupId: String?
    var ship: CLShip?

    init?(_ d: [String: Any]) {
        guard let id = J.str(d["id"]) else { return nil }
        self.id = id
        price = J.int(d["price"]) ?? 0
        qty = max(1, J.int(d["qty"]) ?? 1)
        ts = J.double(d["ts"]) ?? 0
        delivered = J.bool(d["delivered"])
        shipping = J.bool(d["shipping"])
        groupId = J.str(d["groupId"])
        ship = CLShip(J.dict(d["ship"]))
    }
}

struct CLAddress {
    var receiver, phone, street, region, note: String
}

struct CLCustomer: Identifiable {
    var id: String
    var nickname: String
    var uniqueId: String
    var address: CLAddress?
    var items: [CLItem]

    init?(_ d: [String: Any]) {
        guard let id = J.str(d["id"]) else { return nil }
        self.id = id
        nickname = J.str(d["nickname"]) ?? ""
        uniqueId = J.str(d["uniqueId"]) ?? ""
        if let a = J.dict(d["address"]) {
            address = CLAddress(receiver: J.str(a["receiver"]) ?? "", phone: J.str(a["phone"]) ?? "",
                                street: J.str(a["street"]) ?? "", region: J.str(a["region"]) ?? "", note: J.str(a["note"]) ?? "")
        }
        items = ((d["items"] as? [[String: Any]]) ?? []).compactMap(CLItem.init)
    }
}

/// Một đơn = các món cùng nhóm (groupId) hoặc cùng ngày, giống app thật.
struct CLOrder {
    var key: String
    var items: [CLItem]

    var total: Int { items.reduce(0) { $0 + max(0, $1.price) * $1.qty } }
    var qty: Int { items.reduce(0) { $0 + $1.qty } }
    var lastTs: Double { items.map(\.ts).max() ?? 0 }
    var ship: CLShip? { items.first { $0.ship != nil }?.ship }
    var done: Bool { !items.isEmpty && items.allSatisfy { $0.shipping || $0.delivered } }
    var state: String { ship?.state ?? "ask" }
    var pending: Bool { !done && ["ask", "hold", "ready"].contains(state) }

    static func orders(of c: CLCustomer) -> [CLOrder] {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = .current
        let groups = Dictionary(grouping: c.items) { it -> String in
            it.groupId ?? "day-\(Int(cal.startOfDay(for: Date(timeIntervalSince1970: it.ts / 1000)).timeIntervalSince1970))"
        }
        return groups.map { CLOrder(key: $0.key, items: $0.value.sorted { $0.ts < $1.ts }) }.sorted { $0.lastTs < $1.lastTs }
    }
}

/// Một khách = một vận đơn nháp, tính tiền thu hộ đúng cách app thật (Vtp.summarize).
struct DraftGroup: Identifiable {
    var customer: CLCustomer
    var orders: [CLOrder]
    var receiver = ""
    var phone = ""
    var address = ""
    var note = ""
    var goods = 0
    var cod = 0
    var qty = 0
    var weightG = 1000
    var size: (Int, Int, Int)?
    var senderPays = false
    var problems: [String] = []

    var id: String { customer.id }
    /// Đổi khi bộ đơn đổi: dùng để nhớ khách này đã đẩy nháp chưa.
    var pushKey: String { customer.id + "#" + orders.map(\.key).sorted().joined(separator: ",") }
    var states: String {
        let names = ["ask": "chưa duyệt", "hold": "hẹn gom", "ready": "đã duyệt"]
        return Set(orders.map(\.state)).map { names[$0] ?? $0 }.sorted().joined(separator: ", ")
    }

    static let smallLimit = 17_000

    /// mode 0: đã duyệt · 1: chưa gửi (trừ hẹn gom) · 2: đơn gần nhất của mỗi khách, kể cả đã gửi (chỉ để thử,
    /// vì nháp không gọi bưu tá).
    static func build(_ customers: [CLCustomer], mode: Int) -> [DraftGroup] {
        customers.compactMap { c -> DraftGroup? in
            let all = CLOrder.orders(of: c)
            let orders: [CLOrder]
            switch mode {
            case 0: orders = all.filter { $0.pending && $0.state == "ready" }
            case 1: orders = all.filter { $0.pending && $0.state != "hold" }
            default: orders = all.last.map { [$0] } ?? []
            }
            guard !orders.isEmpty else { return nil }
            return summarize(c, orders)
        }
        .sorted { (a, b) in
            mode == 2 ? (a.orders.last?.lastTs ?? 0) > (b.orders.last?.lastTs ?? 0)
                      : (a.orders.first?.lastTs ?? 0) < (b.orders.first?.lastTs ?? 0)
        }
    }

    /// Đếm đơn theo trạng thái để biết vì sao danh sách trống.
    static func stats(_ customers: [CLCustomer]) -> String {
        var counts: [String: Int] = [:]
        var total = 0
        for c in customers {
            for o in CLOrder.orders(of: c) {
                total += 1
                let key: String
                if o.done { key = "đã gửi/giao" } else {
                    switch o.state {
                    case "ask": key = "chưa duyệt"
                    case "hold": key = "hẹn gom"
                    case "ready": key = "đã duyệt"
                    case "exported": key = "đã xuất"
                    default: key = o.state
                    }
                }
                counts[key, default: 0] += 1
            }
        }
        let parts = counts.sorted { $0.value > $1.value }.map { "\($0.key) \($0.value)" }
        return "\(customers.count) khách, \(total) đơn" + (parts.isEmpty ? "" : ": " + parts.joined(separator: " · "))
    }

    static func summarize(_ c: CLCustomer, _ orders: [CLOrder]) -> DraftGroup {
        var g = DraftGroup(customer: c, orders: orders)
        func last<T>(_ f: (CLShip) -> T?) -> T? {
            for o in orders.reversed() { if let s = o.ship, let v = f(s) { return v } }
            return nil
        }
        let paid = { (o: CLOrder) in o.ship?.pay == "paid" || o.ship?.pay == "shipOnly" }
        let allPaid = orders.allSatisfy(paid)
        g.goods = orders.reduce(0) { $0 + $1.total }
        let unpaidRaw = orders.filter { !paid($0) }.reduce(0) { $0 + $1.total }
        let deposit = min(unpaidRaw, orders.reduce(0) { $0 + max(0, $1.ship?.deposit ?? 0) })
        let unpaid = unpaidRaw - deposit
        let feeSet: Int? = last { $0.shipFee }
        let fee = feeSet ?? smallLimit
        let limit = max(smallLimit, fee)
        let payerRaw: String? = last { s -> String? in (s.payer ?? "").isEmpty ? nil : s.payer }
        let payer: String
        if payerRaw == "sender" || payerRaw == "receiver" { payer = payerRaw ?? "receiver" } else { payer = allPaid ? "sender" : "receiver" }
        let override: Int? = last { $0.codOverride }
        let small = !allPaid && unpaid < limit
        let bankShipByReceiver = allPaid && payer == "receiver"
        let overrideSmall = !allPaid && (override.map { $0 < limit } ?? false)
        g.senderPays = payer == "sender" || bankShipByReceiver || small || overrideSmall
        let addFee = bankShipByReceiver || small
        let autoCod = (allPaid ? 0 : unpaid) + (addFee ? fee : 0)
        if let override { g.cod = overrideSmall ? override + fee : override } else { g.cod = autoCod }
        g.weightG = orders.compactMap { $0.ship?.weightG }.filter { $0 > 0 }.max() ?? 1000
        g.qty = orders.reduce(0) { $0 + $1.qty }
        if let l = last({ $0.lengthCm }), let w = last({ $0.widthCm }), let h = last({ $0.heightCm }), l > 0, w > 0, h > 0 {
            g.size = (l, w, h)
        }

        let a = c.address
        let name = (a?.receiver ?? "").isEmpty ? c.nickname : a!.receiver
        g.receiver = name.replacingOccurrences(of: "[^\\p{L}\\p{N}\\s.'-]", with: " ", options: .regularExpression)
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
        g.phone = (a?.phone ?? "").filter { $0.isNumber || $0 == "+" }
        g.address = [a?.street ?? "", a?.region ?? ""].map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }.joined(separator: ", ")
        g.note = a?.note ?? ""
        if g.phone.range(of: "^(\\+?84|0)\\d{9,10}$", options: .regularExpression) == nil { g.problems.append("Thiếu số điện thoại") }
        if (a?.region ?? "").trimmingCharacters(in: .whitespaces).isEmpty { g.problems.append("Thiếu địa chỉ") }
        if g.weightG >= 10_000 && g.size == nil { g.problems.append("Từ 10kg phải có kích thước") }
        return g
    }

    /// Body giống hệt nút "Lưu nháp" trên viettelpost.vn. Cước để 0, Viettel Post tự tính khi bạn gửi đơn.
    func draftBody(kho: VtpKho, place: VtpPlace, service: String) -> [String: Any] {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "dd/MM/yyyy HH:mm:ss"
        let product = "Quần áo"
        let payment = cod > 0 ? (senderPays ? 3 : 2) : (senderPays ? 1 : 4)
        let ref = "CL-" + String(customer.id.filter { $0.isLetter || $0.isNumber }.prefix(24))
        let quantity = max(1, qty)
        let (len, wid, hei) = size ?? (0, 0, 0)
        // Ghép từng phần nhỏ cho trình biên dịch Swift khỏi chậm với một từ điển quá lớn.
        var b: [String: Any] = [:]
        b["ORDER_REFERENCE"] = ref
        b["ORDER_TYPE"] = 1
        b["TYPE"] = 12
        b["DELIVERY_DATE"] = f.string(from: Date())
        b["GROUPADDRESS_ID"] = kho.id
        b["CUS_ID"] = kho.cusId
        b["SENDER_FULLNAME"] = clipBytes(kho.name)
        b["SENDER_ADDRESS"] = clipBytes(kho.address)
        b["SENDER_PHONE"] = kho.phone
        b["SENDER_EMAIL"] = ""
        b["SENDER_PROVINCE"] = String(kho.province)
        b["SENDER_DISTRICT"] = String(kho.district)
        b["SENDER_WARD"] = String(kho.ward)
        b["SENDER_LATITUDE"] = 0
        b["SENDER_LONGITUDE"] = 0
        b["RECEIVER_FULLNAME"] = clipBytes(receiver)
        b["RECEIVER_ADDRESS"] = clipBytes(address)
        b["RECEIVER_PHONE"] = phone
        b["RECEIVER_EMAIL"] = ""
        b["RECEIVER_PROVINCE"] = place.province
        b["RECEIVER_DISTRICT"] = place.district
        b["RECEIVER_WARD"] = place.ward
        b["RECEIVER_LATITUDE"] = 0
        b["RECEIVER_LONGITUDE"] = 0
        b["PRODUCT_NAME"] = product
        b["PRODUCT_DESCRIPTION"] = ""
        b["PRODUCT_QUANTITY"] = quantity
        b["PRODUCT_PRICE"] = goods
        b["PRODUCT_WEIGHT"] = weightG
        b["PRODUCT_LENGTH"] = len
        b["PRODUCT_WIDTH"] = wid
        b["PRODUCT_HEIGHT"] = hei
        b["PRODUCT_TYPE"] = "HH"
        b["ORDER_PAYMENT"] = payment
        b["ORDER_SERVICE"] = service
        b["ORDER_SERVICE_ADD"] = ""
        b["ORDER_VOUCHER"] = ""
        b["ORDER_NOTE"] = clipBytes(note)
        b["DELIVERY_CODE"] = -1
        b["MONEY_COLLECTION"] = cod
        for k in ["MONEY_TOTALFEE", "MONEY_FEECOD", "MONEY_FEEVAS", "MONEY_FEEINSURRANCE", "MONEY_FEE",
                  "MONEY_FEEOTHER", "MONEY_TOTALVAT", "MONEY_TOTAL"] {
            b[k] = 0
        }
        var item: [String: Any] = [:]
        item["ORDER_NUMBER_ITEM"] = 1
        item["PRODUCT_NAME"] = product
        item["PRODUCT_QUANTITY"] = quantity
        item["PRODUCT_WEIGHT"] = weightG
        item["PRODUCT_PRICE"] = goods
        b["LIST_ITEM"] = [item]
        b["OPTION_LOCATION"] = 0
        b["REMOVE_PICKUP_DATE"] = true
        b["XMG_EXTRA_MONEY"] = 0
        b["ORDER_NUMBER"] = ""
        return b
    }
}

/// Nhớ trên máy những khách đã đẩy nháp (theo bộ đơn), để không đẩy trùng.
enum PushedStore {
    private static let key = "pushed.v1"

    static func code(_ pushKey: String) -> String? {
        (UserDefaults.standard.dictionary(forKey: key) as? [String: String])?[pushKey]
    }

    static func save(_ pushKey: String, _ code: String) {
        var d = (UserDefaults.standard.dictionary(forKey: key) as? [String: String]) ?? [:]
        d[pushKey] = code
        UserDefaults.standard.set(d, forKey: key)
    }

    static func clear() { UserDefaults.standard.removeObject(forKey: key) }
}
