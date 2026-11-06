import CoreBluetooth
import SwiftUI

// MARK: - Giao diện chung

enum Theme {
    static let orange = Color(red: 1.0, green: 0.54, blue: 0.24)
    static let orangeDeep = Color(red: 0.93, green: 0.40, blue: 0.10)
    static let orangeSoft = Color(red: 1.0, green: 0.54, blue: 0.24).opacity(0.16)
    static let card = Color(.secondarySystemGroupedBackground)
    static let bg = Color(.systemGroupedBackground)
}

struct Avatar: View {
    let text: String
    var size: CGFloat = 42
    var highlighted = false

    var body: some View {
        Text(text)
            .font(.system(size: size * 0.36, weight: .bold))
            .foregroundColor(highlighted ? Theme.orangeDeep : .secondary)
            .frame(width: size, height: size)
            .background(Circle().fill(highlighted ? Theme.orangeSoft : Color(.tertiarySystemFill)))
    }
}

struct Badge: View {
    let text: String
    var color: Color = Theme.orangeDeep

    var body: some View {
        Text(text)
            .font(.system(size: 10, weight: .semibold))
            .foregroundColor(color)
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(Capsule().fill(color.opacity(0.14)))
    }
}

struct Card<Content: View>: View {
    @ViewBuilder var content: () -> Content
    var body: some View {
        content()
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(Theme.card))
    }
}

struct Chip: View {
    let title: String
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.footnote.weight(.semibold))
                .padding(.horizontal, 14).padding(.vertical, 7)
                .foregroundColor(selected ? .white : .primary)
                .background(Capsule().fill(selected ? Theme.orange : Color(.tertiarySystemFill)))
        }
        .buttonStyle(.plain)
    }
}

struct SearchField: View {
    @Binding var text: String
    var placeholder = "Tìm tên hoặc @tiktok"

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").foregroundColor(.secondary)
            TextField(placeholder, text: $text)
                .textInputAutocapitalization(.never).autocorrectionDisabled()
            if !text.isEmpty {
                Button { text = "" } label: { Image(systemName: "xmark.circle.fill").foregroundColor(.secondary) }
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Theme.card))
    }
}

private func weekdayLabel(_ d: Date) -> String {
    let w = Calendar.current.component(.weekday, from: d) // 1 = CN
    return w == 1 ? "CN" : "T\(w)"
}

private func shortDate(_ d: Date) -> String {
    let c = Calendar.current.dateComponents([.day, .month], from: d)
    return "\(c.day ?? 0)/\(c.month ?? 0)"
}

private func fullDateLabel(_ d: Date) -> String {
    "\(weekdayLabel(d) == "CN" ? "Chủ nhật" : "Thứ " + String(weekdayLabel(d).dropFirst())), \(shortDate(d))"
}

private func timeText(_ d: Date) -> String {
    let c = Calendar.current.dateComponents([.hour, .minute], from: d)
    return String(format: "%02d:%02d", c.hour ?? 0, c.minute ?? 0)
}

private func relativeDay(_ d: Date) -> String {
    let cal = Calendar.current
    if cal.isDateInToday(d) { return "\(timeText(d)) nay" }
    if cal.isDateInYesterday(d) { return "\(timeText(d)) hôm qua" }
    return "\(weekdayLabel(d)) \(shortDate(d))"
}

private func compactMoney(_ n: Int) -> String {
    if n >= 1_000_000 { return String(format: "%.2ftr", Double(n) / 1_000_000).replacingOccurrences(of: ".", with: ",") }
    if n >= 1_000 { return "\(n / 1_000)k" }
    return "\(n)"
}

private struct InfoAlert: ViewModifier {
    @Binding var message: String?
    func body(content: Content) -> some View {
        content.alert("Thông báo", isPresented: Binding(get: { message != nil }, set: { if !$0 { message = nil } })) {
            Button("OK", role: .cancel) {}
        } message: { Text(message ?? "") }
    }
}

