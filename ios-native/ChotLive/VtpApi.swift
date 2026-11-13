import Foundation

/// Kết nối Viettel Post của tài khoản ChốtLive. Token do shop dán, máy chủ ChốtLive giữ và gọi API thay app,
/// nên dán một lần là dùng được trên cả web lẫn app. Máy chủ không bao giờ gửi token về máy.
struct VtpConnection: Equatable {
    struct Sender: Equatable, Identifiable {
        var id: String
        var name: String
        var phone: String
        var address: String

        init?(_ d: [String: Any]?) {
            guard let d, let id = VtpConnection.string(d["id"]), !id.isEmpty else { return nil }
            self.id = id
            name = VtpConnection.string(d["name"]) ?? ""
            phone = VtpConnection.string(d["phone"]) ?? ""
            address = VtpConnection.string(d["address"]) ?? ""
        }

        init(id: String, name: String, phone: String, address: String) {
            self.id = id
            self.name = name
            self.phone = phone
            self.address = address
        }
    }

    var connected = false
    /// Số điện thoại tài khoản Viettel Post đã che bớt ("09•• ••• 454").
    var phone = ""
    var sender: Sender?
    /// Địa chỉ dán vào partner2.viettelpost.vn để Viettel Post báo trạng thái đơn về.
    var hookUrl = ""
    var lastHookAt: Date?
    var connectedAt: Date?

    init(connected: Bool = false) { self.connected = connected }

    init(_ d: [String: Any]) {
        connected = (d["connected"] as? Bool) ?? false
        phone = Self.string(d["phone"]) ?? ""
        sender = Sender(d["sender"] as? [String: Any])
        hookUrl = Self.string(d["hookUrl"]) ?? ""
        lastHookAt = (d["lastHookAt"] as? Double).map { Date(timeIntervalSince1970: $0 / 1000) }
        connectedAt = (d["connectedAt"] as? Double).map { Date(timeIntervalSince1970: $0 / 1000) }
    }

    /// Viettel Post trả mã số lúc là số, lúc là chuỗi.
    static func string(_ v: Any?) -> String? {
        if let s = v as? String { return s }
        if let n = v as? NSNumber { return n.stringValue }
        return nil
    }
}

/// Kết quả tạo vận đơn cho một khách.
struct VtpCreateResult: Identifiable, Equatable {
    var key: String
    var ok: Bool
    var code: String
    var fee: Int
    var already: Bool
    var error: String

    var id: String { key }

    init(_ d: [String: Any]) {
        key = VtpConnection.string(d["key"]) ?? ""
        ok = (d["ok"] as? Bool) ?? false
        code = VtpConnection.string(d["code"]) ?? ""
        fee = (d["fee"] as? NSNumber)?.intValue ?? 0
        already = (d["already"] as? Bool) ?? false
        error = VtpConnection.string(d["error"]) ?? (ok ? "" : "Lỗi không rõ")
    }

    init(key: String, ok: Bool, code: String = "", fee: Int = 0, already: Bool = false, error: String = "") {
        self.key = key
        self.ok = ok
        self.code = code
        self.fee = fee
        self.already = already
        self.error = error
    }
}

/// Cước dự tính và địa chỉ Viettel Post hiểu cho một nháp (máy chủ hỏi giá, không tạo đơn).
struct VtpQuote: Equatable {
    var ok: Bool
    var fee: Int
    /// "Phường Thuỷ Xuân, Thành phố Huế": phường/tỉnh Viettel Post đọc ra từ dòng địa chỉ.
    var parsed: String
    /// false khi phường/tỉnh Viettel Post hiểu khác app; nil khi chưa đối chiếu được.
    var addrOk: Bool?
    var error: String

    init(_ d: [String: Any]) {
        ok = (d["ok"] as? Bool) ?? false
        fee = (d["fee"] as? NSNumber)?.intValue ?? 0
        parsed = VtpConnection.string(d["parsed"]) ?? ""
        addrOk = d["addrOk"] as? Bool
        error = VtpConnection.string(d["error"]) ?? (ok ? "" : "Không tính được cước")
    }

