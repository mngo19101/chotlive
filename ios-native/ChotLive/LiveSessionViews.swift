import SwiftUI
import UIKit

// MARK: - Live mới

/// Đọc tên tài khoản từ chữ người dùng nhập hoặc link phiên live.
enum LiveId {
    static func parse(_ raw: String) -> String? {
        let s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if let r = s.range(of: #"@[A-Za-z0-9._]+"#, options: .regularExpression) { return String(s[r].dropFirst()) }
        return s.range(of: #"^[A-Za-z0-9._]+$"#, options: .regularExpression) != nil ? s : nil
    }
}

struct LiveNewSheet: View {
    @EnvironmentObject var client: LiveClient
    @EnvironmentObject var store: Store
    @EnvironmentObject var ui: AppUI
    @State private var input = ""
    @State private var remember = true
    /// ID vừa bấm theo dõi, đang chờ server nối xong.
    @State private var pendingId: String?
    @State private var timeoutMessage: String?

    private var isConnecting: Bool {
        guard client.serverSupportsSync else { return client.liveState == "connecting" }
        guard let pendingId else { return false }
        return client.live(for: pendingId)?.state != "connected"
    }
    private var errorMessage: String? {
        if let access = client.access, !access.canFollowLive { return access.message }
        if let timeoutMessage { return timeoutMessage }
        if client.serverSupportsSync {
            guard let e = client.lastLiveEvent, e.state == "error" || e.state == "ended", !e.message.isEmpty else { return nil }
            return e.username.isEmpty ? e.message : "@\(e.username): \(e.message)"
        }
        let failed = ["error", "ended", "disconnected"].contains(client.liveState) && !client.liveMessage.isEmpty
        return failed ? client.liveMessage : nil
    }
    private var liveId: String? { LiveId.parse(input) }
    private var inputEmpty: Bool { input.trimmingCharacters(in: .whitespaces).isEmpty }
    private var inputInvalid: Bool { !inputEmpty && liveId == nil }
    /// ID đang được tô sáng: nút dưới cùng bắt đầu ID này khi chưa nhập ID mới.
    private var highlighted: TikTokAccount? { store.accounts.first { $0.id == store.activeAccountId } }
    private var canStart: Bool { !isConnecting && (inputEmpty ? highlighted != nil : liveId != nil) }

    /// ID live gần đây nhất đứng trước.
    private var saved: [TikTokAccount] {
        store.accounts.sorted {
            (store.lastSession(account: $0.id)?.start ?? .distantPast) > (store.lastSession(account: $1.id)?.start ?? .distantPast)
        }
    }

    var body: some View {
        startBody
            .onChange(of: client.lives) { lives in
                guard let id = pendingId, let live = lives.first(where: { $0.id == id.lowercased() }),
                      live.state == "connected" else { return }
                pendingId = nil
                ui.dismissSheet()
                if !live.sessionId.isEmpty { ui.push(.session(live.sessionId)) }
            }
            .onChange(of: client.lastLiveEvent?.message) { message in
                // Live vừa bấm không vào được: mở lại nút để người dùng thử ID khác.
                if message != nil, let e = client.lastLiveEvent, e.username.lowercased() == pendingId?.lowercased() {
                    pendingId = nil
                }
            }
            .onChange(of: client.liveState) { state in
                // Server bản cũ: mỗi tài khoản chỉ một live.
                guard !client.serverSupportsSync, state == "connected" else { return }
                ui.dismissSheet()
                if let open = store.openSession { ui.push(.session(open.id)) }
            }
    }

    /// Các live đang theo dõi; thêm live mới không làm dừng các live này.
    private var followingSection: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack {
                T("Đang theo dõi", 15, .bold)
                Spacer()
                T("\(client.lives.count) live", 12.5, .medium, Theme.muted)
            }
            ForEach(client.lives) { live in
                HStack(spacing: 10) {
                    Circle().fill(live.state == "connected" ? Theme.green : Theme.orange).frame(width: 8, height: 8)
                    VStack(alignment: .leading, spacing: 1) {
                        T("@" + live.username, 14.5, .bold).lineLimit(1)
                        T(live.state == "connected" ? "\(live.viewers) người xem" : "Đang nối lại...", 12.5, .medium, Theme.muted)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 8)
                    Button { client.disconnectLive(live.username) } label: {
                        T("Dừng", 13.5, .bold, Theme.red)
                            .frame(width: 64, height: 34)
                            .background(Capsule().fill(Theme.card).overlay(Capsule().strokeBorder(Theme.line, lineWidth: 1)))
                    }
                    .buttonStyle(.plain)
                }
                .padding(.horizontal, 14)
                .frame(height: 58)
                .contentShape(Rectangle())
                .onTapGesture {
                    guard !live.sessionId.isEmpty else { return }
                    ui.dismissSheet()
                    ui.push(.session(live.sessionId))
                }
                .cardStyle(18)
            }
        }
    }