extension View {
    fileprivate func infoAlert(_ message: Binding<String?>) -> some View { modifier(InfoAlert(message: message)) }
}

// MARK: - Root

struct RootView: View {
    @EnvironmentObject var client: LiveClient

    var body: some View {
        Group {
            if client.loggedIn {
                TabView {
                    DashboardView().tabItem { Label("Doanh số", systemImage: "chart.bar.fill") }
                    LiveView().tabItem { Label("Bình luận", systemImage: "bubble.left.fill") }
                    CustomersView().tabItem { Label("Khách hàng", systemImage: "person.2.fill") }
                    OrdersView().tabItem { Label("Đơn hàng", systemImage: "bag.fill") }
                    SettingsView().tabItem { Label("Tôi", systemImage: "person.crop.circle.fill") }
                }
            } else {
                LoginView()
            }
        }
        .tint(Theme.orange)
    }
}

// MARK: - Đăng nhập

struct LoginView: View {
    @EnvironmentObject var client: LiveClient
    @State private var server = UserDefaults.standard.string(forKey: "serverURL") ?? ""
    @State private var user = ""
    @State private var pass = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Server ChốtLive") {
                    TextField("https://ten-server.onrender.com", text: $server)
                        .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                }
                Section("Tài khoản") {
                    TextField("Tên tài khoản", text: $user).textInputAutocapitalization(.never).autocorrectionDisabled()
                    SecureField("Mật khẩu", text: $pass)
                }
                if let error { Text(error).foregroundColor(.red).font(.footnote) }
                Button {
                    busy = true; error = nil
                    Task {
                        do { try await client.login(server: server, user: user, password: pass) }
                        catch { self.error = error.localizedDescription }
                        busy = false
                    }
                } label: {
                    HStack { Spacer(); if busy { ProgressView() } else { Text("Đăng nhập").bold().foregroundColor(.white) }; Spacer() }
                }
                .listRowBackground(Theme.orange)
                .disabled(busy || server.isEmpty || user.isEmpty || pass.isEmpty)
            }
            .navigationTitle("ChốtLive")
        }
    }
}

// MARK: - Doanh số

struct DashboardView: View {
    @EnvironmentObject var client: LiveClient
    @EnvironmentObject var store: Store
    @State private var days = 7

    private var today: Date { Date() }
    private var cal: Calendar { Calendar.current }

    private var revenueToday: Int { store.revenue(on: today) }
    private var revenueYesterday: Int { store.revenue(on: cal.date(byAdding: .day, value: -1, to: today) ?? today) }

    private var revenueMonth: Int {
        store.orders().filter { cal.isDate($0.day, equalTo: today, toGranularity: .month) }.reduce(0) { $0 + $1.total }
    }

    private var newCustomersToday: Int {
        store.customers.filter { c in
            guard let first = c.items.map(\.ts).min() else { return false }
            return cal.isDateInToday(first)
        }.count
    }

    private var series: [(Date, Int)] {
        (0..<days).reversed().map { off in
            let d = cal.date(byAdding: .day, value: -off, to: today) ?? today
            return (d, store.revenue(on: d))
        }
    }

