import CryptoKit
import Foundation

/// Dựng nội dung nháp Viettel Post (InsertOrderDraftForWeb) từ một khách đã gom (Vtp.Group) và biết nháp
/// trên Viettel Post còn khớp đơn hiện tại không.
///
/// Tiền thu hộ, ai trả cước, cân nặng, người nhận lấy NGUYÊN từ `Vtp.summarize` (cùng cách tính với file Excel
/// và vận đơn API đối tác), không tính lại ở đây.
enum VtpDraftBody {
    /// 1: không thu hộ; 2: thu hộ tiền hàng + cước (người nhận trả); 3: thu hộ tiền hàng; 4: chỉ thu hộ cước.
    /// Giống vtpCreateOrder trên máy chủ (vtp.js).
    static func payment(cod: Int, senderPays: Bool) -> Int {
        cod > 0 ? (senderPays ? 3 : 2) : (senderPays ? 1 : 4)
    }

    /// Lý do không đẩy nháp được (trống = đẩy được). Thêm vào các lỗi sẵn có của bản tóm tắt.
    static func problems(_ g: Vtp.Group) -> [String] {
        var p = g.summary.problems
        if g.orders.contains(where: { !($0.ship?.vtpCode ?? "").isEmpty }) { p.append("Khách đã có vận đơn") }
        return p
    }

    /// Địa chỉ đưa cho dịch vụ tra mã của Viettel Post (`VtpDraftClient.locate`).
    static func addressLine(_ g: Vtp.Group) -> String { g.summary.address.line }

    static func make(_ g: Vtp.Group, kho: VtpDraftKho, place: VtpDraftPlace, service: String,
                     now: Date = Clock.now) -> [String: Any] {
        let s = g.summary
        let quantity = max(1, s.qty)
        let (len, wid, hei) = s.size ?? (0, 0, 0)
        let svc = service.isEmpty ? Vtp.defaultService : service
        // Ghép từng phần cho trình biên dịch Swift khỏi chậm với một từ điển quá lớn.
        var b: [String: Any] = [:]
        b["ORDER_NUMBER"] = ""
        b["ORDER_REFERENCE"] = reference(g)
        b["ORDER_TYPE"] = 1
        b["TYPE"] = 12
        b["DELIVERY_DATE"] = VtpDraftClient.dateText(now)
        b["GROUPADDRESS_ID"] = kho.id
        b["CUS_ID"] = kho.cusId
        b["SENDER_FULLNAME"] = clip(kho.name)
        b["SENDER_ADDRESS"] = clip(kho.address)
        b["SENDER_PHONE"] = kho.phone
        b["SENDER_EMAIL"] = ""
        b["SENDER_PROVINCE"] = String(kho.province)
        b["SENDER_DISTRICT"] = String(kho.district)
        b["SENDER_WARD"] = String(kho.ward)
        b["SENDER_LATITUDE"] = 0
        b["SENDER_LONGITUDE"] = 0
        b["RECEIVER_FULLNAME"] = clip(s.receiver)
        b["RECEIVER_ADDRESS"] = clip(s.address.line)
        b["RECEIVER_PHONE"] = s.phone
        b["RECEIVER_EMAIL"] = ""
        b["RECEIVER_PROVINCE"] = place.province
        b["RECEIVER_DISTRICT"] = place.district
        b["RECEIVER_WARD"] = place.ward
        b["RECEIVER_LATITUDE"] = 0
        b["RECEIVER_LONGITUDE"] = 0
        b["PRODUCT_NAME"] = Vtp.goodsName
        b["PRODUCT_DESCRIPTION"] = ""
        b["PRODUCT_QUANTITY"] = quantity
        b["PRODUCT_PRICE"] = s.goods
        b["PRODUCT_WEIGHT"] = max(1, s.weightG)
        b["PRODUCT_LENGTH"] = len
        b["PRODUCT_WIDTH"] = wid
        b["PRODUCT_HEIGHT"] = hei
        b["PRODUCT_TYPE"] = "HH"
        b["ORDER_PAYMENT"] = payment(cod: s.cod, senderPays: s.senderPays)
        b["ORDER_SERVICE"] = svc
        b["ORDER_SERVICE_ADD"] = ""
        b["ORDER_VOUCHER"] = ""
        b["ORDER_NOTE"] = clip(s.note)
        b["DELIVERY_CODE"] = -1
        b["MONEY_COLLECTION"] = s.cod
        for k in ["MONEY_TOTALFEE", "MONEY_FEECOD", "MONEY_FEEVAS", "MONEY_FEEINSURRANCE", "MONEY_FEE",
                  "MONEY_FEEOTHER", "MONEY_TOTALVAT", "MONEY_TOTAL"] {
            b[k] = 0
        }
        var item: [String: Any] = [:]
        item["ORDER_NUMBER_ITEM"] = 1
        item["PRODUCT_NAME"] = Vtp.goodsName
        item["PRODUCT_QUANTITY"] = quantity
        item["PRODUCT_WEIGHT"] = max(1, s.weightG)
        item["PRODUCT_PRICE"] = s.goods
        b["LIST_ITEM"] = [item]
        b["OPTION_LOCATION"] = 0
        b["REMOVE_PICKUP_DATE"] = true
        b["XMG_EXTRA_MONEY"] = 0
        return b
    }

