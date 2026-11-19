import XCTest
@testable import ChotLive

/// Nhiều tài khoản đẩy nháp trên một máy: phiên cũ giữ nguyên, mỗi tài khoản phiên riêng,
/// xoá nháp đi đúng tài khoản đã đẩy. Số điện thoại trong test là số giả.
@MainActor
final class VtpDraftAccountsTests: XCTestCase {
    private typealias Secrets = VtpDraftTests.MemorySecrets
    private typealias Mock = VtpDraftTests.MockVtp

    private func jwt(_ sub: String) -> String {
        let payload = VtpJ.b64u(VtpJ.data(["exp": Int(Date().timeIntervalSince1970 + 3600), "sub": sub]))
        return VtpJ.b64u(Data("{\"alg\":\"none\"}".utf8)) + "." + payload + ".c2ln"
    }

    private func freshDefaults() -> UserDefaults { UserDefaults(suiteName: "vtpdraft-hub-" + UUID().uuidString)! }

    /// Hai tài khoản đã đăng nhập: "" (khoá cũ, số 0900000111) và "a1" (số 0900000222).
    private func twoAccounts(_ secrets: Secrets, _ defaults: UserDefaults) -> (String, String) {
        let t1 = jwt("one"), t2 = jwt("two")
        secrets.set(Data(t1.utf8), "token")
        secrets.set(Data("rt1".utf8), "refresh")
        secrets.set(Data(t2.utf8), "a1.token")
        secrets.set(Data("rt2".utf8), "a1.refresh")
        defaults.set(["", "a1"], forKey: "vtpDraft.accounts")
        defaults.set("Tài khoản Một", forKey: "vtpDraft.userName")
        defaults.set("0900000111", forKey: "vtpDraft.login")
        defaults.set("Tài khoản Hai", forKey: "vtpDraft.a1.userName")
        defaults.set("0900000222", forKey: "vtpDraft.a1.login")
        return (t1, t2)
    }

    private func group(code: String, account: String) -> Vtp.Group {
        var ship = ShipInfo(state: "ready", pay: "cod")
        ship.draftCode = code
        ship.draftAccount = account
        var it = OrderItem(id: "k-1", comment: "chốt", price: 150_000, ts: Date(timeIntervalSince1970: 1000), qty: 1, groupId: "k")
        it.ship = ship
        let addr = DeliveryAddress(receiver: "Khách", phone: "0911111111", street: "1 Lê Lợi", region: "Phường Thuận Hoá, TP.Huế")
        let c = Customer(id: "khach", uniqueId: "khach", userId: "", nickname: "Khách", items: [], address: addr)
        return Vtp.readyGroups([Order(key: "k", customer: c, items: [it])])[0]
    }

    func testOldSingleSessionStillWorksAsFirstAccount() {
        let secrets = Secrets(), defaults = freshDefaults()
        secrets.set(Data(jwt("old").utf8), "token")
        defaults.set("Ngô Văn A", forKey: "vtpDraft.userName")
        let hub = VtpDraftHub(secrets: secrets, defaults: defaults, transport: Mock().transport)
        XCTAssertEqual(hub.clients.count, 1)
        XCTAssertTrue(hub.current.loggedIn)
        XCTAssertEqual(hub.current.accountId, "")
        // Bản cũ lưu họ tên vào userName: không coi họ tên là số điện thoại.
        XCTAssertEqual(hub.current.phone, "")
        XCTAssertEqual(hub.current.displayName, "Ngô Văn A")
        XCTAssertEqual(hub.current.accountLabel, "Ngô Văn A")
        XCTAssertTrue(hub.current.owns("Ngô Văn A"), "nháp đẩy bằng bản 1.1.x ghi họ tên vẫn nhận ra")
    }

