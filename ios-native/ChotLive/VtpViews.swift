import SwiftUI
import UIKit

// MARK: - Tôi › ViettelPost

/// Dán token một lần. Chưa kết nối thì app vẫn y như cũ (xuất Excel); kết nối rồi thì gửi vận đơn thẳng lên Viettel Post.
struct VtpConnectView: View {
    @EnvironmentObject var client: LiveClient
    @EnvironmentObject var ui: AppUI
    @AppStorage(Vtp.serviceKey) private var service = Vtp.defaultService
    @AppStorage(VtpTrack.labelSizeKey) private var labelSize = "a6"
    @State private var token = ""
    @State private var busy = false
    @State private var showSteps = false
    @State private var senders: [VtpConnection.Sender] = []
    @State private var loadingSenders = false
    @State private var senderError: String?

    private var conn: VtpConnection? { client.vtp }

    var body: some View {
        SubPage(title: "Kết nối ViettelPost") {
            ScrollView(showsIndicators: false) {
                VStack(alignment: .leading, spacing: Metrics.gap) {
                    if client.vtpConnected, let conn { connectedView(conn) } else { tokenView }
                }
                .padding(.horizontal, Metrics.gutter)
                .padding(.bottom, 16)
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .onAppear {
            if client.vtp == nil { client.refreshVtp() }
            if client.vtpConnected && senders.isEmpty { loadSenders() }
        }
        .onChange(of: client.vtp?.connected) { on in
            if on == true && senders.isEmpty { loadSenders() }
        }
    }

    // MARK: Chưa kết nối

    private var tokenView: some View {
        VStack(alignment: .leading, spacing: Metrics.gap) {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    T("Trạng thái", 15, .bold)
                    Spacer()
                    Badge(text: "Chưa kết nối", color: Theme.muted, fill: Theme.grayBadge)
                }
                T("Tạo token tại viettelpost.vn › Cấu hình tài khoản › Thêm mới token, rồi dán vào đây.", 13, .medium, Theme.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .cardStyle(20)

            VStack(alignment: .leading, spacing: 10) {
                T("Token ViettelPost", 12, .medium, Theme.muted)
                HStack(spacing: 8) {
                    SecureField("Dán token đã sao chép", text: $token)
                        .font(.bv(15, .semibold))
                        .foregroundColor(Theme.ink)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .padding(.horizontal, 15)
                        .frame(height: 48)
                        .cardStyle(14, fill: Theme.field)
                    Button {
                        if let s = UIPasteboard.general.string { token = s.trimmingCharacters(in: .whitespacesAndNewlines) }
                    } label: {
                        T("Dán", 14, .bold, Theme.accent).frame(width: 60, height: 48).cardStyle(14)
                    }
                    .buttonStyle(.plain)
                }
                T("Token được lưu trên máy chủ ChốtLive của bạn, không hiện lại trên máy và không gửi đi nơi khác ngoài Viettel Post. Dán một lần là dùng được cả trên web.",
                  12, .medium, Theme.muted)
                    .fixedSize(horizontal: false, vertical: true)
                Button { withAnimation { showSteps.toggle() } } label: {
                    HStack(spacing: 4) {
                        T("Cách lấy token", 13, .bold, Theme.accent)
                        Icon(name: showSteps ? .chevronUp : .chevronRight, size: 13, weight: 2.4, color: Theme.accent)
                    }
                }
                .buttonStyle(.plain)
                if showSteps { steps }
                PrimaryButton(title: busy ? "Đang kiểm tra…" : "Lưu và kiểm tra kết nối", fontSize: 15,
                              enabled: !busy && !token.trimmingCharacters(in: .whitespaces).isEmpty) { connect() }
                    .padding(.top, 4)
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .cardStyle(20)
        }
    }

    private var steps: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array([
                "Đăng nhập viettelpost.vn bằng tài khoản shop.",
                "Vào Cấu hình tài khoản › Thêm mới token, nhập mã OTP gửi về điện thoại.",
                "Sao chép token vừa tạo, quay lại đây bấm “Dán” rồi “Lưu và kiểm tra kết nối”.",
                "Muốn tạo vận đơn bằng app, tài khoản phải là đối tác (Partner) đã kích hoạt Production. Chưa có thì gọi Viettel Post 0862 235 888 nhờ kích hoạt."
            ].enumerated()), id: \.offset) { i, text in
                HStack(alignment: .top, spacing: 8) {
                    T("\(i + 1)", 11, .bold, Theme.accent)
                        .frame(width: 20, height: 20)
                        .background(Circle().fill(Theme.peachSoft))
                    T(text, 13, .medium, Theme.ink).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Theme.field))
    }

    private func connect() {
        let t = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        busy = true
        Task { @MainActor in
            let r = await client.vtpConnect(token: t)
            busy = false
            if let e = r.error {
                ui.notify(e)
                return
            }
            token = ""
            senders = r.senders
            // Chỉ có một điểm lấy hàng thì chọn luôn.
            if client.vtp?.sender == nil, r.senders.count == 1 { choose(r.senders[0]) }
        }
    }

    // MARK: Đã kết nối

    private func connectedView(_ conn: VtpConnection) -> some View {
        VStack(alignment: .leading, spacing: Metrics.gap) {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 8) {
                    T("Trạng thái", 15, .bold)
                    Spacer()
                    Badge(text: "Đã kết nối", color: Theme.green, fill: Theme.greenSoft)
                }
                T("Tài khoản \(conn.phone.isEmpty ? "Viettel Post" : conn.phone)", 13, .medium, Theme.muted)
                HStack(spacing: 8) {
                    OutlineButton(title: "Kiểm tra lại", icon: .check) {
                        client.refreshVtp()
                        loadSenders()
                    }
                    OutlineButton(title: "Ngắt kết nối", color: Theme.red) {
                        ui.confirm = ConfirmItem(title: "Ngắt kết nối Viettel Post?",
                                                 message: "Máy chủ xoá token. Đơn đã tạo vẫn giữ mã vận đơn; muốn gửi tiếp phải dán token lại.",
                                                 action: "Ngắt kết nối") {
                            Task { @MainActor in ui.notify(await client.vtpDisconnect()) }
                        }
                    }
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .cardStyle(20)

            senderCard(conn)
            defaultsCard
            hookCard(conn)
        }
    }

    private func senderCard(_ conn: VtpConnection) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                T("Điểm lấy hàng", 15, .bold)
                Spacer()
                if loadingSenders { ProgressView().scaleEffect(0.8) }
            }
            .padding(.bottom, 6)
            if conn.sender == nil {
                T("Chọn nơi bưu tá đến lấy hàng. Danh sách lấy từ tài khoản Viettel Post của bạn.", 12.5, .medium, Theme.red)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.bottom, 6)
            }
            let list = senders.isEmpty ? [conn.sender].compactMap { $0 } : senders
            if list.isEmpty && !loadingSenders {
                T(senderError ?? "Chưa có điểm lấy hàng. Thêm ở viettelpost.vn › Quản lý kho rồi bấm Kiểm tra lại.",
                  13, .medium, Theme.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            ForEach(Array(list.enumerated()), id: \.element.id) { i, k in
                if i > 0 { HairLine() }
                Button { choose(k) } label: {
                    HStack(alignment: .top, spacing: 12) {
                        TickCircle(on: conn.sender?.id == k.id).padding(.top, 2)
                        VStack(alignment: .leading, spacing: 2) {
                            T(k.name.isEmpty ? "Kho \(k.id)" : k.name, 15, .bold).lineLimit(1)
                            T([k.phone, k.address].filter { !$0.isEmpty }.joined(separator: " · "), 12, .medium, Theme.muted)
                                .lineLimit(2)
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.vertical, 10)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardStyle(20)
    }

    private var defaultsCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            T("Mặc định khi gửi", 15, .bold)
            T("Gói dịch vụ", 12, .medium, Theme.muted)
            FlowChips(options: Vtp.services.map { (value: $0.code, title: "\($0.code) · \($0.name)") }, selected: service) { service = $0 }
            T("Khổ tem in", 12, .medium, Theme.muted)
            FlowChips(options: VtpTrack.labelSizes.map { (value: $0.code, title: $0.name) }, selected: labelSize) { labelSize = $0 }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardStyle(20)
    }

    private func hookCard(_ conn: VtpConnection) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                T("Tự cập nhật trạng thái", 15, .bold)
                Spacer()
                if conn.lastHookAt != nil { Badge(text: "Đang chạy", color: Theme.green, fill: Theme.greenSoft) }
            }
            T(conn.lastHookAt.map { "Cập nhật lần cuối \(Self.ago($0))" }
              ?? "Chưa nhận cập nhật nào. Dán địa chỉ dưới vào partner2.viettelpost.vn › Bảng điều khiển › Thông tin tài khoản › Production › Cấu hình webhook để đơn tự chuyển Đang giao / Đã giao.",
              12.5, .medium, Theme.muted)
                .fixedSize(horizontal: false, vertical: true)
            if !conn.hookUrl.isEmpty {
                HStack(spacing: 8) {
                    T(conn.hookUrl, 12, .semibold, Theme.ink).lineLimit(1).truncationMode(.middle)
                    Spacer(minLength: 4)
                    Button {
                        UIPasteboard.general.string = conn.hookUrl
                        ui.notify("Đã sao chép địa chỉ webhook.")
                    } label: { T("Sao chép", 13, .bold, Theme.accent) }
                    .buttonStyle(.plain)
                }
                .padding(.horizontal, 12)
                .frame(height: 44)
                .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Theme.field))
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardStyle(20)
    }

    static func ago(_ d: Date) -> String {
        let s = max(0, Int(Clock.now.timeIntervalSince(d)))
        if s < 60 { return "vừa xong" }
        if s < 3600 { return "\(s / 60) phút trước" }
        if s < 86_400 { return "\(s / 3600) giờ trước" }
        return "\(dayMonth(d)) \(timeText(d))"
    }

    private func loadSenders() {
        guard !loadingSenders else { return }
        loadingSenders = true
        Task { @MainActor in
            let r = await client.vtpSenders()
            loadingSenders = false
            senderError = r.error
            if r.error == nil { senders = r.senders }
        }
    }

    private func choose(_ k: VtpConnection.Sender) {
        guard client.vtp?.sender?.id != k.id else { return }
        Task { @MainActor in ui.notify(await client.vtpSetSender(k.id)) }
    }
}

