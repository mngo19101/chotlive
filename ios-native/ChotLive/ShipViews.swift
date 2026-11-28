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

// MARK: - Bảng Duyệt đơn

/// Bảng Duyệt đơn đang dở khi bấm Sửa địa chỉ / số điện thoại. Bảng bị đóng để mở trang sửa, nên lưu các ô
/// đã nhập ở đây theo mã đơn; mở lại bảng thì điền lại rồi xoá.
enum ReviewResume {
    struct Form {
        var checked: Set<String>
        var pay: String
        var payer: String
        var fee: Int?
        var depositText: String
        var weightText: String
        var codText: String
        var lengthText: String
        var widthText: String
        var heightText: String
        var codEdited: Bool
        var valueText: String
        var valueEdited: Bool
        var goodsText: String
        var extras: [String]
        var notePicks: [String]
        var noteOther: String
        var noteSaved: Bool
    }

    static var forms: [String: Form] = [:]
}

struct ShipReviewSheet: View {
    let orderId: String
    /// Mở từ nút Sửa ở "Hàng & tiền" của một nháp vận đơn: chỉ tick sẵn đúng các đơn của nháp đó,
    /// giữ số COD đã sửa tay, và lưu xong thì quay lại nháp. nil là duyệt đơn bình thường.
    var draftIds: Set<String>? = nil
    @EnvironmentObject var store: Store
    @EnvironmentObject var ui: AppUI
    @EnvironmentObject var client: LiveClient

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
    /// Giá trị đơn hàng: ô "Giá trị hàng" khai với Viettel Post. Mặc định là tổng tiền các đơn đang tick,
    /// sửa tay được (khách cọc, giảm giá...). Không đổi tiền thu hộ.
    @State private var valueText = ""
    @State private var valueEdited = false
    @FocusState private var valueFocused: Bool
    /// Tên hàng trong cài đặt Máy in; để trống thì bảng có ô nhập tên hàng cho từng lần duyệt.
    @AppStorage(Vtp.goodsNameKey) private var goodsSetting = Vtp.defaultGoodsName
    @State private var goodsText = ""
    @EnvironmentObject var vtpDrafts: VtpDraftHub
    /// Dịch vụ cộng thêm và ghi chú vận đơn, chọn trong bảng con giống trang tạo đơn viettelpost.vn.
    private enum Picker { case extras, notes }
    @State private var picker: Picker?
    @State private var extras: [String] = []
    @State private var notePicks: [String] = []
    @State private var noteOther = ""
    @State private var templates: [String] = UserDefaults.standard.stringArray(forKey: VtpExtras.templatesKey) ?? VtpExtras.defaultTemplates
    /// Mẫu đang hiện là của tài khoản Viettel Post (phần 2) hay 5 mẫu chung.
    @State private var templatesFromAccount = false
    @State private var templatesLoading = false
    @State private var templatesError: String?
    /// Đơn đã có ghi chú lưu từ lần duyệt trước: không tự tick mẫu "Mặc định chọn" của Viettel Post đè lên.
    @State private var noteSaved = false
    /// Giá từng dịch vụ cho đơn đang duyệt; nil trong từ điển là gói đang chọn không nhận dịch vụ đó.
    @State private var prices: [String: Int?] = [:]
    @State private var pricesKey = ""
    @State private var pricesLoading = false
    @State private var pricesError: String?
    @AppStorage(VtpExtras.rememberKey) private var extrasRemember = false
    @AppStorage(VtpExtras.defaultKey) private var extrasDefault = ""
    @AppStorage(VtpExtras.noteRememberKey) private var noteRemember = false
    @AppStorage(VtpExtras.noteDefaultKey) private var noteDefault = ""

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
    private var goodsValue: Int? { valueEdited ? Int(valueText.filter(\.isNumber)) ?? 0 : nil }
    /// Tổng tiền các đơn đang tick (chưa tick đơn nào thì đơn đang mở).
    private var autoGoods: Int { (chosen.isEmpty ? focus.map { [$0] } ?? [] : chosen).reduce(0) { $0 + max(0, $1.total) } }
    private func cm(_ s: String) -> Int? { Int(s.filter(\.isNumber)).flatMap { $0 > 0 ? $0 : nil } }
    /// Từ 10kg Viettel Post cần kích thước kiện: hiện 3 ô Dài / Rộng / Cao và bắt buộc nhập.
    private var needsSize: Bool { weightG >= Vtp.sizeRequiredG }
    private var sizeMissing: Bool { needsSize && (cm(lengthText) == nil || cm(widthText) == nil || cm(heightText) == nil) }
    private var asksGoods: Bool { Vtp.cleanGoods(goodsSetting).isEmpty }
    private var goodsMissing: Bool { asksGoods && Vtp.cleanGoods(goodsText).isEmpty }
    /// Máy chủ đã trả lời là chưa kết nối Viettel Post phần 1 (phần 2 cũng khoá theo): duyệt xong chuyển thẳng
    /// Đang giao, không qua Chờ gửi. `vtp` nil là chưa hỏi xong thì vẫn vào Chờ gửi như cũ, không chuyển nhầm.
    /// Sửa Hàng & tiền của nháp (`draftIds`) thì luôn ở Chờ gửi.
    private var shipsDirect: Bool { draftIds == nil && client.vtp != nil && !client.vtpConnected }

    /// Cài đặt đang chọn trong bảng, ghi vào đơn khi bấm nút.
    private func patch(first: Bool, cod: Int?) -> ShipInfo {
        ShipInfo(pay: pay, payer: payer, deposit: first ? deposit : 0, shipFee: fee, codOverride: cod,
                 goodsOverride: goodsValue, weightG: weightG,
                 lengthCm: needsSize ? cm(lengthText) : nil, widthCm: needsSize ? cm(widthText) : nil,
                 heightCm: needsSize ? cm(heightText) : nil,
                 // Giữ cả khi cài đặt đang có tên hàng, để lỡ xoá trống cài đặt thì tên đã nhập vẫn còn.
                 goodsName: Vtp.cleanGoods(goodsText).isEmpty ? nil : Vtp.cleanGoods(goodsText),
                 extras: VtpExtras.joined(extras),
                 orderNote: noteValue.isEmpty ? nil : noteValue)
    }

    /// Ghi chú sẽ gửi Viettel Post: mẫu đã tick + nội dung khác, cắt theo giới hạn 150 byte của Viettel Post.
    private var noteText: String { VtpExtras.compose(picks: notePicks, templates: templates, other: noteOther) }
    private var noteValue: String { VtpDraftBody.clip(noteText, VtpExtras.maxNoteBytes) }
    private var noteTooLong: Bool { VtpExtras.bytes(noteText) > VtpExtras.maxNoteBytes }
    /// Tổng tiền các dịch vụ đã chọn; nil khi chưa biết giá (chưa kết nối phần 1 hoặc chưa hỏi xong).
    private var extrasTotal: Int? {
        guard !extras.isEmpty else { return 0 }
        var sum = 0
        for c in extras {
            guard let p = prices[c], let v = p else { return nil }
            sum += v
        }
        return sum
    }

    /// Tính thử đúng như lúc xuất: tiền cọc ở đơn đầu, các cài đặt khác ở mọi đơn.
    private var trial: Vtp.Summary? {
        guard let focus else { return nil }
        let list = chosen.isEmpty ? [focus] : chosen
        // Kèm cả số thu hộ nhập tay, để cảnh báo đơn dưới 17.000đ đúng với số sẽ gửi đi (autoCod không đổi theo số này).
        let lines = list.enumerated().map { i, o in Vtp.Line(total: o.total, qty: o.productCount, ship: patch(first: i == 0, cod: codValue)) }
        return Vtp.summarize(lines, address: focus.customer.address, nickname: focus.customer.nickname,
                             goodsSetting: Vtp.cleanGoods(goodsSetting))
    }

    /// Mở / đóng bảng con (dịch vụ cộng thêm, ghi chú): trượt ngang như chuyển trang.
    static let pickerMotion = Animation.spring(response: 0.36, dampingFraction: 0.9)

