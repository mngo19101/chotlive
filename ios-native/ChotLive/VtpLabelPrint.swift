import SwiftUI
import UIKit

// MARK: - In tem Viettel Post thẳng ra máy in

/// Bấm "In tem" ở đơn Đang giao: lấy tem Viettel Post (khổ chọn ở Tôi › ViettelPost), vẽ thành ảnh đúng khổ giấy
/// máy in đã nối ở Tôi › Máy in rồi in luôn, không mở trình duyệt. Nhớ vận đơn nào đã in để nút đổi từ cam sang trắng.
@MainActor
final class VtpLabelPrinter: ObservableObject {
    /// Mã vận đơn đã in tem trên máy này (cũ nhất trước trong UserDefaults, giữ tối đa `keep` mã).
    @Published private(set) var printed: Set<String>
    /// Mã đang lấy tem / đang gửi ra máy in: nút hiện "Đang in…" và không bấm lại được.
    @Published private(set) var printing: Set<String> = []

    private let key = "vtpLabelPrinted"
    private let keep = 3000

    init() {
        printed = Set(UserDefaults.standard.stringArray(forKey: key) ?? [])
    }

    func isPrinted(_ code: String) -> Bool { printed.contains(code) }
    func isPrinting(_ code: String) -> Bool { printing.contains(code) }

    private func remember(_ codes: [String]) {
        var list = UserDefaults.standard.stringArray(forKey: key) ?? []
        list.removeAll { codes.contains($0) }
        list.append(contentsOf: codes)
        if list.count > keep { list.removeFirst(list.count - keep) }
        UserDefaults.standard.set(list, forKey: key)
        printed = Set(list)
    }

    /// In tem các vận đơn. Chưa nối máy in thì hỏi có mở tem trên trình duyệt (cách cũ) không.
    func printLabels(_ codes: [String], client: LiveClient, printer: PrinterManager, ui: AppUI) {
        var seen = Set<String>()
        let list = codes.filter { !$0.isEmpty && seen.insert($0).inserted }
        guard !list.isEmpty, printing.isDisjoint(with: list) else { return }
        let size = UserDefaults.standard.string(forKey: VtpTrack.labelSizeKey) ?? "a6"

        guard printer.isConnected else {
            ui.confirm = ConfirmItem(title: "Chưa kết nối máy in",
                                     message: "Kết nối máy in ở Tôi › Máy in để bấm In tem là in ra luôn. Hoặc mở tem Viettel Post để in bằng cách khác.",
                                     action: "Mở tem", cancel: "Để sau", destructive: false) {
                Task { @MainActor in
                    let r = await client.vtpPrintURL(list, size: size)
                    if let e = r.error { ui.notify(e); return }
                    if let url = r.url { await UIApplication.shared.open(url) }
                }
            }
            return
        }

        printing.formUnion(list)
        Task { @MainActor in
            defer { self.printing.subtract(list) }
            let r = await client.vtpPrintURL(list, size: size)
            if let e = r.error { ui.notify(e); return }
            guard let url = r.url else { ui.notify("Không lấy được tem Viettel Post."); return }
            guard let data = await Self.download(url) else {
                ui.notify("Không tải được tem Viettel Post. Kiểm tra mạng rồi thử lại.")
                return
            }
            guard VtpLabelRender.isPDF(data) else {
                // Viettel Post trả trang web (link hết hạn, lỗi…) chứ không phải tem: không in trang đó ra giấy.
                ui.notify("Viettel Post chưa trả tem dạng in được nên chưa in thẳng. Đã mở tem để bạn xem và in.")
                await UIApplication.shared.open(url)
                return
            }
            let pages = VtpLabelRender.images(fromPDF: data, width: Int(TicketRenderer.paperWidth))
            guard !pages.isEmpty else {
                ui.notify("Tem Viettel Post trống, chưa in được. Thử lại sau ít phút.")
                return
            }
            for (i, page) in pages.enumerated() {
                if let e = await printer.sendAndWait(TicketRenderer.escpos(from: page)) {
                    ui.notify(i == 0 ? "Chưa in được tem. \(e)" : "Mới in được \(i)/\(pages.count) tem. \(e)")
                    return
                }
            }
            self.remember(list)
        }
    }

    private static func download(_ url: URL) async -> Data? {
        var req = URLRequest(url: url, timeoutInterval: 30)
        req.cachePolicy = .reloadIgnoringLocalCacheData
        guard let result = try? await URLSession.shared.data(for: req) else { return nil }
        let (data, resp) = result
        guard (resp as? HTTPURLResponse)?.statusCode == 200, !data.isEmpty else { return nil }
        return data
    }
}

// MARK: - PDF tem → ảnh đen trắng cho máy in nhiệt

enum VtpLabelRender {
    /// Tệp có đầu "%PDF-" trong 1KB đầu.
    static func isPDF(_ data: Data) -> Bool {
        data.prefix(1024).range(of: Data("%PDF-".utf8)) != nil
    }

