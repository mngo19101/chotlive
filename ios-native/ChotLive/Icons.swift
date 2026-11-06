import SwiftUI

// Hình dạng icon dựa trên bộ Lucide (giấy phép ISC, https://lucide.dev), vẽ trên lưới 24×24.

enum IconName {
    case chart, messageLines, message, users, bag, user, calendar, plus, minus, chevronLeft, chevronRight, chevronDown, chevronUp
    case arrowRight, arrowDown, radio, search, filter, printer, truck, more, check, tag, bell, help, logout, cart, trash, close, pencil, pin, stop

    fileprivate var paths: [String] {
        switch self {
        case .chart:
            return ["M1.5 20.5h21", "M7 20.5V12", "M12 20.5V5", "M17 20.5v-7"]
        case .messageLines:
            return ["M7.9 20A9 9 0 1 0 4 16.1L2 22Z", "M8 10h8", "M8 14h5"]
        case .message:
            return ["M7.9 20A9 9 0 1 0 4 16.1L2 22Z"]
        case .users:
            return ["M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2", circle(9, 7, 4),
                    "M22 21v-2a4 4 0 0 0-3-3.87", "M16 3.13a4 4 0 0 1 0 7.75"]
        case .bag:
            return ["M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z", "M3 6h18", "M16 10a4 4 0 0 1-8 0"]
        case .user:
            return ["M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2", circle(12, 7, 4)]
        case .calendar:
            return ["M8 2v4", "M16 2v4", "M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z", "M3 10h18"]
        case .plus:
            return ["M5 12h14", "M12 5v14"]
        case .minus:
            return ["M5 12h14"]
        case .chevronLeft:
            return ["M15 18 9 12 15 6"]
        case .chevronRight:
            return ["M9 18 15 12 9 6"]
        case .chevronDown:
            return ["M6 9 12 15 18 9"]
        case .chevronUp:
            return ["M18 15 12 9 6 15"]
        case .arrowRight:
            return ["M5 12h14", "M12 5 19 12 12 19"]
        case .arrowDown:
            return ["M12 5v14", "M19 12 12 19 5 12"]
        case .radio:
            return ["M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5", circle(12, 12, 2), "M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5"]
        case .search:
            return [circle(11, 11, 8), "M21 21 16.7 16.7"]
        case .filter:
            return ["M3 6h18", "M7 12h10", "M10 18h4"]
        case .printer:
            return ["M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2",
                    "M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6",
                    "M7 14h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1Z"]
        case .truck:
            return ["M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2", "M15 18H9",
                    "M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14",
                    circle(17, 18, 2), circle(7, 18, 2)]
        case .more:
            return [circle(5, 12, 1), circle(12, 12, 1), circle(19, 12, 1)]
        case .check:
            return ["M20 6 9 17 4 12"]
        case .tag:
            return ["M11.414 2.586A2 2 0 0 1 12.828 2H20a2 2 0 0 1 2 2v7.172a2 2 0 0 1-.586 1.414l-8.704 8.704a2.426 2.426 0 0 1-3.42 0l-6.58-6.58a2.426 2.426 0 0 1 0-3.42Z",
                    circle(16.5, 7.5, 0.5)]
        case .bell:
            return ["M10.268 21a2 2 0 0 0 3.464 0",
                    "M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"]
        case .help:
            return [circle(12, 12, 10), "M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3", "M12 17h.01"]
        case .logout:
            return ["M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4", "M16 17 21 12 16 7", "M21 12H9"]
        case .cart:
            return [circle(8, 21, 1), circle(19, 21, 1),
                    "M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12"]
        case .trash:
            return ["M3 6h18", "M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6", "M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2", "M10 11v6", "M14 11v6"]
        case .close:
            return ["M18 6 6 18", "M6 6 18 18"]
        case .pencil:
            return ["M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497Z"]
        case .pin:
            return ["M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0", circle(12, 10, 3)]
        case .stop:
            return ["M7 5h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z"]
        }
    }
}

private func circle(_ cx: Double, _ cy: Double, _ r: Double) -> String {
    "M\(cx - r) \(cy)A\(r) \(r) 0 1 0 \(cx + r) \(cy)A\(r) \(r) 0 1 0 \(cx - r) \(cy)Z"
}

struct Icon: View {
    let name: IconName
    var size: CGFloat = 20
    var weight: CGFloat = 2
    var color: Color = Theme.ink

    var body: some View {
        IconShape(paths: name.paths)
            .stroke(color, style: StrokeStyle(lineWidth: weight * size / 24, lineCap: .round, lineJoin: .round))
            .frame(width: size, height: size)
    }
}

private struct IconShape: Shape {
    let paths: [String]

    func path(in rect: CGRect) -> Path {
        var p = Path()
        for d in paths { SVGPath.append(d, to: &p) }
        let s = min(rect.width, rect.height) / 24
        return p.applying(CGAffineTransform(scaleX: s, y: s))
    }
}

