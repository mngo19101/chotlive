import SwiftUI
import UIKit

// MARK: - Màu, chữ (đo từ mẫu thiết kế, màn 390×844)

extension Color {
    init(hex: UInt32) {
        self.init(red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255)
    }
}

enum Theme {
    static let bg = Color(hex: 0xF6F7F9)
    static let card = Color.white
    static let line = Color(hex: 0xE6E8EC)
    static let ink = Color(hex: 0x14181F)
    static let muted = Color(hex: 0x5B6472)
    static let faint = Color(hex: 0x8B93A0)
    static let placeholder = Color(hex: 0x7D8592)
    static let orange = Color(hex: 0xFF9A4C)
    static let orangeDeep = Color(hex: 0xEA6A09)
    static let accent = Color(hex: 0xB5490C)
    static let peach = Color(hex: 0xFEE4CD)
    static let peachSoft = Color(hex: 0xFEF4EA)
    static let peachLine = Color(hex: 0xFFBD87)
    static let slate = Color(hex: 0xE6E9F0)
    static let green = Color(hex: 0x107A54)
    static let greenSoft = Color(hex: 0xE6F7EF)
    static let greenBright = Color(hex: 0x4ADE9C)
    static let red = Color(hex: 0xB3261E)
    static let redSoft = Color(hex: 0xFDECEC)
    static let live = Color(hex: 0xE5484D)
    static let bar = Color(hex: 0xCBD2DC)
    static let field = Color(hex: 0xF6F7F9)
    static let track = Color(hex: 0xEFF0F4)
    static let grayBadge = Color(hex: 0xEBEEF3)
    static let grabber = Color(hex: 0xD6D9DF)
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

    var body: some View {
        ZStack(alignment: .bottom) {
            if let s = ui.sheet {
                (s.dim >= 0.9 ? Color(hex: 0x2B3036) : Theme.ink.opacity(s.dim))
                    .ignoresSafeArea()
                    .onTapGesture { ui.dismissSheet() }
                    .transition(.opacity)

                VStack(spacing: 0) {
                    Capsule().fill(Theme.grabber).frame(width: 40, height: 4)
                        .padding(.top, 10).padding(.bottom, 8)
                    s.content
                }
                .frame(maxWidth: .infinity)
                .padding(.bottom, Metrics.safeBottom > 0 ? -6 : 16)
                .background(TopRounded(radius: 28).fill(Color.white).ignoresSafeArea(.container, edges: .bottom))
                .offset(y: max(drag, 0))
                .gesture(
                    DragGesture(minimumDistance: 12)
                        .onChanged { drag = $0.translation.height }
                        .onEnded { v in
                            if v.translation.height > 90 { ui.dismissSheet() }
                            drag = 0
                        }
                )
                .transition(.move(edge: .bottom))
                .id(s.id)
            }
        }
        .animation(.spring(response: 0.32, dampingFraction: 0.92), value: ui.sheet?.id)
        .animation(.spring(response: 0.25, dampingFraction: 0.9), value: drag)
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
        seed.unicodeScalars.reduce(0) { ($0 &* 31 &+ Int($1.value)) & 0xFFFF } % 2 == 0
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
        }
        .buttonStyle(.plain)
    }
}

/// Khung trang con: nút lùi tròn, tiêu đề, nội dung; không có thanh tab.
struct SubPage<Trailing: View, Content: View>: View {
    @EnvironmentObject var ui: AppUI
    let title: String
    @ViewBuilder var trailing: () -> Trailing
    @ViewBuilder var content: () -> Content

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                CircleButton(icon: .chevronLeft) { ui.pop() }
                T(title, 20, .heavy, Theme.ink, track: -0.3).lineLimit(1).minimumScaleFactor(0.7)
                Spacer(minLength: 0)
                trailing()
            }
            .padding(.horizontal, Metrics.gutter)
            .padding(.bottom, 14)
            content()
        }
        .background(Theme.bg.ignoresSafeArea())
        .toolbar(.hidden, for: .navigationBar)
    }
}

extension SubPage where Trailing == EmptyView {
    init(title: String, @ViewBuilder content: @escaping () -> Content) {
        self.title = title
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

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            T(label, 12, .medium, Theme.muted)
            TextField(placeholder, text: $text)
                .font(.bv(15, .semibold))
                .foregroundColor(Theme.ink)
                .keyboardType(keyboard)
                .textInputAutocapitalization(capitalize ? .sentences : .never)
                .autocorrectionDisabled(!capitalize)
                .padding(.horizontal, 15)
                .frame(height: 44)
                .cardStyle(14, fill: Theme.field)
        }
    }
}

/// Tiêu đề bottom sheet với nút đóng tròn.
struct SheetTitle: View {
    @EnvironmentObject var ui: AppUI
    let title: String

    var body: some View {
        HStack {
            T(title, 20, .heavy, Theme.ink, track: -0.3)
            Spacer()
            Button { ui.dismissSheet() } label: {
                Icon(name: .close, size: 20).frame(width: 44, height: 44).background(Circle().fill(Theme.field))
            }
            .buttonStyle(.plain)
        }
    }
}