    func testAccountsKeepSeparateSessionsAndSelection() {
        let secrets = Secrets(), defaults = freshDefaults()
        _ = twoAccounts(secrets, defaults)
        let hub = VtpDraftHub(secrets: secrets, defaults: defaults, transport: Mock().transport)
        XCTAssertEqual(hub.loggedInClients.count, 2)
        XCTAssertEqual(hub.current.phone, "0900 *** 111")
        hub.select("a1")
        XCTAssertEqual(hub.current.phone, "0900 *** 222")
        XCTAssertEqual(hub.current.displayName, "Tài khoản Hai")

        // Mở lại app: nhớ tài khoản đang dùng.
        let again = VtpDraftHub(secrets: secrets, defaults: defaults, transport: Mock().transport)
        XCTAssertEqual(again.currentId, "a1")

        // Bỏ một tài khoản: chỉ xoá phiên của tài khoản đó.
        again.remove("a1")
        XCTAssertNil(secrets.get("a1.token"))
        XCTAssertNotNil(secrets.get("token"))
        XCTAssertEqual(again.currentId, "")
    }

    func testAddAccountThenCancelLeavesNoEmptySlot() {
        let secrets = Secrets(), defaults = freshDefaults()
        secrets.set(Data(jwt("old").utf8), "token")
        let hub = VtpDraftHub(secrets: secrets, defaults: defaults, transport: Mock().transport)
        hub.addAccount()
        XCTAssertEqual(hub.clients.count, 2)
        XCTAssertFalse(hub.current.loggedIn)
        hub.addAccount()
        XCTAssertEqual(hub.clients.count, 2, "đã có chỗ trống thì dùng lại")
        hub.remove(hub.currentId)
        XCTAssertEqual(hub.clients.count, 1)
        XCTAssertTrue(hub.current.loggedIn)

        // Bỏ dở rồi đóng app: lần mở sau không còn chỗ trống.
        hub.addAccount()
        let again = VtpDraftHub(secrets: secrets, defaults: defaults, transport: Mock().transport)
        XCTAssertEqual(again.clients.count, 1)
    }

    func testDeleteUsesTheAccountThatPushedTheDraft() async {
        let secrets = Secrets(), defaults = freshDefaults()
        let (_, t2) = twoAccounts(secrets, defaults)
        let mock = Mock()
        mock.handler = { _ in (200, #"{"error":false,"message":"OK"}"#) }
        let hub = VtpDraftHub(secrets: secrets, defaults: defaults, transport: mock.transport)
        XCTAssertEqual(hub.currentId, "", "đang dùng tài khoản Một")

        let left = await hub.deleteDrafts(of: group(code: "1577", account: "0900 *** 222"))
        XCTAssertTrue(left.isEmpty)
        XCTAssertEqual(mock.requests.count, 1)
        XCTAssertEqual(mock.requests[0].value(forHTTPHeaderField: "token"), t2, "xoá bằng tài khoản Hai, không phải tài khoản đang dùng")
    }

    func testDeleteFromAccountNotOnThisPhoneIsReportedNotSent() async {
        let secrets = Secrets(), defaults = freshDefaults()
        _ = twoAccounts(secrets, defaults)
        let mock = Mock()
        let hub = VtpDraftHub(secrets: secrets, defaults: defaults, transport: mock.transport)
        let left = await hub.deleteDrafts(of: group(code: "1577", account: "0900 *** 999"))
        XCTAssertEqual(left.map(\.code), ["1577"])
        XCTAssertTrue(left[0].reason.contains("0900 *** 999"))
        XCTAssertTrue(mock.requests.isEmpty, "không gửi lệnh xoá bằng tài khoản khác")
    }

    func testLoginAgainWithSameNumberDropsOldSlot() {
        let secrets = Secrets(), defaults = freshDefaults()
        _ = twoAccounts(secrets, defaults)
        // Chỗ a2 vừa đăng nhập lại đúng số của tài khoản Hai.
        secrets.set(Data(jwt("three").utf8), "a2.token")
        defaults.set("0900000222", forKey: "vtpDraft.a2.login")
        defaults.set(["", "a1", "a2"], forKey: "vtpDraft.accounts")
        let hub = VtpDraftHub(secrets: secrets, defaults: defaults, transport: Mock().transport)
        let fresh = hub.clients.first { $0.accountId == "a2" }!
        hub.didLogin(fresh)
        XCTAssertEqual(hub.clients.map(\.accountId), ["", "a2"])
        XCTAssertNil(secrets.get("a1.token"))
    }
}