    init(error: String) {
        ok = false
        fee = 0
        parsed = ""
        addrOk = nil
        self.error = error
    }

    /// Chữ ký của nháp: đổi địa chỉ, tiền, cân nặng hay gói thì hỏi lại cước.
    static func signature(_ g: Vtp.Group, service: String) -> String {
        let s = g.baseSummary ?? g.summary
        let size = s.size.map { "\($0.0)x\($0.1)x\($0.2)" } ?? ""
        return [g.id, s.address.line, "\(s.cod)", "\(s.goods)", "\(s.weightG)", size, service].joined(separator: "|")
    }
}

/// Trạng thái vận đơn Viettel Post trên một đơn, dùng chung cho thẻ đơn, chi tiết đơn và tab Đang giao.
enum VtpTrack {
    /// Khổ tem in: A6 (mặc định, giống web), A5, giấy nhiệt 100mm.
    static let labelSizeKey = "vtpLabelSize"
    static let labelSizes: [(code: String, name: String)] = [("a6", "A6"), ("a5", "A5"), ("k100", "Giấy nhiệt 100mm")]

    static func code(_ o: Order) -> String? {
        guard let c = o.ship?.vtpCode, !c.isEmpty else { return nil }
        return c
    }

    static func kind(_ o: Order) -> String {
        if let k = o.ship?.vtpKind, !k.isEmpty { return k }
        return code(o) == nil ? "" : "created"
    }

    /// Giao hỏng / chờ phát lại / đang hoàn: cần shop xử lý.
    static func needsAction(_ o: Order) -> Bool {
        code(o) != nil && ["attention", "returned"].contains(kind(o)) && o.status != .delivered
    }

    /// Viettel Post đã trả hàng về shop: đơn vẫn nằm ở tab Đang giao nhưng trạng thái hiện "Hoàn về".
    static func isReturned(_ o: Order) -> Bool {
        code(o) != nil && kind(o) == "returned" && o.status != .delivered
    }

    /// Huỷ được khi bưu tá chưa lấy hàng.
    static func canCancel(_ o: Order) -> Bool {
        guard code(o) != nil, o.status != .delivered else { return false }
        let k = kind(o)
        let s = o.ship?.vtpStatus ?? 0
        return k == "created" || (k == "moving" && s > 0 && s < 200)
    }

    static func statusName(_ o: Order) -> String {
        if o.status == .delivered { return o.ship?.vtpStatusName ?? "Giao thành công" }
        if isReturned(o) { return "Hoàn về" }
        let name = o.ship?.vtpStatusName ?? ""
        return name.isEmpty ? "Chờ lấy hàng" : name
    }

    static func trackURL(_ code: String) -> URL? {
        var c = URLComponents(string: "https://viettelpost.vn/thong-tin-don-hang")
        c?.queryItems = [URLQueryItem(name: "peopleTracking", value: "sender"), URLQueryItem(name: "orderNumber", value: code)]
        return c?.url
    }

    /// "1562 8812 0034": mã dài chia nhóm 4 số cho dễ đọc.
    static func pretty(_ code: String) -> String {
        guard code.count > 8, code.allSatisfy(\.isNumber) else { return code }
        var out = ""
        for (i, ch) in code.enumerated() {
            if i > 0 && i % 4 == 0 { out += " " }
            out.append(ch)
        }
        return out
    }

    /// Đơn chưa gửi mà lần tạo vận đơn gần nhất bị Viettel Post từ chối.
    static func lastError(_ o: Order) -> String? {
        guard Vtp.state(o).isPending, let e = o.ship?.vtpError, !e.isEmpty else { return nil }
        return e
    }

    /// Đơn đã về Chờ gửi vì vận đơn cũ bị huỷ.
    static func cancelledCode(_ o: Order) -> String? {
        guard Vtp.state(o).isPending, o.ship?.vtpKind == "cancelled", let c = o.ship?.vtpOldCode, !c.isEmpty else { return nil }
        return c
    }

    /// Các đơn chung vận đơn với đơn này (gộp lúc tạo), cũ nhất trước; chưa có vận đơn thì chỉ có chính nó.
    static func sameWaybill(_ o: Order, in all: [Order]) -> [Order] {
        guard let c = code(o) else { return [o] }
        let mates = all.filter { code($0) == c }.sorted { $0.lastTs < $1.lastTs }
        return mates.isEmpty ? [o] : mates
    }

