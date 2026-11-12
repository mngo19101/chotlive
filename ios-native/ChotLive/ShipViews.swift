import SwiftUI
import UIKit

// MARK: - Màu riêng cho đơn gom và khách lỗi

extension Theme {
    /// Thẻ đơn mới của khách còn đơn gom ngày trước.
    static let gomFill = Color.dynamic(0xFFF8E6, 0x2A2413)
    static let gomLine = Color.dynamic(0xF5C96A, 0x6E5622)
    /// Nhãn "Có N đơn gom…", "gộp 2 đơn".
    static let gomTag = Color.dynamic(0xFFF1D6, 0x3A2F15)
    static let gomInk = Color.dynamic(0x8A5300, 0xF5C96A)
    /// Dòng khách thiếu thông tin trong bảng xuất.
    static let badRow = Color.dynamic(0xFDF6F6, 0x2A191A)
    /// Nút chọn 2 lựa chọn.
    static let segTrack = Color.dynamic(0xE9EBF0, 0x262A31)
    static let segOn = Color.dynamic(0xFFFFFF, 0x3A3F48)
}

/// "05/11"
func dayMonth(_ d: Date) -> String {
    let c = Calendar.current.dateComponents([.day, .month], from: d)
    return String(format: "%02d/%02d", c.day ?? 0, c.month ?? 0)
}

/// "419.000": số tiền trong ô nhập, không kèm đơn vị.
func moneyDigits(_ n: Int) -> String { String(money(n).dropLast(2)) }

/// Chữ trên nút giữa của thẻ đơn và trang chi tiết.
func shipButtonLabel(_ o: Order) -> String {
    switch Vtp.state(o) {
    case .ask: return "Duyệt đơn"
    case .hold: return "Gom sau"
    case .ready: return "Sẵn sàng"
    case .exported, .gone:
        if VtpTrack.isReturned(o) { return "Hoàn về" }
        return o.status == .delivered ? "Đã giao" : "Đang giao"
    }
}

func shipButtonColor(_ o: Order) -> Color {
    switch Vtp.state(o) {
    case .ask, .hold: return Theme.ink
    case .ready: return Theme.accent
    case .exported, .gone:
        if VtpTrack.isReturned(o) { return Theme.red }
        return o.status == .delivered ? Theme.green : Theme.accent
    }
}

/// Nhãn trạng thái ở trang chi tiết đơn.
struct ShipBadge: View {
    let order: Order
    var fontSize: CGFloat = 12
    var height: CGFloat = 25

    var body: some View {
        let s = Vtp.state(order)
        switch s {
        case .ask: Badge(text: "Đơn mới", fontSize: fontSize, height: height, hPad: 12)
        case .hold: Badge(text: "Gom sau", color: Theme.gomInk, fill: Theme.gomTag, fontSize: fontSize, height: height, hPad: 12)
        case .ready: Badge(text: "Sẵn sàng", fontSize: fontSize, height: height, hPad: 12)
        case .exported, .gone:
            if VtpTrack.isReturned(order) {
                Badge(text: "Hoàn về", color: Theme.red, fill: Theme.redSoft, fontSize: fontSize, height: height,
                      hPad: height >= 25 ? 12 : 8)
            } else {
                StatusBadge(status: order.status, fontSize: fontSize, height: height)
            }
        }
    }
}

/// Nút chọn 2 lựa chọn rộng hết hàng: nền xám, nút đang chọn trắng có bóng nhẹ.
struct SegmentPicker: View {
    let options: [(value: String, title: String)]
    let selected: String
    var enabled = true
    let onSelect: (String) -> Void

    var body: some View {
        HStack(spacing: 0) {
            ForEach(options.indices, id: \.self) { i in
                let opt = options[i]
                let on = opt.value == selected
                Button { onSelect(opt.value) } label: {
                    T(opt.title, 14, on ? .bold : .semibold, on ? Theme.ink : Theme.muted)
                        .lineLimit(1)
                        .minimumScaleFactor(0.85)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(
                            Capsule().fill(on ? Theme.segOn : Color.clear)
                                .shadow(color: .black.opacity(on ? 0.08 : 0), radius: 2, y: 1)
                        )
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .disabled(!enabled)
            }
        }
        .padding(3)
        .frame(height: 44)
        .background(Capsule().fill(Theme.segTrack))
        .opacity(enabled ? 1 : 0.6)
    }
}

/// Nút X tròn 36 ở góc phải bảng dưới.
private struct SheetClose: View {
    @EnvironmentObject var ui: AppUI
    var body: some View {
        Button { ui.dismissSheet() } label: {
            Icon(name: .close, size: 17, weight: 2.4).frame(width: 36, height: 36).background(Circle().fill(Theme.field))
        }
        .buttonStyle(.plain)
    }
}

/// Dấu tick tròn cam; rỗng khi chưa chọn hoặc không chọn được.
struct TickCircle: View {
    let on: Bool
    var enabled = true

    var body: some View {
        ZStack {
            if on {
                Circle().fill(Theme.orange)
                Icon(name: .check, size: 13, weight: 3).onAccent()
            } else {
                Circle().strokeBorder(enabled ? Theme.faint : Theme.line, lineWidth: 1.6)
            }
        }
        .frame(width: 24, height: 24)
    }
}

private func fieldLabel(_ s: String) -> Text { T(s, 12, .semibold, Theme.muted) }

/// "1kg", "1,5kg"
func weightText(_ g: Int) -> String {
    let kg = Double(g) / 1000
    let s = kg == kg.rounded() ? String(Int(kg)) : String(format: "%g", kg).replacingOccurrences(of: ".", with: ",")
    return s + "kg"
}

// MARK: - Thanh Sẵn sàng xuất

struct ReadyExportBanner: View {
    let groups: [Vtp.Group]
    /// Đã kết nối Viettel Post: soát nháp rồi tạo vận đơn ("Soát & tạo") thay cho xuất Excel ("Xuất VTP").
    var connected = false
    let onExport: () -> Void