/// Hàng chip xuống dòng khi không đủ chỗ.
struct FlowChips: View {
    let options: [(value: String, title: String)]
    let selected: String
    let onSelect: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(options.indices, id: \.self) { i in
                let o = options[i]
                Button { onSelect(o.value) } label: {
                    HStack(spacing: 10) {
                        TickCircle(on: o.value == selected)
                        T(o.title, 14, o.value == selected ? .bold : .semibold).lineLimit(1)
                        Spacer(minLength: 0)
                    }
                    .frame(height: 36)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
    }
}

// MARK: - In tem / theo dõi

@MainActor
enum VtpActions {
    static func printLabels(_ codes: [String], client: LiveClient, ui: AppUI) {
        guard !codes.isEmpty else { return }
        let size = UserDefaults.standard.string(forKey: VtpTrack.labelSizeKey) ?? "a6"
        Task { @MainActor in
            let r = await client.vtpPrintURL(codes, size: size)
            if let e = r.error { ui.notify(e); return }
            if let url = r.url { await UIApplication.shared.open(url) }
        }
    }

    static func track(_ code: String) {
        if let url = VtpTrack.trackURL(code) { UIApplication.shared.open(url) }
    }

    static func copy(_ code: String, ui: AppUI) {
        UIPasteboard.general.string = code
        ui.notify("Đã sao chép mã vận đơn \(code).")
    }
}

// MARK: - Kết quả gửi (trong bảng Gửi Viettel Post)

struct VtpResultView: View {
    let groups: [Vtp.Group]
    let results: [VtpCreateResult]
    @EnvironmentObject var client: LiveClient
    @EnvironmentObject var ui: AppUI

