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
    /// Tiền thu hộ / giá trị hàng máy chủ đã gửi Viettel Post (nil: máy chủ bản cũ chưa trả).
    var cod: Int? = nil
    var goods: Int? = nil
    var already: Bool
    var fromDraft: Bool = false
    var error: String

    var id: String { key }

    init(_ d: [String: Any]) {
        key = VtpConnection.string(d["key"]) ?? ""
        ok = (d["ok"] as? Bool) ?? false
        code = VtpConnection.string(d["code"]) ?? ""
        fee = (d["fee"] as? NSNumber)?.intValue ?? 0
        cod = (d["cod"] as? NSNumber)?.intValue
        goods = (d["goods"] as? NSNumber)?.intValue
        already = (d["already"] as? Bool) ?? false
        fromDraft = (d["fromDraft"] as? Bool) ?? false
        error = VtpConnection.string(d["error"]) ?? (ok ? "" : "Lỗi không rõ")
    }

    init(key: String, ok: Bool, code: String = "", fee: Int = 0, cod: Int? = nil, goods: Int? = nil,
         already: Bool = false, fromDraft: Bool = false, error: String = "") {
        self.key = key
        self.ok = ok
        self.code = code
        self.fee = fee
        self.cod = cod
        self.goods = goods
        self.already = already
        self.fromDraft = fromDraft
        self.error = error
    }
}

/// Cước dự tính và địa chỉ Viettel Post hiểu cho một nháp (máy chủ hỏi giá, không tạo đơn).
struct VtpQuote: Equatable, Codable {
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
        return [g.id, s.address.line, "\(s.cod)", "\(s.goods)", "\(s.weightG)", size, service,
                s.extras.joined(separator: ",")].joined(separator: "|")
    }
}

/// Cước dự tính đã hỏi, nhớ chung cả app và lưu xuống máy: mở lại Chờ gửi (hay mở lại app) hiện giá ngay,
/// chỉ hỏi Viettel Post cho khách mới duyệt hoặc vừa sửa địa chỉ / tiền / cân nặng / gói.
final class VtpQuoteCache: ObservableObject {
    static let shared = VtpQuoteCache()

    private struct Entry: Codable {
        var quote: VtpQuote
        var at: Double
    }

    /// Giá đúng giữ 6 tiếng; lỗi chỉ giữ 90 giây để lần mở sau hỏi lại.
    static let okLife: TimeInterval = 6 * 3600
    static let errorLife: TimeInterval = 90
    /// Mỗi lượt gửi máy chủ 4 khách (máy chủ hỏi 4 khách cùng lúc): xong lượt nào hiện giá lượt đó.
    static let chunk = 4
    private static let diskKey = "vtpQuoteCache.v1"

    @Published private var entries: [String: Entry] = [:]
    @Published private(set) var quoting: Set<String> = []

    init() {
        guard let data = UserDefaults.standard.data(forKey: Self.diskKey),
              let saved = try? JSONDecoder().decode([String: Entry].self, from: data) else { return }
        let now = Date().timeIntervalSince1970
        entries = saved.filter { now - $0.value.at < Self.okLife && $0.value.quote.ok }
    }

    /// Khoá cước: tài khoản app + điểm lấy hàng + chữ ký nháp (đổi điểm lấy hàng là giá khác).
    static func key(account: String, sender: String, signature: String) -> String {
        "\(account)|\(sender)|\(signature)"
    }

    func quote(_ key: String) -> VtpQuote? {
        guard let e = entries[key] else { return nil }
        let life = e.quote.ok ? Self.okLife : Self.errorLife
        return Date().timeIntervalSince1970 - e.at < life ? e.quote : nil
    }

    func isQuoting(_ key: String) -> Bool { quoting.contains(key) }

