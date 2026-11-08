import Foundation

/// Đối chiếu địa chỉ của khách với danh mục Viettel Post, viết lại từ public/js/vtp-address(-old).js của web.
/// Có quận/huyện là địa chỉ cũ (3 cấp), không có là địa chỉ mới (2 cấp), giống công tắc trong bảng chọn khu vực.
enum VtpAddress {
    struct Resolved: Equatable {
        var ok = false
        var reason = ""
        var isOld = false
        var province = ""
        var district = ""
        var ward = ""
        var street = ""
        var newWard = ""
        var newProvince = ""

        /// "Số nhà, Phường, (Quận,) Tỉnh" đúng tên Viettel Post.
        var line: String { [street, ward, district, province].filter { !$0.isEmpty }.joined(separator: ", ") }
        /// "Cầu Giấy, Hà Nội": phần khu vực rút gọn để hiện trong danh sách.
        var shortArea: String {
            let parts = [district.isEmpty ? ward : district, province].filter { !$0.isEmpty }.map(Self.plainName)
            return parts.joined(separator: ", ")
        }

        static func plainName(_ s: String) -> String {
            for prefix in ["TP.", "T.", "Q.", "H.", "TX.", "P.", "X.", "TT.", "Phường ", "Xã ", "Đặc khu "] where s.hasPrefix(prefix) {
                return String(s.dropFirst(prefix.count))
            }
            return s
        }
    }

    // MARK: - So khớp tên

    private static func replace(_ s: String, _ pattern: String, _ with: String) -> String {
        s.replacingOccurrences(of: pattern, with: with, options: .regularExpression)
    }

    /// Bỏ dấu, viết thường, bỏ tiền tố tỉnh/thành để so khớp tên gõ tay.
    static func normalize(_ s: String) -> String {
        var n = s.decomposedStringWithCanonicalMapping
        n = String(String.UnicodeScalarView(n.unicodeScalars.filter { !(0x300...0x36F).contains($0.value) }))
        n = n.replacingOccurrences(of: "đ", with: "d").replacingOccurrences(of: "Đ", with: "D").lowercased()
        n = replace(n, "^(thanh pho|tinh|tp\\.?|t\\.)\\s*", "")
        n = replace(n, "[^a-z0-9]+", " ")
        return n.trimmingCharacters(in: .whitespaces)
    }

    private static let oldPrefixes = ["^(thanh pho|tp)\\s+", "^(tinh|t)\\s+", "^(quan|q)\\s+", "^(huyen|h)\\s+",
                                      "^(thi xa|tx)\\s+", "^(phuong|p)\\s+", "^(thi tran|tt)\\s+", "^(xa|x)\\s+"]
    private static let kinds: [(String, String)] = [
        ("^(thanh pho|tp)\\b", "tp"), ("^(tinh|t)\\b", "t"), ("^(quan|q)\\b", "q"), ("^(huyen|h)\\b", "h"),
        ("^(thi xa|tx)\\b", "tx"), ("^(phuong|p)\\b", "p"), ("^(thi tran|tt)\\b", "tt"), ("^(xa|x)\\b", "x")
    ]

    private static func matches(_ s: String, _ pattern: String) -> Bool {
        s.range(of: pattern, options: .regularExpression) != nil
    }

    /// Chữ "Ð" (eth) Viettel Post dùng trong vài tên tỉnh coi như "Đ".
    private static func fixEth(_ s: String) -> String { s.replacingOccurrences(of: "Ð", with: "Đ") }

    /// Loại cấp hành chính để "Quận 1" không khớp nhầm "H.1".
    static func kind(_ s: String) -> String {
        let n = normalize(s.replacingOccurrences(of: ".", with: ". "))
        return kinds.first { matches(n, $0.0) }?.1 ?? ""
    }

    /// Tên bỏ dấu, bỏ tiền tố cấp, "Phường 01" = "P.1".
    static func oldKey(_ s: String) -> String {
        var n = normalize(fixEth(s).replacingOccurrences(of: ".", with: ". "))
        if let p = oldPrefixes.first(where: { matches(n, $0) }) { n = replace(n, p, "") }
        n = replace(n, "\\b0+(\\d)", "$1")
        n = replace(n, "\\s+", " ")
        return n.trimmingCharacters(in: .whitespaces)
    }

    private static func plainKey(_ s: String) -> String { replace(normalize(fixEth(s)), "\\b0+(\\d)", "$1") }

