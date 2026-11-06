import SwiftUI

// MARK: - Bình luận: danh sách phiên live

struct LiveView: View {
    @EnvironmentObject var client: LiveClient
    @EnvironmentObject var store: Store
    @EnvironmentObject var ui: AppUI
    @State private var filter = DateFilter.make(.today)

    private var sessions: [LiveSession] { store.sessions(in: filter) }

    private var commentCount: Int { sessions.reduce(0) { $0 + $1.commentCount } }

    var body: some View {
        ScrollView(showsIndicators: false) {
            VStack(spacing: Metrics.gap) {
                PageHeader(subtitle: "Các phiên live đã ghi lại", title: "Bình luận") {
                    HeaderAddButton(title: "Live mới") { ui.present { LiveNewSheet() } }
                }
                dateRow
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        presetChip("Hôm nay", .today)
                        presetChip("Hôm qua", .yesterday)
                        presetChip("7 ngày", .last7)
                        presetChip("Tháng này", .thisMonth)
                    }
                    .padding(.horizontal, Metrics.gutter)
                }
                .padding(.horizontal, -Metrics.gutter)

                statsCard

                VStack(spacing: 13) {
                    HStack {
                        T("Các phiên \(filter.scopeLabel)", 14, .bold).lineLimit(1)
                        Spacer()
                        T("\(sessions.count) phiên", 12, .medium, Theme.muted)
                    }
                    if sessions.isEmpty {
                        T("Chưa có phiên live nào. Bấm “Live mới” để bắt đầu đọc bình luận.", 13, .medium, Theme.muted)
                            .multilineTextAlignment(.center)
                            .padding(.top, 24)
                    }
                    VStack(spacing: 24) {
                        ForEach(sessions) { s in
                            Button { ui.push(.session(s.id)) } label: { sessionRow(s) }.buttonStyle(.plain)
                        }
                    }
                }
            }
            .padding(.horizontal, Metrics.gutter)
            .padding(.top, 6)
            .padding(.bottom, 16)
        }
        .background(Theme.bg)
    }

    private var dateRow: some View {
        HStack(spacing: 8) {
            CircleButton(icon: .chevronLeft) { filter = filter.shifted(-1) }
            Button {
                ui.present(dim: 0.9) { DateFilterSheet(filter: filter) { filter = $0 } }
            } label: {
                HStack(spacing: 10) {
                    Icon(name: .calendar, size: 17)
                    T(filter.pillLabel, 14, .bold).lineLimit(1).minimumScaleFactor(0.8)
                    Icon(name: .chevronDown, size: 15, weight: 2.4)
                }
                .frame(maxWidth: .infinity)
                .frame(height: 44)
                .background(Capsule().fill(Theme.card).overlay(Capsule().strokeBorder(Theme.ink, lineWidth: 1.2)))
            }
            .buttonStyle(.plain)
            CircleButton(icon: .chevronRight, enabled: filter.canGoNext) { filter = filter.shifted(1) }
        }
    }

    private func presetChip(_ title: String, _ preset: DateFilter.Preset) -> some View {
        Chip(title: title, selected: filter.preset == preset) { filter = DateFilter.make(preset) }
    }

    private var statsCard: some View {
        VStack(spacing: 0) {
            VStack(spacing: 8) {
                HStack(spacing: 8) {
                    statTile(.radio, "\(sessions.count)", "phiên live")
                    statTile(.message, "\(commentCount)", "bình luận")
                }
                HStack(spacing: 8) {
                    statTile(.users, "\(store.customerCount(in: filter))", "khách")
                    statTile(.bag, "\(store.orders(in: filter).count)", "đơn")
                }
            }
            Timeline(sessions: sessions, showNow: filter.contains(Clock.now) && store.openSession != nil)
                .padding(.top, 15)
        }
        .padding(.horizontal, 17)
        .padding(.top, 16)
        .padding(.bottom, 14)
        .cardStyle(24)
    }

    private func statTile(_ icon: IconName, _ value: String, _ label: String) -> some View {
        HStack(spacing: 8) {
            Icon(name: icon, size: 15, color: Theme.accent)
                .frame(width: 28, height: 28)
                .background(Circle().fill(Theme.peachSoft))
            (Text(verbatim: value).font(.bv(16, .heavy)).foregroundColor(Theme.ink)
                + Text(verbatim: " " + label).font(.bv(12, .medium)).foregroundColor(Theme.muted))
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            Spacer(minLength: 0)
        }
        .padding(.leading, 10)
        .frame(maxWidth: .infinity)
        .frame(height: 44)
        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Theme.field))
    }

    private func sessionRow(_ s: LiveSession) -> some View {
        HStack(alignment: .top, spacing: 13) {
            VStack(spacing: 4) {
                T(timeText(s.start), 15, .heavy, Theme.ink, track: -0.3)
                Rectangle().fill(Theme.bar).frame(width: 3, height: 14)
                if let end = s.end {
                    T(timeText(end), 14, .medium, Theme.muted)
                } else {
                    T("Đang live", 12, .semibold, Theme.red)
                        .multilineTextAlignment(.leading)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .frame(width: 50)

            HStack(spacing: 8) {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 8) {
                        T(s.title, 15, .bold).lineLimit(1)
                        if s.isLive {
                            HStack(spacing: 5) {
                                Circle().fill(Theme.live).frame(width: 6, height: 6)
                                T("Live", 12, .semibold, Theme.red)
                            }
                            .padding(.horizontal, 10)
                            .frame(height: 21)
                            .background(Capsule().fill(Theme.card))
                        }
                        T(s.duration, 12, .medium, Theme.muted).lineLimit(1)
                    }
                    HStack(spacing: 12) {
                        count(.message, s.commentCount)
                        count(.users, store.sessionCustomerCount(s.id))
                        count(.bag, store.sessionOrderCount(s.id))
                    }
                }
                Spacer(minLength: 0)
                Icon(name: .chevronRight, size: 16, color: Theme.ink)
            }
            .padding(.horizontal, 14)
            .frame(height: s.isLive ? 70 : 67)
            .cardStyle(18, fill: s.isLive ? Theme.peachSoft : Theme.card, border: s.isLive ? Theme.peachLine : Theme.line)
        }
    }

    private func count(_ icon: IconName, _ value: Int) -> some View {
        HStack(spacing: 5) {
            Icon(name: icon, size: 15, color: Theme.muted)
            T("\(value)", 13, .bold)
        }
    }
}