    private var delta: String? {
        guard revenueYesterday > 0 else { return nil }
        let p = (Double(revenueToday) - Double(revenueYesterday)) / Double(revenueYesterday) * 100
        return String(format: "%@%.0f%%", p >= 0 ? "+" : "", p)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 12) {
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(fullDateLabel(today)).font(.footnote).foregroundColor(.secondary)
                            Text("Doanh số").font(.largeTitle.bold())
                        }
                        Spacer()
                        if client.liveState == "connected" {
                            HStack(spacing: 6) {
                                Circle().fill(.red).frame(width: 8, height: 8)
                                Text("Đang live").font(.footnote.weight(.semibold))
                            }
                            .padding(.horizontal, 12).padding(.vertical, 7)
                            .background(Capsule().fill(Theme.card))
                        }
                    }

                    // Doanh thu hôm nay
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Doanh thu hôm nay").font(.subheadline.weight(.semibold))
                        Text(vnd(revenueToday)).font(.system(size: 38, weight: .heavy))
                        HStack(spacing: 8) {
                            if let delta {
                                Text(delta).font(.caption.bold())
                                    .padding(.horizontal, 8).padding(.vertical, 3)
                                    .background(Capsule().fill(Color.black.opacity(0.28)))
                                Text("so với hôm qua").font(.footnote)
                            } else {
                                Text("Chưa có dữ liệu hôm qua").font(.footnote)
                            }
                        }
                    }
                    .foregroundColor(.white)
                    .padding(18)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 22, style: .continuous).fill(Theme.orange))

                    HStack(spacing: 12) {
                        Card {
                            VStack(alignment: .leading, spacing: 6) {
                                Text("Khách hôm nay").font(.footnote).foregroundColor(.secondary)
                                Text("\(store.customersToday().count)").font(.system(size: 30, weight: .bold))
                                Text("\(newCustomersToday) khách mới").font(.caption).foregroundColor(Theme.orangeDeep)
                            }
                        }
                        Card {
                            VStack(alignment: .leading, spacing: 6) {
                                Text("Doanh thu tháng \(cal.component(.month, from: today))")
                                    .font(.footnote).foregroundColor(.secondary)
                                Text(vnd(revenueMonth)).font(.system(size: 20, weight: .bold)).minimumScaleFactor(0.6).lineLimit(1)
                                Text("\(store.orders().filter { cal.isDate($0.day, equalTo: today, toGranularity: .month) }.count) đơn")
                                    .font(.caption).foregroundColor(.secondary)
                            }
                        }
                    }

                    Card {
                        VStack(alignment: .leading, spacing: 14) {
                            HStack {
                                Text("Doanh thu theo ngày").font(.headline)
                                Spacer()
                                Picker("", selection: $days) {
                                    Text("7 ngày").tag(7)
                                    Text("30 ngày").tag(30)
                                }
                                .pickerStyle(.segmented).frame(width: 150)
                            }
                            BarChart(data: series, showAllLabels: days == 7)
                                .frame(height: 190)
                        }
                    }
                }
                .padding(.horizontal, 16).padding(.bottom, 16)
            }
            .background(Theme.bg)
            .toolbar(.hidden, for: .navigationBar)
        }
    }
}

struct BarChart: View {
    let data: [(Date, Int)]
    let showAllLabels: Bool

    var body: some View {
        let maxV = max(data.map(\.1).max() ?? 0, 1)
        GeometryReader { geo in
            let spacing: CGFloat = data.count > 10 ? 3 : 8
            let barW = max((geo.size.width - spacing * CGFloat(data.count - 1)) / CGFloat(max(data.count, 1)), 2)
            let chartH = geo.size.height - 22
            HStack(alignment: .bottom, spacing: spacing) {
                ForEach(Array(data.enumerated()), id: \.offset) { idx, item in
                    let isToday = idx == data.count - 1
                    VStack(spacing: 4) {
                        Spacer(minLength: 0)
                        if isToday && item.1 > 0 {
                            Text(compactMoney(item.1)).font(.system(size: 10, weight: .bold)).foregroundColor(Theme.orangeDeep)
                                .fixedSize()
                        }
                        RoundedRectangle(cornerRadius: 5)
                            .fill(isToday ? Theme.orangeDeep : Color(.tertiarySystemFill))
                            .frame(width: barW, height: max(CGFloat(item.1) / CGFloat(maxV) * (chartH - 16), 3))
                        Text(showAllLabels ? weekdayLabel(item.0) : (idx % 5 == 0 || isToday ? shortDate(item.0) : ""))
                            .font(.system(size: 10)).foregroundColor(.secondary)
                            .fixedSize().frame(width: barW, height: 14)
                    }
                    .frame(width: barW)
                }
            }
        }
    }
}