    static func sameName(_ a: String, _ b: String) -> Bool {
        let ka = oldKey(a), kb = oldKey(b)
        return ka == kb || ka == plainKey(b) || plainKey(a) == kb
    }

    static func sameUnit(_ a: String, _ b: String, _ allowed: [String]? = nil) -> Bool {
        guard sameName(a, b) else { return false }
        let ka = kind(a), kb = kind(b)
        return ka.isEmpty || kb.isEmpty || ka == kb || (allowed.map { $0.contains(ka) && $0.contains(kb) } ?? false)
    }

    /// Đúng cấp trước; không có thì nhận khác cấp nếu tên chỉ có một ("X.Bình Khê" nay là "P.Bình Khê").
    private static func pick(_ names: [String], _ name: String) -> Int? {
        if let i = names.firstIndex(where: { sameUnit($0, name) }) { return i }
        let loose = names.indices.filter { sameName(names[$0], name) }
        return loose.count == 1 ? loose[0] : nil
    }

    // MARK: - Tìm trong danh mục

    struct OldMatch: Equatable {
        var province: String
        var district: String
        var ward: String
        var newWard: String
        var newProvince: String
    }

    static func findOld(province: String, district: String, ward: String) -> OldMatch? {
        guard !province.isEmpty, !district.isEmpty, !ward.isEmpty else { return nil }
        for p in AddressBook.old where sameUnit(p.n, province, ["t", "tp"]) {
            let districts = p.d ?? []
            guard let di = pick(districts.map(\.n), district) else { continue }
            let d = districts[di]
            let wards = d.w ?? []
            guard let wi = pick(wards, ward) else { continue }
            let equiv = (d.e ?? []).indices.contains(wi) ? d.e![wi] : ""
            let parts = equiv.components(separatedBy: ", ")
            return OldMatch(province: p.n, district: d.n, ward: wards[wi],
                            newWard: parts.count == 2 ? parts[0] : "", newProvince: parts.count == 2 ? parts[1] : "")
        }
        return nil
    }

    static func findNew(province: String, ward: String) -> (province: String, ward: String)? {
        guard !ward.isEmpty else { return nil }
        let p = AddressBook.new.first { $0.n == province }
            ?? AddressBook.new.first { !normalize(province).isEmpty && normalize($0.n) == normalize(province) }
        guard let prov = p else { return nil }
        let wards = prov.w ?? []
        if wards.contains(ward) { return (prov.n, ward) }
        if let hit = wards.first(where: { normalize($0) == normalize(ward) }) { return (prov.n, hit) }
        return nil
    }

    /// Tách "Phường, (Quận,) Tỉnh" đã lưu trong app.
    static func split(region: String) -> (ward: String, district: String, province: String) {
        var parts = region.components(separatedBy: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        let province = parts.popLast() ?? ""
        let district = parts.count >= 2 ? (parts.popLast() ?? "") : ""
        return (parts.joined(separator: ", "), district, province)
    }

    /// Địa chỉ có xuất sang Viettel Post được không, và viết ra sao.
    static func resolve(_ a: DeliveryAddress?) -> Resolved {
        let parts = split(region: a?.region ?? "")
        return resolve(province: parts.province, district: parts.district, ward: parts.ward, street: a?.street ?? "")
    }

    static func resolve(province: String, district: String, ward: String, street: String) -> Resolved {
        var out = Resolved()
        out.street = street.trimmingCharacters(in: .whitespacesAndNewlines)
        out.isOld = !district.trimmingCharacters(in: .whitespaces).isEmpty
        if out.isOld {
            guard let r = findOld(province: province, district: district, ward: ward) else {
                out.reason = "Địa chỉ cũ không có trong danh mục Viettel Post, chọn lại"
                return out
            }
            out.province = r.province; out.district = r.district; out.ward = r.ward
            out.newWard = r.newWard; out.newProvince = r.newProvince
        } else {
            guard !province.isEmpty else {
                out.reason = "Chưa chọn tỉnh/thành theo Viettel Post"
                return out
            }
            guard let r = findNew(province: province, ward: ward) else {
                out.reason = "Chưa chọn phường/xã theo Viettel Post"
                return out
            }
            out.province = r.province; out.ward = r.ward
        }
        guard !out.street.isEmpty else {
            out.reason = "Thiếu số nhà, tên đường"
            return out
        }
        out.ok = true
        return out
    }
}
