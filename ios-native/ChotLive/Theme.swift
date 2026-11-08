import SwiftUI
import UIKit

// MARK: - Màu, chữ (đo từ mẫu thiết kế, màn 390×844)

extension Color {
    init(hex: UInt32) {
        self.init(red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255)
    }
}

enum Theme {
    // Màu nền và chữ: mỗi màu có bản Sáng và bản Tối, iOS tự chọn theo chế độ nền đang dùng.
    static let bg = Color.dynamic(0xF6F7F9, 0x0F1115)
    static let card = Color.dynamic(0xFFFFFF, 0x1A1D23)
    static let line = Color.dynamic(0xE6E8EC, 0x2C3038)
    static let ink = Color.dynamic(0x14181F, 0xF2F3F5)
    static let muted = Color.dynamic(0x5B6472, 0xA3AAB6)
    static let faint = Color.dynamic(0x8B93A0, 0x7D8592)
    static let placeholder = Color.dynamic(0x7D8592, 0x8A919D)
    static let tabBar = Color.dynamic(0xFFFFFF, 0x15181D)
    static let slate = Color.dynamic(0xE6E9F0, 0x2A2F3A)
    static let green = Color.dynamic(0x107A54, 0x4ADE9C)
    static let greenSoft = Color.dynamic(0xE6F7EF, 0x12291F)
    static let greenBright = Color(hex: 0x4ADE9C)
    static let red = Color.dynamic(0xB3261E, 0xFF8A80)
    static let redSoft = Color.dynamic(0xFDECEC, 0x3A1A1C)
    static let live = Color.dynamic(0xE5484D, 0xFF6369)
    static let bar = Color.dynamic(0xCBD2DC, 0x3A3F48)
    static let field = Color.dynamic(0xF6F7F9, 0x23272E)
    static let track = Color.dynamic(0xEFF0F4, 0x262A31)
    static let grayBadge = Color.dynamic(0xEBEEF3, 0x2A2E36)
    static let grabber = Color.dynamic(0xD6D9DF, 0x3A3F48)

    // Màu chủ đạo người dùng chọn trong Tôi › Giao diện (mặc định Vàng, đúng mẫu thiết kế).
    static private(set) var colors = AccentColors(AccentChoice.saved)
    static func use(_ choice: AccentChoice) { colors = AccentColors(choice) }

    static var orange: Color { colors.orange }
    static var orangeDeep: Color { colors.orangeDeep }
    static var accent: Color { colors.accent }
    static var accentDeep: Color { colors.accentDeep }
    static var peach: Color { colors.peach }
    static var peachSoft: Color { colors.peachSoft }
    static var peachLine: Color { colors.peachLine }
    static var peachTint: Color { colors.peachTint }
    static var peachCode: Color { colors.peachCode }
    static var peachRow: Color { colors.peachRow }
}

enum BV: String {
    case medium = "BeVietnamPro-Medium"
    case semibold = "BeVietnamPro-SemiBold"
    case bold = "BeVietnamPro-Bold"
    case heavy = "BeVietnamPro-ExtraBold"
}

extension Font {
    static func bv(_ size: CGFloat, _ weight: BV = .medium) -> Font { .custom(weight.rawValue, fixedSize: size) }
}

/// Text theo kiểu chữ của mẫu thiết kế.
func T(_ s: String, _ size: CGFloat, _ weight: BV = .medium, _ color: Color = Theme.ink, track: CGFloat = 0) -> Text {
    Text(verbatim: s).font(.bv(size, weight)).foregroundColor(color).tracking(track)
}

enum Metrics {
    static var screenWidth: CGFloat { UIScreen.main.bounds.width }
    static var safeBottom: CGFloat {
        UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            .first?.windows.first?.safeAreaInsets.bottom ?? 0
    }
    static let gutter: CGFloat = 20
    static let gap: CGFloat = 14.5

    /// Chiều cao nội dung bottom sheet có mép trên cách đỉnh màn hình `top` điểm.
    static func sheetHeight(top: CGFloat) -> CGFloat {
        let bottom = safeBottom > 0 ? safeBottom - 6 : 16
        return UIScreen.main.bounds.height - top - 22 - bottom
    }
}

// MARK: - Định dạng

func weekdayLabel(_ d: Date) -> String {
    let w = Calendar.current.component(.weekday, from: d) // 1 = CN
    return w == 1 ? "CN" : "T\(w)"
}

