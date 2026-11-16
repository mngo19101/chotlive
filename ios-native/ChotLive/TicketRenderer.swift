import UIKit

/// Vẽ tem (hỗ trợ tiếng Việt có dấu) thành ảnh rồi chuyển sang lệnh raster ESC/POS.
enum TicketRenderer {
    private enum Block {
        /// Chữ bên trái (tự xuống dòng) và chữ bên phải 1 dòng, thẳng chân chữ dòng đầu. Phải rỗng thì trái chiếm hết.
        case row(String, UIFont, String, UIFont)
        case dashed
    }

    static var paperWidth: CGFloat {
        UserDefaults.standard.integer(forKey: "paperWidth") == 384 ? 384 : 576
    }

    static func ticketBytes(comment: LiveComment) -> Data {
        escpos(from: render(comment: comment))
    }

    /// Tem in từ 1 bình luận đang live: giờ là lúc bấm in. `c.price` là tổng tiền các món của bình luận
    /// (0 thì không in dòng giá).
    static func liveTicketBytes(comment: LiveComment) -> Data {
        escpos(from: render(comment: comment, live: true))
    }

    /// Tem nhỏ gọn, 4 dòng:
    ///   CHỐTLIVE                 15:06 16/11
    ///   Tên khách
    ///   @id
    ///   - - - - - - - - - - - - - - - - - -
    ///   bình luận                    30.000đ
    static func render(comment c: LiveComment, live: Bool = false) -> UIImage {
        let shop = UserDefaults.standard.string(forKey: "shopName") ?? "ChốtLive"
        let f = DateFormatter()
        f.dateFormat = "HH:mm dd/MM"
        let name = (c.nickname.isEmpty ? "@" + c.uniqueId : c.nickname)
        let small = UIFont.systemFont(ofSize: 20, weight: .semibold)

        var blocks: [Block] = [
            .row(shop.uppercased(), .systemFont(ofSize: 20, weight: .heavy), f.string(from: live ? Date() : c.ts), small),
            .row(name, .systemFont(ofSize: 28, weight: .heavy), "", small),
        ]
        if !c.nickname.isEmpty { blocks.append(.row("@" + c.uniqueId, small, "", small)) }
        blocks += [
            .dashed,
            .row(c.text, .systemFont(ofSize: 26, weight: .bold),
                 c.price > 0 ? vnd(c.price) : "", .systemFont(ofSize: 32, weight: .heavy)),
        ]

        let width = paperWidth
        let margin: CGFloat = 12
        let cw = width - margin * 2
        let spacing: CGFloat = 2
        let dashH: CGFloat = 10

        func attrs(_ font: UIFont) -> [NSAttributedString.Key: Any] { [.font: font, .foregroundColor: UIColor.black] }
        func size(_ s: String, _ font: UIFont, _ w: CGFloat) -> CGSize {
            let r = (s as NSString).boundingRect(with: CGSize(width: w, height: .greatestFiniteMagnitude),
                                                 options: [.usesLineFragmentOrigin, .usesFontLeading],
                                                 attributes: attrs(font), context: nil)
            return CGSize(width: ceil(r.width), height: ceil(r.height))
        }
        /// Vị trí 2 bên của 1 dòng: trái, phải (nil nếu rỗng) và chiều cao dòng.
        func place(_ l: String, _ lf: UIFont, _ r: String, _ rf: UIFont)
            -> (left: CGRect, right: CGRect?, height: CGFloat) {
            let rs = r.isEmpty ? CGSize.zero : size(r, rf, cw)
            let lw = r.isEmpty ? cw : max(cw / 3, cw - rs.width - 16)
            let ls = size(l, lf, lw)
            let base = max(lf.ascender, r.isEmpty ? 0 : rf.ascender)
            let left = CGRect(x: margin, y: base - lf.ascender, width: lw, height: ls.height)
            let right = r.isEmpty ? nil
                : CGRect(x: width - margin - rs.width, y: base - rf.ascender, width: rs.width, height: rs.height)
            return (left, right, max(left.maxY, right?.maxY ?? 0))
        }

        var total: CGFloat = 6
        for b in blocks {
            switch b {
            case .row(let l, let lf, let r, let rf): total += place(l, lf, r, rf).height + spacing
            case .dashed: total += dashH
            }
        }
        total += 6

        let fmt = UIGraphicsImageRendererFormat()
        fmt.scale = 1
        fmt.opaque = true
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: width, height: ceil(total / 8) * 8), format: fmt)
        return renderer.image { ctx in
            UIColor.white.setFill()
            ctx.fill(CGRect(x: 0, y: 0, width: width, height: total + 8))
            var y: CGFloat = 6
            for b in blocks {
                switch b {
                case .row(let l, let lf, let r, let rf):
                    let p = place(l, lf, r, rf)
                    (l as NSString).draw(with: p.left.offsetBy(dx: 0, dy: y),
                                         options: [.usesLineFragmentOrigin, .usesFontLeading],
                                         attributes: attrs(lf), context: nil)
                    if let rr = p.right {
                        (r as NSString).draw(with: rr.offsetBy(dx: 0, dy: y),
                                             options: [.usesLineFragmentOrigin, .usesFontLeading],
                                             attributes: attrs(rf), context: nil)
                    }
                    y += p.height + spacing
                case .dashed:
                    let path = UIBezierPath()
                    path.setLineDash([10, 7], count: 2, phase: 0)
                    path.lineWidth = 2
                    path.move(to: CGPoint(x: margin, y: y + dashH / 2))
                    path.addLine(to: CGPoint(x: width - margin, y: y + dashH / 2))
                    UIColor.black.setStroke()
                    path.stroke()
                    y += dashH
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

        // Bỏ dòng trắng cuối ảnh (khoảng chừa dưới chân chữ), chỉ giữ 16 chấm (2mm) sau dòng có mực
        // cuối cùng để dao cắt lệch một chút cũng không cắt vào chữ.
        var inked = h
        while inked > 0 && !(0..<w).contains(where: { gray[(inked - 1) * w + $0] < 150 }) { inked -= 1 }
        let printed = min(h, inked + 16)

        var out = Data([0x1B, 0x40]) // ESC @
        var y = 0
        while y < printed {
            let rows = min(128, printed - y)
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
        // GS V 66 0: máy tự đẩy giấy tới dao rồi mới cắt, nên không cần ESC d trước đó
        // (ESC d sẽ đẩy thêm khoảng trắng thừa dưới chân tem).
        out.append(contentsOf: [0x1D, 0x56, 0x42, 0x00])
        return out
    }
}