    private var subtitle: String {
        let start = Calendar.current.startOfDay(for: Clock.now)
        let merged = groups.filter { $0.orders.count > 1 }.count
        let older = groups.filter { g in g.orders.contains { $0.lastTs < start } }.count
        let cod = groups.reduce(0) { $0 + $1.summary.cod }
        let failed = connected ? groups.filter { g in g.orders.contains { VtpTrack.lastError($0) != nil } }.count : 0
        let noPhone = connected ? groups.filter { $0.summary.problems.contains("Thiếu số điện thoại") }.count : 0
        var parts: [String] = []
        if failed > 0 { parts.append("\(failed) khách tạo vận đơn lỗi") }
        if noPhone > 0 { parts.append("\(noPhone) khách thiếu SĐT") }
        if merged > 0 { parts.append("\(merged) khách gộp nhiều đơn") }
        if older > 0 { parts.append("\(older) khách có đơn duyệt từ ngày trước") }
        parts.append("Thu hộ \(money(cod))")
        return parts.joined(separator: " · ")
    }

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                // Đã kết nối Viettel Post: đơn ở Chờ gửi là nháp sẵn, bấm Soát & tạo mở bảng nháp.
                T(connected ? "\(groups.count) nháp chờ tạo vận đơn" : "\(groups.count) khách sẵn sàng xuất", 14, .bold)
                T(subtitle, 12, .medium, Theme.muted).lineLimit(2).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
            Button(action: onExport) {
                HStack(spacing: 6) {
                    Icon(name: connected ? .truck : .download, size: 15, weight: 2.4)
                    T(connected ? "Soát & tạo" : "Xuất VTP", 14, .bold).fixedSize()
                }
                .padding(.horizontal, 15)
                .frame(height: 40)
                .background(Capsule().fill(Theme.orange))
                .onAccent()
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .cardStyle(18, fill: Theme.peachSoft, border: Theme.peachLine)
    }
}

// MARK: - Bảng Duyệt đơn

struct ShipReviewSheet: View {
    let orderId: String
    /// Mở từ nút Sửa ở "Hàng & tiền" của một nháp vận đơn: chỉ tick sẵn đúng các đơn của nháp đó,
    /// giữ số COD đã sửa tay, và lưu xong thì quay lại nháp. nil là duyệt đơn bình thường.
    var draftIds: Set<String>? = nil
    @EnvironmentObject var store: Store
    @EnvironmentObject var ui: AppUI

    @State private var loaded = false
    @State private var checked: Set<String> = []
    @State private var pay = "cod"
    @State private var payer = "receiver"
    @State private var fee: Int?
    @State private var depositText = "0"
    @State private var weightText = "1"
    @State private var codText = ""
    @State private var lengthText = ""
    @State private var widthText = ""
    @State private var heightText = ""
    /// Đã sửa tay ô COD: số sửa tay thắng số tự cộng cho tới khi bấm "Tự tính" hoặc đổi lựa chọn khác.
    @State private var codEdited = false
    @FocusState private var codFocused: Bool

    private var all: [Order] { store.allOrders() }
    private var focus: Order? { store.order(id: orderId) }
    private var pending: [Order] { focus.map { Vtp.pendingOrders(of: $0.customer.id, in: all) } ?? [] }
    private var chosen: [Order] { pending.filter { checked.contains($0.id) } }
    private var isSent: Bool { focus.map { !Vtp.state($0).isPending } ?? false }

    private var deposit: Int { Int(depositText.filter(\.isNumber)) ?? 0 }
    private var weightG: Int {
        let kg = Double(weightText.replacingOccurrences(of: ",", with: ".").trimmingCharacters(in: .whitespaces)) ?? 0
        return kg > 0 ? Int((kg * 1000).rounded()) : Vtp.defaultWeightG
    }
    private var codValue: Int? { codEdited ? Int(codText.filter(\.isNumber)) : nil }
    private func cm(_ s: String) -> Int? { Int(s.filter(\.isNumber)).flatMap { $0 > 0 ? $0 : nil } }
    /// Từ 10kg Viettel Post cần kích thước kiện: hiện 3 ô Dài / Rộng / Cao và bắt buộc nhập.
    private var needsSize: Bool { weightG >= Vtp.sizeRequiredG }
    private var sizeMissing: Bool { needsSize && (cm(lengthText) == nil || cm(widthText) == nil || cm(heightText) == nil) }

    /// Cài đặt đang chọn trong bảng, ghi vào đơn khi bấm nút.
    private func patch(first: Bool, cod: Int?) -> ShipInfo {
        ShipInfo(pay: pay, payer: payer, deposit: first ? deposit : 0, shipFee: fee, codOverride: cod, weightG: weightG,
                 lengthCm: needsSize ? cm(lengthText) : nil, widthCm: needsSize ? cm(widthText) : nil,
                 heightCm: needsSize ? cm(heightText) : nil)
    }

    /// Tính thử đúng như lúc xuất: tiền cọc ở đơn đầu, các cài đặt khác ở mọi đơn.
    private var trial: Vtp.Summary? {
        guard let focus else { return nil }
        let list = chosen.isEmpty ? [focus] : chosen
        // Kèm cả số thu hộ nhập tay, để cảnh báo đơn dưới 17.000đ đúng với số sẽ gửi đi (autoCod không đổi theo số này).
        let lines = list.enumerated().map { i, o in Vtp.Line(total: o.total, qty: o.productCount, ship: patch(first: i == 0, cod: codValue)) }
        return Vtp.summarize(lines, address: focus.customer.address, nickname: focus.customer.nickname)
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                T(draftIds == nil ? "Duyệt đơn" : "Sửa hàng & tiền", 20, .heavy, Theme.ink, track: -0.3)
                Spacer()
                if draftIds == nil {
                    SheetClose()
                } else {
                    // Đóng khi đang sửa nháp: không lưu gì, quay lại đúng nháp đó.
                    Button { backToDraft(open: true) } label: {
                        Icon(name: .close, size: 17, weight: 2.4).frame(width: 36, height: 36).background(Circle().fill(Theme.field))
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, Metrics.gutter)
            .padding(.bottom, 12)

            if let focus {
                ScrollView(showsIndicators: false) {
                    VStack(alignment: .leading, spacing: 14) {
                        if isSent { sentBox(focus) } else { ordersBox(focus) }
                        if !isSent { form }
                    }
                    .padding(.horizontal, Metrics.gutter)
                    .padding(.bottom, 12)
                }
                .scrollDismissesKeyboard(.interactively)
                footer(focus)
            } else {
                Spacer()
                T("Đơn không còn tồn tại", 14, .medium, Theme.muted)
                Spacer()
            }
        }
        .frame(height: Metrics.sheetHeight(top: UIScreen.main.bounds.height * 0.14))
        .onAppear(perform: load)
    }