func shortDate(_ d: Date) -> String {
    let c = Calendar.current.dateComponents([.day, .month], from: d)
    return "\(c.day ?? 0)/\(c.month ?? 0)"
}

func fullDate(_ d: Date) -> String {
    "\(shortDate(d))/\(Calendar.current.component(.year, from: d))"
}

func longWeekday(_ d: Date) -> String {
    let w = weekdayLabel(d)
    return w == "CN" ? "Chủ nhật" : "Thứ " + String(w.dropFirst())
}

func timeText(_ d: Date) -> String {
    let c = Calendar.current.dateComponents([.hour, .minute], from: d)
    return String(format: "%02d:%02d", c.hour ?? 0, c.minute ?? 0)
}

func minuteText(_ m: Int) -> String { String(format: "%02d:%02d", m / 60, m % 60) }

func relativeDay(_ d: Date) -> String {
    if Clock.isToday(d) { return "\(timeText(d)) nay" }
    if Clock.isYesterday(d) { return "\(timeText(d)) hôm qua" }
    return "\(weekdayLabel(d)) \(shortDate(d))"
}

func compactMoney(_ n: Int) -> String {
    if n >= 1_000_000 { return String(format: "%.2ftr", Double(n) / 1_000_000).replacingOccurrences(of: ".", with: ",") }
    if n >= 1_000 { return "\(n / 1_000)k" }
    return "\(n)"
}

extension DateFilter {
    /// Nhãn trên nút chọn ngày: "Hôm nay · CN 25/10".
    var pillLabel: String {
        switch preset {
        case .today: return "Hôm nay · \(weekdayLabel(startDay)) \(shortDate(startDay))"
        case .yesterday: return "Hôm qua · \(weekdayLabel(startDay)) \(shortDate(startDay))"
        case .last7: return "7 ngày · đến \(shortDate(endDay))"
        case .last30: return "30 ngày · đến \(shortDate(endDay))"
        case .thisMonth, .lastMonth: return "Tháng \(Calendar.current.component(.month, from: startDay))"
        case .custom:
            return isSingleDay ? "\(weekdayLabel(startDay)) \(shortDate(startDay))" : "\(shortDate(startDay)) – \(shortDate(endDay))"
        }
    }

    /// Đuôi tiêu đề danh sách: "hôm nay", "hôm qua", "ngày 23/10"...
    var scopeLabel: String {
        switch preset {
        case .today: return "hôm nay"
        case .yesterday: return "hôm qua"
        case .last7: return "7 ngày qua"
        case .last30: return "30 ngày qua"
        case .thisMonth: return "tháng này"
        case .lastMonth: return "tháng trước"
        case .custom: return isSingleDay ? "ngày \(shortDate(startDay))" : "đã chọn"
        }
    }
}

// MARK: - Điều hướng + bottom sheet

enum AppTab: Int, CaseIterable {
    case sales, comments, customers, orders, me

    var title: String {
        switch self {
        case .sales: return "Doanh số"
        case .comments: return "Bình luận"
        case .customers: return "Khách\nhàng"
        case .orders: return "Đơn hàng"
        case .me: return "Tôi"
        }
    }

    var icon: IconName {
        switch self {
        case .sales: return .chart
        case .comments: return .messageLines
        case .customers: return .users
        case .orders: return .bag
        case .me: return .user
        }
    }
}

enum Route: Hashable {
    case session(String)
    case order(String)
    case orderEdit(String)
    case orderCreate
    case orderComments(String)
    case customer(String)
    case addressEdit(String)
    case printer
    case keywords
    case notifications
    case help
    case appearance
}

struct SheetItem: Identifiable {
    let id = UUID()
    var dim: Double
    var content: AnyView
}

struct ConfirmItem: Identifiable {
    let id = UUID()
    var title: String
    var message: String
    var action: String
    var run: () -> Void
}

@MainActor
final class AppUI: ObservableObject {
    @Published var tab: AppTab = .sales
    @Published var path = NavigationPath()
    @Published var sheet: SheetItem?
    @Published var alert: String?
    @Published var confirm: ConfirmItem?

    func push(_ r: Route) { path.append(r) }
    func pop() { if !path.isEmpty { path.removeLast() } }

    func present<V: View>(dim: Double = 0.45, @ViewBuilder _ content: () -> V) {
        sheet = SheetItem(dim: dim, content: AnyView(content()))
    }

    func dismissSheet() { sheet = nil }

    /// Hiện thông báo nếu có nội dung.
    func notify(_ message: String?) { if let message { alert = message } }
}