/// Đọc chuỗi path kiểu SVG (M L H V C A Z, cả chữ hoa lẫn chữ thường).
private enum SVGPath {
    static func append(_ d: String, to path: inout Path) {
        var tokens = Scanner(d)
        var current = CGPoint.zero
        var start = CGPoint.zero
        var command: Character = "M"

        while let next = tokens.nextCommand(default: command) {
            command = next
            let relative = command.isLowercase
            func point(_ x: Double, _ y: Double) -> CGPoint {
                relative ? CGPoint(x: current.x + x, y: current.y + y) : CGPoint(x: x, y: y)
            }
            switch command.uppercased() {
            case "M":
                guard let x = tokens.number(), let y = tokens.number() else { return }
                current = point(x, y)
                start = current
                path.move(to: current)
                command = relative ? "l" : "L"
            case "L":
                guard let x = tokens.number(), let y = tokens.number() else { return }
                current = point(x, y)
                path.addLine(to: current)
            case "H":
                guard let x = tokens.number() else { return }
                current = CGPoint(x: relative ? current.x + x : x, y: current.y)
                path.addLine(to: current)
            case "V":
                guard let y = tokens.number() else { return }
                current = CGPoint(x: current.x, y: relative ? current.y + y : y)
                path.addLine(to: current)
            case "C":
                guard let x1 = tokens.number(), let y1 = tokens.number(),
                      let x2 = tokens.number(), let y2 = tokens.number(),
                      let x = tokens.number(), let y = tokens.number() else { return }
                let c1 = point(x1, y1), c2 = point(x2, y2), end = point(x, y)
                path.addCurve(to: end, control1: c1, control2: c2)
                current = end
            case "A":
                guard let rx = tokens.number(), let ry = tokens.number(), let rotation = tokens.number(),
                      let large = tokens.number(), let sweep = tokens.number(),
                      let x = tokens.number(), let y = tokens.number() else { return }
                let end = point(x, y)
                addArc(to: &path, from: current, to: end, rx: rx, ry: ry, rotation: rotation,
                       large: large != 0, sweep: sweep != 0)
                current = end
            case "Z":
                path.closeSubpath()
                current = start
            default:
                return
            }
        }
    }

    /// Chuyển cung SVG thành các đoạn bezier (theo phụ lục F.6 của đặc tả SVG).
    private static func addArc(to path: inout Path, from p0: CGPoint, to p1: CGPoint, rx rxIn: Double, ry ryIn: Double,
                               rotation: Double, large: Bool, sweep: Bool) {
        var rx = abs(rxIn), ry = abs(ryIn)
        guard rx > 0, ry > 0, p0 != p1 else {
            path.addLine(to: p1)
            return
        }
        let phi = rotation * .pi / 180
        let cosP = cos(phi), sinP = sin(phi)
        let dx = (Double(p0.x) - Double(p1.x)) / 2, dy = (Double(p0.y) - Double(p1.y)) / 2
        let x1 = cosP * dx + sinP * dy
        let y1 = -sinP * dx + cosP * dy

        let lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry)
        if lambda > 1 {
            rx *= lambda.squareRoot()
            ry *= lambda.squareRoot()
        }
        let numerator = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1
        let denominator = rx * rx * y1 * y1 + ry * ry * x1 * x1
        let factor = (large == sweep ? -1.0 : 1.0) * (max(numerator, 0) / denominator).squareRoot()
        let cxp = factor * rx * y1 / ry
        let cyp = -factor * ry * x1 / rx
        let cx = cosP * cxp - sinP * cyp + (Double(p0.x) + Double(p1.x)) / 2
        let cy = sinP * cxp + cosP * cyp + (Double(p0.y) + Double(p1.y)) / 2

        let theta = atan2((y1 - cyp) / ry, (x1 - cxp) / rx)
        var delta = atan2((-y1 - cyp) / ry, (-x1 - cxp) / rx) - theta
        if sweep && delta < 0 { delta += 2 * .pi }
        if !sweep && delta > 0 { delta -= 2 * .pi }

        let segments = max(Int(ceil(abs(delta) / (.pi / 2) - 1e-9)), 1)
        let step = delta / Double(segments)
        let t = 4.0 / 3.0 * tan(step / 4)
        var angle = theta

        func at(_ ux: Double, _ uy: Double) -> CGPoint {
            CGPoint(x: cosP * rx * ux - sinP * ry * uy + cx, y: sinP * rx * ux + cosP * ry * uy + cy)
        }
        for i in 0..<segments {
            let a2 = angle + step
            let c1 = at(cos(angle) - t * sin(angle), sin(angle) + t * cos(angle))
            let c2 = at(cos(a2) + t * sin(a2), sin(a2) - t * cos(a2))
            let end = i == segments - 1 ? p1 : at(cos(a2), sin(a2))
            path.addCurve(to: end, control1: c1, control2: c2)
            angle = a2
        }
    }

    private struct Scanner {
        private let chars: [Character]
        private var i = 0

        init(_ s: String) { chars = Array(s) }

        private mutating func skipSeparators() {
            while i < chars.count, chars[i] == " " || chars[i] == "," { i += 1 }
        }

        /// Trả về lệnh tiếp theo; nếu tiếp theo là số thì lặp lại lệnh trước (cú pháp SVG).
        mutating func nextCommand(default current: Character) -> Character? {
            skipSeparators()
            guard i < chars.count else { return nil }
            if chars[i].isLetter {
                defer { i += 1 }
                return chars[i]
            }
            return current
        }

        mutating func number() -> Double? {
            skipSeparators()
            var s = ""
            if i < chars.count, chars[i] == "-" || chars[i] == "+" {
                s.append(chars[i])
                i += 1
            }
            var seenDot = false
            while i < chars.count {
                let c = chars[i]
                if c.isNumber {
                    s.append(c)
                } else if c == ".", !seenDot {
                    seenDot = true
                    s.append(c)
                } else {
                    break
                }
                i += 1
            }
            return Double(s)
        }
    }
}
