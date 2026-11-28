import XCTest
@testable import ChotLive

/// Dịch vụ cộng thêm và ghi chú vận đơn chọn ở bảng Duyệt đơn.
final class VtpExtrasTests: XCTestCase {
    func testCleanKeepsOnlyKnownCodesInListOrder() {
        XCTAssertEqual(VtpExtras.clean("sms, GBH,xyz,GBH"), ["GBH", "SMS"])
        XCTAssertEqual(VtpExtras.clean(["ZNS", "GDK"]), ["GDK", "ZNS"])
        XCTAssertEqual(VtpExtras.clean(nil as String?), [])
        XCTAssertNil(VtpExtras.joined([]))
        XCTAssertEqual(VtpExtras.joined(["SMS", "GBH"]), "GBH,SMS")
        XCTAssertEqual(VtpExtras.names(["GDK", "GBH", "SMS"]), "Khai giá · Đồng kiểm · SMS")
        XCTAssertEqual(VtpExtras.all.count, 11, "đúng 11 dịch vụ trang viettelpost.vn cho chọn")
    }

    func testComposeAndSplitNote() {
        let t = VtpExtras.defaultTemplates
        let note = VtpExtras.compose(picks: ["Cho khách xem hàng", "Gọi điện cho khách trước khi giao"], templates: t,
                                     other: "  Giao sau   17h ")
        XCTAssertEqual(note, "Gọi điện cho khách trước khi giao; Cho khách xem hàng; Giao sau 17h", "mẫu theo thứ tự danh sách, rồi nội dung khác")
        let back = VtpExtras.split(note, templates: t)
        XCTAssertEqual(back.picks, ["Gọi điện cho khách trước khi giao", "Cho khách xem hàng"])
        XCTAssertEqual(back.other, "Giao sau 17h")
        XCTAssertEqual(VtpExtras.compose(picks: [], templates: t, other: "   "), "")
        let free = VtpExtras.split("gọi điện cho khách trước khi giao;hàng dễ vỡ", templates: t)
        XCTAssertEqual(free.picks, ["Gọi điện cho khách trước khi giao"], "không phân biệt hoa thường")
        XCTAssertEqual(free.other, "hàng dễ vỡ")
    }

    func testParseTemplatesFromViettelPost() {
        let json: [String: Any] = [
            "status": 200, "error": false,
            "data": [
                ["id": "1", "note": "Giao hàng một phần, nhận lại sản phẩm từ khách", "selected": false, "deleted": false],
                ["id": "2", "note": "Gọi điện cho khách trước khi giao", "selected": true, "deleted": false],
                ["id": "3", "note": "Đã xoá", "selected": false, "deleted": true],
                ["id": "4", "note": "  ", "selected": false, "deleted": false]
            ]
        ]
        let r = VtpExtras.parseTemplates(json)
        XCTAssertEqual(r?.templates, ["Giao hàng một phần, nhận lại sản phẩm từ khách", "Gọi điện cho khách trước khi giao"])
        XCTAssertEqual(r?.selected, ["Gọi điện cho khách trước khi giao"])
        XCTAssertNil(VtpExtras.parseTemplates(["error": true, "message": "Hết phiên"]))
    }

    func testSummaryUsesChosenNoteAndExtras() {
        var addr = DeliveryAddress(receiver: "Lan", phone: "0912345678", street: "12 Trần Thái Tông", region: "Phường Cầu Giấy, TP.Hà Nội")
        addr.note = "Gọi trước khi giao"
        let plain = Vtp.summarize([Vtp.Line(total: 100_000, qty: 1, ship: ShipInfo(state: "ready"))], address: addr, nickname: "Lan")
        XCTAssertEqual(plain.note, "Gọi trước khi giao")
        XCTAssertEqual(plain.extras, [])
        let lines = [
            Vtp.Line(total: 100_000, qty: 1, ship: ShipInfo(state: "ready", extras: "GBP", orderNote: "Cũ")),
            Vtp.Line(total: 50_000, qty: 1, ship: ShipInfo(state: "ready", extras: "SMS,GBH", orderNote: "Cho khách xem hàng"))
        ]
        let s = Vtp.summarize(lines, address: addr, nickname: "Lan")
        XCTAssertEqual(s.note, "Cho khách xem hàng", "đơn mới nhất thắng")
        XCTAssertEqual(s.extras, ["GBH", "SMS"])
    }

    func testShipInfoRoundTripsNewFields() throws {
        let ship = ShipInfo(state: "ready", extras: "GBH,GDK", orderNote: "Cho khách xem hàng")
        let data = try JSONEncoder().encode(ship)
        let back = try JSONDecoder().decode(ShipInfo.self, from: data)
        XCTAssertEqual(back.extras, "GBH,GDK")
        XCTAssertEqual(back.orderNote, "Cho khách xem hàng")
        let old = try JSONDecoder().decode(ShipInfo.self, from: Data(#"{"state":"ready"}"#.utf8))
        XCTAssertNil(old.extras, "dữ liệu cũ không có trường mới vẫn đọc được")
    }

    func testExcelRowHasExtrasColumn() {
        let addr = DeliveryAddress(receiver: "Lan", phone: "0912345678", street: "12 Trần Thái Tông", region: "Phường Cầu Giấy, TP.Hà Nội")
        var it = OrderItem(id: "x-1", comment: "chốt", price: 100_000, ts: Date(timeIntervalSince1970: 1000), qty: 1, groupId: "x")
        it.ship = ShipInfo(state: "ready", pay: "cod", extras: "GDK,GBH")
        let c = Customer(id: "lan", uniqueId: "lan", userId: "", nickname: "Lan", items: [], address: addr)
        let groups = Vtp.readyGroups([Order(key: "x", customer: c, items: [it])])
        let rows = Vtp.rows(groups)
        let col = Vtp.headers.firstIndex(of: "Dịch vụ cộng thêm ")!
        XCTAssertEqual(rows.last?[col], .text("GBH,GDK"))
    }
}
