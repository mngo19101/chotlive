import UIKit

/// Vẽ tem (hỗ trợ tiếng Việt có dấu) thành ảnh rồi chuyển sang lệnh raster ESC/POS.
enum TicketRenderer {
    private enum Block {
        case text(String, UIFont, NSTextAlignment)
        case dashed
        case gap(CGFloat)
    }

    static var paperWidth: CGFloat {
        UserDefaults.standard.integer(forKey: "paperWidth") == 384 ? 384 : 576
    }

    static func ticketBytes(comment: LiveComment) -> Data {
        escpos(from: render(comment: comment))
    }

    static func render(comment c: LiveComment) -> UIImage {
        let shop = UserDefaults.standard.string(forKey: "shopName") ?? "ChốtLive"
        let f = DateFormatter()
        f.dateFormat = "HH:mm  dd/MM/yyyy"
        let name = (c.nickname.isEmpty ? "@" + c.uniqueId : c.nickname)

        var blocks: [Block] = [
            .text(shop.uppercased(), .systemFont(ofSize: 40, weight: .heavy), .center),
            .dashed,
            .text(name, .systemFont(ofSize: 38, weight: .heavy), .left),
            .text("ID TikTok: @" + c.uniqueId, .systemFont(ofSize: 28, weight: .semibold), .left),
        ]
        if !c.userId.isEmpty {
            blocks.append(.text("Mã số: " + c.userId, .systemFont(ofSize: 22, weight: .regular), .left))
        }
        blocks += [
            .text("Giờ: " + f.string(from: c.ts), .systemFont(ofSize: 26, weight: .regular), .left),
            .dashed,
            .text("Bình luận:", .systemFont(ofSize: 24, weight: .regular), .left),
            .text(c.text, .systemFont(ofSize: 36, weight: .bold), .left),
            .dashed,
            .text(vnd(c.price), .systemFont(ofSize: 64, weight: .heavy), .center),
            .gap(10),
            .dashed,
            .gap(20),
        ]

        let width = paperWidth
        let margin: CGFloat = 16
        let cw = width - margin * 2

        func style(_ a: NSTextAlignment) -> NSParagraphStyle {
            let p = NSMutableParagraphStyle()
            p.alignment = a
            return p
        }
        func height(_ s: String, _ font: UIFont, _ a: NSTextAlignment) -> CGFloat {
            ceil((s as NSString).boundingRect(
                with: CGSize(width: cw, height: .greatestFiniteMagnitude),
                options: [.usesLineFragmentOrigin, .usesFontLeading],
                attributes: [.font: font, .paragraphStyle: style(a)], context: nil).height)
        }

        let spacing: CGFloat = 8
        var total: CGFloat = 12
        for b in blocks {
            switch b {
            case .text(let s, let font, let a): total += height(s, font, a) + spacing
            case .dashed: total += 14
            case .gap(let g): total += g
            }
        }
        total += 12

        let fmt = UIGraphicsImageRendererFormat()
        fmt.scale = 1
        fmt.opaque = true
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: width, height: ceil(total / 8) * 8), format: fmt)
        return renderer.image { ctx in
            UIColor.white.setFill()
            ctx.fill(CGRect(x: 0, y: 0, width: width, height: total + 8))
            var y: CGFloat = 12
            for b in blocks {
                switch b {
                case .text(let s, let font, let a):
                    let h = height(s, font, a)
                    (s as NSString).draw(
                        with: CGRect(x: margin, y: y, width: cw, height: h),
                        options: [.usesLineFragmentOrigin, .usesFontLeading],
                        attributes: [.font: font, .paragraphStyle: style(a), .foregroundColor: UIColor.black],
                        context: nil)
                    y += h + spacing
                case .dashed:
                    let path = UIBezierPath()
                    path.setLineDash([10, 7], count: 2, phase: 0)
                    path.lineWidth = 2
                    path.move(to: CGPoint(x: margin, y: y + 6))
                    path.addLine(to: CGPoint(x: width - margin, y: y + 6))
                    UIColor.black.setStroke()
                    path.stroke()
                    y += 14
                case .gap(let g): y += g
                }
            }
        }
    }

    /// Ảnh -> ESC/POS raster (GS v 0), chia dải 128 dòng cho máy in nhỏ bộ đệm.
    static func escpos(from image: UIImage) -> Data {
        guard let cg = image.cgImage else { return Data() }
        let w = cg.width, h = cg.height
        let bytesPerRow = (w + 7) / 8
        var gray = [UInt8](repeating: 255, count: w * h)
        gray.withUnsafeMutableBytes { ptr in
            if let ctx = CGContext(data: ptr.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w,
                                   space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) {
                ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
            }
        }

        var out = Data([0x1B, 0x40]) // ESC @
        var y = 0
        while y < h {
            let rows = min(128, h - y)
            out.append(contentsOf: [0x1D, 0x76, 0x30, 0x00,
                                    UInt8(bytesPerRow & 0xFF), UInt8(bytesPerRow >> 8),
                                    UInt8(rows & 0xFF), UInt8(rows >> 8)])
            for r in y..<(y + rows) {
                for bx in 0..<bytesPerRow {
                    var byte: UInt8 = 0
                    for bit in 0..<8 {
                        let x = bx * 8 + bit
                        if x < w && gray[r * w + x] < 150 { byte |= UInt8(0x80 >> bit) }
                    }
                    out.append(byte)
                }
            }
            y += rows
        }
        out.append(contentsOf: [0x1B, 0x64, 0x04])       // feed 4 dòng
        out.append(contentsOf: [0x1D, 0x56, 0x42, 0x00]) // cắt giấy (máy không có dao sẽ bỏ qua)
        return out
    }
}
