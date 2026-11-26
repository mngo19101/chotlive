import XCTest
import UIKit
@testable import ChotLive

/// Duyệt thẳng Đang giao khi chưa kết nối Viettel Post, và in tem Viettel Post thẳng ra máy in nhiệt.
final class VtpFlowTests: XCTestCase {
    private var dir: URL!
    private var suite = ""
    private var defaults: UserDefaults!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("chotlive-flow-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        suite = "chotlive.flowtests.\(UUID().uuidString)"
        defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
    }

    override func tearDown() {
        defaults?.removePersistentDomain(forName: suite)
        if let dir { try? FileManager.default.removeItem(at: dir) }
    }

    // MARK: Duyệt thẳng Đang giao

    func testApproveAndShipSkipsReadyAndCanBeUndone() throws {
        let store = Store(account: "acc1", directory: dir, defaults: defaults)
        defer { store.save() }
        let c = LiveComment(id: "c1", uniqueId: "khach1", userId: "", nickname: "Khách 1", text: "Chốt 150", ts: Date(), price: 150_000)
        XCTAssertEqual(store.saveToCustomer(c).count, 1)
        let o = try XCTUnwrap(store.allOrders().first)
        XCTAssertEqual(Vtp.state(o), .ask)

        store.approveAndShip([o.id], base: ShipInfo(pay: "cod", deposit: 20_000))
        let shipped = try XCTUnwrap(store.order(id: o.id))
        XCTAssertEqual(shipped.status, .shipping)
        XCTAssertEqual(Vtp.state(shipped), .exported)
        XCTAssertTrue(Vtp.isSelfShipped(shipped))
        XCTAssertNotNil(shipped.ship?.exportedAt)
        // Giữ thông tin vừa duyệt (cọc) chứ không ghi đè bằng ship rỗng.
        XCTAssertEqual(shipped.ship?.deposit, 20_000)
        XCTAssertTrue(store.readyGroups().isEmpty, "Không qua Chờ gửi")

        store.undoExport(shipped)
        let back = try XCTUnwrap(store.order(id: o.id))
        XCTAssertEqual(Vtp.state(back), .ready)
        XCTAssertNotEqual(back.status, .shipping)
        XCTAssertEqual(store.readyGroups().count, 1)
    }

    func testExcelExportIsNotSelfShipped() throws {
        let store = Store(account: "acc1", directory: dir, defaults: defaults)
        defer { store.save() }
        let c = LiveComment(id: "c1", uniqueId: "khach1", userId: "", nickname: "Khách 1", text: "Chốt 150", ts: Date(), price: 150_000)
        _ = store.saveToCustomer(c)
        let o = try XCTUnwrap(store.allOrders().first)
        store.approve([o.id], state: .ready, base: ShipInfo(pay: "cod"))
        let approved = try XCTUnwrap(store.order(id: o.id))
        store.markExported([approved])
        let exported = try XCTUnwrap(store.order(id: o.id))
        XCTAssertEqual(Vtp.state(exported), .exported)
        XCTAssertFalse(Vtp.isSelfShipped(exported))
    }

    // MARK: Tem PDF → ảnh máy in

    /// PDF khổ A4 có một khối đen cỡ tem A6 ở giữa trang.
    private func pdf(page: CGSize = CGSize(width: 595, height: 842), ink: CGRect?) -> Data {
        UIGraphicsPDFRenderer(bounds: CGRect(origin: .zero, size: page)).pdfData { ctx in
            ctx.beginPage()
            if let ink {
                UIColor.black.setFill()
                UIRectFill(ink)
            }
        }
    }

    /// Độ xám (0 đen, 255 trắng) của một chấm, hàng 0 là mép trên ảnh.
    private func gray(_ image: UIImage, x: Int, y: Int) -> UInt8 {
        guard let cg = image.cgImage else { return 0 }
        var px = [UInt8](repeating: 0, count: cg.width * cg.height)
        px.withUnsafeMutableBytes { ptr in
            let ctx = CGContext(data: ptr.baseAddress, width: cg.width, height: cg.height, bitsPerComponent: 8,
                                bytesPerRow: cg.width, space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue)
            ctx?.draw(cg, in: CGRect(x: 0, y: 0, width: cg.width, height: cg.height))
        }
        return px[y * cg.width + x]
    }

    func testLabelIsCroppedToInkAndFitsPaperWidth() throws {
        let data = pdf(ink: CGRect(x: 150, y: 200, width: 298, height: 420))
        XCTAssertTrue(VtpLabelRender.isPDF(data))
        let pages = VtpLabelRender.images(fromPDF: data, width: 576)
        XCTAssertEqual(pages.count, 1)
        let img = try XCTUnwrap(pages.first?.cgImage)
        XCTAssertEqual(img.width, 576)
        // Khối 298×420 phóng vừa 576 chấm: cao khoảng 812 chấm (cộng chút lề chừa quanh mực).
        XCTAssertTrue((760...860).contains(img.height), "cao \(img.height)")
        let page = try XCTUnwrap(pages.first)
        XCTAssertEqual(gray(page, x: 288, y: img.height / 2), 0, "giữa tem là mực")
        XCTAssertEqual(gray(page, x: 1, y: 1), 255, "góc là lề trắng chừa lại")

        let bytes = TicketRenderer.escpos(from: page)
        XCTAssertEqual(Array(bytes.prefix(2)), [0x1B, 0x40])
        XCTAssertEqual(Array(bytes.suffix(4)), [0x1D, 0x56, 0x42, 0x00])
    }

    func testBlankPagesAndWebPagesAreNotPrinted() {
        XCTAssertTrue(VtpLabelRender.images(fromPDF: pdf(ink: nil), width: 576).isEmpty)
        let html = Data("<!DOCTYPE html><html><body>Link đã hết hạn</body></html>".utf8)
        XCTAssertFalse(VtpLabelRender.isPDF(html))
        XCTAssertTrue(VtpLabelRender.images(fromPDF: html, width: 576).isEmpty)
    }

    func testNarrowPaperKeepsWholeLabel() throws {
        let data = pdf(page: CGSize(width: 283, height: 425), ink: CGRect(x: 10, y: 10, width: 263, height: 405))
        let img = try XCTUnwrap(VtpLabelRender.images(fromPDF: data, width: 384).first?.cgImage)
        XCTAssertEqual(img.width, 384)
        XCTAssertTrue((560...620).contains(img.height), "cao \(img.height)")
    }
}