/// Thanh 0h–24h: các đoạn cam là phiên live, vạch đỏ là hiện tại.
struct Timeline: View {
    let sessions: [LiveSession]
    let showNow: Bool

    private func fraction(_ d: Date) -> CGFloat {
        let c = Calendar.current.dateComponents([.hour, .minute], from: d)
        return CGFloat((c.hour ?? 0) * 60 + (c.minute ?? 0)) / 1440
    }

    var body: some View {
        VStack(spacing: 6) {
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(Theme.track).frame(height: 14)
                    ForEach(sessions) { s in
                        let from = fraction(s.start)
                        let to = max(fraction(s.end ?? Clock.now), from)
                        Capsule()
                            .fill(Theme.orange)
                            .frame(width: max((to - from) * geo.size.width, 14), height: 14)
                            .offset(x: from * geo.size.width)
                    }
                    if showNow {
                        RoundedRectangle(cornerRadius: 1.5)
                            .fill(Theme.live)
                            .frame(width: 3, height: 20)
                            .offset(x: fraction(Clock.now) * geo.size.width - 1.5)
                    }
                }
                .frame(maxHeight: .infinity)
            }
            .frame(height: 20)
            HStack {
                ForEach(["0h", "6h", "12h", "18h", "24h"], id: \.self) { label in
                    T(label, 11, .medium, Theme.muted)
                    if label != "24h" { Spacer(minLength: 0) }
                }
            }
        }
    }
}

// MARK: - Xem lại thời điểm

struct DateFilterSheet: View {
    @EnvironmentObject var ui: AppUI
    @State var filter: DateFilter
    let onApply: (DateFilter) -> Void
    @State private var month: Date = Clock.now

