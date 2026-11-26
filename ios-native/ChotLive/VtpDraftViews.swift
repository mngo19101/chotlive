import SwiftUI
import UIKit

// MARK: - Tôi › ViettelPost › phần 2 "Đẩy nháp"

/// Đăng nhập tài khoản Viettel Post NGAY TRÊN MÁY này để đẩy đơn nháp (VtpDraftClient).
/// Khác phần 1 (token đối tác lưu trên máy chủ để tạo vận đơn): phiên này chỉ nằm trong Keychain của iPhone,
/// mật khẩu và OTP không lưu ở đâu.
struct VtpDraftSection: View {
    @EnvironmentObject var vtpDrafts: VtpDraftHub
    @EnvironmentObject var client: LiveClient
    @EnvironmentObject var ui: AppUI
    @State private var user = ""
    @State private var password = ""
    @State private var code = ""
    @State private var sentAt: Date?

    private var active: VtpDraftClient { vtpDrafts.current }

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.gap) {
            if !client.vtpConnected {
                // Phần 2 cần phần 1 trước: chỉ phần 1 (token đối tác) mới nhận trạng thái đơn Viettel Post trả về.
                // Máy đã đăng nhập từ trước thì vẫn hiện thẻ tài khoản để còn đăng xuất được.
                lockedCard
                if active.loggedIn { accountCard }
            } else {
                if vtpDrafts.clients.count > 1 { accountsCard }
                if active.otpStep != nil {
                    otpCard
                } else if !active.loggedIn || active.sessionExpired {
                    loginCard
                }
                if active.loggedIn { accountCard }
                if active.loggedIn, let warn = accountMismatch { mismatchCard(warn) }
                if active.loggedIn && vtpDrafts.clients.count == 1 { addAccountButton }
            }
        }
        .onAppear {
            prefillUser()
            if active.loggedIn && !active.sessionExpired && (active.kho.isEmpty || !active.khoLoadedThisSession) {
                Task { @MainActor in await active.loadKho() }
            } else {
                matchKhoToSender()
            }
        }
        .onChange(of: active.kho) { _ in matchKhoToSender() }
        .onChange(of: vtpDrafts.currentId) { _ in
            user = ""
            password = ""
            code = ""
            sentAt = nil
            prefillUser()
            if active.loggedIn && !active.sessionExpired && (active.kho.isEmpty || !active.khoLoadedThisSession) {
                Task { @MainActor in await active.loadKho() }
            } else {
                matchKhoToSender()
            }
        }
        .onChange(of: active.loggedIn) { on in
            if !on {
                user = ""
                password = ""
                code = ""
                sentAt = nil
                prefillUser()
            }
        }
    }

    /// Tài khoản đầu tiên: gợi ý số ở phần 1 (chỉ khi chưa che). Tài khoản thêm sau: để trống cho gõ số khác.
    private func prefillUser() {
        guard user.isEmpty else { return }
        if !active.login.isEmpty {
            user = active.login
        } else if vtpDrafts.loggedInClients.isEmpty,
                  let p = client.vtp?.phone,
                  !p.contains("•"), !p.contains("*"), p.filter(\.isNumber).count >= 9 {
            user = p
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

    // MARK: Khoá khi chưa kết nối phần 1

    /// Phần 1 chưa kết nối: ô đăng nhập mờ và không bấm được, kèm lời nhắc kết nối phần 1 trước.
    private var lockedCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                T(active.loggedIn ? "Đẩy nháp đang khoá" : "Đăng nhập trên máy này", 15, .bold).lineLimit(1)
                Spacer(minLength: 4)
                HStack(spacing: 4) {
                    Icon(name: .lock, size: 11, weight: 2.6, color: Theme.accent)
                    T("Cần phần 1 trước", 11, .semibold, Theme.accent).lineLimit(1).fixedSize()
                }
                .padding(.horizontal, 8)
                .frame(height: 21)
                .background(Capsule().fill(Theme.peachSoft))
            }
            HStack(alignment: .top, spacing: 9) {
                Icon(name: .lock, size: 15, weight: 2.4, color: Theme.accent).padding(.top, 1)
                T("Kết nối phần 1 trước để app nhận trạng thái đơn Viettel Post trả về.", 12.5, .semibold, Theme.accent)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 13)
            .padding(.vertical, 11)
            .background(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(Theme.peachSoft)
                    .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Theme.peachLine, lineWidth: 1))
            )
            if !active.loggedIn {
                VStack(alignment: .leading, spacing: 10) {
                    lockedField("Số điện thoại / tên đăng nhập", "0987…")
                    lockedField("Mật khẩu Viettel Post", "••••••••")
                }
                .opacity(0.5)
                PrimaryButton(title: "Đăng nhập", fontSize: 15, enabled: false) {}
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardStyle(20)
    }

    private func lockedField(_ label: String, _ placeholder: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            T(label, 12, .medium, Theme.muted)
            T(placeholder, 15, .semibold, Theme.placeholder)
                .padding(.horizontal, 15)
                .frame(maxWidth: .infinity, minHeight: 48, maxHeight: 48, alignment: .leading)
                .cardStyle(14, fill: Theme.field)
        }
    }

    // MARK: Chưa đăng nhập / phiên hết

    private var loginCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                T(adding ? "Thêm tài khoản" : (active.sessionExpired ? "Đăng nhập lại" : "Đăng nhập trên máy này"), 15, .bold)
                Spacer()
                if active.sessionExpired {
                    Badge(text: "Cần đăng nhập lại", color: Theme.red, fill: Theme.redSoft)
                } else {
                    Badge(text: "Chưa đăng nhập", color: Theme.muted, fill: Theme.grayBadge)
                }
            }
            T(adding
              ? "Đăng nhập thêm một tài khoản Viettel Post để đẩy nháp. Tài khoản đang có vẫn giữ phiên. Mật khẩu chỉ gửi thẳng tới Viettel Post. Lần đầu Viettel Post sẽ gửi mã OTP."
              : (active.sessionExpired
                 ? "Phiên Viettel Post của tài khoản này đã hết hạn. Nhập mật khẩu để đăng nhập lại."
                 : "Nên dùng cùng tài khoản Viettel Post ở phần 1. Mật khẩu chỉ gửi thẳng tới Viettel Post, không lưu trên máy chủ ChốtLive. Lần đầu trên máy này Viettel Post sẽ gửi mã OTP."),
              12.5, .medium, Theme.muted)
                .fixedSize(horizontal: false, vertical: true)
            LabeledField(label: "Số điện thoại / tên đăng nhập", placeholder: "0987…", text: $user,
                         keyboard: .asciiCapable, capitalize: false, contentType: .username)
            PasswordField(label: "Mật khẩu Viettel Post", text: $password)
            errorText
            HStack(spacing: 8) {
                if adding {
                    OutlineButton(title: "Huỷ") { vtpDrafts.remove(active.accountId) }
                }
                PrimaryButton(title: active.loading ? "Đang đăng nhập…" : "Đăng nhập", fontSize: 15, height: adding ? 44 : 52,
                              enabled: !active.loading && !user.trimmingCharacters(in: .whitespaces).isEmpty && !password.isEmpty) {
                    let u = user, p = password
                    let c = active
                    // Mật khẩu chỉ cần cho một lần gửi: xoá khỏi ô ngay sau khi lấy ra.
                    password = ""
                    Task { @MainActor in
                        await c.startLogin(user: u, password: p)
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
        let step = active.otpStep
        let hasPhone = (step?.phone.filter(\.isNumber).count ?? 0) >= 9
        let hasEmail = !(step?.email ?? "").isEmpty
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
                if hasPhone || !hasEmail {
                    channelButton("PHONE", "SMS " + VtpMask.text(step?.phone ?? ""))
                }
                if hasEmail { channelButton("EMAIL", "Email " + Self.maskEmail(step?.email ?? "")) }
            }
            if step?.sentType != nil {
                LabeledField(label: "Mã OTP", placeholder: "6 số", text: $code, keyboard: .numberPad,
                             capitalize: false, contentType: .oneTimeCode)
                resendRow
            }
            errorText
            HStack(spacing: 8) {
                OutlineButton(title: "Huỷ") {
                    active.cancelOtp()
                    code = ""
                }
                PrimaryButton(title: active.loading ? "Đang xác nhận…" : "Xác nhận", fontSize: 15, height: 44,
                              enabled: !active.loading && step?.sentType != nil && code.filter(\.isNumber).count >= 4) {
                    let digits = code.filter(\.isNumber)
                    let c = active
                    Task { @MainActor in
                        await c.verifyOtp(digits)
                        if vtpDrafts.currentId == c.accountId && c.otpStep == nil { code = "" }
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
        let on = active.otpStep?.sentType == type
        return Button {
            guard !active.loading else { return }
            let c = active
            Task { @MainActor in
                await c.sendOtp(type)
                if vtpDrafts.currentId == c.accountId && c.otpStep?.sentType == type { sentAt = Date() }
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
                } else if let type = active.otpStep?.sentType {
                    Button {
                        let c = active
                        Task { @MainActor in
                            await c.sendOtp(type)
                            if vtpDrafts.currentId == c.accountId { sentAt = Date() }
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
                if !active.sessionExpired { Badge(text: "Đã đăng nhập", color: Theme.green, fill: Theme.greenSoft) }
            }
            HStack(spacing: 10) {
                T("VTP", 12, .heavy, .white)
                    .frame(width: 36, height: 36)
                    .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Color(hex: 0xEE0033)))
                VStack(alignment: .leading, spacing: 2) {
                    T(active.displayName.isEmpty ? (active.phone.isEmpty ? "Tài khoản Viettel Post" : active.phone)
                                                 : active.displayName, 14, .bold).lineLimit(1)
                    T(active.phone.isEmpty ? "Chưa biết số: đăng xuất rồi đăng nhập lại một lần" : active.phone,
                      12, .medium, Theme.muted).lineLimit(1).minimumScaleFactor(0.8)
                }
            }
            khoList
            HStack {
                T("Phiên", 13, .medium, Theme.muted)
                Spacer()
                T(sessionText, 13, .bold, active.sessionExpired ? Theme.red : Theme.ink)
            }
            errorText
            HStack(spacing: 8) {
                OutlineButton(title: "Mở viettelpost.vn") {
                    if let url = URL(string: "https://viettelpost.vn/") { UIApplication.shared.open(url) }
                }
                OutlineButton(title: "Đăng xuất", color: Theme.red) {
                    let id = active.accountId
                    let name = active.accountLabel
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
                if active.loadingKho {
                    ProgressView().scaleEffect(0.8)
                } else {
                    Button {
                        let c = active
                        Task { @MainActor in await c.loadKho() }
                    } label: { T("Tải lại", 12.5, .bold, Theme.accent) }
                        .buttonStyle(.plain)
                }
            }
            if active.kho.isEmpty && !active.loadingKho {
                T("Chưa đọc được kho. Thêm kho ở viettelpost.vn › Quản lý kho rồi bấm Tải lại.", 12.5, .medium, Theme.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            ForEach(active.kho) { k in
                Button {
                    active.pickKho(k.id)
                } label: {
                    HStack(alignment: .top, spacing: 10) {
                        TickCircle(on: active.selectedKho?.id == k.id).padding(.top, 2)
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
        if active.sessionExpired { return "đã hết, đăng nhập lại" }
        return "tự làm mới"
    }

    private func mismatchCard(_ text: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                T("Khác tài khoản", 14, .bold)
                Spacer()
                Badge(text: "Cảnh báo", color: Theme.gomInk, fill: Theme.gomTag)
            }
            T(text, 12.5, .semibold, Theme.gomInk).fixedSize(horizontal: false, vertical: true)
            if let match = vtpDrafts.matchingPartner(client.vtp?.phone) {
                Button { vtpDrafts.select(match.accountId) } label: {
                    T("Chuyển sang \(match.accountLabel)", 13, .bold, Theme.accent)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 20, style: .continuous).fill(Theme.gomTag.opacity(0.6)))
    }

    @ViewBuilder private var errorText: some View {
        if let e = active.lastError, !e.isEmpty {
            T(e, 12.5, .semibold, Theme.red).fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: Tiện ích

    /// Phần 2 đăng nhập khác số với tài khoản đối tác ở phần 1: nháp và vận đơn sẽ nằm ở hai tài khoản.
    private var accountMismatch: String? {
        guard let partner = client.vtp?.phone, client.vtpConnected else { return nil }
        let activeRaw = active.login.isEmpty ? active.userName : active.login
        guard VtpDraftClient.phonesMatch(partner, activeRaw) == false else { return nil }
        let shown = active.phone.isEmpty ? active.accountLabel : active.phone
        return "Tài khoản đang dùng để đẩy nháp (\(shown)) khác phần 1 (\(VtpMask.text(partner))). Nháp sẽ nằm ở tài khoản khác với vận đơn."
    }

    /// Đang thêm tài khoản thứ hai trở đi (đã có tài khoản khác đăng nhập).
    private var adding: Bool {
        !active.loggedIn && vtpDrafts.loggedInClients.contains { $0 !== active }
    }

    /// 9 số cuối của số điện thoại, để so 0987… với +84987….
    static func phoneKey(_ s: String) -> String { VtpDraftClient.phoneKey(s) }

    static func maskEmail(_ e: String) -> String {
        let parts = e.split(separator: "@", maxSplits: 1).map(String.init)
        guard parts.count == 2, let first = parts[0].first else { return e }
        return "\(first)***@\(parts[1])"
    }

    /// Chưa tự chọn kho: lấy kho trùng điểm lấy hàng ở phần 1 (theo địa chỉ hoặc tên),
    /// chỉ áp dụng khi tài khoản đẩy nháp trùng phần 1 (hoặc chưa rõ số).
    private func matchKhoToSender() {
        guard !active.khoPicked, let s = client.vtp?.sender else { return }
        if let partner = client.vtp?.phone, !partner.isEmpty {
            let activeRaw = active.login.isEmpty ? active.userName : active.login
            if VtpDraftClient.phonesMatch(partner, activeRaw) == false { return }
        }
        let norm = { (x: String) in x.lowercased().filter { $0.isLetter || $0.isNumber } }
        if let k = active.kho.first(where: { norm($0.address) == norm(s.address) && !s.address.isEmpty })
            ?? active.kho.first(where: { norm($0.name) == norm(s.name) && !s.name.isEmpty }) {
            active.khoId = k.id
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
                if !c.loggedIn && c.otpStep != nil {
                    Badge(text: "Đang nhập OTP", color: Theme.accent, fill: Theme.peachSoft)
                } else if !c.loggedIn {
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
        if !c.loggedIn && c.userName.isEmpty {
            if let p = c.otpStep?.phone, !p.isEmpty { return VtpMask.text(p) }
            return "Tài khoản mới"
        }
        return c.displayName.isEmpty ? (c.phone.isEmpty ? "Tài khoản Viettel Post" : c.phone) : c.displayName
    }

    private var subtitle: String {
        [c.displayName.isEmpty ? "" : c.phone, c.selectedKho?.name ?? ""].filter { !$0.isEmpty }.joined(separator: " · ")
    }
}