    private var startBody: some View {
        VStack(spacing: 0) {
            ScrollView(showsIndicators: false) {
                VStack(alignment: .leading, spacing: 0) {
                    SheetTitle(title: "Live mới", subtitle: "Chọn ID đã lưu hoặc nhập ID TikTok Live mới", size: 23)
                        .padding(.top, 7)
                    if !client.lives.isEmpty {
                        followingSection.padding(.top, 17.8)
                    }
                    if !saved.isEmpty {
                        HStack {
                            T("ID đã lưu", 15, .bold)
                            Spacer()
                            T("Bấm để bắt đầu ngay", 12.5, .medium, Theme.muted)
                        }
                        .padding(.top, 17.8)
                        VStack(spacing: 11) {
                            ForEach(saved) { savedCard($0) }
                        }
                        .padding(.top, 15)
                        orDivider.padding(.top, 16.4)
                    }
                    (T("ID TikTok Live ", 13, .semibold, Theme.muted) + T("*", 14, .bold, Theme.red))
                        .padding(.top, saved.isEmpty ? 20 : 16.8)
                    idField.padding(.top, 6.4)
                    if inputInvalid {
                        T("Không đọc được tên tài khoản. Hãy nhập tên dạng ten.tai.khoan.", 12.5, .medium, Theme.red).padding(.top, 5.6)
                    } else {
                        T("Nhập tên tài khoản đang live hoặc dán link phiên live.", 12.5, .medium, Theme.muted).padding(.top, 5.6)
                    }
                    if let errorMessage {
                        T(errorMessage, 12.5, .medium, Theme.red).padding(.top, 4)
                    }
                    rememberRow.padding(.top, 16.5)
                }
                .padding(.horizontal, Metrics.gutter)
                .padding(.bottom, 12)
            }
            .scrollDismissesKeyboard(.interactively)

            HairLine()
            PrimaryButton(title: isConnecting ? "Đang kết nối..." : (client.lives.isEmpty ? "Bắt đầu live" : "Theo dõi thêm live này"),
                          fontSize: 18, height: 55.5,
                          enabled: canStart) {
                if let id = liveId {
                    startNew(id)
                } else if let account = highlighted {
                    start(account)
                }
            }
            .padding(.horizontal, Metrics.gutter)
            .padding(.top, 13)
        }
        .frame(height: Metrics.sheetHeight(top: 112))
    }

