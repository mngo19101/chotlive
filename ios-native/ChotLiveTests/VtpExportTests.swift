import XCTest
@testable import ChotLive

/// Duyệt đơn và xuất Viettel Post: cùng kết quả với web (test/vtp-export.test.js).
final class VtpExportTests: XCTestCase {
    private let address = DeliveryAddress(receiver: "Lan Anh 🌸", phone: "0912 345 678", street: "12 Trần Thái Tông",
                                          region: "Phường Cầu Giấy, TP.Hà Nội")

    private func customer(_ id: String = "lan.anh", address: DeliveryAddress? = nil) -> Customer {
        Customer(id: id, uniqueId: id, userId: "", nickname: "Lan", items: [], address: address ?? self.address)
    }

    private func order(_ key: String, price: Int = 150_000, qty: Int = 1, ts: Date = Date(timeIntervalSince1970: 1000),
                       ship: ShipInfo?, status: (shipping: Bool, delivered: Bool) = (false, false),
                       customer c: Customer? = nil) -> Order {
        var it = OrderItem(id: key + "-1", comment: "chốt", price: price, ts: ts, qty: qty, groupId: key)
        it.ship = ship
        it.shipping = status.shipping
        it.delivered = status.delivered
        it.orderCode = "HD" + key
        return Order(key: key, customer: c ?? customer(), items: [it])
    }

    private func line(_ price: Int, _ ship: ShipInfo) -> Vtp.Line { Vtp.Line(total: price, qty: 1, ship: ship) }

    func testShipStateFollowsWebRules() {
        XCTAssertEqual(Vtp.state(order("a", ship: nil)), .ask)
        XCTAssertEqual(Vtp.state(order("a", ship: ShipInfo(state: "hold"))), .hold)
        XCTAssertEqual(Vtp.state(order("a", ship: ShipInfo(state: "ready"), status: (true, false))), .gone)
        XCTAssertEqual(Vtp.state(order("a", ship: ShipInfo(state: "exported"), status: (true, false))), .exported)
    }

    func testCodRules() {
        let cod = { (lines: [Vtp.Line]) in Vtp.summarize(lines, address: self.address, nickname: "Lan") }
        // Gộp 2 đơn thu tiền hàng.
        XCTAssertEqual(cod([line(120_000, ShipInfo(pay: "cod")), line(299_000, ShipInfo(pay: "cod"))]).cod, 419_000)
        // Đơn nhỏ, người gửi trả: cộng 17.000đ.
        let small = cod([line(10_000, ShipInfo(pay: "cod", payer: "sender"))])
        XCTAssertEqual(small.cod, 27_000)
        XCTAssertEqual(small.shipFee, 17_000)
        XCTAssertTrue(small.senderPays)
        // Đơn nhỏ mà chọn người nhận trả: vẫn xuất người gửi trả và cộng 17.000đ.
        let smallReceiver = cod([line(15_000, ShipInfo(pay: "cod", payer: "receiver"))])
        XCTAssertEqual(smallReceiver.cod, 32_000)
        XCTAssertTrue(smallReceiver.senderPays)
        XCTAssertTrue(smallReceiver.forcedSender)
        XCTAssertFalse(cod([line(17_000, ShipInfo(pay: "cod", payer: "receiver"))]).senderPays)
        // Bank đủ + người gửi trả: 0đ. Bank đủ + người nhận trả: thu 17.000đ, xuất người gửi trả.
        XCTAssertEqual(cod([line(150_000, ShipInfo(pay: "paid", payer: "sender"))]).cod, 0)
        let bankReceiver = cod([line(150_000, ShipInfo(pay: "paid", payer: "receiver"))])
        XCTAssertEqual(bankReceiver.cod, 17_000)
        XCTAssertTrue(bankReceiver.senderPays)
        // Cọc trừ vào COD; còn dưới 17.000đ mà người gửi trả thì cộng phí.
        XCTAssertEqual(cod([line(150_000, ShipInfo(pay: "cod", deposit: 50_000))]).cod, 100_000)
        XCTAssertEqual(cod([line(150_000, ShipInfo(pay: "cod", payer: "sender", deposit: 140_000))]).cod, 27_000)
        // Nhập tay thắng số tự tính.
        XCTAssertEqual(cod([line(150_000, ShipInfo(pay: "cod", codOverride: 123_000))]).cod, 123_000)
        // Nhập tay dưới 17.000đ: người gửi trả cước, cộng 17.000đ vào số đã nhập.
        let low = cod([line(150_000, ShipInfo(pay: "cod", payer: "receiver", codOverride: 10_000))])
        XCTAssertEqual(low.cod, 27_000)
        XCTAssertEqual(low.shipFee, 17_000)
        XCTAssertTrue(low.senderPays)
        XCTAssertTrue(low.forcedSender)
        // Đơn nhỏ đã cộng ship mà nhập tay đúng 27.000đ: giữ nguyên, không cộng lần nữa.
        let kept = cod([line(10_000, ShipInfo(pay: "cod", codOverride: 27_000))])
        XCTAssertEqual(kept.cod, 27_000)
        XCTAssertTrue(kept.senderPays)
        // Nhập tay đúng 17.000đ trở lên thì giữ người trả cước đã chọn.
        XCTAssertFalse(cod([line(150_000, ShipInfo(pay: "cod", payer: "receiver", codOverride: 17_000))]).senderPays)
    }

