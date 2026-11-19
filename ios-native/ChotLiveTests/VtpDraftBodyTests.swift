import XCTest
@testable import ChotLive

/// Nội dung nháp Viettel Post dựng từ đơn thật, và nhận biết nháp đã cũ sau khi sửa đơn.
final class VtpDraftBodyTests: XCTestCase {
    private let address = DeliveryAddress(receiver: "Lan Anh 🌸", phone: "0912 345 678", street: "12 Trần Thái Tông",
                                          region: "Phường Cầu Giấy, TP.Hà Nội")
    private let kho = VtpDraftKho(id: "777", cusId: 45, name: "Shop Thu", phone: "0900000000", address: "1 Lê Lợi, Huế",
                                  province: 1, district: 2, ward: 3)
    private let place = VtpDraftPlace(province: 10, district: 20, ward: 30, formatted: "", confidence: 1)

    private func order(_ key: String, price: Int = 150_000, ship: ShipInfo, address: DeliveryAddress? = nil) -> Order {
        var it = OrderItem(id: key + "-1", comment: "chốt", price: price, ts: Date(timeIntervalSince1970: 1000), qty: 1, groupId: key)
        it.ship = ship
        it.orderCode = "HD" + key
        let c = Customer(id: "lan.anh", uniqueId: "lan.anh", userId: "", nickname: "Lan", items: [], address: address ?? self.address)
        return Order(key: key, customer: c, items: [it])
    }

    private func group(_ orders: [Order]) -> Vtp.Group {
        let g = Vtp.readyGroups(orders)
        XCTAssertEqual(g.count, 1)
        return g[0]
    }

    func testPaymentMatchesServerRules() {
        XCTAssertEqual(VtpDraftBody.payment(cod: 100_000, senderPays: false), 2)
        XCTAssertEqual(VtpDraftBody.payment(cod: 100_000, senderPays: true), 3)
        XCTAssertEqual(VtpDraftBody.payment(cod: 0, senderPays: true), 1)
        XCTAssertEqual(VtpDraftBody.payment(cod: 0, senderPays: false), 4)
    }

    func testBodyUsesSummaryMoneyAndPlaceCodes() {
        let g = group([order("a", price: 120_000, ship: ShipInfo(state: "ready", pay: "cod")),
                       order("b", price: 299_000, ship: ShipInfo(state: "ready", pay: "cod", weightG: 2500))])
        let b = VtpDraftBody.make(g, kho: kho, place: place, service: "VSL9")
        XCTAssertEqual(b["TYPE"] as? Int, 12)
        XCTAssertEqual(b["ORDER_NUMBER"] as? String, "")
        XCTAssertEqual(b["MONEY_COLLECTION"] as? Int, 419_000)
        XCTAssertEqual(b["MONEY_COLLECTION"] as? Int, g.summary.cod)
        XCTAssertEqual(b["PRODUCT_PRICE"] as? Int, 419_000)
        XCTAssertEqual(b["ORDER_PAYMENT"] as? Int, 2)
        XCTAssertEqual(b["PRODUCT_WEIGHT"] as? Int, 2500)
        XCTAssertEqual(b["PRODUCT_QUANTITY"] as? Int, 2)
        XCTAssertEqual(b["RECEIVER_FULLNAME"] as? String, "Lan Anh", "bỏ emoji như file Excel")
        XCTAssertEqual(b["RECEIVER_PHONE"] as? String, "0912345678")
        XCTAssertEqual(b["RECEIVER_PROVINCE"] as? Int, 10)
        XCTAssertEqual(b["RECEIVER_WARD"] as? Int, 30)
        XCTAssertEqual(b["SENDER_PROVINCE"] as? String, "1")
        XCTAssertEqual(b["GROUPADDRESS_ID"] as? String, "777")
        XCTAssertEqual(b["CUS_ID"] as? Int, 45)
        XCTAssertEqual(b["ORDER_SERVICE"] as? String, "VSL9")
        XCTAssertEqual(b["ORDER_REFERENCE"] as? String, "HDa+HDb")
        XCTAssertEqual((b["LIST_ITEM"] as? [[String: Any]])?.first?["PRODUCT_PRICE"] as? Int, 419_000)
        // Body phải đổi được sang JSON để gửi đi.
        XCTAssertNotNil(try? JSONSerialization.data(withJSONObject: b))
    }

    func testSmallOrderShopPaysAddsFeeLikeExcel() {
        let g = group([order("a", price: 10_000, ship: ShipInfo(state: "ready", pay: "cod", payer: "sender"))])
        let b = VtpDraftBody.make(g, kho: kho, place: place, service: "")
        XCTAssertEqual(b["MONEY_COLLECTION"] as? Int, 27_000)
        XCTAssertEqual(b["ORDER_PAYMENT"] as? Int, 3)
        XCTAssertEqual(b["ORDER_SERVICE"] as? String, Vtp.defaultService)
    }