    private var cal: Calendar { Calendar.current }
    private let columns = Array(repeating: GridItem(.flexible(), spacing: 0), count: 7)

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            SheetTitle(title: "Xem lại thời điểm")
                .padding(.top, 6)
                .padding(.bottom, 15)

            VStack(spacing: 8) {
                HStack(spacing: 8) {
                    presetButton("Hôm nay", .today)
                    presetButton("Hôm qua", .yesterday)
                    presetButton("7 ngày qua", .last7)
                }
                HStack(spacing: 8) {
                    presetButton("30 ngày qua", .last30)
                    presetButton("Tháng này", .thisMonth)
                    presetButton("Tháng trước", .lastMonth)
                }
            }

            monthHeader.padding(.top, 20)

            LazyVGrid(columns: columns, spacing: 0) {
                ForEach(["T2", "T3", "T4", "T5", "T6", "T7", "CN"], id: \.self) { d in
                    T(d, 12, .semibold, Theme.muted).frame(height: 24)
                }
                ForEach(gridDays, id: \.self) { d in dayCell(d) }
            }
            .padding(.top, 6)

            T("Khung giờ trong ngày", 14, .bold).padding(.top, 10)
            HStack(spacing: 10) {
                timeField("Từ", minute: $filter.fromMinute)
                timeField("Đến", minute: $filter.toMinute)
            }
            .padding(.top, 8)

            PrimaryButton(title: "Áp dụng") {
                onApply(filter)
                ui.dismissSheet()
            }
            .padding(.top, 17)
        }
        .padding(.horizontal, Metrics.gutter)
        .onAppear { month = filter.endDay }
    }

    private func presetButton(_ title: String, _ preset: DateFilter.Preset) -> some View {
        let selected = filter.preset == preset
        return Button {
            var next = DateFilter.make(preset)
            next.fromMinute = filter.fromMinute
            next.toMinute = filter.toMinute
            filter = next
            month = next.endDay
        } label: {
            T(title, 13, selected ? .bold : .semibold)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .frame(maxWidth: .infinity)
                .frame(height: 40)
                .background(
                    Capsule().fill(selected ? Theme.orange : Theme.card)
                        .overlay(Capsule().strokeBorder(selected ? Color.clear : Theme.line, lineWidth: 1))
                )
        }
        .buttonStyle(.plain)
    }

    private var monthHeader: some View {
        let comps = cal.dateComponents([.month, .year], from: month)
        let canNext = (cal.date(byAdding: .month, value: 1, to: firstOfMonth) ?? Clock.now) <= Clock.now
        return HStack(spacing: 22) {
            T("Tháng \(comps.month ?? 0), \(String(comps.year ?? 0))", 15, .bold)
            Spacer()
            Button { shiftMonth(-1) } label: { Icon(name: .chevronLeft, size: 18).frame(width: 26, height: 26) }
                .buttonStyle(.plain)
            Button { shiftMonth(1) } label: {
                Icon(name: .chevronRight, size: 18, color: canNext ? Theme.ink : Theme.faint).frame(width: 26, height: 26)
            }
            .buttonStyle(.plain)
            .disabled(!canNext)
        }
    }

    private func shiftMonth(_ by: Int) {
        month = cal.date(byAdding: .month, value: by, to: month) ?? month
    }

    private var firstOfMonth: Date { cal.dateInterval(of: .month, for: month)?.start ?? month }

    /// Luôn 5–6 hàng, bắt đầu từ Thứ Hai.
    private var gridDays: [Date] {
        let first = firstOfMonth
        let weekday = cal.component(.weekday, from: first) // 1 = CN
        let leading = (weekday + 5) % 7
        let count = cal.range(of: .day, in: .month, for: first)?.count ?? 30
        let total = Int(ceil(Double(leading + count) / 7)) * 7
        return (0..<total).compactMap { cal.date(byAdding: .day, value: $0 - leading, to: first) }
    }

    private func dayCell(_ d: Date) -> some View {
        let inMonth = cal.isDate(d, equalTo: month, toGranularity: .month)
        let future = cal.startOfDay(for: d) > cal.startOfDay(for: Clock.now)
        let start = cal.startOfDay(for: filter.startDay)
        let end = cal.startOfDay(for: filter.endDay)
        let day = cal.startOfDay(for: d)
        let isEdge = day == start || day == end
        let inRange = day >= start && day <= end
        let enabled = inMonth && !future

        return Button {
            var next = DateFilter.single(d)
            next.fromMinute = filter.fromMinute
            next.toMinute = filter.toMinute
            filter = next
        } label: {
            ZStack {
                if inMonth && isEdge {
                    Circle().fill(Theme.orange).frame(width: 40, height: 40)
                } else if inMonth && inRange {
                    Circle().fill(Theme.peachSoft).frame(width: 40, height: 40)
                }
                T("\(cal.component(.day, from: d))", 15, inMonth && isEdge ? .heavy : .medium, enabled ? Theme.ink : Theme.faint)
            }
            .frame(height: 46)
            .frame(maxWidth: .infinity)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
    }

    private func timeField(_ label: String, minute: Binding<Int>) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            T(label, 12, .medium, Theme.muted)
            ZStack(alignment: .leading) {
                T(minuteText(minute.wrappedValue), 15, .bold).padding(.leading, 15)
                DatePicker("", selection: Binding<Date>(
                    get: { cal.date(byAdding: .minute, value: minute.wrappedValue, to: cal.startOfDay(for: Clock.now)) ?? Clock.now },
                    set: { d in
                        let c = cal.dateComponents([.hour, .minute], from: d)
                        minute.wrappedValue = (c.hour ?? 0) * 60 + (c.minute ?? 0)
                    }
                ), displayedComponents: .hourAndMinute)
                    .labelsHidden()
                    .environment(\.locale, Locale(identifier: "vi_VN"))
                    .scaleEffect(x: 2.5, y: 1.3)
                    .frame(maxWidth: .infinity)
                    .opacity(0.02)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .frame(height: 43)
            .clipped()
            .cardStyle(14, fill: Theme.field)
        }
    }
}

