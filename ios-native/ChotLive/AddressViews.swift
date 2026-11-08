import SwiftUI

// MARK: - Dữ liệu địa giới hành chính

/// AddressData.json nhúng trong app, để chọn khu vực không cần mạng.
/// - "new" (34 tỉnh, 3.321 phường/xã): thanglequoc/vietnamese-provinces-database v5.2.0 (MIT),
///   cập nhật tới Nghị quyết 388/NQ-UBTVQH16, hiệu lực 20/9/2026.
/// - "old" (63 tỉnh, 696 quận/huyện, 10.035 phường/xã): kenzouno1/DiaGioiHanhChinhVN,
///   cấu trúc 3 cấp trước khi bỏ cấp huyện ngày 1/7/2025.
struct AreaUnit: Decodable {
    let n: String
    let d: [AreaUnit]?
    let w: [String]?
}

enum AddressBook {
    private struct Payload: Decodable {
        let new: [AreaUnit]
        let old: [AreaUnit]
    }

    private static let payload: Payload = {
        guard let url = Bundle.main.url(forResource: "AddressData", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let decoded = try? JSONDecoder().decode(Payload.self, from: data) else {
            return Payload(new: [], old: [])
        }
        return decoded
    }()

    static var new: [AreaUnit] { payload.new }
    static var old: [AreaUnit] { payload.old }

    private static let vietnamese = Locale(identifier: "vi_VN")

    /// Theo thứ tự chữ cái tiếng Việt, "Phường 2" đứng trước "Phường 10".
    static func sorted(_ names: [String]) -> [String] {
        names.sorted { $0.compare($1, options: [.numeric], range: nil, locale: vietnamese) == .orderedAscending }
    }

    /// Tỉnh xếp theo tên riêng, không theo chữ "TP." / "Tỉnh".
    static func sortedProvinces(_ names: [String]) -> [String] {
        func key(_ s: String) -> String {
            for prefix in ["TP. ", "Tỉnh "] where s.hasPrefix(prefix) { return String(s.dropFirst(prefix.count)) }
            return s
        }
        return names.sorted { key($0).compare(key($1), options: [.numeric], range: nil, locale: vietnamese) == .orderedAscending }
    }
}

enum AppSheet {
    /// Độ tối nền sau bottom sheet (đo từ mẫu).
    static let dim = 0.545
}

// MARK: - Sửa địa chỉ

struct AddressEditView: View {
    let customerId: String
    @EnvironmentObject var store: Store
    @EnvironmentObject var ui: AppUI
    @State private var address = DeliveryAddress()
    @State private var loaded = false

    private var customer: Customer? { store.customers.first { $0.id == customerId } }