    var body: some View {
        ZStack {
            // Bảng Duyệt đơn luôn nằm dưới, chỉ lùi sang trái và mờ đi khi mở bảng con: bấm Xong là về đúng chỗ đang xem.
            reviewBody
                .offset(x: picker == nil ? 0 : -Metrics.screenWidth * 0.28)
                .opacity(picker == nil ? 1 : 0)
                .allowsHitTesting(picker == nil)
                .accessibilityHidden(picker != nil)
            if let p = picker {
                Group {
                    switch p {
                    case .extras: extrasPicker
                    case .notes: notesPicker
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                .background(Theme.card)
                .transition(.move(edge: .trailing))
                .zIndex(1)
            }
        }
        .clipped()
        .frame(height: Metrics.sheetHeight(top: UIScreen.main.bounds.height * 0.14))
        .onAppear(perform: load)
    }

    private var reviewBody: some View {
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
                        if !isSent && draftIds == nil { nextStepNote }
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
        goodsText = list.reversed().compactMap { $0.ship?.goodsName }.first { !$0.isEmpty } ?? ""
        // Giá trị đơn đã sửa tay lúc duyệt trước thì giữ nguyên.
        if let manual = list.reversed().compactMap({ $0.ship?.goodsOverride }).first {
            valueEdited = true
            valueText = moneyDigits(manual)
        } else {
            resetValue()
        }
        loadExtrasAndNote(list, focus: focus)
        resetCod()
        // Sửa nháp: COD đã sửa tay lúc duyệt thì giữ nguyên, không lặng lẽ quay về số tự cộng.
        if draftIds != nil, let manual = list.reversed().compactMap({ $0.ship?.codOverride }).first {
            codEdited = true
            codText = moneyDigits(manual)
        }
        // Vừa sửa địa chỉ / số điện thoại xong quay lại: điền lại đúng những gì đã nhập trước khi bấm Sửa.
        if let saved = ReviewResume.forms.removeValue(forKey: orderId) { restore(saved) }
    }

    /// Sang trang Sửa địa chỉ: nhớ các ô đang nhập, sửa xong (Lưu hoặc quay lại) thì mở lại bảng này cho đơn này.
    private func editAddress(_ customerId: String) {
        ReviewResume.forms[orderId] = snapshot
        let id = orderId, ids = draftIds, app = ui
        ui.resumeAfterPop { app.present(dim: 0.42) { ShipReviewSheet(orderId: id, draftIds: ids) } }
        ui.dismissSheet()
        ui.push(.addressEdit(customerId))
    }

    private var snapshot: ReviewResume.Form {
        ReviewResume.Form(checked: checked, pay: pay, payer: payer, fee: fee, depositText: depositText,
                          weightText: weightText, codText: codText, lengthText: lengthText, widthText: widthText,
                          heightText: heightText, codEdited: codEdited, valueText: valueText, valueEdited: valueEdited,
                          goodsText: goodsText, extras: extras, notePicks: notePicks, noteOther: noteOther, noteSaved: noteSaved)
    }

    private func restore(_ f: ReviewResume.Form) {
        // Đơn đã tick mà nay không còn chờ duyệt thì bỏ; không còn đơn nào thì giữ lựa chọn vừa nạp.
        let still = f.checked.intersection(Set(pending.map(\.id)))
        if !still.isEmpty { checked = still }
        pay = f.pay
        payer = f.payer
        fee = f.fee
        depositText = f.depositText
        weightText = f.weightText
        codText = f.codText
        lengthText = f.lengthText
        widthText = f.widthText
        heightText = f.heightText
        codEdited = f.codEdited
        valueText = f.valueText
        valueEdited = f.valueEdited
        goodsText = f.goodsText
        extras = f.extras
        notePicks = f.notePicks
        noteOther = f.noteOther
        noteSaved = f.noteSaved
    }

    /// Quay lại tab Chờ gửi (danh sách nháp nằm ngay trong tab); `open` thì mở thẳng nháp của khách này.
    private func backToDraft(open: Bool) {
        let customerId = focus?.customer.id
        ui.dismissSheet()
        ui.tab = .orders
        ui.ordersFilter = 2
        if open { ui.draftDetail = customerId }
    }

    /// Mỗi lần mở bảng hay đổi lựa chọn, COD quay về số tự cộng.
    private func resetCod() {
        codEdited = false
        codText = moneyDigits(trial?.autoCod ?? 0)
    }

    /// Giá trị đơn quay về tổng tiền các đơn đang tick.
    private func resetValue() {
        valueEdited = false
        valueText = moneyDigits(autoGoods)
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
            // Thiếu kích thước, tên hàng: báo ngay dưới ô nhập, không ở đây (nút Sửa ở đây là sửa địa chỉ).
            if let warn = trial?.problems.filter({ !$0.contains("kích thước") && $0 != Vtp.goodsNameMissing }), !warn.isEmpty {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    T(warn.joined(separator: " · "), 12.5, .medium, Theme.red).fixedSize(horizontal: false, vertical: true)
                    Button { editAddress(focus.customer.id) } label: { T("Sửa", 12.5, .bold, Theme.accent) }
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
            resetValue()
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
                    T("Đơn \(dayMonth(o.lastTs))", 15, .bold)
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
        if Vtp.state(o) == .exported && Vtp.isSelfShipped(o) { return "Đã chuyển Đang giao\(day) (shop tự gửi, chưa kết nối Viettel Post)." }
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
            if asksGoods {
                VStack(alignment: .leading, spacing: 6) {
                    fieldLabel("Tên hàng ") + T("*", 13, .bold, Theme.red)
                    ZStack(alignment: .leading) {
                        if goodsText.isEmpty { T("Ví dụ: Giày dép, Mỹ phẩm", 15, .medium, Theme.placeholder).lineLimit(1) }
                        TextField("", text: $goodsText)
                            .font(.bv(16, .semibold))
                            .foregroundColor(Theme.ink)
                            .textInputAutocapitalization(.sentences)
                    }
                    .padding(.horizontal, 14)
                    .frame(height: 44)
                    .cardStyle(12)
                    if goodsMissing {
                        T("Viettel Post bắt buộc có tên hàng. Đặt tên hàng mặc định ở Tôi → Máy in để khỏi nhập mỗi lần.",
                          12, .medium, Theme.red)
                            .fixedSize(horizontal: false, vertical: true)
                    }
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
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    fieldLabel("Giá trị đơn hàng")
                    Spacer()
                    if valueEdited {
                        Button { resetValue() } label: { T("Tổng các đơn", 12, .bold, Theme.accent) }.buttonStyle(.plain)
                    }
                }
                TextField("", text: $valueText)
                    .font(.bv(16, .semibold))
                    .foregroundColor(Theme.ink)
                    .keyboardType(.numberPad)
                    .focused($valueFocused)
                    .onChange(of: valueText) { _ in
                        // Chỉ khi người bán gõ, không tính lúc mở bảng hay tick đơn.
                        if valueFocused { valueEdited = true }
                    }
                    .padding(.horizontal, 14)
                    .frame(height: 44)
                    .cardStyle(12)
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
            // Chưa kết nối Viettel Post thì không tạo vận đơn: không cần dịch vụ cộng thêm hay ghi chú vận đơn.
            if !shipsDirect {
                extrasRow
                noteRow
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

    /// Dòng nhắc dưới form: bấm xác nhận thì đơn đi đâu (Đang giao thẳng, hay Chờ gửi để Lên vận đơn).
    @ViewBuilder private var nextStepNote: some View {
        if shipsDirect {
            HStack(alignment: .top, spacing: 9) {
                Icon(name: .truck, size: 15, weight: 2.3, color: Theme.muted).padding(.top, 1)
                T("Chưa kết nối Viettel Post (Tôi › ViettelPost). Xác nhận xong, đơn chuyển thẳng sang Đang giao, không qua Chờ gửi.",
                  12.5, .semibold, Theme.muted)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 13)
            .padding(.vertical, 11)
            .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Theme.grayBadge))
        } else if client.vtpConnected {
            HStack(alignment: .top, spacing: 9) {
                Icon(name: .check, size: 15, weight: 2.6, color: Theme.green).padding(.top, 1)
                T("Đã kết nối Viettel Post phần 1. Xác nhận xong, đơn vào Chờ gửi để bấm Lên vận đơn.", 12.5, .semibold, Theme.green)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 13)
            .padding(.vertical, 11)
            .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Theme.greenSoft))
        }
    }

    @ViewBuilder private func footer(_ focus: Order) -> some View {
        HStack(spacing: 10) {
            if isSent {
                // Vận đơn tạo qua API thì huỷ ở phần ViettelPost của chi tiết đơn, không hoàn tác ở đây.
                if Vtp.state(focus) == .exported && focus.status == .shipping && VtpTrack.code(focus) == nil {
                    OutlineButton(title: Vtp.isSelfShipped(focus) ? "Về Chờ gửi" : "Hoàn tác xuất", height: 52) {
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
                if draftIds != nil {
                    // Mở từ nháp vận đơn: không để "Gom sau" ở đây (bấm nhầm là nháp biến mất), chỉ quay lại danh sách nháp.
                    OutlineButton(title: "Quay lại", height: 52) { backToDraft(open: false) }
                        .frame(maxWidth: .infinity)
                } else {
                    OutlineButton(title: "Gom sau", height: 52) { apply(.hold) }
                        .frame(maxWidth: .infinity)
                }
                PrimaryButton(title: draftIds != nil ? "Lưu thay đổi" : (shipsDirect ? "Xác nhận · Đang giao" : "Xác nhận gửi"),
                              icon: shipsDirect ? IconName.truck : nil, fontSize: 15) { apply(.ready) }
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
        // Gửi thẳng Đang giao (chưa kết nối Viettel Post) thì không tạo vận đơn: không bắt kích thước, tên hàng.
        let direct = state == .ready && shipsDirect
        if state == .ready && !direct && sizeMissing {
            ui.notify("Hàng từ 10kg phải nhập đủ kích thước dài, rộng, cao (cm).")
            return
        }
        if state == .ready && !direct && goodsMissing {
            ui.notify("Nhập tên hàng trước khi gửi.")
            return
        }
        rememberDefaults()
        // Đơn đang Chờ gửi mà bị bỏ tick: đưa về chưa duyệt, không thì lúc tạo vận đơn vẫn bị gộp chung và cộng tiền.
        let dropped = state == .ready ? pending.filter { !checked.contains($0.id) && Vtp.state($0) == .ready }.map(\.id) : []
        if direct {
            store.approveAndShip(ids, base: patch(first: true, cod: codValue), dropped: dropped)
        } else {
            store.approve(ids, state: state, base: patch(first: true, cod: codValue), dropped: dropped)
        }
        if draftIds != nil {
            // Lưu thì mở lại nháp để soát tiếp.
            backToDraft(open: state == .ready)
        } else {
            ui.dismissSheet()
        }
    }
}

// MARK: - Dịch vụ cộng thêm và ghi chú vận đơn (bảng Duyệt đơn)

extension ShipReviewSheet {
    /// Mở bảng: lấy dịch vụ và ghi chú đã lưu ở đơn. Đơn chưa duyệt lần nào thì dùng mặc định shop đã bật
    /// ("Mặc định chọn/lưu cho các đơn tiếp theo"), ghi chú giao hàng của khách điền sẵn vào Nội dung khác.
    fileprivate func loadExtrasAndNote(_ list: [Order], focus: Order) {
        let ships = (list + [focus]).reversed().compactMap { $0.ship }
        let reviewed = list.contains { Vtp.state($0) != .ask }
        if let saved = ships.compactMap(\.extras).first {
            extras = VtpExtras.clean(saved)
        } else if !reviewed && extrasRemember {
            extras = VtpExtras.clean(extrasDefault)
        }
        let note: String
        if let saved = ships.compactMap(\.orderNote).first {
            noteSaved = true
            note = saved
        } else {
            let base = !reviewed && noteRemember ? noteDefault : ""
            note = joinNote([base, focus.customer.address?.note ?? ""])
        }
        (notePicks, noteOther) = VtpExtras.split(note, templates: templates)
    }

    /// Nối các phần ghi chú bằng "; ", bỏ phần trống và phần trùng.
    fileprivate func joinNote(_ parts: [String]) -> String {
        var out: [String] = []
        for p in parts.flatMap({ $0.components(separatedBy: ";") }).map(VtpExtras.cleanText) where !p.isEmpty {
            if !out.contains(where: { $0.lowercased() == p.lowercased() }) { out.append(p) }
        }
        return out.joined(separator: VtpExtras.separator)
    }

    /// Bấm Xác nhận / Gom sau: bật "mặc định" thì nhớ lựa chọn này cho đơn chưa duyệt lần sau.
    /// Ghi chú giao hàng riêng của khách này không được nhớ sang khách khác.
    fileprivate func rememberDefaults() {
        if extrasRemember { extrasDefault = VtpExtras.joined(extras) ?? "" }
        if noteRemember {
            let own = VtpExtras.cleanText(focus?.customer.address?.note ?? "").lowercased()
            let parts = noteValue.components(separatedBy: ";").map(VtpExtras.cleanText)
                .filter { !$0.isEmpty && (own.isEmpty || $0.lowercased() != own) }
            noteDefault = parts.joined(separator: VtpExtras.separator)
        }
    }

    // MARK: Hai dòng trong form

    fileprivate var extrasRow: some View {
        VStack(alignment: .leading, spacing: 6) {
            T("Dịch vụ cộng thêm", 12, .semibold, Theme.muted)
            Button { openExtras() } label: {
                HStack(spacing: 12) {
                    Icon(name: .plus, size: 15, weight: 2.4, color: Theme.orange)
                        .frame(width: 32, height: 32)
                        .background(RoundedRectangle(cornerRadius: 9, style: .continuous).fill(Theme.orange.opacity(0.12)))
                    VStack(alignment: .leading, spacing: 2) {
                        T(extras.isEmpty ? "Chưa chọn" : "\(extras.count) dịch vụ", 15, .bold, extras.isEmpty ? Theme.muted : Theme.ink)
                        if !extras.isEmpty {
                            T(VtpExtras.names(extras), 12, .medium, Theme.muted).lineLimit(1)
                        }
                    }
                    Spacer(minLength: 6)
                    if let total = extrasTotal, total > 0 {
                        T("+" + money(total), 14, .bold, Theme.orange).fixedSize()
                    }
                    Icon(name: .chevronRight, size: 14, weight: 2.4, color: Theme.faint)
                }
                .padding(.horizontal, 12)
                .frame(minHeight: 54)
                .contentShape(Rectangle())
                .cardStyle(12)
            }
            .buttonStyle(.plain)
        }
    }

    fileprivate var noteRow: some View {
        VStack(alignment: .leading, spacing: 6) {
            T("Ghi chú đơn hàng", 12, .semibold, Theme.muted)
            Button { openNotes() } label: {
                HStack(alignment: .top, spacing: 12) {
                    Icon(name: .pencil, size: 15, weight: 2.2, color: Theme.orange)
                        .frame(width: 32, height: 32)
                        .background(RoundedRectangle(cornerRadius: 9, style: .continuous).fill(Theme.orange.opacity(0.12)))
                    T(noteValue.isEmpty ? "Chưa có ghi chú" : noteValue, 14, .semibold, noteValue.isEmpty ? Theme.muted : Theme.ink)
                        .lineLimit(3)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, minHeight: 32, alignment: .leading)
                    Icon(name: .chevronRight, size: 14, weight: 2.4, color: Theme.faint).padding(.top, 9)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 11)
                .contentShape(Rectangle())
                .cardStyle(12)
            }
            .buttonStyle(.plain)
        }
    }

    // MARK: Bảng chọn dịch vụ

    private var service: String { UserDefaults.standard.string(forKey: Vtp.serviceKey) ?? Vtp.defaultService }

    private func hideKeyboard() {
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    }

    fileprivate func openExtras() {
        hideKeyboard()
        withAnimation(Self.pickerMotion) { picker = .extras }
        loadPrices()
    }

    /// Hỏi máy chủ giá từng dịch vụ cho đúng đơn này (địa chỉ, cân nặng, giá trị, thu hộ, gói). Đơn không đổi thì không hỏi lại.
    private func loadPrices() {
        guard client.vtpConnected, let focus, let t = trial else { return }
        let list = chosen.isEmpty ? [focus] : chosen
        let g = Vtp.Group(customer: focus.customer, orders: list, recentExported: [], summary: t)
        let svc = service
        let size = t.size.map { "\($0.0)x\($0.1)x\($0.2)" } ?? ""
        let key = [t.address.line, "\(t.cod)", "\(t.goods)", "\(t.weightG)", size, svc].joined(separator: "|")
        guard key != pricesKey || pricesError != nil, !pricesLoading else { return }
        // Viettel Post chỉ tính giá khi có địa chỉ khách đủ (số nhà, phường, tỉnh); trống hoặc thiếu thì họ trả
        // "Invalid [RECEIVER_ADDRESS]". Báo rõ ngay, không hỏi máy chủ.
        guard t.address.ok else {
            prices = [:]
            pricesKey = ""
            pricesError = Self.noAddressText
            return
        }
        var payload = VtpTrack.payload(g)
        payload["extras"] = ""
        pricesLoading = true
        pricesError = nil
        Task { @MainActor in
            let r = await client.vtpExtraPrices(service: svc, group: payload)
            pricesLoading = false
            if let e = r.error {
                pricesError = e.contains("RECEIVER_ADDRESS") ? Self.noAddressText : e
                return
            }
            prices = r.prices
            pricesKey = key
            // Dịch vụ đã chọn mà gói đang chọn không nhận: bỏ tick, kẻo Viettel Post từ chối cả vận đơn.
            let refusedNow = extras.filter { refused($0) }
            if !refusedNow.isEmpty {
                extras.removeAll { refusedNow.contains($0) }
                ui.notify("Bỏ chọn \(VtpExtras.names(refusedNow)): gói đang chọn không nhận.")
            }
        }
    }

    static let noAddressText = "Viettel Post chưa đọc được địa chỉ khách nên chưa tính được giá. Nhập đủ số nhà, phường, tỉnh ở mục Người nhận rồi mở lại bảng này."

    /// Đã hỏi giá và Viettel Post báo gói đang chọn không nhận dịch vụ này.
    private func refused(_ code: String) -> Bool {
        guard let p = prices[code] else { return false }
        return p == nil
    }

    fileprivate var extrasPicker: some View {
        VStack(spacing: 0) {
            pickerHeader("Dịch vụ cộng thêm") {
                if pricesLoading {
                    ProgressView().scaleEffect(0.8)
                } else if !prices.isEmpty {
                    T("giá đã gồm VAT", 12, .semibold, Theme.faint)
                }
            }
            ScrollView(showsIndicators: false) {
                VStack(alignment: .leading, spacing: 12) {
                    VStack(spacing: 0) {
                        ForEach(Array(VtpExtras.all.enumerated()), id: \.element.code) { i, svc in
                            if i > 0 { Rectangle().fill(Theme.line.opacity(0.7)).frame(height: 1).padding(.leading, 50) }
                            extraRow(svc)
                        }
                    }
                    .cardStyle(16)
                    if let e = pricesError {
                        T("Chưa hỏi được giá: \(e)", 12.5, .medium, Theme.red).fixedSize(horizontal: false, vertical: true)
                    } else if !client.vtpConnected {
                        T("Kết nối Viettel Post phần 1 (Tôi › ViettelPost) để xem giá từng dịch vụ.", 12.5, .medium, Theme.muted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Toggle(isOn: $extrasRemember) {
                        T("Mặc định chọn cho các đơn tiếp theo", 14, .semibold)
                    }
                    .tint(Theme.orange)
                    .onChange(of: extrasRemember) { on in if !on { extrasDefault = "" } }
                    .padding(.horizontal, 4)
                }
                .padding(.horizontal, Metrics.gutter)
                .padding(.bottom, 12)
            }
            pickerFooter(left: extras.isEmpty ? "Chưa chọn dịch vụ" : "\(extras.count) dịch vụ",
                         right: extrasTotal.map { $0 > 0 ? "+" + money($0) : "" } ?? "")
        }
    }

    private func extraRow(_ svc: VtpExtras.Service) -> some View {
        let on = extras.contains(svc.code)
        let off = refused(svc.code)
        let price: Int? = prices[svc.code] ?? nil
        return Button {
            guard !off else { return }
            if on { extras.removeAll { $0 == svc.code } } else { extras = VtpExtras.clean(extras + [svc.code]) }
        } label: {
            HStack(spacing: 12) {
                TickCircle(on: on && !off, enabled: !off)
                VStack(alignment: .leading, spacing: 2) {
                    T(svc.name, 15, .semibold, off ? Theme.faint : Theme.ink)
                    if off {
                        T("Gói đang chọn không nhận", 11.5, .medium, Theme.faint)
                    } else if svc.code == "GBH", let t = trial {
                        T("Theo giá trị đơn \(money(t.goods))", 11.5, .medium, Theme.muted)
                    }
                }
                Spacer(minLength: 6)
                if let price {
                    T(money(price), 14, .bold, on ? Theme.ink : Theme.muted).fixedSize()
                } else if off {
                    T("—", 14, .bold, Theme.faint)
                }
            }
            .padding(.horizontal, 14)
            .frame(minHeight: 50)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    // MARK: Bảng ghi chú

    fileprivate func openNotes() {
        hideKeyboard()
        withAnimation(Self.pickerMotion) { picker = .notes }
        if !templatesFromAccount { loadTemplates() }
    }

    private var noteAccount: VtpDraftClient? {
        let c = vtpDrafts.current
        return c.loggedIn && !c.sessionExpired ? c : nil
    }

    /// Ghi chú mẫu lấy thẳng từ tài khoản Viettel Post (phần 2); chưa đăng nhập thì dùng 5 mẫu chung của Viettel Post.
    private func loadTemplates() {
        guard let account = noteAccount, !templatesLoading else { return }
        templatesLoading = true
        templatesError = nil
        Task { @MainActor in
            defer { templatesLoading = false }
            do {
                let r = try await account.noteTemplates()
                let list = r.templates.isEmpty ? VtpExtras.defaultTemplates : r.templates
                let current = noteText
                templates = list
                templatesFromAccount = true
                UserDefaults.standard.set(list, forKey: VtpExtras.templatesKey)
                // Tách lại ghi chú theo mẫu mới; đơn chưa có ghi chú lưu thì tick sẵn mẫu bật "Mặc định chọn".
                var split = VtpExtras.split(current, templates: list)
                if !noteSaved {
                    for t in r.selected where !split.picks.contains(t) { split.picks.append(t) }
                }
                notePicks = split.picks
                noteOther = split.other
            } catch {
                templatesError = error.localizedDescription
            }
        }
    }

    fileprivate var notesPicker: some View {
        VStack(spacing: 0) {
            pickerHeader("Ghi chú đơn hàng") {
                if templatesLoading {
                    ProgressView().scaleEffect(0.8)
                } else if noteAccount != nil {
                    Button { loadTemplates() } label: { T("Tải lại", 13, .bold, Theme.accent) }.buttonStyle(.plain)
                }
            }
            ScrollView(showsIndicators: false) {
                VStack(alignment: .leading, spacing: 10) {
                    T(templatesFromAccount ? "GHI CHÚ MẪU · TỪ TÀI KHOẢN VIETTEL POST" : "GHI CHÚ MẪU VIETTEL POST",
                      11.5, .bold, Theme.muted, track: 0.4)
                        .padding(.leading, 4)
                    VStack(spacing: 0) {
                        ForEach(Array(templates.enumerated()), id: \.element) { i, t in
                            if i > 0 { Rectangle().fill(Theme.line.opacity(0.7)).frame(height: 1).padding(.leading, 50) }
                            templateRow(t)
                        }
                    }
                    .cardStyle(16)
                    if let e = templatesError {
                        T("Chưa đọc được mẫu của tài khoản: \(e)", 12, .medium, Theme.red).fixedSize(horizontal: false, vertical: true)
                    } else if noteAccount == nil {
                        T("Đăng nhập Viettel Post phần 2 để lấy đúng ghi chú mẫu của tài khoản bạn.", 12, .medium, Theme.muted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    T("NỘI DUNG KHÁC · TỰ ĐIỀN", 11.5, .bold, Theme.muted, track: 0.4)
                        .padding(.leading, 4)
                        .padding(.top, 6)
                    ZStack(alignment: .topLeading) {
                        if noteOther.isEmpty {
                            T("Ví dụ: Giao sau 17h giúp shop", 15, .medium, Theme.placeholder)
                        }
                        TextField("", text: $noteOther, axis: .vertical)
                            .font(.bv(15, .semibold))
                            .foregroundColor(Theme.ink)
                            .lineLimit(2...5)
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 12)
                    .frame(maxWidth: .infinity, minHeight: 64, alignment: .topLeading)
                    .cardStyle(12)
                    HStack {
                        T("Chữ có dấu tính 2-3 ký tự", 11.5, .medium, Theme.faint)
                        Spacer()
                        T("\(VtpExtras.bytes(noteText))/\(VtpExtras.maxNoteBytes)", 12, .bold, noteTooLong ? Theme.red : Theme.muted)
                    }
                    .padding(.horizontal, 4)
                    if noteTooLong {
                        T("Ghi chú dài quá giới hạn Viettel Post, phần cuối sẽ bị cắt.", 12, .medium, Theme.red)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Toggle(isOn: $noteRemember) {
                        T("Mặc định lưu ghi chú này cho các đơn tiếp theo", 14, .semibold)
                    }
                    .tint(Theme.orange)
                    .onChange(of: noteRemember) { on in if !on { noteDefault = "" } }
                    .padding(.horizontal, 4)
                    .padding(.top, 4)
                }
                .padding(.horizontal, Metrics.gutter)
                .padding(.bottom, 12)
            }
            .scrollDismissesKeyboard(.interactively)
            pickerFooter(left: "", right: "")
        }
    }

    private func templateRow(_ t: String) -> some View {
        let on = notePicks.contains(t)
        return Button {
            if on { notePicks.removeAll { $0 == t } } else { notePicks.append(t) }
        } label: {
            HStack(spacing: 12) {
                TickCircle(on: on)
                T(t, 15, .semibold).fixedSize(horizontal: false, vertical: true).frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .frame(minHeight: 50)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    // MARK: Khung chung của hai bảng con

    private func pickerHeader<Trailing: View>(_ title: String, @ViewBuilder trailing: () -> Trailing) -> some View {
        HStack(spacing: 10) {
            Button { closePicker() } label: {
                Icon(name: .chevronLeft, size: 17, weight: 2.4).frame(width: 36, height: 36).background(Circle().fill(Theme.field))
            }
            .buttonStyle(.plain)
            T(title, 20, .heavy, Theme.ink, track: -0.3)
            Spacer()
            trailing()
        }
        .padding(.horizontal, Metrics.gutter)
        .padding(.bottom, 12)
    }

    private func pickerFooter(left: String, right: String) -> some View {
        VStack(spacing: 10) {
            if !left.isEmpty || !right.isEmpty {
                HStack {
                    T(left, 13.5, .semibold, Theme.muted)
                    Spacer()
                    T(right, 15, .heavy)
                }
            }
            PrimaryButton(title: "Xong", fontSize: 15) { closePicker() }
        }
        .padding(.horizontal, Metrics.gutter)
        .padding(.top, 10)
    }

    private func closePicker() {
        hideKeyboard()
        withAnimation(Self.pickerMotion) { picker = nil }
    }
}

// MARK: - Bảng Xuất Viettel Post

struct VtpExportSheet: View {
    @EnvironmentObject var store: Store
    @EnvironmentObject var client: LiveClient
    @EnvironmentObject var ui: AppUI
    @EnvironmentObject var vtpDrafts: VtpDraftHub
    /// Nằm luôn trong tab Chờ gửi (thay cho bảng "Nháp vận đơn" bật lên trước đây).
    let embedded: Bool
    /// Ô tìm của tab Đơn hàng: lọc danh sách khách khi nằm trong tab.
    let search: String
    /// Nhóm khách Chờ gửi tính sẵn từ màn cha để không gom và kiểm địa chỉ lại từ đầu.
    let baseGroups: [Vtp.Group]?
    /// Lọc trong tab Chờ gửi: 0 tất cả, 1 chưa đẩy, 2 nháp VTP, 3 cần sửa.
    @State private var draftFilter = 0
    @State private var sending = false
    /// Kết quả lần tạo vận đơn vừa xong (cùng các khách đã gửi), hiện thay cho danh sách.
    @State private var result: (groups: [Vtp.Group], results: [VtpCreateResult])?
    @State private var selected: Set<String> = []
    @State private var touched = false
    @State private var service = UserDefaults.standard.string(forKey: Vtp.serviceKey) ?? Vtp.defaultService
    @State private var picking = false
    /// Đang mở bảng giải thích hai nút (nút "?" cạnh "Đã chọn").
    @State private var showHelp = false
    /// Thẻ khách đang mở rộng trong tab Chờ gửi (mặc định thẻ gọn).
    @State private var expanded: Set<String> = []
    /// Nháp đã hỏi cước, theo chữ ký nháp (VtpQuote.signature). Đang hỏi thì nằm trong `quoting`.
    @State private var quotes: [String: VtpQuote] = [:]
    @State private var quoting: Set<String> = []
    /// Nháp đang mở để soát chi tiết (mã khách); nil là đang ở danh sách nháp.
    @State private var detailId: String?
    /// Đang xoá nháp trên Viettel Post (một khách hoặc nhiều khách).
    @State private var deletingDrafts = false

    /// `openDetail`: mở thẳng nháp của khách này (dùng khi vừa sửa Hàng & tiền xong).
    init(openDetail: String? = nil, embedded: Bool = false, search: String = "", baseGroups: [Vtp.Group]? = nil) {
        _detailId = State(initialValue: openDetail)
        self.embedded = embedded
        self.search = search
        self.baseGroups = baseGroups
    }

    private var rawGroups: [Vtp.Group] { baseGroups ?? store.readyGroups() }

    /// Khách khớp ô tìm (tên, SĐT, @tiktok, mã đơn).
    private func matchesSearch(_ g: Vtp.Group) -> Bool {
        let q = search.trimmingCharacters(in: .whitespaces).lowercased()
        guard !q.isEmpty else { return true }
        let s = g.summary
        let hay = [s.receiver, s.phone, g.customer.nickname, g.customer.uniqueId]
            .joined(separator: " ").lowercased()
        return hay.contains(q)
    }

    private func matchesDraftFilter(_ g: Vtp.Group, _ f: Int) -> Bool {
        let st = VtpDraftBody.status(g, service: service)
        switch f {
        case 1:
            if case .notPushed = st { return !g.isBad }
            return false
        case 2:
            switch st {
            case .pushed, .stale: return true
            default: return false
            }
        case 3:
            if case .failed = st { return true }
            return g.isBad
        default:
            return true
        }
    }

    /// Đơn ở Chờ gửi là nháp sẵn. Viettel Post hiểu địa chỉ sang phường/tỉnh khác thì nháp đó chưa cho tạo.
    private func makeAllGroups() -> [Vtp.Group] {
        rawGroups.map { g in
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
    private var serviceName: String {
        let s = Vtp.services.first { $0.code == service } ?? Vtp.services[0]
        return "\(s.code) · \(s.name)"
    }

    private var api: Bool { client.vtpConnected }

    var body: some View {
        let all = result == nil ? makeAllGroups() : []
        Group {
            if let result {
                VtpResultView(groups: result.groups, results: result.results, onDone: embedded ? { self.result = nil } : nil)
            } else if let id = detailId, let g = all.first(where: { $0.id == id }) {
                detailView(g)
            } else {
                picker(all: all)
            }
        }
        .frame(height: embedded ? nil : Metrics.sheetHeight(top: UIScreen.main.bounds.height * 0.12))
        .frame(maxHeight: embedded ? .infinity : nil)
        .onAppear {
            takeDetailRequest()
            if client.vtpConnected && !client.vtpRunning { client.refreshVtp() }
        }
        .onChange(of: ui.draftDetail) { _ in takeDetailRequest() }
        .onChange(of: client.vtp?.sender?.id) { _ in
            quotes = [:]
            quoting = []
        }
        .onChange(of: client.currentAccountKey) { _ in
            quotes = [:]
            quoting = []
            detailId = nil
            result = nil
            selected = []
            touched = false
        }
        // Khoá theo mọi nháp đủ địa chỉ (không theo cái đang hỏi), để lượt hỏi đang chạy không bị huỷ giữa chừng.
        .task(id: quoteKey) { await loadQuotes() }
    }

    /// Vừa sửa Hàng & tiền xong (bảng Duyệt đơn): mở lại đúng nháp của khách đó.
    private func takeDetailRequest() {
        guard embedded, let id = ui.draftDetail else { return }
        detailId = id
        ui.draftDetail = nil
    }

    private var quoteKey: String {
        guard api, let senderId = client.vtp?.sender?.id else { return "" }
        return ([client.currentAccountKey, senderId] + rawGroups.filter { !$0.isBad }
            .map { VtpQuote.signature($0, service: service) }.sorted()).joined(separator: ",")
    }

    /// Nháp đủ địa chỉ chưa có cước cho gói đang chọn.
    private var quoteNeeds: [(String, Vtp.Group)] {
        guard api, client.vtp?.sender != nil else { return [] }
        return rawGroups
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
        guard !Task.isCancelled else { return }
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
        let busy = isQuoting(g)
        let parsed = q?.parsed ?? ""
        let mismatch = q?.addrOk == false
        let feeOk = q?.ok == true
        return VStack(spacing: 0) {
            HStack(alignment: .top) {
                T("Nháp · \(name)", 20, .heavy, Theme.ink, track: -0.3).lineLimit(1).minimumScaleFactor(0.8)
                Spacer()
                if embedded {
                    Button { detailId = nil } label: {
                        Icon(name: .close, size: 17, weight: 2.4).frame(width: 36, height: 36).background(Circle().fill(Theme.field))
                    }
                    .buttonStyle(.plain)
                } else {
                    SheetClose()
                }
            }
            .padding(.horizontal, Metrics.gutter)
            .padding(.bottom, 12)

            ScrollView(showsIndicators: false) {
                VStack(spacing: 10) {
                    if embedded { draftBox(g) }
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
                            T("\(s.goodsName.isEmpty ? "Chưa có tên hàng" : s.goodsName) · \(max(s.qty, 1)) món", 13, .semibold,
                              s.goodsName.isEmpty ? Theme.red : Theme.ink).lineLimit(1)
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
                        if !s.extras.isEmpty { kv("Dịch vụ thêm", VtpExtras.names(s.extras)) }
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

            // Trong tab Chờ gửi: nút thấp hơn và chừa lề dưới để không dính sát thanh tab.
            let detailBtnH: CGFloat = embedded ? 44 : 52
            let detailFont: CGFloat = embedded ? 14.5 : 15
            HStack(spacing: 10) {
                OutlineButton(title: embedded ? "Quay lại" : "Để nháp", height: detailBtnH) { detailId = nil }
                    .frame(width: (Metrics.screenWidth - 50) / 3)
                let hasPushedDraft: Bool = {
                    if case .pushed = VtpDraftBody.status(g, service: service) { return true }
                    return false
                }()
                if api || !embedded || (hasPushedDraft && vtpDrafts.anyLoggedIn) {
                    let btnTitle = sending
                        ? (hasPushedDraft ? "Đang duyệt nháp…" : "Đang tạo vận đơn…")
                        : busy ? "Đang tính cước…"
                        : hasPushedDraft ? "Duyệt nháp lên đơn"
                        : (embedded ? "Lên vận đơn" : "Tạo vận đơn này")
                    PrimaryButton(title: btnTitle,
                                  icon: .truck, fontSize: detailFont, height: detailBtnH, enabled: !g.isBad && !sending && !busy) {
                        create([g])
                    }
                } else {
                    PrimaryButton(title: "Đẩy nháp VTP", icon: .arrowRight, fontSize: detailFont, height: detailBtnH, enabled: !g.isBad) {
                        pushDrafts([g])
                    }
                }
            }
            .padding(.horizontal, Metrics.gutter)
            .padding(.top, embedded ? 10 : 14)
            .padding(.bottom, embedded ? 10 : 0)
            .background(Theme.card.overlay(alignment: .top) { HairLine() })
        }
    }

    private func picker(all: [Vtp.Group]) -> some View {
        let searched = embedded ? all.filter { matchesSearch($0) } : all
        let list = embedded ? searched.filter { matchesDraftFilter($0, draftFilter) } : searched
        let ok = Set(list.filter { !$0.isBad }.map(\.id))
        let pick = touched ? selected.intersection(ok) : ok
        let bad = list.filter(\.isBad).count
        return VStack(spacing: 0) {
            if embedded {
                draftChips(searched)
            } else {
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
            }

            HStack(spacing: 8) {
                T("ĐÃ CHỌN \(pick.count)", 12, .bold, Theme.muted, track: 0.4)
                if embedded {
                    Button { withAnimation(.easeOut(duration: 0.15)) { showHelp.toggle() } } label: {
                        T("?", 11.5, .heavy, showHelp ? Theme.card : Theme.muted)
                            .frame(width: 20, height: 20)
                            .background(Circle().fill(showHelp ? Theme.ink : Color.clear))
                            .overlay(Circle().strokeBorder(showHelp ? Theme.ink : Theme.placeholder, lineWidth: 1.5))
                            .frame(width: 32, height: 26)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .padding(.horizontal, -6)
                }
                Spacer()
                Button {
                    selected = pick.count == ok.count ? [] : ok
                    touched = true
                } label: {
                    T(pick.count == ok.count && !pick.isEmpty ? "Bỏ chọn tất cả" : "Chọn tất cả", 13, .bold, Theme.accent)
                }
                .buttonStyle(.plain)
                .disabled(ok.isEmpty)
                let withDraft = list.filter { pick.contains($0.id) && !VtpDraftBody.codes($0).isEmpty }
                if embedded && !withDraft.isEmpty {
                    Button { deleteDrafts(withDraft) } label: {
                        T(deletingDrafts ? "Đang xoá…" : "Xoá nháp (\(withDraft.count))", 13, .bold, Theme.red)
                    }
                    .buttonStyle(.plain)
                    .disabled(deletingDrafts)
                    .padding(.leading, 12)
                }
            }
            .padding(.horizontal, Metrics.gutter + 4)
            .padding(.top, embedded ? 6 : 12)
            .padding(.bottom, embedded ? 6 : 8)
            // Bảng giải thích hai nút dưới cùng, nổi đè lên danh sách khi bấm "?".
            .overlay(alignment: .top) {
                if showHelp {
                    buttonHelp
                        .padding(.horizontal, Metrics.gutter - 4)
                        .padding(.top, 34)
                        .transition(.opacity)
                }
            }
            .zIndex(2)

            ScrollView(showsIndicators: false) {
                LazyVStack(spacing: 10) {
                    if list.isEmpty {
                        T(embedded && !all.isEmpty ? "Không có khách nào khớp." : "Chưa có đơn nào đã duyệt.", 14, .medium, Theme.muted)
                            .padding(.vertical, 30)
                    }
                    if !embedded && api && !list.isEmpty {
                        T("Viettel Post chưa nhận đơn nào. Soát xong rồi mới bấm Tạo.", 12.5, .medium, Theme.muted)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 4)
                    }
                    ForEach(list) { g in
                        row(g, on: pick.contains(g.id), pick: pick)
                            .cardStyle(16, fill: g.isBad ? Theme.badRow : Theme.card)
                            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                    }
                }
                .padding(.horizontal, Metrics.gutter)
                .padding(.bottom, 12)
            }
            .frame(maxHeight: .infinity)
            .overlay {
                // Đang mở giải thích: lớp mờ, chạm ra ngoài là đóng.
                if showHelp {
                    Theme.ink.opacity(0.12)
                        .contentShape(Rectangle())
                        .onTapGesture { withAnimation(.easeOut(duration: 0.15)) { showHelp = false } }
                        .transition(.opacity)
                }
            }

            footer(list, pick)
        }
    }

    private func row(_ g: Vtp.Group, on: Bool, pick: Set<String>) -> some View {
        let s = g.summary
        let start = Calendar.current.startOfDay(for: Clock.now)
        let olderDay = g.orders.first { $0.lastTs < start }.map { dayMonth($0.lastTs) }
        return Button {
            guard !g.isBad else { return }
            var next = pick
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
                    // Tab Chờ gửi: thẻ gọn (địa chỉ 1 dòng, không hộp xanh), bấm mũi tên để xem đủ.
                    let compact = embedded && !expanded.contains(g.id)
                    let contact = [s.phone, s.address.line].filter { !$0.isEmpty }.joined(separator: " · ")
                    if embedded {
                        HStack(alignment: .top, spacing: 4) {
                            T(contact.isEmpty ? " " : contact, 12.5, .medium, Theme.muted)
                                .lineLimit(compact ? 1 : nil)
                                .fixedSize(horizontal: false, vertical: !compact)
                                .frame(maxWidth: .infinity, alignment: .leading)
                            Button {
                                withAnimation(.easeOut(duration: 0.15)) {
                                    if expanded.contains(g.id) { expanded.remove(g.id) } else { expanded.insert(g.id) }
                                }
                            } label: {
                                Icon(name: compact ? .chevronDown : .chevronUp, size: 14, color: Theme.muted)
                                    .frame(width: 30, height: 20)
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .padding(.trailing, -6)
                        }
                    } else if !contact.isEmpty {
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
                    } else if compact {
                        if api, !isQuoting(g), let q = quote(g), !q.ok {
                            T(q.error, 12, .semibold, Theme.red).fixedSize(horizontal: false, vertical: true)
                        }
                        HStack(spacing: 0) {
                            if api && addressConfirmed(g) {
                                T("✓ Địa chỉ đúng · ", 12, .semibold, Theme.green).lineLimit(1).fixedSize()
                            }
                            T(shortDetail(s), 12, .medium, Theme.muted).lineLimit(1).minimumScaleFactor(0.85)
                        }
                        HStack(alignment: .firstTextBaseline) {
                            if api { T(feeText(g), 12.5, .bold, Theme.ink).lineLimit(1).minimumScaleFactor(0.8) }
                            Spacer(minLength: 8)
                            Button { detailId = g.id } label: {
                                T("Soát chi tiết ›", 12.5, .bold, Theme.accent).fixedSize()
                            }
                            .buttonStyle(.plain)
                        }
                    } else {
                        if api { quoteLine(g) }
                        T(detail(s), 12, .medium, Theme.muted).fixedSize(horizontal: false, vertical: true)
                        if api || embedded {
                            HStack(alignment: .firstTextBaseline) {
                                if api { T(feeText(g), 12.5, .bold, Theme.ink).lineLimit(1).minimumScaleFactor(0.8) }
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
        if let d = draftTag(g) { tags.append(d) }
        if g.orders.count > 1 { tags.append(("gộp \(g.orders.count) đơn", Theme.gomInk, Theme.gomTag)) }
        if let olderDay { tags.append(("duyệt \(olderDay)", Theme.muted, Theme.grayBadge)) }
        if g.summary.allPaid { tags.append(("bank đủ", Theme.green, Theme.greenSoft)) }
        if g.summary.address.ok && g.summary.address.isOld { tags.append(("địa chỉ cũ", Theme.muted, Theme.grayBadge)) }
        return tags
    }

    /// Nhãn nháp Viettel Post của khách: đã đẩy (giờ đẩy), nháp ở tài khoản khác, nháp cũ, lỗi đẩy, chưa đẩy.
    private func draftTag(_ g: Vtp.Group) -> (String, Color, Color)? {
        switch VtpDraftBody.status(g, service: service) {
        case .pushed(_, let at):
            if vtpDrafts.loggedInClients.count > 1,
               let acc = g.orders.compactMap(\.ship).compactMap(\.draftAccount).first(where: { !$0.isEmpty }),
               !vtpDrafts.current.owns(acc) {
                return ("Nháp · khác TK", Theme.gomInk, Theme.gomTag)
            }
            var when = ""
            if let at {
                let d = Date(timeIntervalSince1970: at / 1000)
                when = " · \(timeText(d))"
            }
            return ("Nháp VTP" + when, VtpDraftColors.ink, VtpDraftColors.soft)
        case .stale:
            return ("Nháp cũ", Theme.gomInk, Theme.gomTag)
        case .failed:
            return ("Lỗi đẩy nháp", Theme.red, Theme.redSoft)
        case .notPushed:
            return embedded && vtpDrafts.anyLoggedIn && !g.isBad ? ("Chưa đẩy", Theme.muted, Theme.grayBadge) : nil
        }
    }

    /// Hàng lọc nhanh trong tab Chờ gửi.
    private func draftChips(_ searched: [Vtp.Group]) -> some View {
        let items: [(id: Int, title: String)] = [(0, "Tất cả"), (1, "Chưa đẩy"), (2, "Nháp VTP"), (3, "Cần sửa")]
        return ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(items, id: \.id) { item in
                    let n = item.id == 0 ? searched.count : searched.filter { matchesDraftFilter($0, item.id) }.count
                    let on = draftFilter == item.id
                    Button {
                        draftFilter = item.id
                        touched = false
                    } label: {
                        T("\(item.title) \(n)", 12.5, .bold, on ? Theme.card : Theme.muted)
                            .padding(.horizontal, 12)
                            .frame(height: 30)
                            .background(Capsule().fill(on ? Theme.ink : Theme.card))
                            .overlay(Capsule().strokeBorder(on ? Color.clear : Theme.line, lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, Metrics.gutter)
        }
    }

    private func tag(_ text: String, _ color: Color, _ fill: Color) -> some View {
        T(text, 11, .bold, color).lineLimit(1).fixedSize()
            .padding(.horizontal, 8)
            .frame(height: 20)
            .background(Capsule().fill(fill))
    }

    /// Viettel Post đã đọc ra địa chỉ và khớp (thẻ gọn chỉ hiện dấu ✓ thay cho hộp xanh).
    private func addressConfirmed(_ g: Vtp.Group) -> Bool {
        guard !isQuoting(g), let q = quote(g) else { return false }
        return !q.parsed.isEmpty && q.addrOk != false
    }

    /// Dòng tóm tắt của thẻ gọn: ai trả ship, tiền ship cộng vào thu hộ (nếu có), cân nặng.
    private func shortDetail(_ s: Vtp.Summary) -> String {
        let who = s.senderPays ? "Shop trả ship" : "Khách trả ship"
        let cod = s.shipFee > 0 ? "COD +\(money(s.shipFee))" : ""
        return [who, cod, weightText(s.weightG)].filter { !$0.isEmpty }.joined(separator: " · ")
    }

    /// Bảng giải thích hai nút dưới cùng của tab Chờ gửi (mở bằng nút "?" cạnh "Đã chọn").
    private var buttonHelp: some View {
        VStack(alignment: .leading, spacing: 10) {
            T("Hai nút dưới cùng khác nhau thế nào?", 14, .heavy)
            helpItem(icon: .arrowRight, color: VtpDraftColors.brand, fill: nil, title: "Đẩy nháp VTP",
                     text: "Đơn vào mục Đơn nháp trên viettelpost.vn, chưa gọi bưu tá. Sửa hoặc xoá nháp được.")
            if api {
                helpItem(icon: .truck, color: Theme.ink, fill: Theme.orange, title: "Lên vận đơn",
                         text: "Tạo vận đơn thật, Viettel Post cho bưu tá tới lấy. Khách đã đẩy nháp thì duyệt thẳng nháp, giữ nguyên mã; chưa có nháp thì tạo mới.")
            } else {
                helpItem(icon: .download, color: Theme.ink, fill: Theme.orange, title: "Xuất Excel",
                         text: "Tải file Excel để tự nhập lên Viettel Post. Kết nối phần 1 ở Tôi › ViettelPost để bấm Lên vận đơn ngay trong app.")
            }
            HStack {
                Spacer()
                Button { withAnimation(.easeOut(duration: 0.15)) { showHelp = false } } label: {
                    T("Đã hiểu", 13.5, .heavy, Theme.accent)
                        .padding(.vertical, 4)
                        .padding(.leading, 12)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .fixedSize(horizontal: false, vertical: true)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(Theme.card)
                .shadow(color: Color.black.opacity(0.18), radius: 18, x: 0, y: 8)
        )
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Theme.line, lineWidth: 1))
    }

    private func helpItem(icon: IconName, color: Color, fill: Color?, title: String, text: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Icon(name: icon, size: 13, weight: 2.4, color: color)
                .frame(width: 28, height: 28)
                .background(Circle().fill(fill ?? Color.clear))
                .overlay(Circle().strokeBorder(fill == nil ? color : Color.clear, lineWidth: 1.5))
            VStack(alignment: .leading, spacing: 2) {
                T(title, 13, .heavy)
                T(text, 12.5, .medium, Theme.muted).fixedSize(horizontal: false, vertical: true)
            }
        }
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
        // Trong tab Chờ gửi: chân gọn hơn (không nhãn "Dịch vụ", nút thấp hơn) để danh sách khách có thêm chỗ.
        let compact = embedded
        let btnH: CGFloat = compact ? 48 : 52
        let btnFont: CGFloat = compact ? 17 : 15
        return VStack(spacing: compact ? 10 : 14) {
            HStack(alignment: compact ? .center : .bottom) {
                VStack(alignment: .leading, spacing: 5) {
                    if !compact { fieldLabel("Dịch vụ") }
                    Button { picking.toggle() } label: {
                        HStack(spacing: 4) {
                            T(serviceName, compact ? 16 : 14, .bold).lineLimit(1).fixedSize()
                            Icon(name: picking ? .chevronUp : .chevronDown, size: compact ? 16 : 14, color: Theme.muted)
                        }
                        .padding(.horizontal, compact ? 13 : 12)
                        .frame(height: compact ? 38 : 38)
                        .cardStyle(compact ? 11 : 12, fill: Theme.field)
                    }
                    .buttonStyle(.plain)
                    .overlay(alignment: .bottomLeading) {
                        if picking { servicePicker.offset(y: compact ? -46 : -46).fixedSize() }
                    }
                }
                .zIndex(1)
                Spacer(minLength: 8)
                if compact {
                    VStack(alignment: .trailing, spacing: 0) {
                        T(money(total), 22, .heavy, Theme.ink, track: -0.35).lineLimit(1).minimumScaleFactor(0.7)
                        T(["\(pick.count) khách", api && feeTotal > 0 ? "cước \(money(feeTotal))" : ""]
                            .filter { !$0.isEmpty }.joined(separator: " · "), 14, .semibold, Theme.muted)
                            .lineLimit(1).minimumScaleFactor(0.8)
                    }
                } else {
                    VStack(alignment: .trailing, spacing: 2) {
                        T(api ? "Tổng thu hộ · \(pick.count) khách" : "Tổng thu hộ", 12, .semibold, Theme.muted)
                        T(money(total), 22, .heavy, Theme.ink, track: -0.4).lineLimit(1).minimumScaleFactor(0.7)
                        if api && feeTotal > 0 {
                            T("Cước dự tính \(money(feeTotal))", 12, .semibold, Theme.muted).lineLimit(1)
                        }
                    }
                }
            }
            .zIndex(1)
            let allPushedDrafts = !picked.isEmpty && picked.allSatisfy {
                if case .pushed = VtpDraftBody.status($0, service: service) { return true }
                return false
            }
            let canApproveOnly = !api && vtpDrafts.anyLoggedIn && allPushedDrafts
            if embedded {
                HStack(spacing: 10) {
                    // Phần 1 chưa "Đang chạy" hoặc chưa đăng nhập phần 2: nút mờ có ổ khoá, bấm vào thì mở phần 2 / báo cần đăng nhập.
                    let draftLocked = !client.vtpRunning || !vtpDrafts.anyLoggedIn
                    Button { pushDrafts(picked) } label: {
                        HStack(spacing: 6) {
                            Icon(name: draftLocked ? .lock : .arrowRight, size: 16, weight: 2.4, color: VtpDraftColors.brand)
                            T("Đẩy nháp VTP", btnFont, .bold, VtpDraftColors.brand).lineLimit(1).minimumScaleFactor(0.8)
                        }
                        .frame(maxWidth: .infinity)
                        .frame(height: btnH)
                        .background(RoundedRectangle(cornerRadius: btnH / 2, style: .continuous).strokeBorder(VtpDraftColors.brand, lineWidth: 1.5))
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(pick.isEmpty || sending)
                    .opacity(pick.isEmpty || sending ? 0.45 : (draftLocked ? 0.6 : 1))
                    if api || canApproveOnly {
                        PrimaryButton(title: sending ? (allPushedDrafts ? "Đang duyệt…" : "Đang tạo…") : busy ? "Đang tính cước…" : "Lên vận đơn",
                                      icon: .truck, fontSize: btnFont, height: btnH, enabled: !pick.isEmpty && !sending && !busy) {
                            create(picked)
                        }
                    } else {
                        PrimaryButton(title: "Xuất Excel", icon: .download, fontSize: btnFont, height: btnH, enabled: !pick.isEmpty) {
                            export(picked)
                        }
                    }
                }
            } else {
                HStack(spacing: 10) {
                    OutlineButton(title: "Huỷ", height: 52) { ui.dismissSheet() }
                        .frame(width: (Metrics.screenWidth - 50) / 3)
                    if api || canApproveOnly {
                        PrimaryButton(title: sending ? (allPushedDrafts ? "Đang duyệt \(pick.count) nháp…" : "Đang tạo \(pick.count) vận đơn…")
                                                     : busy ? "Đang tính cước…" : "Tạo \(pick.count) vận đơn",
                                      icon: .truck, fontSize: 15, enabled: !pick.isEmpty && !sending && !busy) {
                            create(list.filter { pick.contains($0.id) })
                        }
                    } else {
                        PrimaryButton(title: "Xuất Excel · \(pick.count) vận đơn", icon: .download, fontSize: 15, enabled: !pick.isEmpty) {
                            export(list.filter { pick.contains($0.id) })
                        }
                    }
                }
            }
            // Đã đăng nhập Viettel Post trên máy (đẩy nháp được) thì bỏ đường Excel cho đỡ chỗ; trừ khi chưa nối Phần 1.
            if (api && !(embedded && vtpDrafts.anyLoggedIn)) || canApproveOnly {
                Button { export(list.filter { pick.contains($0.id) }) } label: {
                    T("Hoặc xuất file Excel như cũ", 13, .bold, Theme.accent)
                }
                .buttonStyle(.plain)
                .disabled(pick.isEmpty || sending)
                .padding(.top, -4)
            }
        }
        .padding(.horizontal, Metrics.gutter)
        .padding(.top, compact ? 10 : 14)
        .padding(.bottom, compact ? 8 : 0)
        .background(Theme.card.overlay(alignment: .top) { HairLine() })
    }

    // MARK: Nháp Viettel Post của một khách

    /// Khung "NHÁP VIETTEL POST" trong Soát chi tiết: mã nháp, giờ đẩy, nháp cũ hay còn khớp, và các nút xử lý.
    private func draftBox(_ g: Vtp.Group) -> some View {
        let st = VtpDraftBody.status(g, service: service)
        let codes = VtpDraftBody.codes(g)
        let ship = g.orders.compactMap(\.ship).first { ($0.draftCode ?? "").isEmpty == false }
        let otherAccount: String? = {
            guard case .pushed = st, vtpDrafts.loggedInClients.count > 1,
                  let acc = ship?.draftAccount, !acc.isEmpty,
                  !vtpDrafts.current.owns(acc) else { return nil }
            return acc
        }()
        return detailBox("NHÁP VIETTEL POST") {
            switch st {
            case .notPushed:
                T("Chưa đẩy nháp. Bấm Đẩy nháp để đơn vào mục Đơn nháp trên viettelpost.vn (chưa gọi bưu tá).",
                  12.5, .medium, Theme.muted).fixedSize(horizontal: false, vertical: true)
            case .failed(let e):
                T("Lần đẩy trước lỗi: \(e)", 12.5, .semibold, Theme.red).fixedSize(horizontal: false, vertical: true)
            case .pushed, .stale:
                kv("Mã nháp", codes.joined(separator: ", "), strong: true)
                if let at = ship?.draftAt {
                    let d = Date(timeIntervalSince1970: at / 1000)
                    kv("Đẩy lúc", "\(timeText(d)) \(dayMonth(d))")
                }
                if let acc = ship?.draftAccount, !acc.isEmpty { kv("Tài khoản", acc) }
                if case .stale = st {
                    T("Nháp trên Viettel Post là bản cũ: đơn đã sửa hoặc thêm đơn sau khi đẩy. Đẩy lại để thay.",
                      12.5, .bold, Theme.gomInk).fixedSize(horizontal: false, vertical: true)
                } else if let otherAccount {
                    T("Nháp đang nằm ở \(otherAccount), khác tài khoản đang chọn (\(vtpDrafts.current.accountLabel)).",
                      12.5, .bold, Theme.gomInk).fixedSize(horizontal: false, vertical: true)
                } else {
                    T("✓ Khớp với đơn hiện tại", 12.5, .bold, Theme.green)
                }
            }
            HStack(spacing: 8) {
                switch st {
                case .pushed:
                    OutlineButton(title: "Xem trên VTP") { viewDraft(codes) }
                    OutlineButton(title: deletingDrafts ? "Đang xoá…" : "Xoá nháp", color: Theme.red) { deleteDrafts([g]) }
                case .stale:
                    OutlineButton(title: "Đẩy lại nháp", color: VtpDraftColors.brand) { pushDrafts([g]) }
                    OutlineButton(title: deletingDrafts ? "Đang xoá…" : "Xoá nháp", color: Theme.red) { deleteDrafts([g]) }
                default:
                    OutlineButton(title: "Đẩy nháp VTP", color: VtpDraftColors.brand) { pushDrafts([g]) }
                }
            }
            .disabled(g.isBad || deletingDrafts)
            if otherAccount != nil {
                OutlineButton(title: "Chuyển sang TK đang dùng", color: VtpDraftColors.brand) { pushDrafts([g]) }
                    .disabled(g.isBad || deletingDrafts)
            }
            if !codes.isEmpty {
                Button { clearDraftLabel(g) } label: {
                    T("Bỏ nhãn nháp (đã tự xoá trên web)", 12.5, .bold, Theme.muted)
                }
                .buttonStyle(.plain)
            }
        }
    }

    /// Sao chép mã nháp rồi mở viettelpost.vn để tìm trong mục Đơn nháp.
    private func viewDraft(_ codes: [String]) {
        UIPasteboard.general.string = codes.joined(separator: " ")
        ui.notify("Đã sao chép mã nháp. Trên viettelpost.vn mở Quản lý vận đơn › Đơn nháp rồi dán mã để tìm.")
        if let url = URL(string: "https://viettelpost.vn/") { UIApplication.shared.open(url) }
    }

    /// Xoá nháp trên Viettel Post (lệnh web chưa thử thật). Chỉ bỏ nhãn trong app khi Viettel Post báo xoá được.
    private func deleteDrafts(_ list: [Vtp.Group]) {
        guard !list.isEmpty, !deletingDrafts else { return }
        guard vtpDrafts.anyLoggedIn else {
            ui.push(.vtpDraft)
            ui.notify("Đăng nhập Viettel Post trên máy này (phần 2 · Đẩy nháp) rồi xoá nháp.")
            return
        }
        let count = list.reduce(0) { $0 + VtpDraftBody.codes($1).count }
        ui.confirm = ConfirmItem(title: "Xoá \(count) nháp trên Viettel Post?",
                                 message: "Nháp bị xoá khỏi mục Đơn nháp trên viettelpost.vn. Đơn trong app vẫn ở Chờ gửi.",
                                 action: "Xoá nháp") {
            deletingDrafts = true
            Task { @MainActor in
                var failed: [String] = []
                for g in list {
                    // Mỗi mã nháp xoá bằng đúng tài khoản đã đẩy mã đó.
                    let left = await vtpDrafts.deleteDrafts(of: g)
                    let name = g.summary.receiver.isEmpty ? g.customer.nickname : g.summary.receiver
                    failed += left.map { "\(name) (\($0.code)): \($0.reason)" }
                    if left.isEmpty { store.clearDraft(g.orders) }
                }
                deletingDrafts = false
                if failed.isEmpty {
                    ui.notify("Đã xoá nháp trên Viettel Post.")
                } else {
                    ui.notify("Chưa xoá được \(failed.count) nháp:\n" + failed.prefix(5).joined(separator: "\n"))
                }
            }
        }
    }

    /// Bỏ nhãn nháp trong app, không gọi Viettel Post (dùng khi đã tự xoá nháp trên web).
    private func clearDraftLabel(_ g: Vtp.Group) {
        ui.confirm = ConfirmItem(title: "Bỏ nhãn nháp?",
                                 message: "Chỉ bỏ nhãn trong app. Nếu nháp còn trên viettelpost.vn thì phải tự xoá ở đó.",
                                 action: "Bỏ nhãn") {
            store.clearDraft(g.orders)
        }
    }

    /// Đẩy các khách đã chọn vào mục Đơn nháp trên Viettel Post, từ máy này.
    /// Phần 2 cần phần 1 trước; chưa đăng nhập phần 2 thì hiện thông báo "Cần đăng nhập phần 2".
    private func pushDrafts(_ chosen: [Vtp.Group]) {
        guard !chosen.isEmpty else { return }
        // Máy chủ đã trả lời là phần 1 chưa "Đang chạy" (vtp nil = chưa hỏi xong, không chặn nhầm):
        // mở thẳng phần 2 đang khoá, ở đó ghi rõ cần làm gì ở phần 1.
        if client.vtp != nil && !client.vtpRunning {
            ui.dismissSheet()
            ui.push(.vtpDraft)
            return
        }
        // Tài khoản đang dùng chưa đăng nhập hoặc hết phiên mà có tài khoản khác còn phiên: dùng tài khoản đó.
        if !vtpDrafts.current.loggedIn || vtpDrafts.current.sessionExpired,
           let other = vtpDrafts.loggedInClients.first(where: { !$0.sessionExpired }) {
            vtpDrafts.select(other.accountId)
        }
        guard vtpDrafts.current.loggedIn, !vtpDrafts.current.sessionExpired else {
            let expired = vtpDrafts.current.sessionExpired
            let lead = expired
                ? "Phiên Viettel Post trên máy này đã hết. Đăng nhập lại ở Tôi › ViettelPost › phần 2 “Đẩy nháp” rồi đẩy nháp."
                : "Đẩy nháp cần đăng nhập Viettel Post trên máy này ở Tôi › ViettelPost › phần 2 “Đẩy nháp”."
            let tail = api ? "\n\nBạn vẫn có thể bấm “Lên vận đơn” ngay mà không cần đẩy nháp." : ""
            ui.confirm = ConfirmItem(title: expired ? "Cần đăng nhập lại phần 2" : "Cần đăng nhập phần 2",
                                     message: lead + tail,
                                     action: "Đăng nhập phần 2", cancel: "Để sau", destructive: false) {
                ui.dismissSheet()
                ui.push(.vtpDraft)
            }
            return
        }
        let svc = service
        ui.present(dim: 0.42) { VtpDraftPushSheet(groups: chosen, service: svc) }
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

    /// Lên vận đơn: khách đã đẩy nháp khớp đơn hiện tại thì duyệt thẳng nháp (giữ nguyên mã nháp đã in);
    /// khách chưa có nháp thì tạo vận đơn mới qua API đối tác (máy chủ ChốtLive).
    private func create(_ chosen: [Vtp.Group]) {
        guard !chosen.isEmpty, !sending else { return }
        let svc = service
        var draftGroups: [(index: Int, group: Vtp.Group, code: String)] = []
        var staleGroups: [(index: Int, group: Vtp.Group, code: String)] = []
        var apiGroups: [(index: Int, group: Vtp.Group)] = []
        for (i, g) in chosen.enumerated() {
            switch VtpDraftBody.status(g, service: svc) {
            case .pushed(let code, _):
                draftGroups.append((i, g, code))
            case .stale(let code):
                staleGroups.append((i, g, code))
            case .notPushed, .failed:
                apiGroups.append((i, g))
            }
        }
        if !apiGroups.isEmpty && client.vtp?.sender == nil {
            ui.dismissSheet()
            ui.push(.vtp)
            ui.notify("Chọn điểm lấy hàng trước khi tạo vận đơn mới.")
            return
        }
        sending = true
        let quoteFees: [String: Int] = Dictionary(uniqueKeysWithValues: chosen.map { g in
            let f = quote(g).flatMap { $0.ok ? $0.fee : nil } ?? 0
            return (g.id, f)
        })
        Task { @MainActor in
            await client.vtpFlush(store)
            var byIndex: [Int: VtpCreateResult] = [:]

            for item in staleGroups {
                let msg = "Nháp \(item.code) là bản cũ (đơn đã sửa, thêm món hoặc khác gói dịch vụ). Bấm “Đẩy nháp VTP” để cập nhật nháp, hoặc “Xoá nháp” rồi mới Lên vận đơn."
                store.applyVtpError(item.group.orders, error: msg)
                byIndex[item.index] = VtpCreateResult(key: item.group.id, ok: false, error: msg)
            }

            var draftBlocked = false
            let batchPrefix = "vtpd_" + String(Int64(Clock.now.timeIntervalSince1970 * 1000), radix: 36)
            for (offset, item) in draftGroups.enumerated() {
                if draftBlocked {
                    let msg = "Viettel Post đang giới hạn gửi liên tục từ máy này, thử lại sau."
                    byIndex[item.index] = VtpCreateResult(key: item.group.id, ok: false, error: msg)
                    continue
                }
                if offset > 0 { try? await Task.sleep(nanoseconds: 300_000_000) }
                let batch = "\(batchPrefix)_\(offset)"
                let res = await approveOneDraft(item.group, code: item.code, service: svc,
                                                  estimatedFee: quoteFees[item.group.id] ?? 0, batchId: batch)
                byIndex[item.index] = res.result
                if res.blocked { draftBlocked = true }
            }

            if !apiGroups.isEmpty {
                let r = await client.vtpCreate(service: svc, groups: apiGroups.map { VtpTrack.payload($0.group) })
                if let e = r.error {
                    if draftGroups.isEmpty && staleGroups.isEmpty {
                        sending = false
                        ui.notify(e)
                        return
                    }
                    for item in apiGroups {
                        byIndex[item.index] = VtpCreateResult(key: item.group.id, ok: false, error: e)
                    }
                } else {
                    for item in apiGroups {
                        if let res = r.results.first(where: { $0.key == item.group.id }) {
                            if res.ok && !res.code.isEmpty {
                                store.applyVtpCreated(item.group.orders, code: res.code, fee: res.fee, cod: res.cod,
                                                      goods: res.goods, service: svc)
                            } else if !res.ok {
                                store.applyVtpError(item.group.orders, error: res.error)
                            }
                            byIndex[item.index] = res
                        } else {
                            byIndex[item.index] = VtpCreateResult(key: item.group.id, ok: false, error: "Không nhận được phản hồi từ máy chủ")
                        }
                    }
                }
            }

            sending = false
            let ordered = chosen.indices.map { i in
                byIndex[i] ?? VtpCreateResult(key: chosen[i].id, ok: false, error: "Lỗi không rõ")
            }
            result = (chosen, ordered)
        }
    }

    /// Duyệt một nháp thành vận đơn giữ nguyên mã: ưu tiên dùng đúng phiên Phần 2 đã đẩy trên máy;
    /// nếu máy này không đăng nhập tài khoản đó mà Phần 1 kết nối đúng cùng tài khoản thì nhờ máy chủ duyệt qua API.
    private func approveOneDraft(_ g: Vtp.Group, code: String, service svc: String,
                                 estimatedFee: Int, batchId: String) async -> (result: VtpCreateResult, blocked: Bool) {
        let outcome = await vtpDrafts.approveDraft(of: g, code: code)
        switch outcome {
        case .approved(let approved):
            let fee = approved.fee > 0 ? approved.fee : estimatedFee
            store.applyVtpCreated(g.orders, code: approved.code, fee: fee, cod: g.summary.cod, goods: g.summary.goods,
                                  service: svc, fromDraft: true, batchId: batchId)
            var p = VtpTrack.payload(g)
            p["code"] = approved.code
            p["fee"] = fee
            p["batchId"] = batchId
            let adopt = await client.vtpAdoptDraft(service: svc, groups: [p])
            if adopt.status == 0 {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                _ = await client.vtpAdoptDraft(service: svc, groups: [p])
            }
            return (VtpCreateResult(key: g.id, ok: true, code: approved.code, fee: fee,
                                    cod: g.summary.cod, goods: g.summary.goods,
                                    already: false, fromDraft: true, error: ""), false)

        case .unavailable(let acc, let reason):
            if client.vtpConnected, let partnerPhone = client.vtp?.phone, !partnerPhone.isEmpty,
               acc.isEmpty || VtpDraftClient.phonesMatch(partnerPhone, acc) == true {
                var p = VtpTrack.payload(g)
                p["code"] = code
                p["fee"] = estimatedFee
                p["batchId"] = batchId
                let r = await client.vtpApproveDraft(service: svc, groups: [p])
                if r.status == 200, var first = r.results.first(where: { $0.key == g.id }) ?? r.results.first {
                    if first.ok && !first.code.isEmpty {
                        first.fromDraft = true
                        store.applyVtpCreated(g.orders, code: first.code, fee: first.fee, cod: first.cod,
                                              goods: first.goods, service: svc, fromDraft: true, batchId: batchId)
                    } else {
                        store.applyVtpError(g.orders, error: first.error)
                    }
                    return (first, false)
                }
                if r.status != 404, let e = r.error {
                    store.applyVtpError(g.orders, error: e)
                    return (VtpCreateResult(key: g.id, ok: false, error: e), false)
                }
            }
            store.applyVtpError(g.orders, error: reason)
            return (VtpCreateResult(key: g.id, ok: false, error: reason), false)

        case .failed(let msg, let blocked):
            store.applyVtpError(g.orders, error: msg)
            return (VtpCreateResult(key: g.id, ok: false, error: msg), blocked)
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
        let orders = chosen.flatMap(\.orders)
        let store = store, ui = ui
        ui.dismissSheet()
        // Đợi bảng dưới trượt xuống rồi mới mở bảng chia sẻ của iOS.
        // Chỉ chuyển đơn sang Đang giao khi file đã được lưu hoặc gửi đi; lỡ tay đóng bảng chia sẻ thì đơn vẫn ở Chờ gửi.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) {
            ShareFile.present(url) { done in
                Task { @MainActor in
                    if done {
                        store.markExported(orders, at: now)
                    } else {
                        ui.notify("Chưa lưu hay gửi file Excel nên các đơn vẫn ở Chờ gửi. Xuất lại khi cần.")
                    }
                }
            }
        }
    }
}

/// Bảng chia sẻ của iOS để lưu file vào Tệp hoặc gửi đi.
enum ShareFile {
    /// `completion(true)` khi người dùng đã lưu hoặc gửi file; `false` khi đóng bảng hoặc huỷ giữa chừng.
    static func present(_ url: URL, completion: @escaping (Bool) -> Void = { _ in }) {
        guard let root = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene })
            .flatMap(\.windows).first(where: \.isKeyWindow)?.rootViewController else { return completion(false) }
        var top = root
        while let next = top.presentedViewController { top = next }
        let vc = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        vc.popoverPresentationController?.sourceView = top.view
        var finished = false
        vc.completionWithItemsHandler = { [weak vc] _, completed, _, _ in
            DispatchQueue.main.async {
                guard !finished else { return }
                if completed {
                    finished = true
                    return completion(true)
                }
                // Huỷ giữa chừng trong một mục (Mail, Zalo...) thì bảng chia sẻ có thể vẫn mở để chọn mục khác:
                // chỉ báo chưa lưu khi bảng đã đóng hẳn.
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
                    guard !finished else { return }
                    if let vc, vc.viewIfLoaded?.window != nil { return }
                    finished = true
                    completion(false)
                }
            }
        }
        top.present(vc, animated: true)
    }
}
