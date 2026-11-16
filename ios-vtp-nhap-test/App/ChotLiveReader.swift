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
    @Published private(set) var orders: [CLOrder] = []
    @Published private(set) var customerCount = 0
    @Published private(set) var source = ""
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
            log.add("ChotLive: đăng nhập \(user)", summary)
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
            log.add("ChotLive: tải lại đơn", summary)
        } catch {
            lastError = error.localizedDescription
            log.add("Lỗi: tải đơn ChotLive", error.localizedDescription, ok: false)
        }
    }

    /// Chỉ quên phiên trên máy này (không gọi máy chủ).
    func forget() {
        token = nil
        Keychain.setString(nil, "cl.token")
        orders = []
        customerCount = 0
        loadedAt = nil
    }

    var summary: String { "\(orders.count) đơn, \(customerCount) khách (đọc từ \(source))" }

    private func apply(_ state: [String: Any]?) {
        let parsed = CLParser.parse(state)
        orders = parsed.orders
        customerCount = parsed.customers
        source = parsed.source
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

/// Tên, SĐT, địa chỉ của khách (lấy từ hồ sơ khách, thiếu thì lấy từ đơn).
struct CLContact {
    var name = ""
    var uniqueId = ""
    var phone = ""
    var street = ""
    var ward = ""
    var district = ""
    var province = ""
    /// Địa chỉ dạng một dòng (dữ liệu cũ / app iOS) khi không có từng phần.
    var line = ""
    var note = ""

    var address: String {
        let parts = [street, ward, district, province].map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        return parts.count >= 2 ? parts.joined(separator: ", ") : line.trimmingCharacters(in: .whitespaces)
    }

    /// Ghép: trường nào mình trống thì lấy của `other`.
    func filled(from other: CLContact) -> CLContact {
        func pick(_ a: String, _ b: String) -> String { a.trimmingCharacters(in: .whitespaces).isEmpty ? b : a }
        var c = self
        c.name = pick(name, other.name); c.uniqueId = pick(uniqueId, other.uniqueId); c.phone = pick(phone, other.phone)
        c.street = pick(street, other.street); c.ward = pick(ward, other.ward); c.district = pick(district, other.district)
        c.province = pick(province, other.province); c.line = pick(line, other.line); c.note = pick(note, other.note)
        return c
    }

    init() {}

    /// Từ một đơn / hồ sơ khách của web ChotLive (hoặc khách của app iOS có `address` lồng).
    init(_ d: [String: Any]) {
        name = J.str(d["receiver"]) ?? J.str(d["name"]) ?? J.str(d["nickname"]) ?? ""
        uniqueId = J.str(d["uniqueId"]) ?? ""
        phone = J.str(d["phone"]) ?? ""
        street = J.str(d["street"]) ?? ""
        ward = J.str(d["ward"]) ?? ""
        district = J.str(d["district"]) ?? ""
        province = J.str(d["province"]) ?? ""
        note = J.str(d["note"]) ?? ""
        if let s = d["address"] as? String {
            line = s
        } else if let a = J.dict(d["address"]) {
            if let r = J.str(a["receiver"]), !r.isEmpty { name = r }
            if phone.isEmpty { phone = J.str(a["phone"]) ?? "" }
            line = [J.str(a["street"]) ?? "", J.str(a["region"]) ?? ""].filter { !$0.isEmpty }.joined(separator: ", ")
            if note.isEmpty { note = J.str(a["note"]) ?? "" }
        }
    }
}

struct CLOrder: Identifiable {
    var id: String
    /// Khách của đơn, cùng cách nhận khách với web (uniqueId → userId → tên).
    var customerKey: String
    var ts: Double
    var total: Int
    var qty: Int
    var ship: CLShip?
    var done: Bool
    var state: String
    var contact: CLContact

    var pending: Bool { !done && ["ask", "hold", "ready"].contains(state) }

    static func key(uniqueId: String?, userId: String?, name: String?) -> String {
        let u = (uniqueId ?? "").trimmingCharacters(in: .whitespaces).lowercased()
        if !u.isEmpty { return u }
        if let id = userId, !id.isEmpty { return id }
        let n = (name ?? "").trimmingCharacters(in: .whitespaces).lowercased()
        return n.isEmpty ? "" : "manual-" + n
    }
}

enum CLParser {
    /// Web ChotLive lưu đơn ở `state.orders`; dữ liệu kiểu app iOS lưu món trong `state.customers[].items`.
    static func parse(_ state: [String: Any]?) -> (orders: [CLOrder], customers: Int, source: String) {
        let rawOrders = (state?["orders"] as? [[String: Any]]) ?? []
        let rawCustomers = (state?["customers"] as? [[String: Any]]) ?? []
        if !rawOrders.isEmpty {
            // Hồ sơ khách (tên, SĐT, địa chỉ đã sửa) thắng thông tin ghi trên đơn, giống web (summarizeGroup).
            var profiles: [String: CLContact] = [:]
            for c in rawCustomers {
                let p = CLContact(c)
                let k = CLOrder.key(uniqueId: J.str(c["uniqueId"]), userId: J.str(c["userId"]), name: J.str(c["name"]) ?? p.name)
                if !k.isEmpty { profiles[k] = p }
            }
            let orders = rawOrders.compactMap(webOrder).map { o -> CLOrder in
                var o = o
                if let p = profiles[o.customerKey] { o.contact = p.filled(from: o.contact) }
                return o
            }
            return (orders, Set(orders.map(\.customerKey)).count, "state.orders")
        }
        let orders = rawCustomers.flatMap(nativeOrders)
        return (orders, rawCustomers.count, "state.customers")
    }

    private static func webOrder(_ o: [String: Any]) -> CLOrder? {
        guard let id = J.str(o["id"]) else { return nil }
        let status = J.str(o["status"]) ?? "new"
        if status == "cancelled" { return nil }
        let items = (o["items"] as? [[String: Any]]) ?? []
        let sub = items.reduce(0) { $0 + (J.int($1["price"]) ?? 0) * max(1, J.int($1["qty"]) ?? 1) }
        let ship = CLShip(J.dict(o["ship"]))
        let done = status == "shipping" || status == "done"
        let state = done ? (ship?.state == "exported" ? "exported" : "gone") : (ship?.state ?? "ask")
        let contact = CLContact(o)
        let key = CLOrder.key(uniqueId: J.str(o["uniqueId"]), userId: J.str(o["userId"]), name: J.str(o["nickname"]) ?? contact.name)
        guard !key.isEmpty else { return nil }
        return CLOrder(id: id, customerKey: key, ts: J.double(o["ts"]) ?? 0, total: max(0, sub - (J.int(o["discount"]) ?? 0)),
                       qty: items.reduce(0) { $0 + max(1, J.int($1["qty"]) ?? 1) }, ship: ship, done: done, state: state,
                       contact: contact)
    }

    /// Dữ liệu kiểu app iOS: mỗi khách có `items`, đơn = các món cùng groupId hoặc cùng ngày.
    private static func nativeOrders(_ c: [String: Any]) -> [CLOrder] {
        guard let cid = J.str(c["id"]) else { return [] }
        let contact = CLContact(c)
        let key = CLOrder.key(uniqueId: J.str(c["uniqueId"]), userId: J.str(c["userId"]), name: contact.name).isEmpty
            ? cid : CLOrder.key(uniqueId: J.str(c["uniqueId"]), userId: J.str(c["userId"]), name: contact.name)
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = .current
        let items = (c["items"] as? [[String: Any]]) ?? []
        let groups = Dictionary(grouping: items) { it -> String in
            let ts = J.double(it["ts"]) ?? 0
            return J.str(it["groupId"]) ?? "day-\(Int(cal.startOfDay(for: Date(timeIntervalSince1970: ts / 1000)).timeIntervalSince1970))"
        }
        return groups.map { gkey, its in
            let ship = its.lazy.compactMap { CLShip(J.dict($0["ship"])) }.first
            let done = !its.isEmpty && its.allSatisfy { J.bool($0["shipping"]) || J.bool($0["delivered"]) }
            let state = done ? (ship?.state == "exported" ? "exported" : "gone") : (ship?.state ?? "ask")
            return CLOrder(id: cid + "|" + gkey, customerKey: key, ts: its.compactMap { J.double($0["ts"]) }.max() ?? 0,
                           total: its.reduce(0) { $0 + max(0, J.int($1["price"]) ?? 0) * max(1, J.int($1["qty"]) ?? 1) },
                           qty: its.reduce(0) { $0 + max(1, J.int($1["qty"]) ?? 1) }, ship: ship, done: done, state: state,
                           contact: contact)
        }
    }
}

/// Một khách = một vận đơn nháp, tính tiền thu hộ đúng cách app thật (summarizeGroup / Vtp.summarize).
struct DraftGroup: Identifiable {
    var key: String
    var orders: [CLOrder]
    var name = ""
    var uniqueId = ""
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

    var id: String { key }
    /// Đổi khi bộ đơn đổi: dùng để nhớ khách này đã đẩy nháp chưa.
    var pushKey: String { key + "#" + orders.map(\.id).sorted().joined(separator: ",") }
    var states: String {
        let names = ["ask": "chưa duyệt", "hold": "hẹn gom", "ready": "đã duyệt", "exported": "đã xuất", "gone": "đã gửi"]
        return Set(orders.map(\.state)).map { names[$0] ?? $0 }.sorted().joined(separator: ", ")
    }

    static let smallLimit = 17_000

    /// mode 0: đã duyệt · 1: chưa gửi (trừ hẹn gom) · 2: đơn gần nhất của mỗi khách, kể cả đã gửi (chỉ để thử,
    /// vì nháp không gọi bưu tá).
    static func build(_ all: [CLOrder], mode: Int) -> [DraftGroup] {
        let byCustomer = Dictionary(grouping: all) { $0.customerKey }
        return byCustomer.compactMap { key, list -> DraftGroup? in
            let sorted = list.sorted { $0.ts < $1.ts }
            let orders: [CLOrder]
            switch mode {
            case 0: orders = sorted.filter { $0.pending && $0.state == "ready" }
            case 1: orders = sorted.filter { $0.pending && $0.state != "hold" }
            default: orders = sorted.last.map { [$0] } ?? []
            }
            guard !orders.isEmpty else { return nil }
            // Thông tin khách: đơn mới nhất trước, thiếu trường nào lấy ở đơn cũ hơn.
            var contact = CLContact()
            for o in sorted.reversed() { contact = contact.filled(from: o.contact) }
            return summarize(key, orders, contact)
        }
        .sorted { (a, b) in
            mode == 2 ? (a.orders.last?.ts ?? 0) > (b.orders.last?.ts ?? 0)
                      : (a.orders.first?.ts ?? 0) < (b.orders.first?.ts ?? 0)
        }
    }

    /// Đếm đơn theo trạng thái để biết vì sao danh sách trống.
    static func stats(_ all: [CLOrder]) -> String {
        let names = ["ask": "chưa duyệt", "hold": "hẹn gom", "ready": "đã duyệt", "exported": "đã xuất", "gone": "đã gửi/giao"]
        var counts: [String: Int] = [:]
        for o in all { counts[names[o.state] ?? o.state, default: 0] += 1 }
        let parts = counts.sorted { $0.value > $1.value }.map { "\($0.key) \($0.value)" }
        return "\(all.count) đơn" + (parts.isEmpty ? "" : ": " + parts.joined(separator: " · "))
    }

    static func summarize(_ key: String, _ orders: [CLOrder], _ c: CLContact) -> DraftGroup {
        var g = DraftGroup(key: key, orders: orders)
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

        g.name = c.name
        g.uniqueId = c.uniqueId
        g.receiver = c.name.replacingOccurrences(of: "[^\\p{L}\\p{N}\\s.'-]", with: " ", options: .regularExpression)
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
        g.phone = c.phone.filter { $0.isNumber || $0 == "+" }
        g.address = c.address
        g.note = c.note
        if g.phone.range(of: "^(\\+?84|0)\\d{9,10}$", options: .regularExpression) == nil { g.problems.append("Thiếu số điện thoại") }
        if g.address.isEmpty { g.problems.append("Thiếu địa chỉ") }
        if g.receiver.isEmpty { g.problems.append("Thiếu tên người nhận") }
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
        let ref = "CL-" + String(key.filter { $0.isLetter || $0.isNumber }.prefix(24))
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