// MARK: - Bình luận (Live)

struct LiveView: View {
    @EnvironmentObject var client: LiveClient
    @EnvironmentObject var store: Store
    @EnvironmentObject var printer: PrinterManager
    @State private var tiktok = UserDefaults.standard.string(forKey: "tiktokName") ?? ""
    @State private var onlyPriced = true
    @State private var alert: String?

    private var shown: [LiveComment] { onlyPriced ? store.comments.filter { $0.price > 0 } : store.comments }
    private var isLive: Bool { client.liveState == "connected" || client.liveState == "connecting" }

    private var statusText: String {
        switch client.liveState {
        case "connected": return "Đang đọc live @\(client.liveUsername) · \(client.viewers) người xem"
        case "connecting": return "Đang kết nối..."
        case "error", "ended", "disconnected": return client.liveMessage.isEmpty ? "Đã ngắt" : client.liveMessage
        default: return client.socketConnected ? "Chưa kết nối live" : "Đang nối server..."
        }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 12) {
                    HStack(spacing: 8) {
                        Image(systemName: "at").foregroundColor(.secondary)
                        TextField("tên TikTok đang live", text: $tiktok)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                        if isLive {
                            Button("Dừng") { client.disconnectLive() }
                                .font(.subheadline.weight(.bold)).foregroundColor(.red)
                                .padding(.horizontal, 14).padding(.vertical, 8)
                                .background(Capsule().fill(Color.red.opacity(0.15)))
                        } else {
                            Button("Kết nối") { client.connectLive(tiktok: tiktok) }
                                .font(.subheadline.weight(.bold)).foregroundColor(.white)
                                .padding(.horizontal, 14).padding(.vertical, 8)
                                .background(Capsule().fill(Theme.orange))
                                .disabled(tiktok.trimmingCharacters(in: .whitespaces).isEmpty)
                        }
                    }
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Theme.card))

                    HStack(spacing: 8) {
                        Circle().fill(client.liveState == "connected" ? Color.green : Color.gray).frame(width: 8, height: 8)
                        Text(statusText).font(.footnote).foregroundColor(.secondary).lineLimit(2)
                        Spacer()
                    }

                    Card {
                        HStack(spacing: 0) {
                            stat("\(store.comments.count)", "bình luận")
                            Divider().frame(height: 28)
                            stat("\(store.comments.filter { $0.price > 0 }.count)", "có giá")
                            Divider().frame(height: 28)
                            stat("\(store.orders(on: Date()).count)", "đơn hôm nay")
                        }
                    }

                    Toggle("Chỉ hiện bình luận có giá", isOn: $onlyPriced)
                        .font(.subheadline).tint(Theme.orange).padding(.horizontal, 4)

                    if shown.isEmpty {
                        Text(isLive ? "Đang chờ bình luận..." : "Kết nối live để bắt đầu đọc bình luận.")
                            .font(.footnote).foregroundColor(.secondary).padding(.top, 30)
                    }

                    LazyVStack(spacing: 8) {
                        ForEach(shown) { c in
                            CommentRow(c: c) { alert = printComment(c, store: store, printer: printer) }
                        }
                    }
                }
                .padding(.horizontal, 16).padding(.bottom, 16)
            }
            .background(Theme.bg)
            .navigationTitle("Bình luận")
            .infoAlert($alert)
        }
    }

    private func stat(_ value: String, _ label: String) -> some View {
        VStack(spacing: 2) {
            Text(value).font(.title3.bold())
            Text(label).font(.caption).foregroundColor(.secondary)
        }.frame(maxWidth: .infinity)
    }
}

