import Foundation

/// Duyệt đơn, gom đơn theo khách và xuất file Excel Viettel Post.
/// Viết lại đúng cách tính của web (public/js/vtp-export.js) để hai bên ra cùng tiền thu hộ và cùng file.
enum ShipState: String {
    /// Chưa duyệt (đơn mới).
    case ask
    /// Khách hẹn gom gửi sau.
    case hold
    /// Đã duyệt, chờ xuất Viettel Post.
    case ready
    /// Đã xuất file Viettel Post.
    case exported
    /// Đã chuyển Đang giao / Đã giao mà không qua file xuất.
    case gone

    var isPending: Bool { self == .ask || self == .hold || self == .ready }
}

enum Vtp {
    static let defaultWeightG = 1000
    /// Từ cân nặng này Viettel Post cần kích thước kiện (dài, rộng, cao).
    static let sizeRequiredG = 10_000
    /// Đơn thu hộ dưới mức này mà shop trả cước thì cộng phí ship vào tiền thu hộ.
    static let smallOrderLimit = 17_000
    static let smallOrderShipFee = 17_000
    /// Tên hàng hoá trên vận đơn: shop bán quần áo, không lấy tên/mã từ bình luận.
    static let goodsName = "Quần áo"

    /// Gói dịch vụ; mặc định Flashsale thỏa thuận (VSL9), giống web.
    static let services: [(code: String, name: String)] = [
        ("VSL9", "Flashsale thỏa thuận"),
        ("STK", "Chuyển phát tiêu chuẩn"),
        ("SCN", "Chuyển phát nhanh")
    ]
    static let defaultService = "VSL9"
    static let serviceKey = "vtpServiceCode"

    static func state(_ o: Order) -> ShipState {
        if o.status == .shipping || o.status == .delivered {
            return o.ship?.state == ShipState.exported.rawValue ? .exported : .gone
        }
        return ShipState(rawValue: o.ship?.state ?? "") ?? .ask
    }

    /// Đơn chưa gửi của cùng khách ở mọi ngày, cũ nhất trước.
    static func pendingOrders(of customerId: String, in orders: [Order]) -> [Order] {
        orders.filter { $0.customer.id == customerId && state($0).isPending }.sorted { $0.lastTs < $1.lastTs }
    }

    /// Đơn chưa gửi khác của khách, cũ hơn đơn đang xem: để hiện nhãn "Có N đơn gom từ dd/mm".
    static func olderPending(_ order: Order, in orders: [Order]) -> [Order] {
        pendingOrders(of: order.customer.id, in: orders).filter { $0.id != order.id && $0.lastTs <= order.lastTs }
    }

    /// Đơn của khách đã xuất Viettel Post trong 3 ngày qua mà chưa giao xong: dễ thành 2 vận đơn.
    static func recentExported(of customerId: String, in orders: [Order], now: Date = Clock.now) -> [Order] {
        orders.filter {
            $0.customer.id == customerId && $0.status == .shipping && $0.ship?.state == ShipState.exported.rawValue
                && now.timeIntervalSince1970 * 1000 - ($0.ship?.exportedAt ?? 0) < 3 * 86_400_000
        }
    }

    // MARK: - Tính tiền một vận đơn

    /// Một đơn trong vận đơn: tiền hàng, số món và cài đặt giao (có thể là bản tính thử trong bảng Duyệt đơn).
    struct Line {
        var total: Int
        var qty: Int
        var ship: ShipInfo?
    }

    struct Summary {
        var allPaid = false
        var senderPays = false
        /// Phí ship đã cộng vào thu hộ (đơn nhỏ / bank đủ mà người nhận trả ship).
        var shipFee = 0
        var deposit = 0
        var autoCod = 0
        var codOverridden = false
        var goods = 0
        var cod = 0
        var weightG = Vtp.defaultWeightG
        /// Dài, rộng, cao (cm); nil khi chưa nhập.
        var size: (Int, Int, Int)? = nil
        var qty = 0
        var receiver = ""
        var phone = ""
        var address = VtpAddress.Resolved()
        var note = ""
        var problems: [String] = []
    }

