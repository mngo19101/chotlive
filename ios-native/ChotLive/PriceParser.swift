import Foundation

/// Bắt giá từ bình luận (port từ public/js/price.js). "59" -> 59.000, "5k" -> 5.000, "1tr2" -> 1.200.000.
enum PriceParser {
    private static let regex = try! NSRegularExpression(
        pattern: #"(?<![a-z\d])(\d{1,3}(?:[.,]\d{3})+|\d+(?:[.,]\d+)?)\s*(k|tr(?:ieu)?|cu|nghin|ngan|vnd|d)?(\d{1,3})?(?![a-z\d])"#
    )
    private static let grouped = try! NSRegularExpression(pattern: #"^\d{1,3}(?:[.,]\d{3})+$"#)

    static func stripAccents(_ s: String) -> String {
        s.folding(options: .diacriticInsensitive, locale: Locale(identifier: "en"))
            .replacingOccurrences(of: "đ", with: "d")
            .replacingOccurrences(of: "Đ", with: "D")
    }

    /// Trả về giá (đồng) hoặc 0 nếu không có giá.
    static func parse(_ text: String, multiplier: Double = 1000, minPrice: Double = 1, maxPrice: Double = 50_000_000) -> Int {
        let s = stripAccents(text.lowercased())
        let ns = s as NSString
        var best: Double = 0

        for m in regex.matches(in: s, range: NSRange(location: 0, length: ns.length)) {
            func group(_ i: Int) -> String {
                let r = m.range(at: i)
                return r.location == NSNotFound ? "" : ns.substring(with: r)
            }
            let rawNum = group(1), unit = group(2), trail = group(3)
            let digitsOnly = rawNum.replacingOccurrences(of: ".", with: "").replacingOccurrences(of: ",", with: "")
            if digitsOnly.count >= 9 { continue } // số điện thoại / mã đơn

            let isGrouped = grouped.firstMatch(in: rawNum, range: NSRange(location: 0, length: (rawNum as NSString).length)) != nil
            let bigUnit = ["k", "tr", "trieu", "cu"].contains(unit)
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
            if v > best { best = v }
        }
        return Int(best)
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
