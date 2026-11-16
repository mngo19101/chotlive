import Foundation
import Network

/// Địa chỉ máy in nhiệt nối mạng (dây LAN hoặc WiFi). Máy nhận lệnh ESC/POS thô qua TCP, thường ở cổng 9100.
struct WifiPrinterAddress: Equatable {
    let host: String
    let port: UInt16

    static let defaultPort: UInt16 = 9100

    var label: String { "\(host):\(port)" }

    /// Đọc IP và cổng người dùng gõ. Trả nil khi IP hoặc cổng sai định dạng.
    /// Ô cổng để trống thì dùng 9100; dán cả "192.168.1.13:9100" vào ô IP cũng được.
    static func parse(host rawHost: String, port rawPort: String) -> WifiPrinterAddress? {
        var host = rawHost.trimmingCharacters(in: .whitespacesAndNewlines)
        var portText = rawPort.trimmingCharacters(in: .whitespacesAndNewlines)
        if let colon = host.firstIndex(of: ":") {
            portText = String(host[host.index(after: colon)...])
            host = String(host[..<colon])
        }
        guard isIPv4(host) else { return nil }
        if portText.isEmpty { return WifiPrinterAddress(host: host, port: defaultPort) }
        guard portText.count <= 5, portText.allSatisfy(\.isASCIIDigit), let port = UInt16(portText), port > 0 else { return nil }
        return WifiPrinterAddress(host: host, port: port)
    }

    static func isIPv4(_ s: String) -> Bool {
        let parts = s.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return false }
        for p in parts {
            guard (1...3).contains(p.count), p.allSatisfy(\.isASCIIDigit), let v = Int(p), v <= 255 else { return false }
        }
        return parts[0] != "0"
    }
}

private extension Character {
    var isASCIIDigit: Bool { ("0"..."9").contains(self) }
}

/// Gửi tem tới máy in mạng: mỗi tem mở một kết nối TCP, gửi hết rồi đóng.
/// Máy in mạng thường chỉ nhận một kết nối một lúc, giữ kết nối lâu sẽ chặn điện thoại khác in.
/// Các tem được gửi lần lượt. Mọi callback chạy trên main queue.
final class WifiPrinterLink {
    private struct Job {
        let data: Data
        let completion: (String?) -> Void
    }

    let address: WifiPrinterAddress
    private var jobs: [Job] = []
    private var connection: NWConnection?
    private var timeout: DispatchWorkItem?
    /// Lý do gần nhất iOS báo khi đang chờ nối, để báo lỗi rõ hơn khi hết giờ.
    private var waitingError: NWError?

    private let connectTimeoutSeconds: TimeInterval = 15
    private let sendTimeoutSeconds: TimeInterval = 30
    private let drainSeconds: TimeInterval = 3

    init(address: WifiPrinterAddress) {
        self.address = address
    }

    var isBusy: Bool { !jobs.isEmpty }

    func send(_ data: Data, completion: @escaping (String?) -> Void) {
        jobs.append(Job(data: data, completion: completion))
        if jobs.count == 1 { startNext() }
    }

    /// Huỷ mọi tem đang chờ, ví dụ khi người dùng đổi máy in.
    func cancelAll(_ reason: String) {
        let pending = jobs
        jobs.removeAll()
        closeConnection()
        pending.forEach { $0.completion(reason) }
    }