    private var okList: [VtpCreateResult] { results.filter(\.ok) }

    var body: some View {
        VStack(spacing: 0) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    T("Đã tạo \(okList.count)/\(results.count) vận đơn", 20, .heavy, Theme.ink, track: -0.3)
                    T(okList.isEmpty ? "Chưa tạo được vận đơn nào" : "\(okList.count) khách đã chuyển sang Đang giao", 13, .medium, Theme.muted)
                }
                Spacer()
                Button { ui.dismissSheet() } label: {
                    Icon(name: .close, size: 17, weight: 2.4).frame(width: 36, height: 36).background(Circle().fill(Theme.field))
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, Metrics.gutter)
            .padding(.bottom, 12)

            ScrollView(showsIndicators: false) {
                VStack(alignment: .leading, spacing: 12) {
                    VStack(spacing: 0) {
                        ForEach(Array(results.enumerated()), id: \.element.id) { i, r in
                            if i > 0 { Rectangle().fill(Theme.line.opacity(0.7)).frame(height: 1) }
                            row(r)
                        }
                    }
                    .cardStyle(18)
                    .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                    T("Đơn lỗi vẫn nằm ở “Chờ gửi”, sửa xong ấn Gửi VTP lại. Không tạo trùng vận đơn cho đơn đã thành công.",
                      12.5, .medium, Theme.muted)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.horizontal, 4)
                }
                .padding(.horizontal, Metrics.gutter)
                .padding(.bottom, 12)
            }
            .frame(maxHeight: .infinity)