    func testPaidAndShopPaysIsNoCollection() {
        let g = group([order("a", ship: ShipInfo(state: "ready", pay: "paid", payer: "sender"))])
        let b = VtpDraftBody.make(g, kho: kho, place: place, service: "STK")
        XCTAssertEqual(b["MONEY_COLLECTION"] as? Int, 0)
        XCTAssertEqual(b["ORDER_PAYMENT"] as? Int, 1)
    }

    func testClipCountsBytesNotCharacters() {
        let s = String(repeating: "ạ", count: 100)   // 3 byte mỗi chữ
        let c = VtpDraftBody.clip(s)
        XCTAssertLessThanOrEqual(c.utf8.count, 150)
        XCTAssertEqual(c.count, 50)
    }

    func testHashChangesWhenOrderIsEdited() {
        let base = group([order("a", ship: ShipInfo(state: "ready", pay: "cod"))])
        let h = VtpDraftBody.hash(base, service: "VSL9")
        XCTAssertEqual(h, VtpDraftBody.hash(base, service: "VSL9"))
        XCTAssertNotEqual(h, VtpDraftBody.hash(base, service: "STK"), "đổi dịch vụ")
        let cod = group([order("a", ship: ShipInfo(state: "ready", pay: "cod", codOverride: 99_000))])
        XCTAssertNotEqual(h, VtpDraftBody.hash(cod, service: "VSL9"), "sửa thu hộ")
        let moved = DeliveryAddress(receiver: "Lan Anh", phone: "0912345678", street: "99 Kim Mã", region: "Phường Cầu Giấy, TP.Hà Nội")
        let addr = group([order("a", ship: ShipInfo(state: "ready", pay: "cod"), address: moved)])
        XCTAssertNotEqual(h, VtpDraftBody.hash(addr, service: "VSL9"), "sửa địa chỉ")
        let more = group([order("a", ship: ShipInfo(state: "ready", pay: "cod")), order("b", ship: ShipInfo(state: "ready", pay: "cod"))])
        XCTAssertNotEqual(h, VtpDraftBody.hash(more, service: "VSL9"), "thêm đơn")
    }

    func testStatus() {
        var ship = ShipInfo(state: "ready", pay: "cod")
        let fresh = group([order("a", ship: ship)])
        XCTAssertEqual(VtpDraftBody.status(fresh, service: "VSL9"), .notPushed)

        ship.draftCode = "157491796322"
        ship.draftHash = VtpDraftBody.hash(fresh, service: "VSL9")
        ship.draftAt = 5
        let pushed = group([order("a", ship: ship)])
        XCTAssertEqual(VtpDraftBody.status(pushed, service: "VSL9"), .pushed(code: "157491796322", at: 5))
        XCTAssertEqual(VtpDraftBody.status(pushed, service: "STK"), .stale(code: "157491796322"))

        // Thêm đơn mới cho khách sau khi đẩy: nháp cũ.
        let added = group([order("a", ship: ship), order("b", ship: ShipInfo(state: "ready", pay: "cod"))])
        XCTAssertEqual(VtpDraftBody.status(added, service: "VSL9"), .stale(code: "157491796322"))
        XCTAssertEqual(VtpDraftBody.codes(added), ["157491796322"])

        var failed = ShipInfo(state: "ready", pay: "cod")
        failed.draftError = "Viettel Post không nhận ra địa chỉ"
        XCTAssertEqual(VtpDraftBody.status(group([order("a", ship: failed)]), service: "VSL9"), .failed("Viettel Post không nhận ra địa chỉ"))
    }

    func testCustomerWithWaybillCannotBeDrafted() {
        var ship = ShipInfo(state: "ready", pay: "cod")
        ship.vtpCode = "1234567890"
        let g = group([order("a", ship: ship)])
        XCTAssertTrue(VtpDraftBody.problems(g).contains("Khách đã có vận đơn"))
    }

    func testDraftFieldsSurviveJsonAndAreOmittedWhenUnused() throws {
        var s = ShipInfo(state: "ready")
        let plain = try JSONSerialization.jsonObject(with: JSONEncoder().encode(s)) as? [String: Any]
        XCTAssertNil(plain?["draftCode"], "đơn chưa từng có nháp không mang thêm trường rỗng")

        s.draftCode = "157491796322"
        s.draftHash = "abcd"
        s.draftAt = 1_700_000_000_000
        s.draftAccount = "0987 *** 321"
        let back = try JSONDecoder().decode(ShipInfo.self, from: JSONEncoder().encode(s))
        XCTAssertEqual(back.draftCode, "157491796322")
        XCTAssertEqual(back.draftHash, "abcd")
        XCTAssertEqual(back.draftAt, 1_700_000_000_000)
        XCTAssertEqual(back.draftAccount, "0987 *** 321")
        // Web có thể lưu mã nháp dạng số.
        let num = try JSONDecoder().decode(ShipInfo.self, from: Data(#"{"draftCode":157491796322}"#.utf8))
        XCTAssertEqual(num.draftCode, "157491796322")
    }
}
