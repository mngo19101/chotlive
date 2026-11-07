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
        wipeKeychain()
    }

    override func tearDownWithError() throws {
        defaults.removePersistentDomain(forName: suite)
        try? FileManager.default.removeItem(at: directory)
        wipeKeychain()
    }

    /// Keychain là của cả hệ thống, không theo UserDefaults suite của test, nên phải tự dọn.
    private func wipeKeychain() {
        Keychain.delete(AuthStorage.tokenAccount(accountA))
        Keychain.delete(AuthStorage.tokenAccount(accountB))
        Keychain.delete("authToken")
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
        let account = AuthStorage.tokenAccount(accountA)
        XCTAssertNil(Keychain.read(account))
        XCTAssertTrue(Keychain.write(account, "tk-1"))
        XCTAssertEqual(Keychain.read(account), "tk-1")
        XCTAssertTrue(Keychain.write(account, "tk-2"))
        XCTAssertEqual(Keychain.read(account), "tk-2")
        Keychain.delete(account)
        XCTAssertNil(Keychain.read(account))
    }

    func testLegacyKeychainTokenMovesToKeyedEntry() {
        defaults.set("https://chotlive.test", forKey: AuthStorage.serverKey)
        defaults.set("Shop.A", forKey: AuthStorage.userKey)
        Keychain.write("authToken", "tk-cu")

        XCTAssertEqual(AuthStorage.currentToken(defaults), "tk-cu")
        XCTAssertNil(Keychain.read("authToken"))
        XCTAssertEqual(Keychain.read(AuthStorage.tokenAccount(accountA)), "tk-cu")
        XCTAssertEqual(AuthStorage.savedAccounts(defaults).map(\.key), [accountA])
    }

    func testLegacyUserDefaultsTokenMovesToKeychain() {
        defaults.set("https://chotlive.test", forKey: AuthStorage.serverKey)
        defaults.set("Shop.A", forKey: AuthStorage.userKey)
        defaults.set("tk-rat-cu", forKey: "authToken")

        XCTAssertEqual(AuthStorage.currentToken(defaults), "tk-rat-cu")
        XCTAssertNil(defaults.string(forKey: "authToken"))
        XCTAssertEqual(Keychain.read(AuthStorage.tokenAccount(accountA)), "tk-rat-cu")
    }

    func testReinstallDropsLeftoverToken() {
        Keychain.write("authToken", "tk-sot")
        XCTAssertEqual(AuthStorage.currentToken(defaults), "")
        XCTAssertNil(Keychain.read("authToken"))
        XCTAssertNil(AuthStorage.currentAccountKey(defaults))
    }

    // MARK: - Nhiều tài khoản app

    func testSaveSessionAddsToSavedAccountsAndSwitchChangesCurrent() {
        AuthStorage.saveSession(server: "https://chotlive.test", user: "Shop.A", token: "tk-a", defaults)
        AuthStorage.saveSession(server: "https://chotlive.test", user: "shop.b", token: "tk-b", defaults)

        XCTAssertEqual(Set(AuthStorage.savedAccounts(defaults).map(\.key)), [accountA, accountB])
        XCTAssertEqual(AuthStorage.currentAccountKey(defaults), accountB) // tài khoản vừa thêm là tài khoản hiện tại

        let switched = AuthStorage.switchCurrent(to: accountA, defaults)
        XCTAssertEqual(switched?.user, "Shop.A")
        XCTAssertEqual(AuthStorage.currentAccountKey(defaults), accountA)
        // Token của cả hai vẫn còn, đổi qua lại không cần đăng nhập lại.
        XCTAssertEqual(AuthStorage.token(for: accountA), "tk-a")
        XCTAssertEqual(AuthStorage.token(for: accountB), "tk-b")
    }

    func testSwitchCurrentFailsForUnknownAccount() {
        AuthStorage.saveSession(server: "https://chotlive.test", user: "Shop.A", token: "tk-a", defaults)
        XCTAssertNil(AuthStorage.switchCurrent(to: accountB, defaults))
        XCTAssertEqual(AuthStorage.currentAccountKey(defaults), accountA)
    }

    func testForgetAccountOnlyAffectsOtherAccounts() {
        AuthStorage.saveSession(server: "https://chotlive.test", user: "Shop.A", token: "tk-a", defaults)
        AuthStorage.saveSession(server: "https://chotlive.test", user: "shop.b", token: "tk-b", defaults)
        AuthStorage.switchCurrent(to: accountA, defaults)

        // Không xoá được tài khoản đang dùng qua đường này.
        AuthStorage.forgetAccount(accountA, defaults)
        XCTAssertEqual(AuthStorage.token(for: accountA), "tk-a")
        XCTAssertEqual(AuthStorage.savedAccounts(defaults).map(\.key).sorted(), [accountA, accountB].sorted())

        AuthStorage.forgetAccount(accountB, defaults)
        XCTAssertNil(AuthStorage.token(for: accountB))
        XCTAssertEqual(AuthStorage.savedAccounts(defaults).map(\.key), [accountA])
        XCTAssertEqual(AuthStorage.currentAccountKey(defaults), accountA) // tài khoản đang dùng không đổi
    }

    func testClearCurrentSessionRemovesOnlyCurrentFromSavedList() {
        AuthStorage.saveSession(server: "https://chotlive.test", user: "Shop.A", token: "tk-a", defaults)
        AuthStorage.saveSession(server: "https://chotlive.test", user: "shop.b", token: "tk-b", defaults)

        AuthStorage.clearCurrentSession(defaults) // hiện đang là accountB
        XCTAssertNil(AuthStorage.token(for: accountB))
        XCTAssertEqual(AuthStorage.token(for: accountA), "tk-a")
        XCTAssertEqual(AuthStorage.savedAccounts(defaults).map(\.key), [accountA])
    }

    // MARK: - LiveClient: đăng nhập, đổi và quên tài khoản

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
        XCTAssertEqual(Keychain.read(AuthStorage.tokenAccount(accountA)), "tk-dang-nhap")
        XCTAssertNil(defaults.string(forKey: "authToken"))
        XCTAssertEqual(AuthStorage.currentAccountKey(defaults), accountA)
        XCTAssertEqual(client.savedAccounts.map(\.key), [accountA])

        let reopened = LiveClient(defaults: defaults)
        XCTAssertTrue(reopened.loggedIn)
        reopened.onAccountChange = nil

        client.logout()
        XCTAssertFalse(client.loggedIn)
        XCTAssertNil(Keychain.read(AuthStorage.tokenAccount(accountA)))
        XCTAssertNil(AuthStorage.token(for: accountA))
        XCTAssertTrue(client.savedAccounts.isEmpty)
        XCTAssertEqual(changes, [accountA, nil])
    }

    @MainActor
    func testRegisterCreatesSessionLikeLogin() async throws {
        URLProtocol.registerClass(AuthStub.self)
        defer { URLProtocol.unregisterClass(AuthStub.self) }

        let client = LiveClient(defaults: defaults)
        var changes: [String?] = []
        client.onAccountChange = { changes.append($0) }

        try await client.register(server: "https://chotlive.test", user: "shop.a", password: "mat-khau", confirmPassword: "mat-khau")

        XCTAssertEqual(AuthStub.lastAuthPath, "/api/auth/register")
        XCTAssertEqual(AuthStub.lastAuthBody?["confirmPassword"] as? String, "mat-khau")
        XCTAssertTrue(client.loggedIn)
        XCTAssertEqual(client.username, "Shop.A")
        XCTAssertEqual(Keychain.read(AuthStorage.tokenAccount(accountA)), "tk-dang-nhap")
        XCTAssertEqual(client.savedAccounts.map(\.key), [accountA])
        XCTAssertEqual(changes, [accountA])
    }

    func testBuildsWithoutServerAddressAskForIt() {
        // Test chạy trên bản không đặt CHOTLIVE_SERVER_URL.
        XCTAssertNil(AppConfig.builtInServer)
    }

    @MainActor
    func testAddingSecondAccountSwitchingAndForgetting() async throws {
        URLProtocol.registerClass(AuthStub.self)
        defer { URLProtocol.unregisterClass(AuthStub.self) }

        let client = LiveClient(defaults: defaults)
        try await client.login(server: "https://chotlive.test", user: "shop.a", password: "x")
        try await client.login(server: "https://chotlive.test", user: "shop.b", password: "x")

        // Thêm tài khoản thứ hai: nó trở thành tài khoản đang dùng, tài khoản đầu vẫn còn trong danh sách.
        XCTAssertEqual(client.username, "shop.b")
        XCTAssertEqual(Set(client.savedAccounts.map(\.key)), [accountA, accountB])

        var changes: [String?] = []
        client.onAccountChange = { changes.append($0) }

        // Đổi về tài khoản đầu không cần đăng nhập lại.
        client.switchAccount(to: accountA)
        XCTAssertEqual(client.username, "Shop.A")
        XCTAssertEqual(changes, [accountA])

        // Quên tài khoản còn lại (không phải tài khoản đang dùng): không ảnh hưởng tài khoản hiện tại.
        client.forgetSavedAccount(accountB)
        XCTAssertEqual(client.savedAccounts.map(\.key), [accountA])
        XCTAssertTrue(client.loggedIn)
        XCTAssertEqual(client.username, "Shop.A")
        XCTAssertNil(AuthStorage.token(for: accountB))

        // Không thể tự quên tài khoản đang dùng qua đường này.
        client.forgetSavedAccount(accountA)
        XCTAssertEqual(client.savedAccounts.map(\.key), [accountA])
        XCTAssertTrue(changes.count == 1) // forgetSavedAccount không gọi onAccountChange
    }

    @MainActor
    func testSwitchAccountIgnoresUnknownOrCurrentKey() async throws {
        URLProtocol.registerClass(AuthStub.self)
        defer { URLProtocol.unregisterClass(AuthStub.self) }

        let client = LiveClient(defaults: defaults)
        try await client.login(server: "https://chotlive.test", user: "shop.a", password: "x")
        var changes: [String?] = []
        client.onAccountChange = { changes.append($0) }

        client.switchAccount(to: accountA) // đang là tài khoản hiện tại
        client.switchAccount(to: "khong-ton-tai")
        XCTAssertEqual(client.username, "Shop.A")
        XCTAssertTrue(changes.isEmpty)
    }
}

