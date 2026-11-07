import SwiftUI
import UserNotifications

// MARK: - Mô hình

struct SupportMessage: Identifiable, Equatable {
    let id: Int
    let sessionId: String
    let sender: String // "user" | "admin"
    let text: String
    let ts: Date

    var fromAdmin: Bool { sender == "admin" }

    init?(_ d: [String: Any]) {
        guard let id = d["id"] as? Int, let sessionId = d["sessionId"] as? String,
              let sender = d["sender"] as? String, let text = d["text"] as? String else { return nil }
        self.id = id
        self.sessionId = sessionId
        self.sender = sender
        self.text = text
        self.ts = Date(timeIntervalSince1970: ((d["ts"] as? Double) ?? 0) / 1000)
    }
}

struct SupportSession: Identifiable, Equatable {
    let id: String
    let createdAt: Date
    let lastAt: Date
    let closesAt: Date
    let open: Bool
    let lastText: String
    let lastSender: String

    init?(_ d: [String: Any]) {
        guard let id = d["id"] as? String else { return nil }
        func date(_ k: String) -> Date { Date(timeIntervalSince1970: ((d[k] as? Double) ?? 0) / 1000) }
        self.id = id
        createdAt = date("createdAt")
        lastAt = date("lastAt")
        closesAt = date("closesAt")
        open = (d["open"] as? Bool) ?? false
        lastText = (d["lastText"] as? String) ?? ""
        lastSender = (d["lastSender"] as? String) ?? ""
    }
}

struct SupportThread: Identifiable, Equatable {
    let session: SupportSession
    let messages: [SupportMessage]
    var id: String { session.id }
}

// MARK: - Thông báo

extension Notification.Name {
    /// Người dùng bấm vào thông báo Admin trả lời.
    static let openSupportChat = Notification.Name("openSupportChat")
}

/// Báo khi Admin trả lời. Chỉ chạy lúc app còn nối server (đang mở hoặc vừa chuyển sang nền);
/// app đã bị tắt hẳn thì cần push từ Apple (APNs), chưa có.
final class SupportNotifier: NSObject, UNUserNotificationCenterDelegate {
    static let shared = SupportNotifier()

    func install() {
        UNUserNotificationCenter.current().delegate = self
    }

    func requestPermission() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
    }

    func notify(text: String) {
        let content = UNMutableNotificationContent()
        content.title = "Admin đã trả lời"
        content.body = text
        content.sound = .default
        let req = UNNotificationRequest(identifier: "support-\(UUID().uuidString)", content: content, trigger: nil)
        UNUserNotificationCenter.current().add(req)
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
        done([.banner, .sound])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler done: @escaping () -> Void) {
        NotificationCenter.default.post(name: .openSupportChat, object: nil)
        done()
    }
}

// MARK: - Màn chat

/// Kiểu Messenger: danh sách phiên theo ngày, bấm vào một phiên mới thấy tin nhắn và ô chat.
struct SupportChatView: View {
    @EnvironmentObject var client: LiveClient

    @State private var threads: [SupportThread] = []
    /// nil = đang xem danh sách.
    @State private var selectedId: String?
    @State private var composingNew = false
    @State private var draft = ""
    @State private var sending = false
    @State private var loaded = false
    @State private var error: String?

