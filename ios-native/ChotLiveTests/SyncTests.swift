import XCTest
@testable import ChotLive

/// Đồng bộ với server: gói dữ liệu đúng định dạng, thay đổi chưa gửi không bị mất.
final class SyncTests: XCTestCase {
    private var directory: URL!
    private var suite: String!
    private var defaults: UserDefaults!
    private let account = "https://chotlive.test|shop.a"

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        suite = "chotlive.synctests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)
    }

    override func tearDownWithError() throws {
        defaults.removePersistentDomain(forName: suite)
        try? FileManager.default.removeItem(at: directory)
    }

    private func makeStore() -> Store { Store(account: account, directory: directory, defaults: defaults) }

    private func comment(_ id: String, user: String = "khach", session: String? = "s1") -> LiveComment {
        LiveComment(id: id, uniqueId: user, userId: "", nickname: "Khách", text: "Chốt 150", ts: Date(), price: 150_000, sessionId: session)
    }

    private func serverItem(_ id: String) -> OrderItem {
        OrderItem(id: id, comment: "Mã 150", price: 150_000, ts: Date(timeIntervalSince1970: 1_794_000_000))
    }

    private func serverCustomer(_ id: String, items: [String]) -> Customer {
        Customer(id: id, uniqueId: id, userId: "", nickname: id, items: items.map(serverItem))
    }

    /// Đánh dấu đã đồng bộ lần đầu, để test đi thẳng vào luồng thường ngày.
    private func markSynced(_ store: Store) {
        XCTAssertNotNil(store.makeSyncUpdate())
        store.acknowledgeSync(id: 1)
        XCTAssertTrue(store.syncState.syncedOnce)
    }

    // MARK: - Định dạng dữ liệu server

    func testDecodesServerSnapshot() throws {
        let json = """
        {"customers":[{"id":"linh","uniqueId":"Linh","userId":"719","nickname":"Linh","address":null,
          "items":[{"id":"it1","comment":"Chốt 150","price":150000,"ts":1794000000000,"printed":true,"delivered":false,
                    "shipping":true,"qty":2,"sessionId":null,"groupId":"o_1","code":"150","commentId":null}]}],
         "sessions":[{"id":"s1","tiktok":"shop","start":1794000000000,"end":null,"commentCount":12,"lastActivity":1794000100000}],
         "accounts":[{"id":"shop","uniqueId":"Shop","displayName":"Shop"}],
         "activeAccountId":"shop","printedCommentIds":["c1"]}
        """
        let snap = try ServerSync.decoder.decode(ServerSnapshot.self, from: Data(json.utf8))
        XCTAssertEqual(snap.customers[0].items[0].qty, 2)
        XCTAssertEqual(snap.customers[0].items[0].ts.timeIntervalSince1970, 1_794_000_000, accuracy: 0.001)
        XCTAssertTrue(snap.sessions[0].isLive)
        XCTAssertEqual(snap.sessions[0].commentCount, 12)
        XCTAssertEqual(snap.accounts[0].id, "shop")
        XCTAssertEqual(snap.printedCommentIds, ["c1"])
    }

    func testDecodesServerCommentsPage() throws {
        let json = """
        {"ok":true,"hasMore":false,"comments":[{"id":"c1","uniqueId":"k","userId":"","nickname":"K","text":"xin chào",
          "ts":1794000000000,"price":0,"printed":false,"sessionId":"s1"}]}
        """
        let page = try ServerSync.decoder.decode(CommentsPage.self, from: Data(json.utf8))
        XCTAssertEqual(page.comments[0].sessionId, "s1")
        XCTAssertFalse(page.hasMore)
    }

    func testUpdateEncodesWhatServerExpects() throws {
        let store = makeStore()
        store.addAccount(uniqueId: "Shop.A", displayName: "", activate: true)
        _ = store.saveToCustomer(comment("c1"))
        let update = try XCTUnwrap(store.makeSyncUpdate())
        let data = try ServerSync.encoder.encode(update)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(json["type"] as? String, "native_update")
        XCTAssertEqual(json["id"] as? Int, update.id)
        let customers = try XCTUnwrap(json["customers"] as? [[String: Any]])
        let item = try XCTUnwrap((customers[0]["items"] as? [[String: Any]])?.first)
        XCTAssertEqual(item["commentId"] as? String, "c1")
        // Mốc thời gian phải là mili giây.
        XCTAssertGreaterThan(try XCTUnwrap(item["ts"] as? Double), 1_000_000_000_000)
        XCTAssertEqual((json["accounts"] as? [[String: Any]])?.first?["uniqueId"] as? String, "Shop.A")
    }

    // MARK: - Lần đồng bộ đầu tiên

    func testFirstSyncUploadsLocalHistoryAndKeepsItUntilAck() {
        let store = makeStore()
        store.addComment(comment("c1", session: nil), tiktok: "shop")
        _ = store.saveToCustomer(store.comments[0])

        // Server chưa có khách này: không được làm mất dữ liệu trên máy.
        store.applyServer(ServerSnapshot(customers: [serverCustomer("web.only", items: ["w1"])]))
        XCTAssertEqual(Set(store.customers.map(\.id)), ["khach", "web.only"])

        let update = store.makeSyncUpdate()
        XCTAssertEqual(update?.comments?.map(\.id), ["c1"])
        XCTAssertEqual(update?.sessions?.count, 1)
        XCTAssertTrue(update?.customers.contains { $0.id == "khach" } ?? false)
        XCTAssertNil(store.makeSyncUpdate(), "chỉ gửi một gói mỗi lúc")

        store.acknowledgeSync(id: update?.id ?? 0)
        XCTAssertTrue(store.syncState.syncedOnce)
        XCTAssertNil(store.makeSyncUpdate(), "không còn gì để gửi")
    }

    func testOldFileWithoutSyncStateIsUploadedOnce() throws {
        let store = makeStore()
        _ = store.saveToCustomer(comment("c1"))
        store.save()
        let reopened = makeStore()
        XCTAssertFalse(reopened.syncState.syncedOnce)
        XCTAssertNotNil(reopened.makeSyncUpdate())
    }

    // MARK: - Thay đổi hằng ngày

    func testServerStateReplacesCleanCustomersButKeepsUnsentChanges() {
        let store = makeStore()
        markSynced(store)
        store.applyServer(ServerSnapshot(customers: [serverCustomer("a", items: ["a1"]), serverCustomer("b", items: ["b1"])]))
        XCTAssertEqual(store.customers.count, 2)

        // Sửa khách "a" trên máy, chưa gửi xong thì server gửi bản cũ về.
        store.setAddress(DeliveryAddress(receiver: "A", phone: "09", street: "", region: "", note: ""), customerId: "a")
        store.applyServer(ServerSnapshot(customers: [serverCustomer("a", items: ["a1"]), serverCustomer("b", items: ["b1", "b2"])]))
        XCTAssertEqual(store.customers.first { $0.id == "a" }?.address?.phone, "09", "giữ bản trên máy")
        XCTAssertEqual(store.customers.first { $0.id == "b" }?.items.count, 2, "khách khác vẫn nhận bản mới")

        // Web xoá khách "b".
        store.applyServer(ServerSnapshot(customers: [serverCustomer("a", items: ["a1"])]))
        XCTAssertNil(store.customers.first { $0.id == "b" })
    }

    func testOnlyChangedCustomersAreSent() {
        let store = makeStore()
        markSynced(store)
        store.applyServer(ServerSnapshot(customers: [serverCustomer("a", items: ["a1"]), serverCustomer("b", items: ["b1"])]))
        store.markPrinted(itemId: "a1")
        let update = store.makeSyncUpdate()
        XCTAssertEqual(update?.customers.map(\.id), ["a"])
        XCTAssertNil(update?.sessions)
        XCTAssertNil(update?.comments)
    }

    func testDeletedItemStaysDeletedAndIsReported() {
        let store = makeStore()
        markSynced(store)
        store.applyServer(ServerSnapshot(customers: [serverCustomer("a", items: ["a1"])]))
        store.deleteItem(customerId: "a", itemId: "a1")
        XCTAssertTrue(store.customers.isEmpty)

        // Bản cũ từ server về trong lúc chưa gửi lệnh xoá: không được hiện lại.
        store.applyServer(ServerSnapshot(customers: [serverCustomer("a", items: ["a1"])]))
        XCTAssertTrue(store.customers.isEmpty)

        let update = store.makeSyncUpdate()
        XCTAssertEqual(update?.deletedItemIds, ["a1"])
        store.acknowledgeSync(id: update?.id ?? 0)
        XCTAssertNil(store.makeSyncUpdate())
    }

    func testChangeWhileSendingIsSentAgain() {
        let store = makeStore()
        markSynced(store)
        store.applyServer(ServerSnapshot(customers: [serverCustomer("a", items: ["a1"])]))
        store.markPrinted(itemId: "a1")
        let first = store.makeSyncUpdate()
        store.setAddress(DeliveryAddress(receiver: "A", phone: "09", street: "", region: "", note: ""), customerId: "a")
        XCTAssertTrue(store.acknowledgeSync(id: first?.id ?? 0), "còn thay đổi mới")
        XCTAssertEqual(store.makeSyncUpdate()?.customers.first?.address?.phone, "09")
    }

    func testConnectionLossKeepsChangesForNextConnection() {
        let store = makeStore()
        markSynced(store)
        store.applyServer(ServerSnapshot(customers: [serverCustomer("a", items: ["a1"])]))
        store.markPrinted(itemId: "a1")
        XCTAssertNotNil(store.makeSyncUpdate())
        store.syncInterrupted()
        XCTAssertEqual(store.makeSyncUpdate()?.customers.map(\.id), ["a"])
    }

    func testUnsentChangesSurviveRestart() {
        let store = makeStore()
        markSynced(store)
        store.applyServer(ServerSnapshot(customers: [serverCustomer("a", items: ["a1"])]))
        store.deleteItem(customerId: "a", itemId: "a1")
        store.save()
        let reopened = makeStore()
        XCTAssertEqual(reopened.makeSyncUpdate()?.deletedItemIds, ["a1"])
    }

    // MARK: - Phiên và bình luận

    func testServerSessionsKeepSeveralLivesOpenAtOnce() {
        let store = makeStore()
        markSynced(store)
        let start = Date()
        store.applyServer(ServerSnapshot(sessions: [
            LiveSession(id: "s1", tiktok: "shop.a", start: start),
            LiveSession(id: "s2", tiktok: "shop.b", start: start.addingTimeInterval(1))
        ]))
        XCTAssertEqual(store.sessions.filter(\.isLive).count, 2)

        store.addComment(comment("c1", session: "s1"), tiktok: "ignored")
        store.addComment(comment("c2", session: "s2"), tiktok: "ignored")
        XCTAssertEqual(store.sessions.first { $0.id == "s1" }?.commentCount, 1)
        XCTAssertEqual(store.sessions.first { $0.id == "s2" }?.commentCount, 1)
        XCTAssertEqual(store.comments(session: "s1").map(\.id), ["c1"])
        XCTAssertEqual(store.sessions.count, 2, "không tự tạo phiên trên máy")
    }

    func testLocalOpenSessionUnknownToServerGetsClosed() {
        let store = makeStore()
        store.addComment(comment("c1", session: nil), tiktok: "shop")
        XCTAssertNotNil(store.openSession)
        store.applyServer(ServerSnapshot())
        XCTAssertNil(store.openSession)
        XCTAssertEqual(store.sessions.count, 1, "phiên cũ vẫn còn trong lịch sử")
    }

    func testCatchUpCommentsAreNotDuplicatedAndKeepNewestFirst() {
        let store = makeStore()
        var older = comment("old")
        older.ts = Date(timeIntervalSinceNow: -60)
        var newer = comment("new")
        newer.ts = Date()
        store.addComment(newer, tiktok: "")
        store.addComments([older, newer])
        XCTAssertEqual(store.comments.map(\.id), ["new", "old"])
        store.addComment(older, tiktok: "")
        XCTAssertEqual(store.comments.count, 2)
    }

    func testPrintedOnWebShowsOnPhone() {
        let store = makeStore()
        markSynced(store)
        store.addComment(comment("c1"), tiktok: "")
        store.applyServer(ServerSnapshot(printedCommentIds: ["c1"]))
        XCTAssertTrue(store.comments[0].printed)
    }

    func testSavedTikTokIdsFollowServerUnlessChangedHere() {
        let store = makeStore()
        markSynced(store)
        let shop = TikTokAccount(id: "shop", uniqueId: "Shop", displayName: "Shop")
        store.applyServer(ServerSnapshot(accounts: [shop], activeAccountId: "shop"))
        XCTAssertEqual(store.activeAccount?.id, "shop")

        store.removeAccount("shop")
        XCTAssertEqual(store.syncState.deletedAccounts, ["shop"])
        store.applyServer(ServerSnapshot(accounts: [shop], activeAccountId: "shop"))
        XCTAssertTrue(store.accounts.isEmpty, "đã xoá trên máy thì không hiện lại")
        XCTAssertEqual(store.makeSyncUpdate()?.deletedAccountIds, ["shop"])
    }
}
