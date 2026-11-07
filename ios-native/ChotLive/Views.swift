import SwiftUI

// MARK: - Root

struct RootView: View {
    @EnvironmentObject var client: LiveClient
    @EnvironmentObject var store: Store

    var body: some View {
        Group {
            if client.loggedIn {
                MainShell()
            } else {
                LoginView()
            }
        }
        .alert("Thông báo", isPresented: Binding(get: { store.storageWarning != nil },
                                                 set: { if !$0 { store.storageWarning = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(store.storageWarning ?? "")
        }
        .preferredColorScheme(.light)
        .tint(Theme.orangeDeep)
        #if DEBUG
        .onAppear { Demo.prepare(store: store, client: client) }
        #endif
    }
}

struct MainShell: View {
    @EnvironmentObject var client: LiveClient
    @EnvironmentObject var store: Store
    @StateObject private var ui = AppUI()

    var body: some View {
        ZStack {
            NavigationStack(path: $ui.path) {
                TabsContainer()
                    .toolbar(.hidden, for: .navigationBar)
                    .navigationDestination(for: Route.self) { route in
                        destination(route)
                            .navigationBarBackButtonHidden(true)
                    }
            }
            SheetLayer(ui: ui)
        }
        .environmentObject(ui)
        .alert("Thông báo", isPresented: Binding(get: { ui.alert != nil }, set: { if !$0 { ui.alert = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(ui.alert ?? "")
        }
        .alert(ui.confirm?.title ?? "", isPresented: Binding(get: { ui.confirm != nil }, set: { if !$0 { ui.confirm = nil } }),
               presenting: ui.confirm) { item in
            Button("Huỷ", role: .cancel) {}
            Button(item.action, role: .destructive) { item.run() }
        } message: { item in
            Text(item.message)
        }
        .onReceive(client.$liveState.dropFirst()) { state in
            // Server mới tự ghi phiên; chỉ server bản cũ mới cần máy tự ghi.
            guard !isDemo, !client.serverSupportsSync else { return }
            store.syncLive(state: state, username: client.liveUsername)
        }
        .onAppear {
            if !isDemo && !client.serverSupportsSync && client.liveState == "connected" {
                store.syncLive(state: "connected", username: client.liveUsername)
            }
            #if DEBUG
            Demo.show(ui: ui)
            #endif
        }
    }

    private var isDemo: Bool {
        #if DEBUG
        return Demo.isActive
        #else
        return false
        #endif
    }

    @ViewBuilder
    private func destination(_ route: Route) -> some View {
        switch route {
        case .session(let id): SessionDetailView(sessionId: id)
        case .order(let id): OrderDetailView(orderId: id)
        case .orderEdit(let id): OrderEditView(orderId: id)
        case .orderCreate: OrderCreateView()
        case .orderComments(let id): OrderCommentsView(orderId: id)
        case .customer(let id): CustomerDetailView(customerId: id)
        case .addressEdit(let id): AddressEditView(customerId: id)
        case .printer: PrinterView()
        case .keywords: KeywordsView()
        case .notifications: NotificationsView()
        case .help: HelpView()
        }
    }
}

struct TabsContainer: View {
    @EnvironmentObject var ui: AppUI

    var body: some View {
        VStack(spacing: 0) {
            ZStack {
                tab(.sales) { DashboardView() }
                tab(.comments) { LiveView() }
                tab(.customers) { CustomersView() }
                tab(.orders) { OrdersView() }
                tab(.me) { SettingsView() }
            }
            TabBar(selection: $ui.tab)
        }
        .background(Theme.bg.ignoresSafeArea())
        .ignoresSafeArea(.container, edges: .bottom)
        .ignoresSafeArea(.keyboard, edges: .bottom)
    }

    private func tab<V: View>(_ t: AppTab, @ViewBuilder _ content: () -> V) -> some View {
        content()
            .opacity(ui.tab == t ? 1 : 0)
            .allowsHitTesting(ui.tab == t)
    }
}

/// Thanh tab theo mẫu: 5 cột đều, nhãn "Khách hàng" xuống dòng.
struct TabBar: View {
    @Binding var selection: AppTab

    var body: some View {
        HStack(spacing: 0) {
            ForEach(AppTab.allCases, id: \.self) { t in
                let active = selection == t
                Button { selection = t } label: {
                    VStack(spacing: 3) {
                        Icon(name: t.icon, size: 22, color: active ? Theme.accent : Theme.muted)
                        T(t.title, 11, .semibold, active ? Theme.accent : Theme.muted)
                            .multilineTextAlignment(.center)
                            .lineSpacing(0.5)
                            .fixedSize()
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 5)
        .frame(height: 75)
        .padding(.bottom, max(Metrics.safeBottom - 25, 0))
        .background(
            Color.white
                .overlay(Rectangle().fill(Theme.line).frame(height: 1), alignment: .top)
                .ignoresSafeArea(.container, edges: .bottom)
        )
    }
}

// MARK: - Đăng nhập

struct LoginView: View {
    private enum Mode { case login, register }

    @EnvironmentObject var client: LiveClient
    @State private var mode = Mode.login
    @State private var server = AppConfig.builtInServer ?? UserDefaults.standard.string(forKey: AuthStorage.serverKey) ?? ""
    @State private var user = ""
    @State private var pass = ""
    @State private var confirm = ""
    @State private var busy = false
    @State private var error: String?

    private var isRegister: Bool { mode == .register }

    private var canSubmit: Bool {
        !busy && !server.isEmpty && !user.isEmpty && !pass.isEmpty && (!isRegister || !confirm.isEmpty)
    }

    private var buttonTitle: String {
        if busy { return isRegister ? "Đang tạo tài khoản..." : "Đang đăng nhập..." }
        return isRegister ? "Tạo tài khoản" : "Đăng nhập"
    }

    var body: some View {
        GeometryReader { geo in
            ScrollView(showsIndicators: false) {
                VStack(spacing: Metrics.gap) {
                    header.padding(.bottom, 6)
                    modeSwitch
                    fields
                    if let error {
                        T(error, 13, .medium, Theme.red)
                            .multilineTextAlignment(.center)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    PrimaryButton(title: buttonTitle, enabled: canSubmit, action: submit)
                    T(isRegister ? "Mật khẩu từ \(AppConfig.minPasswordLength) ký tự trở lên."
                                 : "Quên mật khẩu? Liên hệ quản trị viên ChốtLive để được đặt lại.",
                      12, .medium, Theme.muted)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.horizontal, Metrics.gutter)
                .padding(.vertical, 24)
                .frame(maxWidth: .infinity, minHeight: geo.size.height)
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .background(Theme.bg.ignoresSafeArea())
        #if DEBUG
        .onAppear { if Demo.screen == "register" { mode = .register } }
        #endif
    }

    private var header: some View {
        VStack(spacing: 12) {
            T("CL", 26, .heavy, Theme.ink, track: -0.5)
                .frame(width: 68, height: 68)
                .background(RoundedRectangle(cornerRadius: 20, style: .continuous).fill(Theme.orange))
            VStack(spacing: 3) {
                T("ChốtLive", 28, .heavy, Theme.ink, track: -0.5)
                T(isRegister ? "Tạo tài khoản để bắt đầu chốt đơn" : "Chốt đơn TikTok Live, in tem tức thì", 14, .medium, Theme.muted)
                    .multilineTextAlignment(.center)
            }
        }
    }

    private var modeSwitch: some View {
        HStack(spacing: 4) {
            modeButton("Đăng nhập", .login)
            modeButton("Đăng ký", .register)
        }
        .padding(4)
        .background(Capsule().fill(Theme.card).overlay(Capsule().strokeBorder(Theme.line, lineWidth: 1)))
    }

    private func modeButton(_ title: String, _ target: Mode) -> some View {
        let selected = mode == target
        return Button {
            mode = target
            error = nil
            confirm = ""
        } label: {
            T(title, 14, .bold, selected ? Theme.ink : Theme.muted)
                .frame(maxWidth: .infinity)
                .frame(height: 40)
                .background(Capsule().fill(selected ? Theme.orange : Color.clear))
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
    }

    private var fields: some View {
        VStack(alignment: .leading, spacing: 14) {
            // Bản phát hành đã gắn sẵn địa chỉ server nên người dùng không phải biết tới.
            if AppConfig.builtInServer == nil {
                LabeledField(label: "Địa chỉ máy chủ", placeholder: "https://ten-mien-cua-ban.vn",
                             text: $server, keyboard: .URL, capitalize: false)
            }
            LabeledField(label: "Tên tài khoản", placeholder: "Tên tài khoản", text: $user, capitalize: false,
                         contentType: .username)
            PasswordField(label: "Mật khẩu", text: $pass, contentType: isRegister ? .newPassword : .password)
            if isRegister {
                PasswordField(label: "Nhập lại mật khẩu", text: $confirm, contentType: .newPassword)
            }
        }
        .padding(16)
        .cardStyle(24)
    }

    private func submit() {
        if isRegister {
            if pass.count < AppConfig.minPasswordLength {
                error = "Mật khẩu phải có ít nhất \(AppConfig.minPasswordLength) ký tự."
                return
            }
            if pass != confirm {
                error = "Mật khẩu nhập lại không khớp."
                return
            }
        }
        busy = true
        error = nil
        Task {
            do {
                if isRegister {
                    try await client.register(server: server, user: user, password: pass, confirmPassword: confirm)
                } else {
                    try await client.login(server: server, user: user, password: pass)
                }
            } catch {
                self.error = error.localizedDescription
            }
            busy = false
        }
    }
}

// MARK: - Doanh số

struct DashboardView: View {
    @EnvironmentObject var client: LiveClient
    @EnvironmentObject var store: Store
    @State private var days = 7

    private var cal: Calendar { Calendar.current }
    private var today: Date { Clock.now }
    private var revenueToday: Int { store.revenue(on: today) }

    private var deltaYesterday: Int? {
        guard let y = cal.date(byAdding: .day, value: -1, to: today) else { return nil }
        let prev = store.revenue(on: y)
        guard prev > 0 else { return nil }
        return Int(((Double(revenueToday) - Double(prev)) / Double(prev) * 100).rounded())
    }

    private var monthNumber: Int { cal.component(.month, from: today) }
    private var previousMonthDate: Date { cal.date(byAdding: .month, value: -1, to: today) ?? today }
    private var revenueMonth: Int { store.revenue(monthOf: today, throughDay: 31) }

    /// So với cùng số ngày của tháng trước, để giữa tháng không bị so lệch.
    private var deltaMonth: Int? {
        let prev = store.revenue(monthOf: previousMonthDate, throughDay: cal.component(.day, from: today))
        guard prev > 0 else { return nil }
        return Int(((Double(revenueMonth) - Double(prev)) / Double(prev) * 100).rounded())
    }

    private var newCustomersToday: Int { store.customers.filter(\.isNewToday).count }

    private var series: [(Date, Int)] {
        (0..<days).reversed().map { off in
            let d = cal.date(byAdding: .day, value: -off, to: today) ?? today
            return (d, store.revenue(on: d))
        }
    }

    var body: some View {
        GeometryReader { geo in
            ScrollView(showsIndicators: false) {
                VStack(spacing: Metrics.gap) {
                    PageHeader(subtitle: "\(longWeekday(today)), \(fullDate(today))", title: "Doanh số") {
                        if client.liveState == "connected" { livePill }
                    }
                    hero
                    HStack(spacing: 12) {
                        customersTile
                            .frame(width: (Metrics.screenWidth - 2 * Metrics.gutter - 12) * 0.417)
                        monthTile
                    }
                    .frame(height: 131)
                    // Thẻ biểu đồ kéo dài vừa khít tới thanh tab như trong mẫu.
                    chartCard.frame(height: max(300, geo.size.height - 372.5))
                }
                .padding(.horizontal, Metrics.gutter)
                .padding(.top, 2)
                .padding(.bottom, 2)
            }
        }
        .background(Theme.bg)
    }

    private var livePill: some View {
        HStack(spacing: 8) {
            Circle().fill(Theme.live).frame(width: 8, height: 8)
            T("Đang live", 13, .bold).lineLimit(1).fixedSize()
        }
        .padding(.horizontal, 13)
        .frame(height: 36)
        .background(Capsule().fill(Theme.card).overlay(Capsule().strokeBorder(Theme.line, lineWidth: 1)))
    }

    private var hero: some View {
        VStack(alignment: .leading, spacing: 0) {
            T("Doanh thu hôm nay", 14, .semibold)
            T(money(revenueToday), 40, .heavy, Theme.ink, track: -1.5)
                .lineLimit(1)
                .minimumScaleFactor(0.5)
                .padding(.top, 2)
            HStack(spacing: 8) {
                if let delta = deltaYesterday {
                    HStack(spacing: 4) {
                        Icon(name: delta >= 0 ? .chevronUp : .chevronDown, size: 14, weight: 2.6,
                             color: delta >= 0 ? Theme.greenBright : Theme.live)
                        T("\(delta >= 0 ? "+" : "")\(delta)%", 13, .semibold, delta >= 0 ? Theme.greenBright : Theme.live)
                    }
                    .padding(.horizontal, 9)
                    .frame(height: 23)
                    .background(Capsule().fill(Color(hex: 0x0D1015)))
                    T("so với hôm qua", 13, .semibold)
                } else {
                    T("Chưa có dữ liệu hôm qua", 13, .semibold).frame(height: 23)
                }
            }
            .padding(.top, 8)
        }
        .padding(.horizontal, 22)
        .padding(.top, 20)
        .padding(.bottom, 21)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 24, style: .continuous).fill(Theme.orange))
    }

    private var customersTile: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 9) {
                Icon(name: .users, size: 14, color: Theme.muted)
                T("Khách hôm\nnay", 13, .medium, Theme.muted).lineSpacing(0).fixedSize()
            }
            T("\(store.customersToday().count)", 30, .heavy, Theme.ink, track: -1).padding(.top, 8)
            T("\(newCustomersToday) khách mới", 12, .semibold, Theme.accent).padding(.top, 4)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 17)
        .padding(.top, 17)
        .padding(.bottom, 12)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .cardStyle(20)
    }

    private var monthTile: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 9) {
                Icon(name: .calendar, size: 16, color: Theme.muted)
                T("Doanh thu tháng \(monthNumber)", 13, .medium, Theme.muted).lineLimit(1).minimumScaleFactor(0.8)
            }
            T(money(revenueMonth), 24, .heavy, Theme.ink, track: -0.8)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
                .padding(.top, 13)
            monthDelta.padding(.top, 4)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 17)
        .padding(.top, 17)
        .padding(.bottom, 12)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .cardStyle(20)
    }

    @ViewBuilder
    private var monthDelta: some View {
        let prevMonth = cal.component(.month, from: previousMonthDate)
        if let delta = deltaMonth {
            T("\(delta >= 0 ? "+" : "")\(delta)% so với tháng \(prevMonth)", 12, .semibold, delta >= 0 ? Theme.green : Theme.red)
                .lineLimit(1).minimumScaleFactor(0.8)
        } else {
            T("Chưa có dữ liệu tháng \(prevMonth)", 12, .semibold, Theme.muted).lineLimit(1).minimumScaleFactor(0.8)
        }
    }

    private var chartCard: some View {
        VStack(spacing: 0) {
            HStack {
                T("Doanh thu theo ngày", 15, .bold).lineLimit(1).minimumScaleFactor(0.8)
                Spacer(minLength: 8)
                HStack(spacing: 0) {
                    segment("7 ngày", value: 7)
                    segment("30 ngày", value: 30)
                }
                .padding(3)
                .background(RoundedRectangle(cornerRadius: 13, style: .continuous).fill(Theme.track))
            }
            Spacer(minLength: 16)
            BarChart(data: series, labelEveryBar: days == 7).frame(height: 170)
            Spacer(minLength: 16)
        }
        .padding(.horizontal, 16)
        .padding(.top, 16)
        .frame(maxHeight: .infinity)
        .cardStyle(24)
    }

    private func segment(_ title: String, value: Int) -> some View {
        Button { days = value } label: {
            T(title, 12, days == value ? .bold : .semibold, days == value ? Theme.ink : Theme.muted)
                .lineLimit(1)
                .fixedSize()
                .padding(.horizontal, 13)
                .frame(height: 28)
                .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(days == value ? Theme.orange : Color.clear))
        }
        .buttonStyle(.plain)
    }
}

/// Biểu đồ cột: 2 vạch đứt, trục đáy, cột hôm nay màu cam kèm số tiền.
struct BarChart: View {
    let data: [(Date, Int)]
    let labelEveryBar: Bool

    private let labelArea: CGFloat = 23
    private let plotTopInset: CGFloat = 25

    var body: some View {
        GeometryReader { geo in
            let plot = geo.size.height - labelArea - plotTopInset
            let baseline = plotTopInset + plot
            let maxValue = max(data.map(\.1).max() ?? 0, 1)
            let barInset: CGFloat = data.count > 10 ? 0 : 1
            let column = (geo.size.width - 2 * barInset) / CGFloat(max(data.count, 1))
            let barWidth = data.count > 10 ? max(column - 3, 2) : min(29, column - 8)

            ZStack(alignment: .topLeading) {
                gridLine(y: plotTopInset, width: geo.size.width)
                gridLine(y: plotTopInset + plot / 2, width: geo.size.width)
                Rectangle().fill(Theme.line).frame(height: 1).offset(y: baseline)

                ForEach(Array(data.enumerated()), id: \.offset) { index, item in
                    let isToday = index == data.count - 1
                    let height = max(CGFloat(item.1) / CGFloat(maxValue) * plot * 0.95, 3)
                    let centerX = barInset + column * (CGFloat(index) + 0.5)

                    RoundedRectangle(cornerRadius: data.count > 10 ? 3 : 7, style: .continuous)
                        .fill(isToday ? Theme.orangeDeep : Theme.bar)
                        .frame(width: barWidth, height: height)
                        .position(x: centerX, y: baseline - height / 2)

                    if isToday && item.1 > 0 {
                        T(compactMoney(item.1), 12, .bold, Theme.accent)
                            .lineLimit(1)
                            .fixedSize()
                            .position(x: min(centerX, geo.size.width - 20), y: baseline - height - 12)
                    }

                    if labelEveryBar || index % 5 == 4 || isToday {
                        T(labelEveryBar ? weekdayLabel(item.0) : shortDate(item.0), labelEveryBar ? 12 : 10,
                          isToday ? .bold : .medium, isToday ? Theme.ink : Theme.muted)
                            .lineLimit(1)
                            .fixedSize()
                            .position(x: centerX, y: baseline + 16)
                    }
                }
            }
        }
    }

    private func gridLine(y: CGFloat, width: CGFloat) -> some View {
        Path { p in
            p.move(to: CGPoint(x: 0, y: y))
            p.addLine(to: CGPoint(x: width, y: y))
        }
        .stroke(Theme.line, style: StrokeStyle(lineWidth: 1, dash: [4, 4]))
    }
}

// MARK: - Khách hàng

struct CustomersView: View {
    @EnvironmentObject var store: Store
    @EnvironmentObject var ui: AppUI
    @State private var search = ""
    @State private var filter = 0 // 0 tất cả, 1 mới hôm nay, 2 mua nhiều

    private var list: [Customer] {
        var l = store.customers.sorted { $0.lastTs > $1.lastTs }
        switch filter {
        case 1: l = l.filter(\.isNewToday)
        case 2: l = l.filter(\.isBigSpender).sorted { $0.total > $1.total }
        default: break
        }
        let q = search.trimmingCharacters(in: .whitespaces).lowercased()
        if !q.isEmpty { l = l.filter { $0.nickname.lowercased().contains(q) || $0.uniqueId.lowercased().contains(q) } }
        return l
    }

    var body: some View {
        ScrollView(showsIndicators: false) {
            VStack(spacing: Metrics.gap) {
                PageHeader(subtitle: "\(store.customers.count) khách · \(store.customers.filter(\.isNewToday).count) khách mới hôm nay",
                           title: "Khách hàng") { EmptyView() }
                SearchField(text: $search)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        Chip(title: "Tất cả", selected: filter == 0) { filter = 0 }
                        Chip(title: "Mới hôm nay", selected: filter == 1) { filter = 1 }
                        Chip(title: "Mua nhiều", selected: filter == 2) { filter = 2 }
                    }
                    .padding(.horizontal, Metrics.gutter)
                }
                .padding(.horizontal, -Metrics.gutter)

                if list.isEmpty {
                    T("Chưa có khách. Bấm nút in trên một bình luận để lưu khách.", 13, .medium, Theme.muted)
                        .multilineTextAlignment(.center)
                        .padding(.top, 30)
                }
                LazyVStack(spacing: 8.5) {
                    ForEach(list) { c in
                        Button { ui.push(.customer(c.id)) } label: { row(c) }.buttonStyle(.plain)
                    }
                }
            }
            .padding(.horizontal, Metrics.gutter)
            .padding(.top, 2)
            .padding(.bottom, 16)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Theme.bg)
    }

    private func row(_ c: Customer) -> some View {
        HStack(spacing: 12) {
            Avatar(text: c.initials, seed: c.id)
            // Hai dòng tách riêng: dòng @tài khoản được chạy dài xuống dưới cột tiền như trong mẫu.
            VStack(spacing: 4) {
                HStack(spacing: 0) {
                    T(c.nickname, 15, .bold).lineLimit(1).minimumScaleFactor(0.85).offset(y: 1)
                    if c.isBigSpender {
                        Badge(text: "Mua nhiều").padding(.leading, 7)
                    } else if c.isNewToday {
                        Badge(text: "Mới", color: Theme.green, fill: Theme.greenSoft).padding(.leading, 7)
                    }
                    Spacer(minLength: 2)
                    T(money(c.total), 14, .heavy).lineLimit(1).fixedSize()
                }
                HStack(spacing: 6) {
                    T("@\(c.uniqueId) · \(relativeDay(c.lastTs))", 12, .medium, Theme.muted).lineLimit(1)
                    Spacer(minLength: 0)
                    T("\(store.orders(of: c).count) đơn", 12, .medium, Theme.muted).lineLimit(1).fixedSize()
                }
            }
        }
        .padding(.horizontal, 15)
        .frame(height: 69)
        .cardStyle(18)
        .contentShape(Rectangle())
    }
}

struct CustomerDetailView: View {
    let customerId: String
    @EnvironmentObject var store: Store
    @EnvironmentObject var ui: AppUI

    var body: some View {
        SubPage(title: "Hồ sơ khách hàng") {
            if let c = store.customers.first(where: { $0.id == customerId }) {
                let orders = store.orders(of: c)
                ScrollView(showsIndicators: false) {
                    VStack(spacing: Metrics.gap) {
                        profileCard(c, orderCount: orders.count)
                        addressCard(c)
                        historyCard(orders)
                    }
                    .padding(.horizontal, Metrics.gutter)
                    .padding(.bottom, 16)
                }
            } else {
                Spacer()
                T("Khách không còn tồn tại", 14, .medium, Theme.muted)
                Spacer()
            }
        }
    }

    private func profileCard(_ c: Customer, orderCount: Int) -> some View {
        VStack(spacing: 13) {
            HStack(spacing: 13) {
                Avatar(text: c.initials, size: 56, fontSize: 19, seed: c.id)
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 10) {
                        T(c.nickname, 18, .bold).lineLimit(1).minimumScaleFactor(0.8)
                        if c.isBigSpender { Badge(text: "Mua nhiều") }
                    }
                    T("@" + c.uniqueId, 13, .medium, Theme.muted).lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            HairLine()
            HStack(spacing: 0) {
                summary(money(c.total), "Tổng chi tiêu")
                Rectangle().fill(Theme.line).frame(width: 1, height: 36)
                summary("\(orderCount)", "Số đơn")
                Rectangle().fill(Theme.line).frame(width: 1, height: 36)
                summary(shortDate(c.lastTs), "Mua gần nhất")
            }
        }
        .padding(.horizontal, 17)
        .padding(.top, 18)
        .padding(.bottom, 17)
        .cardStyle(20)
    }

    private func summary(_ value: String, _ label: String) -> some View {
        VStack(spacing: 2) {
            T(value, 16, .heavy, Theme.ink, track: -0.3).lineLimit(1).minimumScaleFactor(0.7)
            T(label, 11, .medium, Theme.muted).lineLimit(1)
        }
        .frame(maxWidth: .infinity)
    }

    private func addressCard(_ c: Customer) -> some View {
        let a = c.address ?? DeliveryAddress()
        return VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 9) {
                Icon(name: .pin, size: 17, color: Theme.accent)
                T("Địa chỉ nhận hàng", 15, .bold).lineLimit(1)
                Spacer(minLength: 4)
                Button { ui.push(.addressEdit(c.id)) } label: {
                    HStack(spacing: 6) {
                        Icon(name: .pencil, size: 13, weight: 2.3)
                        T("Sửa", 13, .bold)
                    }
                    .padding(.horizontal, 15)
                    .frame(height: 35)
                    .background(Capsule().fill(Theme.field))
                }
                .buttonStyle(.plain)
            }
            .padding(.bottom, 7)
            addressRow("Người nhận", a.receiver.isEmpty ? c.nickname : a.receiver)
            HairLine()
            addressRow("Số điện thoại", a.phone)
            HairLine()
            addressRow("Địa chỉ", a.street)
            HairLine()
            addressRow("Phường / Quận\n/ Tỉnh", a.region)
            HairLine()
            addressRow("Ghi chú giao", a.note)
        }
        .padding(.horizontal, 17)
        .padding(.top, 15)
        .padding(.bottom, 7)
        .cardStyle(20)
    }

