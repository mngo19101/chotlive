import CoreBluetooth
import SwiftUI

// MARK: - Tôi

struct SettingsView: View {
    @EnvironmentObject var client: LiveClient
    @EnvironmentObject var store: Store
    @EnvironmentObject var printer: PrinterManager
    @EnvironmentObject var ui: AppUI
    @EnvironmentObject var appearance: Appearance

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
                if let access = client.access, access.status != "admin" {
                    AccessCard(access: access).padding(.bottom, 10)
                }
                appAccountsCard.padding(.bottom, 15)

                sectionLabel("Cài đặt")
                settingsCard.padding(.bottom, 15)

                Button {
                    let count = client.savedAccounts.count
                    let scope = count > 1 ? "Cả \(count) tài khoản trên máy sẽ được đăng xuất. " : ""
                    ui.confirm = ConfirmItem(title: "Đăng xuất?", message: scope + "Dữ liệu đã lưu trên máy vẫn được giữ lại.",
                                             action: "Đăng xuất") { client.logoutAll() }
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
            // Đổi tài khoản làm thẻ gói xuất hiện/biến mất và đẩy cả trang; không animate để khỏi giật.
            .transaction { $0.animation = nil }
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
        // Không dùng Button + contextMenu: chạm vào là iOS chụp ảnh dòng để làm hiệu ứng nhấn giữ,
        // đổi tài khoản xong ảnh cũ mờ dần chồng lên dòng mới nên trông như bị giật, chữ đè lên nhau.
        return HStack(spacing: 12) {
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
                    .onAccent()
            } else {
                Circle().strokeBorder(Theme.bar, lineWidth: 1.5).frame(width: 24, height: 24)
            }
        }
        .padding(.horizontal, 17)
        .frame(height: 68.5)
        .contentShape(Rectangle())
        .onTapGesture {
            guard !active else { return }
            if ["connected", "connecting", "reconnecting"].contains(client.liveState) {
                ui.confirm = ConfirmItem(title: "Đổi tài khoản?",
                                         message: "Server vẫn ghi tiếp live của tài khoản này. Máy sẽ chuyển sang dữ liệu của tài khoản kia.",
                                         action: "Đổi tài khoản") { client.switchAccount(to: a.key) }
            } else {
                client.switchAccount(to: a.key)
            }
        }
        .onLongPressGesture(minimumDuration: 0.5) {
            guard !active else { return }
            ui.confirm = ConfirmItem(title: "Xoá tài khoản \(a.user)?",
                                     message: "Tài khoản sẽ bị xoá khỏi máy này. Muốn dùng lại thì đăng nhập lại.",
                                     action: "Xoá tài khoản") { client.forgetSavedAccount(a.key) }
        }
        .accessibilityAddTraits(.isButton)
    }

    private func serverHost(_ s: String) -> String {
        s.replacingOccurrences(of: "https://", with: "").replacingOccurrences(of: "http://", with: "")
    }

    private var settingsCard: some View {
        VStack(spacing: 0) {
            settingRow(.truck, "ViettelPost", trailing: client.vtpConnected ? "Đã kết nối" : "Chưa kết nối",
                       trailingColor: client.vtpConnected ? Theme.green : Theme.muted, route: .vtp)
            HairLine()
            settingRow(.printer, "Máy in", trailing: printerConnected ? "Đã kết nối" : "Chưa kết nối",
                       trailingColor: printerConnected ? Theme.green : Theme.muted, route: .printer)
            HairLine()
            settingRow(.palette, "Giao diện", trailing: appearance.summary, trailingColor: Theme.accent,
                       isNew: !appearance.seen, route: .appearance)
            HairLine()
            settingRow(.tag, "Từ khoá chốt đơn", route: .keywords)
            HairLine()
            settingRow(.bell, "Thông báo", route: .notifications)
            HairLine()
            settingRow(.help, "Hỗ trợ", trailing: client.supportUnread > 0 ? "\(client.supportUnread) tin mới" : nil,
                       trailingColor: Theme.red, route: .help)
        }
        .cardStyle(22)
    }

    private func settingRow(_ icon: IconName, _ title: String, trailing: String? = nil, trailingColor: Color = Theme.muted,
                            isNew: Bool = false, route: Route) -> some View {
        Button { ui.push(route) } label: {
            HStack(spacing: 12) {
                Icon(name: icon, size: 16, weight: 2.3, color: Theme.accent)
                    .frame(width: 32, height: 32)
                    .background(Circle().fill(Theme.peachSoft))
                T(title, 15, .semibold).lineLimit(1)
                Spacer(minLength: 4)
                if isNew {
                    T("MỚI", 10, .heavy).padding(.horizontal, 7).frame(height: 18)
                        .background(Capsule().fill(Theme.orange)).onAccent()
                }
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

/// Dùng thử, gói hoặc hết hạn của tài khoản đang dùng. Lúc dùng thử thì đếm ngược từng giây.
struct AccessCard: View {
    let access: AccountAccess

    var body: some View {
        if access.status == "trial" {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                card(title: "Dùng thử miễn phí còn",
                     value: AccountAccess.countdownText(until: access.endsAt, now: context.date),
                     color: Theme.accent, background: Theme.peachSoft, border: Theme.peachLine)
            }
        } else if access.canFollowLive {
            card(title: "Gói đang dùng",
                 value: "Còn \(AccountAccess.remainingText(until: access.endsAt, now: Date()))",
                 color: Theme.accent, background: Theme.peachSoft, border: Theme.peachLine)
        } else {
            card(title: access.code == "PLAN_EXPIRED" ? "Gói đã hết hạn" : "Đã hết dùng thử",
                 value: access.message.isEmpty ? "Vui lòng mua gói để tiếp tục theo dõi live." : access.message,
                 color: Theme.red, background: Theme.redSoft, border: Theme.red.opacity(0.25), wraps: true)
        }
    }

    private func card(title: String, value: String, color: Color, background: Color, border: Color,
                      wraps: Bool = false) -> some View {
        HStack(spacing: 12) {
            Icon(name: .calendar, size: 16, weight: 2.3, color: color)
                .frame(width: 32, height: 32)
                .background(Circle().fill(Theme.card))
            VStack(alignment: .leading, spacing: 3) {
                T(title, 12.5, .semibold, color.opacity(0.85)).lineLimit(1)
                if wraps {
                    T(value, 14, .bold, color).fixedSize(horizontal: false, vertical: true)
                } else {
                    T(value, 15, .bold, color).monospacedDigit().lineLimit(1).minimumScaleFactor(0.8)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 15)
        .padding(.vertical, 12)
        .background(RoundedRectangle(cornerRadius: 18).fill(background))
        .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(border, lineWidth: 1))
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
        _server = State(initialValue: AppConfig.builtInServer ?? defaultServer)
    }

    private var canSubmit: Bool {
        !busy && !server.trimmingCharacters(in: .whitespaces).isEmpty && !user.isEmpty && !pass.isEmpty
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            SheetTitle(title: "Thêm tài khoản", subtitle: "Đăng nhập một tài khoản ChốtLive khác").padding(.top, 6)
            if AppConfig.builtInServer == nil {
                LabeledField(label: "Địa chỉ máy chủ", placeholder: "https://ten-mien-cua-ban.vn",
                             text: $server, keyboard: .URL, capitalize: false)
            }
            LabeledField(label: "Tên tài khoản", placeholder: "Tên tài khoản", text: $user, capitalize: false,
                         contentType: .username)
            PasswordField(label: "Mật khẩu", text: $pass)
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
    @EnvironmentObject var ui: AppUI
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
                        ForEach(printer.devices.filter(\.likelyPrinter)) { deviceRow($0) }
                        let others = printer.devices.filter { !$0.likelyPrinter }
                        if !others.isEmpty {
                            T("Thiết bị khác, có thể không phải máy in", 13, .medium, Theme.muted)
                            ForEach(others) { deviceRow($0) }
                        }
                        if printer.hasScanned && !printer.isScanning && !printer.devices.contains(where: \.likelyPrinter) {
                            T("Không thấy máy in? Kiểm tra máy đã bật và không nối với điện thoại khác. iPhone chỉ nối được máy có Bluetooth LE, không dùng được máy chỉ có Bluetooth Classic (SPP).",
                              13, .medium, Theme.muted)
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

    private func deviceRow(_ d: NearbyDevice) -> some View {
        Button { printer.connect(d.peripheral) } label: {
            HStack {
                T(d.name, 14, .semibold).lineLimit(1)
                Spacer()
                Icon(name: .chevronRight, size: 16, color: Theme.muted)
            }
            .frame(height: 40)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func printTest() {
        let c = LiveComment(id: "test", uniqueId: "tai_khoan_mau", userId: "123456789", nickname: "Khách thử",
                            text: "59", ts: Date(), price: 59000)
        Task { @MainActor in
            let error = await printer.sendAndWait(TicketRenderer.ticketBytes(comment: c))
            ui.notify(error ?? "Đã gửi xong tem thử. Nếu không ra giấy, kiểm tra giấy và xem đã chọn đúng máy in chưa.")
        }
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
