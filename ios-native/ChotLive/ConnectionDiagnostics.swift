import CFNetwork
import Foundation
import Network
import SwiftUI
import UIKit

// MARK: - Diễn giải lỗi mạng

/// Diễn giải lỗi mạng của iOS ra tiếng Việt, kèm mã lỗi gốc để người hỗ trợ tra được.
enum NetErrorText {
    static func describe(_ error: Error) -> String {
        guard let url = error as? URLError else {
            let ns = error as NSError
            return "\(ns.localizedDescription) (\(ns.domain) \(ns.code))"
        }
        var text = "\(reason(url.code)) (mã \(url.code.rawValue))"
        switch url.networkUnavailableReason {
        case .cellular?: text += ", app đang bị tắt dữ liệu di động"
        case .expensive?: text += ", mạng đang bị coi là tốn phí"
        case .constrained?: text += ", máy đang bật Chế độ dữ liệu thấp"
        default: break
        }
        return text
    }

    static func reason(_ code: URLError.Code) -> String {
        switch code {
        case .notConnectedToInternet: return "iOS báo không có mạng hoặc app bị chặn dùng mạng"
        case .timedOut: return "Quá thời gian chờ máy chủ trả lời"
        case .cannotFindHost, .dnsLookupFailed: return "Không tìm thấy máy chủ (lỗi DNS)"
        case .cannotConnectToHost: return "Không mở được kết nối tới máy chủ"
        case .networkConnectionLost: return "Mất kết nối giữa chừng"
        case .secureConnectionFailed: return "Lỗi kết nối bảo mật (HTTPS)"
        case .serverCertificateUntrusted, .serverCertificateHasBadDate,
             .serverCertificateNotYetValid, .serverCertificateHasUnknownRoot, .clientCertificateRejected:
            return "Chứng chỉ máy chủ bị từ chối, kiểm tra ngày giờ trên máy"
        case .appTransportSecurityRequiresSecureConnection: return "iOS chặn kết nối không mã hoá"
        case .internationalRoamingOff: return "Đang tắt chuyển vùng dữ liệu"
        case .dataNotAllowed: return "Máy không cho dùng dữ liệu di động"
        case .callIsActive: return "Đang gọi điện nên không dùng được dữ liệu di động"
        case .cancelled: return "Kết nối bị huỷ"
        case .badServerResponse: return "Máy chủ trả lời sai định dạng"
        default: return "Lỗi mạng"
        }
    }

    /// Mã kỹ thuật đầy đủ (lỗi gốc, mã stream) cho báo cáo chẩn đoán.
    static func technical(_ error: Error) -> String {
        let ns = error as NSError
        var parts = ["\(ns.domain) \(ns.code)"]
        if let under = ns.userInfo[NSUnderlyingErrorKey] as? NSError {
            parts.append("lỗi gốc \(under.domain) \(under.code)")
        }
        if let stream = ns.userInfo["_kCFStreamErrorCodeKey"] { parts.append("stream \(stream)") }
        if let domain = ns.userInfo["_kCFStreamErrorDomainKey"] { parts.append("stream domain \(domain)") }
        if let why = (error as? URLError)?.networkUnavailableReason { parts.append("lý do \(why.rawValue)") }
        return parts.joined(separator: " · ")
    }
}

// MARK: - Chạy các bước kiểm tra

/// Kiểm tra từng chặng từ điện thoại tới máy chủ, để biết kết nối hỏng ở đâu
/// (mạng của máy, DNS, kết nối bảo mật, hay máy chủ) thay vì chỉ một câu "không kết nối được".
@MainActor
final class ConnectionDiagnostics: ObservableObject {
    enum State { case running, ok, warn, fail }

    struct Step: Identifiable {
        let id: Int
        var title: String
        var state: State
        var detail: String
    }

    typealias Outcome = (state: State, detail: String)

    @Published private(set) var steps: [Step] = []
    @Published private(set) var running = false
    let server: String

    nonisolated init(server: String) {
        self.server = LiveClient.normalize(server)
    }

