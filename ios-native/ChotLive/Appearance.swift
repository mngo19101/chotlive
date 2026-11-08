import SwiftUI
import UIKit

// MARK: - Màu đổi theo nền Sáng/Tối

extension UIColor {
    convenience init(hex: UInt32) {
        self.init(red: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
                  blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
    }
}

extension Color {
    /// Một màu cho nền Sáng, một màu cho nền Tối; iOS tự chọn theo màn hình đang hiện.
    static func dynamic(_ light: UInt32, _ dark: UInt32) -> Color {
        let l = UIColor(hex: light), d = UIColor(hex: dark)
        return Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? d : l })
    }
}

/// Trộn hai màu: `share` là phần của màu `a` (0...1).
func mixHex(_ a: UInt32, _ b: UInt32, _ share: Double) -> UInt32 {
    func ch(_ c: UInt32, _ shift: UInt32) -> Double { Double((c >> shift) & 0xFF) }
    var out: UInt32 = 0
    for shift: UInt32 in [16, 8, 0] {
        let v = (ch(a, shift) * share + ch(b, shift) * (1 - share)).rounded()
        out |= UInt32(min(max(v, 0), 255)) << shift
    }
    return out
}

// MARK: - Màu chủ đạo

/// Bảng màu của một màu chủ đạo. `fill` là nền nút (chữ trên nút luôn màu tối), `text` là chữ nhấn trên nền sáng,
/// `darkText` là chữ nhấn trên nền tối. Các nền nhạt (peach…) trộn từ màu đậm với nền thẻ.
struct AccentPalette: Equatable {
    var fill: UInt32
    var deep: UInt32
    var text: UInt32
    var textDeep: UInt32
    var darkText: UInt32
    var darkTextDeep: UInt32
    var peach: UInt32
    var peachSoft: UInt32
    var peachLine: UInt32
    var peachTint: UInt32
    var peachCode: UInt32
    var peachRow: UInt32

    static let lightCard: UInt32 = 0xFFFFFF
    static let darkCard: UInt32 = 0x1A1D23

    init(fill: UInt32, deep: UInt32, text: UInt32, textDeep: UInt32, darkText: UInt32, darkTextDeep: UInt32) {
        self.fill = fill
        self.deep = deep
        self.text = text
        self.textDeep = textDeep
        self.darkText = darkText
        self.darkTextDeep = darkTextDeep
        let w = Self.lightCard
        peach = mixHex(deep, w, 0.2)
        peachSoft = mixHex(deep, w, 0.08)
        peachLine = mixHex(fill, w, 0.66)
        peachTint = mixHex(deep, w, 0.1)
        peachCode = mixHex(deep, w, 0.16)
        peachRow = mixHex(deep, w, 0.05)
    }

    /// Nền nhạt trên nền tối: trộn màu đậm với màu thẻ tối, đậm hơn bản sáng một chút cho dễ thấy.
    var darkPeach: UInt32 { mixHex(deep, Self.darkCard, 0.3) }
    var darkPeachSoft: UInt32 { mixHex(deep, Self.darkCard, 0.14) }
    var darkPeachLine: UInt32 { mixHex(deep, Self.darkCard, 0.45) }
    var darkPeachTint: UInt32 { mixHex(deep, Self.darkCard, 0.18) }
    var darkPeachCode: UInt32 { mixHex(deep, Self.darkCard, 0.26) }
    var darkPeachRow: UInt32 { mixHex(deep, Self.darkCard, 0.1) }
}

enum AccentChoice: String, CaseIterable, Identifiable {
    case vang, xanh, ngoc, la, hong, tim

    var id: String { rawValue }

    var name: String {
        switch self {
        case .vang: return "Vàng"
        case .xanh: return "Xanh dương"
        case .ngoc: return "Xanh ngọc"
        case .la: return "Xanh lá"
        case .hong: return "Hồng"
        case .tim: return "Tím"
        }
    }

