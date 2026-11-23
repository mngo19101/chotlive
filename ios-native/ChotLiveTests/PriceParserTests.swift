import XCTest
@testable import ChotLive

/// BL-12: bắt giá giống hệt web (PRICE_VECTORS trong test/price.test.js) và Android (LogicTest.kt). 0 ở đây là null bên web.
final class PriceParserTests: XCTestCase {
    private let vectors: [(String, Int)] = [
        ("chốt mã 150 sđt 0912 345 678", 150000), ("lấy 150 0912.345.678", 150000), ("150 sđt 0912-345-678", 150000),
        ("sđt 098.812.3456 lấy 250", 250000), ("0988 123 456 mã 99", 99000), ("024 3826 1234 mã 120", 120000),
        ("+84 912 345 678 mã 150", 150000), ("0912345678 150", 150000), ("0912 345 678", 0),
        ("2.500k", 2500000), ("1,200k", 1200000), ("1.5k", 1500), ("150k", 150000), ("150 k", 150000),
        ("1.5tr", 1500000), ("150,000", 150000), ("150.000đ", 150000), ("1.200.000", 1200000), ("1,5tr", 1500000),
        ("Chốt 120 với 180", 180000), ("lấy 2 cái 150", 150000), ("mã 090 150 180", 180000),
        ("cho em xin giá", 0), ("", 0),
        ("1 triệu 2", 1200000), ("1 triệu 250", 1250000), ("1tr 2 cái", 1000000), ("1tr 200k", 1000000), ("giá 1 triệu.", 1000000),
    ]

    func testPhoneNumbersAndGroupedThousands() {
        for (text, price) in vectors { XCTAssertEqual(PriceParser.parse(text), price, text) }
    }

    /// Size và số lượng không phải giá: cùng danh sách với SIZE_QTY_VECTORS của test/price.test.js.
    private let sizeQty: [(String, Int)] = [
        ("size 38 0912 345 678", 0), ("size 38", 0), ("sz 38 mã 250", 250000), ("size: 40 lấy 150", 150000),
        ("lấy 2 cái", 0), ("chốt 2 cái 150", 150000), ("lấy 2 cái 150", 150000), ("sl 2", 0),
        ("số lượng: 3 mã 120", 120000), ("50 kg", 0), ("nặng 50 kg mã 199", 199000), ("mã 99 bộ đồ", 99000),
        ("150 cái", 150000), ("38", 38000),
    ]

    func testSizeAndQuantityAreNotPrices() {
        for (text, price) in sizeQty { XCTAssertEqual(PriceParser.parse(text), price, text) }
    }

    func testLetterLBeforeNumberIsAPrice() {
        let cases: [(String, Int)] = [("L40", 40000), ("l40", 40000), ("chốt L40", 40000), ("L 40", 40000), ("L150k", 150000), ("sl40", 0), ("xl40", 0)]
        for (text, price) in cases { XCTAssertEqual(PriceParser.parse(text), price, text) }
        for text in ["L40", "L 40", "L40, L50"] { XCTAssertTrue(PriceParser.isOnlyCodes(text), text) }
        XCTAssertEqual(PriceParser.orderTokens("L40 L50").map(\.price), [40000, 50000])
        XCTAssertEqual(PriceParser.segments("L40").filter(\.isCode).map(\.text), ["L40"])
    }

    /// Cùng danh sách với GLUED_VECTORS của test/price.test.js (0 ở đây là null bên web).
    func testNumberGluedToLettersIsAPrice() {
        let cases: [(String, Int)] = [("30L", 30000), ("30l", 30000), ("chốt 30L", 30000), ("30M", 30000), ("30XL", 30000), ("ao30", 30000), ("chot30", 30000), ("áo 30L size M", 30000), ("L5", 5000), ("150ka", 150000), ("150 200", 200000), ("150 2", 150000), ("size38", 0), ("1m6", 0), ("cao 1m65", 0), ("45kg", 0), ("8h", 0), ("35t", 0), ("30%", 0), ("2k3", 0), ("mix2", 0), ("x2", 0), ("350k x2", 350000), ("35 tuổi", 0), ("giao 3 ngày", 0), ("mã a12", 0), ("ma30", 30000)]
        for (text, price) in cases { XCTAssertEqual(PriceParser.parse(text), price, text) }
        for text in ["30L", "30L 40L"] { XCTAssertTrue(PriceParser.isOnlyCodes(text), text) }
    }

    func testPhoneIsNotOnlyCodes() {
        for text in ["0912 345 678", "0912.345.678", "150 0912 345 678"] { XCTAssertFalse(PriceParser.isOnlyCodes(text), text) }
        XCTAssertTrue(PriceParser.isOnlyCodes("mã 150"))
        XCTAssertEqual(PriceParser.orderTokens("chốt mã 150 sđt 0912 345 678").map(\.price), [150000])
    }
}