    var report: String {
        steps.map { step in
            let mark: String
            switch step.state {
            case .ok: mark = "[OK]"
            case .warn: mark = "[!]"
            case .fail: mark = "[LỖI]"
            case .running: mark = "[...]"
            }
            return "\(mark) \(step.title)\n\(step.detail)"
        }
        .joined(separator: "\n\n")
    }

    func run() async {
        guard !running else { return }
        running = true
        steps = []
        defer { running = false }

        add("Thông tin máy", (.ok, deviceInfo()))
        await step("Mạng của điện thoại") { await Self.pathCheck() }

        guard let base = URL(string: server), let host = base.host, !host.isEmpty else {
            add("Địa chỉ máy chủ", (.fail, "Địa chỉ không hợp lệ: \"\(server)\""))
            return
        }
        let port = base.port ?? (base.scheme == "http" ? 80 : 443)
        let shared = URLSession.shared
        let fresh = URLSession(configuration: .ephemeral)

        await step("Internet chung (apple.com)") {
            await Self.httpCheck(URL(string: "https://www.apple.com/library/test/success.html")!,
                                 session: fresh) { $0 == 200 }
        }
        await step("Tra tên miền (DNS)") { await Self.dnsCheck(host) }
        await step("Mở kết nối tới \(host):\(port)") {
            await Self.socketCheck(host: host, port: port, tls: base.scheme != "http")
        }
        await step("Mở trang chủ máy chủ") {
            await Self.httpCheck(base, session: fresh) { $0 < 500 }
        }
        // Giống hệt lúc bấm Đăng nhập: cùng URLSession.shared, cùng đường dẫn, chỉ khác tài khoản giả.
        await step("Gọi thử đăng nhập (tài khoản giả)") {
            let body = try? JSONSerialization.data(withJSONObject: ["username": "kiem-tra-ket-noi",
                                                                    "password": "kiem-tra-ket-noi"])
            let result = await Self.httpCheck(base.appendingPathComponent("api/auth/login"), method: "POST",
                                              body: body, session: shared) { [400, 401, 403, 429].contains($0) }
            guard result.state == .ok else { return result }
            return (.ok, result.detail + "\nMáy chủ nhận được yêu cầu đăng nhập (tài khoản giả bị từ chối là đúng).")
        }
        fresh.invalidateAndCancel()
    }

    private func add(_ title: String, _ outcome: Outcome) {
        steps.append(Step(id: steps.count, title: title, state: outcome.state, detail: outcome.detail))
    }

    private func step(_ title: String, _ work: () async -> Outcome) async {
        let index = steps.count
        steps.append(Step(id: index, title: title, state: .running, detail: "Đang kiểm tra..."))
        let outcome = await work()
        steps[index].state = outcome.state
        steps[index].detail = outcome.detail
    }

    private func deviceInfo() -> String {
        var sys = utsname()
        uname(&sys)
        let model = withUnsafeBytes(of: &sys.machine) { raw in
            String(decoding: raw.prefix { $0 != 0 }, as: UTF8.self)
        }
        let info = Bundle.main.infoDictionary ?? [:]
        let version = info["CFBundleShortVersionString"] as? String ?? "?"
        let build = info["CFBundleVersion"] as? String ?? "?"
        let clock = DateFormatter()
        clock.dateFormat = "dd/MM/yyyy HH:mm:ss"
        return """
        Máy \(model), iOS \(UIDevice.current.systemVersion), app \(version) (\(build))
        Giờ trên máy: \(clock.string(from: Date())) (\(TimeZone.current.identifier))
        Máy chủ: \(server)
        """
    }

    // MARK: Các bước

    nonisolated private static func ms(since start: Date) -> Int {
        Int(Date().timeIntervalSince(start) * 1000)
    }