    /// Mỗi trang PDF thành một ảnh xám rộng đúng `width` chấm: cắt bỏ lề trắng quanh tem rồi phóng vừa khổ giấy.
    /// Vẽ thẳng từ PDF ở độ phân giải in (không phóng ảnh) và tắt khử răng cưa để mã vạch sắc nét, quét được.
    /// Trang trắng bị bỏ qua.
    static func images(fromPDF data: Data, width: Int, maxPages: Int = 50) -> [UIImage] {
        guard width > 0, maxPages > 0, let provider = CGDataProvider(data: data as CFData),
              let doc = CGPDFDocument(provider), doc.numberOfPages > 0 else { return [] }
        var out: [UIImage] = []
        for n in 1...min(doc.numberOfPages, maxPages) {
            guard let page = doc.page(at: n), let img = render(page, width: width) else { continue }
            out.append(img)
        }
        return out
    }

    private static func render(_ page: CGPDFPage, width: Int) -> UIImage? {
        let box = page.getBoxRect(.cropBox)
        guard box.width > 1, box.height > 1 else { return nil }
        // Trang xoay 90/270 độ: khổ hiển thị đổi chiều.
        let turned = abs(page.rotationAngle) % 180 == 90
        let pageW = turned ? box.height : box.width
        let pageH = turned ? box.width : box.height

        // Lượt 1: vẽ cả trang rộng 800 chấm để tìm khung có mực.
        let w1 = 800
        let h1 = max(1, Int((CGFloat(w1) * pageH / pageW).rounded()))
        guard h1 <= 8000 else { return nil }
        let full = CGRect(x: 0, y: 0, width: w1, height: h1)
        let fit = page.getDrawingTransform(.cropBox, rect: full, rotate: 0, preserveAspectRatio: true)
        guard let probe = grayContext(width: w1, height: h1) else { return nil }
        probe.concatenate(fit)
        probe.drawPDFPage(page)
        guard let ink = inkBounds(probe, width: w1, height: h1) else { return nil }

        // Chừa 4 chấm (lượt 1) quanh khung mực rồi đổi sang toạ độ vẽ (gốc dưới-trái).
        let pad = 4
        let left = max(0, ink.minX - pad), right = min(w1 - 1, ink.maxX + pad)
        let top = max(0, ink.minRow - pad), bottom = min(h1 - 1, ink.maxRow + pad)
        let cropW = CGFloat(right - left + 1)
        let cropH = CGFloat(bottom - top + 1)
        let yLow = CGFloat(h1 - 1 - bottom)

        // Lượt 2: vẽ riêng khung tem, rộng đúng khổ giấy máy in.
        let k = CGFloat(width) / cropW
        let outH = max(1, Int((cropH * k).rounded()))
        guard outH <= 12000, let ctx = grayContext(width: width, height: outH) else { return nil }
        ctx.scaleBy(x: k, y: k)
        ctx.translateBy(x: -CGFloat(left), y: -yLow)
        ctx.concatenate(fit)
        ctx.drawPDFPage(page)
        return ctx.makeImage().map { UIImage(cgImage: $0) }
    }

    /// Ngữ cảnh xám 8 bit nền trắng, không khử răng cưa.
    private static func grayContext(width: Int, height: Int) -> CGContext? {
        guard let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return nil }
        ctx.setFillColor(gray: 1, alpha: 1)
        ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
        ctx.setShouldAntialias(false)
        ctx.setAllowsAntialiasing(false)
        ctx.interpolationQuality = .none
        return ctx
    }

    /// Khung chấm có mực (xám < 200). Hàng 0 là mép trên ảnh. nil là trang trắng.
    private static func inkBounds(_ ctx: CGContext, width: Int, height: Int) -> (minX: Int, maxX: Int, minRow: Int, maxRow: Int)? {
        guard let base = ctx.data else { return nil }
        let stride = ctx.bytesPerRow
        let px = base.bindMemory(to: UInt8.self, capacity: stride * height)
        var minX = width, maxX = -1, minRow = height, maxRow = -1
        for row in 0..<height {
            let line = px + row * stride
            for x in 0..<width where line[x] < 200 {
                if x < minX { minX = x }
                if x > maxX { maxX = x }
                if row < minRow { minRow = row }
                if row > maxRow { maxRow = row }
            }
        }
        guard maxX >= 0 else { return nil }
        return (minX: minX, maxX: maxX, minRow: minRow, maxRow: maxRow)
    }
}

// MARK: - Nút "In tem"

/// Nút in tem một vận đơn: cam khi chưa in, trắng sau khi đã in tem trên máy này ("In lại tem").
struct VtpLabelButton: View {
    let code: String
    @EnvironmentObject var labels: VtpLabelPrinter
    @EnvironmentObject var client: LiveClient
    @EnvironmentObject var printer: PrinterManager
    @EnvironmentObject var ui: AppUI

    var body: some View {
        let busy = labels.isPrinting(code)
        let done = labels.isPrinted(code)
        OutlineButton(title: busy ? "Đang in…" : (done ? "In lại tem" : "In tem"), icon: .printer, filled: !done) {
            labels.printLabels([code], client: client, printer: printer, ui: ui)
        }
        .disabled(busy)
    }
}
