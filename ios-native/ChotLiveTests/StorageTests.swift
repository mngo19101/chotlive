import XCTest
@testable import ChotLive

final class StorageTests: XCTestCase {
    private let accountA = AuthStorage.accountKey(server: "https://chotlive.test", user: "Shop.A")
    private let accountB = AuthStorage.accountKey(server: "https://chotlive.test", user: "shop.b")

    private var directory: URL!
    private var suite: String!
    private var defaults: UserDefaults!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        suite = "chotlive.tests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)
        Keychain.delete()
    }

    override func tearDownWithError() throws {
        defaults.removePersistentDomain(forName: suite)
        try? FileManager.default.removeItem(at: directory)
        Keychain.delete()
    }

    private func makeStore(_ account: String?) -> Store {
        Store(account: account, directory: directory, defaults: defaults)
    }

    private func comment(_ id: String, _ text: String = "Mã 150 chốt") -> LiveComment {
        LiveComment(id: id, uniqueId: "khach", userId: "", nickname: "Khách", text: text, ts: Date(), price: 150_000)
    }

    private func accountFile(_ account: String) -> URL {
        directory.appendingPathComponent("accounts").appendingPathComponent(AuthStorage.folderName(account: account))
            .appendingPathComponent("chotlive.json")
    }

    private var legacyFile: URL { directory.appendingPathComponent("chotlive.json") }

    private func writeLegacy(commentId: String) throws {
        let snap = Snapshot(comments: [comment(commentId)], customers: [], sessions: [], accounts: [],
                            activeAccountId: nil, keywords: nil)
        try JSONEncoder().encode(snap).write(to: legacyFile)
    }

    private func writeRaw(_ text: String, to url: URL) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(text.utf8).write(to: url)
    }

    // MARK: - Tách dữ liệu theo tài khoản

    func testAccountsDoNotSeeEachOthersData() {
        let store = makeStore(accountA)
        store.addComment(comment("a1"), tiktok: "shop_a")
        store.setKeywords(["ib"])

        store.switchAccount(accountB)
        XCTAssertTrue(store.comments.isEmpty)
        XCTAssertTrue(store.sessions.isEmpty)
        XCTAssertTrue(store.accounts.isEmpty)
        XCTAssertEqual(store.keywords, ["chốt", "lấy"])
        store.addComment(comment("b1"), tiktok: "shop_b")

        store.switchAccount(accountA)
        XCTAssertEqual(store.comments.map(\.id), ["a1"])
        XCTAssertEqual(store.accounts.map(\.id), ["shop_a"])
        XCTAssertEqual(store.keywords, ["ib"])

        store.switchAccount(accountB)
        XCTAssertEqual(store.comments.map(\.id), ["b1"])
    }

    func testSwitchingFlushesPendingSaveAndClosesLive() {
        let store = makeStore(accountA)
        store.addComment(comment("a1"), tiktok: "shop_a")
        XCTAssertNotNil(store.openSession)

        store.switchAccount(nil)
        XCTAssertTrue(store.comments.isEmpty)

        let reopened = makeStore(accountA)
        XCTAssertEqual(reopened.comments.map(\.id), ["a1"])
        XCTAssertNil(reopened.openSession)
    }

    func testLoggedOutStoreWritesNothing() {
        let store = makeStore(nil)
        store.addComment(comment("x"), tiktok: "shop")
        store.save()
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.appendingPathComponent("accounts").path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: legacyFile.path))
    }

    func testAccountKeyIgnoresCaseAndSpaces() {
        XCTAssertEqual(AuthStorage.accountKey(server: " https://ChotLive.test ", user: " SHOP.a "), accountA)
        XCTAssertNotEqual(AuthStorage.accountKey(server: "https://khac.test", user: "shop.a"), accountA)
    }

    // MARK: - Dữ liệu của bản cũ

    func testLegacyFileGoesOnlyToItsOwner() throws {
        defaults.set("https://chotlive.test", forKey: AuthStorage.serverKey)
        defaults.set("Shop.A", forKey: AuthStorage.userKey)
        defaults.set("tiktok_cua_a", forKey: "tiktokName")
        try writeLegacy(commentId: "old")

        let store = makeStore(nil)
        // Người khác đăng nhập trước: không thấy dữ liệu, không thấy ID TikTok, file cũ vẫn còn.
        defaults.set("shop.b", forKey: AuthStorage.userKey)
        store.switchAccount(accountB)
        XCTAssertTrue(store.comments.isEmpty)
        XCTAssertTrue(store.accounts.isEmpty)
        XCTAssertTrue(FileManager.default.fileExists(atPath: legacyFile.path))

        store.switchAccount(nil)
        store.switchAccount(accountA)
        XCTAssertEqual(store.comments.map(\.id), ["old"])
        XCTAssertEqual(store.accounts.map(\.id), ["tiktok_cua_a"])
        XCTAssertEqual(store.sessions.count, 1)
        XCTAssertFalse(FileManager.default.fileExists(atPath: legacyFile.path))
        XCTAssertNil(defaults.string(forKey: "tiktokName"))
    }

    func testLegacyFileWithoutKnownOwnerGoesToFirstLogin() throws {
        try writeLegacy(commentId: "old")
        let store = makeStore(nil)
        store.switchAccount(accountB)
        XCTAssertEqual(store.comments.map(\.id), ["old"])
        store.switchAccount(accountA)
        XCTAssertTrue(store.comments.isEmpty)
    }

    func testLegacyOwnerStaysFixedAfterOtherLogin() {
        defaults.set("https://chotlive.test", forKey: AuthStorage.serverKey)
        defaults.set("Shop.A", forKey: AuthStorage.userKey)
        XCTAssertEqual(AuthStorage.legacyOwner(defaults), accountA)
        defaults.set("shop.b", forKey: AuthStorage.userKey)
        XCTAssertEqual(AuthStorage.legacyOwner(defaults), accountA)
    }

    // MARK: - Không ghi đè khi file lỗi

    func testCorruptFileIsKeptAndNotOverwritten() throws {
        let file = accountFile(accountA)
        try writeRaw("{hong", to: file)

        let store = makeStore(accountA)
        XCTAssertNotNil(store.storageWarning)
        XCTAssertTrue(store.comments.isEmpty)

        store.addComment(comment("moi"), tiktok: "shop_a")
        store.save()

        let folder = file.deletingLastPathComponent()
        let kept = try FileManager.default.contentsOfDirectory(atPath: folder.path).filter { $0.hasPrefix("chotlive.loi-") }
        XCTAssertEqual(kept.count, 1)
        XCTAssertEqual(try String(contentsOf: folder.appendingPathComponent(kept[0]), encoding: .utf8), "{hong")
        XCTAssertEqual(makeStore(accountA).comments.map(\.id), ["moi"])
    }

    func testUnreadableFileBlocksSaving() throws {
        // Thư mục trùng tên file: tồn tại nhưng đọc lỗi.
        let file = accountFile(accountA)
        try FileManager.default.createDirectory(at: file, withIntermediateDirectories: true)
        try writeRaw("giu", to: file.appendingPathComponent("dau-vet"))

        let store = makeStore(accountA)
        XCTAssertNotNil(store.storageWarning)
        store.addComment(comment("moi"), tiktok: "shop_a")
        store.save()

        var isDirectory: ObjCBool = false
        XCTAssertTrue(FileManager.default.fileExists(atPath: file.path, isDirectory: &isDirectory))
        XCTAssertTrue(isDirectory.boolValue)
        XCTAssertTrue(FileManager.default.fileExists(atPath: file.appendingPathComponent("dau-vet").path))
    }

    func testValidFileLoadsWithoutWarning() {
        let store = makeStore(accountA)
        store.addComment(comment("a1"), tiktok: "shop_a")
        store.save()
        let reopened = makeStore(accountA)
        XCTAssertNil(reopened.storageWarning)
        XCTAssertEqual(reopened.comments.map(\.id), ["a1"])
    }

    func testSaveFailureWarnsInsteadOfStayingSilent() throws {
        // Vị trí thư mục tài khoản bị một file chiếm nên không ghi được.
        let store = makeStore(accountA)
        try writeRaw("chan", to: directory.appendingPathComponent("accounts"))
        store.save()
        XCTAssertNotNil(store.storageWarning)
    }

    // MARK: - Keychain

    func testKeychainRoundTrip() {
        XCTAssertNil(Keychain.read())
        XCTAssertTrue(Keychain.write("tk-1"))
        XCTAssertEqual(Keychain.read(), "tk-1")
        XCTAssertTrue(Keychain.write("tk-2"))
        XCTAssertEqual(Keychain.read(), "tk-2")
        Keychain.delete()
        XCTAssertNil(Keychain.read())
    }

    func testLegacyTokenMovesToKeychain() {
        defaults.set("https://chotlive.test", forKey: AuthStorage.serverKey)
        defaults.set("Shop.A", forKey: AuthStorage.userKey)
        defaults.set("tk-cu", forKey: "authToken")

        XCTAssertEqual(AuthStorage.token(defaults), "tk-cu")
        XCTAssertNil(defaults.string(forKey: "authToken"))
        XCTAssertEqual(Keychain.read(), "tk-cu")
        XCTAssertEqual(AuthStorage.currentAccountKey(defaults), accountA)
    }

    func testReinstallDropsLeftoverToken() {
        Keychain.write("tk-sot")
        XCTAssertEqual(AuthStorage.token(defaults), "")
        XCTAssertNil(Keychain.read())
        XCTAssertNil(AuthStorage.currentAccountKey(defaults))
    }

    @MainActor
    func testLoginAndLogoutFlow() async throws {
        URLProtocol.registerClass(AuthStub.self)
        defer { URLProtocol.unregisterClass(AuthStub.self) }

        let client = LiveClient(defaults: defaults)
        XCTAssertFalse(client.loggedIn)
        var changes: [String?] = []
        client.onAccountChange = { changes.append($0) }

        try await client.login(server: "https://chotlive.test", user: "shop.a", password: "mat-khau")
        XCTAssertTrue(client.loggedIn)
        XCTAssertEqual(Keychain.read(), "tk-dang-nhap")
        XCTAssertNil(defaults.string(forKey: "authToken"))
        XCTAssertEqual(AuthStorage.currentAccountKey(defaults), accountA)

        let reopened = LiveClient(defaults: defaults)
        XCTAssertTrue(reopened.loggedIn)
        reopened.onAccountChange = nil
        reopened.logout()

        client.logout()
        XCTAssertFalse(client.loggedIn)
        XCTAssertNil(Keychain.read())
        XCTAssertNil(AuthStorage.currentAccountKey(defaults))
        XCTAssertEqual(changes, [accountA, nil])
    }
}

/// Trả lời giả cho /api/auth/*; server thật không tham gia test.
private final class AuthStub: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool {
        request.url?.host == "chotlive.test" && request.url?.scheme == "https"
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let body = #"{"ok":true,"token":"tk-dang-nhap","user":{"username":"Shop.A"}}"#
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