    private func load() {
        guard !loaded, let focus else { return }
        loaded = true
        // Sửa nháp: chỉ lấy các đơn của nháp, đơn khác của khách vẫn hiện nhưng không tick sẵn.
        let own = draftIds.map { ids in pending.filter { ids.contains($0.id) } } ?? []
        let list = own.isEmpty ? pending : own
        checked = Set(list.map(\.id))
        let pays = (list + [focus]).compactMap { $0.ship?.pay }
        pay = pays.contains("paid") || pays.contains("shipOnly") ? "paid" : "cod"
        let lastPayer = list.reversed().compactMap { $0.ship?.payer }.first { $0 == "sender" || $0 == "receiver" }
        payer = lastPayer ?? (pay == "cod" ? "receiver" : "sender")
        let dep = list.reduce(0) { $0 + ($1.ship?.deposit ?? 0) }
        depositText = String(dep)
        fee = list.reversed().compactMap { $0.ship?.shipFee }.first
        let w = list.compactMap { $0.ship?.weightG }.filter { $0 > 0 }.max() ?? Vtp.defaultWeightG
        if let s = list.reversed().compactMap({ $0.ship }).first(where: { $0.lengthCm != nil }) {
            lengthText = s.lengthCm.map { String($0) } ?? ""
            widthText = s.widthCm.map { String($0) } ?? ""
            heightText = s.heightCm.map { String($0) } ?? ""
        }
        weightText = Swift.String(format: "%g", Double(w) / 1000).replacingOccurrences(of: ".", with: ",")
        resetCod()
        // Sửa nháp: COD đã sửa tay lúc duyệt thì giữ nguyên, không lặng lẽ quay về số tự cộng.
        if draftIds != nil, let manual = list.reversed().compactMap({ $0.ship?.codOverride }).first {
            codEdited = true
            codText = moneyDigits(manual)
        }
    }

    /// Quay lại bảng Nháp vận đơn; `open` thì mở thẳng nháp của khách này.
    private func backToDraft(open: Bool) {
        let customerId = focus?.customer.id
        ui.present(dim: 0.42) { VtpExportSheet(openDetail: open ? customerId : nil) }
    }

    /// Mỗi lần mở bảng hay đổi lựa chọn, COD quay về số tự cộng.
    private func resetCod() {
        codEdited = false
        codText = moneyDigits(trial?.autoCod ?? 0)
    }

    // MARK: Danh sách đơn