    /// Chờ quá lâu mà server không trả lời thì mở lại nút và báo lỗi, thay vì kẹt "Đang kết nối...".
    private func watchPending(_ id: String) {
        timeoutMessage = nil
        guard client.socketConnected else {
            pendingId = nil
            timeoutMessage = "Chưa nối được tới server. Kiểm tra mạng rồi thử lại."
            return
        }
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 45_000_000_000)
            guard pendingId?.lowercased() == id.lowercased(), isConnecting else { return }
            pendingId = nil
            timeoutMessage = "TikTok phản hồi quá lâu. Kiểm tra @\(id) có đang live không rồi thử lại."
        }
    }

    private func start(_ account: TikTokAccount) {
        guard !isConnecting else { return }
        store.unsavedLiveId = nil
        // Đang theo dõi live khác thì giữ nguyên ID đang chọn.
        if client.lives.isEmpty { store.selectAccount(account.id) }
        pendingId = account.uniqueId
        client.connectLive(tiktok: account.uniqueId)
        watchPending(account.uniqueId)
    }

    private func startNew(_ id: String) {
        // Live này đang được theo dõi rồi: mở luôn phiên của nó.
        if let running = client.live(for: id), running.state == "connected", !running.sessionId.isEmpty {
            ui.dismissSheet()
            ui.push(.session(running.sessionId))
            return
        }
        if remember {
            store.unsavedLiveId = nil
            store.addAccount(uniqueId: id, displayName: "", activate: true)
        } else {
            store.unsavedLiveId = id.lowercased()
        }
        pendingId = id
        client.connectLive(tiktok: id)
        watchPending(id)
    }

    private func lastLiveText(_ account: TikTokAccount) -> String {
        let handle = "@" + account.uniqueId
        guard let start = store.lastSession(account: account.id)?.start else { return handle }
        if Clock.isToday(start) { return "\(handle) · hôm nay \(timeText(start))" }
        if Clock.isYesterday(start) { return "\(handle) · hôm qua \(timeText(start))" }
        return "\(handle) · \(shortDate(start))"
    }

    /// Không cho xoá ID đang live hoặc đang kết nối, tránh mất dấu phiên đang mở.
    private func isLive(_ account: TikTokAccount) -> Bool {
        client.live(for: account.uniqueId) != nil
            || (!client.serverSupportsSync && client.liveState != "idle" && account.uniqueId.lowercased() == client.liveUsername.lowercased())
    }

    private func savedCard(_ account: TikTokAccount) -> some View {
        let active = account.id == store.activeAccountId
        let following = client.live(for: account.uniqueId)
        return Button {
            if let following {
                guard !following.sessionId.isEmpty else { return }
                ui.dismissSheet()
                ui.push(.session(following.sessionId))
            } else {
                start(account)
            }
        } label: {
            HStack(spacing: 0) {
                Avatar(text: account.initials, size: 44, fontSize: 15, seed: account.id)
                VStack(alignment: .leading, spacing: 1) {
                    T(account.displayName, 16.2, .bold).lineLimit(1)
                    T(lastLiveText(account), 13, .medium, Theme.muted)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.leading, 12)
                .padding(.trailing, 8)
                T(following == nil ? "Bắt đầu" : "Đang live", 15, .bold)
                    .fixedSize()
                    .frame(width: 88, height: 36)
                    .background(
                        Capsule().fill(active ? Theme.orange : Theme.card)
                            .overlay(Capsule().strokeBorder(active ? Color.clear : Theme.line, lineWidth: 1))
                    )
                    .onAccent(active)
            }
            .padding(.horizontal, 15)
            .padding(.vertical, 11.6)
            .frame(maxWidth: .infinity, minHeight: 69.3)
            .cardStyle(22, fill: active ? Theme.peachRow : Theme.card, border: active ? Theme.peachLine : Theme.line)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .contextMenu {
            if !isLive(account) {
                Button("Xoá ID này", role: .destructive) { store.removeAccount(account.id) }
            }
        }
    }

    private var orDivider: some View {
        HStack(spacing: 12) {
            HairLine()
            T("hoặc nhập ID mới", 12.5, .semibold, Theme.muted).fixedSize()
            HairLine()
        }
    }

    private var idField: some View {
        HStack(spacing: 8) {
            T("@", 16, .bold, Theme.muted)
            ZStack(alignment: .leading) {
                if input.isEmpty { T("ten.tai.khoan", 16, .semibold, Theme.placeholder).lineLimit(1) }
                TextField("", text: $input)
                    .font(.bv(16, .semibold))
                    .foregroundColor(Theme.ink)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            }
            Button {
                if let text = UIPasteboard.general.string {
                    input = LiveId.parse(text) ?? text.trimmingCharacters(in: .whitespacesAndNewlines)
                }
            } label: {
                T("Dán", 13.5, .bold)
                    .frame(width: 54, height: 36)
                    .background(Capsule().fill(Theme.grayBadge))
            }
            .buttonStyle(.plain)
        }
        .padding(.leading, 17)
        .padding(.trailing, 9)
        .frame(height: 51.5)
        .cardStyle(22, fill: Theme.field)
    }

    private var rememberRow: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                T("Lưu ID này cho lần sau", 15, .bold)
                T("Lần sau chỉ cần bấm vào ID đã lưu", 13, .medium, Theme.muted)
            }
            Spacer(minLength: 8)
            Button { remember.toggle() } label: {
                ZStack(alignment: remember ? .trailing : .leading) {
                    Capsule().fill(remember ? Theme.orange : Theme.bar)
                    Circle().fill(Color.white).frame(width: 24, height: 24).padding(.horizontal, 4)
                }
                .frame(width: 52, height: 32)
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 2)
    }
}