    /// Có cước thật Viettel Post: thu hộ thấp hơn cước đó thì người gửi trả cước, cộng đúng cước đó vào thu hộ.
    func testRealFeeRules() {
        let cod = { (lines: [Vtp.Line], fee: Int?) in
            Vtp.summarize(lines, address: self.address, nickname: "Lan", realFee: fee)
        }
        let near = [line(17_500, ShipInfo(pay: "cod", payer: "receiver"))]
        XCTAssertFalse(cod(near, nil).senderPays)
        let real = cod(near, 18_480)
        XCTAssertTrue(real.senderPays)
        XCTAssertEqual(real.shipFee, 18_480)
        XCTAssertEqual(real.cod, 35_980)
        XCTAssertTrue(real.feeIsReal)
        XCTAssertEqual(cod([line(10_000, ShipInfo(pay: "cod"))], 18_480).cod, 28_480)
        XCTAssertEqual(cod([line(150_000, ShipInfo(pay: "cod", payer: "receiver"))], 18_480).cod, 150_000)
        XCTAssertEqual(cod([line(150_000, ShipInfo(pay: "cod", payer: "receiver", codOverride: 18_000))], 18_480).cod, 36_480)
        // Cước thật rẻ hơn 17.000đ: ngưỡng vẫn là 17.000đ, tiền cộng vào là cước thật.
        XCTAssertEqual(cod([line(16_900, ShipInfo(pay: "cod"))], 16_800).cod, 33_700)
        XCTAssertEqual(cod([line(150_000, ShipInfo(pay: "paid", payer: "receiver"))], 18_480).cod, 18_480)
    }

    func testGroupsMergeReadyOrdersOfAllDaysAndRows() throws {
        let old = order("05", price: 120_000, ts: Date(timeIntervalSince1970: 500), ship: ShipInfo(state: "ready", pay: "cod"))
        let now = order("08", price: 100_000, qty: 2, ts: Date(timeIntervalSince1970: 900), ship: ShipInfo(state: "ready", pay: "cod"))
        let held = order("07", ts: Date(timeIntervalSince1970: 700), ship: ShipInfo(state: "hold"))
        let groups = Vtp.readyGroups([now, held, old])
        XCTAssertEqual(groups.count, 1)
        let g = try XCTUnwrap(groups.first)
        XCTAssertEqual(g.orders.map(\.key), ["05", "08"])
        XCTAssertEqual(g.summary.cod, 320_000)
        XCTAssertEqual(g.summary.qty, 3)
        XCTAssertEqual(g.summary.receiver, "Lan Anh")
        XCTAssertEqual(g.summary.phone, "0912345678")
        XCTAssertEqual(g.summary.problems, [])

        let rows = Vtp.rows(groups)
        XCTAssertEqual(rows[6].count, 22)
        let row = rows[7]
        XCTAssertEqual(row.count, 22)
        XCTAssertEqual(row[1], .text("HD05+HD08"))
        XCTAssertEqual(row[4], .text("12 Trần Thái Tông, Phường Cầu Giấy, TP.Hà Nội"))
        XCTAssertEqual(row[5], .text("Quần áo"))
        XCTAssertEqual(row[9], .number(320_000))
        XCTAssertEqual(row[12], .text("VSL9"))
        XCTAssertEqual(row[18], .text("Người nhận trả"))
    }

    func testHeavyParcelNeedsSize() {
        let heavy = order("h", ship: ShipInfo(state: "ready", pay: "cod", weightG: 12_000))
        XCTAssertTrue(Vtp.readyGroups([heavy])[0].summary.problems.contains("Từ 10kg phải nhập kích thước"))
        let sized = order("h", ship: ShipInfo(state: "ready", pay: "cod", weightG: 12_000, lengthCm: 50, widthCm: 40, heightCm: 30))
        let g = Vtp.readyGroups([sized])
        XCTAssertEqual(g[0].summary.problems, [])
        XCTAssertEqual(Array(Vtp.rows(g)[7][15...17]), [.number(50), .number(40), .number(30)])
    }

    func testOldAndNewAddressResolveToViettelPostNames() {
        let old = VtpAddress.resolve(DeliveryAddress(street: "1 Lê Lợi", region: "Phường Bến Nghé, Quận 1, TP. Hồ Chí Minh"))
        XCTAssertTrue(old.ok, old.reason)
        XCTAssertEqual(old.line, "1 Lê Lợi, P.Bến Nghé, Q.1, TP.Hồ Chí Minh")
        let new = VtpAddress.resolve(DeliveryAddress(street: "1 Trần Thái Tông", region: "Phường Cầu Giấy, Hà Nội"))
        XCTAssertTrue(new.ok, new.reason)
        XCTAssertEqual(new.province, "TP.Hà Nội")
        XCTAssertFalse(VtpAddress.resolve(DeliveryAddress(street: "", region: "Phường Cầu Giấy, TP.Hà Nội")).ok)
    }