    private func ordersBox(_ focus: Order) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            T(pending.count > 1 ? "GỘP \(pending.count) ĐƠN" : "ĐƠN DUYỆT", 12, .bold, Theme.muted, track: 0.4)
                .padding(.leading, 4)
            VStack(spacing: 0) {
                ForEach(Array(pending.enumerated()), id: \.element.id) { i, o in
                    if i > 0 { Rectangle().fill(Theme.line.opacity(0.7)).frame(height: 1).padding(.leading, 50) }
                    orderRow(o)
                }
            }
            .cardStyle(18)
            if let warn = trial?.problems.filter({ !$0.contains("kích thước") }), !warn.isEmpty {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    T(warn.joined(separator: " · "), 12.5, .medium, Theme.red).fixedSize(horizontal: false, vertical: true)
                    Button {
                        ui.dismissSheet()
                        ui.push(.addressEdit(focus.customer.id))
                    } label: { T("Sửa", 12.5, .bold, Theme.accent) }
                    .buttonStyle(.plain)
                }
                .padding(.horizontal, 4)
            }
        }
    }

    private func orderRow(_ o: Order) -> some View {
        let on = checked.contains(o.id)
        let st = Vtp.state(o)
        let title = st == .hold ? "Đơn gom \(dayMonth(o.lastTs))" : Clock.isToday(o.lastTs) ? "Đơn hôm nay" : "Đơn \(dayMonth(o.lastTs))"
        let sub = st == .hold ? "Khách hẹn gom · \(o.productCount) sản phẩm"
            : "\(timeText(o.lastTs)) · \(o.productCount) sản phẩm\(st == .ready ? " · đã duyệt" : "")"
        return Button {
            if on { checked.remove(o.id) } else { checked.insert(o.id) }
            resetCod()
        } label: {
            HStack(spacing: 12) {
                TickCircle(on: on)
                VStack(alignment: .leading, spacing: 2) {
                    T(title, 15, .bold).lineLimit(1)
                    T(sub, 12, .medium, st == .hold ? Theme.gomInk : Theme.muted).lineLimit(1)
                }
                Spacer(minLength: 6)
                T(money(o.total), 15, .heavy, on ? Theme.ink : Theme.muted).lineLimit(1).fixedSize()
            }
            .padding(.horizontal, 14)
            .frame(height: 60)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func sentBox(_ o: Order) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    T(o.code.map { "Đơn \($0)" } ?? "Đơn \(dayMonth(o.lastTs))", 15, .bold)
                    T("\(o.productCount) sản phẩm · \(timeText(o.lastTs)) · \(dayMonth(o.lastTs))", 12, .medium, Theme.muted)
                }
                Spacer()
                T(money(o.total), 15, .heavy).fixedSize()
            }
            .padding(.horizontal, 14)
            .frame(height: 60)
            .cardStyle(18)
            T(sentText(o), 13, .medium, Theme.muted)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 4)
        }
    }

    private func sentText(_ o: Order) -> String {
        let day: String = o.ship?.exportedAt.map { " ngày " + dayMonth(Date(timeIntervalSince1970: $0 / 1000)) } ?? ""
        if let code = VtpTrack.code(o) {
            return "Đã tạo vận đơn \(VtpTrack.pretty(code))\(day). In tem hoặc huỷ vận đơn ở chi tiết đơn."
        }
        if Vtp.state(o) == .exported { return "Đã xuất Viettel Post\(day)." }
        return "Đơn đã chuyển \(o.status == .delivered ? "Đã giao" : "Đang giao")."
    }

    // MARK: Ô nhập

    private var form: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 6) {
                fieldLabel("Tiền hàng")
                SegmentPicker(options: [("cod", "Thu tiền hàng"), ("paid", "Đã bank đủ")], selected: pay) { v in
                    pay = v
                    // Thu tiền hàng thì người nhận trả cước, đã bank đủ thì shop trả.
                    payer = v == "cod" ? "receiver" : "sender"
                    resetCod()
                }
            }
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 6) {
                    fieldLabel("Khách cọc")
                    input($depositText, keyboard: .numberPad)
                        .onChange(of: depositText) { _ in resetCod() }
                }
                VStack(alignment: .leading, spacing: 6) {
                    fieldLabel("Cân nặng (kg)")
                    input($weightText, keyboard: .decimalPad)
                }
            }
            if needsSize {
                VStack(alignment: .leading, spacing: 6) {
                    fieldLabel("Kích thước ") + T("*", 13, .bold, Theme.red)
                    HStack(spacing: 8) {
                        sizeInput($lengthText, "Dài (cm)")
                        sizeInput($widthText, "Rộng (cm)")
                        sizeInput($heightText, "Cao (cm)")
                    }
                    if sizeMissing {
                        T("Hàng từ 10kg phải nhập đủ dài, rộng, cao.", 12, .medium, Theme.red)
                    }
                }
            }
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    fieldLabel("Thu hộ COD")
                    Spacer()
                    if codEdited {
                        Button { resetCod() } label: { T("Tự tính", 12, .bold, Theme.accent) }.buttonStyle(.plain)
                    }
                }
                TextField("", text: $codText)
                    .font(.bv(20, .heavy))
                    .foregroundColor(Theme.ink)
                    .keyboardType(.numberPad)
                    .focused($codFocused)
                    .onChange(of: codText) { _ in if codFocused { codEdited = true } }
                    .padding(.horizontal, 14)
                    .frame(height: 50)
                    .cardStyle(12, fill: Theme.peachSoft, border: Theme.peachLine)
            }
            VStack(alignment: .leading, spacing: 6) {
                fieldLabel("Người trả cước")
                SegmentPicker(options: [("receiver", "Người nhận"), ("sender", "Người gửi")], selected: payer) { v in
                    payer = v
                    resetCod()
                }
                // Kể cả khi đã chọn người gửi trả hoặc tự nhập số thu hộ: báo rõ khách sẽ trả bao nhiêu.
                if let t = trial, !t.allPaid, t.shipFee > 0 || t.forcedSender {
                    forcedSenderWarning(t)
                }
            }
        }
    }

    /// Đơn dưới 17.000đ mà chọn người nhận trả: vẫn cho chọn, khi xuất tự đổi người gửi trả và cộng ship vào COD.
    private func forcedSenderWarning(_ t: Vtp.Summary) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "exclamationmark.circle")
                .font(.system(size: 15, weight: .semibold))
                .foregroundColor(Theme.red)
                .padding(.top, 1)
            T(t.shipFee > 0
              ? "Thu hộ thấp hơn tiền ship: người gửi trả ship và cộng tiền ship vào thu hộ. Tạm tính ship \(money(t.shipFee)), khách trả \(money(t.cod)). Bước nháp vận đơn sẽ tính lại theo cước thật Viettel Post báo."
              : "Tiền hàng thấp hơn tiền ship: người gửi trả ship. Thu hộ giữ đúng \(money(t.cod)) bạn đã nhập.",
              12.5, .medium, Theme.red)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 12).fill(Theme.red.opacity(0.08)))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.red.opacity(0.3), lineWidth: 1))
        .padding(.top, 2)
    }

    private func sizeInput(_ text: Binding<String>, _ placeholder: String) -> some View {
        ZStack(alignment: .leading) {
            if text.wrappedValue.isEmpty { T(placeholder, 14, .medium, Theme.placeholder).lineLimit(1).minimumScaleFactor(0.8) }
            TextField("", text: text)
                .font(.bv(16, .semibold))
                .foregroundColor(Theme.ink)
                .keyboardType(.numberPad)
        }
        .padding(.horizontal, 12)
        .frame(height: 44)
        .cardStyle(12)
    }

    private func input(_ text: Binding<String>, keyboard: UIKeyboardType) -> some View {
        TextField("", text: text)
            .font(.bv(16, .semibold))
            .foregroundColor(Theme.ink)
            .keyboardType(keyboard)
            .padding(.horizontal, 14)
            .frame(height: 44)
            .cardStyle(12)
    }

    // MARK: Nút cuối bảng

    @ViewBuilder private func footer(_ focus: Order) -> some View {
        HStack(spacing: 10) {
            if isSent {
                // Vận đơn tạo qua API thì huỷ ở phần ViettelPost của chi tiết đơn, không hoàn tác ở đây.
                if Vtp.state(focus) == .exported && focus.status == .shipping && VtpTrack.code(focus) == nil {
                    OutlineButton(title: "Hoàn tác xuất", height: 52) {
                        store.undoExport(focus)
                        ui.dismissSheet()
                    }
                }
                if focus.status == .delivered {
                    OutlineButton(title: "Chưa giao", height: 52) { store.setDelivered(focus, false); ui.dismissSheet() }
                } else {
                    PrimaryButton(title: "Đã giao", fontSize: 15) { store.setDelivered(focus, true); ui.dismissSheet() }
                }
            } else {
                OutlineButton(title: "Gom sau", height: 52) { apply(.hold) }
                    .frame(maxWidth: .infinity)
                PrimaryButton(title: draftIds == nil ? "Xác nhận gửi" : "Lưu thay đổi", fontSize: 15) { apply(.ready) }
                    .frame(maxWidth: .infinity)
                    .layoutPriority(1)
                    .frame(minWidth: (Metrics.screenWidth - 50) * 0.6)
            }
        }
        .padding(.horizontal, Metrics.gutter)
        .padding(.top, 10)
    }

    private func apply(_ state: ShipState) {
        let ids = chosen.map(\.id)
        guard !ids.isEmpty else {
            ui.notify("Tick ít nhất một đơn.")
            return
        }
        if state == .ready && sizeMissing {
            ui.notify("Hàng từ 10kg phải nhập đủ kích thước dài, rộng, cao (cm).")
            return
        }
        // Đơn đang Chờ gửi mà bị bỏ tick: đưa về chưa duyệt, không thì lúc tạo vận đơn vẫn bị gộp chung và cộng tiền.
        let dropped = state == .ready ? pending.filter { !checked.contains($0.id) && Vtp.state($0) == .ready }.map(\.id) : []
        store.approve(ids, state: state, base: patch(first: true, cod: codValue), dropped: dropped)
        if draftIds != nil {
            // Gom sau thì nháp không còn: về danh sách nháp. Lưu thì mở lại nháp để soát tiếp.
            backToDraft(open: state == .ready)
        } else {
            ui.dismissSheet()
        }
    }
}