struct CommentRow: View {
    let c: LiveComment
    let onPrint: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Avatar(text: String(c.nickname.prefix(1)).uppercased(), size: 36, highlighted: c.price > 0)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(c.nickname).font(.subheadline.weight(.bold)).lineLimit(1)
                    Text(timeText(c.ts)).font(.caption2).foregroundColor(.secondary)
                }
                Text("@" + c.uniqueId).font(.caption).foregroundColor(.secondary).lineLimit(1)
                Text(c.text).font(.body)
            }
            Spacer(minLength: 4)
            if c.price > 0 {
                VStack(alignment: .trailing, spacing: 6) {
                    Text(vnd(c.price)).font(.subheadline.weight(.bold)).foregroundColor(Theme.orangeDeep)
                    Button(c.printed ? "Đã chốt" : "Chốt & in") { onPrint() }
                        .font(.footnote.weight(.bold))
                        .foregroundColor(c.printed ? .secondary : .white)
                        .padding(.horizontal, 12).padding(.vertical, 6)
                        .background(Capsule().fill(c.printed ? Color(.tertiarySystemFill) : Theme.orange))
                }
            }
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Theme.card))
    }
}

// MARK: - Khách hàng

struct CustomersView: View {
    @EnvironmentObject var store: Store
    @State private var search = ""
    @State private var filter = 0 // 0 tất cả, 1 mới hôm nay, 2 mua nhiều
    private let bigSpender = 1_000_000

    private func isNewToday(_ c: Customer) -> Bool {
        guard let first = c.items.map(\.ts).min() else { return false }
        return Calendar.current.isDateInToday(first)
    }

    private var list: [Customer] {
        var l = store.customers.sorted { $0.lastTs > $1.lastTs }
        switch filter {
        case 1: l = l.filter(isNewToday)
        case 2: l = l.filter { $0.total >= bigSpender }.sorted { $0.total > $1.total }
        default: break
        }
        let q = search.trimmingCharacters(in: .whitespaces).lowercased()
        if !q.isEmpty { l = l.filter { $0.nickname.lowercased().contains(q) || $0.uniqueId.lowercased().contains(q) } }
        return l
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 12) {
                    SearchField(text: $search)
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            Chip(title: "Tất cả", selected: filter == 0) { filter = 0 }
                            Chip(title: "Mới hôm nay", selected: filter == 1) { filter = 1 }
                            Chip(title: "Mua nhiều", selected: filter == 2) { filter = 2 }
                        }
                    }
                    if list.isEmpty {
                        Text("Chưa có khách. Bấm “Chốt & in” trên một bình luận để lưu khách.")
                            .font(.footnote).foregroundColor(.secondary).multilineTextAlignment(.center).padding(.top, 30)
                    }
                    LazyVStack(spacing: 8) {
                        ForEach(list) { c in
                            NavigationLink(value: c.id) { row(c) }.buttonStyle(.plain)
                        }
                    }
                }
                .padding(.horizontal, 16).padding(.bottom, 16)
            }
            .background(Theme.bg)
            .navigationTitle("Khách hàng")
            .navigationBarTitleDisplayMode(.large)
            .navigationDestination(for: String.self) { id in CustomerDetail(customerId: id) }
        }
    }

    private func row(_ c: Customer) -> some View {
        HStack(spacing: 12) {
            Avatar(text: c.initials, highlighted: c.total >= bigSpender)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(c.nickname).font(.subheadline.weight(.bold)).lineLimit(1)
                    if c.total >= bigSpender { Badge(text: "Mua nhiều") }
                    else if isNewToday(c) { Badge(text: "Mới", color: .green) }
                }
                Text("@\(c.uniqueId) · \(relativeDay(c.lastTs))")
                    .font(.caption).foregroundColor(.secondary).lineLimit(1)
            }
            Spacer(minLength: 4)
            VStack(alignment: .trailing, spacing: 2) {
                Text(vnd(c.total)).font(.subheadline.weight(.bold))
                Text("\(c.items.count) đơn").font(.caption).foregroundColor(.secondary)
            }
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Theme.card))
    }
}

struct CustomerDetail: View {
    let customerId: String
    @EnvironmentObject var store: Store
    @EnvironmentObject var printer: PrinterManager
    @State private var alert: String?

