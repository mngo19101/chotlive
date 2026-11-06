import CoreBluetooth
import SwiftUI

struct RootView: View {
    @EnvironmentObject var client: LiveClient

    var body: some View {
        if client.loggedIn {
            TabView {
                LiveView().tabItem { Label("Live", systemImage: "dot.radiowaves.left.and.right") }
                CustomersView().tabItem { Label("Khách", systemImage: "person.2") }
                PrinterView().tabItem { Label("Máy in", systemImage: "printer") }
                SettingsView().tabItem { Label("Tôi", systemImage: "gearshape") }
            }
        } else {
            LoginView()
        }
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
                    HStack { Spacer(); if busy { ProgressView() } else { Text("Đăng nhập").bold() }; Spacer() }
                }
                .disabled(busy || server.isEmpty || user.isEmpty || pass.isEmpty)
            }
            .navigationTitle("ChốtLive")
        }
    }
}

// MARK: - Live

struct LiveView: View {
    @EnvironmentObject var client: LiveClient
    @EnvironmentObject var store: Store
    @EnvironmentObject var printer: PrinterManager
    @State private var tiktok = UserDefaults.standard.string(forKey: "tiktokName") ?? ""
    @State private var onlyPriced = true
    @State private var alert: String?

    private var shown: [LiveComment] { onlyPriced ? store.comments.filter { $0.price > 0 } : store.comments }

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
            VStack(spacing: 0) {
                HStack {
                    TextField("@tên TikTok đang live", text: $tiktok)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .textFieldStyle(.roundedBorder)
                    if client.liveState == "connected" || client.liveState == "connecting" {
                        Button("Dừng") { client.disconnectLive() }.buttonStyle(.bordered).tint(.red)
                    } else {
                        Button("Kết nối") { client.connectLive(tiktok: tiktok) }
                            .buttonStyle(.borderedProminent).disabled(tiktok.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                }
                .padding(.horizontal).padding(.top, 8)

                Text(statusText).font(.footnote).foregroundColor(.secondary).padding(.vertical, 6)
                Toggle("Chỉ hiện bình luận có giá", isOn: $onlyPriced).padding(.horizontal).font(.footnote)

                List(shown) { c in
                    CommentRow(c: c) {
                        alert = printComment(c, store: store, printer: printer)
                    }
                }
                .listStyle(.plain)
            }
            .navigationTitle("Bình luận")
            .alert("Không in được", isPresented: Binding(get: { alert != nil }, set: { if !$0 { alert = nil } })) {
                Button("OK", role: .cancel) {}
            } message: { Text(alert ?? "") }
        }
    }
}

struct CommentRow: View {
    let c: LiveComment
    let onPrint: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                Text(c.nickname).font(.subheadline).bold()
                Text("@" + c.uniqueId).font(.caption).foregroundColor(.secondary)
                Text(c.text).font(.body)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 6) {
                Text(c.ts, style: .time).font(.caption2).foregroundColor(.secondary)
                if c.price > 0 {
                    Text(vnd(c.price)).font(.subheadline).bold().foregroundColor(.green)
                    Button(c.printed ? "Đã in" : "In") { onPrint() }
                        .buttonStyle(.borderedProminent).tint(c.printed ? .gray : .blue)
                        .controlSize(.small)
                }
            }
        }
        .padding(.vertical, 4)
    }
}

// MARK: - Khách hàng

struct CustomersView: View {
    @EnvironmentObject var store: Store
    @State private var todayOnly = true

    private var list: [Customer] {
        todayOnly ? store.customersToday() : store.customers.sorted { $0.lastTs > $1.lastTs }
    }