    var palette: AccentPalette {
        switch self {
        case .vang:
            // Giữ đúng các màu của mẫu thiết kế gốc.
            var p = AccentPalette(fill: 0xFF9A4C, deep: 0xEA6A09, text: 0xB5490C, textDeep: 0x7A3300,
                                  darkText: 0xFFA94D, darkTextDeep: 0xFFC58A)
            p.peach = 0xFEE4CD
            p.peachSoft = 0xFEF4EA
            p.peachLine = 0xFFBD87
            p.peachTint = 0xFFF1E4
            p.peachCode = 0xFFE9D2
            p.peachRow = 0xFFF7EC
            return p
        case .xanh:
            return AccentPalette(fill: 0x6E9CFF, deep: 0x2563EB, text: 0x1D4ED8, textDeep: 0x1E3A8A,
                                 darkText: 0x8AB0FF, darkTextDeep: 0xB5CDFF)
        case .ngoc:
            return AccentPalette(fill: 0x3CC4B4, deep: 0x0D9488, text: 0x0B6B62, textDeep: 0x134E4A,
                                 darkText: 0x4FD1C1, darkTextDeep: 0x99E6DC)
        case .la:
            return AccentPalette(fill: 0x5CCB85, deep: 0x16A34A, text: 0x166534, textDeep: 0x14532D,
                                 darkText: 0x6EDB95, darkTextDeep: 0xA7EBC0)
        case .hong:
            return AccentPalette(fill: 0xFF85B5, deep: 0xDB2777, text: 0xBE185D, textDeep: 0x831843,
                                 darkText: 0xFF85BB, darkTextDeep: 0xFFB8D6)
        case .tim:
            return AccentPalette(fill: 0xA98BFF, deep: 0x7C3AED, text: 0x6D28D9, textDeep: 0x4C1D95,
                                 darkText: 0xB9A0FF, darkTextDeep: 0xD6C8FF)
        }
    }

    static var saved: AccentChoice {
        #if DEBUG
        if let demo = Appearance.demoArg("-demoAccent").flatMap(AccentChoice.init(rawValue:)) { return demo }
        #endif
        return UserDefaults.standard.string(forKey: Appearance.accentKey).flatMap(AccentChoice.init(rawValue:)) ?? .vang
    }
}

/// Các màu nhấn đang dùng, dựng lại mỗi khi đổi màu chủ đạo.
struct AccentColors {
    let orange: Color
    let orangeDeep: Color
    let accent: Color
    let accentDeep: Color
    let peach: Color
    let peachSoft: Color
    let peachLine: Color
    let peachTint: Color
    let peachCode: Color
    let peachRow: Color

    init(_ choice: AccentChoice) {
        let p = choice.palette
        // Nền nút sáng cả hai chế độ, chữ trên nút luôn tối (xem `onAccent`).
        orange = Color(hex: p.fill)
        orangeDeep = Color(hex: p.deep)
        accent = .dynamic(p.text, p.darkText)
        accentDeep = .dynamic(p.textDeep, p.darkTextDeep)
        peach = .dynamic(p.peach, p.darkPeach)
        peachSoft = .dynamic(p.peachSoft, p.darkPeachSoft)
        peachLine = .dynamic(p.peachLine, p.darkPeachLine)
        peachTint = .dynamic(p.peachTint, p.darkPeachTint)
        peachCode = .dynamic(p.peachCode, p.darkPeachCode)
        peachRow = .dynamic(p.peachRow, p.darkPeachRow)
    }
}

// MARK: - Chế độ nền

enum AppearanceMode: String, CaseIterable, Identifiable {
    case light, dark, system

    var id: String { rawValue }

    var label: String {
        switch self {
        case .light: return "Sáng"
        case .dark: return "Tối"
        case .system: return "Theo máy"
        }
    }

    var icon: IconName {
        switch self {
        case .light: return .sun
        case .dark: return .moon
        case .system: return .smartphone
        }
    }