/// Trả lời giả cho /api/auth/*; server thật không tham gia test.
private final class AuthStub: URLProtocol {
    static var lastAuthPath: String?
    static var lastAuthBody: [String: Any]?

    override class func canInit(with request: URLRequest) -> Bool {
        request.url?.host == "chotlive.test" && request.url?.scheme == "https"
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        if request.url?.path == "/api/auth/logout" {
            let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocolDidFinishLoading(self)
            return
        }
        // Đăng nhập: trả token/tên tài khoản dựa theo username gửi lên, để test được 2 tài khoản khác nhau.
        let body = (try? JSONSerialization.jsonObject(with: request.httpBodyOrStream() ?? Data())) as? [String: Any]
        Self.lastAuthPath = request.url?.path
        Self.lastAuthBody = body
        let username = (body?["username"] as? String) ?? ""
        let displayName = username.lowercased() == "shop.a" ? "Shop.A" : username
        let token = "tk-dang-nhap"
        let reply = ["ok": true, "token": token, "user": ["username": displayName]] as [String: Any]
        let data = try! JSONSerialization.data(withJSONObject: reply)
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private extension URLRequest {
    /// httpBody không có sẵn khi request đi qua URLProtocol (chuyển thành httpBodyStream); đọc lại từ stream.
    func httpBodyOrStream() -> Data? {
        if let body = httpBody { return body }
        guard let stream = httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        let bufferSize = 4096
        var buffer = [UInt8](repeating: 0, count: bufferSize)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: bufferSize)
            if read <= 0 { break }
            data.append(buffer, count: read)
        }
        return data
    }
}