// MARK: - Live mới

struct LiveNewSheet: View {
    @EnvironmentObject var client: LiveClient
    @EnvironmentObject var store: Store
    @EnvironmentObject var ui: AppUI
    @State private var tiktok = ""

    private var isConnecting: Bool { client.liveState == "connecting" }
    private var isConnected: Bool { client.liveState == "connected" }
    private var name: String { tiktok.trimmingCharacters(in: CharacterSet(charactersIn: "@ ")) }
    private var hasError: Bool { ["error", "ended", "disconnected"].contains(client.liveState) && !client.liveMessage.isEmpty }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            SheetTitle(title: "Live mới").padding(.top, 6)

            if isConnected {
                T("Đang đọc live @\(client.liveUsername) · \(client.viewers) người xem", 14, .medium, Theme.muted)
                PrimaryButton(title: "Xem phiên đang live") {
                    ui.dismissSheet()
                    if let open = store.openSession { ui.push(.session(open.id)) }
                }
                OutlineButton(title: "Dừng phiên live", color: Theme.red, height: 52) { client.disconnectLive() }
            } else {
                if !store.accounts.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(store.accounts) { a in
                                Chip(title: "@" + a.uniqueId, selected: name.lowercased() == a.id) { tiktok = a.uniqueId }
                            }
                        }
                        .padding(.horizontal, Metrics.gutter)
                    }
                    .padding(.horizontal, -Metrics.gutter)
                }
                LabeledField(label: "Tên TikTok đang live", placeholder: "ten_tiktok", text: $tiktok, capitalize: false)
                if hasError {
                    T(client.liveMessage, 13, .medium, Theme.red)
                }
                PrimaryButton(title: isConnecting ? "Đang kết nối..." : "Bắt đầu đọc bình luận", enabled: !name.isEmpty && !isConnecting) {
                    store.addAccount(uniqueId: name, displayName: "", activate: true)
                    client.connectLive(tiktok: name)
                }
            }
        }
        .padding(.horizontal, Metrics.gutter)
        .onAppear { tiktok = store.activeAccount?.uniqueId ?? UserDefaults.standard.string(forKey: "tiktokName") ?? "" }
        .onChange(of: client.liveState) { state in
            if state == "connected" {
                ui.dismissSheet()
                if let open = store.openSession { ui.push(.session(open.id)) }
            }
        }
    }
}