    /// Tiền thu hộ của vận đơn: tính lại như lúc tạo (COD nhập tay, tiền cọc, cước thật Viettel Post báo).
    static func waybillCod(_ orders: [Order]) -> Int {
        guard let c = orders.last?.customer else { return 0 }
        let fee = orders.compactMap { $0.ship?.vtpFee }.first { $0 > 0 }
        return Vtp.summarize(Vtp.lines(orders), address: c.address, nickname: c.nickname, realFee: fee).cod
    }

    /// Tiền thu hộ đã sửa tay ở nháp của nhóm đơn này (cũ nhất trước), tính như lúc tạo vận đơn; nil khi chưa sửa.
    static func editedCod(_ orders: [Order]) -> Int? {
        guard orders.contains(where: { $0.ship?.codOverride != nil }) else { return nil }
        return waybillCod(orders)
    }

    /// Danh sách đơn: các đơn chung một vận đơn chỉ giữ một thẻ (đơn gặp trước trong danh sách).
    static func oneCardPerWaybill(_ list: [Order]) -> [Order] {
        var seen = Set<String>()
        return list.filter { o in
            guard let c = code(o) else { return true }
            return seen.insert(c).inserted
        }
    }

    /// Dữ liệu một khách gửi lên máy chủ, cùng cách tính với file Excel và với web (vtpPayload).
    static func payload(_ g: Vtp.Group, now: Date = Clock.now) -> [String: Any] {
        let s = g.summary
        let codes = g.orders.compactMap(\.code).filter { !$0.isEmpty }.joined(separator: "+")
        let base = codes.isEmpty ? g.customer.id : codes
        // Vận đơn cũ đã huỷ thì Viettel Post không nhận lại đúng mã đơn đó: thêm hậu tố.
        let retry = g.orders.contains { ($0.ship?.vtpOldCode ?? "").isEmpty == false }
            ? "-" + String(String(Int64(now.timeIntervalSince1970 * 1000), radix: 36).suffix(4)) : ""
        var p: [String: Any] = [
            "key": g.id,
            "itemIds": g.orders.flatMap { $0.items.map(\.id) },
            "ref": String(base.prefix(50 - retry.count)) + retry,
            "receiver": s.receiver,
            "phone": s.phone,
            "address": s.address.line,
            // Phường/tỉnh theo danh mục mới của Viettel Post để máy chủ đối chiếu với địa chỉ Viettel Post hiểu.
            "expect": [
                "province": s.address.newProvince.isEmpty ? s.address.province : s.address.newProvince,
                "ward": s.address.newWard.isEmpty ? s.address.ward : s.address.newWard
            ],
            "goodsName": Vtp.goodsName,
            "qty": max(s.qty, 1),
            "weightG": s.weightG,
            "goods": s.goods,
            "cod": s.cod,
            "senderPays": s.senderPays,
            "note": String(s.note.prefix(150))
        ]
        if let z = s.size { p["size"] = [z.0, z.1, z.2] }
        return p
    }
}

// MARK: - Gọi máy chủ ChốtLive

extension LiveClient {
    var vtpConnected: Bool { vtp?.connected == true }

    private static func errorText(_ r: (Int, [String: Any])?, _ fallback: String) -> String {
        guard let r else { return "Không kết nối được máy chủ ChốtLive. Kiểm tra mạng rồi thử lại." }
        if r.0 == 404 { return "Máy chủ ChốtLive chưa có tính năng Viettel Post. Cập nhật máy chủ rồi thử lại." }
        return (r.1["error"] as? String) ?? fallback
    }

    /// Hỏi máy chủ tài khoản đã kết nối Viettel Post chưa.
    func refreshVtp() {
        Task { @MainActor [weak self] in
            guard let self, let r = await self.apiCall("/api/vtp/status"), r.0 == 200 else { return }
            self.vtp = VtpConnection(r.1)
        }
    }