    private func startNext() {
        guard let job = jobs.first, let port = NWEndpoint.Port(rawValue: address.port) else { return }
        let tcp = NWProtocolTCP.Options()
        tcp.noDelay = true
        tcp.connectionTimeout = Int(connectTimeoutSeconds)
        let params = NWParameters(tls: nil, tcp: tcp)
        // Máy in nằm trong WiFi nhà: không thử qua 4G.
        params.prohibitedInterfaceTypes = [.cellular]
        let conn = NWConnection(host: NWEndpoint.Host(address.host), port: port, using: params)
        connection = conn
        waitingError = nil
        conn.stateUpdateHandler = { [weak self, weak conn] state in
            guard let self, let conn, conn === self.connection else { return }
            switch state {
            case .ready:
                self.transmit(job.data, on: conn)
            case .waiting(let error):
                self.waitingError = error
                // Máy in trả lời là không nhận ở cổng này: báo ngay, chờ thêm cũng vô ích.
                if case .posix(.ECONNREFUSED) = error { self.finish(self.message(for: error)) }
            case .failed(let error):
                self.finish(self.message(for: error))
            default:
                break
            }
        }
        arm(connectTimeoutSeconds) { [weak self] in
            guard let self else { return }
            self.finish(self.waitingError.map { self.message(for: $0) } ?? self.unreachableMessage)
        }
        conn.start(queue: .main)
    }

    private func transmit(_ data: Data, on conn: NWConnection) {
        arm(sendTimeoutSeconds) { [weak self] in
            self?.finish("Máy in không nhận hết dữ liệu. Kiểm tra giấy, nắp máy rồi in lại.")
        }
        // Gửi kèm tín hiệu hết dữ liệu để máy in biết tem đã trọn.
        conn.send(content: data, contentContext: .finalMessage, isComplete: true, completion: .contentProcessed { [weak self, weak conn] error in
            guard let self, let conn, conn === self.connection else { return }
            if let error {
                self.finish("Gửi tem tới máy in bị lỗi: \(error.localizedDescription)")
            } else {
                self.drain(conn)
            }
        })
    }

    /// Đợi máy in đọc hết và tự đóng kết nối. Máy không tự đóng thì sau vài giây app đóng, vẫn đóng êm để byte cuối đi hết.
    private func drain(_ conn: NWConnection) {
        arm(drainSeconds) { [weak self] in self?.finish(nil) }
        receiveUntilClosed(conn)
    }

    private func receiveUntilClosed(_ conn: NWConnection) {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 1024) { [weak self, weak conn] _, _, isComplete, error in
            guard let self, let conn, conn === self.connection else { return }
            if isComplete || error != nil {
                self.finish(nil)
            } else {
                self.receiveUntilClosed(conn)
            }
        }
    }

    private func finish(_ error: String?) {
        closeConnection()
        guard !jobs.isEmpty else { return }
        let job = jobs.removeFirst()
        job.completion(error)
        if !jobs.isEmpty { startNext() }
    }

    private func closeConnection() {
        timeout?.cancel()
        timeout = nil
        if let conn = connection {
            connection = nil
            conn.stateUpdateHandler = nil
            conn.cancel()
        }
    }

    private func arm(_ seconds: TimeInterval, _ action: @escaping () -> Void) {
        timeout?.cancel()
        let work = DispatchWorkItem(block: action)
        timeout = work
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: work)
    }

    private var unreachableMessage: String {
        "Không nối được máy in \(address.label). Kiểm tra máy in đã bật, iPhone dùng cùng WiFi với máy in và IP đúng. Nếu iPhone vừa hỏi quyền Mạng cục bộ, bấm Cho phép rồi in lại."
    }

    private func message(for error: NWError) -> String {
        switch error {
        case .posix(.ECONNREFUSED):
            return "Máy in \(address.host) không nhận kết nối ở cổng \(address.port). Kiểm tra lại Port (thường là 9100)."
        case .dns(let code) where code == -65570: // kDNSServiceErr_PolicyDenied: bị chặn quyền Mạng cục bộ
            return "ChốtLive chưa được dùng Mạng cục bộ. Vào Cài đặt › ChốtLive, bật Mạng cục bộ rồi in lại."
        case .posix(.ENETUNREACH), .posix(.EHOSTUNREACH), .posix(.ENETDOWN), .posix(.EHOSTDOWN), .posix(.ETIMEDOUT):
            return unreachableMessage
        default:
            return "\(unreachableMessage) (\(error.localizedDescription))"
        }
    }
}
