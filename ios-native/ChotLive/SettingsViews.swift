import CoreBluetooth
import SwiftUI

// MARK: - Tôi

struct SettingsView: View {
    @EnvironmentObject var client: LiveClient
    @EnvironmentObject var store: Store
    @EnvironmentObject var printer: PrinterManager
    @EnvironmentObject var ui: AppUI

    private var version: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0.0"
    }

    private var printerConnected: Bool {
        #if DEBUG
        if Demo.isActive { return true }
        #endif
        return printer.isConnected
    }

    var body: some View {
        ScrollView(showsIndicators: false) {
            VStack(alignment: .leading, spacing: 0) {
                PageHeader(subtitle: "Tài khoản và cài đặt", title: "Tôi") { EmptyView() }
                    .padding(.bottom, 15)

                sectionLabel("Tài khoản")
                appAccountsCard.padding(.bottom, 15)

                sectionLabel("Cài đặt")
                settingsCard.padding(.bottom, 15)

                Button {
                    ui.confirm = ConfirmItem(title: "Đăng xuất?", message: "Dữ liệu đã lưu trên máy vẫn được giữ lại.",
                                             action: "Đăng xuất") { client.logout() }
                } label: {
                    HStack(spacing: 10) {
                        Icon(name: .logout, size: 17, color: Theme.red)
                        T("Đăng xuất", 15, .bold, Theme.red)
                    }
                    .frame(maxWidth: .infinity)
                    .frame(height: 50)
                    .background(Capsule().fill(Theme.card).overlay(Capsule().strokeBorder(Theme.line, lineWidth: 1)))
                }
                .buttonStyle(.plain)

                T("Phiên bản \(version)", 12, .medium, Theme.muted)
                    .frame(maxWidth: .infinity)
                    .padding(.top, 15)
            }
            .padding(.horizontal, Metrics.gutter)
            .padding(.top, 2)
            .padding(.bottom, 16)
        }
        .background(Theme.bg)
    }

    private func sectionLabel(_ text: String) -> some View {
        T(text, 13, .bold, Theme.muted)
            .padding(.leading, 4)
            .padding(.bottom, 8)
    }

    /// Tài khoản ChốtLive đã đăng nhập trên máy — khác với tài khoản TikTok (quản lý trong Live mới).
    private var appAccountsCard: some View {
        VStack(spacing: 0) {
            ForEach(client.savedAccounts) { a in
                appAccountRow(a)
                HairLine()
            }
            Button {
                ui.present { AddAppAccountSheet(defaultServer: client.baseURL) }
            } label: {
                HStack(spacing: 12) {
                    Icon(name: .plus, size: 20, color: Theme.accent)
                        .frame(width: 45, height: 45)
                        .overlay(Circle().strokeBorder(Theme.peachLine, style: StrokeStyle(lineWidth: 1, dash: [3, 3])))
                    T("Thêm tài khoản", 15, .bold, Theme.accent)
                    Spacer()
                }
                .padding(.horizontal, 17)
                .frame(height: 60)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
        .cardStyle(22)
    }

    private var currentAccountKey: String { AuthStorage.accountKey(server: client.baseURL, user: client.username) }

    private func appAccountRow(_ a: AuthStorage.SavedAccount) -> some View {
        let active = a.key == currentAccountKey
        return Button {
            guard !active else { return }
            if ["connected", "connecting"].contains(client.liveState) {
                ui.confirm = ConfirmItem(title: "Đổi tài khoản?", message: "Phiên live đang đọc sẽ dừng lại.",
                                         action: "Đổi tài khoản") { client.switchAccount(to: a.key) }
            } else {
                client.switchAccount(to: a.key)
            }
        } label: {
            HStack(spacing: 12) {
                Avatar(text: initialsOf(a.user), seed: a.key)
                VStack(alignment: .leading, spacing: 3) {
                    T(a.user, 15, .bold).lineLimit(1)
                    T(serverHost(a.server), 12, .medium, Theme.muted).lineLimit(1)
                }
                Spacer(minLength: 4)
                if active {
                    T("Đang dùng", 12, .semibold, Theme.green).lineLimit(1).fixedSize().padding(.trailing, -5)
                    Icon(name: .check, size: 14, weight: 2.8)
                        .frame(width: 24, height: 24)
                        .background(Circle().fill(Theme.orange))
                } else {
                    Circle().strokeBorder(Theme.bar, lineWidth: 1.5).frame(width: 24, height: 24)
                }
            }
            .padding(.horizontal, 17)
            .frame(height: 68.5)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .contextMenu {
            if !active {
                Button("Xoá tài khoản", role: .destructive) { client.forgetSavedAccount(a.key) }
            }
        }
    }

    private func serverHost(_ s: String) -> String {
        s.replacingOccurrences(of: "https://", with: "").replacingOccurrences(of: "http://", with: "")
    }

    private var settingsCard: some View {
        VStack(spacing: 0) {
            settingRow(.printer, "Máy in", trailing: printerConnected ? "Đã kết nối" : "Chưa kết nối",
                       trailingColor: printerConnected ? Theme.green : Theme.muted, route: .printer)
            HairLine()
            settingRow(.tag, "Từ khoá chốt đơn", route: .keywords)
            HairLine()
            settingRow(.bell, "Thông báo", route: .notifications)
            HairLine()
            settingRow(.help, "Trợ giúp", route: .help)
        }
        .cardStyle(22)
    }

    private func settingRow(_ icon: IconName, _ title: String, trailing: String? = nil, trailingColor: Color = Theme.muted,
                            route: Route) -> some View {
        Button { ui.push(route) } label: {
            HStack(spacing: 12) {
                Icon(name: icon, size: 16, weight: 2.3, color: Theme.accent)
                    .frame(width: 32, height: 32)
                    .background(Circle().fill(Theme.peachSoft))
                T(title, 15, .semibold).lineLimit(1)
                Spacer(minLength: 4)
                if let trailing { T(trailing, 12, .semibold, trailingColor).lineLimit(1).fixedSize() }
                Icon(name: .chevronRight, size: 16, weight: 2.4, color: Theme.muted).padding(.leading, -2)
            }
            .padding(.horizontal, 17)
            .frame(height: 56)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// Thêm một tài khoản ChốtLive khác trên cùng máy — đăng nhập xong có thể đổi qua lại không cần nhập lại mật khẩu.
struct AddAppAccountSheet: View {
    @EnvironmentObject var client: LiveClient
    @EnvironmentObject var ui: AppUI
    @State var server: String
    @State private var user = ""
    @State private var pass = ""
    @State private var busy = false
    @State private var error: String?

    init(defaultServer: String) {
        _server = State(initialValue: defaultServer)
    }

    private var canSubmit: Bool {
        !busy && !server.trimmingCharacters(in: .whitespaces).isEmpty && !user.isEmpty && !pass.isEmpty
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            SheetTitle(title: "Thêm tài khoản", subtitle: "Đăng nhập một tài khoản ChốtLive khác").padding(.top, 6)
            LabeledField(label: "Server ChốtLive", placeholder: "https://ten-server.onrender.com",
                         text: $server, keyboard: .URL, capitalize: false)
            LabeledField(label: "Tên tài khoản", placeholder: "Tên tài khoản", text: $user, capitalize: false)
            VStack(alignment: .leading, spacing: 6) {
                T("Mật khẩu", 12, .medium, Theme.muted)
                SecureField("Mật khẩu", text: $pass)
                    .font(.bv(15, .semibold))
                    .padding(.horizontal, 15)
                    .frame(height: 44)
                    .cardStyle(14, fill: Theme.field)
            }
            if let error { T(error, 13, .medium, Theme.red) }
            PrimaryButton(title: busy ? "Đang đăng nhập..." : "Đăng nhập", enabled: canSubmit) {
                busy = true
                error = nil
                Task {
                    do {
                        try await client.login(server: server, user: user, password: pass)
                        ui.dismissSheet()
                    } catch {
                        self.error = error.localizedDescription
                    }
                    busy = false
                }
            }
        }
        .padding(.horizontal, Metrics.gutter)
    }
}

// MARK: - Máy in

struct PrinterView: View {
    @EnvironmentObject var printer: PrinterManager
    @AppStorage("paperWidth") private var paperWidth = 576
    @AppStorage("shopName") private var shopName = "ChốtLive"

    var body: some View {
        SubPage(title: "Máy in") {
            ScrollView(showsIndicators: false) {
                VStack(alignment: .leading, spacing: Metrics.gap) {
                    VStack(alignment: .leading, spacing: 12) {
                        T("Trạng thái", 15, .bold)
                        T(printer.statusText, 13, .medium, Theme.muted)
                        if let n = printer.connectedName {
                            T("Đang dùng: \(n)", 14, .semibold, Theme.green)
                            HStack(spacing: 8) {
                                OutlineButton(title: "In thử", icon: .printer, filled: true) { printTest() }
                                OutlineButton(title: "Ngắt kết nối", color: Theme.red) { printer.disconnect() }
                            }
                        }
                    }
                    .padding(16)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .cardStyle(20)

                    VStack(alignment: .leading, spacing: 12) {
                        T("Máy in Bluetooth gần đây", 15, .bold)
                        OutlineButton(title: printer.isScanning ? "Đang tìm..." : "Tìm máy in", icon: .search, filled: true) {
                            printer.startScan()
                        }
                        .disabled(printer.isScanning)
                        ForEach(printer.devices, id: \.identifier) { p in
                            Button { printer.connect(p) } label: {
                                HStack {
                                    T(p.name ?? p.identifier.uuidString, 14, .semibold).lineLimit(1)
                                    Spacer()
                                    Icon(name: .chevronRight, size: 16, color: Theme.muted)
                                }
                                .frame(height: 40)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(16)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .cardStyle(20)

                    VStack(alignment: .leading, spacing: 14) {
                        T("Tem", 15, .bold)
                        HStack(spacing: 8) {
                            Chip(title: "80mm", selected: paperWidth == 576) { paperWidth = 576 }
                            Chip(title: "58mm", selected: paperWidth == 384) { paperWidth = 384 }
                        }
                        LabeledField(label: "Tên shop trên tem", placeholder: "ChốtLive", text: $shopName)
                    }
                    .padding(16)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .cardStyle(20)
                }
                .padding(.horizontal, Metrics.gutter)
                .padding(.bottom, 16)
            }
            .scrollDismissesKeyboard(.interactively)
        }
    }

    private func printTest() {
        let c = LiveComment(id: "test", uniqueId: "tai_khoan_mau", userId: "123456789", nickname: "Khách thử",
                            text: "59", ts: Date(), price: 59000)
        printer.send(TicketRenderer.ticketBytes(comment: c))
    }
}

// MARK: - Từ khoá chốt đơn

struct KeywordsView: View {
    @EnvironmentObject var store: Store
    @State private var draft = ""

    var body: some View {
        SubPage(title: "Từ khoá chốt đơn") {
            ScrollView(showsIndicators: false) {
                VStack(alignment: .leading, spacing: Metrics.gap) {
                    T("Bình luận chứa một trong các từ khoá này, hoặc chỉ ghi mã, được coi là bình luận chốt đơn.", 13, .medium, Theme.muted)
                    HStack(spacing: 8) {
                        TextField("Thêm từ khoá", text: $draft)
                            .font(.bv(15, .semibold))
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .onSubmit { add() }
                            .padding(.horizontal, 15)
                            .frame(height: 44)
                            .cardStyle(14)
                        CircleButton(icon: .plus) { add() }
                    }
                    VStack(spacing: 0) {
                        ForEach(Array(store.keywords.enumerated()), id: \.element) { index, k in
                            if index > 0 { HairLine() }
                            HStack {
                                T(k, 15, .semibold).lineLimit(1)
                                Spacer()
                                Button { store.setKeywords(store.keywords.filter { $0 != k }) } label: {
                                    Icon(name: .close, size: 16, color: Theme.muted).frame(width: 34, height: 34)
                                }
                                .buttonStyle(.plain)
                            }
                            .padding(.horizontal, 17)
                            .frame(height: 52)
                        }
                    }
                    .cardStyle(20)
                }
                .padding(.horizontal, Metrics.gutter)
                .padding(.bottom, 16)
            }
            .scrollDismissesKeyboard(.interactively)
        }
    }

    private func add() {
        let word = draft.trimmingCharacters(in: .whitespaces).lowercased()
        draft = ""
        guard !word.isEmpty, !store.keywords.contains(word) else { return }
        store.setKeywords(store.keywords + [word])
    }
}

// MARK: - Thông báo

struct NotificationsView: View {
    @AppStorage(CommentAlert.soundKey) private var sound = false
    @AppStorage(CommentAlert.hapticKey) private var haptic = false

    var body: some View {
        SubPage(title: "Thông báo") {
            ScrollView(showsIndicators: false) {
                VStack(alignment: .leading, spacing: Metrics.gap) {
                    T("Báo khi có bình luận chốt đơn trong lúc app đang mở.", 13, .medium, Theme.muted)
                    VStack(spacing: 0) {
                        Toggle(isOn: $sound) { T("Âm thanh", 15, .semibold) }
                            .tint(Theme.orange)
                            .padding(.horizontal, 17)
                            .frame(height: 56)
                        HairLine()
                        Toggle(isOn: $haptic) { T("Rung", 15, .semibold) }
                            .tint(Theme.orange)
                            .padding(.horizontal, 17)
                            .frame(height: 56)
                    }
                    .cardStyle(20)
                }
                .padding(.horizontal, Metrics.gutter)
            }
        }
    }
}

// MARK: - Trợ giúp

struct HelpView: View {
    @EnvironmentObject var client: LiveClient

    private let topics: [(String, String)] = [
        ("Bắt đầu đọc bình luận", "Vào tab Bình luận, bấm Live mới, nhập tên TikTok đang live. Phiên được ghi lại tự động."),
        ("Chốt đơn", "Mở phiên live, bấm nút in trên bình luận. Đơn được lưu vào Khách hàng và Đơn hàng kể cả khi chưa nối máy in."),
        ("In tem", "Vào Tôi › Máy in để tìm và kết nối máy in Bluetooth, sau đó bấm In đơn trên đơn hàng."),
        ("Trạng thái giao", "Bấm Giao hàng để chuyển đơn sang Đang giao, bấm lần nữa khi đã giao xong."),
    ]

    var body: some View {
        SubPage(title: "Trợ giúp") {
            ScrollView(showsIndicators: false) {
                VStack(spacing: Metrics.gap) {
                    VStack(alignment: .leading, spacing: 8) {
                        T("Tài khoản ChốtLive", 15, .bold)
                        if !client.username.isEmpty { T(client.username, 14, .semibold).lineLimit(1) }
                        if !client.baseURL.isEmpty { T(client.baseURL, 12, .medium, Theme.muted).lineLimit(1) }
                        T(client.socketConnected ? "Đã nối server" : "Mất kết nối server", 12, .semibold,
                          client.socketConnected ? Theme.green : Theme.red)
                    }
                    .padding(16)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .cardStyle(20)

                    ForEach(topics, id: \.0) { title, body in
                        VStack(alignment: .leading, spacing: 6) {
                            T(title, 15, .bold)
                            T(body, 13, .medium, Theme.muted).fixedSize(horizontal: false, vertical: true)
                        }
                        .padding(16)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .cardStyle(20)
                    }
                }
                .padding(.horizontal, Metrics.gutter)
                .padding(.bottom, 16)
            }
        }
    }
}