    /// Dán token: máy chủ đăng nhập thử Viettel Post, được thì lưu và trả về danh sách điểm lấy hàng.
    func vtpConnect(token: String) async -> (error: String?, senders: [VtpConnection.Sender]) {
        let r = await apiCall("/api/vtp/connect", method: "POST", body: ["siteToken": token], timeout: 40)
        guard let r, r.0 == 200, (r.1["ok"] as? Bool) == true else {
            return (Self.errorText(r, "Token không dùng được"), [])
        }
        vtp = VtpConnection(r.1)
        let list = (r.1["inventory"] as? [[String: Any]] ?? []).compactMap { VtpConnection.Sender($0) }
        return (nil, list)
    }

    func vtpSenders() async -> (error: String?, senders: [VtpConnection.Sender]) {
        let r = await apiCall("/api/vtp/inventory", timeout: 30)
        guard let r, r.0 == 200 else { return (Self.errorText(r, "Không lấy được điểm lấy hàng"), []) }
        return (nil, (r.1["list"] as? [[String: Any]] ?? []).compactMap { VtpConnection.Sender($0) })
    }

    func vtpSetSender(_ id: String) async -> String? {
        let r = await apiCall("/api/vtp/sender", method: "POST", body: ["id": id], timeout: 30)
        guard let r, r.0 == 200 else { return Self.errorText(r, "Không chọn được điểm lấy hàng") }
        vtp = VtpConnection(r.1)
        return nil
    }

    func vtpDisconnect() async -> String? {
        let r = await apiCall("/api/vtp/disconnect", method: "POST", body: [:])
        guard let r, r.0 == 200 else { return Self.errorText(r, "Không ngắt được kết nối") }
        vtp = VtpConnection(connected: false)
        return nil
    }

    /// Tạo vận đơn cho nhiều khách một lần. Máy chủ ghi mã vận đơn vào đơn ngay khi tạo xong, nên gửi lại không bị trùng.
    func vtpCreate(service: String, groups: [[String: Any]]) async -> (error: String?, results: [VtpCreateResult]) {
        let timeout = TimeInterval(30 + groups.count * 15)
        let r = await apiCall("/api/vtp/create", method: "POST", body: ["service": service, "groups": groups], timeout: timeout)
        guard let r, r.0 == 200 else { return (Self.errorText(r, "Không tạo được vận đơn"), []) }
        return (nil, (r.1["results"] as? [[String: Any]] ?? []).map { VtpCreateResult($0) })
    }

    /// Nháp: cước dự tính và địa chỉ Viettel Post hiểu cho từng khách, theo `key` của khách. Chưa tạo đơn nào.
    func vtpQuote(service: String, groups: [[String: Any]]) async -> (error: String?, quotes: [String: VtpQuote]) {
        let timeout = TimeInterval(20 + groups.count * 5)
        let r = await apiCall("/api/vtp/quote", method: "POST", body: ["service": service, "groups": groups], timeout: timeout)
        guard let r, r.0 == 200 else { return (Self.errorText(r, "Không tính được cước"), [:]) }
        var out: [String: VtpQuote] = [:]
        for d in r.1["results"] as? [[String: Any]] ?? [] {
            if let key = VtpConnection.string(d["key"]) { out[key] = VtpQuote(d) }
        }
        return (nil, out)
    }

    /// Link in tem của các vận đơn theo khổ giấy đã chọn.
    func vtpPrintURL(_ codes: [String], size: String) async -> (error: String?, url: URL?) {
        var seen = Set<String>()
        let unique = codes.filter { !$0.isEmpty && seen.insert($0).inserted }
        let r = await apiCall("/api/vtp/print", method: "POST", body: ["codes": unique], timeout: 30)
        guard let r, r.0 == 200, let links = r.1["links"] as? [String: Any] else {
            return (Self.errorText(r, "Không lấy được tem"), nil)
        }
        let raw = (links[size] as? String) ?? (links["a6"] as? String) ?? ""
        return (nil, URL(string: raw))
    }

