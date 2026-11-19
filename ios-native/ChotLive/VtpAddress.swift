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

    /// Cache an toàn đa luồng; không giữ khoá khi chạy `compute()` vì các hàm chuẩn hoá gọi lồng nhau.
    private final class Cache<K: Hashable, V> {
        private let lock = NSLock()
        private var map: [K: V] = [:]
        private let limit: Int

        init(limit: Int = 20_000) { self.limit = limit }

        func get(_ key: K, compute: () -> V) -> V {
            lock.lock()
            if let hit = map[key] {
                lock.unlock()
                return hit
            }
            lock.unlock()
            let value = compute()
            lock.lock()
            if map.count >= limit { map.removeAll(keepingCapacity: true) }
            map[key] = value
            lock.unlock()
            return value
        }
    }

    private struct ResolveKey: Hashable {
        let province: String
        let district: String
        let ward: String
        let street: String
    }

    private static let provincePrefixRe = try! NSRegularExpression(pattern: #"^(thanh pho|tinh|tp\.?|t\.)\s*"#)
    private static let nonWordRe = try! NSRegularExpression(pattern: #"[^a-z0-9]+"#)
    private static let leadingZeroRe = try! NSRegularExpression(pattern: #"\b0+(\d)"#)
    private static let spacesRe = try! NSRegularExpression(pattern: #"\s+"#)
    private static let oldPrefixRegexes = [
        #"^(thanh pho|tp)\s+"#, #"^(tinh|t)\s+"#, #"^(quan|q)\s+"#, #"^(huyen|h)\s+"#,
        #"^(thi xa|tx)\s+"#, #"^(phuong|p)\s+"#, #"^(thi tran|tt)\s+"#, #"^(xa|x)\s+"#
    ].map { try! NSRegularExpression(pattern: $0) }
    private static let kindRegexes: [(NSRegularExpression, String)] = [
        (#"^(thanh pho|tp)\b"#, "tp"), (#"^(tinh|t)\b"#, "t"), (#"^(quan|q)\b"#, "q"), (#"^(huyen|h)\b"#, "h"),
        (#"^(thi xa|tx)\b"#, "tx"), (#"^(phuong|p)\b"#, "p"), (#"^(thi tran|tt)\b"#, "tt"), (#"^(xa|x)\b"#, "x")
    ].map { (try! NSRegularExpression(pattern: $0.0), $0.1) }

    private static let normalizeCache = Cache<String, String>()
    private static let kindCache = Cache<String, String>()
    private static let oldKeyCache = Cache<String, String>()
    private static let plainKeyCache = Cache<String, String>()
    private static let resolveCache = Cache<ResolveKey, Resolved>(limit: 2_000)

    private static func replace(_ s: String, _ re: NSRegularExpression, _ with: String) -> String {
        re.stringByReplacingMatches(in: s, range: NSRange(location: 0, length: (s as NSString).length), withTemplate: with)
    }

    /// Bỏ dấu, viết thường, bỏ tiền tố tỉnh/thành để so khớp tên gõ tay.
    static func normalize(_ s: String) -> String {
        normalizeCache.get(s) {
            var n = s.decomposedStringWithCanonicalMapping
            n = String(String.UnicodeScalarView(n.unicodeScalars.filter { !(0x300...0x36F).contains($0.value) }))
            n = n.replacingOccurrences(of: "đ", with: "d").replacingOccurrences(of: "Đ", with: "D").lowercased()
            n = replace(n, provincePrefixRe, "")
            n = replace(n, nonWordRe, " ")
            return n.trimmingCharacters(in: .whitespaces)
        }
    }

    private static func matches(_ s: String, _ re: NSRegularExpression) -> Bool {
        re.firstMatch(in: s, range: NSRange(location: 0, length: (s as NSString).length)) != nil
    }

    /// Chữ "Ð" (eth) Viettel Post dùng trong vài tên tỉnh coi như "Đ".
    private static func fixEth(_ s: String) -> String { s.replacingOccurrences(of: "Ð", with: "Đ") }

    /// Loại cấp hành chính để "Quận 1" không khớp nhầm "H.1".
    static func kind(_ s: String) -> String {
        kindCache.get(s) {
            let n = normalize(s.replacingOccurrences(of: ".", with: ". "))
            return kindRegexes.first { matches(n, $0.0) }?.1 ?? ""
        }
    }

    /// Tên bỏ dấu, bỏ tiền tố cấp, "Phường 01" = "P.1".
    static func oldKey(_ s: String) -> String {
        oldKeyCache.get(s) {
            var n = normalize(fixEth(s).replacingOccurrences(of: ".", with: ". "))
            if let p = oldPrefixRegexes.first(where: { matches(n, $0) }) { n = replace(n, p, "") }
            n = replace(n, leadingZeroRe, "$1")
            n = replace(n, spacesRe, " ")
            return n.trimmingCharacters(in: .whitespaces)
        }
    }

    private static func plainKey(_ s: String) -> String {
        plainKeyCache.get(s) { replace(normalize(fixEth(s)), leadingZeroRe, "$1") }
    }

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
        let normProv = normalize(province)
        let p = AddressBook.new.first { $0.n == province }
            ?? AddressBook.new.first { !normProv.isEmpty && normalize($0.n) == normProv }
        guard let prov = p else { return nil }
        let wards = prov.w ?? []
        if wards.contains(ward) { return (prov.n, ward) }
        let normWard = normalize(ward)
        if let hit = wards.first(where: { normalize($0) == normWard }) { return (prov.n, hit) }
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
        resolveCache.get(ResolveKey(province: province, district: district, ward: ward, street: street)) {
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
}