    private static func last<T>(_ lines: [Line], _ field: (ShipInfo) -> T?) -> T? {
        for l in lines.reversed() { if let s = l.ship, let v = field(s) { return v } }
        return nil
    }

    /// `lines` cũ nhất trước: cài đặt của đơn mới nhất thắng, giống web.
    static func summarize(_ lines: [Line], address: DeliveryAddress?, nickname: String) -> Summary {
        var s = Summary()
        // "shipOnly": dữ liệu cũ của web, coi như đã bank.
        let goodsPaid = { (l: Line) in l.ship?.pay == "paid" || l.ship?.pay == "shipOnly" }
        s.allPaid = !lines.isEmpty && lines.allSatisfy(goodsPaid)
        s.goods = lines.reduce(0) { $0 + max(0, $1.total) }
        let unpaidRaw = lines.filter { !goodsPaid($0) }.reduce(0) { $0 + max(0, $1.total) }
        s.deposit = min(unpaidRaw, lines.reduce(0) { $0 + max(0, $1.ship?.deposit ?? 0) })
        let unpaid = unpaidRaw - s.deposit
        let fee = last(lines) { $0.shipFee } ?? smallOrderShipFee
        let payerRaw = last(lines) { ($0.payer ?? "").isEmpty ? nil : $0.payer }
        let payer = payerRaw == "sender" || payerRaw == "receiver" ? payerRaw! : (s.allPaid ? "sender" : "receiver")
        let override = last(lines) { $0.codOverride }

        // Đơn thu hộ dưới 17.000đ mà shop trả cước: khách trả lại phí ship qua tiền thu hộ.
        let small = !s.allPaid && unpaid < smallOrderLimit
        // Đã bank đủ mà người nhận trả ship: Viettel Post báo lỗi khi COD 0đ + người nhận trả,
        // nên xuất thành người gửi trả cước và thu hộ đúng phí ship.
        let bankShipByReceiver = s.allPaid && payer == "receiver"
        s.senderPays = payer == "sender" || bankShipByReceiver
        let addFee = bankShipByReceiver || (small && s.senderPays)
        s.autoCod = (s.allPaid ? 0 : unpaid) + (addFee ? fee : 0)
        s.cod = override ?? s.autoCod
        s.codOverridden = override != nil
        s.shipFee = override == nil && addFee ? fee : 0
        s.weightG = lines.compactMap { $0.ship?.weightG }.filter { $0 > 0 }.max() ?? defaultWeightG
        s.qty = lines.reduce(0) { $0 + $1.qty }
        if let l = last(lines, { $0.lengthCm }), let w = last(lines, { $0.widthCm }), let h = last(lines, { $0.heightCm }),
           l > 0, w > 0, h > 0 {
            s.size = (l, w, h)
        }

        s.address = VtpAddress.resolve(address)
        s.receiver = cleanName((address?.receiver ?? "").isEmpty ? nickname : address!.receiver)
        s.phone = (address?.phone ?? "").filter { $0.isNumber || $0 == "+" }
        s.note = address?.note ?? ""
        if s.phone.range(of: "^(\\+?84|0)\\d{9,10}$", options: .regularExpression) == nil {
            s.problems.append("Thiếu số điện thoại")
        }
        if !s.address.ok { s.problems.append(s.address.reason) }
        if s.weightG >= sizeRequiredG && s.size == nil { s.problems.append("Từ 10kg phải nhập kích thước") }
        return s
    }

    static func lines(_ orders: [Order]) -> [Line] {
        orders.map { Line(total: $0.total, qty: $0.productCount, ship: $0.ship) }
    }

    /// Viettel Post không nhận emoji/ký tự lạ trong tên người nhận.
    static func cleanName(_ s: String) -> String {
        var n = s.precomposedStringWithCanonicalMapping
        n = n.replacingOccurrences(of: "[^\\p{L}\\p{N}\\s.'-]", with: " ", options: .regularExpression)
        n = n.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        return n.trimmingCharacters(in: .whitespaces)
    }