// MARK: - Bảng Xuất Viettel Post

struct VtpExportSheet: View {
    @EnvironmentObject var store: Store
    @EnvironmentObject var client: LiveClient
    @EnvironmentObject var ui: AppUI
    @State private var sending = false
    /// Kết quả lần tạo vận đơn vừa xong (cùng các khách đã gửi), hiện thay cho danh sách.
    @State private var result: (groups: [Vtp.Group], results: [VtpCreateResult])?
    @State private var selected: Set<String> = []
    @State private var touched = false
    @State private var service = UserDefaults.standard.string(forKey: Vtp.serviceKey) ?? Vtp.defaultService
    @State private var picking = false
    /// Nháp đã hỏi cước, theo chữ ký nháp (VtpQuote.signature). Đang hỏi thì nằm trong `quoting`.
    @State private var quotes: [String: VtpQuote] = [:]
    @State private var quoting: Set<String> = []
    /// Nháp đang mở để soát chi tiết (mã khách); nil là đang ở danh sách nháp.
    @State private var detailId: String?

    /// `openDetail`: mở thẳng nháp của khách này (dùng khi vừa sửa Hàng & tiền xong).
    init(openDetail: String? = nil) {
        _detailId = State(initialValue: openDetail)
    }

    /// Đơn ở Chờ gửi là nháp sẵn. Viettel Post hiểu địa chỉ sang phường/tỉnh khác thì nháp đó chưa cho tạo.
    private var groups: [Vtp.Group] {
        Vtp.readyGroups(store.allOrders()).map { g in
            guard api, let q = quotes[VtpQuote.signature(g, service: service)] else { return g }
            var out = g
            // Đã có cước thật: đơn thu hộ thấp hơn cước đó chuyển người gửi trả và cộng đúng cước đó vào thu hộ.
            if q.ok, q.fee > 0 {
                out.baseSummary = g.summary
                out.summary = Vtp.summarize(Vtp.lines(g.orders), address: g.customer.address,
                                            nickname: g.customer.nickname, realFee: q.fee)
            }
            if q.addrOk == false {
                out.summary.problems.append("Viettel Post hiểu \"\(q.parsed)\", khác địa chỉ trong app")
            }
            return out
        }
        // Đơn sẵn sàng lên đầu, đơn cần sửa xuống cuối; giữ nguyên thứ tự trong từng nhóm.
        .enumerated()
        .sorted { a, b in a.element.isBad != b.element.isBad ? !a.element.isBad : a.offset < b.offset }
        .map(\.element)
    }
    private var okIds: Set<String> { Set(groups.filter { !$0.isBad }.map(\.id)) }
    private var chosen: Set<String> { touched ? selected.intersection(okIds) : okIds }
    private var serviceName: String {
        let s = Vtp.services.first { $0.code == service } ?? Vtp.services[0]
        return "\(s.code) · \(s.name)"
    }

    private var api: Bool { client.vtpConnected }

    var body: some View {
        Group {
            if let result {
                VtpResultView(groups: result.groups, results: result.results)
            } else if let id = detailId, let g = groups.first(where: { $0.id == id }) {
                detailView(g)
            } else {
                picker
            }
        }
        .frame(height: Metrics.sheetHeight(top: UIScreen.main.bounds.height * 0.12))
        // Khoá theo mọi nháp đủ địa chỉ (không theo cái đang hỏi), để lượt hỏi đang chạy không bị huỷ giữa chừng.
        .task(id: quoteKey) { await loadQuotes() }
    }

    private var quoteKey: String {
        guard api, client.vtp?.sender != nil else { return "" }
        return Vtp.readyGroups(store.allOrders()).filter { !$0.isBad }
            .map { VtpQuote.signature($0, service: service) }.sorted().joined(separator: ",")
    }

    /// Nháp đủ địa chỉ chưa có cước cho gói đang chọn.
    private var quoteNeeds: [(String, Vtp.Group)] {
        guard api, client.vtp?.sender != nil else { return [] }
        return Vtp.readyGroups(store.allOrders())
            .filter { !$0.isBad }
            .map { (VtpQuote.signature($0, service: service), $0) }
            .filter { quotes[$0.0] == nil && !quoting.contains($0.0) }
    }

    private func loadQuotes() async {
        let need = quoteNeeds
        guard !need.isEmpty else { return }
        let sigs = Dictionary(need.map { ($0.1.id, $0.0) }, uniquingKeysWith: { a, _ in a })
        quoting.formUnion(sigs.values)
        let r = await client.vtpQuote(service: service, groups: need.map { VtpTrack.payload($0.1) })
        for (key, sig) in sigs {
            quotes[sig] = r.quotes[key] ?? VtpQuote(error: r.error ?? "Không tính được cước")
        }
        quoting.subtract(sigs.values)
    }

    private func quote(_ g: Vtp.Group) -> VtpQuote? { quotes[VtpQuote.signature(g, service: service)] }
    private func isQuoting(_ g: Vtp.Group) -> Bool { quoting.contains(VtpQuote.signature(g, service: service)) }

