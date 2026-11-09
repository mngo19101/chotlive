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
    /// Mã sản phẩm. nil = dữ liệu cũ, lấy từ nội dung bình luận.
    var code: String? = nil
    /// Bình luận sinh ra món này (1 bình luận có thể chốt nhiều mã). nil = dữ liệu cũ: id chính là id bình luận.
    var commentId: String? = nil
    /// Thông tin giao Viettel Post của đơn chứa món này (giống `order.ship` của web); các món cùng đơn giữ cùng giá trị.
    var ship: ShipInfo? = nil
    /// Mã đơn do server cấp ("HD26110901"), ghi vào cột mã đơn của file Viettel Post.
    var orderCode: String? = nil

    var lineTotal: Int { price * max(qty, 1) }

    /// Mã để hiển thị và sửa.
    var codeText: String {
        get { code ?? PriceParser.orderTokens(comment).first?.code ?? comment }
        set { code = newValue }
    }

    /// "Mã 150"; bình luận không có mã thì giữ nguyên nội dung bình luận.
    var productLabel: String {
        let c = codeText
        return c == comment && c.contains(" ") ? c : "Mã \(c)"
    }

    /// Nội dung in trên tem: bình luận chốt nhiều mã thì mỗi tem chỉ ghi mã của tem đó.
    var ticketText: String {
        comment.isEmpty || PriceParser.orderTokens(comment).count > 1 ? productLabel : comment
    }

    init(id: String, comment: String, price: Int, ts: Date, printed: Bool = false, delivered: Bool = false,
         shipping: Bool = false, qty: Int = 1, sessionId: String? = nil, groupId: String? = nil,
         code: String? = nil, commentId: String? = nil) {
        self.id = id; self.comment = comment; self.price = price; self.ts = ts
        self.printed = printed; self.delivered = delivered; self.shipping = shipping
        self.qty = qty; self.sessionId = sessionId; self.groupId = groupId
        self.code = code; self.commentId = commentId
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
        code = try c.decodeIfPresent(String.self, forKey: .code)
        commentId = try c.decodeIfPresent(String.self, forKey: .commentId)
        ship = try? c.decodeIfPresent(ShipInfo.self, forKey: .ship)
        orderCode = try? c.decodeIfPresent(String.self, forKey: .orderCode)
    }
}

/// Thông tin giao của đơn, cùng JSON với `order.ship` trên web (public/js/vtp-export.js):
/// state ask | hold | ready | exported; pay cod | paid; payer receiver | sender;
/// deposit, shipFee, codOverride (đồng), weightG (gram), exportedAt (mili giây).
struct ShipInfo: Codable, Equatable {
    var state: String? = nil
    var pay: String? = nil
    var payer: String? = nil
    var deposit: Int? = nil
    var shipFee: Int? = nil
    var codOverride: Int? = nil
    var weightG: Int? = nil
    var exportedAt: Double? = nil
    var batchId: String? = nil
    /// Kích thước kiện (cm), bắt buộc khi nặng từ 10kg.
    var lengthCm: Int? = nil
    var widthCm: Int? = nil
    var heightCm: Int? = nil
    // Vận đơn Viettel Post tạo qua API: máy chủ ghi, app chỉ đọc (gửi lên máy chủ cũng bỏ qua).
    var vtpCode: String? = nil
    /// Mã vận đơn đã huỷ, để tra lại; đơn về Chờ gửi.
    var vtpOldCode: String? = nil
    var vtpFee: Int? = nil
    var vtpService: String? = nil
    var vtpStatus: Int? = nil
    var vtpStatusName: String? = nil
    var vtpStatusAt: Double? = nil
    /// created | moving | delivered | cancelled | returned | attention
    var vtpKind: String? = nil
    var vtpNote: String? = nil
    /// Lý do Viettel Post từ chối lần tạo vận đơn gần nhất.
    var vtpError: String? = nil
    var vtpErrorAt: Double? = nil