// MARK: - Chi tiết phiên live

struct SessionDetailView: View {
    let sessionId: String
    @EnvironmentObject var store: Store
    @EnvironmentObject var client: LiveClient
    @EnvironmentObject var printer: PrinterManager
    @EnvironmentObject var ui: AppUI
    @State private var tab = 0 // 0 tất cả, 1 chốt đơn, 2 khách mới
    @State private var searching = false
    @State private var search = ""
    @State private var atTop = true
    /// Đang cuộn xuống đọc: chỉ hiện bình luận tới mốc này để danh sách không bị đẩy xuống khi có bình luận mới.
    @State private var frozenAt: Date?
    /// Bình luận cũ vừa tải từ server, chỉ giữ khi đang mở màn này.
    @State private var older: [LiveComment] = []
    @State private var loadingOlder = false
    @State private var olderExhausted = false

    private var session: LiveSession? { store.sessions.first { $0.id == sessionId } }

    /// Mới nhất trên cùng.
    private var all: [LiveComment] { store.sessionComments(sessionId, older: older) }

    private var isDemo: Bool {
        #if DEBUG
        return Demo.isActive
        #else
        return false
        #endif
    }

    private func customer(of c: LiveComment, in map: [String: Customer]) -> Customer? {
        map[Store.key(uniqueId: c.uniqueId, userId: c.userId)]
    }

    private func isNew(_ customer: Customer?) -> Bool {
        guard let customer, let session, !customer.items.isEmpty else { return false }
        return Calendar.current.isDate(customer.firstTs, inSameDayAs: session.start)
    }

