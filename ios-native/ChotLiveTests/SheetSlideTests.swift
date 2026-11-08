import XCTest
import SwiftUI
@testable import ChotLive

/// Sheet đóng phải rời hẳn màn hình, không để lại dải trắng đè lên thanh tab.
@MainActor
final class SheetSlideTests: XCTestCase {
    func testClosedSheetTravelsPastTheSafeArea() {
        let effect = SheetSlide(progress: 0, safeBottom: 34)
        let moved = effect.effectValue(size: CGSize(width: 393, height: 691)).m32
        XCTAssertEqual(moved, 725, accuracy: 0.001)
    }

    func testOpenSheetStaysInPlace() {
        let effect = SheetSlide(progress: 1, safeBottom: 34)
        XCTAssertEqual(effect.effectValue(size: CGSize(width: 393, height: 691)).m32, 0, accuracy: 0.001)
    }
}
