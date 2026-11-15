import Foundation

/// Bắt giá từ bình luận (port từ public/js/price.js). "59" -> 59.000, "5k" -> 5.000, "1tr2" -> 1.200.000.
enum PriceParser {
    private static let regex = try! NSRegularExpression(
        pattern: #"(?<![a-z\d])(\d{1,3}(?:[.,]\d{3})+|\d+(?:[.,]\d+)?)\s*(k|tr(?:ieu)?|cu|nghin|ngan|vnd|d)?(\d{1,3})?(?![a-z\d])"#
    )
    private static let grouped = try! NSRegularExpression(pattern: #"^\d{1,3}(?:[.,]\d{3})+$"#)
    /// Số điện thoại Việt Nam (0… hoặc +84…), kể cả viết tách: "0912 345 678", "098.812.3456".
    /// Phải đủ 10-11 số. Giống PHONE_RE của public/js/price.js.
    private static let phone = try! NSRegularExpression(
        pattern: #"(?<!\d)(?:\+84[\s.-]{0,3}|0)\d{2,3}[\s.-]{0,3}\d{3,4}[\s.-]{0,3}\d{3,4}(?!\d)"#
    )

    /// Thay số điện thoại bằng "#" (giữ nguyên độ dài) để phần bắt giá không đọc nhầm thành giá.
    private static func maskPhones(_ s: String) -> String {
        let ns = NSMutableString(string: s)
        for m in phone.matches(in: s, range: NSRange(location: 0, length: ns.length)) {
            let raw = ns.substring(with: m.range)
            let digits = raw.filter { $0.isASCII && $0.isNumber }.count - (raw.hasPrefix("+") ? 1 : 0)
            if digits == 10 || digits == 11 {
                ns.replaceCharacters(in: m.range, with: String(repeating: "#", count: m.range.length))
            }
        }
        return ns as String
    }

    /// Số ngay sau "size", "sz", "sl", "số lượng" là size/số lượng: "size 38", "sl: 2".
    private static let sizeQtyBefore = try! NSRegularExpression(pattern: #"(?<![a-z\d])(?:size|sz|sl|so luong)\s*:?\s*$"#)
    /// Số 1-2 chữ số ngay trước "cái", "đôi", "kg"... là số lượng/cân nặng: "lấy 2 cái", "50 kg".
    private static let qtyAfter = try! NSRegularExpression(
        pattern: #"^\s*(?:cai|chiec|doi|bo|hop|set|kg|sp|goi|cap|chai|tui|lo|cuon)(?![a-z\d])"#
    )
    /// Có "mã" đứng trước thì vẫn là mã: "mã 99 bộ đồ".
    private static let codeBefore = try! NSRegularExpression(pattern: #"(?<![a-z\d])ma\s*$"#)
    private static let oneOrTwoDigits = try! NSRegularExpression(pattern: #"^\d{1,2}$"#)

    private static func has(_ re: NSRegularExpression, _ s: String) -> Bool {
        re.firstMatch(in: s, range: NSRange(location: 0, length: (s as NSString).length)) != nil
    }

    /// Số ở vị trí `range` của ns là size hoặc số lượng, không phải giá. Giống isSizeOrQty của public/js/price.js.
    private static func isSizeOrQty(_ ns: NSString, _ range: NSRange, rawNum: String, unit: String) -> Bool {
        if !unit.isEmpty { return false }
        let before = ns.substring(to: range.location)
        if has(sizeQtyBefore, before) { return true }
        return has(oneOrTwoDigits, rawNum) && has(qtyAfter, ns.substring(from: range.location + range.length))
            && !has(codeBefore, before)
    }

    static func stripAccents(_ s: String) -> String {
        s.folding(options: .diacriticInsensitive, locale: Locale(identifier: "en"))
            .replacingOccurrences(of: "đ", with: "d")
            .replacingOccurrences(of: "Đ", with: "D")
    }

    /// Một số/giá tìm thấy trong bình luận.
    struct Token {
        var range: NSRange
        var code: String
        var price: Int
    }

    /// Trả về giá (đồng) hoặc 0 nếu không có giá.
    static func parse(_ text: String, multiplier: Double = 1000, minPrice: Double = 1, maxPrice: Double = 50_000_000) -> Int {
        tokens(text, multiplier: multiplier, minPrice: minPrice, maxPrice: maxPrice).map(\.price).max() ?? 0
    }

    private static func folded(_ text: String) -> String { stripAccents(text.precomposedStringWithCanonicalMapping.lowercased()) }

    /// Mọi số/giá trong bình luận, theo thứ tự xuất hiện.
    static func tokens(_ text: String, multiplier: Double = 1000, minPrice: Double = 1, maxPrice: Double = 50_000_000) -> [Token] {
        let s = maskPhones(folded(text))
        let ns = s as NSString
        var found: [Token] = []

        for m in regex.matches(in: s, range: NSRange(location: 0, length: ns.length)) {
            func group(_ i: Int) -> String {
                let r = m.range(at: i)
                return r.location == NSNotFound ? "" : ns.substring(with: r)
            }
            let rawNum = group(1), unit = group(2), trail = group(3)
            let digitsOnly = rawNum.replacingOccurrences(of: ".", with: "").replacingOccurrences(of: ",", with: "")
            if digitsOnly.count >= 9 { continue } // số điện thoại / mã đơn
            if isSizeOrQty(ns, m.range, rawNum: rawNum, unit: unit) { continue }

            let isGrouped = grouped.firstMatch(in: rawNum, range: NSRange(location: 0, length: (rawNum as NSString).length)) != nil
            // "2.500k" là 2.500 nghìn; riêng "1.500tr" vẫn đọc là 1,5 triệu.
            let bigUnit = ["tr", "trieu", "cu"].contains(unit)
            let n: Double
            if isGrouped && !bigUnit {
                n = Double(digitsOnly) ?? 0
            } else {
                n = Double(rawNum.replacingOccurrences(of: ",", with: ".")) ?? .nan
            }
            if n.isNaN { continue }

            var v: Double
            switch unit {
            case "k", "nghin", "ngan":
                if !trail.isEmpty { continue }
                v = n * 1000
            case "tr", "trieu", "cu":
                v = n * 1_000_000 + (trail.isEmpty ? 0 : (Double("0." + trail) ?? 0) * 1_000_000)
            default:
                if !trail.isEmpty { continue }
                v = n >= 1000 ? n : n * multiplier
            }
            v = v.rounded()
            if v < minPrice || v > maxPrice { continue }
            found.append(Token(range: m.range, code: rawNum + unit + trail, price: Int(v)))
        }
        return found
    }

    /// Các số đi liền nhau chỉ cách bởi "với", "và", dấu phẩy... ("120 với 180").
    private static let connector = try! NSRegularExpression(pattern: #"^\s*(?:[,;+&/-]|va|voi)?\s*(?:ma\s+)?$"#)
    private static let codePrefix = try! NSRegularExpression(pattern: #"(?<![a-z\d])ma\s+$"#)
    private static let fillers = try! NSRegularExpression(pattern: #"(?<![a-z\d])(?:ma|va|voi)(?![a-z\d])|[\s,;+&/.-]"#)

    /// Các mã khách chốt trong 1 bình luận: số có giá lớn nhất và các số nối liền với nó.
    /// Số nhỏ hơn 10k không tính vì thường là số lượng hoặc size ("lấy 2 cái 150").
    static func orderTokens(_ text: String) -> [Token] {
        let all = tokens(text)
        guard let best = all.indices.max(by: { all[$0].price < all[$1].price }) else { return [] }
        let ns = folded(text) as NSString
        func linked(_ a: Token, _ b: Token) -> Bool {
            let start = a.range.location + a.range.length
            let gap = ns.substring(with: NSRange(location: start, length: b.range.location - start))
            return connector.firstMatch(in: gap, range: NSRange(location: 0, length: (gap as NSString).length)) != nil
        }
        var from = best, to = best
        while from > 0, all[from - 1].price >= 10_000, linked(all[from - 1], all[from]) { from -= 1 }
        while to < all.count - 1, all[to + 1].price >= 10_000, linked(all[to], all[to + 1]) { to += 1 }
        return Array(all[from...to])
    }

    /// Bình luận chỉ ghi mã/giá, không có chữ nào khác ("280", "mã 150, 180").
    static func isOnlyCodes(_ text: String) -> Bool {
        let all = tokens(text)
        guard !all.isEmpty else { return false }
        let ns = folded(text) as NSString
        var rest = ""
        var cursor = 0
        for t in all {
            rest += ns.substring(with: NSRange(location: cursor, length: t.range.location - cursor)) + " "
            cursor = t.range.location + t.range.length
        }
        rest += ns.substring(from: cursor)
        let left = fillers.stringByReplacingMatches(in: rest, range: NSRange(location: 0, length: (rest as NSString).length), withTemplate: "")
        return left.isEmpty
    }

    struct Segment: Hashable {
        var text: String
        var isCode: Bool
    }

    /// Tách bình luận thành từng từ, phần mã ("Mã 150", "120") đứng riêng để tô nền.
    static func segments(_ text: String) -> [Segment] {
        let original = text.precomposedStringWithCanonicalMapping
        let s = folded(text)
        let words: (String) -> [Segment] = { $0.split(whereSeparator: \.isWhitespace).map { Segment(text: String($0), isCode: false) } }
        // Bỏ dấu làm đổi độ dài (rất hiếm) thì không tô để khỏi tô lệch chữ.
        guard s.utf16.count == original.utf16.count else { return words(original) }
        let ns = s as NSString, source = original as NSString
        var result: [Segment] = []
        var cursor = 0
        for t in orderTokens(text) {
            var start = t.range.location
            let before = ns.substring(with: NSRange(location: cursor, length: start - cursor))
            if let m = codePrefix.firstMatch(in: before, range: NSRange(location: 0, length: (before as NSString).length)) {
                start = cursor + m.range.location
            }
            result += words(source.substring(with: NSRange(location: cursor, length: start - cursor)))
            let end = t.range.location + t.range.length
            result.append(Segment(text: source.substring(with: NSRange(location: start, length: end - start)), isCode: true))
            cursor = end
        }
        return result + words(source.substring(from: cursor))
    }
}

private func groupedNumber(_ n: Int) -> String {
    let f = NumberFormatter()
    f.numberStyle = .decimal
    f.usesGroupingSeparator = true
    f.groupingSeparator = "."
    return f.string(from: NSNumber(value: n)) ?? "\(n)"
}

/// Dùng trên tem in.
func vnd(_ n: Int) -> String { groupedNumber(n) + "đ" }

/// Dùng trên giao diện: "4.860.000 ₫".
func money(_ n: Int) -> String { groupedNumber(n) + " ₫" }