            VStack(spacing: 10) {
                if !okList.isEmpty {
                    PrimaryButton(title: "In tem \(okList.count) vận đơn", icon: .printer, fontSize: 15) {
                        VtpActions.printLabels(okList.map(\.code), client: client, ui: ui)
                    }
                }
                OutlineButton(title: "Xong", height: 52) { ui.dismissSheet() }
            }
            .padding(.horizontal, Metrics.gutter)
            .padding(.top, 14)
            .background(Theme.card.overlay(alignment: .top) { HairLine() })
        }
    }

    private func name(_ r: VtpCreateResult) -> String {
        guard let g = groups.first(where: { $0.id == r.key }) else { return r.key }
        return g.summary.receiver.isEmpty ? g.customer.nickname : g.summary.receiver
    }

    private func row(_ r: VtpCreateResult) -> some View {
        HStack(alignment: .top, spacing: 12) {
            ZStack {
                Circle().fill(r.ok ? Theme.greenSoft : Theme.redSoft)
                if r.ok {
                    Icon(name: .check, size: 13, weight: 3, color: Theme.green)
                } else {
                    T("!", 14, .heavy, Theme.red)
                }
            }
            .frame(width: 26, height: 26)
            VStack(alignment: .leading, spacing: 4) {
                T(name(r), 15, .bold).lineLimit(1)
                if r.ok {
                    HStack(spacing: 6) {
                        T("Mã \(VtpTrack.pretty(r.code))", 13, .semibold, Theme.ink)
                        if r.fee > 0 { T("· cước \(money(r.fee))", 12, .medium, Theme.muted) }
                        if r.already { T("· đã có từ trước", 12, .medium, Theme.muted) }
                    }
                } else {
                    T("ViettelPost báo: \(r.error)", 12.5, .semibold, Theme.red).fixedSize(horizontal: false, vertical: true)
                    if let g = groups.first(where: { $0.id == r.key }) {
                        Button {
                            ui.dismissSheet()
                            ui.push(.addressEdit(g.customer.id))
                        } label: { T("Sửa rồi thử lại", 12.5, .bold, Theme.accent) }
                        .buttonStyle(.plain)
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background(r.ok ? Color.clear : Theme.badRow)
    }
}

// MARK: - Chi tiết đơn: phần vận đơn

struct VtpOrderBox: View {
    let order: Order
    @EnvironmentObject var client: LiveClient
    @EnvironmentObject var store: Store
    @EnvironmentObject var ui: AppUI
    @State private var busy = false

    var body: some View {
        if let code = VtpTrack.code(order) {
            active(code)
        } else if let old = VtpTrack.cancelledCode(order) {
            VStack(alignment: .leading, spacing: 6) {
                T("Vận đơn \(VtpTrack.pretty(old)) đã huỷ", 14, .bold, Theme.red)
                T("Đơn đã về Chờ gửi. Bấm Gửi VTP ở tab Đơn hàng để tạo vận đơn mới.", 12.5, .medium, Theme.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(15)
            .frame(maxWidth: .infinity, alignment: .leading)
            .cardStyle(20, fill: Theme.badRow, border: Theme.red.opacity(0.3))
        } else if let e = VtpTrack.lastError(order) {
            VStack(alignment: .leading, spacing: 6) {
                T("Lỗi tạo vận đơn", 14, .bold, Theme.red)
                T("ViettelPost báo: \(e)", 12.5, .medium, Theme.red).fixedSize(horizontal: false, vertical: true)
                Button { ui.push(.addressEdit(order.customer.id)) } label: { T("Sửa địa chỉ", 13, .bold, Theme.accent) }
                    .buttonStyle(.plain)
            }
            .padding(15)
            .frame(maxWidth: .infinity, alignment: .leading)
            .cardStyle(20, fill: Theme.badRow, border: Theme.red.opacity(0.3))
        }
    }

    private func active(_ code: String) -> some View {
        let bad = VtpTrack.needsAction(order)
        let s = order.ship
        let at = s?.vtpStatusAt.map { Date(timeIntervalSince1970: $0 / 1000) }
        return VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Icon(name: .truck, size: 16, weight: 2.3, color: Theme.accent)
                T("ViettelPost", 15, .bold)
                Spacer(minLength: 4)
                Badge(text: bad ? "Cần xử lý" : VtpTrack.statusName(order),
                      color: bad ? Theme.red : (order.status == .delivered ? Theme.green : Theme.accent),
                      fill: bad ? Theme.redSoft : (order.status == .delivered ? Theme.greenSoft : Theme.peachSoft),
                      fontSize: 12, height: 24, hPad: 10)
            }

            if bad {
                VStack(alignment: .leading, spacing: 4) {
                    T(VtpTrack.statusName(order), 14, .bold, Theme.red)
                    if let n = s?.vtpNote, !n.isEmpty {
                        T("Lý do từ ViettelPost: \(n)", 12.5, .medium, Theme.ink).fixedSize(horizontal: false, vertical: true)
                    }
                    if let at { T("\(dayMonth(at)) \(timeText(at))", 12, .medium, Theme.muted) }
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Theme.redSoft))
            }

            Button { VtpActions.copy(code, ui: ui) } label: {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        T("Mã vận đơn · chạm để sao chép", 12, .medium, Theme.muted)
                        T(VtpTrack.pretty(code), 18, .heavy, Theme.ink, track: 0.3)
                    }
                    Spacer()
                    Image(systemName: "doc.on.doc").font(.system(size: 15, weight: .semibold)).foregroundColor(Theme.muted)
                }
                .padding(.horizontal, 14)
                .frame(height: 60)
                .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Theme.field))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            VStack(spacing: 8) {
                if let fee = s?.vtpFee, fee > 0 { line("Cước", money(fee)) }
                if let sv = s?.vtpService, !sv.isEmpty { line("Gói", sv) }
                if !bad { line("Trạng thái", VtpTrack.statusName(order) + (at.map { " · \(dayMonth($0)) \(timeText($0))" } ?? "")) }
                if !bad, let n = s?.vtpNote, !n.isEmpty { line("Hành trình", n) }
                if let created = s?.exportedAt.map({ Date(timeIntervalSince1970: $0 / 1000) }) {
                    line("Tạo vận đơn", "\(dayMonth(created)) \(timeText(created))")
                }
            }

            HStack(spacing: 8) {
                OutlineButton(title: "In tem", icon: .printer, filled: true) {
                    VtpActions.printLabels([code], client: client, ui: ui)
                }
                OutlineButton(title: "Theo dõi", icon: .truck) { VtpActions.track(code) }
            }

            if bad {
                VStack(alignment: .leading, spacing: 0) {
                    T("Gửi yêu cầu cho ViettelPost", 13, .bold, Theme.muted).padding(.bottom, 4)
                    actionRow("Yêu cầu phát lại", "Kèm ghi chú cho bưu tá") { openRedeliver(code, prefill: "") }
                    HairLine()
                    actionRow("Đổi số điện thoại / địa chỉ", "Khi khách báo sai thông tin, ghi kèm yêu cầu phát lại") {
                        openRedeliver(code, prefill: "Khách đổi thông tin nhận: ")
                    }
                    HairLine()
                    actionRow("Duyệt hoàn về shop", "Đơn chuyển sang “Đang hoàn”", color: Theme.red) { approveReturn(code) }
                }
                T("Khi ViettelPost báo “Giao thành công”, đơn tự chuyển Đã giao.", 12, .medium, Theme.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if VtpTrack.canCancel(order) {
                OutlineButton(title: busy ? "Đang huỷ…" : "Huỷ vận đơn", color: Theme.red) { cancel(code) }
                    .disabled(busy)
            }
        }
        .padding(15)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardStyle(20, fill: bad ? Theme.badRow : Theme.card, border: bad ? Theme.red.opacity(0.35) : Theme.line)
    }

    private func line(_ k: String, _ v: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            T(k, 13, .medium, Theme.muted)
            Spacer(minLength: 10)
            T(v, 13, .semibold).multilineTextAlignment(.trailing).fixedSize(horizontal: false, vertical: true)
        }
    }

    private func actionRow(_ title: String, _ sub: String, color: Color = Theme.ink, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    T(title, 14, .bold, color)
                    T(sub, 12, .medium, Theme.muted).lineLimit(2)
                }
                Spacer(minLength: 4)
                Icon(name: .chevronRight, size: 15, color: Theme.muted)
            }
            .padding(.vertical, 10)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func openRedeliver(_ code: String, prefill: String) {
        guard client.vtpConnected else { return ui.notify("Chưa kết nối Viettel Post. Vào Tôi › ViettelPost để dán token.") }
        let name = order.customer.address?.receiver.isEmpty == false ? order.customer.address!.receiver : order.customer.nickname
        ui.present(dim: 0.42) { VtpRedeliverSheet(code: code, name: name, prefill: prefill) }
    }

    private func approveReturn(_ code: String) {
        guard client.vtpConnected else { return ui.notify("Chưa kết nối Viettel Post. Vào Tôi › ViettelPost để dán token.") }
        ui.confirm = ConfirmItem(title: "Đồng ý hoàn đơn \(VtpTrack.pretty(code))?",
                                 message: "Viettel Post sẽ hoàn hàng về shop. Không giao lại cho khách nữa.",
                                 action: "Duyệt hoàn") {
            Task { @MainActor in
                if let e = await client.vtpResolve(code, type: 2, note: "") { return ui.notify(e) }
                store.applyVtpResolved(code: code, type: 2)
                ui.notify("Đã gửi yêu cầu hoàn về shop.")
            }
        }
    }

    private func cancel(_ code: String) {
        guard client.vtpConnected else { return ui.notify("Chưa kết nối Viettel Post. Vào Tôi › ViettelPost để dán token.") }
        ui.confirm = ConfirmItem(title: "Huỷ vận đơn \(VtpTrack.pretty(code))?",
                                 message: "Chỉ huỷ được khi bưu tá chưa lấy hàng. Đơn sẽ về lại Chờ gửi.",
                                 action: "Huỷ vận đơn") {
            busy = true
            Task { @MainActor in
                let e = await client.vtpCancel(code)
                busy = false
                if let e { return ui.notify(e) }
                store.applyVtpCancelled(code: code)
                ui.notify("Đã huỷ vận đơn, đơn về Chờ gửi.")
            }
        }
    }
}