    var body: some View {
        if let cust = store.customers.first(where: { $0.id == customerId }) {
            let items = cust.items.sorted { $0.ts > $1.ts }
            ScrollView {
                VStack(spacing: 12) {
                    Card {
                        VStack(spacing: 14) {
                            HStack(spacing: 12) {
                                Avatar(text: cust.initials, size: 52, highlighted: true)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(cust.nickname).font(.headline)
                                    Text("@" + cust.uniqueId).font(.subheadline).foregroundColor(.secondary)
                                    if !cust.userId.isEmpty {
                                        Text("Mã số: " + cust.userId).font(.caption).foregroundColor(.secondary)
                                    }
                                }
                                Spacer()
                            }
                            Divider()
                            HStack {
                                summary(vnd(cust.total), "Tổng chi tiêu")
                                summary("\(cust.items.count)", "Số đơn")
                                summary(shortDate(cust.lastTs), "Mua gần nhất")
                            }
                        }
                    }

                    Card {
                        VStack(alignment: .leading, spacing: 10) {
                            Text("Lịch sử mua hàng").font(.headline)
                            ForEach(items) { it in
                                HStack {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(it.comment).font(.subheadline.weight(.semibold))
                                        Text(relativeDay(it.ts)).font(.caption).foregroundColor(.secondary)
                                    }
                                    Spacer()
                                    VStack(alignment: .trailing, spacing: 3) {
                                        Text(vnd(it.price)).font(.subheadline.weight(.bold))
                                        Badge(text: it.delivered ? "Đã giao" : (it.printed ? "Đã in" : "Đơn mới"),
                                              color: it.delivered ? .green : (it.printed ? .gray : Theme.orangeDeep))
                                    }
                                    Menu {
                                        Button("In lại tem") {
                                            let c = LiveComment(id: it.id, uniqueId: cust.uniqueId, userId: cust.userId,
                                                                nickname: cust.nickname, text: it.comment, ts: it.ts, price: it.price)
                                            alert = printComment(c, store: store, printer: printer)
                                        }
                                        Button("Xoá", role: .destructive) { store.deleteItem(customerId: cust.id, itemId: it.id) }
                                    } label: { Image(systemName: "ellipsis.circle").foregroundColor(.secondary) }
                                }
                                if it.id != items.last?.id { Divider() }
                            }
                        }
                    }
                }
                .padding(.horizontal, 16).padding(.bottom, 16)
            }
            .background(Theme.bg)
            .navigationTitle("Hồ sơ khách hàng")
            .navigationBarTitleDisplayMode(.inline)
            .infoAlert($alert)
        } else {
            Text("Khách không còn tồn tại")
        }
    }

    private func summary(_ value: String, _ label: String) -> some View {
        VStack(spacing: 2) {
            Text(value).font(.subheadline.weight(.bold)).minimumScaleFactor(0.7).lineLimit(1)
            Text(label).font(.caption2).foregroundColor(.secondary)
        }.frame(maxWidth: .infinity)
    }
}

// MARK: - Đơn hàng

struct OrdersView: View {
    @EnvironmentObject var store: Store
    @EnvironmentObject var printer: PrinterManager
    @State private var search = ""
    @State private var filter = 0 // 0 tất cả, 1 mới, 2 đã in, 3 đang giao
    @State private var alert: String?

    private var allToday: [Order] { store.orders(on: Date()) }

