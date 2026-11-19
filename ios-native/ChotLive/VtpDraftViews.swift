import SwiftUI
import UIKit

// MARK: - Tôi › ViettelPost › phần 2 "Đẩy nháp"

/// Đăng nhập tài khoản Viettel Post NGAY TRÊN MÁY này để đẩy đơn nháp (VtpDraftClient).
/// Khác phần 1 (token đối tác lưu trên máy chủ để tạo vận đơn): phiên này chỉ nằm trong Keychain của iPhone,
/// mật khẩu và OTP không lưu ở đâu.
struct VtpDraftSection: View {
    @EnvironmentObject var vtpDraft: VtpDraftClient
    @EnvironmentObject var vtpDrafts: VtpDraftHub
    @EnvironmentObject var client: LiveClient
    @EnvironmentObject var ui: AppUI
    /// Người dùng đã tự chọn kho cho nháp: thôi tự khớp theo điểm lấy hàng ở phần 1.
    @AppStorage("vtpDraft.khoPicked") private var khoPicked = false
    @State private var user = ""
    @State private var password = ""
    @State private var code = ""
    @State private var sentAt: Date?

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.gap) {
            if vtpDrafts.clients.count > 1 { accountsCard }
            if vtpDraft.otpStep != nil {
                otpCard
            } else if !vtpDraft.loggedIn || vtpDraft.sessionExpired {
                loginCard
            }
            if vtpDraft.loggedIn { accountCard }
            if vtpDraft.loggedIn, let warn = accountMismatch { mismatchCard(warn) }
            if vtpDraft.loggedIn && vtpDrafts.clients.count == 1 { addAccountButton }
        }
        .onAppear {
            prefillUser()
            if vtpDraft.loggedIn && vtpDraft.kho.isEmpty { Task { @MainActor in await vtpDraft.loadKho() } }
        }
        .onChange(of: vtpDraft.kho) { _ in matchKhoToSender() }
        .onChange(of: vtpDrafts.currentId) { _ in
            user = ""
            password = ""
            code = ""
            sentAt = nil
            prefillUser()
            if vtpDraft.loggedIn && vtpDraft.kho.isEmpty { Task { @MainActor in await vtpDraft.loadKho() } }
        }
    }

    /// Tài khoản đầu tiên: gợi ý số ở phần 1. Tài khoản thêm sau: để trống cho gõ số khác.
    private func prefillUser() {
        guard user.isEmpty else { return }
        if !vtpDraft.login.isEmpty {
            user = vtpDraft.login
        } else if vtpDrafts.loggedInClients.isEmpty {
            user = client.vtp?.phone ?? ""
        }
    }

    // MARK: Danh sách tài khoản

    private var accountsCard: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                T("Tài khoản đẩy nháp", 15, .bold)
                Spacer()
                T("chạm để dùng", 12, .semibold, Theme.muted)
            }
            .padding(.bottom, 4)
            ForEach(vtpDrafts.clients, id: \.accountId) { c in
                VtpDraftAccountRow(c: c, on: c.accountId == vtpDrafts.currentId) { vtpDrafts.select(c.accountId) }
            }
            if !vtpDrafts.clients.contains(where: { !$0.loggedIn }) {
                Button { vtpDrafts.addAccount() } label: {
                    HStack(spacing: 8) {
                        Icon(name: .plus, size: 14, weight: 2.4, color: Theme.accent)
                        T("Thêm tài khoản Viettel Post", 13.5, .bold, Theme.accent)
                    }
                    .padding(.vertical, 8)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardStyle(20)
    }

    private var addAccountButton: some View {
        Button { vtpDrafts.addAccount() } label: {
            HStack(spacing: 8) {
                Icon(name: .plus, size: 14, weight: 2.4, color: Theme.accent)
                T("Thêm tài khoản Viettel Post khác", 13.5, .bold, Theme.accent)
                Spacer()
            }
            .padding(.horizontal, 16)
            .frame(height: 46)
            .cardStyle(16)
        }
        .buttonStyle(.plain)
    }

    /// Đăng nhập (kể cả qua OTP) xong: báo hub để bỏ chỗ cũ trùng số.
    private func afterLogin(_ c: VtpDraftClient) {
        if c.loggedIn && c.otpStep == nil { vtpDrafts.didLogin(c) }
    }

    // MARK: Chưa đăng nhập / phiên hết

    private var loginCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                T(adding ? "Thêm tài khoản" : "Đăng nhập trên máy này", 15, .bold)
                Spacer()
                if vtpDraft.sessionExpired {
                    Badge(text: "Cần đăng nhập lại", color: Theme.red, fill: Theme.redSoft)
                } else {
                    Badge(text: "Chưa đăng nhập", color: Theme.muted, fill: Theme.grayBadge)
                }
            }
            T(adding
              ? "Đăng nhập thêm một tài khoản Viettel Post để đẩy nháp. Tài khoản đang có vẫn giữ phiên. Mật khẩu chỉ gửi thẳng tới Viettel Post. Lần đầu Viettel Post sẽ gửi mã OTP."
              : "Nên dùng cùng tài khoản Viettel Post ở phần 1. Mật khẩu chỉ gửi thẳng tới Viettel Post, không lưu trên máy chủ ChốtLive. Lần đầu trên máy này Viettel Post sẽ gửi mã OTP.",
              12.5, .medium, Theme.muted)
                .fixedSize(horizontal: false, vertical: true)
            LabeledField(label: "Số điện thoại / tên đăng nhập", placeholder: "0987…", text: $user,
                         keyboard: .asciiCapable, capitalize: false, contentType: .username)
            PasswordField(label: "Mật khẩu Viettel Post", text: $password)
            errorText
            HStack(spacing: 8) {
                if adding {
                    OutlineButton(title: "Huỷ") { vtpDrafts.remove(vtpDraft.accountId) }
                }
                PrimaryButton(title: vtpDraft.loading ? "Đang đăng nhập…" : "Đăng nhập", fontSize: 15, height: adding ? 44 : 52,
                              enabled: !vtpDraft.loading && !user.trimmingCharacters(in: .whitespaces).isEmpty && !password.isEmpty) {
                    let u = user, p = password
                    let c = vtpDraft
                    Task { @MainActor in
                        await c.startLogin(user: u, password: p)
                        // Mật khẩu chỉ cần cho một lần gửi: xoá khỏi ô ngay, kể cả khi lỗi.
                        password = ""
                        afterLogin(c)
                    }
                }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardStyle(20)
    }

    // MARK: OTP

    private var otpCard: some View {
        let step = vtpDraft.otpStep
        return VStack(alignment: .leading, spacing: 12) {
            HStack {
                T("Xác minh thiết bị", 15, .bold)
                Spacer()
                Badge(text: "Bước 2/2", color: Theme.accent, fill: Theme.peachSoft)
            }
            T(step?.function == "SSO_OTP_FALLBACK"
              ? "Viettel Post cần xác minh bằng mã OTP thay cho mã captcha. Chọn nơi nhận mã:"
              : "Viettel Post thấy máy này đăng nhập lần đầu nên cần mã OTP. Chọn nơi nhận mã:",
              12.5, .medium, Theme.muted)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
                channelButton("PHONE", "SMS " + VtpMask.text(step?.phone ?? ""))
                if let email = step?.email, !email.isEmpty { channelButton("EMAIL", "Email " + Self.maskEmail(email)) }
            }
            if step?.sentType != nil {
                LabeledField(label: "Mã OTP", placeholder: "6 số", text: $code, keyboard: .numberPad,
                             capitalize: false, contentType: .oneTimeCode)
                resendRow
            }
            errorText
            HStack(spacing: 8) {
                OutlineButton(title: "Huỷ") {
                    vtpDraft.cancelOtp()
                    code = ""
                }
                PrimaryButton(title: vtpDraft.loading ? "Đang xác nhận…" : "Xác nhận", fontSize: 15, height: 44,
                              enabled: !vtpDraft.loading && step?.sentType != nil && code.filter(\.isNumber).count >= 4) {
                    let digits = code.filter(\.isNumber)
                    let c = vtpDraft
                    Task { @MainActor in
                        await c.verifyOtp(digits)
                        if c.otpStep == nil { code = "" }
                        afterLogin(c)
                    }
                }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardStyle(20)
    }

    private func channelButton(_ type: String, _ title: String) -> some View {
        let on = vtpDraft.otpStep?.sentType == type
        return Button {
            guard !vtpDraft.loading else { return }
            Task { @MainActor in
                await vtpDraft.sendOtp(type)
                if vtpDraft.otpStep?.sentType == type { sentAt = Date() }
            }
        } label: {
            T(title, 13, .bold, on ? Theme.accent : Theme.ink)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .frame(maxWidth: .infinity)
                .frame(height: 40)
                .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(on ? Theme.peachSoft : Theme.field))
        }
        .buttonStyle(.plain)
    }

    /// Gửi lại mã sau 60 giây, đếm ngược từng giây.
    private var resendRow: some View {
        TimelineView(.periodic(from: .now, by: 1)) { ctx in
            let left = max(0, 60 - Int(ctx.date.timeIntervalSince(sentAt ?? .distantPast)))
            HStack {
                Spacer()
                if left > 0 {
                    T("Gửi lại mã sau 0:\(String(format: "%02d", left))", 12.5, .semibold, Theme.muted)
                } else if let type = vtpDraft.otpStep?.sentType {
                    Button {
                        Task { @MainActor in
                            await vtpDraft.sendOtp(type)
                            sentAt = Date()
                        }
                    } label: { T("Gửi lại mã", 13, .bold, Theme.accent) }
                    .buttonStyle(.plain)
                }
                Spacer()
            }
        }
    }

    // MARK: Đã đăng nhập

    private var accountCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                T("Đăng nhập trên máy này", 15, .bold)
                Spacer()
                if !vtpDraft.sessionExpired { Badge(text: "Đã đăng nhập", color: Theme.green, fill: Theme.greenSoft) }
            }
            HStack(spacing: 10) {
                T("VTP", 12, .heavy, .white)
                    .frame(width: 36, height: 36)
                    .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Color(hex: 0xEE0033)))
                VStack(alignment: .leading, spacing: 2) {
                    T(vtpDraft.displayName.isEmpty ? (vtpDraft.phone.isEmpty ? "Tài khoản Viettel Post" : vtpDraft.phone)
                                                   : vtpDraft.displayName, 14, .bold).lineLimit(1)
                    T(vtpDraft.phone.isEmpty ? "Chưa biết số: đăng xuất rồi đăng nhập lại một lần" : vtpDraft.phone,
                      12, .medium, Theme.muted).lineLimit(1).minimumScaleFactor(0.8)
                }
            }
            khoList
            HStack {
                T("Phiên", 13, .medium, Theme.muted)
                Spacer()
                T(sessionText, 13, .bold, vtpDraft.sessionExpired ? Theme.red : Theme.ink)
            }
            errorText
            HStack(spacing: 8) {
                OutlineButton(title: "Mở viettelpost.vn") {
                    if let url = URL(string: "https://viettelpost.vn/") { UIApplication.shared.open(url) }
                }
                OutlineButton(title: "Đăng xuất", color: Theme.red) {
                    let id = vtpDraft.accountId
                    let name = vtpDraft.accountLabel
                    ui.confirm = ConfirmItem(title: "Đăng xuất \(name.isEmpty ? "Viettel Post" : name) trên máy này?",
                                             message: "Tài khoản này không đẩy hay xoá nháp được tới khi đăng nhập lại. Nháp đã đẩy và vận đơn không bị ảnh hưởng.",
                                             action: "Đăng xuất") { vtpDrafts.remove(id) }
                }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardStyle(20)
    }

    private var khoList: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                T("Kho lấy hàng cho nháp", 12, .medium, Theme.muted)
                Spacer()
                if vtpDraft.loadingKho {
                    ProgressView().scaleEffect(0.8)
                } else {
                    Button { Task { @MainActor in await vtpDraft.loadKho() } } label: { T("Tải lại", 12.5, .bold, Theme.accent) }
                        .buttonStyle(.plain)
                }
            }
            if vtpDraft.kho.isEmpty && !vtpDraft.loadingKho {
                T("Chưa đọc được kho. Thêm kho ở viettelpost.vn › Quản lý kho rồi bấm Tải lại.", 12.5, .medium, Theme.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            ForEach(vtpDraft.kho) { k in
                Button {
                    vtpDraft.khoId = k.id
                    khoPicked = true
                } label: {
                    HStack(alignment: .top, spacing: 10) {
                        TickCircle(on: vtpDraft.selectedKho?.id == k.id).padding(.top, 2)
                        VStack(alignment: .leading, spacing: 2) {
                            T(k.name.isEmpty ? "Kho \(k.id)" : k.name, 14, .bold).lineLimit(1)
                            T(k.address, 12, .medium, Theme.muted).lineLimit(2)
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.vertical, 6)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
    }

    private var sessionText: String {
        if vtpDraft.sessionExpired { return "đã hết, đăng nhập lại" }
        return "tự làm mới"
    }

    private func mismatchCard(_ text: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                T("Khác tài khoản", 14, .bold)
                Spacer()
                Badge(text: "Cảnh báo", color: Theme.gomInk, fill: Theme.gomTag)
            }
            T(text, 12.5, .semibold, Theme.gomInk).fixedSize(horizontal: false, vertical: true)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 20, style: .continuous).fill(Theme.gomTag.opacity(0.6)))
    }

    @ViewBuilder private var errorText: some View {
        if let e = vtpDraft.lastError, !e.isEmpty {
            T(e, 12.5, .semibold, Theme.red).fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: Tiện ích

    /// Phần 2 đăng nhập khác số với tài khoản đối tác ở phần 1: nháp và vận đơn sẽ nằm ở hai tài khoản.
    private var accountMismatch: String? {
        guard let partner = client.vtp?.phone, client.vtpConnected else { return nil }
        let a = Self.phoneKey(partner), b = Self.phoneKey(vtpDraft.login.isEmpty ? vtpDraft.userName : vtpDraft.login)
        guard a.count >= 9, b.count >= 9, a != b else { return nil }
        let same = vtpDrafts.loggedInClients.contains { Self.phoneKey($0.login) == a }
        return "Tài khoản đang dùng để đẩy nháp (\(vtpDraft.phone)) khác phần 1 (\(VtpMask.text(partner))). Nháp sẽ nằm ở tài khoản khác với vận đơn."
            + (same ? " Chạm tài khoản trùng số ở trên nếu muốn nháp và vận đơn cùng chỗ." : "")
    }

    /// Đang thêm tài khoản thứ hai trở đi (đã có tài khoản khác đăng nhập).
    private var adding: Bool {
        !vtpDraft.loggedIn && vtpDrafts.loggedInClients.contains { $0 !== vtpDraft }
    }

    /// 9 số cuối của số điện thoại, để so 0987… với +84987….
    static func phoneKey(_ s: String) -> String { String(s.filter(\.isNumber).suffix(9)) }

    static func maskEmail(_ e: String) -> String {
        let parts = e.split(separator: "@", maxSplits: 1).map(String.init)
        guard parts.count == 2, let first = parts[0].first else { return e }
        return "\(first)***@\(parts[1])"
    }

    /// Chưa tự chọn kho: lấy kho trùng điểm lấy hàng ở phần 1 (theo địa chỉ hoặc tên).
    private func matchKhoToSender() {
        guard !khoPicked, let s = client.vtp?.sender else { return }
        let norm = { (x: String) in x.lowercased().filter { $0.isLetter || $0.isNumber } }
        if let k = vtpDraft.kho.first(where: { norm($0.address) == norm(s.address) && !s.address.isEmpty })
            ?? vtpDraft.kho.first(where: { norm($0.name) == norm(s.name) && !s.name.isEmpty }) {
            vtpDraft.khoId = k.id
        }
    }
}

/// Tiêu đề hai phần trong màn Kết nối ViettelPost: "1 Tạo vận đơn", "2 Đẩy nháp".
struct VtpSectionHeader: View {
    let number: Int
    let title: String
    let hint: String
    var color: Color = Theme.accent

    var body: some View {
        HStack(spacing: 10) {
            T("\(number)", 12, .heavy, .white)
                .frame(width: 22, height: 22)
                .background(RoundedRectangle(cornerRadius: 7, style: .continuous).fill(color))
            T(title, 15, .heavy)
            Spacer()
            T(hint, 12, .semibold, Theme.muted).lineLimit(1)
        }
        .padding(.top, 6)
    }
}

/// Một dòng trong danh sách tài khoản đẩy nháp. Theo dõi riêng client đó để tên, trạng thái phiên cập nhật ngay.
struct VtpDraftAccountRow: View {
    @ObservedObject var c: VtpDraftClient
    let on: Bool
    let select: () -> Void

    var body: some View {
        Button(action: select) {
            HStack(spacing: 10) {
                TickCircle(on: on)
                VStack(alignment: .leading, spacing: 2) {
                    T(title, 14, .bold).lineLimit(1)
                    T(subtitle, 12, .medium, Theme.muted).lineLimit(1).minimumScaleFactor(0.8)
                }
                Spacer(minLength: 6)
                if !c.loggedIn {
                    Badge(text: "Chưa đăng nhập", color: Theme.muted, fill: Theme.grayBadge)
                } else if c.sessionExpired {
                    Badge(text: "Cần đăng nhập lại", color: Theme.red, fill: Theme.redSoft)
                }
            }
            .padding(.vertical, 7)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var title: String {
        if !c.loggedIn && c.userName.isEmpty { return "Tài khoản mới" }
        return c.displayName.isEmpty ? (c.phone.isEmpty ? "Tài khoản Viettel Post" : c.phone) : c.displayName
    }

    private var subtitle: String {
        [c.displayName.isEmpty ? "" : c.phone, c.selectedKho?.name ?? ""].filter { !$0.isEmpty }.joined(separator: " · ")
    }
}