    var style: UIUserInterfaceStyle {
        switch self {
        case .light: return .light
        case .dark: return .dark
        case .system: return .unspecified
        }
    }
}

/// Lựa chọn Giao diện của người dùng, lưu trên máy này.
@MainActor
final class Appearance: ObservableObject {
    nonisolated static let modeKey = "appearanceMode"
    nonisolated static let accentKey = "appearanceAccent"
    nonisolated static let seenKey = "appearanceSeen"

    private let defaults: UserDefaults

    @Published var mode: AppearanceMode {
        didSet {
            guard mode != oldValue else { return }
            defaults.set(mode.rawValue, forKey: Self.modeKey)
            applyToWindows()
        }
    }

    @Published var accent: AccentChoice {
        didSet {
            guard accent != oldValue else { return }
            defaults.set(accent.rawValue, forKey: Self.accentKey)
            Theme.use(accent)
        }
    }

    /// Đã mở màn Giao diện lần nào chưa (để ẩn nhãn "MỚI").
    @Published var seen: Bool {
        didSet { defaults.set(seen, forKey: Self.seenKey) }
    }

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        var mode = defaults.string(forKey: Self.modeKey).flatMap(AppearanceMode.init(rawValue:)) ?? .light
        #if DEBUG
        if let demo = Self.demoArg("-demoAppearance").flatMap(AppearanceMode.init(rawValue:)) { mode = demo }
        #endif
        self.mode = mode
        self.accent = defaults.string(forKey: Self.accentKey).flatMap(AccentChoice.init(rawValue:)) ?? .vang
        self.seen = defaults.bool(forKey: Self.seenKey)
        #if DEBUG
        if let demo = Self.demoArg("-demoAccent").flatMap(AccentChoice.init(rawValue:)) { self.accent = demo }
        #endif
        Theme.use(accent)
    }

    var summary: String { "\(mode.label) · \(accent.name)" }

    /// Đặt Sáng/Tối cho cả cửa sổ app: thanh trạng thái, bàn phím và hộp thoại hệ thống cũng đổi theo.
    func applyToWindows() {
        for scene in UIApplication.shared.connectedScenes {
            guard let windowScene = scene as? UIWindowScene else { continue }
            for window in windowScene.windows { window.overrideUserInterfaceStyle = mode.style }
        }
    }

    nonisolated static func demoArg(_ name: String) -> String? {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
        return args[i + 1]
    }
}

// MARK: - Chữ trên nền màu chủ đạo

private struct OnAccent: ViewModifier {
    let active: Bool
    @Environment(\.colorScheme) private var scheme

    func body(content: Content) -> some View {
        content.environment(\.colorScheme, active ? .light : scheme)
    }
}

extension View {
    /// Nền nút màu chủ đạo luôn sáng, nên chữ và icon bên trên dùng màu của chế độ Sáng (chữ tối) kể cả khi app đang nền Tối.
    func onAccent(_ active: Bool = true) -> some View { modifier(OnAccent(active: active)) }
}

// MARK: - Màn Giao diện

struct AppearanceView: View {
    @EnvironmentObject var appearance: Appearance
    @EnvironmentObject var ui: AppUI

    private let columns = Array(repeating: GridItem(.flexible(), spacing: 10), count: 3)

    var body: some View {
        VStack(spacing: 0) {
            SubPage(title: "Giao diện", subtitle: appearance.summary) {
                ScrollView(showsIndicators: false) {
                    VStack(alignment: .leading, spacing: 22) {
                        modeSection
                        accentSection
                    }
                    .padding(.horizontal, Metrics.gutter)
                    .padding(.bottom, 20)
                }
            }
            // Thanh tab ngay dưới màn này để thấy màu tab đổi theo; bấm vào tab nào thì về tab đó.
            TabBar(selection: Binding(get: { AppTab.me }, set: { tab in
                ui.tab = tab
                ui.path = NavigationPath()
            }))
        }
        .background(Theme.bg.ignoresSafeArea())
        .ignoresSafeArea(.container, edges: .bottom)
        .onAppear { if !appearance.seen { appearance.seen = true } }
    }