    private var list: [Order] {
        var l = allToday
        switch filter {
        case 1: l = l.filter { !$0.isPrinted }
        case 2: l = l.filter { $0.isPrinted && !$0.isDelivered }
        case 3: l = l.filter { $0.isDelivered }
        default: break
        }
        let q = search.trimmingCharacters(in: .whitespaces).lowercased()
        if !q.isEmpty {
            l = l.filter { $0.customer.nickname.lowercased().contains(q) || $0.customer.uniqueId.lowercased().contains(q) }
        }
        return l
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 12) {
                    Text("\(allToday.count) đơn hôm nay · \(fullDateLabel(Date()))")
                        .font(.footnote).foregroundColor(.secondary).frame(maxWidth: .infinity, alignment: .leading)
                    SearchField(text: $search)
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            Chip(title: "Tất cả · \(allToday.count)", selected: filter == 0) { filter = 0 }
                            Chip(title: "Đơn mới · \(allToday.filter { !$0.isPrinted }.count)", selected: filter == 1) { filter = 1 }
                            Chip(title: "Đã in · \(allToday.filter { $0.isPrinted && !$0.isDelivered }.count)", selected: filter == 2) { filter = 2 }
                            Chip(title: "Đã giao · \(allToday.filter { $0.isDelivered }.count)", selected: filter == 3) { filter = 3 }
                        }
                    }
                    if list.isEmpty {
                        Text("Chưa có đơn nào. Bấm “Chốt & in” trên một bình luận để tạo đơn.")
                            .font(.footnote).foregroundColor(.secondary).multilineTextAlignment(.center).padding(.top, 30)
                    }
                    LazyVStack(spacing: 10) {
                        ForEach(list) { o in card(o) }
                    }
                }
                .padding(.horizontal, 16).padding(.bottom, 16)
            }
            .background(Theme.bg)
            .navigationTitle("Đơn hàng")
            .infoAlert($alert)
        }
    }

    private func card(_ o: Order) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                Avatar(text: o.customer.initials, size: 40, highlighted: true)
                VStack(alignment: .leading, spacing: 3) {
                    Text(o.customer.nickname).font(.subheadline.weight(.bold)).lineLimit(1)
                    Text("@\(o.customer.uniqueId) · \(o.items.count) sản phẩm · \(timeText(o.lastTs))")
                        .font(.caption).foregroundColor(.secondary).lineLimit(1)
                }
                Spacer(minLength: 4)
                VStack(alignment: .trailing, spacing: 3) {
                    Text(vnd(o.total)).font(.subheadline.weight(.bold))
                    Badge(text: o.isDelivered ? "Đã giao" : (o.isPrinted ? "Đã in" : "Đơn mới"),
                          color: o.isDelivered ? .green : (o.isPrinted ? .gray : Theme.orangeDeep))
                }
            }
            VStack(alignment: .leading, spacing: 4) {
                ForEach(o.items) { it in
                    HStack {
                        Text("Mã \(it.comment)").font(.footnote).foregroundColor(.secondary)
                        Spacer()
                        Text(vnd(it.price)).font(.footnote).foregroundColor(.secondary)
                    }
                }
            }
            HStack(spacing: 8) {
                Button { printOrder(o) } label: {
                    Label("In đơn", systemImage: "printer").font(.subheadline.weight(.bold))
                        .frame(maxWidth: .infinity).padding(.vertical, 10)
                        .foregroundColor(o.isPrinted ? .primary : .white)
                        .background(Capsule().fill(o.isPrinted ? Color(.tertiarySystemFill) : Theme.orange))
                }
                Button { store.setDelivered(!o.isDelivered, itemIds: o.items.map(\.id)) } label: {
                    Label(o.isDelivered ? "Đã giao" : "Giao hàng", systemImage: "shippingbox")
                        .font(.subheadline.weight(.bold))
                        .frame(maxWidth: .infinity).padding(.vertical, 10)
                        .foregroundColor(o.isDelivered ? .green : .primary)
                        .background(Capsule().fill(Color(.tertiarySystemFill)))
                }
            }
            .buttonStyle(.plain)
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(Theme.card))
    }

    private func printOrder(_ o: Order) {
        var msg: String?
        for it in o.items {
            let c = LiveComment(id: it.id, uniqueId: o.customer.uniqueId, userId: o.customer.userId,
                                nickname: o.customer.nickname, text: it.comment, ts: it.ts, price: it.price)
            msg = printComment(c, store: store, printer: printer) ?? msg
        }
        alert = msg
    }
}