/// Lớp phủ bottom sheet: nền tối, bo góc trên, kéo xuống để đóng.
struct SheetLayer: View {
    @ObservedObject var ui: AppUI
    @State private var drag: CGFloat = 0
    /// Sheet đang vẽ: còn giữ trong lúc trượt xuống, sau khi `ui.sheet` đã về nil.
    @State private var shown: SheetItem?
    @State private var isUp = false

    private static let slide = Animation.spring(response: 0.32, dampingFraction: 0.92)
    /// Đợi sheet dựng xong ở ngoài màn hình rồi mới trượt lên.
    private static let mountDelay: UInt64 = 30_000_000
    /// Spring đã tắt hẳn, sheet nằm ngoài màn hình nên gỡ lúc này không thấy giật.
    private static let removeDelay: UInt64 = 450_000_000

    var body: some View {
        ZStack(alignment: .bottom) {
            if let s = shown {
                // Lớp phủ luôn tối, kể cả khi app đang nền Tối.
                (s.dim >= 0.9 ? Color(hex: 0x2B3036) : Color(hex: 0x14181F).opacity(s.dim))
                    .ignoresSafeArea()
                    .opacity(isUp ? 1 : 0)
                    .onTapGesture { ui.dismissSheet() }

                VStack(spacing: 0) {
                    // Chỉ kéo ở vùng tay nắm để không tranh cử chỉ với bánh xe chọn giờ và danh sách cuộn.
                    Capsule().fill(Theme.grabber).frame(width: 40, height: 4)
                        .padding(.top, 10).padding(.bottom, 8)
                        .frame(maxWidth: .infinity)
                        .contentShape(Rectangle())
                        .gesture(
                            DragGesture(minimumDistance: 4)
                                .onChanged { drag = $0.translation.height }
                                .onEnded { v in
                                    if v.translation.height > 90 { ui.dismissSheet() }
                                    drag = 0
                                }
                        )
                    s.content
                }
                .frame(maxWidth: .infinity)
                .padding(.bottom, Metrics.safeBottom > 0 ? -6 : 16)
                .background(TopRounded(radius: 28).fill(Theme.card).ignoresSafeArea(.container, edges: .bottom))
                .offset(y: max(drag, 0))
                .modifier(SheetSlide(progress: isUp ? 1 : 0))
                .id(s.id)
            }
        }
        .allowsHitTesting(isUp)
        .animation(.spring(response: 0.25, dampingFraction: 0.9), value: drag)
        .onAppear { sync() }
        .onChange(of: ui.sheet?.id) { _ in sync() }
    }

    /// Không dùng `.transition` cho sheet: nội dung chèn cùng lúc với chuyển động có thể không đi theo nền
    /// (`ViewThatFits` của lịch đứng yên trong khi nền trượt lên), nên dựng xong mới cho trượt.
    private func sync() {
        guard let next = ui.sheet else {
            guard let closing = shown else { return }
            withAnimation(Self.slide) { isUp = false }
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: Self.removeDelay)
                if ui.sheet == nil, shown?.id == closing.id { shown = nil }
            }
            return
        }
        isUp = false
        shown = next
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: Self.mountDelay)
            guard ui.sheet?.id == next.id else { return }
            withAnimation(Self.slide) { isUp = true }
        }
    }
}

/// Trượt sheet như một khối. `progress` 0 là nằm hẳn dưới đáy màn hình: nền trắng phủ xuống vùng an toàn
/// nên quãng trượt phải cộng thêm phần đó, nếu không sẽ còn một dải trắng đè lên thanh tab.
struct SheetSlide: GeometryEffect {
    var progress: CGFloat
    var safeBottom: CGFloat = Metrics.safeBottom

    var animatableData: CGFloat {
        get { progress }
        set { progress = newValue }
    }

    func effectValue(size: CGSize) -> ProjectionTransform {
        ProjectionTransform(CGAffineTransform(translationX: 0, y: (1 - progress) * (size.height + safeBottom)))
    }
}

struct TopRounded: Shape {
    var radius: CGFloat
    func path(in rect: CGRect) -> Path {
        Path(UIBezierPath(roundedRect: rect, byRoundingCorners: [.topLeft, .topRight],
                          cornerRadii: CGSize(width: radius, height: radius)).cgPath)
    }
}

// Giữ cử chỉ vuốt lùi khi ẩn thanh điều hướng hệ thống.
extension UINavigationController: UIGestureRecognizerDelegate {
    open override func viewDidLoad() {
        super.viewDidLoad()
        interactivePopGestureRecognizer?.delegate = self
    }