    private var customerMap: [String: Customer] {
        Dictionary(store.customers.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
    }

    private func counts(_ comments: [LiveComment], _ map: [String: Customer]) -> (closing: Int, newCustomers: Int) {
        #if DEBUG
        if Demo.isActive { return (31, 9) }
        #endif
        let closing = comments.filter(store.isClosingComment).count
        let newCustomers = Set(comments.compactMap { c -> String? in
            let owner = customer(of: c, in: map)
            return isNew(owner) ? owner?.id : nil
        }).count
        return (closing, newCustomers)
    }

    var body: some View {
        let comments = all
        let map = customerMap
        let count = counts(comments, map)
        let matching = filter(comments, map)
        let shown = frozenAt.map { at in matching.filter { $0.ts <= at } } ?? matching
        let pending = isDemo ? 12 : matching.count - shown.count
        let newest = comments.first?.ts

        return SubPage(title: session?.title ?? "Phiên live", subtitle: subtitle, accessory: liveBadge, headerBottom: 16, trailing: {
            CircleButton(icon: .search) {
                searching.toggle()
                if !searching { search = "" }
            }
        }) {
            ScrollViewReader { proxy in
                ScrollView(showsIndicators: false) {
                    VStack(spacing: 13.5) {
                        if searching { SearchField(text: $search) }
                        if let s = session { summaryCard(s) }
                        tabs(total: session?.commentCount ?? comments.count, count)
                        // Mốc đầu danh sách: biết đang ở trên cùng hay đã cuộn xuống đọc.
                        Color.clear
                            .frame(height: 1)
                            .id("top")
                            .background(GeometryReader { g in
                                Color.clear.preference(key: CommentTopOffsetKey.self, value: g.frame(in: .named("commentScroll")).minY)
                            })
                        if shown.isEmpty {
                            T(emptyText, 13, .medium, Theme.muted)
                                .padding(.top, 24)
                        }
                        LazyVStack(spacing: 9) {
                            ForEach(shown) { c in
                                let owner = customer(of: c, in: map)
                                CommentRow(c: c, closing: store.isClosingComment(c), customer: owner, isNew: isNew(owner)) {
                                    Task { @MainActor in
                                        ui.notify(await printComment(c, store: store, printer: printer))
                                    }
                                }
                                .id(c.id)
                            }
                        }
                        // Bình luận cũ nằm dưới cùng nên nút tải phần cũ cũng ở dưới.
                        if !isDemo, let total = session?.commentCount, total > comments.count {
                            olderControl(loaded: comments.count, total: total)
                        }
                    }
                    .padding(.horizontal, Metrics.gutter)
                    .padding(.bottom, 56)
                }
                .coordinateSpace(name: "commentScroll")
                .scrollDismissesKeyboard(.interactively)
                .onPreferenceChange(CommentTopOffsetKey.self) { y in
                    let top = y > -80
                    guard top != atTop else { return }
                    atTop = top
                    frozenAt = top ? nil : (newest ?? Date())
                }
                .task(id: client.serverSupportsSync) {
                    // Phiên cũ đã hết bình luận trên máy: tự tải luôn, khỏi thấy màn trống.
                    guard !isDemo, client.serverSupportsSync, all.isEmpty, (session?.commentCount ?? 0) > 0 else { return }
                    await loadOlder()
                }
                .overlay(alignment: .bottom) {
                    if pending > 0 {
                        newCommentsPill(pending) {
                            frozenAt = nil
                            withAnimation { proxy.scrollTo("top", anchor: .top) }
                        }
                    }
                }
            }
        }
    }

    private var emptyText: String {
        if loadingOlder { return "Đang tải bình luận..." }
        return session?.isLive == true ? "Đang chờ bình luận..." : "Không có bình luận phù hợp."
    }

    /// Nút tải phần cũ từ server, đặt cuối danh sách vì bình luận cũ nằm ở dưới.
    @ViewBuilder
    private func olderControl(loaded: Int, total: Int) -> some View {
        VStack(spacing: 8) {
            T(olderNote(loaded: loaded, total: total), 12.5, .medium, Theme.muted)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            if client.serverSupportsSync && !olderExhausted {
                Button {
                    Task { @MainActor in await loadOlder() }
                } label: {
                    HStack(spacing: 8) {
                        if loadingOlder { ProgressView().controlSize(.small) }
                        T(loadingOlder ? "Đang tải..." : "Xem bình luận cũ hơn", 13.5, .bold)
                    }
                    .frame(maxWidth: .infinity)
                    .frame(height: 44)
                    .background(
                        Capsule().fill(Theme.card)
                            .overlay(Capsule().strokeBorder(Theme.line, lineWidth: 1))
                    )
                }
                .buttonStyle(.plain)
                .disabled(loadingOlder)
            }
        }
    }

    private func olderNote(loaded: Int, total: Int) -> String {
        if olderExhausted { return "Đã hiện hết \(loaded) bình luận server còn lưu, trên tổng \(total) bình luận của phiên." }
        if !client.serverSupportsSync { return "Đang hiện \(loaded)/\(total) bình luận. Cần kết nối server để xem phần cũ hơn." }
        if !search.isEmpty || tab != 0 { return "Đã tải \(loaded)/\(total) bình luận. Chỉ lọc và tìm trong phần đã tải." }
        return "Đang hiện \(loaded)/\(total) bình luận."
    }

    @MainActor
    private func loadOlder() async {
        guard !loadingOlder else { return }
        loadingOlder = true
        defer { loadingOlder = false }
        guard let page = await client.fetchOlderComments(sessionId: sessionId, before: CommentCursor.oldest(in: all)) else {
            if !Task.isCancelled { ui.notify("Không tải được bình luận cũ. Kiểm tra kết nối rồi thử lại.") }
            return
        }
        older.append(contentsOf: page.comments)
        olderExhausted = !page.hasMore
    }

    private var subtitle: String {
        guard let s = session else { return "" }
        if let end = s.end { return "\(timeText(s.start)) – \(timeText(end)) · \(s.duration)" }
        return "Từ \(timeText(s.start)) · \(s.duration)"
    }

    private var liveBadge: AnyView? {
        guard session?.isLive == true else { return nil }
        return AnyView(
            HStack(spacing: 5) {
                Circle().fill(Theme.live.opacity(0.4)).frame(width: 7, height: 7)
                T("Live", 13, .bold, Theme.red)
            }
            .padding(.horizontal, 9)
            .frame(height: 24)
            .background(Capsule().fill(Theme.redSoft))
        )
    }

    private func filter(_ comments: [LiveComment], _ map: [String: Customer]) -> [LiveComment] {
        var list = comments
        switch tab {
        case 1: list = list.filter(store.isClosingComment)
        case 2: list = list.filter { isNew(customer(of: $0, in: map)) }
        default: break
        }
        let q = search.trimmingCharacters(in: .whitespaces).lowercased()
        if !q.isEmpty {
            list = list.filter {
                $0.nickname.lowercased().contains(q) || $0.uniqueId.lowercased().contains(q) || $0.text.lowercased().contains(q)
            }
        }
        return list
    }

    private func summaryCard(_ s: LiveSession) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(spacing: 8) {
                if s.isLive { Circle().fill(Theme.live).frame(width: 8, height: 8) }
                T(s.tiktok.isEmpty ? "Tài khoản TikTok" : "@\(s.tiktok)", 13.5, .medium, Theme.muted).lineLimit(1)
                if s.isLive, client.live(for: s.tiktok)?.state == "reconnecting" {
                    T("· đang nối lại", 12.5, .medium, Theme.accent).lineLimit(1)
                }
                Spacer(minLength: 4)
                if s.isLive, client.live(for: s.tiktok) != nil {
                    Button {
                        let tiktok = s.tiktok
                        ui.confirm = ConfirmItem(title: "Dừng theo dõi live này?", message: "@\(tiktok) sẽ không được ghi bình luận nữa. Các live khác vẫn chạy.",
                                                 action: "Dừng") { client.disconnectLive(tiktok) }
                    } label: {
                        T("Dừng", 13, .bold, Theme.red)
                    }
                    .buttonStyle(.plain)
                    .padding(.trailing, 13)
                }
            }
            .padding(.leading, 13)
            HStack(spacing: 0) {
                stat("\(s.commentCount)", "bình luận")
                Rectangle().fill(Theme.line).frame(width: 1, height: 44)
                stat("\(store.sessionCustomerCount(s.id))", "khách")
                Rectangle().fill(Theme.line).frame(width: 1, height: 44)
                stat("\(store.sessionOrderCount(s.id))", "đơn")
            }
        }
        .padding(.horizontal, 6)
        .padding(.top, 12)
        .padding(.bottom, 11)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardStyle(24)
    }

    private func stat(_ value: String, _ label: String) -> some View {
        VStack(spacing: 2) {
            T(value, 23, .heavy, Theme.ink, track: -0.4).lineLimit(1)
            T(label, 12.5, .medium, Theme.muted).lineLimit(1)
        }
        .frame(maxWidth: .infinity)
    }

    private func tabs(total: Int, _ count: (closing: Int, newCustomers: Int)) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                tabChip("Tất cả", total, 0)
                tabChip("Chốt đơn", count.closing, 1)
                tabChip("Khách mới", count.newCustomers, 2)
            }
            .padding(.horizontal, Metrics.gutter)
        }
        .padding(.horizontal, -Metrics.gutter)
    }

    private func tabChip(_ title: String, _ count: Int, _ value: Int) -> some View {
        let selected = tab == value
        return Button { tab = value } label: {
            HStack(spacing: 6) {
                T(title, 14.4, .bold)
                T("\(count)", 13, selected ? .bold : .medium, selected ? Theme.ink : Theme.muted)
            }
            .fixedSize()
            .padding(.horizontal, 14)
            .frame(height: 38)
            .background(
                Capsule().fill(selected ? Theme.orange : Theme.card)
                    .overlay(Capsule().strokeBorder(selected ? Color.clear : Theme.line, lineWidth: 1))
            )
            .onAccent(selected)
        }
        .buttonStyle(.plain)
    }

    private func newCommentsPill(_ count: Int, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Icon(name: .arrowDown, size: 15, weight: 2.4, color: .white)
                    .rotationEffect(.degrees(180))
                T("\(count) bình luận mới", 13.5, .bold, .white).fixedSize()
            }
            .padding(.horizontal, 18)
            .frame(height: 40)
            .background(Capsule().fill(Theme.ink))
            .shadow(color: Color.black.opacity(0.18), radius: 10, y: 5)
        }
        .buttonStyle(.plain)
        .padding(.bottom, Metrics.safeBottom > 0 ? -5.5 : 12)
    }
}