    private func addressRow(_ label: String, _ value: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            T(label, 13, .medium, Theme.muted).frame(width: 100, alignment: .leading)
            T(value.isEmpty ? "Chưa có" : value, 14, .semibold, value.isEmpty ? Theme.faint : Theme.ink)
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.vertical, 10)
    }

    private func historyCard(_ orders: [Order]) -> some View {
        VStack(spacing: 0) {
            HStack {
                T("Lịch sử mua hàng", 15, .bold)
                Spacer()
                T("\(orders.count) đơn", 12, .medium, Theme.muted)
            }
            .padding(.bottom, 5)
            ForEach(Array(orders.enumerated()), id: \.element.id) { index, o in
                if index > 0 { HairLine() }
                Button { ui.push(.order(o.id)) } label: { historyRow(o) }.buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 17)
        .padding(.top, 15)
        .padding(.bottom, 8)
        .cardStyle(20)
    }

    private func historyRow(_ o: Order) -> some View {
        HStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 2) {
                T(shortDate(o.lastTs), 15, .heavy, Theme.ink, track: -0.4)
                T(timeText(o.lastTs), 11, .medium, Theme.muted)
            }
            .frame(width: 64, alignment: .leading)
            T("\(o.productCount) sản phẩm", 13, .medium, Theme.muted).lineLimit(1)
            Spacer(minLength: 4)
            VStack(alignment: .trailing, spacing: 3) {
                T(money(o.total), 14, .heavy).lineLimit(1).fixedSize()
                StatusBadge(status: o.status)
            }
        }
        .padding(.vertical, 8)
        .contentShape(Rectangle())
    }
}
