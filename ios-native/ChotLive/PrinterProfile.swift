import Foundation

/// Quy tắc nhận diện máy in BLE, tách khỏi CoreBluetooth để test được không cần máy in thật.
enum PrinterProfile {
    struct Candidate: Equatable {
        let service: String
        let characteristic: String
        let canWriteWithoutResponse: Bool
    }

    struct Selection: Equatable {
        let index: Int
        /// false: chỉ là kênh ghi bất kỳ, chưa chắc thiết bị này là máy in.
        let isRecognized: Bool
    }

    /// Cặp dịch vụ/kênh ghi ESC/POS phổ biến, ưu tiên từ trên xuống.
    static let knownEndpoints: [(service: String, characteristic: String)] = [
        ("18F0", "2AF1"),
        ("E7810A71-73AE-499D-8C15-FAA9AEF0C3F2", "BEF8D6C9-9C21-4C9E-B632-BD58C1009F9F"),
        ("49535343-FE7D-4AE5-8FA9-9FAFD205E455", "49535343-8841-43F4-A8D4-ECBE34729BB3"),
        ("FF00", "FF02"),
        ("FFE0", "FFE1"),
    ]

    /// Dịch vụ cập nhật firmware: tuyệt đối không ghi dữ liệu in vào đây.
    private static let firmwareServices: Set<String> = [
        "FE59",
        "00001530-1212-EFDE-1523-785FEABCD123",
        "F000FFC0-0451-4000-B000-000000000000",
    ]

    /// Kênh điều khiển của module ISSC: chỉ dùng khi không còn kênh nào khác.
    private static let controlCharacteristics: Set<String> = [
        "49535343-ACA3-481C-91EC-D85E28A60318",
        "49535343-6DAA-4D02-ABF6-19569ACA69FE",
    ]

    private static let printerNameHints = [
        "print", "xp-", "pos", "mtp", "rpp", "pt-", "goojprt", "hoin", "thermal", "q80", "n160", "epson", "tm-", "bixolon",
    ]

    /// Không gửi nhanh hơn mức này: bộ đệm của máy in giá rẻ dễ tràn, nhất là khi in ảnh raster.
    static let bytesPerSecond = 10_000.0

    /// "00002AF1-0000-1000-8000-00805F9B34FB" và "2af1" là cùng một UUID.
    static func normalize(_ uuid: String) -> String {
        let u = uuid.uppercased()
        let prefix = "0000"
        let suffix = "-0000-1000-8000-00805F9B34FB"
        if u.count == 36, u.hasPrefix(prefix), u.hasSuffix(suffix) {
            return String(u.dropFirst(prefix.count).prefix(4))
        }
        return u
    }

    /// Chọn kênh ghi tốt nhất. Trả về nil nếu thiết bị không có kênh nào dùng được để in.
    static func pick(_ candidates: [Candidate]) -> Selection? {
        var best: (index: Int, rank: Int, recognized: Bool)?
        for (i, c) in candidates.enumerated() {
            guard let (base, recognized) = classify(c) else { continue }
            // Cùng hạng thì ưu tiên ghi không cần phản hồi vì nhanh hơn nhiều.
            let rank = base * 2 + (c.canWriteWithoutResponse ? 0 : 1)
            if best == nil || rank < best!.rank { best = (i, rank, recognized) }
        }
        return best.map { Selection(index: $0.index, isRecognized: $0.recognized) }
    }

    private static func classify(_ c: Candidate) -> (rank: Int, recognized: Bool)? {
        let service = normalize(c.service)
        let characteristic = normalize(c.characteristic)
        if firmwareServices.contains(service) { return nil }
        if controlCharacteristics.contains(characteristic) { return (300, false) }
        if let i = knownEndpoints.firstIndex(where: { $0.service == service && $0.characteristic == characteristic }) {
            return (i, true)
        }
        if knownEndpoints.contains(where: { $0.service == service }) { return (100, true) }
        return (200, false)
    }

    /// Gói ghi không vượt MTU thực tế của kết nối, tránh long write mà nhiều module BLE không hỗ trợ.
    static func chunkSize(maxWithoutResponse: Int) -> Int {
        max(20, min(maxWithoutResponse, 180))
    }

    static func pacingDelay(bytes: Int) -> TimeInterval {
        Double(bytes) / bytesPerSecond
    }

    /// Chỉ để xếp thiết bị lên đầu danh sách, không dùng để ẩn: nhiều máy in có tên rất lạ.
    static func looksLikePrinter(name: String?, advertisedServices: [String]) -> Bool {
        let services = advertisedServices.map(normalize)
        if knownEndpoints.contains(where: { services.contains($0.service) }) { return true }
        guard let lower = name?.lowercased() else { return false }
        return printerNameHints.contains { lower.contains($0) }
    }
}
