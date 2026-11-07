import XCTest
@testable import ChotLive

/// Dùng thử và gói: đọc đúng dữ liệu server gửi, đếm ngược giống bản web.
final class AccessTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_794_000_000)

    func testCountdownMatchesWeb() {
        let left: TimeInterval = (2 * 24 + 13) * 3600 + 4 * 60 + 9
        XCTAssertEqual(AccountAccess.countdownText(until: now + left, now: now), "2 ngày 13 giờ 04 phút 09 giây")
        XCTAssertEqual(AccountAccess.countdownText(until: now + 3 * 86400, now: now), "3 ngày 0 giờ 00 phút 00 giây")
        XCTAssertEqual(AccountAccess.countdownText(until: now + 5 * 3600 + 7, now: now), "5 giờ 00 phút 07 giây")
        XCTAssertEqual(AccountAccess.countdownText(until: now + 69, now: now), "01 phút 09 giây")
    }

    func testCountdownNeverShowsZeroBeforeTheEnd() {
        XCTAssertEqual(AccountAccess.countdownText(until: now + 0.2, now: now), "01 giây")
        XCTAssertEqual(AccountAccess.countdownText(until: now - 10, now: now), "00 giây")
        XCTAssertEqual(AccountAccess.countdownText(until: nil, now: now), "00 giây")
    }

    func testReadsServerAccess() throws {
        let trial = try XCTUnwrap(AccountAccess(["status": "trial", "canFollowLive": true, "endsAt": 1_794_000_000_000.0]))
        XCTAssertEqual(trial.endsAt, now)
        XCTAssertTrue(trial.canFollowLive)

        let expired = try XCTUnwrap(AccountAccess(["status": "expired", "canFollowLive": false, "endsAt": NSNull(),
                                                   "code": "PLAN_EXPIRED", "message": "Gói của bạn đã hết hạn."]))
        XCTAssertNil(expired.endsAt)
        XCTAssertFalse(expired.canFollowLive)
        XCTAssertEqual(expired.code, "PLAN_EXPIRED")
        XCTAssertNil(AccountAccess(["canFollowLive": true]))
    }
}