    func testXlsxIsZipWithSharedStrings() {
        let data = Vtp.xlsx(Vtp.readyGroups([order("a", ship: ShipInfo(state: "ready", pay: "cod"))]))
        XCTAssertEqual(Array(data.prefix(4)), [0x50, 0x4B, 0x03, 0x04])
        XCTAssertEqual(Array(data.suffix(22).prefix(4)), [0x50, 0x4B, 0x05, 0x06])
        XCTAssertEqual(Xlsx.crc32(Data("123456789".utf8)), 0xCBF4_3926)
    }

    func testShipJsonRoundTripsWithServer() throws {
        let json = #"{"state":"ready","pay":"cod","deposit":"50000","weightG":1500.4,"codOverride":null}"#
        let s = try JSONDecoder().decode(ShipInfo.self, from: Data(json.utf8))
        XCTAssertEqual(s.state, "ready")
        XCTAssertEqual(s.deposit, 50_000)
        XCTAssertEqual(s.weightG, 1500)
        XCTAssertNil(s.codOverride)
        let back = try JSONSerialization.jsonObject(with: JSONEncoder().encode(s)) as? [String: Any]
        XCTAssertTrue(back?["codOverride"] is NSNull)
    }

    // MARK: - Gửi vận đơn qua API

    func testVtpFieldsFromServerAndStatus() throws {
        let json = #"{"state":"exported","pay":"cod","vtpCode":"156288120034","vtpFee":22000,"vtpStatus":"505","vtpStatusName":"Chờ phát lại","vtpKind":"attention","vtpNote":"Không liên lạc được người nhận"}"#
        let s = try JSONDecoder().decode(ShipInfo.self, from: Data(json.utf8))
        XCTAssertEqual(s.vtpCode, "156288120034")
        XCTAssertEqual(s.vtpFee, 22_000)
        XCTAssertEqual(s.vtpStatus, 505)
        let o = order("a", ship: s, status: (true, false))
        XCTAssertEqual(Vtp.state(o), .exported)
        XCTAssertTrue(VtpTrack.needsAction(o))
        XCTAssertFalse(VtpTrack.canCancel(o))
        XCTAssertEqual(VtpTrack.pretty("156288120034"), "1562 8812 0034")

        var fresh = s
        fresh.vtpKind = "created"
        fresh.vtpStatus = 0
        let created = order("b", ship: fresh, status: (true, false))
        XCTAssertFalse(VtpTrack.needsAction(created))
        XCTAssertTrue(VtpTrack.canCancel(created))
        // Đã giao thì không còn cần xử lý.
        XCTAssertFalse(VtpTrack.needsAction(order("c", ship: s, status: (false, true))))

        // Đơn chưa có vận đơn không gửi trường vận đơn lên máy chủ.
        let plain = try JSONSerialization.jsonObject(with: JSONEncoder().encode(ShipInfo(state: "ready"))) as? [String: Any]
        XCTAssertNil(plain?["vtpCode"])
    }

    func testVtpPayloadMatchesExcelMoney() {
        let a = order("a", price: 120_000, ship: ShipInfo(state: "ready", pay: "cod", deposit: 20_000))
        let b = order("b", price: 80_000, ts: Date(timeIntervalSince1970: 2000), ship: ShipInfo(state: "ready", pay: "cod"))
        let g = Vtp.readyGroups([a, b])[0]
        let p = VtpTrack.payload(g, now: Date(timeIntervalSince1970: 1_800_000_000))
        XCTAssertEqual(p["key"] as? String, "lan.anh")
        XCTAssertEqual(p["itemIds"] as? [String], ["a-1", "b-1"])
        XCTAssertEqual(p["ref"] as? String, "HDa+HDb")
        XCTAssertEqual(p["cod"] as? Int, 180_000)
        XCTAssertEqual(p["goods"] as? Int, 200_000)
        XCTAssertEqual(p["phone"] as? String, "0912345678")
        XCTAssertEqual(p["receiver"] as? String, "Lan Anh")
        XCTAssertEqual(p["senderPays"] as? Bool, false)
        XCTAssertEqual(p["address"] as? String, g.summary.address.line)
        XCTAssertNil(p["size"])

        // Vận đơn cũ đã huỷ: thêm hậu tố để Viettel Post nhận lại mã đơn.
        var again = ShipInfo(state: "ready", pay: "cod")
        again.vtpOldCode = "156288120034"
        again.vtpKind = "cancelled"
        let c = order("c", ship: again)
        let p2 = VtpTrack.payload(Vtp.readyGroups([c])[0])
        XCTAssertTrue((p2["ref"] as? String ?? "").hasPrefix("HDc-"))
        XCTAssertEqual(VtpTrack.cancelledCode(c), "156288120034")
    }
}
