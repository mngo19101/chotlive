import Foundation

/// Dịch vụ cộng thêm và ghi chú vận đơn chọn ở bảng Duyệt đơn, làm giống trang tạo đơn viettelpost.vn.
enum VtpExtras {
    struct Service: Identifiable, Equatable {
        let code: String
        let name: String
        var id: String { code }
    }

    /// Đúng 11 dịch vụ trang tạo đơn viettelpost.vn cho shop tick, cùng thứ tự với app Viettel Post.
    /// Cùng danh sách với máy chủ (VTP_EXTRAS trong public/js/vtp-export.js); mã ngoài danh sách bị bỏ.
    static let all: [Service] = [
        Service(code: "GBH", name: "Khai giá"),
        Service(code: "GBP", name: "Báo phát"),
        Service(code: "GDK", name: "Đồng kiểm"),
        Service(code: "GG1P", name: "Giao một phần"),
        Service(code: "GGC", name: "Gia cố hàng hóa"),
        Service(code: "GGDH", name: "Đổi hàng"),
        Service(code: "GST", name: "Giao hàng đặc thù"),
        Service(code: "GTT", name: "Phát tận tay"),
        Service(code: "PTTX", name: "Phát tận tay xác thực"),
        Service(code: "SMS", name: "SMS thông báo đơn hàng"),
        Service(code: "ZNS", name: "Zalo thông báo đơn hàng")
    ]

    static func name(_ code: String) -> String { all.first { $0.code == code }?.name ?? code }

    /// "sms, GBH,xyz" → ["GBH", "SMS"]: chỉ mã trong danh sách, không trùng, theo thứ tự danh sách.
    static func clean(_ raw: String?) -> [String] {
        let picked = Set((raw ?? "").split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces).uppercased() })
        return all.map(\.code).filter { picked.contains($0) }
    }

    static func clean(_ codes: [String]) -> [String] { clean(codes.joined(separator: ",")) }

    /// Chuỗi lưu vào đơn và gửi Viettel Post; nil khi không chọn gì.
    static func joined(_ codes: [String]) -> String? {
        let c = clean(codes)
        return c.isEmpty ? nil : c.joined(separator: ",")
    }

    /// "Khai giá · Đồng kiểm · SMS"
    static func names(_ codes: [String]) -> String {
        clean(codes).map { $0 == "SMS" ? "SMS" : $0 == "ZNS" ? "Zalo" : name($0) }.joined(separator: " · ")
    }

    // MARK: - Mặc định cho đơn sau

    /// Bật "Mặc định chọn cho các đơn tiếp theo": đơn chưa duyệt lần nào được tick sẵn đúng các dịch vụ này.
    static let rememberKey = "vtpExtrasRemember"
    static let defaultKey = "vtpExtrasDefault"
    static let noteRememberKey = "vtpNoteRemember"
    static let noteDefaultKey = "vtpNoteDefault"

    // MARK: - Ghi chú

    /// 5 ghi chú mẫu Viettel Post cho mọi tài khoản; dùng khi chưa đăng nhập phần 2 nên chưa đọc được mẫu của tài khoản.
    static let defaultTemplates = [
        "Giao hàng một phần, nhận lại sản phẩm từ khách",
        "Hàng dễ vỡ, vui lòng nhẹ tay",
        "Gọi điện cho khách trước khi giao",
        "Giao hàng vào giờ hành chính",
        "Cho khách xem hàng"
    ]
    /// Mẫu đọc được lần gần nhất từ tài khoản Viettel Post (phần 2), để lần sau mở bảng có ngay.
    static let templatesKey = "vtpNoteTemplates"
    /// Viettel Post nối các mẫu đã chọn bằng "; " vào ô ghi chú.
    static let separator = "; "
    /// Viettel Post giới hạn ghi chú 150 BYTE (chữ có dấu tốn 2-3 byte), giống VtpDraftBody.clip.
    static let maxNoteBytes = 150

    static func bytes(_ s: String) -> Int { s.utf8.count }

    static func cleanText(_ s: String) -> String {
        s.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }

    /// Mẫu đã tick (theo thứ tự danh sách mẫu) rồi tới nội dung tự gõ, nối bằng "; ".
    static func compose(picks: [String], templates: [String], other: String) -> String {
        let chosen = templates.filter { picks.contains($0) } + picks.filter { !templates.contains($0) }
        let parts = chosen.map(cleanText) + [cleanText(other)]
        return parts.filter { !$0.isEmpty }.joined(separator: separator)
    }

    /// Tách ghi chú đã lưu: phần nào trùng một mẫu là mẫu đã tick, còn lại là nội dung khác.
    static func split(_ note: String, templates: [String]) -> (picks: [String], other: String) {
        let parts = note.components(separatedBy: ";").map(cleanText).filter { !$0.isEmpty }
        let keys = Dictionary(templates.map { (cleanText($0).lowercased(), $0) }, uniquingKeysWith: { a, _ in a })
        var picks: [String] = []
        var rest: [String] = []
        for p in parts {
            if let t = keys[p.lowercased()], !picks.contains(t) { picks.append(t) } else { rest.append(p) }
        }
        return (picks, rest.joined(separator: separator))
    }

    /// Đọc danh sách mẫu từ trả lời GET /api/user-notes/v1: [{ note, selected }] trong `data`.
    static func parseTemplates(_ json: Any?) -> (templates: [String], selected: [String])? {
        guard let d = json as? [String: Any], !VtpJ.bool(d["error"]), let arr = d["data"] as? [[String: Any]] else { return nil }
        var list: [String] = []
        var selected: [String] = []
        for item in arr where !VtpJ.bool(item["deleted"]) {
            let t = cleanText(VtpJ.str(item["note"]) ?? "")
            guard !t.isEmpty, !list.contains(t) else { continue }
            list.append(t)
            if VtpJ.bool(item["selected"]) { selected.append(t) }
        }
        return (list, selected)
    }
}