    // MARK: - Gom theo khách

    /// Một khách = một vận đơn: mọi đơn ĐÃ DUYỆT của khách ở mọi ngày gộp lại.
    struct Group: Identifiable {
        var customer: Customer
        var orders: [Order]
        var recentExported: [Order]
        var summary: Summary

        var id: String { customer.id }
        var isBad: Bool { !summary.problems.isEmpty }
    }

    static func readyGroups(_ all: [Order], now: Date = Clock.now) -> [Group] {
        let ready = all.filter { state($0) == .ready }
        let byCustomer = Dictionary(grouping: ready) { $0.customer.id }
        return byCustomer.values.map { list -> Group in
            let orders = list.sorted { $0.lastTs < $1.lastTs }
            let c = orders[0].customer
            return Group(customer: c, orders: orders,
                         recentExported: recentExported(of: c.id, in: all, now: now),
                         summary: summarize(lines(orders), address: c.address, nickname: c.nickname))
        }
        .sorted { $0.orders[0].lastTs < $1.orders[0].lastTs }
    }

    // MARK: - File Excel

    static let headers = [
        "STT", "Mã đơn hàng ", "Tên người nhận (*)", "Số ĐT người nhận (*)", "Địa chỉ nhận (*)", "Tên hàng hóa (*)",
        "Số lượng", "Trọng lượng (gram)  (*)", "Giá trị hàng (VND) (*)", "Tiền thu hộ COD (VND)", "Loại hàng hóa (*)",
        "Tính chất hàng hóa đặc biệt", "Dịch vụ  (*)", "Dịch vụ cộng thêm ", "Thu tiền xem hàng", "Dài (cm)", "Rộng (cm)",
        "Cao (cm)", "Người trả cước", "Yêu cầu khác", "Thời gian hẹn lấy", "Thời gian giao"
    ]

    enum Cell: Equatable {
        case text(String)
        case number(Int)
    }

    /// Các dòng của trang tính, bố cục giống hệt file mẫu của Viettel Post (tiêu đề cột ở dòng 7).
    static func rows(_ groups: [Group], service: String = defaultService) -> [[Cell?]] {
        func t(_ s: String) -> Cell { .text(s) }
        var rows: [[Cell?]] = [
            [],
            [nil, nil, nil, t("TẬP ĐOÀN CÔNG NGHIỆP - VIỄN THÔNG QUÂN ĐỘI")],
            [nil, nil, nil, t("TỔNG CÔNG TY CỔ PHẦN BƯU CHÍNH VIETTEL")],
            [],
            [nil, nil, nil, nil, nil, t("DANH SÁCH ĐƠN HÀNG")],
            [t("(*) là các trường bắt buộc nhập")],
            headers.map { t($0) }
        ]
        for (i, g) in groups.enumerated() {
            let s = g.summary
            let codes = String(g.orders.compactMap(\.code).filter { !$0.isEmpty }.joined(separator: "+").prefix(50))
            let note = String(s.note.prefix(150))
            let size: [Cell?] = s.size.map { [Cell.number($0.0), Cell.number($0.1), Cell.number($0.2)] } ?? [nil, nil, nil]
            var row: [Cell?] = [Cell.number(i + 1)]
            row.append(codes.isEmpty ? nil : t(codes))
            row += [t(s.receiver), t(s.phone), t(s.address.line), t(goodsName)]
            row += [Cell.number(max(s.qty, 1)), Cell.number(s.weightG), Cell.number(s.goods), Cell.number(s.cod)]
            row += [t("Bưu kiện"), nil, t(service.isEmpty ? defaultService : service)]
            row += [nil, nil] // Dịch vụ cộng thêm: để trống, không SMS; Thu tiền xem hàng
            row += size // Dài, Rộng, Cao (cm)
            row.append(t(s.senderPays ? "Người gửi trả" : "Người nhận trả"))
            row.append(note.isEmpty ? nil : t(note))
            row += [nil, nil]
            rows.append(row)
        }
        return rows
    }