    /// Trạng thái mạng iOS cấp cho app: có mạng không, qua Wi-Fi hay 4G, có bị chặn quyền không.
    nonisolated static func pathCheck() async -> Outcome {
        await withCheckedContinuation { (cont: CheckedContinuation<Outcome, Never>) in
            let once = Once()
            let monitor = NWPathMonitor()
            let queue = DispatchQueue(label: "chotlive.diag.path")
            monitor.pathUpdateHandler = { path in
                guard once.claim() else { return }
                monitor.cancel()
                cont.resume(returning: describe(path))
            }
            monitor.start(queue: queue)
            queue.asyncAfter(deadline: .now() + 5) {
                guard once.claim() else { return }
                monitor.cancel()
                cont.resume(returning: (.warn, "iOS không trả lời trạng thái mạng sau 5 giây"))
            }
        }
    }

    nonisolated private static func describe(_ path: NWPath) -> Outcome {
        var lines: [String] = []
        var state: State
        switch path.status {
        case .satisfied:
            state = .ok
            lines.append("Có mạng")
        case .unsatisfied:
            state = .fail
            var why = "Không có mạng"
            switch path.unsatisfiedReason {
            case .cellularDenied: why = "App bị tắt dữ liệu di động (Cài đặt › ChốtLive › Dữ liệu di động)"
            case .wifiDenied: why = "App bị chặn dùng Wi-Fi (Cài đặt › ChốtLive › Dữ liệu không dây)"
            case .localNetworkDenied: why = "App bị chặn mạng cục bộ"
            case .notAvailable: why = "Không có mạng nào dùng được"
            default: break
            }
            lines.append(why)
        case .requiresConnection:
            state = .warn
            lines.append("Mạng đang chờ kết nối")
        @unknown default:
            state = .warn
            lines.append("Trạng thái mạng không rõ")
        }

        let names = path.availableInterfaces.map { "\($0.name) (\(kind($0.type)))" }
        lines.append("Đường mạng: " + (names.isEmpty ? "không có" : names.joined(separator: ", ")))
        var flags: [String] = []
        if path.isConstrained { flags.append("đang bật Chế độ dữ liệu thấp"); if state == .ok { state = .warn } }
        if path.isExpensive { flags.append("mạng tốn phí (4G hoặc điểm phát)") }
        flags.append(path.supportsIPv4 ? "có IPv4" : "không có IPv4")
        flags.append(path.supportsIPv6 ? "có IPv6" : "không có IPv6")
        if !path.supportsDNS { flags.append("không có DNS"); state = .fail }
        lines.append(flags.joined(separator: ", "))
        if let proxy = proxySummary() { lines.append(proxy) }
        return (state, lines.joined(separator: "\n"))
    }

    nonisolated private static func kind(_ type: NWInterface.InterfaceType) -> String {
        switch type {
        case .wifi: return "Wi-Fi"
        case .cellular: return "di động"
        case .wiredEthernet: return "mạng dây"
        case .loopback: return "nội bộ"
        case .other: return "khác, có thể là VPN"
        @unknown default: return "không rõ"
        }
    }

    /// Proxy và các giao diện VPN iOS đang áp cho app (nếu có).
    nonisolated private static func proxySummary() -> String? {
        guard let settings = CFNetworkCopySystemProxySettings()?.takeRetainedValue() as? [String: Any] else { return nil }
        var parts: [String] = []
        if (settings["HTTPEnable"] as? Int) == 1, let host = settings["HTTPProxy"] as? String {
            parts.append("proxy \(host):\(settings["HTTPPort"] as? Int ?? 0)")
        }
        if (settings["ProxyAutoConfigEnable"] as? Int) == 1 {
            parts.append("proxy tự động \(settings["ProxyAutoConfigURLString"] as? String ?? "")")
        }
        if let scoped = settings["__SCOPED__"] as? [String: Any] {
            let vpn = scoped.keys.filter { key in
                ["ipsec", "ppp", "tap", "tun"].contains { key.hasPrefix($0) }
            }
            if !vpn.isEmpty { parts.append("có VPN: " + vpn.sorted().joined(separator: ", ")) }
        }
        return parts.isEmpty ? nil : parts.joined(separator: ", ")
    }