    public func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        viewControllers.count > 1
    }
}

// MARK: - Thành phần dùng chung

extension View {
    /// Thẻ trắng viền mảnh.
    func cardStyle(_ radius: CGFloat = 20, fill: Color = Theme.card, border: Color = Theme.line) -> some View {
        background(
            RoundedRectangle(cornerRadius: radius, style: .continuous)
                .fill(fill)
                .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).strokeBorder(border, lineWidth: 1))
        )
    }
}

struct HairLine: View {
    var body: some View { Rectangle().fill(Theme.line).frame(height: 1) }
}

struct Avatar: View {
    let text: String
    var size: CGFloat = 44
    var fontSize: CGFloat = 15
    var seed: String

    private var isPeach: Bool {
        let hash = seed.unicodeScalars.reduce(0) { ($0 &* 9 &+ Int($1.value)) & 0xFFFF }
        return (hash >> 3) & 1 == 0
    }

    var body: some View {
        T(text, fontSize, .bold)
            .frame(width: size, height: size)
            .background(Circle().fill(isPeach ? Theme.peach : Theme.slate))
    }
}

struct Badge: View {
    let text: String
    var color: Color = Theme.accent
    var fill: Color = Theme.peachSoft
    var fontSize: CGFloat = 11
    var height: CGFloat = 19
    var hPad: CGFloat = 8

    var body: some View {
        T(text, fontSize, .semibold, color)
            .lineLimit(1)
            .fixedSize()
            .padding(.horizontal, hPad)
            .frame(height: height)
            .background(Capsule().fill(fill))
    }
}

extension OrderStatus {
    var badgeColor: Color {
        switch self {
        case .new: return Theme.accent
        case .printed: return Theme.ink
        case .shipping: return Theme.accent
        case .delivered: return Theme.green
        }
    }

    var badgeFill: Color {
        switch self {
        case .new, .shipping: return Theme.peachSoft
        case .printed: return Theme.grayBadge
        case .delivered: return Theme.greenSoft
        }
    }
}

struct StatusBadge: View {
    let status: OrderStatus
    var fontSize: CGFloat = 11
    var height: CGFloat = 19
    var body: some View {
        Badge(text: status.label, color: status.badgeColor, fill: status.badgeFill, fontSize: fontSize, height: height,
              hPad: height >= 25 ? 12 : 8)
    }
}

/// Tiêu đề lớn đầu tab.
struct PageHeader<Trailing: View>: View {
    let subtitle: String
    let title: String
    @ViewBuilder var trailing: () -> Trailing

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 1) {
                T(subtitle, 13, .medium, Theme.muted).lineLimit(1).minimumScaleFactor(0.8)
                T(title, 28, .heavy, Theme.ink, track: -0.5).lineLimit(1)
            }
            Spacer(minLength: 0)
            trailing()
        }
        .padding(.bottom, -1)
    }
}

/// Nút cam có dấu cộng ở góc phải tiêu đề ("Live mới", "Tạo đơn").
struct HeaderAddButton: View {
    let title: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Icon(name: .plus, size: 16, weight: 2.4)
                T(title, 14, .bold).lineLimit(1).fixedSize()
            }
            .frame(width: 108, height: 44)
            .background(Capsule().fill(Theme.orange))
            .onAccent()
        }
        .buttonStyle(.plain)
    }
}

struct CircleButton: View {
    let icon: IconName
    var iconSize: CGFloat = 20
    var color: Color = Theme.ink
    var enabled = true
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Icon(name: icon, size: iconSize, color: enabled ? color : Theme.faint)
                .frame(width: 44, height: 44)
                .background(Circle().fill(Theme.card).overlay(Circle().strokeBorder(Theme.line, lineWidth: 1)))
        }
        .buttonStyle(.plain)
        .allowsHitTesting(enabled)
    }
}

struct Chip: View {
    let title: String
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            T(title, 13, selected ? .bold : .semibold)
                .lineLimit(1)
                .fixedSize()
                .padding(.horizontal, 15)
                .frame(height: 36)
                .background(
                    Capsule().fill(selected ? Theme.orange : Theme.card)
                        .overlay(Capsule().strokeBorder(selected ? Color.clear : Theme.line, lineWidth: 1))
                )
                .onAccent(selected)
        }
        .buttonStyle(.plain)
    }
}

struct SearchField: View {
    @Binding var text: String
    var placeholder = "Tìm tên hoặc @tiktok"