    private var selected: SupportThread? { threads.first { $0.id == selectedId } }
    private var hasOpen: Bool { threads.contains { $0.session.open } }
    private var inThread: Bool { composingNew || selected != nil }
    private var canType: Bool { composingNew || (selected?.session.open ?? false) }
    private var canSend: Bool { !sending && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        SubPage(title: "Chat với quản trị viên",
                trailing: {
                    if !inThread && !hasOpen {
                        Button { composingNew = true } label: {
                            T("+ Phiên mới", 13, .bold, .white)
                                .padding(.horizontal, 16)
                                .frame(height: 44)
                                .background(Capsule().fill(Theme.orangeDeep))
                        }
                        .buttonStyle(.plain)
                    }
                }) {
            if inThread { thread } else { list }
        }
        .task {
            client.supportChatOpen = true
            SupportNotifier.shared.requestPermission()
            client.checkSocket()
            await reload()
            await client.markSupportRead()
            // Hỏi lại server định kỳ: tin từ Telegram vẫn hiện ngay dù kết nối realtime bị rớt.
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 3_000_000_000)
                if Task.isCancelled { break }
                await reload()
                if client.supportUnread > 0 { await client.markSupportRead() }
            }
        }
        .onDisappear { client.supportChatOpen = false }
        .onReceive(client.$lastSupportMessage.compactMap { $0 }) { _ in
            Task { await reload() }
        }
    }

    // MARK: Danh sách phiên

    private var list: some View {
        ScrollView(showsIndicators: false) {
            VStack(spacing: 10) {
                T("Phiên tự đóng sau 24 giờ không có tin mới. Tin nhắn lưu 30 ngày.", 12, .medium, Theme.muted)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.bottom, 4)
                if loaded && threads.isEmpty {
                    T("Chưa có phiên chat nào. Bấm “Phiên mới” để nhắn cho quản trị viên.", 13, .semibold, Theme.muted)
                        .multilineTextAlignment(.center)
                        .padding(.top, 32)
                }
                ForEach(threads) { t in
                    Button { selectedId = t.id; error = nil } label: { row(t) }
                        .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, Metrics.gutter)
            .padding(.bottom, 16)
        }
    }

    private func row(_ t: SupportThread) -> some View {
        let last = t.messages.last
        return HStack(spacing: 12) {
            Circle().fill(t.session.open ? Theme.green : Theme.faint).frame(width: 10, height: 10)
            VStack(alignment: .leading, spacing: 3) {
                T("Phiên \(Self.day(t.session.createdAt))", 15, .bold)
                T(last.map { ($0.fromAdmin ? "Quản trị viên: " : "Bạn: ") + $0.text } ?? "Chưa có tin nhắn", 13, .medium, Theme.muted)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 3) {
                T(t.session.open ? "Đang mở" : "Đã đóng", 11, .bold, t.session.open ? Theme.green : Theme.muted)
                T(Self.clock(last?.ts ?? t.session.lastAt), 11, .medium, Theme.muted)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardStyle(16)
    }

    // MARK: Một phiên

    private var thread: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Button {
                    selectedId = nil
                    composingNew = false
                    draft = ""
                } label: {
                    T("‹ Các phiên", 14, .bold, Theme.accent)
                }
                .buttonStyle(.plain)
                Spacer()
                T(selected.map { "Phiên \(Self.day($0.session.createdAt))" } ?? "Phiên mới", 14, .bold)
                Spacer()
                if selected?.session.open == true {
                    Button {
                        Task {
                            await client.endSupportSession()
                            await reload()
                        }
                    } label: {
                        T("Kết thúc", 13, .semibold, Theme.muted)
                            .padding(.horizontal, 12)
                            .frame(height: 34)
                            .background(Capsule().strokeBorder(Theme.line, lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                } else {
                    Color.clear.frame(width: 70, height: 1)
                }
            }
            .padding(.horizontal, Metrics.gutter)
            .padding(.bottom, 8)

            ScrollViewReader { proxy in
                ScrollView(showsIndicators: false) {
                    VStack(spacing: 8) {
                        if (selected?.messages.isEmpty ?? true) {
                            T("Nhắn cho quản trị viên nếu bạn cần hỗ trợ. Khi có trả lời, app sẽ báo cho bạn.", 13, .medium, Theme.muted)
                                .multilineTextAlignment(.center)
                                .padding(.top, 24)
                        }
                        ForEach(selected?.messages ?? []) { m in bubble(m).id(m.id) }
                        Color.clear.frame(height: 1).id("end")
                    }
                    .padding(.horizontal, Metrics.gutter)
                    .padding(.bottom, 8)
                }
                .onChange(of: selected?.messages.count) { _ in
                    withAnimation { proxy.scrollTo("end", anchor: .bottom) }
                }
                .onAppear { proxy.scrollTo("end", anchor: .bottom) }
            }
            footer
        }
    }

    private func bubble(_ m: SupportMessage) -> some View {
        HStack {
            if !m.fromAdmin { Spacer(minLength: 48) }
            VStack(alignment: m.fromAdmin ? .leading : .trailing, spacing: 3) {
                T(m.text, 14, .medium, m.fromAdmin ? Theme.ink : .white)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(
                        RoundedRectangle(cornerRadius: 18, style: .continuous)
                            .fill(m.fromAdmin ? Theme.card : Theme.orangeDeep)
                            .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous)
                                .strokeBorder(m.fromAdmin ? Theme.line : .clear, lineWidth: 1))
                    )
                T((m.fromAdmin ? "Quản trị viên · " : "") + Self.clock(m.ts), 10, .medium, Theme.muted)
            }
            if m.fromAdmin { Spacer(minLength: 48) }
        }
    }

    @ViewBuilder
    private var footer: some View {
        if canType {
            VStack(spacing: 6) {
                if let error { T(error, 12, .semibold, Theme.red) }
                HStack(spacing: 10) {
                    TextField("Nhập tin nhắn…", text: $draft, axis: .vertical)
                        .lineLimit(1...4)
                        .font(.system(size: 15))
                        .padding(.horizontal, 16)
                        .padding(.vertical, 12)
                        .background(Capsule().fill(Theme.card).overlay(Capsule().strokeBorder(Theme.line, lineWidth: 1)))
                    Button { Task { await send() } } label: {
                        Icon(name: .arrowRight, size: 18, weight: 2.4, color: .white)
                            .frame(width: 46, height: 46)
                            .background(Circle().fill(canSend ? Theme.orangeDeep : Theme.faint))
                    }
                    .buttonStyle(.plain)
                    .disabled(!canSend)
                }
            }
            .padding(.horizontal, Metrics.gutter)
            .padding(.vertical, 10)
        } else {
            T("Phiên này đã đóng. Quay lại danh sách và bấm “Phiên mới” để nhắn tiếp.", 12, .semibold, Theme.muted)
                .multilineTextAlignment(.center)
                .padding(Metrics.gutter)
        }
    }

    // MARK: Dữ liệu

    private func reload() async {
        if let list = await client.fetchSupportThreads() { threads = list }
        loaded = true
    }

    private func send() async {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        sending = true
        error = nil
        defer { sending = false }
        do {
            let m = try await client.sendSupport(text)
            draft = ""
            composingNew = false
            selectedId = m.sessionId
            await reload()
        } catch {
            self.error = error.localizedDescription
        }
    }

    private static func format(_ f: String) -> DateFormatter {
        let d = DateFormatter()
        d.locale = Locale(identifier: "vi_VN")
        d.dateFormat = f
        return d
    }
    private static let dayFormat = format("dd/MM")
    private static let clockFormat = format("HH:mm")

    static func day(_ d: Date) -> String { dayFormat.string(from: d) }
    static func clock(_ d: Date) -> String { clockFormat.string(from: d) }
}