/// Vị trí mốc đầu danh sách bình luận trong vùng cuộn.
private struct CommentTopOffsetKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

struct CommentRow: View {
    let c: LiveComment
    let closing: Bool
    let customer: Customer?
    let isNew: Bool
    let onPrint: () -> Void

    var body: some View {
        HStack(spacing: 9.7) {
            Avatar(text: initialsOf(c.nickname), size: 34, fontSize: 12.5, seed: c.uniqueId)
            VStack(alignment: .leading, spacing: closing ? 3.4 : 2) {
                HStack(spacing: 5) {
                    T(c.nickname, 13.4, .bold).lineLimit(1).layoutPriority(1)
                    if customer?.isBigSpender == true {
                        Badge(text: "Mua nhiều", color: Theme.accentDeep, fill: Theme.peachCode, fontSize: 11, height: 20, hPad: 6)
                    } else if isNew {
                        Badge(text: "Mới", color: Theme.green, fill: Theme.greenSoft, fontSize: 11, height: 20, hPad: 6)
                    } else {
                        T("@" + c.uniqueId, 11, .medium, Theme.muted).lineLimit(1)
                    }
                    Spacer(minLength: 0)
                    T(timeText(c.ts), 11, .medium, Theme.muted).fixedSize()
                    if closing {
                        Icon(name: .check, size: 10, weight: 3)
                            .frame(width: 18, height: 18)
                            .background(Circle().fill(Theme.orange))
                            .onAccent()
                    }
                }
                // Giữ chiều cao dòng tên để badge và dấu tích không đẩy hàng cao lên.
                .frame(height: 17)
                CommentText(text: c.text, size: 14, highlight: closing)
            }
            Button(action: onPrint) {
                Icon(name: .printer, size: 15, weight: 2.2)
                    .frame(width: 34, height: 34)
                    .background(Circle().fill(Theme.card).overlay(Circle().strokeBorder(Theme.line, lineWidth: 1)))
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 13)
        .padding(.vertical, 9.5)
        .cardStyle(20, fill: closing ? Theme.peachRow : Theme.card, border: closing ? Theme.peachLine : Theme.line)
    }
}

// MARK: - Bình luận chốt đơn của một đơn

struct OrderCommentsView: View {
    let orderId: String
    @EnvironmentObject var store: Store
    @EnvironmentObject var ui: AppUI

