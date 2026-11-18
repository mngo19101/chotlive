import SwiftUI
import UIKit

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
                    HeaderAddButton(title: "Live mới") { ui.present(dim: AppSheet.dim) { LiveNewSheet() } }
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

                VStack(spacing: 9) {
                    HStack {
                        T("Các phiên \(filter.scopeLabel)", 13, .bold).lineLimit(1)
                        Spacer()
                        T("\(sessions.count) phiên", 12, .medium, Theme.muted)
                    }
                    if sessions.isEmpty {
                        T("Chưa có phiên live nào. Bấm “Live mới” để bắt đầu đọc bình luận.", 13, .medium, Theme.muted)
                            .multilineTextAlignment(.center)
                            .padding(.top, 24)
                    }
                    VStack(spacing: 28) {
                        ForEach(sessions) { s in
                            Button { ui.push(.session(s.id)) } label: { sessionRow(s) }.buttonStyle(.plain)
                        }
                    }
                }
            }
            .padding(.horizontal, Metrics.gutter)
            .padding(.top, 2)
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
                .padding(.top, 12)
        }
        .padding(.horizontal, 17)
        .padding(.top, 16)
        .padding(.bottom, 16)
        .cardStyle(24)
    }

    private func statTile(_ icon: IconName, _ value: String, _ label: String) -> some View {
        HStack(spacing: 8) {
            Icon(name: icon, size: 13, weight: 2.3, color: Theme.accent)
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
            VStack(spacing: 3) {
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
            .padding(.top, s.isLive ? 0 : 4)

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
            Icon(name: icon, size: 13, color: Theme.muted).frame(width: 15, height: 15)
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
        VStack(spacing: 3) {
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

/// Chọn một ngày hoặc một khoảng ngày. Mở ra chưa chọn ngày nào: chạm lần đầu là ngày bắt đầu, lần hai là ngày
/// kết thúc, hoặc giữ và kéo qua các ô. Chấm đỏ dưới số là ngày có phiên live.
struct DateFilterSheet: View {
    @EnvironmentObject var ui: AppUI
    @EnvironmentObject var store: Store
    let onApply: (DateFilter) -> Void

    /// Tháng đang hiện, luôn là ngày đầu tháng. Đặt một lần trong init: `onAppear` có thể chạy lại khi bảng
    /// dựng lại và kéo lịch về tháng cũ.
    @State private var month: Date
    @State private var pickerYear: Int
    @State private var pickingMonth = false
    @State private var start: Date?
    @State private var end: Date?
    @State private var preset: DateFilter.Preset?
    @State private var fromMinute: Int
    @State private var toMinute: Int
    @State private var showTime: Bool
    @State private var editingFrom: Bool? = nil
    @State private var dragging = false
    @State private var dragLast: Date?
    @State private var contentHeight: CGFloat = 0
    @State private var viewportHeight: CGFloat = 0

    private static let rowHeight: CGFloat = 46
    private static let weekdayHeight: CGFloat = 30
    private var cal: Calendar { Calendar.current }
    private var today: Date { cal.startOfDay(for: Clock.now) }

    init(filter: DateFilter, onApply: @escaping (DateFilter) -> Void) {
        self.onApply = onApply
        let cal = Calendar.current
        let first = cal.dateInterval(of: .month, for: filter.endDay)?.start ?? cal.startOfDay(for: filter.endDay)
        _month = State(initialValue: first)
        _pickerYear = State(initialValue: cal.component(.year, from: first))
        _fromMinute = State(initialValue: filter.fromMinute)
        _toMinute = State(initialValue: filter.toMinute)
        _showTime = State(initialValue: filter.fromMinute != 0 || filter.toMinute != 1439)
    }

    var body: some View {
        // Một ScrollView duy nhất, cao vừa bằng nội dung và tối đa bằng màn hình. Trước đây `ViewThatFits` đổi
        // qua lại giữa bản không cuộn và bản cuộn khi mở khung giờ: hai bản chồng lên nhau và sheet giật.
        ScrollView(showsIndicators: false) {
            content
                .scrollDisabled(false)
                .background(GeometryReader { g in
                    Color.clear.preference(key: DateSheetContentHeight.self, value: g.size.height)
                })
        }
        .frame(maxHeight: contentHeight > 0 ? contentHeight : nil)
        .background(GeometryReader { g in
            Color.clear.preference(key: DateSheetViewportHeight.self, value: g.size.height)
        })
        // Vừa màn hình thì không cho cuộn, để kéo ngoài lịch không làm cả bảng nảy.
        .scrollDisabled(contentHeight <= viewportHeight + 0.5)
        .onPreferenceChange(DateSheetContentHeight.self) { h in
            guard abs(h - contentHeight) > 0.5 else { return }
            if contentHeight == 0 {
                contentHeight = h
            } else {
                withAnimation(.easeOut(duration: 0.18)) { contentHeight = h }
            }
        }
        .onPreferenceChange(DateSheetViewportHeight.self) { viewportHeight = $0 }
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 0) {
            SheetTitle(title: "Xem lại thời điểm")
                .padding(.top, 8)
            presetRow.padding(.top, 12)
            fromToRow.padding(.top, 14)
            monthHeader.padding(.top, 14)
            Group {
                if pickingMonth { monthPicker.padding(.top, 10) } else { calendar }
            }
            // Lịch và lưới tháng cao bằng nhau để bảng không nhảy khi đổi qua lại.
            .frame(height: Self.weekdayHeight + Self.rowHeight * 6, alignment: .top)
            hint.padding(.top, 8)
            timeSection.padding(.top, 10)
            PrimaryButton(title: applyTitle, enabled: start != nil) { apply() }
                .padding(.top, 12)
        }
        .padding(.horizontal, Metrics.gutter)
    }

    // MARK: Chọn nhanh

    private var presetRow: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                presetChip("Hôm nay", .today)
                presetChip("Hôm qua", .yesterday)
                presetChip("7 ngày qua", .last7)
                presetChip("30 ngày qua", .last30)
                presetChip("Tháng này", .thisMonth)
                presetChip("Tháng trước", .lastMonth)
            }
            .padding(.horizontal, Metrics.gutter)
        }
        .padding(.horizontal, -Metrics.gutter)
    }

    private func presetChip(_ title: String, _ p: DateFilter.Preset) -> some View {
        Chip(title: title, selected: preset == p) {
            let f = DateFilter.make(p)
            start = f.startDay
            end = f.endDay
            preset = p
            pickingMonth = false
            show(f.endDay)
        }
    }

    // MARK: Từ ngày → Đến ngày

    private var fromToRow: some View {
        HStack(spacing: 8) {
            dayBox("Từ ngày", start.map { dayText($0) }, placeholder: "Chạm 1 ngày", active: start == nil)
            Icon(name: .arrowRight, size: 16, color: Theme.faint)
            dayBox("Đến ngày", end.map { dayText($0) }, placeholder: start == nil ? "—" : "Chạm ngày cuối",
                   active: start != nil && end == nil)
        }
    }

    private func dayBox(_ label: String, _ value: String?, placeholder: String, active: Bool) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            T(label, 11, .semibold, Theme.muted)
            if let value {
                T(value, 15, .heavy).lineLimit(1).minimumScaleFactor(0.8)
            } else {
                T(placeholder, 14, .semibold, Theme.faint).lineLimit(1).minimumScaleFactor(0.8)
            }
        }
        .padding(.horizontal, 13)
        .frame(maxWidth: .infinity, alignment: .leading)
        .frame(height: 54)
        .cardStyle(14, fill: active ? Theme.card : Theme.field, border: active ? Theme.orange : Theme.line)
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(Theme.orange, lineWidth: active ? 1.5 : 0)
        )
    }

    private func dayText(_ d: Date) -> String {
        let sameYear = cal.component(.year, from: d) == cal.component(.year, from: Clock.now)
        return "\(weekdayLabel(d)), " + (sameYear ? shortDate(d) : fullDate(d))
    }

    // MARK: Tiêu đề tháng

    private var monthHeader: some View {
        let comps = cal.dateComponents([.month, .year], from: month)
        return HStack(spacing: 0) {
            Button {
                pickerYear = comps.year ?? pickerYear
                withAnimation(.easeOut(duration: 0.18)) { pickingMonth.toggle() }
            } label: {
                HStack(spacing: 6) {
                    T("Tháng \(comps.month ?? 0), \(String(comps.year ?? 0))", 15, .heavy)
                    Icon(name: pickingMonth ? .chevronUp : .chevronDown, size: 14, weight: 2.6)
                }
                .padding(.leading, 13)
                .padding(.trailing, 11)
                .frame(height: 36)
                .background(Capsule().fill(pickingMonth ? Theme.peachSoft : Theme.field))
                .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            Spacer()
            // Luôn giữ chỗ cho hai nút: gỡ ra thì hàng thấp đi 8pt và cả bảng nhảy khi mở lưới tháng.
            HStack(spacing: 0) {
                navButton(.chevronLeft, enabled: true) { shiftMonth(-1) }
                navButton(.chevronRight, enabled: canGoNextMonth) { shiftMonth(1) }
            }
            .padding(.trailing, -4)
            .opacity(pickingMonth ? 0 : 1)
            .allowsHitTesting(!pickingMonth)
            .accessibilityHidden(pickingMonth)
        }
    }

    /// Nút tròn 36pt, vùng bấm 44pt.
    private func navButton(_ icon: IconName, enabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Icon(name: icon, size: 17, color: enabled ? Theme.ink : Theme.faint)
                .frame(width: 36, height: 36)
                .background(Circle().fill(Theme.card).overlay(Circle().strokeBorder(Theme.line, lineWidth: 1)))
                .padding(4)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
    }

    private var canGoNextMonth: Bool {
        (cal.date(byAdding: .month, value: 1, to: month) ?? Clock.now) <= Clock.now
    }

    private func startOfMonth(_ d: Date) -> Date { cal.dateInterval(of: .month, for: d)?.start ?? d }

    private func show(_ d: Date) {
        month = startOfMonth(d)
        pickerYear = cal.component(.year, from: month)
    }

    private func shiftMonth(_ by: Int) {
        show(cal.date(byAdding: .month, value: by, to: month) ?? month)
    }

    // MARK: Lịch

    /// Luôn 6 hàng từ Thứ Hai, để chiều cao lịch không đổi giữa các tháng.
    private var gridDays: [Date] {
        let leading = (cal.component(.weekday, from: month) + 5) % 7 // weekday 1 = CN
        return (0..<42).map { cal.date(byAdding: .day, value: $0 - leading, to: month) ?? month }
    }

    private var liveDays: Set<Date> { Set(store.sessions.map { cal.startOfDay(for: $0.start) }) }

    /// Khoảng đang chọn, ngày sớm đứng trước.
    private var range: (lo: Date, hi: Date)? {
        guard let s = start else { return nil }
        let e = end ?? s
        return s <= e ? (s, e) : (e, s)
    }

    private var calendar: some View {
        let days = gridDays
        let live = liveDays
        return VStack(spacing: 0) {
            HStack(spacing: 0) {
                ForEach(["T2", "T3", "T4", "T5", "T6", "T7", "CN"], id: \.self) { d in
                    T(d, 12, .semibold, Theme.muted).frame(maxWidth: .infinity)
                }
            }
            .frame(height: Self.weekdayHeight)
            GeometryReader { geo in
                let cellW = geo.size.width / 7
                VStack(spacing: 0) {
                    ForEach(0..<6, id: \.self) { r in
                        weekRow(Array(days[(r * 7)..<(r * 7 + 7)]), cellW: cellW, live: live)
                    }
                }
                .contentShape(Rectangle())
                .gesture(pickGesture(days: days, cellW: cellW))
            }
            .frame(height: Self.rowHeight * 6)
        }
    }

    private func weekRow(_ week: [Date], cellW: CGFloat, live: Set<Date>) -> some View {
        ZStack(alignment: .leading) {
            if let b = band(week, cellW: cellW) {
                Capsule().fill(Theme.peachSoft)
                    .frame(width: b.width, height: 40)
                    .offset(x: b.x)
            }
            HStack(spacing: 0) {
                ForEach(week, id: \.self) { d in
                    dayCell(d, live: live).frame(width: cellW)
                }
            }
        }
        .frame(height: Self.rowHeight)
    }

    /// Dải màu nối ngày đầu và ngày cuối trong một hàng; hàng giữa khoảng thì chạy hết bề ngang.
    private func band(_ week: [Date], cellW: CGFloat) -> (x: CGFloat, width: CGFloat)? {
        guard let r = range, r.lo != r.hi,
              let a = week.firstIndex(where: { $0 >= r.lo && $0 <= r.hi }),
              let b = week.lastIndex(where: { $0 >= r.lo && $0 <= r.hi }) else { return nil }
        let left = week[a] == r.lo ? CGFloat(a) * cellW + cellW / 2 - 20 : CGFloat(a) * cellW + 2
        let right = week[b] == r.hi ? CGFloat(b) * cellW + cellW / 2 + 20 : CGFloat(b + 1) * cellW - 2
        return (left, right - left)
    }

    private func dayCell(_ d: Date, live: Set<Date>) -> some View {
        let inMonth = cal.isDate(d, equalTo: month, toGranularity: .month)
        let future = d > today
        let isEdge = range.map { d == $0.lo || d == $0.hi } ?? false
        let isToday = d == today
        let color = future || !inMonth ? Theme.faint : Theme.ink
        return ZStack {
            if isEdge {
                Circle().fill(Theme.orange).frame(width: 40, height: 40)
            } else if isToday {
                Circle().strokeBorder(Theme.ink, lineWidth: 1.5).frame(width: 40, height: 40)
            }
            T("\(cal.component(.day, from: d))", 15, isEdge || isToday ? .heavy : .medium, isEdge ? Theme.ink : color)
            if live.contains(d) {
                Circle().fill(isEdge ? Color.white : Theme.live)
                    .frame(width: 5, height: 5)
                    .offset(y: 13)
            }
        }
        .frame(height: Self.rowHeight)
        .opacity(inMonth || isEdge ? 1 : 0.6)
        .onAccent(isEdge)
    }

    /// Một cử chỉ cho cả lưới: chạm là chọn ngày, kéo quá vài điểm là quét khoảng từ ô đầu tới ô đang chạm.
    private func pickGesture(days: [Date], cellW: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { v in
                let moved = abs(v.translation.width) > 6 || abs(v.translation.height) > 6
                guard moved || dragging else { return }
                if !dragging {
                    guard let from = day(at: v.startLocation, days: days, cellW: cellW) else { return }
                    dragging = true
                    preset = nil
                    start = from
                    end = from
                    dragLast = from
                    tick()
                }
                if let to = day(at: v.location, days: days, cellW: cellW, clamp: true), to != dragLast {
                    dragLast = to
                    end = to
                    tick()
                }
            }
            .onEnded { v in
                if dragging {
                    dragging = false
                    dragLast = nil
                    if let s = start, let e = end, e < s {
                        start = e
                        end = s
                    }
                } else if let d = day(at: v.location, days: days, cellW: cellW) {
                    tap(d)
                }
            }
    }

    /// Ô dưới ngón tay. `clamp`: kéo ra ngoài lưới thì lấy ô sát mép, kéo vào ngày chưa tới thì dừng ở hôm nay.
    private func day(at p: CGPoint, days: [Date], cellW: CGFloat, clamp: Bool = false) -> Date? {
        var col = Int(floor(p.x / cellW))
        var row = Int(floor(p.y / Self.rowHeight))
        if clamp {
            col = min(max(col, 0), 6)
            row = min(max(row, 0), 5)
        }
        guard (0..<7).contains(col), (0..<6).contains(row) else { return nil }
        let d = days[row * 7 + col]
        if d > today { return clamp ? today : nil }
        return d
    }

    private func tap(_ d: Date) {
        preset = nil
        if let s = start, end == nil {
            if d < s {
                start = d
                end = s
            } else {
                end = d
            }
        } else {
            start = d
            end = nil
        }
        tick()
    }

    private func tick() { UISelectionFeedbackGenerator().selectionChanged() }

    // MARK: Lưới tháng / năm

    private var minYear: Int {
        let first = store.sessions.map(\.start).min() ?? Clock.now
        return min(cal.component(.year, from: first), cal.component(.year, from: Clock.now) - 1)
    }

    private func monthCounts(_ year: Int) -> [Int: Int] {
        var out: [Int: Int] = [:]
        for s in store.sessions {
            let c = cal.dateComponents([.year, .month], from: s.start)
            if c.year == year, let m = c.month { out[m, default: 0] += 1 }
        }
        return out
    }

    private var monthPicker: some View {
        let thisYear = cal.component(.year, from: Clock.now)
        let thisMonth = cal.component(.month, from: Clock.now)
        let shown = cal.dateComponents([.year, .month], from: month)
        let counts = monthCounts(pickerYear)
        return VStack(spacing: 10) {
            HStack(spacing: 0) {
                navButton(.chevronLeft, enabled: pickerYear > minYear) { pickerYear -= 1 }
                Spacer()
                T(String(pickerYear), 18, .heavy)
                Spacer()
                navButton(.chevronRight, enabled: pickerYear < thisYear) { pickerYear += 1 }
            }
            .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Theme.field))
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 3), spacing: 8) {
                ForEach(1...12, id: \.self) { m in
                    let future = pickerYear > thisYear || (pickerYear == thisYear && m > thisMonth)
                    let current = shown.year == pickerYear && shown.month == m
                    Button { pickMonth(m) } label: {
                        monthTile(m, count: counts[m] ?? 0, future: future, current: current)
                    }
                    .buttonStyle(.plain)
                    .disabled(future)
                }
            }
        }
    }

    private func monthTile(_ m: Int, count: Int, future: Bool, current: Bool) -> some View {
        let note = future ? "chưa tới" : count > 0 ? "\(count) phiên" : "không live"
        return VStack(spacing: 2) {
            T("Thg \(m)", 15, .bold, future ? Theme.faint : Theme.ink)
            T(note, 11, .semibold, future ? Theme.faint : Theme.muted)
        }
        .frame(maxWidth: .infinity)
        .frame(height: 56)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(current ? Theme.orange : future ? Theme.field : Theme.card)
                .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .strokeBorder(current || future ? Color.clear : Theme.line, lineWidth: 1))
        )
        .onAccent(current)
        .contentShape(Rectangle())
    }

    private func pickMonth(_ m: Int) {
        if let d = cal.date(from: DateComponents(year: pickerYear, month: m, day: 1)) { month = d }
        withAnimation(.easeOut(duration: 0.18)) { pickingMonth = false }
    }

    // MARK: Gợi ý và số phiên live

    private func sessionCount(_ lo: Date, _ hi: Date) -> Int {
        store.sessions(in: DateFilter(preset: .custom, startDay: lo, endDay: hi,
                                      fromMinute: fromMinute, toMinute: toMinute)).count
    }

    private var hint: some View {
        let r = range
        let count = r.map { sessionCount($0.lo, $0.hi) } ?? 0
        let done = r != nil && end != nil
        var text = "Chạm ngày bắt đầu, hoặc giữ và kéo qua nhiều ngày"
        if let r {
            let span = (cal.dateComponents([.day], from: r.lo, to: r.hi).day ?? 0) + 1
            let lives = count > 0 ? "\(count) phiên live" : "không có phiên live"
            if end == nil {
                text = "Ngày \(shortDate(r.lo)) \(count > 0 ? "có " : "")\(lives). Chạm ngày cuối để xem nhiều ngày."
            } else if span == 1 {
                text = "Ngày \(shortDate(r.lo)) \(count > 0 ? "có " : "")\(lives)."
            } else {
                text = "\(count > 0 ? lives : "Không có phiên live") trong \(span) ngày, \(shortDate(r.lo)) – \(shortDate(r.hi))"
            }
        }
        return HStack(spacing: 9) {
            if r == nil {
                Icon(name: .calendar, size: 15, color: Theme.muted)
            } else {
                Circle().fill(count > 0 ? Theme.live : Theme.faint).frame(width: 7, height: 7)
            }
            T(text, 13, .semibold, done ? Theme.ink : Theme.muted)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(minHeight: 42)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(done ? Theme.peachSoft : Theme.field))
    }

    // MARK: Khung giờ

    private var timeSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.easeOut(duration: 0.18)) {
                    showTime.toggle()
                    if !showTime { editingFrom = nil }
                }
            } label: {
                HStack(spacing: 8) {
                    T("Khung giờ trong ngày", 14, .bold)
                    Spacer()
                    T("\(minuteText(fromMinute)) – \(minuteText(toMinute))", 13, .semibold, Theme.muted)
                    Icon(name: showTime ? .chevronUp : .chevronDown, size: 14, color: Theme.muted)
                }
                .padding(.horizontal, 14)
                .frame(height: 46)
                .cardStyle(14)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if showTime {
                HStack(spacing: 10) {
                    timeField("Từ", isFrom: true, minute: fromMinute)
                    timeField("Đến", isFrom: false, minute: toMinute)
                }
                .padding(.top, 8)
                if let isFrom = editingFrom {
                    timeWheel(isFrom ? $fromMinute : $toMinute)
                }
            }
        }
    }

    /// Ô giờ; bấm vào để mở / đóng bánh xe chọn giờ.
    private func timeField(_ label: String, isFrom: Bool, minute: Int) -> some View {
        let active = editingFrom == isFrom
        return VStack(alignment: .leading, spacing: 5) {
            T(label, 12, .medium, Theme.muted)
            Button {
                withAnimation(.easeOut(duration: 0.18)) { editingFrom = active ? nil : isFrom }
            } label: {
                T(minuteText(minute), 15, .bold)
                    .padding(.leading, 15)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .frame(height: 43)
                    .cardStyle(14, fill: Theme.field, border: active ? Theme.orange : Theme.line)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
    }

    private func timeWheel(_ minute: Binding<Int>) -> some View {
        DatePicker("", selection: Binding<Date>(
            get: { cal.date(byAdding: .minute, value: minute.wrappedValue, to: cal.startOfDay(for: Clock.now)) ?? Clock.now },
            set: { d in
                let c = cal.dateComponents([.hour, .minute], from: d)
                minute.wrappedValue = (c.hour ?? 0) * 60 + (c.minute ?? 0)
            }
        ), displayedComponents: .hourAndMinute)
            .datePickerStyle(.wheel)
            .labelsHidden()
            .environment(\.locale, Locale(identifier: "vi_VN"))
            .frame(maxWidth: .infinity)
            .frame(height: 120)
            .clipped()
            .padding(.top, 6)
    }

    // MARK: Áp dụng

    private var applyTitle: String {
        guard let r = range else { return "Chọn ngày để xem" }
        if r.lo == r.hi { return "Xem ngày \(shortDate(r.lo))" }
        return "Áp dụng · \(shortDate(r.lo)) – \(shortDate(r.hi))"
    }

    private func apply() {
        guard let r = range else { return }
        var next: DateFilter
        if let p = preset {
            next = DateFilter.make(p)
        } else if r.lo == r.hi {
            next = DateFilter.single(r.lo)
        } else {
            next = DateFilter(preset: .custom, startDay: r.lo, endDay: r.hi)
        }
        next.fromMinute = fromMinute
        next.toMinute = toMinute
        onApply(next)
        ui.dismissSheet()
    }
}

/// Chiều cao nội dung bảng chọn ngày, để ScrollView cao vừa đúng bằng nó.
private struct DateSheetContentHeight: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

/// Chiều cao thật của ScrollView sau khi bị màn hình giới hạn.
private struct DateSheetViewportHeight: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}