    /// Mã đơn ChốtLive của các đơn trong nháp (giống cột "Mã đơn hàng" file Excel), tối đa 50 ký tự.
    static func reference(_ g: Vtp.Group) -> String {
        let codes = g.orders.compactMap(\.code).filter { !$0.isEmpty }.joined(separator: "+")
        let clean = codes.replacingOccurrences(of: "[^A-Za-z0-9_+-]+", with: "-", options: .regularExpression)
        return String(clean.prefix(50))
    }

    /// Viettel Post giới hạn 150 BYTE: cắt theo byte, không cắt giữa ký tự.
    static func clip(_ s: String, _ max: Int = 150) -> String {
        var out = ""
        var bytes = 0
        for ch in s {
            let n = String(ch).utf8.count
            if bytes + n > max { break }
            out.append(ch)
            bytes += n
        }
        return out
    }

    // MARK: - Nháp còn khớp đơn không

    /// Băm những gì quyết định nội dung nháp: người nhận, địa chỉ, tiền, ai trả cước, cân nặng, kích thước,
    /// dịch vụ, ghi chú và danh sách đơn. Đổi một trong số đó là nháp trên Viettel Post đã cũ.
    static func hash(_ g: Vtp.Group, service: String) -> String {
        let s = g.summary
        let size = s.size.map { "\($0.0)x\($0.1)x\($0.2)" } ?? ""
        let parts: [String] = [
            s.receiver, s.phone, s.address.line, String(s.goods), String(s.cod), s.senderPays ? "S" : "R",
            String(s.weightG), size, String(max(1, s.qty)), service.isEmpty ? Vtp.defaultService : service, s.note,
            g.orders.map(\.id).sorted().joined(separator: ",")
        ]
        let digest = SHA256.hash(data: Data(parts.joined(separator: "|").utf8))
        return digest.prefix(8).map { String(format: "%02x", $0) }.joined()
    }

    enum Status: Equatable {
        /// Chưa đẩy lần nào (hoặc đã bỏ nhãn).
        case none
        /// Đã có nháp trên Viettel Post, khớp đơn hiện tại.
        case pushed(code: String, at: Double?)
        /// Có nháp nhưng đơn đã sửa / thêm đơn sau khi đẩy: cần đẩy lại.
        case stale(code: String)
        /// Lần đẩy gần nhất lỗi và chưa có nháp nào.
        case failed(String)
    }

    static func status(_ g: Vtp.Group, service: String) -> Status {
        let ships = g.orders.map { $0.ship }
        let codes = Set(ships.compactMap { $0?.draftCode }.filter { !$0.isEmpty })
        if let code = codes.sorted().last {
            let current = hash(g, service: service)
            let allSame = codes.count == 1 && ships.allSatisfy { $0?.draftCode == code && $0?.draftHash == current }
            if allSame { return .pushed(code: code, at: ships.compactMap { $0?.draftAt }.max()) }
            return .stale(code: code)
        }
        if let e = ships.compactMap({ $0?.draftError }).last, !e.isEmpty { return .failed(e) }
        return .none
    }

    /// Mọi mã nháp đang gắn với khách (thường 1; nhiều hơn khi có đơn đẩy riêng trước đó): để xoá hết khi đẩy lại.
    static func codes(_ g: Vtp.Group) -> [String] {
        Array(Set(g.orders.compactMap { $0.ship?.draftCode }.filter { !$0.isEmpty })).sorted()
    }
}