    /// Một bình luận cùng các sản phẩm nó sinh ra.
    private struct CommentGroup: Identifiable {
        var id: String
        var text: String
        var ts: Date
        var items: [OrderItem]
    }

    private func groups(_ o: Order) -> [CommentGroup] {
        // Đơn tạo tay không có bình luận.
        let commented = o.items.filter { !$0.comment.isEmpty }
        let byComment = Dictionary(grouping: commented) { $0.commentId ?? $0.id }
        var list: [CommentGroup] = []
        for (key, items) in byComment {
            let source = store.comments.first { $0.id == key }
            list.append(CommentGroup(id: key, text: source?.text ?? items[0].comment, ts: source?.ts ?? items[0].ts, items: items))
        }
        return list.sorted { $0.ts < $1.ts }
    }

    var body: some View {
        let order = store.order(id: orderId)
        SubPage(title: "Bình luận chốt đơn",
                subtitle: order.map { "Đơn của \($0.customer.displayName) · \(timeText($0.lastTs))" },
                headerBottom: 20) {
            if let o = order {
                let list = groups(o)
                ScrollView(showsIndicators: false) {
                    VStack(alignment: .leading, spacing: 0) {
                        summaryCard(o, commentCount: list.count)
                        HStack(alignment: .firstTextBaseline) {
                            T("Các bình luận đã chốt", 16.2, .bold).lineLimit(1)
                            Spacer()
                            T("Theo thời gian", 13.2, .medium, Theme.muted)
                        }
                        .padding(.horizontal, 4)
                        .padding(.top, 15)
                        VStack(spacing: 17) {
                            ForEach(list) { row($0) }
                        }
                        .padding(.top, 17)
                    }
                    .padding(.horizontal, Metrics.gutter)
                    .padding(.bottom, 16)
                }
                FooterBar {
                    PrimaryButton(title: "Xem chi tiết đơn", fontSize: 18, height: 55.5) { ui.push(.order(o.id)) }
                }
            } else {
                Spacer()
                T("Đơn không còn tồn tại", 14, .medium, Theme.muted)
                Spacer()
            }
        }
    }