    var body: some View {
        NavigationStack {
            List {
                Picker("", selection: $todayOnly) {
                    Text("Hôm nay").tag(true)
                    Text("Tất cả").tag(false)
                }.pickerStyle(.segmented)

                if list.isEmpty {
                    Text("Chưa có khách. Bấm In trên một bình luận để lưu khách.").foregroundColor(.secondary)
                }
                ForEach(list) { cust in
                    NavigationLink(value: cust.id) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(cust.nickname).bold()
                            Text("@" + cust.uniqueId).font(.caption).foregroundColor(.secondary)
                            let items = todayOnly ? cust.itemsToday : cust.items
                            Text("\(items.count) món · \(vnd(items.reduce(0) { $0 + $1.price }))")
                                .font(.footnote).foregroundColor(.green)
                        }
                    }
                }
            }
            .navigationTitle("Khách hàng")
            .navigationDestination(for: String.self) { id in
                CustomerDetail(customerId: id, todayOnly: todayOnly)
            }
        }
    }
}

struct CustomerDetail: View {
    let customerId: String
    let todayOnly: Bool
    @EnvironmentObject var store: Store
    @EnvironmentObject var printer: PrinterManager
    @State private var alert: String?

    var body: some View {
        if let cust = store.customers.first(where: { $0.id == customerId }) {
            let items = (todayOnly ? cust.itemsToday : cust.items).sorted { $0.ts > $1.ts }
            List {
                Section {
                    Text(cust.nickname).font(.headline)
                    Text("ID TikTok: @" + cust.uniqueId)
                    if !cust.userId.isEmpty { Text("Mã số: " + cust.userId).foregroundColor(.secondary) }
                }
                Section("Các món đã chốt") {
                    ForEach(items) { it in
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(it.comment)
                                Text(it.ts.formatted(date: .abbreviated, time: .shortened))
                                    .font(.caption).foregroundColor(.secondary)
                            }
                            Spacer()
                            Text(vnd(it.price)).bold()
                        }
                        .swipeActions {
                            Button("In lại") {
                                let c = LiveComment(id: it.id, uniqueId: cust.uniqueId, userId: cust.userId,
                                                    nickname: cust.nickname, text: it.comment, ts: it.ts, price: it.price)
                                alert = printComment(c, store: store, printer: printer)
                            }.tint(.blue)
                            Button("Xoá", role: .destructive) { store.deleteItem(customerId: cust.id, itemId: it.id) }
                        }
                    }
                }
                Section {
                    HStack { Text("Tổng cộng").bold(); Spacer(); Text(vnd(items.reduce(0) { $0 + $1.price })).bold() }
                }
            }
            .navigationTitle(cust.nickname)
            .alert("Không in được", isPresented: Binding(get: { alert != nil }, set: { if !$0 { alert = nil } })) {
                Button("OK", role: .cancel) {}
            } message: { Text(alert ?? "") }
        } else {
            Text("Khách không còn tồn tại")
        }
    }
}

// MARK: - Máy in

struct PrinterView: View {
    @EnvironmentObject var printer: PrinterManager
    @AppStorage("paperWidth") private var paperWidth = 576
    @AppStorage("shopName") private var shopName = "ChốtLive"

    var body: some View {
        NavigationStack {
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
        }
    }

    private func printTest() {
        let c = LiveComment(id: "test", uniqueId: "tai_khoan_mau", userId: "123456789", nickname: "Khách thử",
                            text: "59", ts: Date(), price: 59000)
        printer.send(TicketRenderer.ticketBytes(comment: c))
    }
}

// MARK: - Cài đặt

struct SettingsView: View {
    @EnvironmentObject var client: LiveClient

    var body: some View {
        NavigationStack {
            Form {
                Section("Tài khoản") {
                    Text(client.username)
                    Text(client.baseURL).font(.footnote).foregroundColor(.secondary)
                    Text(client.socketConnected ? "Đã nối server" : "Mất kết nối server")
                        .foregroundColor(client.socketConnected ? .green : .orange)
                }
                Button("Đăng xuất", role: .destructive) { client.logout() }
            }
            .navigationTitle("Tôi")
        }
    }
}