    static func fileName(_ now: Date = Clock.now) -> String {
        let c = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: now)
        return String(format: "ViettelPost_%04d%02d%02d_%02d%02d.xlsx", c.year ?? 0, c.month ?? 0, c.day ?? 0, c.hour ?? 0, c.minute ?? 0)
    }

    static func xlsx(_ groups: [Group], service: String = defaultService) -> Data {
        Xlsx.build(rows(groups, service: service), sheetName: "Danh sách",
                   colWidths: [6, 16, 22, 15, 48, 30, 9, 12, 14, 14, 12, 12, 14, 12, 10, 8, 8, 8, 16, 24, 16, 12])
    }
}

/// File .xlsx tối giản (gói ZIP lưu thẳng, chuỗi trong sharedStrings), giống public/js/xlsx-writer.js.
enum Xlsx {
    private static let crcTable: [UInt32] = (0..<256).map { n -> UInt32 in
        var c = UInt32(n)
        for _ in 0..<8 { c = c & 1 != 0 ? 0xEDB8_8320 ^ (c >> 1) : c >> 1 }
        return c
    }

    static func crc32(_ data: Data) -> UInt32 {
        var c: UInt32 = 0xFFFF_FFFF
        for b in data { c = crcTable[Int((c ^ UInt32(b)) & 0xFF)] ^ (c >> 8) }
        return c ^ 0xFFFF_FFFF
    }

    private static func le16(_ v: Int) -> [UInt8] { [UInt8(v & 0xFF), UInt8((v >> 8) & 0xFF)] }
    private static func le32(_ v: UInt32) -> [UInt8] { (0..<4).map { UInt8((v >> (8 * $0)) & 0xFF) } }

    static func zip(_ files: [(name: String, data: Data)]) -> Data {
        var out = Data()
        var central = Data()
        for f in files {
            let name = Data(f.name.utf8)
            let crc = crc32(f.data)
            let size = UInt32(f.data.count)
            let offset = UInt32(out.count)
            var local: [UInt8] = le32(0x0403_4B50) + le16(20) + le16(0x0800)
            local += le16(0) + le16(0) + le16(0) // lưu thẳng, không giờ
            local += le32(crc) + le32(size) + le32(size)
            local += le16(name.count) + le16(0)
            out.append(contentsOf: local)
            out.append(name)
            out.append(f.data)

            var cen: [UInt8] = le32(0x0201_4B50) + le16(20) + le16(20)
            cen += le16(0x0800) + le16(0) + le16(0) + le16(0)
            cen += le32(crc) + le32(size) + le32(size)
            cen += le16(name.count) + le16(0) + le16(0)
            cen += le16(0) + le16(0) + le32(0) + le32(offset)
            central.append(contentsOf: cen)
            central.append(name)
        }
        let centralOffset = UInt32(out.count)
        out.append(central)
        var end: [UInt8] = le32(0x0605_4B50) + le16(0) + le16(0)
        end += le16(files.count) + le16(files.count)
        end += le32(UInt32(central.count)) + le32(centralOffset) + le16(0)
        out.append(contentsOf: end)
        return out
    }

    static func escape(_ s: String) -> String {
        var out = ""
        for u in s.unicodeScalars {
            switch u.value {
            case 0x00...0x08, 0x0B, 0x0C, 0x0E...0x1F: continue // ký tự điều khiển làm hỏng XML của Excel
            case 0x26: out += "&amp;"
            case 0x3C: out += "&lt;"
            case 0x3E: out += "&gt;"
            case 0x22: out += "&quot;"
            default: out.unicodeScalars.append(u)
            }
        }
        return out
    }

    static func colName(_ i: Int) -> String {
        var s = ""
        var n = i + 1
        while n > 0 {
            s = String(UnicodeScalar(UInt8(65 + (n - 1) % 26))) + s
            n = (n - 1) / 26
        }
        return s
    }