    private func summaryCard(_ o: Order, commentCount: Int) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 11) {
                Avatar(text: o.customer.initials, size: 48, fontSize: 17, seed: o.customer.id)
                VStack(alignment: .leading, spacing: 0.5) {
                    T(o.customer.displayName, 17.5, .bold).lineLimit(1).minimumScaleFactor(0.8)
                    T("@" + o.customer.uniqueId, 13.5, .medium, Theme.muted).lineLimit(1)
                }
                Spacer(minLength: 4)
                Badge(text: "\(commentCount) bình luận", color: Theme.accentDeep, fill: Theme.peachTint, fontSize: 12.5, height: 28, hPad: 10)
            }
            HairLine().padding(.top, 14.6)
            HStack(alignment: .top) {
                if let s = store.sessions.first(where: { $0.id == o.items.first?.sessionId }) {
                    VStack(alignment: .leading, spacing: 1.6) {
                        T("Phiên live", 12.5, .semibold, Theme.muted)
                        T("\(s.title) · \(timeText(s.start))", 15, .bold).lineLimit(1).minimumScaleFactor(0.8)
                    }
                }
                Spacer(minLength: 8)
                VStack(alignment: .trailing, spacing: 1.6) {
                    T("Giá trị đơn", 12.5, .semibold, Theme.muted)
                    T("\(o.productCount) sản phẩm · \(money(o.total))", 15, .bold).lineLimit(1).minimumScaleFactor(0.8)
                }
            }
            .padding(.top, 13.5)
        }
        .padding(.horizontal, 19)
        .padding(.top, 16)
        .padding(.bottom, 17.2)
        .cardStyle(24)
    }

    private func row(_ g: CommentGroup) -> some View {
        HStack(alignment: .top, spacing: 0) {
            T(timeText(g.ts), 15.5, .heavy, Theme.ink, track: -0.2)
                .frame(width: 60, alignment: .leading)
                .padding(.top, 16)
            VStack(alignment: .leading, spacing: 13) {
                CommentText(text: g.text, size: 16)
                VStack(spacing: 7) {
                    ForEach(g.items) { it in
                        HStack(spacing: 8) {
                            Icon(name: .arrowRight, size: 14, weight: 2.3, color: Theme.accent)
                            T(it.productLabel, 13.1, .bold).lineLimit(1)
                            T("\(it.qty) × \(money(it.price))", 13, .medium, Theme.muted).lineLimit(1).minimumScaleFactor(0.8)
                            Spacer(minLength: 0)
                        }
                        .padding(.horizontal, 14)
                        .frame(height: 33.5)
                        .background(Capsule().fill(Theme.field))
                    }
                }
            }
            .padding(.horizontal, 16.5)
            .padding(.top, 15)
            .padding(.bottom, 15)
            .frame(maxWidth: .infinity, alignment: .leading)
            .cardStyle(22)
        }
    }
}