    private var modeSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            T("Chế độ nền", 13, .bold, Theme.muted)
            HStack(spacing: 10) {
                ForEach(AppearanceMode.allCases) { modeTile($0) }
            }
            T("“Theo máy” tự đổi Sáng/Tối theo cài đặt của iPhone.", 11, .medium, Theme.muted)
        }
    }

    private func modeTile(_ m: AppearanceMode) -> some View {
        let selected = appearance.mode == m
        return Button { appearance.mode = m } label: {
            VStack(alignment: .leading, spacing: 9) {
                HStack(spacing: 0) {
                    miniPage(dark: m == .dark)
                    miniPage(dark: m != .light)
                }
                .frame(height: 76)
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Theme.line, lineWidth: 1))
                HStack(spacing: 6) {
                    Icon(name: m.icon, size: 15, weight: 2.2, color: selected ? Theme.accent : Theme.muted)
                    T(m.label, 13, .bold).lineLimit(1).minimumScaleFactor(0.8)
                    Spacer(minLength: 0)
                    ZStack {
                        if selected {
                            Circle().fill(Theme.orange)
                            Icon(name: .check, size: 11, weight: 3.4).onAccent()
                        } else {
                            Circle().strokeBorder(Theme.bar, lineWidth: 1.5)
                        }
                    }
                    .frame(width: 18, height: 18)
                }
            }
            .padding(EdgeInsets(top: 8, leading: 8, bottom: 10, trailing: 8))
            .frame(maxWidth: .infinity)
            .background(
                RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Theme.card)
                    .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .strokeBorder(selected ? Theme.orangeDeep : Theme.line, lineWidth: selected ? 2 : 1))
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Nền \(m.label)")
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    /// Hình thu nhỏ một trang: nửa trái/phải của ô "Theo máy" là Sáng và Tối.
    private func miniPage(dark: Bool) -> some View {
        let bg = Color(hex: dark ? 0x0F1115 : 0xF6F7F9)
        let card = Color(hex: dark ? 0x1A1D23 : 0xFFFFFF)
        return VStack(alignment: .leading, spacing: 6) {
            RoundedRectangle(cornerRadius: 4).fill(card).frame(height: 14)
            RoundedRectangle(cornerRadius: 4).fill(Theme.orange).frame(height: 7).frame(maxWidth: .infinity, alignment: .leading)
                .padding(.trailing, 10)
            RoundedRectangle(cornerRadius: 4).fill(card).frame(height: 14)
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 9)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(bg)
    }

    private var accentSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                T("Màu chủ đạo", 13, .bold, Theme.muted)
                Spacer()
                T("Nút, chữ nhấn và thanh tab", 11, .semibold, Theme.muted)
            }
            LazyVGrid(columns: columns, spacing: 4) {
                ForEach(AccentChoice.allCases) { accentSwatch($0) }
            }
            .padding(.vertical, 10)
            .padding(.horizontal, 8)
            .cardStyle(20)
        }
    }

    private func accentSwatch(_ a: AccentChoice) -> some View {
        let selected = appearance.accent == a
        let fill = Color(hex: a.palette.fill)
        return Button { appearance.accent = a } label: {
            VStack(spacing: 5) {
                ZStack {
                    Circle().strokeBorder(selected ? Color(hex: a.palette.deep) : Color.clear, lineWidth: 2)
                        .frame(width: 48, height: 48)
                    Circle().fill(fill).frame(width: 36, height: 36)
                    if selected { Icon(name: .check, size: 18, weight: 3).onAccent() }
                }
                T(a.name, 12, .bold).lineLimit(1).minimumScaleFactor(0.8)
                T(a == .vang ? "Mặc định" : " ", 10, .semibold, Theme.muted)
            }
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Màu \(a.name)")
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}