    var body: some View {
        HStack(spacing: 13) {
            Icon(name: .search, size: 17, weight: 2.3, color: Theme.muted)
            ZStack(alignment: .leading) {
                if text.isEmpty { T(placeholder, 14, .medium, Theme.placeholder).lineLimit(1) }
                TextField("", text: $text)
                    .font(.bv(14, .medium))
                    .foregroundColor(Theme.ink)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            }
            if !text.isEmpty {
                Button { text = "" } label: { Icon(name: .close, size: 16, color: Theme.muted) }
                    .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 17)
        .frame(height: 44)
        .background(Capsule().fill(Theme.card).overlay(Capsule().strokeBorder(Theme.line, lineWidth: 1)))
    }
}

/// Nút cam to chiếm hết chiều ngang ("Áp dụng", "Chỉnh sửa đơn").
struct PrimaryButton: View {
    let title: String
    var icon: IconName?
    var fontSize: CGFloat = 16
    var height: CGFloat = 52
    var enabled = true
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if let icon { Icon(name: icon, size: 15, weight: 2.3) }
                T(title, fontSize, .bold)
            }
            .frame(maxWidth: .infinity)
            .frame(height: height)
            .background(Capsule().fill(Theme.orange))
            .onAccent()
            .opacity(enabled ? 1 : 0.5)
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
    }
}

/// Nút trắng viền mảnh.
struct OutlineButton: View {
    let title: String
    var icon: IconName?
    var color: Color = Theme.ink
    var height: CGFloat = 44
    var filled = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if let icon { Icon(name: icon, size: 15, weight: 2.3, color: color) }
                T(title, 14, .bold, color).lineLimit(1).minimumScaleFactor(0.8)
            }
            .frame(maxWidth: .infinity)
            .frame(height: height)
            .background(
                Capsule().fill(filled ? Theme.orange : Theme.card)
                    .overlay(Capsule().strokeBorder(filled ? Color.clear : Theme.line, lineWidth: 1))
            )
            .onAccent(filled)
        }
        .buttonStyle(.plain)
    }
}

/// Khung trang con: nút lùi tròn, tiêu đề, nội dung; không có thanh tab.
struct SubPage<Trailing: View, Content: View>: View {
    @EnvironmentObject var ui: AppUI
    let title: String
    var subtitle: String? = nil
    /// Hiện ngay sau tiêu đề (ví dụ nhãn Live).
    var accessory: AnyView? = nil
    var headerBottom: CGFloat = 14
    @ViewBuilder var trailing: () -> Trailing
    @ViewBuilder var content: () -> Content

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: subtitle == nil ? 12 : 14) {
                CircleButton(icon: .chevronLeft) { ui.pop() }
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 8) {
                        T(title, 20, .heavy, Theme.ink, track: -0.3).lineLimit(1).minimumScaleFactor(0.7)
                        accessory
                    }
                    if let subtitle {
                        T(subtitle, 13, .medium, Theme.muted).lineLimit(1).minimumScaleFactor(0.8)
                    }
                }
                Spacer(minLength: 0)
                trailing()
            }
            .padding(.horizontal, Metrics.gutter)
            .padding(.bottom, headerBottom)
            content()
        }
        .background(Theme.bg.ignoresSafeArea())
        .toolbar(.hidden, for: .navigationBar)
    }
}

extension SubPage where Trailing == EmptyView {
    init(title: String, subtitle: String? = nil, headerBottom: CGFloat = 14, @ViewBuilder content: @escaping () -> Content) {
        self.title = title
        self.subtitle = subtitle
        self.headerBottom = headerBottom
        self.trailing = { EmptyView() }
        self.content = content
    }
}

/// Ô nhập có nhãn dùng cho các màn sửa.
struct LabeledField: View {
    let label: String
    let placeholder: String
    @Binding var text: String
    var keyboard: UIKeyboardType = .default
    var capitalize = true
    var contentType: UITextContentType? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            T(label, 12, .medium, Theme.muted)
            TextField(placeholder, text: $text)
                .font(.bv(15, .semibold))
                .foregroundColor(Theme.ink)
                .keyboardType(keyboard)
                .textContentType(contentType)
                .textInputAutocapitalization(capitalize ? .sentences : .never)
                .autocorrectionDisabled(!capitalize)
                .padding(.horizontal, 15)
                .frame(height: 44)
                .cardStyle(14, fill: Theme.field)
        }
    }
}

