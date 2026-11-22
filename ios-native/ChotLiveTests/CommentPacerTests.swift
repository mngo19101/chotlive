import XCTest
@testable import ChotLive

/// Giữ danh sách bình luận khi chốt: bình luận thường hiện ngay, bình luận chốt làm danh sách đứng yên,
/// nhưng không bình luận nào phải chờ quá lâu.
@MainActor
final class CommentPacerTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_794_000_000)
    private let longAgo = Date.distantPast

    private func comment(_ id: String, _ at: TimeInterval, _ text: String = "đẹp quá") -> LiveComment {
        LiveComment(id: id, uniqueId: "u\(id)", userId: id, nickname: "Khách \(id)", text: text,
                    ts: t0.addingTimeInterval(at), price: 0)
    }

    private func isClosing(_ c: LiveComment) -> Bool { c.text.contains("chốt") }

    /// Danh sách mới nhất trước, như trên màn hình.
    private func list(_ items: LiveComment...) -> [LiveComment] { items.sorted { $0.ts > $1.ts } }

    private func activePacer(newest: TimeInterval = 0, fixedHold: Int = 0) -> CommentPacer {
        let pacer = CommentPacer()
        pacer.fixedHold = fixedHold
        pacer.setActive(true, newest: t0.addingTimeInterval(newest), now: t0.addingTimeInterval(-60))
        return pacer
    }

    func testNormalCommentShowsAtOnce() {
        let pacer = activePacer()
        let a = comment("a", 0), b = comment("b", 1)
        pacer.arrived(list(a, b), isClosing: isClosing, touching: false, lastTouchUp: longAgo, now: t0.addingTimeInterval(1))
        XCTAssertEqual(pacer.cutoff, b.ts)
    }

    func testClosingCommentHoldsTheList() {
        let pacer = activePacer(fixedHold: 2)
        let a = comment("a", 0), order = comment("o", 1, "chốt 40"), after = comment("c", 1.5)
        pacer.arrived(list(a, order), isClosing: isClosing, touching: false, lastTouchUp: longAgo, now: t0.addingTimeInterval(1))
        XCTAssertEqual(pacer.cutoff, order.ts)

        pacer.arrived(list(a, order, after), isClosing: isClosing, touching: false, lastTouchUp: longAgo, now: t0.addingTimeInterval(1.5))
        XCTAssertEqual(pacer.cutoff, order.ts, "đang giữ sau bình luận chốt")
        XCTAssertTrue(pacer.holding)

        pacer.tick(touching: false, lastTouchUp: longAgo, now: t0.addingTimeInterval(2.9))
        XCTAssertEqual(pacer.cutoff, order.ts)
        pacer.tick(touching: false, lastTouchUp: longAgo, now: t0.addingTimeInterval(3.1))
        XCTAssertEqual(pacer.cutoff, after.ts, "hết 2 giây thì hiện phần chờ")
        XCTAssertFalse(pacer.holding)
    }

    func testCommentsBurstIsBatched() {
        let pacer = activePacer()
        let a = comment("a", 1), b = comment("b", 1.2), c = comment("c", 1.4)
        pacer.arrived(list(a), isClosing: isClosing, touching: false, lastTouchUp: longAgo, now: t0.addingTimeInterval(1))
        pacer.arrived(list(a, b), isClosing: isClosing, touching: false, lastTouchUp: longAgo, now: t0.addingTimeInterval(1.2))
        pacer.arrived(list(a, b, c), isClosing: isClosing, touching: false, lastTouchUp: longAgo, now: t0.addingTimeInterval(1.4))
        XCTAssertEqual(pacer.cutoff, a.ts, "chưa đủ khoảng cách giữa hai lần đẩy")
        pacer.tick(touching: false, lastTouchUp: longAgo, now: t0.addingTimeInterval(1.75))
        XCTAssertEqual(pacer.cutoff, c.ts, "đẩy cả lô một lần")
    }

    func testTouchFreezesTheList() {
        let pacer = activePacer()
        let a = comment("a", 1)
        pacer.arrived(list(a), isClosing: isClosing, touching: true, lastTouchUp: longAgo, now: t0.addingTimeInterval(1))
        XCTAssertNotEqual(pacer.cutoff, a.ts)
        pacer.tick(touching: false, lastTouchUp: t0.addingTimeInterval(2), now: t0.addingTimeInterval(3))
        XCTAssertNotEqual(pacer.cutoff, a.ts, "vừa thả tay, còn chờ một chút")
        pacer.tick(touching: false, lastTouchUp: t0.addingTimeInterval(2), now: t0.addingTimeInterval(3.6))
        XCTAssertEqual(pacer.cutoff, a.ts)
    }

    func testNeverLagsMoreThanTheCap() {
        let pacer = activePacer()
        let a = comment("a", 1)
        pacer.arrived(list(a), isClosing: isClosing, touching: true, lastTouchUp: longAgo, now: t0.addingTimeInterval(1))
        pacer.tick(touching: true, lastTouchUp: longAgo, now: t0.addingTimeInterval(4.9))
        XCTAssertNotEqual(pacer.cutoff, a.ts)
        pacer.tick(touching: true, lastTouchUp: longAgo, now: t0.addingTimeInterval(5))
        XCTAssertEqual(pacer.cutoff, a.ts, "chạm tay mãi cũng không chờ quá 4 giây")
    }

    func testAutoHoldShrinksWhenBusy() {
        let quiet = activePacer()
        XCTAssertEqual(quiet.holdDuration(now: t0), CommentPacer.autoHoldMax)

        let busy = activePacer()
        var shown: [LiveComment] = []
        for i in 0..<30 {
            let at = Double(i) * 0.5
            shown.insert(comment("o\(i)", at, "chốt"), at: 0)
            busy.arrived(shown, isClosing: isClosing, touching: false, lastTouchUp: longAgo, now: t0.addingTimeInterval(at))
            busy.tick(touching: false, lastTouchUp: longAgo, now: t0.addingTimeInterval(at + 0.25))
        }
        XCTAssertLessThan(busy.holdDuration(now: t0.addingTimeInterval(15)), 1.2)
        XCTAssertGreaterThanOrEqual(busy.holdDuration(now: t0.addingTimeInterval(15)), CommentPacer.autoHoldMin)
    }

    func testInactiveShowsEverything() {
        let pacer = activePacer()
        pacer.setActive(false, newest: t0)
        XCTAssertNil(pacer.cutoff)
        pacer.arrived(list(comment("a", 1)), isClosing: isClosing, touching: false, lastTouchUp: longAgo, now: t0)
        XCTAssertNil(pacer.cutoff)
    }

    func testTapRightAfterAShiftIsIgnored() {
        let pacer = CommentPacer()
        pacer.noteShift(now: t0)
        XCTAssertTrue(pacer.movedBeforeTap(touchDown: t0.addingTimeInterval(0.2), now: t0.addingTimeInterval(0.3)))
        XCTAssertFalse(pacer.movedBeforeTap(touchDown: t0.addingTimeInterval(0.5), now: t0.addingTimeInterval(0.6)))
        XCTAssertFalse(pacer.movedBeforeTap(touchDown: .distantPast, now: t0.addingTimeInterval(0.3)), "không biết lúc chạm thì không chặn")
    }
}