// MARK: - Chi tiết phiên live

struct SessionDetailView: View {
    let sessionId: String
    @EnvironmentObject var client: LiveClient
    @EnvironmentObject var store: Store
    @EnvironmentObject var printer: PrinterManager
    @EnvironmentObject var ui: AppUI
    @State private var onlyClosing = true

    private var session: LiveSession? { store.sessions.first { $0.id == sessionId } }

    private var shown: [LiveComment] {
        let all = store.comments(session: sessionId)
        return onlyClosing ? all.filter(store.isClosingComment) : all
    }

    var body: some View {
        SubPage(title: session?.title ?? "Phiên live", trailing: {
            if session?.isLive == true {
                Badge(text: "Đang live", color: Theme.red, fill: Theme.redSoft, fontSize: 12, height: 25)
            }
        }) {
            ScrollView(showsIndicators: false) {
                VStack(spacing: Metrics.gap) {
                    if let s = session { summaryCard(s) }
                    Toggle(isOn: $onlyClosing) {
                        T("Chỉ hiện bình luận chốt đơn", 14, .semibold)
                    }
                    .tint(Theme.orange)
                    .padding(.horizontal, 4)

                    if shown.isEmpty {
                        T(session?.isLive == true ? "Đang chờ bình luận..." : "Phiên này chưa có bình luận phù hợp.", 13, .medium, Theme.muted)
                            .padding(.top, 24)
                    }
                    LazyVStack(spacing: 8.5) {
                        ForEach(shown) { c in
                            CommentRow(c: c) {
                                ui.notify(printComment(c, store: store, printer: printer))
                            }
                        }
                    }
                }
                .padding(.horizontal, Metrics.gutter)
                .padding(.bottom, 16)
            }
        }
    }

    private func summaryCard(_ s: LiveSession) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                T(s.tiktok.isEmpty ? "Tài khoản TikTok" : "@\(s.tiktok)", 15, .bold).lineLimit(1)
                Spacer()
                T(s.isLive ? "\(client.viewers) người xem" : s.duration, 12, .medium, Theme.muted)
            }
            HStack(spacing: 16) {
                stat(.message, s.commentCount, "bình luận")
                stat(.users, store.sessionCustomerCount(s.id), "khách")
                stat(.bag, store.sessionOrderCount(s.id), "đơn")
            }
            if s.isLive {
                OutlineButton(title: "Dừng phiên live", icon: .stop, color: Theme.red) { client.disconnectLive() }
            }
        }
        .padding(16)
        .cardStyle(20)
    }

    private func stat(_ icon: IconName, _ value: Int, _ label: String) -> some View {
        HStack(spacing: 5) {
            Icon(name: icon, size: 15, color: Theme.accent)
            T("\(value)", 14, .bold)
            T(label, 12, .medium, Theme.muted).lineLimit(1)
        }
    }
}

struct CommentRow: View {
    let c: LiveComment
    let onPrint: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Avatar(text: initialsOf(c.nickname), size: 40, fontSize: 14, seed: c.uniqueId)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    T(c.nickname, 14, .bold).lineLimit(1)
                    T(timeText(c.ts), 11, .medium, Theme.muted)
                }
                T("@" + c.uniqueId, 12, .medium, Theme.muted).lineLimit(1)
                T(c.text, 14, .medium)
            }
            Spacer(minLength: 4)
            VStack(alignment: .trailing, spacing: 6) {
                if c.price > 0 { T(money(c.price), 14, .heavy).lineLimit(1).fixedSize() }
                Button(action: onPrint) {
                    T(c.printed ? "Đã chốt" : "Chốt & in", 13, .bold, c.printed ? Theme.muted : Theme.ink)
                        .lineLimit(1)
                        .fixedSize()
                        .padding(.horizontal, 12)
                        .frame(height: 32)
                        .background(Capsule().fill(c.printed ? Theme.track : Theme.orange))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(13)
        .cardStyle(18)
    }
}