    init(state: String? = nil, pay: String? = nil, payer: String? = nil, deposit: Int? = nil, shipFee: Int? = nil,
         codOverride: Int? = nil, weightG: Int? = nil, exportedAt: Double? = nil, batchId: String? = nil,
         lengthCm: Int? = nil, widthCm: Int? = nil, heightCm: Int? = nil) {
        self.state = state; self.pay = pay; self.payer = payer; self.deposit = deposit; self.shipFee = shipFee
        self.codOverride = codOverride; self.weightG = weightG; self.exportedAt = exportedAt; self.batchId = batchId
        self.lengthCm = lengthCm; self.widthCm = widthCm; self.heightCm = heightCm
    }

    private enum CodingKeys: String, CodingKey {
        case state, pay, payer, deposit, shipFee, codOverride, weightG, exportedAt, batchId, lengthCm, widthCm, heightCm
        case vtpCode, vtpOldCode, vtpFee, vtpService, vtpStatus, vtpStatusName, vtpStatusAt, vtpKind, vtpNote, vtpError, vtpErrorAt
    }

    private static func text(_ c: KeyedDecodingContainer<CodingKeys>, _ key: CodingKeys) -> String? {
        if let s = try? c.decodeIfPresent(String.self, forKey: key) { return s.isEmpty ? nil : s }
        if let n = try? c.decodeIfPresent(Double.self, forKey: key), n.isFinite, abs(n) < 1e15 { return String(Int64(n)) }
        return nil
    }

    /// Web có thể lưu số dạng chuỗi hoặc số lẻ: đọc được thì lấy, không thì bỏ qua thay vì làm hỏng cả gói.
    private static func number(_ c: KeyedDecodingContainer<CodingKeys>, _ key: CodingKeys) -> Double? {
        if let v = try? c.decodeIfPresent(Double.self, forKey: key) { return v.isFinite ? v : nil }
        if let s = try? c.decodeIfPresent(String.self, forKey: key) { return Double(s.trimmingCharacters(in: .whitespaces)) }
        return nil
    }