    /// Hỏi cước những khách chưa có giá, theo đúng thứ tự danh sách (khách trên cùng có giá trước).
    /// Chạy riêng, không theo màn: rời tab giữa chừng thì giá vẫn về và được nhớ.
    func fetch(_ need: [(key: String, group: Vtp.Group)], service: String, client: LiveClient) {
        let todo = need.filter { quote($0.key) == nil && !quoting.contains($0.key) }
        guard !todo.isEmpty else { return }
        quoting.formUnion(todo.map(\.key))
        Task { @MainActor in
            for start in stride(from: 0, to: todo.count, by: Self.chunk) {
                let part = Array(todo[start..<min(start + Self.chunk, todo.count)])
                let r = await client.vtpQuote(service: service, groups: part.map { VtpTrack.payload($0.group) })
                let now = Date().timeIntervalSince1970
                for item in part {
                    entries[item.key] = Entry(quote: r.quotes[item.group.id] ?? VtpQuote(error: r.error ?? "Không tính được cước"), at: now)
                    quoting.remove(item.key)
                }
            }
            save()
        }
    }

    private func save() {
        let now = Date().timeIntervalSince1970
        let keep = entries.filter { $0.value.quote.ok && now - $0.value.at < Self.okLife }
        if let data = try? JSONEncoder().encode(keep) { UserDefaults.standard.set(data, forKey: Self.diskKey) }
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

    /// Giao hỏng / chờ phát lại / đang hoàn, hoặc vận đơn tạo sai địa chỉ mà máy chủ chưa huỷ được (needsCancel): cần shop xử lý.
    static func needsAction(_ o: Order) -> Bool {
        code(o) != nil && ["attention", "returned", "needsCancel"].contains(kind(o)) && o.status != .delivered
    }

    /// Vận đơn tạo sai địa chỉ, máy chủ tự huỷ chưa được: còn sống bên Viettel Post, shop cần bấm huỷ lại.
    static func needsCancel(_ o: Order) -> Bool { code(o) != nil && kind(o) == "needsCancel" }

    /// Lần tạo vận đơn trước chưa rõ kết quả (Viettel Post trả lời chậm, đứt mạng): máy chủ khoá đơn, chưa tạo lại được.
    static func unknown(_ o: Order) -> Bool {
        code(o) == nil && ["creating", "unknown"].contains(o.ship?.vtpKind ?? "")
    }

    static let unknownProblem = "Chưa rõ vận đơn trước đã tạo chưa, mở đơn để kiểm tra"

    /// Viettel Post đã trả hàng về shop: đơn vẫn nằm ở tab Đang giao nhưng trạng thái hiện "Hoàn về".
    static func isReturned(_ o: Order) -> Bool {
        code(o) != nil && kind(o) == "returned" && o.status != .delivered
    }

    /// Huỷ được khi bưu tá chưa lấy hàng.
    static func canCancel(_ o: Order) -> Bool {
        guard code(o) != nil, o.status != .delivered else { return false }
        let k = kind(o)
        let s = o.ship?.vtpStatus ?? 0
        return k == "created" || k == "needsCancel" || (k == "moving" && s > 0 && s < 200)
    }

    static func statusName(_ o: Order) -> String {
        if o.status == .delivered { return o.ship?.vtpStatusName ?? "Giao thành công" }
        if needsCancel(o) { return "Cần huỷ vận đơn" }
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
        guard Vtp.state(o).isPending, !unknown(o), let e = o.ship?.vtpError, !e.isEmpty else { return nil }
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

    /// Tiền thu hộ của vận đơn: đúng số máy chủ đã gửi Viettel Post. Vận đơn tạo trước khi máy chủ lưu số đó
    /// (hoặc nháp chưa tạo) thì tính lại như lúc tạo (COD nhập tay, tiền cọc, cước thật Viettel Post báo).
    static func waybillCod(_ orders: [Order]) -> Int {
        if let sent = orders.first(where: { code($0) != nil && $0.ship?.vtpCod != nil })?.ship?.vtpCod { return sent }
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
        var p: [String: Any] = [
            "key": g.id,
            "itemIds": g.orders.flatMap { $0.items.map(\.id) },
            "receiver": s.receiver,
            "phone": s.phone,
            "address": s.address.line,
            // Phường/tỉnh theo danh mục mới của Viettel Post để máy chủ đối chiếu với địa chỉ Viettel Post hiểu.
            "expect": [
                "province": s.address.newProvince.isEmpty ? s.address.province : s.address.newProvince,
                "ward": s.address.newWard.isEmpty ? s.address.ward : s.address.newWard
            ],
            "goodsName": s.goodsName,
            "qty": max(s.qty, 1),
            "weightG": s.weightG,
            "goods": s.goods,
            "cod": s.cod,
            "senderPays": s.senderPays,
            "note": String(s.note.prefix(150)),
            // Dịch vụ cộng thêm chọn ở bảng Duyệt đơn; máy chủ lọc lại theo danh sách được phép.
            "extras": s.extras.joined(separator: ",")
        ]
        if let z = s.size { p["size"] = [z.0, z.1, z.2] }
        return p
    }
}

// MARK: - Gọi máy chủ ChốtLive

extension LiveClient {
    var vtpConnected: Bool { vtp?.connected == true }
    /// Phần 1 "Đang chạy": đã lưu token VÀ Viettel Post đã báo trạng thái đơn về qua webhook ít nhất một lần.
    /// Phần 2 (Đẩy nháp) chỉ mở khi phần 1 chạy, vì app cần trạng thái Viettel Post trả về để biết đơn đi tới đâu.
    var vtpRunning: Bool { vtpConnected && vtp?.lastHookAt != nil }

    private static func errorText(_ r: (Int, [String: Any])?, _ fallback: String) -> String {
        guard let r else { return "Không kết nối được máy chủ ChốtLive. Kiểm tra mạng rồi thử lại." }
        if r.0 == 404 { return "Máy chủ ChốtLive chưa có tính năng Viettel Post. Cập nhật máy chủ rồi thử lại." }
        return (r.1["error"] as? String) ?? fallback
    }

    /// Hỏi máy chủ tài khoản đã kết nối Viettel Post chưa.
    func refreshVtp() {
        let key = currentAccountKey
        Task { @MainActor [weak self] in
            guard let self, let r = await self.apiCall("/api/vtp/status"), r.0 == 200,
                  self.currentAccountKey == key else { return }
            let next = VtpConnection(r.1)
            if self.vtp != next { self.vtp = next }
        }
    }

    /// Dán token: máy chủ đăng nhập thử Viettel Post, được thì lưu và trả về danh sách điểm lấy hàng.
    func vtpConnect(token: String) async -> (error: String?, senders: [VtpConnection.Sender]) {
        let key = currentAccountKey
        let r = await apiCall("/api/vtp/connect", method: "POST", body: ["siteToken": token], timeout: 40)
        guard self.currentAccountKey == key else { return ("Đã chuyển tài khoản ChốtLive khác.", []) }
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
        let key = currentAccountKey
        let r = await apiCall("/api/vtp/sender", method: "POST", body: ["id": id], timeout: 30)
        guard self.currentAccountKey == key else { return nil }
        guard let r, r.0 == 200 else { return Self.errorText(r, "Không chọn được điểm lấy hàng") }
        vtp = VtpConnection(r.1)
        return nil
    }

    func vtpDisconnect() async -> String? {
        let key = currentAccountKey
        let r = await apiCall("/api/vtp/disconnect", method: "POST", body: [:])
        guard self.currentAccountKey == key else { return nil }
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

    private func vtpDraftServerCall(_ path: String, service: String, groups: [[String: Any]], timeout: TimeInterval,
                                    fallback: String) async -> (status: Int, error: String?, results: [VtpCreateResult]) {
        let r = await apiCall(path, method: "POST", body: ["service": service, "groups": groups], timeout: timeout)
        guard let r else { return (0, Self.errorText(nil, fallback), []) }
        guard r.0 == 200 else { return (r.0, Self.errorText(r, fallback), []) }
        return (200, nil, (r.1["results"] as? [[String: Any]] ?? []).map { VtpCreateResult($0) })
    }

    /// Ghi nhận nháp đã được duyệt ngay trên thiết bị lên máy chủ (để đồng bộ, in tem và nhận webhook).
    func vtpAdoptDraft(service: String, groups: [[String: Any]]) async -> (status: Int, error: String?, results: [VtpCreateResult]) {
        await vtpDraftServerCall("/api/vtp/adopt-draft", service: service, groups: groups,
                                 timeout: TimeInterval(20 + groups.count * 5), fallback: "Không ghi được vận đơn đã duyệt")
    }

    /// Nhờ máy chủ duyệt nháp qua API đối tác (UpdateOrder TYPE 1) khi thiết bị không có phiên Phần 2 phù hợp.
    func vtpApproveDraft(service: String, groups: [[String: Any]]) async -> (status: Int, error: String?, results: [VtpCreateResult]) {
        await vtpDraftServerCall("/api/vtp/approve-draft", service: service, groups: groups,
                                 timeout: TimeInterval(30 + groups.count * 10), fallback: "Không duyệt được nháp")
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

    /// Bảng dịch vụ cộng thêm: giá từng dịch vụ (đã gồm VAT) cho đúng đơn đang duyệt và gói đang chọn.
    /// Giá nil: gói này Viettel Post không nhận dịch vụ đó. Chưa tạo đơn nào.
    func vtpExtraPrices(service: String, group: [String: Any]) async -> (error: String?, prices: [String: Int?]) {
        let r = await apiCall("/api/vtp/extras", method: "POST", body: ["service": service, "group": group], timeout: 40)
        guard let r, r.0 == 200 else { return (Self.errorText(r, "Không hỏi được giá dịch vụ"), [:]) }
        var out: [String: Int?] = [:]
        let raw = r.1["prices"] as? [String: Any] ?? [:]
        for svc in VtpExtras.all {
            guard let v = raw[svc.code] else { continue }
            // null (NSNull) là gói không nhận dịch vụ này.
            out[svc.code] = .some((v as? NSNumber)?.intValue)
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

    /// Lần tạo vận đơn "chưa rõ": shop đã kiểm trên viettelpost.vn. `code` = mã tìm thấy; nil = xác nhận không có, cho tạo lại.
    func vtpSettle(itemIds: [String], code: String?) async -> String? {
        var body: [String: Any] = ["itemIds": itemIds]
        if let code { body["code"] = code } else { body["none"] = true }
        let r = await apiCall("/api/vtp/settle", method: "POST", body: body, timeout: 30)
        guard let r, r.0 == 200 else { return Self.errorText(r, "Không ghi được, thử lại") }
        return nil
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
    func applyVtpCreated(_ orders: [Order], code: String, fee: Int, cod: Int? = nil, goods: Int? = nil,
                         service: String, fromDraft: Bool = false, batchId: String? = nil, at now: Date = Clock.now) {
        let ms = (now.timeIntervalSince1970 * 1000).rounded()
        let batch = batchId ?? ((fromDraft ? "vtpd_" : "vtp_") + String(Int64(ms), radix: 36))
        var changes: [String: ShipInfo] = [:]
        for o in orders {
            var s = order(id: o.id)?.ship ?? o.ship ?? ShipInfo()
            s.state = ShipState.exported.rawValue
            s.exportedAt = ms
            s.batchId = batch
            s.vtpCode = code
            s.vtpFee = fee
            // Số máy chủ đã gửi Viettel Post; máy chủ bản cũ không trả thì giữ số đang có.
            if let cod { s.vtpCod = cod }
            if let goods { s.vtpGoods = goods }
            s.vtpService = service
            s.vtpStatus = 0
            s.vtpStatusName = "Chờ lấy hàng"
            s.vtpStatusAt = ms
            s.vtpKind = "created"
            s.vtpNote = nil
            s.vtpError = nil
            s.vtpErrorAt = nil
            if fromDraft {
                s.draftCode = nil
                s.draftAt = nil
                s.draftHash = nil
                s.draftAccount = nil
                s.draftError = nil
                s.draftErrorAt = nil
            }
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
            s.readyAt = (Clock.now.timeIntervalSince1970 * 1000).rounded()
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