    static func build(_ rows: [[Vtp.Cell?]], sheetName: String = "Sheet1", colWidths: [Int] = []) -> Data {
        var strings: [String] = []
        var index: [String: Int] = [:]
        func sid(_ s: String) -> Int {
            if let i = index[s] { return i }
            index[s] = strings.count
            strings.append(s)
            return strings.count - 1
        }

        var rowXml = ""
        for (r, row) in rows.enumerated() {
            var cells = ""
            for (c, cell) in row.enumerated() {
                guard let cell else { continue }
                let ref = "\(colName(c))\(r + 1)"
                switch cell {
                case .number(let n): cells += "<c r=\"\(ref)\"><v>\(n)</v></c>"
                case .text(let s):
                    if s.isEmpty { continue }
                    cells += "<c r=\"\(ref)\" t=\"s\"><v>\(sid(s))</v></c>"
                }
            }
            rowXml += "<row r=\"\(r + 1)\">\(cells)</row>"
        }

        let cols = colWidths.isEmpty ? "" : "<cols>" + colWidths.enumerated().map {
            "<col min=\"\($0.offset + 1)\" max=\"\($0.offset + 1)\" width=\"\($0.element)\" customWidth=\"1\"/>"
        }.joined() + "</cols>"
        let head = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n"
        let ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
        let rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
        let pkg = "http://schemas.openxmlformats.org/package/2006"
        let ct = "application/vnd.openxmlformats-officedocument.spreadsheetml"

        let sheet = head + "<worksheet xmlns=\"\(ns)\">\(cols)<sheetData>\(rowXml)</sheetData></worksheet>"
        let sst = head + "<sst xmlns=\"\(ns)\" count=\"\(strings.count)\" uniqueCount=\"\(strings.count)\">"
            + strings.map { "<si><t xml:space=\"preserve\">\(escape($0))</t></si>" }.joined() + "</sst>"

        let files: [(String, String)] = [
            ("[Content_Types].xml", head + "<Types xmlns=\"\(pkg)/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/xl/workbook.xml\" ContentType=\"\(ct).sheet.main+xml\"/><Override PartName=\"/xl/worksheets/sheet1.xml\" ContentType=\"\(ct).worksheet+xml\"/><Override PartName=\"/xl/sharedStrings.xml\" ContentType=\"\(ct).sharedStrings+xml\"/><Override PartName=\"/xl/styles.xml\" ContentType=\"\(ct).styles+xml\"/></Types>"),
            ("_rels/.rels", head + "<Relationships xmlns=\"\(pkg)/relationships\"><Relationship Id=\"rId1\" Type=\"\(rel)/officeDocument\" Target=\"xl/workbook.xml\"/></Relationships>"),
            ("xl/workbook.xml", head + "<workbook xmlns=\"\(ns)\" xmlns:r=\"\(rel)\"><sheets><sheet name=\"\(escape(sheetName))\" sheetId=\"1\" r:id=\"rId1\"/></sheets></workbook>"),
            ("xl/_rels/workbook.xml.rels", head + "<Relationships xmlns=\"\(pkg)/relationships\"><Relationship Id=\"rId1\" Type=\"\(rel)/worksheet\" Target=\"worksheets/sheet1.xml\"/><Relationship Id=\"rId2\" Type=\"\(rel)/sharedStrings\" Target=\"sharedStrings.xml\"/><Relationship Id=\"rId3\" Type=\"\(rel)/styles\" Target=\"styles.xml\"/></Relationships>"),
            ("xl/styles.xml", head + "<styleSheet xmlns=\"\(ns)\"><fonts count=\"1\"><font><sz val=\"11\"/><name val=\"Calibri\"/></font></fonts><fills count=\"2\"><fill><patternFill patternType=\"none\"/></fill><fill><patternFill patternType=\"gray125\"/></fill></fills><borders count=\"1\"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count=\"1\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\"/></cellStyleXfs><cellXfs count=\"1\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\"/></cellXfs></styleSheet>"),
            ("xl/worksheets/sheet1.xml", sheet),
            ("xl/sharedStrings.xml", sst)
        ]
        return zip(files.map { ($0.0, Data($0.1.utf8)) })
    }
}