    /// Ô "Viettel Post hiểu": phường/tỉnh họ đọc ra từ dòng địa chỉ, hỏi trước khi tạo đơn.
    @ViewBuilder private func quoteLine(_ g: Vtp.Group) -> some View {
        if isQuoting(g) {
            T("Đang tính cước và kiểm địa chỉ với Viettel Post…", 12, .medium, Theme.muted)
        } else if let q = quote(g) {
            if !q.parsed.isEmpty && q.addrOk != false {
                T("✓ Viettel Post hiểu: \(q.parsed) · đúng", 12, .semibold, Theme.green)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 7)
                    .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Theme.greenSoft))
            }
            if !q.ok {
                T(q.error, 12, .semibold, Theme.red).fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func feeText(_ g: Vtp.Group) -> String {
        if isQuoting(g) { return "Đang tính cước…" }
        guard let q = quote(g), q.ok else { return "Cước chưa tính" }
        return "Cước dự tính \(money(q.fee))"
    }

    // MARK: Soát một nháp

    private func detailBox<V: View>(_ title: String, @ViewBuilder _ content: () -> V) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            T(title, 11.5, .bold, Theme.muted, track: 0.4)
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .cardStyle(16)
    }

    private func kv(_ k: String, _ v: String, strong: Bool = false) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            T(k, 13, .medium, Theme.muted).fixedSize()
            Spacer(minLength: 8)
            T(v, strong ? 15 : 13, strong ? .heavy : .semibold, Theme.ink)
                .multilineTextAlignment(.trailing)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func detailView(_ g: Vtp.Group) -> some View {
        let s = g.summary
        let q = quote(g)
        let name = s.receiver.isEmpty ? g.customer.nickname : s.receiver
        let codes = g.orders.compactMap(\.code).filter { !$0.isEmpty }.joined(separator: " + ")
        let busy = isQuoting(g)
        let parsed = q?.parsed ?? ""
        let mismatch = q?.addrOk == false
        let feeOk = q?.ok == true
        return VStack(spacing: 0) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    T("Nháp · \(name)", 20, .heavy, Theme.ink, track: -0.3).lineLimit(1).minimumScaleFactor(0.8)
                    if !codes.isEmpty { T(codes, 12.5, .medium, Theme.muted).lineLimit(2) }
                }
                Spacer()
                SheetClose()
            }
            .padding(.horizontal, Metrics.gutter)
            .padding(.bottom, 12)

            ScrollView(showsIndicators: false) {
                VStack(spacing: 10) {
                    detailBox("NGƯỜI NHẬN") {
                        HStack(alignment: .firstTextBaseline) {
                            T(name, 16, .bold).lineLimit(1)
                            Spacer(minLength: 8)
                            Button {
                                ui.dismissSheet()
                                ui.push(.addressEdit(g.customer.id))
                            } label: { T("Sửa", 13, .bold, Theme.accent) }
                            .buttonStyle(.plain)
                        }
                        T(s.phone.isEmpty ? "Chưa có số điện thoại" : s.phone, 13.5, .semibold, s.phone.isEmpty ? Theme.red : Theme.ink)
                        kv("App ghi", s.address.line.isEmpty ? "Chưa có địa chỉ" : s.address.line)
                        if busy {
                            kv("VTP hiểu", "Đang kiểm…")
                        } else if !parsed.isEmpty {
                            kv("VTP hiểu", parsed)
                            T(mismatch ? "Khác phường hoặc tỉnh. Sửa địa chỉ trước khi tạo." : "✓ Khớp phường và tỉnh",
                              12.5, .bold, mismatch ? Theme.red : Theme.green)
                                .fixedSize(horizontal: false, vertical: true)
                        } else if !g.isBad {
                            T("Chưa đối chiếu được địa chỉ với Viettel Post.", 12.5, .semibold, Theme.muted)
                        }
                        if g.isBad {
                            T(s.problems.joined(separator: " · "), 12.5, .semibold, Theme.red).fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    detailBox("HÀNG & TIỀN") {
                        HStack(alignment: .firstTextBaseline, spacing: 10) {
                            T("Tên hàng", 13, .medium, Theme.muted).fixedSize()
                            Spacer(minLength: 8)
                            T("\(Vtp.goodsName) · \(max(s.qty, 1)) món", 13, .semibold, Theme.ink).lineLimit(1)
                            // Sửa cân nặng, kích thước, COD, tiền cọc, người trả cước của đúng các đơn trong nháp này.
                            if let last = g.orders.last, !sending {
                                Button {
                                    ui.present(dim: 0.42) {
                                        ShipReviewSheet(orderId: last.id, draftIds: Set(g.orders.map(\.id)))
                                    }
                                } label: { T("Sửa", 13, .bold, Theme.accent) }
                                .buttonStyle(.plain)
                            }
                        }
                        kv("Giá trị hàng", money(s.goods))
                        kv("Người trả cước", s.senderPays ? "Shop (người gửi)" : "Người nhận")
                        kv("Trọng lượng", weightText(s.weightG))
                        if let z = s.size { kv("Kích thước", "\(z.0) × \(z.1) × \(z.2) cm") }
                        HairLine()
                        if s.shipFee > 0 {
                            kv(s.feeIsReal ? "Tiền ship cộng vào thu hộ" : "Tiền ship cộng vào thu hộ (tạm tính)", money(s.shipFee))
                        }
                        kv("Thu hộ (COD)", money(s.cod), strong: true)
                    }
                    detailBox("CƯỚC DỰ TÍNH · \(service)") {
                        if busy {
                            T("Đang tính cước…", 13, .medium, Theme.muted)
                        } else if feeOk {
                            kv("Tổng cước", money(q?.fee ?? 0), strong: true)
                            T("Chưa tạo đơn. Cước thật do Viettel Post chốt khi nhận hàng.", 12, .medium, Theme.muted)
                                .fixedSize(horizontal: false, vertical: true)
                        } else {
                            T(q?.error ?? "Cước chưa tính", 13, .semibold, q == nil ? Theme.muted : Theme.red)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    detailBox("GHI CHÚ CHO BƯU TÁ") {
                        T(s.note.isEmpty ? "Trống" : s.note, 13.5, .medium, s.note.isEmpty ? Theme.muted : Theme.ink)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(.horizontal, Metrics.gutter)
                .padding(.bottom, 12)
            }
            .frame(maxHeight: .infinity)

            HStack(spacing: 10) {
                OutlineButton(title: "Để nháp", height: 52) { detailId = nil }
                    .frame(width: (Metrics.screenWidth - 50) / 3)
                PrimaryButton(title: sending ? "Đang tạo vận đơn…" : busy ? "Đang tính cước…" : "Tạo vận đơn này",
                              icon: .truck, fontSize: 15, enabled: !g.isBad && !sending && !busy) {
                    create([g])
                }
            }
            .padding(.horizontal, Metrics.gutter)
            .padding(.top, 14)
            .background(Theme.card.overlay(alignment: .top) { HairLine() })
        }
    }

    private var picker: some View {
        let list = groups
        let pick = chosen
        let bad = list.filter(\.isBad).count
        return VStack(spacing: 0) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    T(api ? "Nháp vận đơn" : "Xuất Viettel Post", 20, .heavy, Theme.ink, track: -0.3)
                    T(api ? "\(list.count) nháp · \(list.count - bad) sẵn sàng\(bad > 0 ? " · \(bad) cần sửa" : "")"
                          : "\(list.count - bad) khách sẵn sàng gửi\(bad > 0 ? " · \(bad) khách cần sửa" : "")", 13, .medium, Theme.muted)
                        .lineLimit(1).minimumScaleFactor(0.85)
                }
                Spacer()
                SheetClose()
            }
            .padding(.horizontal, Metrics.gutter)

            HStack {
                T("ĐÃ CHỌN \(pick.count)", 12, .bold, Theme.muted, track: 0.4)
                Spacer()
                Button {
                    let ok = okIds
                    selected = pick.count == ok.count ? [] : ok
                    touched = true
                } label: {
                    T(pick.count == okIds.count && !pick.isEmpty ? "Bỏ chọn tất cả" : "Chọn tất cả", 13, .bold, Theme.accent)
                }
                .buttonStyle(.plain)
                .disabled(okIds.isEmpty)
            }
            .padding(.horizontal, Metrics.gutter + 4)
            .padding(.top, 12)
            .padding(.bottom, 8)

            ScrollView(showsIndicators: false) {
                VStack(spacing: 10) {
                    if list.isEmpty {
                        T("Chưa có đơn nào đã duyệt.", 14, .medium, Theme.muted).padding(.vertical, 30)
                    }
                    if api && !list.isEmpty {
                        T("Viettel Post chưa nhận đơn nào. Soát xong rồi mới bấm Tạo.", 12.5, .medium, Theme.muted)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 4)
                    }
                    ForEach(list) { g in
                        row(g, on: pick.contains(g.id))
                            .cardStyle(16, fill: g.isBad ? Theme.badRow : Theme.card)
                            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                    }
                }
                .padding(.horizontal, Metrics.gutter)
                .padding(.bottom, 12)
            }
            .frame(maxHeight: .infinity)

            footer(list, pick)
        }
    }

    private func row(_ g: Vtp.Group, on: Bool) -> some View {
        let s = g.summary
        let start = Calendar.current.startOfDay(for: Clock.now)
        let olderDay = g.orders.first { $0.lastTs < start }.map { dayMonth($0.lastTs) }
        return Button {
            guard !g.isBad else { return }
            var next = chosen
            if on { next.remove(g.id) } else { next.insert(g.id) }
            selected = next
            touched = true
        } label: {
            HStack(alignment: .top, spacing: 12) {
                TickCircle(on: on && !g.isBad, enabled: !g.isBad).padding(.top, 1)
                VStack(alignment: .leading, spacing: 5) {
                    HStack(alignment: .firstTextBaseline) {
                        T(s.receiver.isEmpty ? g.customer.nickname : s.receiver, 15, .bold).lineLimit(1)
                        Spacer(minLength: 6)
                        T(money(s.cod), 15, .heavy, g.isBad ? Theme.muted : Theme.ink).lineLimit(1).fixedSize()
                    }
                    let tags = tagList(g, olderDay: olderDay)
                    if !tags.isEmpty {
                        HStack(spacing: 6) { ForEach(tags.indices, id: \.self) { i in tag(tags[i].0, tags[i].1, tags[i].2) } }
                    }
                    let contact = [s.phone, s.address.line].filter { !$0.isEmpty }.joined(separator: " · ")
                    if !contact.isEmpty {
                        T(contact, 12.5, .medium, Theme.muted).fixedSize(horizontal: false, vertical: true)
                    }
                    if g.isBad {
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            T(s.problems.joined(separator: " · "), 12.5, .semibold, Theme.red).fixedSize(horizontal: false, vertical: true)
                            Button {
                                ui.dismissSheet()
                                ui.push(.addressEdit(g.customer.id))
                            } label: { T("Sửa", 12.5, .bold, Theme.accent) }
                            .buttonStyle(.plain)
                        }
                    } else {
                        if api { quoteLine(g) }
                        T(detail(s), 12, .medium, Theme.muted).fixedSize(horizontal: false, vertical: true)
                        if api {
                            HStack(alignment: .firstTextBaseline) {
                                T(feeText(g), 12.5, .bold, Theme.ink).lineLimit(1).minimumScaleFactor(0.8)
                                Spacer(minLength: 8)
                                Button { detailId = g.id } label: {
                                    T("Soát chi tiết ›", 12.5, .bold, Theme.accent).fixedSize()
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                    if !g.isBad, let e = g.orders.compactMap(VtpTrack.lastError).first {
                        T("Lần trước ViettelPost báo: \(e)", 12, .semibold, Theme.red).fixedSize(horizontal: false, vertical: true)
                    }
                    if let r = g.recentExported.first, let at = r.ship?.exportedAt {
                        T("Khách đã có vận đơn xuất \(dayMonth(Date(timeIntervalSince1970: at / 1000)))", 12, .semibold, Theme.gomInk)
                    }
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func tagList(_ g: Vtp.Group, olderDay: String?) -> [(String, Color, Color)] {
        var tags: [(String, Color, Color)] = []
        if g.isBad { tags.append(("cần sửa", Theme.red, Theme.redSoft)) }
        if g.orders.count > 1 { tags.append(("gộp \(g.orders.count) đơn", Theme.gomInk, Theme.gomTag)) }
        if let olderDay { tags.append(("duyệt \(olderDay)", Theme.muted, Theme.grayBadge)) }
        if g.summary.allPaid { tags.append(("bank đủ", Theme.green, Theme.greenSoft)) }
        if g.summary.address.ok && g.summary.address.isOld { tags.append(("địa chỉ cũ", Theme.muted, Theme.grayBadge)) }
        return tags
    }

    private func tag(_ text: String, _ color: Color, _ fill: Color) -> some View {
        T(text, 11, .bold, color).lineLimit(1).fixedSize()
            .padding(.horizontal, 8)
            .frame(height: 20)
            .background(Capsule().fill(fill))
    }

    private func detail(_ s: Vtp.Summary) -> String {
        let who = s.senderPays ? "Shop trả ship" : "Khách trả ship"
        let small = s.shipFee > 0 ? " (\(s.allPaid ? "thu tiền ship" : "thu hộ thấp hơn ship"), COD +\(money(s.shipFee))\(s.feeIsReal ? "" : " tạm tính"))" : ""
        return [who + small, weightText(s.weightG), s.address.shortArea].filter { !$0.isEmpty }.joined(separator: " · ")
    }

    // MARK: Chân bảng

    private func footer(_ list: [Vtp.Group], _ pick: Set<String>) -> some View {
        let picked = list.filter { pick.contains($0.id) }
        let total = picked.reduce(0) { $0 + $1.summary.cod }
        let busy = api && picked.contains { isQuoting($0) }
        let feeTotal = picked.reduce(0) { $0 + (quote($1).flatMap { $0.ok ? $0.fee : nil } ?? 0) }
        return VStack(spacing: 14) {
            HStack(alignment: .bottom) {
                VStack(alignment: .leading, spacing: 5) {
                    fieldLabel("Dịch vụ")
                    Button { picking.toggle() } label: {
                        HStack(spacing: 4) {
                            T(serviceName, 14, .bold).lineLimit(1).fixedSize()
                            Icon(name: picking ? .chevronUp : .chevronDown, size: 14, color: Theme.muted)
                        }
                        .padding(.horizontal, 12)
                        .frame(height: 38)
                        .cardStyle(12, fill: Theme.field)
                    }
                    .buttonStyle(.plain)
                    .overlay(alignment: .bottomLeading) {
                        if picking { servicePicker.offset(y: -46).fixedSize() }
                    }
                }
                .zIndex(1)
                Spacer(minLength: 8)
                VStack(alignment: .trailing, spacing: 2) {
                    T(api ? "Tổng thu hộ · \(pick.count) khách" : "Tổng thu hộ", 12, .semibold, Theme.muted)
                    T(money(total), 22, .heavy, Theme.ink, track: -0.4).lineLimit(1).minimumScaleFactor(0.7)
                    if api && feeTotal > 0 {
                        T("Cước dự tính \(money(feeTotal))", 12, .semibold, Theme.muted).lineLimit(1)
                    }
                }
            }
            .zIndex(1)
            HStack(spacing: 10) {
                OutlineButton(title: "Huỷ", height: 52) { ui.dismissSheet() }
                    .frame(width: (Metrics.screenWidth - 50) / 3)
                if api {
                    PrimaryButton(title: sending ? "Đang tạo \(pick.count) vận đơn…" : busy ? "Đang tính cước…" : "Tạo \(pick.count) vận đơn",
                                  icon: .truck, fontSize: 15, enabled: !pick.isEmpty && !sending && !busy) {
                        create(list.filter { pick.contains($0.id) })
                    }
                } else {
                    PrimaryButton(title: "Xuất Excel · \(pick.count) vận đơn", icon: .download, fontSize: 15, enabled: !pick.isEmpty) {
                        export(list.filter { pick.contains($0.id) })
                    }
                }
            }
            if api {
                Button { export(list.filter { pick.contains($0.id) }) } label: {
                    T("Hoặc xuất file Excel như cũ", 13, .bold, Theme.accent)
                }
                .buttonStyle(.plain)
                .disabled(pick.isEmpty || sending)
                .padding(.top, -4)
            }
        }
        .padding(.horizontal, Metrics.gutter)
        .padding(.top, 14)
        .background(Theme.card.overlay(alignment: .top) { HairLine() })
    }

    private var servicePicker: some View {
        VStack(spacing: 0) {
            ForEach(Vtp.services.indices, id: \.self) { i in
                let s = Vtp.services[i]
                let on = s.code == service
                Button {
                    service = s.code
                    UserDefaults.standard.set(s.code, forKey: Vtp.serviceKey)
                    picking = false
                } label: {
                    HStack(spacing: 10) {
                        T("\(s.code) · \(s.name)", 14, on ? .bold : .semibold).lineLimit(1)
                        Spacer(minLength: 12)
                        if on { Icon(name: .check, size: 14, weight: 2.8, color: Theme.accent) }
                    }
                    .padding(.horizontal, 14)
                    .frame(width: 280, height: 46)
                    .background(on ? Theme.peachSoft : Color.clear)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Theme.card))
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Theme.line, lineWidth: 1))
        .shadow(color: .black.opacity(0.12), radius: 12, y: 4)
    }

    /// Tạo vận đơn thẳng trên Viettel Post (qua máy chủ ChốtLive), mỗi khách một vận đơn.
    private func create(_ chosen: [Vtp.Group]) {
        guard !chosen.isEmpty, !sending else { return }
        guard client.vtp?.sender != nil else {
            ui.dismissSheet()
            ui.push(.vtp)
            ui.notify("Chọn điểm lấy hàng trước khi gửi.")
            return
        }
        sending = true
        let svc = service
        Task { @MainActor in
            await client.vtpFlush(store)
            let r = await client.vtpCreate(service: svc, groups: chosen.map { VtpTrack.payload($0) })
            sending = false
            if let e = r.error { return ui.notify(e) }
            // Máy chủ đã ghi mã vận đơn vào đơn; ghi luôn trên máy để không phải chờ đồng bộ.
            for res in r.results {
                guard let g = chosen.first(where: { $0.id == res.key }) else { continue }
                if res.ok && !res.code.isEmpty {
                    store.applyVtpCreated(g.orders, code: res.code, fee: res.fee, service: svc)
                } else if !res.ok {
                    store.applyVtpError(g.orders, error: res.error)
                }
            }
            result = (chosen, r.results)
        }
    }

    private func export(_ chosen: [Vtp.Group]) {
        guard !chosen.isEmpty else { return }
        let now = Clock.now
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(Vtp.fileName(now))
        do {
            try Vtp.xlsx(chosen, service: service).write(to: url, options: .atomic)
        } catch {
            ui.notify("Không tạo được file Excel: \(error.localizedDescription)")
            return
        }
        store.markExported(chosen.flatMap(\.orders), at: now)
        ui.dismissSheet()
        // Đợi bảng dưới trượt xuống rồi mới mở bảng chia sẻ của iOS.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) { ShareFile.present(url) }
    }
}

/// Bảng chia sẻ của iOS để lưu file vào Tệp hoặc gửi đi.
enum ShareFile {
    static func present(_ url: URL) {
        guard let root = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene })
            .flatMap(\.windows).first(where: \.isKeyWindow)?.rootViewController else { return }
        var top = root
        while let next = top.presentedViewController { top = next }
        let vc = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        vc.popoverPresentationController?.sourceView = top.view
        top.present(vc, animated: true)
    }
}
