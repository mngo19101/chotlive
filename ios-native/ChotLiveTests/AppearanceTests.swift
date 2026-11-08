import XCTest
@testable import ChotLive

/// Giao diện: màu mặc định giữ đúng mẫu, mọi màu chủ đạo đủ tương phản ở cả nền Sáng lẫn Tối, lựa chọn được lưu lại.
final class AppearanceTests: XCTestCase {
    private func luminance(_ hex: UInt32) -> Double {
        func channel(_ shift: UInt32) -> Double {
            let c = Double((hex >> shift) & 0xFF) / 255
            return c <= 0.03928 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0)
    }

    private func contrast(_ a: UInt32, _ b: UInt32) -> Double {
        let (hi, lo) = (max(luminance(a), luminance(b)), min(luminance(a), luminance(b)))
        return (hi + 0.05) / (lo + 0.05)
    }

    func testMixHex() {
        XCTAssertEqual(mixHex(0xFF0000, 0x0000FF, 1), 0xFF0000)
        XCTAssertEqual(mixHex(0xFF0000, 0x0000FF, 0), 0x0000FF)
        XCTAssertEqual(mixHex(0xFFFFFF, 0x000000, 0.5), 0x808080)
    }

    func testDefaultAccentKeepsDesignColors() {
        let p = AccentChoice.vang.palette
        XCTAssertEqual(p.fill, 0xFF9A4C)
        XCTAssertEqual(p.deep, 0xEA6A09)
        XCTAssertEqual(p.text, 0xB5490C)
        XCTAssertEqual(p.textDeep, 0x7A3300)
        XCTAssertEqual(p.peach, 0xFEE4CD)
        XCTAssertEqual(p.peachSoft, 0xFEF4EA)
        XCTAssertEqual(p.peachLine, 0xFFBD87)
        XCTAssertEqual(p.peachTint, 0xFFF1E4)
        XCTAssertEqual(p.peachCode, 0xFFE9D2)
        XCTAssertEqual(p.peachRow, 0xFFF7EC)
    }

    func testEveryAccentIsReadable() {
        let ink: UInt32 = 0x14181F
        let darkBg: UInt32 = 0x0F1115
        for a in AccentChoice.allCases {
            let p = a.palette
            XCTAssertGreaterThanOrEqual(contrast(ink, p.fill), 4.5, "\(a.name): chữ trên nút")
            XCTAssertGreaterThanOrEqual(contrast(p.text, 0xFFFFFF), 4.5, "\(a.name): chữ nhấn trên thẻ sáng")
            XCTAssertGreaterThanOrEqual(contrast(p.text, p.peachSoft), 4.5, "\(a.name): chữ nhấn trên nền nhạt")
            XCTAssertGreaterThanOrEqual(contrast(p.darkText, AccentPalette.darkCard), 4.5, "\(a.name): chữ nhấn trên thẻ tối")
            XCTAssertGreaterThanOrEqual(contrast(p.darkText, p.darkPeachSoft), 4.5, "\(a.name): chữ nhấn trên nền nhạt tối")
            XCTAssertGreaterThanOrEqual(contrast(p.darkText, darkBg), 4.5, "\(a.name): chữ nhấn trên nền tối")
        }
    }

    @MainActor
    func testChoiceIsSavedAndRestored() {
        let suite = "AppearanceTests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }

        let first = Appearance(defaults: defaults)
        XCTAssertEqual(first.mode, .light)
        XCTAssertEqual(first.accent, .vang)
        XCTAssertFalse(first.seen)
        XCTAssertEqual(first.summary, "Sáng · Vàng")

        first.mode = .dark
        first.accent = .xanh
        first.seen = true

        let again = Appearance(defaults: defaults)
        XCTAssertEqual(again.mode, .dark)
        XCTAssertEqual(again.accent, .xanh)
        XCTAssertTrue(again.seen)
        XCTAssertEqual(again.summary, "Tối · Xanh dương")

        // Trả màu dùng chung về mặc định cho các test khác.
        Theme.use(.vang)
    }
}