/// Ô mật khẩu cùng kiểu với LabeledField.
struct PasswordField: View {
    let label: String
    @Binding var text: String
    var contentType: UITextContentType = .password

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            T(label, 12, .medium, Theme.muted)
            SecureField(label, text: $text)
                .font(.bv(15, .semibold))
                .foregroundColor(Theme.ink)
                .textContentType(contentType)
                .padding(.horizontal, 15)
                .frame(height: 44)
                .cardStyle(14, fill: Theme.field)
        }
    }
}

/// Xếp các phần tử thành hàng, hết chỗ thì xuống dòng.
struct FlowLayout: Layout {
    var spacing: CGFloat = 8
    var lineSpacing: CGFloat = 8

    private func lines(_ subviews: Subviews, width: CGFloat) -> [(items: [(Int, CGSize)], height: CGFloat)] {
        var result: [(items: [(Int, CGSize)], height: CGFloat)] = []
        var items: [(Int, CGSize)] = []
        var x: CGFloat = 0
        var height: CGFloat = 0
        for (i, v) in subviews.enumerated() {
            let size = v.sizeThatFits(.unspecified)
            if !items.isEmpty && x + size.width > width {
                result.append((items, height))
                items = []
                x = 0
                height = 0
            }
            items.append((i, size))
            x += size.width + spacing
            height = max(height, size.height)
        }
        if !items.isEmpty { result.append((items, height)) }
        return result
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let all = lines(subviews, width: proposal.width ?? .infinity)
        var used: CGFloat = 0
        var height: CGFloat = 0
        for (index, line) in all.enumerated() {
            var lineWidth = spacing * CGFloat(line.items.count - 1)
            for item in line.items { lineWidth += item.1.width }
            used = max(used, lineWidth)
            height += line.height + (index > 0 ? lineSpacing : 0)
        }
        return CGSize(width: proposal.width ?? used, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for line in lines(subviews, width: bounds.width) {
            var x = bounds.minX
            for (i, size) in line.items {
                subviews[i].place(at: CGPoint(x: x, y: y + (line.height - size.height) / 2), proposal: ProposedViewSize(size))
                x += size.width + spacing
            }
            y += line.height + lineSpacing
        }
    }
}

/// Thanh nút dưới đáy trang con: nền trắng, kẻ mảnh phía trên.
struct FooterBar<Content: View>: View {
    @ViewBuilder var content: () -> Content

    var body: some View {
        VStack(spacing: 0) {
            HairLine()
            content()
                .padding(.horizontal, Metrics.gutter)
                .padding(.top, 14)
                .padding(.bottom, Metrics.safeBottom > 0 ? -5.5 : 12)
        }
        .background(Theme.card.ignoresSafeArea(edges: .bottom))
    }
}

/// Nội dung bình luận, phần mã ("Mã 150") được tô nền.
struct CommentText: View {
    let text: String
    var size: CGFloat = 15
    var highlight = true

    var body: some View {
        let parts = highlight ? PriceParser.segments(text) : []
        if parts.contains(where: \.isCode) {
            FlowLayout(spacing: size * 0.26, lineSpacing: 3) {
                ForEach(Array(parts.enumerated()), id: \.offset) { _, part in
                    if part.isCode {
                        T(part.text, size, .bold)
                            .fixedSize()
                            .padding(.horizontal, 5)
                            .frame(height: size + 4)
                            .background(RoundedRectangle(cornerRadius: 7, style: .continuous).fill(Theme.peachCode))
                    } else {
                        T(part.text, size, .medium).fixedSize()
                    }
                }
            }
        } else {
            T(text, size, .medium).fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// Tiêu đề bottom sheet với nút đóng tròn.
struct SheetTitle: View {
    @EnvironmentObject var ui: AppUI
    let title: String
    var subtitle: String? = nil
    var size: CGFloat = 20

    var body: some View {
        // Có dòng phụ thì nút đóng thẳng hàng với đỉnh tiêu đề, như mẫu Live mới.
        HStack(alignment: subtitle == nil ? .center : .top) {
            VStack(alignment: .leading, spacing: 1.5) {
                T(title, size, .heavy, Theme.ink, track: -0.3)
                if let subtitle { T(subtitle, 13, .medium, Theme.muted).lineLimit(1).minimumScaleFactor(0.85) }
            }
            Spacer()
            Button { ui.dismissSheet() } label: {
                Icon(name: .close, size: 20).frame(width: 44, height: 44).background(Circle().fill(Theme.field))
            }
            .buttonStyle(.plain)
        }
    }
}
