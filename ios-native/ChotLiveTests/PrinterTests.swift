import XCTest
@testable import ChotLive

/// Chọn kênh ghi, chia gói và đánh dấu đã in. Không thay được thử với máy in thật.
final class PrinterTests: XCTestCase {
    private func candidate(_ service: String, _ characteristic: String, noResponse: Bool = true) -> PrinterProfile.Candidate {
        .init(service: service, characteristic: characteristic, canWriteWithoutResponse: noResponse)
    }

    func testNormalizeTreatsLongAndShortUUIDsAsTheSame() {
        XCTAssertEqual(PrinterProfile.normalize("00002af1-0000-1000-8000-00805f9b34fb"), "2AF1")
        XCTAssertEqual(PrinterProfile.normalize("2af1"), "2AF1")
    }

    func testPicksKnownEndpointOverEarlierUnknownCharacteristic() {
        let selection = PrinterProfile.pick([
            candidate("ABCD", "1234"),
            candidate("00001234-0000-1000-8000-00805F9B34FB", "5678"),
            candidate("18F0", "2AF1", noResponse: false),
        ])
        XCTAssertEqual(selection, .init(index: 2, isRecognized: true))
    }

    func testResultDoesNotDependOnDiscoveryOrder() {
        let a = candidate("FFE0", "FFE1")
        let b = candidate("18F0", "2AF1")
        XCTAssertEqual(PrinterProfile.pick([a, b])?.index, 1)
        XCTAssertEqual(PrinterProfile.pick([b, a])?.index, 0)
    }

    func testISSCUsesDataChannelNotControlChannel() {
        let service = "49535343-FE7D-4AE5-8FA9-9FAFD205E455"
        let selection = PrinterProfile.pick([
            candidate(service, "49535343-ACA3-481C-91EC-D85E28A60318"),
            candidate(service, "49535343-8841-43F4-A8D4-ECBE34729BB3"),
        ])
        XCTAssertEqual(selection, .init(index: 1, isRecognized: true))
    }

    func testUnknownDeviceIsAllowedButNotRecognized() {
        XCTAssertEqual(PrinterProfile.pick([candidate("ABCD", "1234")]), .init(index: 0, isRecognized: false))
    }

    func testNeverWritesToFirmwareUpdateService() {
        XCTAssertNil(PrinterProfile.pick([candidate("FE59", "8EC90003-F315-4F60-9FB8-838830DAEA50")]))
        XCTAssertNil(PrinterProfile.pick([]))
    }

    func testChunkStaysWithinMTU() {
        XCTAssertEqual(PrinterProfile.chunkSize(maxWithoutResponse: 20), 20)
        XCTAssertEqual(PrinterProfile.chunkSize(maxWithoutResponse: 100), 100)
        XCTAssertEqual(PrinterProfile.chunkSize(maxWithoutResponse: 512), 180)
    }

    func testLooksLikePrinter() {
        XCTAssertTrue(PrinterProfile.looksLikePrinter(name: "XP-Q80B", advertisedServices: []))
        XCTAssertTrue(PrinterProfile.looksLikePrinter(name: nil, advertisedServices: ["18F0"]))
        XCTAssertFalse(PrinterProfile.looksLikePrinter(name: "AirPods", advertisedServices: []))
        XCTAssertFalse(PrinterProfile.looksLikePrinter(name: nil, advertisedServices: []))
    }

    @MainActor
    func testCommentIsSavedButNotMarkedPrintedWithoutPrinter() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let suite = "chotlive.printertests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer {
            defaults.removePersistentDomain(forName: suite)
            try? FileManager.default.removeItem(at: directory)
        }
        let store = Store(account: "https://chotlive.test|shop.a", directory: directory, defaults: defaults)
        let comment = LiveComment(id: "c1", uniqueId: "khach", userId: "", nickname: "Khách", text: "59", ts: Date(), price: 59_000)

        let message = await printComment(comment, store: store, printer: PrinterManager())

        XCTAssertNotNil(message)
        let items = store.customers.flatMap(\.items)
        XCTAssertFalse(items.isEmpty)
        XCTAssertTrue(items.allSatisfy { !$0.printed })
    }

    func testSendFailsImmediatelyWhenNotConnected() {
        let done = expectation(description: "completion")
        PrinterManager().send(Data([0x1B, 0x40])) { message in
            XCTAssertNotNil(message)
            done.fulfill()
        }
        wait(for: [done], timeout: 1)
    }
}