// MARK: - Yêu cầu phát lại

struct VtpRedeliverSheet: View {
    let code: String
    let name: String
    var prefill = ""
    @EnvironmentObject var client: LiveClient
    @EnvironmentObject var store: Store
    @EnvironmentObject var ui: AppUI
    @State private var note = ""
    @State private var picked: Set<String> = []
    @State private var busy = false
    @State private var loaded = false

    private static let quick = ["Giao sau 17h", "Gọi trước khi giao", "Giao giờ hành chính", "Giao cuối tuần"]

    private var fullNote: String {
        let parts = Self.quick.filter { picked.contains($0) } + [note.trimmingCharacters(in: .whitespacesAndNewlines)]
        return String(parts.filter { !$0.isEmpty }.joined(separator: ". ").prefix(150))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    T("Yêu cầu phát lại", 20, .heavy, Theme.ink, track: -0.3)
                    T("\(name) · \(VtpTrack.pretty(code))", 13, .medium, Theme.muted).lineLimit(1)
                }
                Spacer()
                Button { ui.dismissSheet() } label: {
                    Icon(name: .close, size: 17, weight: 2.4).frame(width: 36, height: 36).background(Circle().fill(Theme.field))
                }
                .buttonStyle(.plain)
            }
            VStack(alignment: .leading, spacing: 6) {
                T("Ghi chú cho bưu tá", 12, .semibold, Theme.muted)
                TextField("Ví dụ: gọi sau 17h, khách đi làm ban ngày.", text: $note, axis: .vertical)
                    .font(.bv(15, .semibold))
                    .foregroundColor(Theme.ink)
                    .lineLimit(3...5)
                    .padding(14)
                    .cardStyle(14, fill: Theme.field)
            }
            WrapChips(items: Self.quick, picked: picked) { q in
                if picked.contains(q) { picked.remove(q) } else { picked.insert(q) }
            }
            T("Yêu cầu gửi thẳng lên ViettelPost. Kết quả giao lại sẽ tự hiện trong đơn.", 12.5, .medium, Theme.muted)
                .fixedSize(horizontal: false, vertical: true)
            PrimaryButton(title: busy ? "Đang gửi…" : "Gửi yêu cầu", fontSize: 15, enabled: !busy) { send() }
        }
        .padding(.horizontal, Metrics.gutter)
        .padding(.bottom, 8)
        .onAppear {
            guard !loaded else { return }
            loaded = true
            note = prefill
        }
    }

    private func send() {
        busy = true
        let text = fullNote
        Task { @MainActor in
            let e = await client.vtpResolve(code, type: 3, note: text)
            busy = false
            if let e { return ui.notify(e) }
            store.applyVtpResolved(code: code, type: 3)
            ui.dismissSheet()
            ui.notify("Đã gửi yêu cầu phát lại cho ViettelPost.")
        }
    }
}