    private var canSave: Bool {
        [address.phone, address.receiver, address.street, address.region]
            .allSatisfy { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
    }

    var body: some View {
        SubPage(title: "Sửa địa chỉ",
                subtitle: customer.map { "\($0.nickname) · @\($0.uniqueId)" },
                headerBottom: 20) {
            ScrollView(showsIndicators: false) {
                VStack(spacing: 17) {
                    section(.user, "Người nhận") {
                        field("Số điện thoại", text: $address.phone, placeholder: "", keyboard: .phonePad)
                        field("Họ tên", text: $address.receiver, placeholder: "")
                    }
                    section(.pin, "Địa chỉ nhận hàng") {
                        field("Địa chỉ", text: $address.street, placeholder: "")
                        regionField
                    }
                    section(.messageSquare, "Ghi chú giao") {
                        FlowLayout(spacing: 8, lineSpacing: 9) {
                            ForEach(DeliveryAddress.noteOptions, id: \.self) { noteChip($0) }
                        }
                    }
                }
                .padding(.horizontal, Metrics.gutter)
                .padding(.bottom, 16)
            }
            .scrollDismissesKeyboard(.interactively)
            FooterBar {
                HStack(spacing: 12.5) {
                    Button { ui.pop() } label: {
                        T("Huỷ", 16, .bold)
                            .frame(width: 83.5, height: 55.5)
                            .background(Capsule().fill(Theme.card).overlay(Capsule().strokeBorder(Theme.line, lineWidth: 1)))
                    }
                    .buttonStyle(.plain)
                    PrimaryButton(title: "Lưu thay đổi", fontSize: 18, height: 55.5, enabled: canSave) {
                        store.setAddress(address, customerId: customerId)
                        ui.pop()
                    }
                }
            }
        }
        .onAppear {
            guard !loaded else { return }
            loaded = true
            if let c = customer {
                address = c.address ?? DeliveryAddress()
                if address.receiver.isEmpty { address.receiver = c.nickname }
            }
        }
    }

    private func section<Content: View>(_ icon: IconName, _ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 14.5) {
            HStack(spacing: 10) {
                Icon(name: icon, size: 15, weight: 2.3, color: Theme.accent)
                    .frame(width: 32, height: 32)
                    .background(Circle().fill(Theme.peachTint))
                T(title, 17, .bold).lineLimit(1)
            }
            content()
        }
        .padding(.horizontal, 19)
        .padding(.top, 19)
        .padding(.bottom, 20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardStyle(24)
    }

    private func label(_ title: String) -> some View {
        T(title + " ", 13, .semibold, Theme.muted) + T("*", 14, .bold, Theme.red)
    }

    private func field(_ title: String, text: Binding<String>, placeholder: String, keyboard: UIKeyboardType = .default) -> some View {
        VStack(alignment: .leading, spacing: 6.4) {
            label(title)
            TextField(placeholder, text: text)
                .font(.bv(16, .semibold))
                .foregroundColor(Theme.ink)
                .keyboardType(keyboard)
                .padding(.horizontal, 17)
                .frame(height: 50)
                .cardStyle(16, fill: Theme.field)
        }
    }

    private var regionField: some View {
        VStack(alignment: .leading, spacing: 6.4) {
            label("Phường / Quận / Tỉnh")
            Button {
                let current = address.region
                ui.present(dim: AppSheet.dim) {
                    AreaPickerSheet(region: current) { address.region = $0 }
                }
            } label: {
                HStack(spacing: 10) {
                    T(regionText, 16, .semibold)
                        .lineSpacing(2)
                        .multilineTextAlignment(.leading)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .fixedSize(horizontal: false, vertical: true)
                    Icon(name: .chevronDown, size: 16, color: Theme.muted)
                }
                .padding(.leading, 17)
                .padding(.trailing, 16)
                .padding(.vertical, 11.5)
                .frame(minHeight: 50)
                .cardStyle(16, fill: Theme.field)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
    }

    /// Tên tỉnh không bị tách làm hai dòng ("TP." một dòng, "Hồ Chí Minh" một dòng).
    private var regionText: String {
        var parts = address.region.components(separatedBy: ", ")
        guard let last = parts.popLast() else { return address.region }
        parts.append(last.replacingOccurrences(of: " ", with: "\u{00A0}"))
        return parts.joined(separator: ", ")
    }

    private func noteChip(_ option: String) -> some View {
        let selected = address.hasNote(option)
        return Button { address.toggleNote(option) } label: {
            HStack(spacing: 8) {
                if selected { Icon(name: .check, size: 14, weight: 2.6, color: Theme.accentDeep) }
                T(option, 14, .semibold, selected ? Theme.accentDeep : Theme.ink).lineLimit(1).fixedSize()
            }
            .padding(.horizontal, 15)
            .frame(height: 38.6)
            .background(
                Capsule().fill(selected ? Theme.peachTint : Theme.card)
                    .overlay(Capsule().strokeBorder(selected ? Theme.peachLine : Theme.line, lineWidth: 1))
            )
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Chọn khu vực

struct AreaPickerSheet: View {
    @EnvironmentObject var ui: AppUI
    let onConfirm: (String) -> Void

    private enum Mode { case new, old }
    private enum Level { case province, district, ward }

    @State private var mode: Mode
    @State private var level: Level
    @State private var province: String?
    @State private var district: String?
    @State private var ward: String?
    @State private var query = ""

    init(region: String, onConfirm: @escaping (String) -> Void) {
        self.onConfirm = onConfirm
        let start = Self.parse(region)
        _mode = State(initialValue: start.mode)
        _province = State(initialValue: start.province)
        _district = State(initialValue: start.district)
        _ward = State(initialValue: start.ward)
        let startLevel: Level
        if start.province == nil {
            startLevel = .province
        } else if start.mode == .old && start.ward == nil {
            startLevel = .district
        } else {
            startLevel = .ward
        }
        _level = State(initialValue: startLevel)
    }

    /// Đọc lại khu vực đang lưu; không khớp dữ liệu thì bắt đầu từ đầu.
    private static func parse(_ region: String) -> (mode: Mode, province: String?, district: String?, ward: String?) {
        let parts = region.components(separatedBy: ", ").map { $0.trimmingCharacters(in: .whitespaces) }
        guard let provinceName = parts.last else { return (.new, nil, nil, nil) }
        if parts.count == 3,
           let d = AddressBook.old.first(where: { $0.n == provinceName })?.d?.first(where: { $0.n == parts[1] }),
           d.w?.contains(parts[0]) == true {
            return (.old, provinceName, parts[1], parts[0])
        }
        if parts.count == 2 {
            if AddressBook.new.first(where: { $0.n == provinceName })?.w?.contains(parts[0]) == true {
                return (.new, provinceName, nil, parts[0])
            }
            // Huyện đảo không có cấp xã.
            if AddressBook.old.first(where: { $0.n == provinceName })?.d?.contains(where: { $0.n == parts[0] }) == true {
                return (.old, provinceName, parts[0], nil)
            }
        }
        return (.new, nil, nil, nil)
    }

    private var provinces: [AreaUnit] { mode == .old ? AddressBook.old : AddressBook.new }
    private var provinceUnit: AreaUnit? { provinces.first { $0.n == province } }
    private var districtUnit: AreaUnit? { provinceUnit?.d?.first { $0.n == district } }

    private var names: [String] {
        switch level {
        case .province: return AddressBook.sortedProvinces(provinces.map(\.n))
        case .district: return AddressBook.sorted(provinceUnit?.d?.map(\.n) ?? [])
        case .ward:
            let wards = mode == .old ? districtUnit?.w : provinceUnit?.w
            return AddressBook.sorted(wards ?? [])
        }
    }

    private var shown: [String] {
        let q = PriceParser.stripAccents(query.trimmingCharacters(in: .whitespaces).lowercased())
        return q.isEmpty ? names : names.filter { PriceParser.stripAccents($0.lowercased()).contains(q) }
    }

    private var selectedName: String? {
        switch level {
        case .province: return province
        case .district: return district
        case .ward: return ward
        }
    }

    private var isComplete: Bool {
        if ward != nil { return true }
        return mode == .old && district != nil && districtUnit?.w?.isEmpty == true
    }

    private var summary: String {
        [ward, district, province].compactMap { $0 }.joined(separator: ", ")
    }

    var body: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 0) {
                SheetTitle(title: "Chọn khu vực", size: 23).padding(.top, 7)
                modeSwitch.padding(.top, 16)
                T(mode == .old ? "Theo đơn vị hành chính cũ: Tỉnh / Thành phố → Quận / Huyện → Phường / Xã"
                               : "Theo đơn vị hành chính mới: Tỉnh / Thành phố → Phường / Xã", 12.5, .medium, Theme.muted)
                    .lineSpacing(2)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 2)
                    .padding(.top, 8)
                FlowLayout(spacing: 8, lineSpacing: 8) { steps }.padding(.top, 15)
                searchBox.padding(.top, 12.5)
            }
            .padding(.horizontal, Metrics.gutter)

            ScrollView(showsIndicators: false) {
                LazyVStack(spacing: 0) {
                    ForEach(Array(shown.enumerated()), id: \.element) { index, name in
                        if index > 0 { HairLine() }
                        row(name)
                    }
                }
                .padding(.horizontal, Metrics.gutter)
            }
            .scrollDismissesKeyboard(.immediately)
            .padding(.top, 8)
            .frame(maxHeight: .infinity)

            HairLine()
            VStack(alignment: .leading, spacing: 3) {
                T("Địa chỉ đã chọn", 12.5, .medium, Theme.muted)
                T(summary.isEmpty ? " " : summary, 15, .bold).lineLimit(1).minimumScaleFactor(0.75)
                PrimaryButton(title: "Xác nhận", fontSize: 18, height: 55.5, enabled: isComplete) {
                    onConfirm(summary)
                    ui.dismissSheet()
                }
                .padding(.top, 6.5)
            }
            .padding(.horizontal, Metrics.gutter)
            .padding(.top, 12)
        }
        .frame(height: Metrics.sheetHeight(top: 96))
    }

    private var modeSwitch: some View {
        HStack(spacing: 0) {
            modeButton("Địa chỉ mới", .new)
            modeButton("Địa chỉ cũ", .old)
        }
        .padding(4)
        .frame(width: 236, height: 38)
        .background(Capsule().fill(Theme.track))
    }

    private func modeButton(_ title: String, _ value: Mode) -> some View {
        Button {
            guard mode != value else { return }
            // Hai cách phân cấp khác nhau nên đổi chế độ thì chọn lại từ đầu.
            mode = value
            province = nil
            district = nil
            ward = nil
            level = .province
            query = ""
        } label: {
            T(title, 13, .bold, mode == value ? Theme.ink : Theme.muted)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Capsule().fill(mode == value ? Theme.orange : Color.clear))
                .onAccent(mode == value)
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder private var steps: some View {
        step(.province, province, placeholder: "Tỉnh / Thành phố")
        if mode == .old, province != nil { step(.district, district, placeholder: "Quận / Huyện") }
        if province != nil, mode == .new || (district != nil && districtUnit?.w?.isEmpty == false) {
            step(.ward, ward, placeholder: "Phường / Xã")
        }
    }

    private func step(_ value: Level, _ name: String?, placeholder: String) -> some View {
        let active = level == value
        return Button {
            level = value
            query = ""
        } label: {
            HStack(spacing: 6) {
                if !active && name != nil { Icon(name: .check, size: 14, weight: 2.6, color: Theme.green) }
                T(name ?? placeholder, 14, active ? .bold : .semibold).lineLimit(1).fixedSize()
            }
            .padding(.horizontal, active ? 13.5 : 13)
            .frame(height: 35.5)
            .background(
                Capsule().fill(Theme.card)
                    .overlay(Capsule().strokeBorder(active ? Theme.ink : Theme.line, lineWidth: active ? 1.5 : 1))
            )
        }
        .buttonStyle(.plain)
    }

    private var searchBox: some View {
        HStack(spacing: 14) {
            Icon(name: .search, size: 17, weight: 2.3, color: Theme.muted)
            ZStack(alignment: .leading) {
                if query.isEmpty { T(searchPlaceholder, 15, .medium, Theme.placeholder).lineLimit(1) }
                TextField("", text: $query)
                    .font(.bv(15, .medium))
                    .foregroundColor(Theme.ink)
                    .autocorrectionDisabled()
            }
        }
        .padding(.leading, 19)
        .padding(.trailing, 16)
        .frame(height: 47.5)
        .background(Capsule().fill(Theme.field).overlay(Capsule().strokeBorder(Theme.line, lineWidth: 1)))
    }

    private var searchPlaceholder: String {
        switch level {
        case .province: return "Tìm tỉnh / thành phố"
        case .district: return "Tìm quận / huyện"
        case .ward: return "Tìm phường / xã"
        }
    }

    private func row(_ name: String) -> some View {
        let selected = selectedName == name
        return Button { select(name) } label: {
            HStack {
                T(name, 16, selected ? .bold : .medium).lineLimit(1)
                Spacer(minLength: 8)
                if selected {
                    Icon(name: .check, size: 14, weight: 2.8)
                        .frame(width: 26, height: 26)
                        .background(Circle().fill(Theme.orange))
                        .onAccent()
                }
            }
            .padding(.horizontal, 4)
            .frame(height: 53)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func select(_ name: String) {
        query = ""
        switch level {
        case .province:
            if province != name {
                province = name
                district = nil
                ward = nil
            }
            level = mode == .old ? .district : .ward
        case .district:
            if district != name {
                district = name
                ward = nil
            }
            // Huyện đảo không có phường/xã: chọn huyện là đủ.
            if districtUnit?.w?.isEmpty == false { level = .ward }
        case .ward:
            ward = name
        }
    }
}
