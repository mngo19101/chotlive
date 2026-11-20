import Combine
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

    func testEmptyAccountsListDoesNotCrashAndCleansAbandonedSlots() {
        let secrets = Secrets(), defaults = freshDefaults()
        defaults.set([String](), forKey: "vtpDraft.accounts")
        let emptyHub = VtpDraftHub(secrets: secrets, defaults: defaults, transport: Mock().transport)
        XCTAssertEqual(emptyHub.clients.count, 1)
        XCTAssertEqual(emptyHub.currentId, "")

        // Có tài khoản 1 đã đăng nhập và một chỗ trống bỏ dở: mở lại phải dọn sạch chỗ bỏ dở.
        secrets.set(Data(jwt("one").utf8), "token")
        secrets.set(Data("k-abandoned".utf8), "abandoned.key")
        defaults.set("dev-abandoned", forKey: "vtpDraft.abandoned.deviceId")
        defaults.set(["", "abandoned"], forKey: "vtpDraft.accounts")
        let cleaned = VtpDraftHub(secrets: secrets, defaults: defaults, transport: Mock().transport)
        XCTAssertEqual(cleaned.clients.map(\.accountId), [""])
        XCTAssertNil(secrets.get("abandoned.key"))
        XCTAssertNil(defaults.string(forKey: "vtpDraft.abandoned.deviceId"))
    }

    func testDeviceAndDpopKeysAreIsolatedPerAccount() {
        let secrets = Secrets(), defaults = freshDefaults()
        secrets.set(Data(jwt("one").utf8), "token")
        let hub = VtpDraftHub(secrets: secrets, defaults: defaults, transport: Mock().transport)
        hub.addAccount()
        XCTAssertEqual(hub.clients.count, 2)
        let first = hub.clients[0], second = hub.clients[1]
        XCTAssertNotEqual(first.deviceId, second.deviceId)
        XCTAssertNotNil(secrets.get("key"))
        XCTAssertNotNil(secrets.get("\(second.accountId).key"))
        XCTAssertNotEqual(secrets.get("key"), secrets.get("\(second.accountId).key"))

        // Gỡ tài khoản thứ 2 phải xoá luôn key/deviceId riêng của nó, không đụng tài khoản 1.
        let secondId = second.accountId
        hub.remove(secondId)
        XCTAssertNil(secrets.get("\(secondId).key"))
        XCTAssertNil(defaults.string(forKey: "vtpDraft.\(secondId).deviceId"))
        XCTAssertNotNil(secrets.get("key"))
        XCTAssertNotNil(defaults.string(forKey: "vtpDraft.deviceId"))
    }

    func testLegacySecondAccountMigratesAndRotatesOnRelogin() async {
        let secrets = Secrets(), defaults = freshDefaults()
        _ = twoAccounts(secrets, defaults)
        let newToken = jwt("two-new")
        let mock = Mock()
        mock.handler = { req in
            if req.url!.path.contains("/PasswordCaptcha") {
                return (200, #"{"status":true,"accessToken":"sso-new","phoneNumber":"0900000222"}"#)
            }
            if req.url!.path == "/api/user/ssoUpdateUser" {
                return (200, #"{"error":false,"data":{"TokenKey":"\#(newToken)","refreshToken":"rt-2","UserName":"Tài khoản Hai","Phone":"0900000222","UserId":"222"}}"#)
            }
            if req.url!.path == "/api/setting/listInventoryV2" {
                return (200, "[]")
            }
            return (404, "{}")
        }
        let hub = VtpDraftHub(secrets: secrets, defaults: defaults, transport: mock.transport)
        let first = hub.clients[0], second = hub.clients[1]
        let legacyDevId = first.deviceId
        XCTAssertEqual(second.deviceId, legacyDevId, "tài khoản 2 bản cũ giữ tạm deviceId để không gãy phiên DPoP hiện có")

        await second.startLogin(user: "0900000222", password: "secret")
        XCTAssertNotEqual(second.deviceId, legacyDevId, "đăng nhập lại phải tách sang deviceId/DPoP key riêng")
        XCTAssertNotNil(secrets.get("a1.key"))
        XCTAssertNotEqual(secrets.get("key"), secrets.get("a1.key"))
    }

    func testSwitchAppAccountAndSyncWithPartnerPhone() {
        let secrets = Secrets(), defaults = freshDefaults()
        _ = twoAccounts(secrets, defaults)
        let appA = "https://shop.vn|chu_a"
        let appB = "https://shop.vn|chu_b"
        let hub = VtpDraftHub(appAccount: appA, secrets: secrets, defaults: defaults, transport: Mock().transport)

        // Tài khoản ChốtLive A khớp phần 1 với VTP 1 ("").
        hub.syncWithPartner(phone: "090•••111")
        XCTAssertEqual(hub.currentId, "")

        // Chuyển sang tài khoản ChốtLive B có phần 1 là VTP 2 ("a1"): tự chọn VTP 2.
        hub.switchAppAccount(appB)
        hub.syncWithPartner(phone: "090•••222")
        XCTAssertEqual(hub.currentId, "a1")

        // Quay lại tài khoản ChốtLive A: khôi phục VTP 1.
        hub.switchAppAccount(appA)
        XCTAssertEqual(hub.currentId, "")

        // Nếu người dùng tự chọn VTP 2 cho A, lần sync sau không ghi đè lựa chọn tay.
        hub.select("a1")
        hub.syncWithPartner(phone: "090•••111")
        XCTAssertEqual(hub.currentId, "a1")

        // Mở lại app ở tài khoản B vẫn nhớ VTP 2.
        hub.switchAppAccount(appB)
        let relaunched = VtpDraftHub(appAccount: appB, secrets: secrets, defaults: defaults, transport: Mock().transport)
        XCTAssertEqual(relaunched.currentId, "a1")
    }

    func testHubForwardsChildClientObjectWillChange() async {
        let secrets = Secrets(), defaults = freshDefaults()
        secrets.set(Data(jwt("one").utf8), "token")
        secrets.set(Data("rt1".utf8), "refresh")
        // Tài khoản 2 token đã hết hạn và refresh bị từ chối.
        let expiredPayload = VtpJ.b64u(VtpJ.data(["exp": Int(Date().timeIntervalSince1970 - 60), "sub": "two"]))
        let expiredJwt = VtpJ.b64u(Data("{\"alg\":\"none\"}".utf8)) + "." + expiredPayload + ".c2ln"
        secrets.set(Data(expiredJwt.utf8), "a1.token")
        secrets.set(Data("rt2".utf8), "a1.refresh")
        defaults.set(["", "a1"], forKey: "vtpDraft.accounts")
        defaults.set("0900000111", forKey: "vtpDraft.login")
        defaults.set("0900000222", forKey: "vtpDraft.a1.login")

        let mock = Mock()
        mock.handler = { _ in (200, #"{"error":true,"message":"Refresh token hết hạn"}"#) }
        let hub = VtpDraftHub(secrets: secrets, defaults: defaults, transport: mock.transport)
        var changes = 0
        let bag = hub.objectWillChange.sink { changes += 1 }
        defer { bag.cancel() }

        await hub.refreshAll()
        XCTAssertTrue(hub.clients[1].sessionExpired)
        XCTAssertGreaterThan(changes, 0)
    }

    func testDidLoginDeduplicatesByVtpUserIdAndRemapsCurrentByApp() async {
        let secrets = Secrets(), defaults = freshDefaults()
        _ = twoAccounts(secrets, defaults)
        defaults.set("200", forKey: "vtpDraft.a1.vtpUserId")
        let appB = "https://shop.vn|chu_b"
        let hub = VtpDraftHub(appAccount: appB, secrets: secrets, defaults: defaults, transport: Mock().transport)
        hub.select("a1")

        // Thêm slot mới và đăng nhập bằng email nhưng cùng UserId "200" của "a1".
        hub.addAccount()
        let fresh = hub.current
        secrets.set(Data(jwt("two-email").utf8), "\(fresh.accountId).token")
        defaults.set("shop@example.com", forKey: "vtpDraft.\(fresh.accountId).login")
        defaults.set("200", forKey: "vtpDraft.\(fresh.accountId).vtpUserId")
        let reloaded = VtpDraftHub(appAccount: appB, secrets: secrets, defaults: defaults, transport: Mock().transport)
        let freshClient = reloaded.clients.first { $0.accountId == fresh.accountId }!
        reloaded.didLogin(freshClient)

        XCTAssertEqual(reloaded.clients.map(\.accountId), ["", fresh.accountId])
        XCTAssertNil(secrets.get("a1.token"))
        XCTAssertEqual(reloaded.currentId, fresh.accountId)

        // Chuyển sang A rồi về B phải dùng đúng slot mới đã remap.
        reloaded.switchAppAccount("https://shop.vn|chu_a")
        reloaded.switchAppAccount(appB)
        XCTAssertEqual(reloaded.currentId, fresh.accountId)
    }

    func testPhonesMatchAndOwnsHandleMaskedAndNormalizedFormats() {
        XCTAssertEqual(VtpDraftClient.phonesMatch("090•••222", "0900000222"), true)
        XCTAssertEqual(VtpDraftClient.phonesMatch("090•••222", "+84 900 000 222"), true)
        XCTAssertEqual(VtpDraftClient.phonesMatch("0900 *** 222", "090•••222"), true)
        XCTAssertEqual(VtpDraftClient.phonesMatch("090•••111", "0900000222"), false)
        XCTAssertEqual(VtpDraftClient.phonesMatch("+84900000222", "0900000222"), true)
        XCTAssertNil(VtpDraftClient.phonesMatch("090•••222", "shop@gmail.com"))

        let secrets = Secrets(), defaults = freshDefaults()
        secrets.set(Data(jwt("one").utf8), "token")
        defaults.set("+84900000111", forKey: "vtpDraft.login")
        let c = VtpDraftClient(secrets: secrets, defaults: defaults, transport: Mock().transport)
        XCTAssertEqual(c.phone, "0900 *** 111")
        XCTAssertTrue(c.owns("090•••111"))
        XCTAssertTrue(c.owns("0900000111"))
        XCTAssertFalse(c.owns("090•••999"))
    }
}