    private static func money(_ v: Double?) -> Int? { v.map { max(0, Int($0.rounded())) } }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        state = try? c.decodeIfPresent(String.self, forKey: .state)
        pay = try? c.decodeIfPresent(String.self, forKey: .pay)
        payer = try? c.decodeIfPresent(String.self, forKey: .payer)
        deposit = Self.money(Self.number(c, .deposit))
        shipFee = Self.money(Self.number(c, .shipFee))
        codOverride = Self.money(Self.number(c, .codOverride))
        weightG = Self.money(Self.number(c, .weightG))
        exportedAt = Self.number(c, .exportedAt)
        batchId = try? c.decodeIfPresent(String.self, forKey: .batchId)
        lengthCm = Self.money(Self.number(c, .lengthCm))
        widthCm = Self.money(Self.number(c, .widthCm))
        heightCm = Self.money(Self.number(c, .heightCm))
        vtpCode = Self.text(c, .vtpCode)
        vtpOldCode = Self.text(c, .vtpOldCode)
        vtpFee = Self.money(Self.number(c, .vtpFee))
        vtpService = Self.text(c, .vtpService)
        vtpStatus = Self.number(c, .vtpStatus).flatMap { $0.isFinite && abs($0) < 1e9 ? Int($0) : nil }
        vtpStatusName = Self.text(c, .vtpStatusName)
        vtpStatusAt = Self.number(c, .vtpStatusAt)
        vtpKind = Self.text(c, .vtpKind)
        vtpNote = Self.text(c, .vtpNote)
        vtpError = Self.text(c, .vtpError)
        vtpErrorAt = Self.number(c, .vtpErrorAt)
    }

    /// Ghi cả giá trị rỗng (null) để server xoá đúng trường đã bỏ, ví dụ COD nhập tay.
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(state, forKey: .state)
        try c.encode(pay, forKey: .pay)
        try c.encode(payer, forKey: .payer)
        try c.encode(deposit, forKey: .deposit)
        try c.encode(shipFee, forKey: .shipFee)
        try c.encode(codOverride, forKey: .codOverride)
        try c.encode(weightG, forKey: .weightG)
        try c.encode(exportedAt, forKey: .exportedAt)
        try c.encode(batchId, forKey: .batchId)
        try c.encode(lengthCm, forKey: .lengthCm)
        try c.encode(widthCm, forKey: .widthCm)
        try c.encode(heightCm, forKey: .heightCm)
        // Máy chủ không nhận các trường vận đơn từ app; chỉ lưu trên máy và để máy chủ biết app đang giữ mã nào.
        try c.encodeIfPresent(vtpCode, forKey: .vtpCode)
        try c.encodeIfPresent(vtpOldCode, forKey: .vtpOldCode)
        try c.encodeIfPresent(vtpFee, forKey: .vtpFee)
        try c.encodeIfPresent(vtpService, forKey: .vtpService)
        try c.encodeIfPresent(vtpStatus, forKey: .vtpStatus)
        try c.encodeIfPresent(vtpStatusName, forKey: .vtpStatusName)
        try c.encodeIfPresent(vtpStatusAt, forKey: .vtpStatusAt)
        try c.encodeIfPresent(vtpKind, forKey: .vtpKind)
        try c.encodeIfPresent(vtpNote, forKey: .vtpNote)
        try c.encodeIfPresent(vtpError, forKey: .vtpError)
        try c.encodeIfPresent(vtpErrorAt, forKey: .vtpErrorAt)
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
    /// Món thêm sau khi duyệt chưa có `ship`: lấy theo món đã có.
    var ship: ShipInfo? { items.first { $0.ship != nil }?.ship }
    var code: String? { items.compactMap(\.orderCode).first }

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

    /// Các lựa chọn ghi chú giao trên màn Sửa địa chỉ.
    static let noteOptions = ["Giao giờ hành chính", "Gọi trước khi giao", "Cho xem hàng"]

    private static func noteParts(_ note: String) -> [String] {
        note.components(separatedBy: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }

    func hasNote(_ option: String) -> Bool {
        Self.noteParts(note).contains { $0.caseInsensitiveCompare(option) == .orderedSame }
    }

    /// Bật / tắt một lựa chọn; ghi chú khác đã có trong dữ liệu vẫn được giữ.
    /// Kết quả dạng "Giao giờ hành chính, gọi trước khi giao".
    mutating func toggleNote(_ option: String) {
        let parts = Self.noteParts(note)
        let isOption: (String) -> Bool = { p in Self.noteOptions.contains { $0.caseInsensitiveCompare(p) == .orderedSame } }
        var chosen = Self.noteOptions.filter { o in parts.contains { $0.caseInsensitiveCompare(o) == .orderedSame } }
        if let i = chosen.firstIndex(of: option) { chosen.remove(at: i) } else { chosen.append(option) }
        let picked = chosen
        let all: [String] = Self.noteOptions.filter { picked.contains($0) } + parts.filter { !isOption($0) }
        var result: [String] = []
        for (i, p) in all.enumerated() {
            if i > 0, isOption(p), let first = p.first {
                result.append(first.lowercased() + String(p.dropFirst()))
            } else {
                result.append(p)
            }
        }
        note = result.joined(separator: ", ")
    }
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
    if words.count >= 2, let first = words.first?.first, let last = words.last?.first {
        return String([first, last]).uppercased()
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
    /// nil: file của bản chưa đồng bộ, toàn bộ dữ liệu trên máy sẽ được gửi lên ở lần nối đầu tiên.
    var sync: SyncState?

    init(comments: [LiveComment], customers: [Customer], sessions: [LiveSession], accounts: [TikTokAccount],
         activeAccountId: String?, keywords: [String]?, sync: SyncState? = nil) {
        self.comments = comments; self.customers = customers; self.sessions = sessions
        self.accounts = accounts; self.activeAccountId = activeAccountId; self.keywords = keywords
        self.sync = sync
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
        sync = try c.decodeIfPresent(SyncState.self, forKey: .sync)
    }
}