    /// `force`: không gọi Viettel Post, chỉ gỡ mã vận đơn khỏi đơn (shop đã huỷ trên viettelpost.vn).
    /// Thành công trả `already` = Viettel Post báo vận đơn đã huỷ từ trước.
    func vtpCancel(_ code: String, force: Bool = false) async -> (error: String?, already: Bool) {
        let r = await apiCall("/api/vtp/cancel", method: "POST", body: ["code": code, "force": force], timeout: 30)
        guard let r, r.0 == 200 else { return (Self.errorText(r, "Không huỷ được vận đơn"), false) }
        return (nil, (r.1["already"] as? Bool) ?? false)
    }

    /// type 3: phát lại, type 2: đồng ý hoàn về shop.
    func vtpResolve(_ code: String, type: Int, note: String) async -> String? {
        let r = await apiCall("/api/vtp/resolve", method: "POST", body: ["code": code, "type": type, "note": note], timeout: 30)
        guard let r, r.0 == 200 else { return Self.errorText(r, "Viettel Post không nhận yêu cầu") }
        return nil
    }

    /// Gửi nốt thay đổi trên máy trước khi tạo vận đơn, để máy chủ thấy đủ đơn vừa duyệt.
    func vtpFlush(_ store: Store) async {
        flushSync(store)
        for _ in 0..<20 {
            if !store.isAwaitingAck && !store.syncState.hasChanges { return }
            try? await Task.sleep(nanoseconds: 150_000_000)
            if !store.isAwaitingAck && store.syncState.hasChanges { flushSync(store) }
        }
    }
}

// MARK: - Ghi kết quả lên máy ngay, không chờ máy chủ đồng bộ về

extension Store {
    func applyVtpCreated(_ orders: [Order], code: String, fee: Int, service: String, at now: Date = Clock.now) {
        let ms = (now.timeIntervalSince1970 * 1000).rounded()
        let batch = "vtp_" + String(Int64(ms), radix: 36)
        var changes: [String: ShipInfo] = [:]
        for o in orders {
            var s = o.ship ?? ShipInfo()
            s.state = ShipState.exported.rawValue
            s.exportedAt = ms
            s.batchId = batch
            s.vtpCode = code
            s.vtpFee = fee
            s.vtpService = service
            s.vtpStatus = 0
            s.vtpStatusName = "Chờ lấy hàng"
            s.vtpStatusAt = ms
            s.vtpKind = "created"
            s.vtpNote = nil
            s.vtpError = nil
            s.vtpErrorAt = nil
            changes[o.id] = s
        }
        setShip(changes, shipping: true)
    }

    func applyVtpError(_ orders: [Order], error: String, at now: Date = Clock.now) {
        var changes: [String: ShipInfo] = [:]
        for o in orders {
            var s = o.ship ?? ShipInfo()
            s.vtpError = error
            s.vtpErrorAt = (now.timeIntervalSince1970 * 1000).rounded()
            changes[o.id] = s
        }
        setShip(changes)
    }

    /// Huỷ vận đơn xong: đơn về Chờ gửi, giữ mã cũ để tra (giống máy chủ).
    func applyVtpCancelled(code: String, name: String = "Shop đã huỷ vận đơn") {
        var changes: [String: ShipInfo] = [:]
        for o in allOrders() where o.ship?.vtpCode == code {
            var s = o.ship ?? ShipInfo()
            s.state = ShipState.ready.rawValue
            s.vtpOldCode = code
            s.vtpCode = nil
            s.vtpKind = "cancelled"
            s.vtpStatus = 107
            s.vtpStatusName = name
            s.vtpStatusAt = (Clock.now.timeIntervalSince1970 * 1000).rounded()
            s.exportedAt = nil
            s.batchId = nil
            changes[o.id] = s
        }
        setShip(changes, shipping: false)
    }

    func applyVtpResolved(code: String, type: Int) {
        var changes: [String: ShipInfo] = [:]
        for o in allOrders() where o.ship?.vtpCode == code {
            var s = o.ship ?? ShipInfo()
            s.vtpKind = "moving"
            s.vtpStatusName = type == 3 ? "Đã yêu cầu phát lại" : "Đã đồng ý hoàn"
            s.vtpStatusAt = (Clock.now.timeIntervalSince1970 * 1000).rounded()
            changes[o.id] = s
        }
        setShip(changes)
    }
}