// MARK: - Máy in

struct PrinterView: View {
    @EnvironmentObject var printer: PrinterManager
    @AppStorage("paperWidth") private var paperWidth = 576
    @AppStorage("shopName") private var shopName = "ChốtLive"

    var body: some View {
        Form {
            Section("Trạng thái") {
                Text(printer.statusText)
                if let n = printer.connectedName {
                    Text("Đang dùng: \(n)").foregroundColor(.green)
                    Button("In thử") { printTest() }
                    Button("Ngắt kết nối", role: .destructive) { printer.disconnect() }
                }
            }
            Section("Máy in Bluetooth gần đây") {
                Button(printer.isScanning ? "Đang tìm..." : "Tìm máy in") { printer.startScan() }
                    .disabled(printer.isScanning)
                ForEach(printer.devices, id: \.identifier) { p in
                    Button(p.name ?? p.identifier.uuidString) { printer.connect(p) }
                }
            }
            Section("Tem") {
                Picker("Khổ giấy", selection: $paperWidth) {
                    Text("80mm").tag(576)
                    Text("58mm").tag(384)
                }.pickerStyle(.segmented)
                TextField("Tên shop trên tem", text: $shopName)
            }
        }
        .navigationTitle("Máy in")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func printTest() {
        let c = LiveComment(id: "test", uniqueId: "tai_khoan_mau", userId: "123456789", nickname: "Khách thử",
                            text: "59", ts: Date(), price: 59000)
        printer.send(TicketRenderer.ticketBytes(comment: c))
    }
}

// MARK: - Tôi

struct SettingsView: View {
    @EnvironmentObject var client: LiveClient
    @EnvironmentObject var printer: PrinterManager

    private var version: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0"
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 14) {
                    section("Tài khoản") {
                        HStack(spacing: 12) {
                            Avatar(text: String(client.username.prefix(2)).uppercased(), size: 44, highlighted: true)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(client.username).font(.subheadline.weight(.bold))
                                Text(client.baseURL).font(.caption).foregroundColor(.secondary).lineLimit(1)
                            }
                            Spacer()
                            Text(client.socketConnected ? "Đã nối server" : "Mất kết nối")
                                .font(.caption.weight(.semibold))
                                .foregroundColor(client.socketConnected ? .green : .orange)
                        }
                    }

                    section("Cài đặt") {
                        NavigationLink { PrinterView() } label: {
                            HStack(spacing: 12) {
                                Image(systemName: "printer.fill").foregroundColor(Theme.orangeDeep)
                                    .frame(width: 34, height: 34).background(Circle().fill(Theme.orangeSoft))
                                Text("Máy in").font(.subheadline.weight(.semibold)).foregroundColor(.primary)
                                Spacer()
                                Text(printer.isConnected ? "Đã kết nối" : "Chưa kết nối")
                                    .font(.caption.weight(.semibold))
                                    .foregroundColor(printer.isConnected ? .green : .secondary)
                                Image(systemName: "chevron.right").font(.caption).foregroundColor(.secondary)
                            }
                        }
                    }

                    Button { client.logout() } label: {
                        Label("Đăng xuất", systemImage: "rectangle.portrait.and.arrow.right")
                            .font(.subheadline.weight(.bold)).foregroundColor(.red)
                            .frame(maxWidth: .infinity).padding(.vertical, 14)
                            .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Theme.card))
                    }

                    Text("Phiên bản \(version)").font(.caption).foregroundColor(.secondary)
                }
                .padding(.horizontal, 16).padding(.bottom, 16)
            }
            .background(Theme.bg)
            .navigationTitle("Tôi")
        }
    }

    private func section<C: View>(_ title: String, @ViewBuilder _ content: @escaping () -> C) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.footnote.weight(.semibold)).foregroundColor(.secondary).padding(.leading, 4)
            Card { content() }
        }
    }
}
