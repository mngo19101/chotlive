import SwiftUI

private func money(_ n: Int) -> String {
    let f = NumberFormatter()
    f.numberStyle = .decimal
    f.groupingSeparator = "."
    return (f.string(from: NSNumber(value: n)) ?? "\(n)") + "đ"
}

// MARK: - Kết nối

struct ConnectView: View {
    @EnvironmentObject var cl: ChotLiveReader
    @EnvironmentObject var vtp: VtpWebClient

    @State private var clUser = ""
    @State private var clPass = ""
    @State private var vtpUser = ""
    @State private var vtpPass = ""
    @State private var otp = ""

    var body: some View {
        NavigationStack {
            Form {
                chotliveSection
                vtpSection
                Section {
                    Text("Bản THỬ, tách biệt với app ChốtLive thật. Không ghi gì lên máy chủ ChotLive, không tạo vận đơn thật: chỉ lưu NHÁP trên Viettel Post.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("VTP Nháp Test")
        }
    }

    private var chotliveSection: some View {
        Section {
            TextField("Máy chủ", text: $cl.server)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.URL)
            if cl.loggedIn {
                LabeledContent("Tài khoản", value: cl.user)
                LabeledContent("Đọc được", value: "\(cl.orders.count) đơn · \(cl.customerCount) khách")
                if !cl.source.isEmpty { LabeledContent("Nguồn", value: cl.source) }
                Button(cl.busy ? "Đang tải…" : "Tải lại đơn") { Task { await cl.reload() } }
                    .disabled(cl.busy)
                Button("Quên phiên trên máy này", role: .destructive) { cl.forget() }
            } else {
                TextField("Tên tài khoản ChotLive", text: $clUser)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                SecureField("Mật khẩu", text: $clPass)
                Button(cl.busy ? "Đang đăng nhập…" : "Đăng nhập & đọc đơn") {
                    Task { await cl.login(user: clUser, password: clPass); clPass = "" }
                }
                .disabled(cl.busy || clUser.isEmpty || clPass.isEmpty)
            }
            if let e = cl.lastError { Text(e).foregroundStyle(.red).font(.footnote) }
        } header: {
            Text("1. ChotLive (chỉ đọc)")
        } footer: {
            Text("App chỉ được gọi 2 lệnh: đăng nhập và đọc đơn (GET /api/state). Mọi lệnh ghi đều bị chặn trong code.")
        }
    }

    private var vtpSection: some View {
        Section {
            if vtp.loggedIn {
                LabeledContent("Tài khoản", value: vtp.userName.isEmpty ? "Đã đăng nhập" : vtp.userName)
                if let exp = vtp.tokenExpiry {
                    LabeledContent("Phiên hết hạn", value: exp.formatted(date: .abbreviated, time: .shortened))
                }
                LabeledContent("Kho hàng", value: "\(vtp.kho.count)")
                Button("Làm mới phiên") { Task { await vtp.refreshNow() } }.disabled(vtp.busy)
                Button("Tải lại kho hàng") { Task { await vtp.loadKho() } }.disabled(vtp.busy)
                Button("Đăng xuất Viettel Post", role: .destructive) { vtp.logout() }
            } else if let step = vtp.otpStep {
                Text(step.function == "SSO_OTP_FALLBACK"
                     ? "Viettel Post đòi xác minh không phải robot, chuyển sang đăng nhập bằng OTP."
                     : "Viettel Post cần xác minh thiết bị mới bằng OTP.")
                    .font(.footnote)
                if step.sentType == nil {
                    Button("Gửi mã qua SMS") { Task { await vtp.sendOtp("PHONE") } }.disabled(vtp.busy)
                    if !step.email.isEmpty {
                        Button("Gửi mã qua Email") { Task { await vtp.sendOtp("EMAIL") } }.disabled(vtp.busy)
                    }
                } else {
                    TextField("Mã OTP 6 số", text: $otp).keyboardType(.numberPad)
                    Button(vtp.busy ? "Đang xác nhận…" : "Xác nhận") { Task { await vtp.verifyOtp(otp); otp = "" } }
                        .disabled(vtp.busy || otp.count < 4)
                }
                Button("Huỷ", role: .cancel) { vtp.otpStep = nil }
            } else {
                TextField("SĐT hoặc email Viettel Post", text: $vtpUser)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                SecureField("Mật khẩu Viettel Post", text: $vtpPass)
                Button(vtp.busy ? "Đang đăng nhập…" : "Đăng nhập Viettel Post") {
                    Task { await vtp.startLogin(user: vtpUser, password: vtpPass); vtpPass = "" }
                }
                .disabled(vtp.busy || vtpUser.isEmpty || vtpPass.isEmpty)
            }
            if let e = vtp.lastError { Text(e).foregroundStyle(.red).font(.footnote) }
        } header: {
            Text("2. Viettel Post (trên máy này)")
        } footer: {
            Text("Đăng nhập và ký ngay trên iPhone, đi từ IP của máy. Mật khẩu và OTP không lưu, không gửi lên máy chủ ChotLive.")
        }
    }
}

// MARK: - Đẩy nháp

struct PushResult {
    var ok: Bool
    var text: String
}

struct OrdersView: View {
    @EnvironmentObject var cl: ChotLiveReader
    @EnvironmentObject var vtp: VtpWebClient
    @EnvironmentObject var log: LogStore

    @AppStorage("filterMode") private var mode = 0
    @AppStorage("service") private var service = "STK"
    @AppStorage("khoId") private var khoId = ""
    @State private var selected: Set<String> = []
    @State private var results: [String: PushResult] = [:]
    @State private var pushing = false

    private var groups: [DraftGroup] { DraftGroup.build(cl.orders, mode: mode) }
    private var kho: VtpKho? { vtp.kho.first { $0.id == khoId } ?? vtp.kho.first }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Picker("Lấy đơn", selection: $mode) {
                        Text("Đã duyệt").tag(0)
                        Text("Chưa gửi (trừ hẹn gom)").tag(1)
                        Text("Đơn gần nhất mỗi khách (để thử)").tag(2)
                    }
                    .onChange(of: mode) { _ in selected.removeAll() }
                    Picker("Dịch vụ", selection: $service) {
                        Text("STK · Tiêu chuẩn").tag("STK")
                        Text("SCN · Nhanh").tag("SCN")
                        Text("VSL9 · Flashsale").tag("VSL9")
                    }
                    if vtp.kho.count > 1 {
                        Picker("Kho lấy hàng", selection: $khoId) {
                            ForEach(vtp.kho) { k in Text(k.name + " · " + k.address).tag(k.id) }
                        }
                    } else if let k = kho {
                        LabeledContent("Kho lấy hàng", value: k.name)
                    } else if vtp.loggedIn {
                        Button(vtp.loadingKho ? "Đang tải kho hàng…" : "Tải kho hàng Viettel Post") { Task { await vtp.loadKho() } }
                            .disabled(vtp.loadingKho)
                    }
                } footer: {
                    if !cl.loggedIn { Text("Chưa đăng nhập ChotLive (tab Kết nối).") }
                    else if !vtp.loggedIn { Text("Chưa đăng nhập Viettel Post (tab Kết nối).") }
                }

                Section {
                    if groups.isEmpty {
                        Text(cl.loggedIn ? "Không có đơn phù hợp. Đổi \"Lấy đơn\" sang \"Đơn gần nhất mỗi khách\" để thử với đơn cũ."
                                         : "Chưa có dữ liệu.").foregroundStyle(.secondary)
                    }
                    ForEach(groups) { g in row(g) }
                } header: {
                    Text("\(groups.count) khách · đã chọn \(selected.count)")
                } footer: {
                    if cl.loggedIn { Text("Trên ChotLive: \(cl.customerCount) khách, " + DraftGroup.stats(cl.orders)) }
                }
            }
            .navigationTitle("Đẩy nháp")
            .refreshable { await cl.reload() }
            // Phiên Viettel Post giữ được qua lần mở app, nhưng danh sách kho thì không: tự tải lại.
            .task { if vtp.loggedIn && vtp.kho.isEmpty { await vtp.loadKho() } }
            .safeAreaInset(edge: .bottom) { pushBar }
        }
    }

    private func row(_ g: DraftGroup) -> some View {
        let pushed = PushedStore.code(g.pushKey)
        let on = selected.contains(g.id)
        return Button {
            if on { selected.remove(g.id) } else if g.problems.isEmpty { selected.insert(g.id) }
        } label: {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: on ? "checkmark.square.fill" : "square")
                    .font(.title3)
                    .foregroundStyle(g.problems.isEmpty ? Color.accentColor : Color.secondary)
                VStack(alignment: .leading, spacing: 3) {
                    HStack {
                        Text(g.receiver.isEmpty ? g.key : g.receiver).font(.headline)
                        if !g.uniqueId.isEmpty { Text("@" + g.uniqueId).font(.caption).foregroundStyle(.secondary) }
                    }
                    Text(g.address.isEmpty ? "Chưa có địa chỉ" : g.address).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                    Text("\(g.orders.count) đơn (\(g.states)) · \(g.qty) món · \(g.weightG)g · \(g.senderPays ? "shop trả cước" : "khách trả cước")")
                        .font(.caption2).foregroundStyle(.secondary)
                    ForEach(g.problems, id: \.self) { p in Text("⚠ " + p).font(.caption).foregroundStyle(.orange) }
                    if let r = results[g.id] {
                        Text((r.ok ? "✓ " : "✗ ") + r.text).font(.caption).foregroundStyle(r.ok ? Color.green : Color.red)
                    } else if let pushed {
                        Text("Đã đẩy nháp trước đó: \(pushed)").font(.caption).foregroundStyle(.green)
                    }
                }
                Spacer()
                VStack(alignment: .trailing) {
                    Text(money(g.cod)).font(.subheadline.bold())
                    Text("thu hộ").font(.caption2).foregroundStyle(.secondary)
                }
            }
        }
        .buttonStyle(.plain)
    }

    private var pushBar: some View {
        VStack(spacing: 6) {
            Button {
                Task { await push() }
            } label: {
                Text(pushing ? "Đang đẩy…" : "Đẩy \(selected.count) nháp lên Viettel Post")
                    .bold()
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
            }
            .buttonStyle(.borderedProminent)
            .disabled(pushing || selected.isEmpty || !vtp.loggedIn || kho == nil)
            if let why = blockedReason {
                Text(why).font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal)
        .padding(.vertical, 8)
        .background(.bar)
    }

    /// Vì sao nút đẩy đang khoá (nil = bấm được).
    private var blockedReason: String? {
        if pushing { return nil }
        if !vtp.loggedIn { return "Chưa đăng nhập Viettel Post (tab Kết nối)." }
        if kho == nil { return vtp.loadingKho ? "Đang tải kho hàng Viettel Post…" : "Chưa có kho hàng Viettel Post: bấm \"Tải kho hàng Viettel Post\" ở trên." }
        if selected.isEmpty { return "Chọn ít nhất 1 khách." }
        return nil
    }

    private func push() async {
        guard let kho else { return }
        pushing = true
        defer { pushing = false }
        let chosen = groups.filter { selected.contains($0.id) }
        log.add("Bắt đầu đẩy \(chosen.count) nháp", "Kho: \(kho.name) · dịch vụ \(service)")
        for g in chosen {
            if let old = PushedStore.code(g.pushKey) {
                results[g.id] = PushResult(ok: true, text: "Bỏ qua, đã đẩy: \(old)")
                continue
            }
            do {
                let place = try await vtp.locate(g.address)
                log.add("Địa chỉ \(g.receiver)", "\(g.address)\n→ \(place.formatted) (\(place.province)/\(place.district)/\(place.ward), tin cậy \(Int(place.confidence * 100))%)")
                let code = try await vtp.insertDraft(g.draftBody(kho: kho, place: place, service: service))
                PushedStore.save(g.pushKey, code)
                results[g.id] = PushResult(ok: true, text: "Nháp \(code) · thu hộ \(money(g.cod))")
                selected.remove(g.id)
            } catch {
                results[g.id] = PushResult(ok: false, text: error.localizedDescription)
                log.add("Lỗi nháp \(g.receiver)", error.localizedDescription, ok: false)
            }
        }
    }
}

// MARK: - Nhật ký

struct LogView: View {
    @EnvironmentObject var log: LogStore

    var body: some View {
        NavigationStack {
            List(log.entries) { e in
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Image(systemName: e.ok ? "checkmark.circle.fill" : "xmark.octagon.fill")
                            .foregroundStyle(e.ok ? Color.green : Color.red)
                        Text(e.title).font(.subheadline.bold())
                        Spacer()
                        Text(e.time.formatted(date: .omitted, time: .standard)).font(.caption2).foregroundStyle(.secondary)
                    }
                    if !e.detail.isEmpty {
                        Text(e.detail).font(.system(.caption2, design: .monospaced)).foregroundStyle(.secondary)
                            .textSelection(.enabled)
                    }
                }
            }
            .navigationTitle("Nhật ký")
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button("Xoá") { log.entries.removeAll() }
                }
                ToolbarItem(placement: .navigationBarTrailing) {
                    ShareLink(item: log.asText) { Image(systemName: "square.and.arrow.up") }
                }
            }
        }
    }
}