    /// Tra tên miền bằng bộ phân giải của máy (cùng bộ URLSession dùng).
    nonisolated static func dnsCheck(_ host: String) async -> Outcome {
        let start = Date()
        let expected = expectedIP(host)
        typealias Lookup = (code: Int32, ips: [String])
        let result: Lookup? = await withCheckedContinuation { (cont: CheckedContinuation<Lookup?, Never>) in
            let once = Once()
            DispatchQueue.global(qos: .userInitiated).async {
                var hints = addrinfo()
                hints.ai_family = AF_UNSPEC
                hints.ai_socktype = SOCK_STREAM
                var list: UnsafeMutablePointer<addrinfo>?
                let code = getaddrinfo(host, "443", &hints, &list)
                var ips: [String] = []
                var cursor = list
                while let item = cursor {
                    var buffer = [CChar](repeating: 0, count: Int(NI_MAXHOST))
                    if getnameinfo(item.pointee.ai_addr, item.pointee.ai_addrlen, &buffer, socklen_t(buffer.count),
                                   nil, 0, NI_NUMERICHOST) == 0 {
                        let ip = String(cString: buffer)
                        if !ips.contains(ip) { ips.append(ip) }
                    }
                    cursor = item.pointee.ai_next
                }
                if list != nil { freeaddrinfo(list) }
                if once.claim() { cont.resume(returning: (code, ips)) }
            }
            DispatchQueue.global().asyncAfter(deadline: .now() + 10) {
                if once.claim() { cont.resume(returning: nil) }
            }
        }
        guard let result else { return (.fail, "Quá 10 giây không tra được tên miền \(host)") }
        guard result.code == 0, !result.ips.isEmpty else {
            let text = String(cString: gai_strerror(result.code))
            return (.fail, "Không tra được \(host): \(text) (mã \(result.code)) sau \(ms(since: start)) ms")
        }
        var detail = "\(host) → \(result.ips.joined(separator: ", ")) (\(ms(since: start)) ms)"
        if let expected, !result.ips.contains(expected) {
            detail += "\nIP đúng phải là \(expected): mạng này đang trả về IP khác"
            return (.fail, detail)
        }
        return (.ok, detail)
    }

    /// Tên miền dạng ...52-64-216-229.sslip.io tự chứa IP đúng của nó.
    nonisolated private static func expectedIP(_ host: String) -> String? {
        guard let range = host.range(of: #"\d{1,3}-\d{1,3}-\d{1,3}-\d{1,3}\.sslip\.io$"#, options: .regularExpression)
        else { return nil }
        return host[range].replacingOccurrences(of: ".sslip.io", with: "").replacingOccurrences(of: "-", with: ".")
    }

    /// Mở kết nối TCP (và TLS nếu là https) để tách lỗi đường truyền khỏi lỗi của máy chủ web.
    nonisolated static func socketCheck(host: String, port: Int, tls: Bool) async -> Outcome {
        let start = Date()
        return await withCheckedContinuation { (cont: CheckedContinuation<Outcome, Never>) in
            let once = Once()
            let queue = DispatchQueue(label: "chotlive.diag.socket")
            let connection = NWConnection(host: NWEndpoint.Host(host),
                                          port: NWEndpoint.Port(rawValue: UInt16(clamping: port)) ?? .https,
                                          using: tls ? .tls : .tcp)
            let waitingNote = Note()
            let finish = { @Sendable (outcome: Outcome) in
                guard once.claim() else { return }
                connection.cancel()
                cont.resume(returning: outcome)
            }
            connection.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    var detail = "Kết nối\(tls ? " bảo mật" : "") được sau \(ms(since: start)) ms"
                    if let remote = connection.currentPath?.remoteEndpoint { detail += ", tới \(remote)" }
                    if let iface = connection.currentPath?.availableInterfaces.first { detail += ", qua \(iface.name)" }
                    finish((.ok, detail))
                case .failed(let error):
                    finish((.fail, "Thất bại sau \(ms(since: start)) ms: \(error)"))
                case .waiting(let error):
                    waitingNote.text = "\(error)"
                default:
                    break
                }
            }
            connection.start(queue: queue)
            queue.asyncAfter(deadline: .now() + 15) {
                finish((.fail, "Quá 15 giây không kết nối được" + (waitingNote.text.map { ". iOS báo: \($0)" } ?? "")))
            }
        }
    }

    nonisolated static func httpCheck(_ url: URL, method: String = "GET", body: Data? = nil,
                                      session: URLSession, accept: @escaping @Sendable (Int) -> Bool) async -> Outcome {
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData, timeoutInterval: 20)
        request.httpMethod = method
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let start = Date()
        do {
            let (_, response) = try await session.data(for: request)
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            return (accept(code) ? .ok : .warn, "Trả lời mã HTTP \(code) sau \(ms(since: start)) ms")
        } catch {
            return (.fail, "\(NetErrorText.describe(error)), sau \(ms(since: start)) ms\n\(NetErrorText.technical(error))")
        }
    }
}