/// Chip chọn nhiều, xếp 2 cột.
struct WrapChips: View {
    let items: [String]
    let picked: Set<String>
    let onTap: (String) -> Void

    var body: some View {
        LazyVGrid(columns: [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)], alignment: .leading, spacing: 8) {
            ForEach(items, id: \.self) { q in
                let on = picked.contains(q)
                Button { onTap(q) } label: {
                    T(q, 13, on ? .bold : .semibold)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                        .frame(maxWidth: .infinity)
                        .frame(height: 38)
                        .background(
                            Capsule().fill(on ? Theme.orange : Theme.card)
                                .overlay(Capsule().strokeBorder(on ? Color.clear : Theme.line, lineWidth: 1))
                        )
                        .onAccent(on)
                }
                .buttonStyle(.plain)
            }
        }
    }
}

// MARK: - Tab Đang giao: đơn cần xử lý

struct VtpAttentionBanner: View {
    let orders: [Order]

    var body: some View {
        let codes = Set(orders.compactMap(VtpTrack.code))
        VStack(alignment: .leading, spacing: 3) {
            T("\(codes.count) đơn cần xử lý · xếp lên đầu", 14, .bold, Theme.red)
            T(orders.prefix(3).map { "\($0.customer.nickname): \(VtpTrack.statusName($0))" }.joined(separator: " · "),
              12, .medium, Theme.muted)
                .lineLimit(2)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardStyle(18, fill: Theme.badRow, border: Theme.red.opacity(0.35))
    }
}
