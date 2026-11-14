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
    ]

    func testPhoneNumbersAndGroupedThousands() {
        for (text, price) in vectors { XCTAssertEqual(PriceParser.parse(text), price, text) }
    }

    func testPhoneIsNotOnlyCodes() {
        for text in ["0912 345 678", "0912.345.678", "150 0912 345 678"] { XCTAssertFalse(PriceParser.isOnlyCodes(text), text) }
        XCTAssertTrue(PriceParser.isOnlyCodes("mã 150"))
        XCTAssertEqual(PriceParser.orderTokens("chốt mã 150 sđt 0912 345 678").map(\.price), [150000])
    }
}
