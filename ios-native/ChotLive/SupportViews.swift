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

struct SupportChatView: View {
    @EnvironmentObject var client: LiveClient

    @State private var threads: [SupportThread] = []
    @State private var draft = ""
    @State private var sending = false
    @State private var loaded = false
    @State private var composing = false // đã bấm "Phiên mới" nhưng chưa gửi tin đầu
    @State private var error: String?

    private var current: SupportThread? { threads.first { $0.session.open } }
    private var showComposer: Bool { current != nil || composing }
    private var canSend: Bool { !sending && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        SubPage(title: "Chat với quản trị viên",
                trailing: {
                    if showComposer {
                        T("Đang mở 1 phiên", 12, .bold, Theme.accent)
                            .padding(.horizontal, 12)
                            .frame(height: 32)
                            .background(Capsule().fill(Theme.card).overlay(Capsule().strokeBorder(Theme.line, lineWidth: 1)))
                    } else {
                        Button { composing = true } label: {
                            T("+ Phiên mới", 13, .bold, .white)
                                .padding(.horizontal, 16)
                                .frame(height: 44)
                                .background(Capsule().fill(Theme.orangeDeep))
                        }
                        .buttonStyle(.plain)
                    }
                }) {
            ScrollView(showsIndicators: false) {
                VStack(spacing: Metrics.gap) {
                    T("Phiên tự đóng sau 24 giờ không có tin mới. Tin nhắn lưu 30 ngày.", 12, .medium, Theme.muted)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    T("Các phiên chat", 15, .bold).frame(maxWidth: .infinity, alignment: .leading)
                    if showComposer { composer }
                    ForEach(threads.filter { !$0.session.open }) { t in pastCard(t) }
                    if loaded && !showComposer && threads.isEmpty {
                        T("Chưa có phiên chat nào. Bấm “Phiên mới” để nhắn cho quản trị viên.", 13, .semibold, Theme.muted)
                            .multilineTextAlignment(.center)
                            .padding(.top, 24)
                    }
                }
                .padding(.horizontal, Metrics.gutter)
                .padding(.bottom, 16)
            }
        }
        .task {
            client.supportChatOpen = true
            SupportNotifier.shared.requestPermission()
            await reload()
            await client.markSupportRead()
        }
        .onDisappear { client.supportChatOpen = false }
        .onReceive(client.$lastSupportMessage.compactMap { $0 }) { _ in
            Task { await reload() }
        }
    }

    // MARK: Thẻ phiên

    private var composer: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Circle().fill(Theme.green).frame(width: 8, height: 8)
                T("Phiên hiện tại", 14, .bold)
                if let s = current?.session { T("· mở lúc \(Self.stamp(s.createdAt))", 12, .medium, Theme.muted) }
                Spacer()
                Button {
                    Task {
                        composing = false
                        await client.endSupportSession()
                        await reload()
                    }
                } label: {
                    T("Kết thúc phiên", 13, .semibold, Theme.muted)
                        .padding(.horizontal, 12)
                        .frame(height: 36)
                        .background(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.line, lineWidth: 1))
                }
                .buttonStyle(.plain)
            }
            if let msgs = current?.messages, !msgs.isEmpty {
                ForEach(msgs) { m in line(m) }
            } else {
                T("Nhập nội dung cần hỗ trợ, quản trị viên sẽ trả lời tại đây.", 13, .medium, Theme.muted)
            }
            if let error { T(error, 12, .semibold, Theme.red) }
            HStack(spacing: 10) {
                TextField("Nhập tin nhắn…", text: $draft, axis: .vertical)
                    .lineLimit(1...4)
                    .font(.system(size: 15))
                    .padding(.horizontal, 14)
                    .padding(.vertical, 12)
                    .background(RoundedRectangle(cornerRadius: 12).fill(Theme.card)
                        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Theme.line, lineWidth: 1)))
                Button { Task { await send() } } label: {
                    T("Gửi", 15, .bold, .white)
                        .padding(.horizontal, 20)
                        .frame(height: 48)
                        .background(Capsule().fill(canSend ? Theme.orangeDeep : Theme.faint))
                }
                .buttonStyle(.plain)
                .disabled(!canSend)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Theme.card)
            .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Theme.orangeDeep, lineWidth: 1.5)))
    }

    private func pastCard(_ t: SupportThread) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                T("Phiên \(Self.stamp(t.session.createdAt))", 14, .bold)
                Spacer()
                T("Đã đóng · \(t.messages.count) tin", 12, .medium, Theme.muted)
            }
            ForEach(t.messages) { m in line(m) }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardStyle(16)
    }

    private func line(_ m: SupportMessage) -> some View {
        HStack(alignment: .top, spacing: 10) {
            T(m.fromAdmin ? "Quản trị viên" : "Bạn", 13, .bold, m.fromAdmin ? Theme.accent : Theme.orangeDeep)
                .frame(width: 92, alignment: .leading)
            T(m.text, 14, .medium)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            T(Self.stamp(m.ts), 11, .medium, Theme.muted)
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
            _ = try await client.sendSupport(text)
            draft = ""
            composing = false
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