/// Bảo đảm continuation chỉ được trả kết quả một lần khi có cả kết quả lẫn hẹn giờ.
private final class Once: @unchecked Sendable {
    private let lock = NSLock()
    private var done = false

    func claim() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if done { return false }
        done = true
        return true
    }
}

/// Ghi chú dùng chung giữa các closure của một kết nối (đều chạy trên cùng một hàng đợi).
private final class Note: @unchecked Sendable {
    private let lock = NSLock()
    private var value: String?

    var text: String? {
        get { lock.lock(); defer { lock.unlock() }; return value }
        set { lock.lock(); value = newValue; lock.unlock() }
    }
}

// MARK: - Màn hình

struct ConnectionTestView: View {
    @StateObject private var diag: ConnectionDiagnostics
    @Environment(\.dismiss) private var dismiss
    @State private var copied = false

    init(server: String) {
        _diag = StateObject(wrappedValue: ConnectionDiagnostics(server: server))
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                T("Kiểm tra kết nối", 20, .heavy, Theme.ink, track: -0.3)
                Spacer()
                Button { dismiss() } label: { T("Đóng", 15, .bold, Theme.orange) }
                    .buttonStyle(.plain)
            }
            .padding(.horizontal, Metrics.gutter)
            .padding(.top, 20)
            .padding(.bottom, 8)

            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    T("Chụp màn hình này, hoặc bấm Sao chép kết quả rồi gửi cho người hỗ trợ.", 13, .medium, Theme.muted)
                        .fixedSize(horizontal: false, vertical: true)
                    ForEach(diag.steps) { row($0) }
                }
                .padding(.horizontal, Metrics.gutter)
                .padding(.vertical, 8)
            }

            HStack(spacing: 10) {
                OutlineButton(title: diag.running ? "Đang kiểm tra..." : "Kiểm tra lại") {
                    copied = false
                    Task { await diag.run() }
                }
                .disabled(diag.running)
                OutlineButton(title: copied ? "Đã sao chép" : "Sao chép kết quả", filled: true) {
                    UIPasteboard.general.string = diag.report
                    copied = true
                }
                .disabled(diag.running)
            }
            .padding(.horizontal, Metrics.gutter)
            .padding(.vertical, 12)
        }
        .background(Theme.bg.ignoresSafeArea())
        .task { await diag.run() }
    }

    private func row(_ step: ConnectionDiagnostics.Step) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Group {
                switch step.state {
                case .running: ProgressView()
                case .ok: T("✓", 16, .heavy, Theme.green)
                case .warn: T("!", 16, .heavy, Theme.orange)
                case .fail: T("✗", 16, .heavy, Theme.red)
                }
            }
            .frame(width: 22, height: 22)
            VStack(alignment: .leading, spacing: 4) {
                T(step.title, 14, .bold, Theme.ink)
                T(step.detail, 12, .medium, step.state == .fail ? Theme.red : Theme.muted)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .cardStyle(16)
    }
}
