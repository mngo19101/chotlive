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

struct SupportChatView: View {
    @EnvironmentObject var client: LiveClient

    @State private var sessions: [SupportSession] = []
    /// nil = phiên mới nhất (hoặc chưa có phiên nào).
    @State private var viewingId: String?
    @State private var session: SupportSession?
    @State private var messages: [SupportMessage] = []
    @State private var draft = ""
    @State private var sending = false
    @State private var loaded = false
    @State private var showHistory = false
    @State private var error: String?

    private var latestId: String? { sessions.first?.id }
    /// Đang xem phiên cũ: chỉ đọc.
    private var readOnly: Bool { viewingId != nil && viewingId != latestId }

    var body: some View {
        SubPage(title: "Chat với Admin",
                trailing: {
                    Button { withAnimation(.easeOut(duration: 0.15)) { showHistory.toggle() } } label: {
                        T(showHistory ? "Đóng" : "Phiên trước", 13, .bold, Theme.accent)
                            .padding(.horizontal, 14)
                            .frame(height: 44)
                            .background(Capsule().fill(Theme.card).overlay(Capsule().strokeBorder(Theme.line, lineWidth: 1)))
                    }
                    .buttonStyle(.plain)
                }) {
            if showHistory { historyList } else { chat }
        }
        .task {
            client.supportChatOpen = true
            SupportNotifier.shared.requestPermission()
            await reload()
            await client.markSupportRead()
        }
        .onDisappear { client.supportChatOpen = false }
        .onReceive(client.$lastSupportMessage.compactMap { $0 }) { m in
            guard !readOnly, !messages.contains(where: { $0.id == m.id }) else { return }
            if let s = session, s.id != m.sessionId { return }
            messages.append(m)
            Task { await reload(keepScroll: true) }
        }
    }

    // MARK: Khung chat

    private var chat: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView(showsIndicators: false) {
                    VStack(spacing: 8) {
                        info
                        if loaded && messages.isEmpty {
                            T("Nhắn cho Admin nếu bạn cần hỗ trợ. Admin sẽ trả lời ngay trong đây và app sẽ báo cho bạn.",
                              13, .medium, Theme.muted)
                                .multilineTextAlignment(.center)
                                .padding(.top, 24)
                        }
                        ForEach(messages) { m in bubble(m).id(m.id) }
                        Color.clear.frame(height: 1).id("end")
                    }
                    .padding(.horizontal, Metrics.gutter)
                    .padding(.bottom, 8)
                }
                .onChange(of: messages.count) { _ in
                    withAnimation { proxy.scrollTo("end", anchor: .bottom) }
                }
                .onAppear { proxy.scrollTo("end", anchor: .bottom) }
            }
            footer
        }
    }

    private var info: some View {
        let text: String
        if let s = session {
            let when = Self.stamp(s.createdAt)
            text = s.open
                ? "Phiên bắt đầu \(when). Tự đóng sau 24 giờ không có tin mới."
                : "Phiên bắt đầu \(when), đã đóng. Tin nhắn được lưu 30 ngày."
        } else {
            text = "Phiên chat tự đóng sau 24 giờ không có tin mới. Tin nhắn được lưu 30 ngày."
        }
        return T(text, 11, .semibold, Theme.muted)
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 6)
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
                T((m.fromAdmin ? "Admin · " : "") + Self.stamp(m.ts), 10, .medium, Theme.muted)
            }
            if m.fromAdmin { Spacer(minLength: 48) }
        }
    }

    @ViewBuilder
    private var footer: some View {
        if readOnly {
            Button {
                viewingId = nil
                Task { await reload() }
            } label: {
                T("Về phiên hiện tại", 14, .bold, .white)
                    .frame(maxWidth: .infinity, minHeight: 48)
                    .background(Capsule().fill(Theme.orangeDeep))
            }
            .buttonStyle(.plain)
            .padding(Metrics.gutter)
        } else {
            VStack(spacing: 6) {
                if let error { T(error, 12, .semibold, Theme.red) }
                if let s = session, !s.open {
                    T("Phiên này đã đóng. Gửi tin mới sẽ mở phiên mới.", 12, .semibold, Theme.muted)
                }
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
        }
    }

    private var canSend: Bool { !sending && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    // MARK: Lịch sử

    private var historyList: some View {
        ScrollView(showsIndicators: false) {
            VStack(spacing: Metrics.gap) {
                T("Tin nhắn các phiên được lưu 30 ngày.", 12, .medium, Theme.muted)
                if sessions.isEmpty {
                    T("Chưa có phiên chat nào.", 13, .semibold, Theme.muted).padding(.top, 24)
                }
                ForEach(sessions) { s in
                    Button {
                        viewingId = s.id == latestId ? nil : s.id
                        showHistory = false
                        Task { await reload() }
                    } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                T(Self.stamp(s.createdAt), 13, .bold)
                                Spacer()
                                T(s.open ? "Đang mở" : "Đã đóng", 11, .bold, s.open ? Theme.green : Theme.muted)
                            }
                            T((s.lastSender == "admin" ? "Admin: " : "Bạn: ") + s.lastText, 13, .medium, Theme.muted)
                                .lineLimit(2)
                                .multilineTextAlignment(.leading)
                        }
                        .padding(16)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .cardStyle(20)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, Metrics.gutter)
            .padding(.bottom, 16)
        }
    }

    // MARK: Dữ liệu

    private func reload(keepScroll: Bool = false) async {
        if let list = await client.fetchSupportSessions() { sessions = list }
        if let (s, msgs) = await client.fetchSupportMessages(sessionId: viewingId) {
            session = s
            messages = msgs
        }
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
            if !messages.contains(where: { $0.id == m.id }) { messages.append(m) }
            await reload()
        } catch {
            self.error = error.localizedDescription
        }
    }

    private static let stampFormat: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "vi_VN")
        f.dateFormat = "HH:mm dd/MM"
        return f
    }()

    static func stamp(_ d: Date) -> String { stampFormat.string(from: d) }
}
