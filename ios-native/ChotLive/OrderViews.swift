import SwiftUI

// MARK: - Đơn hàng

struct OrdersView: View {
    @EnvironmentObject var store: Store
    @EnvironmentObject var printer: PrinterManager
    @EnvironmentObject var ui: AppUI
    @State private var search = ""
    @State private var filter = 0 // 0 tất cả, 1 mới, 2 đã in, 3 đang giao, 4 đã giao
    @State private var dateFilter = DateFilter.make(.today)

    private var all: [Order] { store.orders(in: dateFilter) }

    private func matches(_ o: Order, _ tab: Int) -> Bool {
        switch tab {
        case 1: return o.status == .new
        case 2: return o.status == .printed
        case 3: return o.status == .shipping
        case 4: return o.status == .delivered
        default: return true
        }
    }

    private var list: [Order] {
        var l = all.filter { matches($0, filter) }
        let q = search.trimmingCharacters(in: .whitespaces).lowercased()
        if !q.isEmpty {
            l = l.filter { $0.customer.nickname.lowercased().contains(q) || $0.customer.uniqueId.lowercased().contains(q) }
        }
        return l
    }

    private var subtitle: String {
        let date = dateFilter.isSingleDay ? "\(weekdayLabel(dateFilter.startDay)) \(shortDate(dateFilter.startDay))" : dateFilter.pillLabel
        return "\(all.count) đơn \(dateFilter.scopeLabel) · \(date)"
    }

    var body: some View {
        ScrollView(showsIndicators: false) {
            VStack(spacing: Metrics.gap) {
                PageHeader(subtitle: subtitle, title: "Đơn hàng") {
                    HeaderAddButton(title: "Tạo đơn") { ui.push(.orderCreate) }
                }
                HStack(spacing: 8) {
                    SearchField(text: $search)
                    CircleButton(icon: .filter) {
                        ui.present(dim: 0.9) { DateFilterSheet(filter: dateFilter) { dateFilter = $0 } }
                    }
                }
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        statusChip("Tất cả", 0)
                        statusChip("Đơn mới", 1)
                        statusChip("Đã in", 2)
                        statusChip("Đang giao", 3)
                        statusChip("Đã giao", 4)
                    }
                    .padding(.horizontal, Metrics.gutter)
                }
                .padding(.horizontal, -Metrics.gutter)

                if list.isEmpty {
                    T("Chưa có đơn nào. Bấm “Chốt & in” trên một bình luận hoặc “Tạo đơn” để thêm đơn.", 13, .medium, Theme.muted)
                        .multilineTextAlignment(.center)
                        .padding(.top, 30)
                }
                LazyVStack(spacing: 11) {
                    ForEach(list) { o in card(o) }
                }
            }
            .padding(.horizontal, Metrics.gutter)
            .padding(.top, 6)
            .padding(.bottom, 16)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Theme.bg)
    }

    private func statusChip(_ title: String, _ tab: Int) -> some View {
        Chip(title: "\(title) · \(all.filter { matches($0, tab) }.count)", selected: filter == tab) { filter = tab }
    }

    private func card(_ o: Order) -> some View {
        VStack(spacing: 15) {
            HStack(spacing: 12) {
                Avatar(text: o.customer.initials, size: 40, fontSize: 14, seed: o.customer.id)
                VStack(spacing: 2) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        T(o.customer.nickname, 15, .bold).lineLimit(1)
                        Spacer(minLength: 0)
                        T(money(o.total), 17, .heavy, Theme.ink, track: -0.4).lineLimit(1).fixedSize()
                    }
                    HStack(spacing: 6) {
                        T("@\(o.customer.uniqueId) · \(o.productCount) sản phẩm · \(timeText(o.lastTs))", 12, .medium, Theme.muted)
                            .lineLimit(1)
                            .minimumScaleFactor(0.85)
                        Spacer(minLength: 0)
                        StatusBadge(status: o.status)
                    }
                }
            }
            .contentShape(Rectangle())
            .onTapGesture { ui.push(.order(o.id)) }

            HStack(spacing: 8) {
                OutlineButton(title: "In đơn", icon: .printer, filled: !o.isPrinted) {
                    ui.notify(printOrder(o, store: store, printer: printer))
                }
                OutlineButton(title: deliveryLabel(o), icon: .truck, color: o.status == .delivered ? Theme.green : Theme.ink) {
                    store.advanceDelivery(o)
                }
                Button {
                    ui.present { OrderActionSheet(orderId: o.id) }
                } label: {
                    Icon(name: .more, size: 20, weight: 2.6)
                        .frame(width: 44, height: 44)
                        .background(Circle().fill(Theme.card).overlay(Circle().strokeBorder(Theme.line, lineWidth: 1)))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 15)
        .padding(.top, 15)
        .padding(.bottom, 14)
        .cardStyle(20)
    }
}

func deliveryLabel(_ o: Order) -> String {
    switch o.status {
    case .new, .printed: return "Giao hàng"
    case .shipping: return "Đang giao"
    case .delivered: return "Đã giao"
    }
}

func confirmDelete(_ o: Order, store: Store, ui: AppUI, then: @escaping () -> Void = {}) {
    ui.confirm = ConfirmItem(title: "Xoá đơn của \(o.customer.nickname)?",
                             message: "Không thể khôi phục sau khi xoá.", action: "Xoá đơn") {
        store.deleteOrder(o)
        then()
    }
}

// MARK: - Sheet thao tác đơn

struct OrderActionSheet: View {
    let orderId: String
    @EnvironmentObject var store: Store
    @EnvironmentObject var ui: AppUI

    var body: some View {
        VStack(spacing: 0) {
            if let o = store.order(id: orderId) {
                HStack(spacing: 12) {
                    Avatar(text: o.customer.initials, size: 40, fontSize: 14, seed: o.customer.id)
                    VStack(alignment: .leading, spacing: 2) {
                        T(o.customer.nickname, 16, .bold).lineLimit(1)
                        T("\(o.productCount) sản phẩm · \(timeText(o.lastTs))", 12, .medium, Theme.muted)
                    }
                    Spacer(minLength: 4)
                    T(money(o.total), 17, .heavy, Theme.ink, track: -0.4).lineLimit(1).fixedSize()
                }
                .padding(.horizontal, 4)
                .padding(.top, 8)
                .padding(.bottom, 12)
                HairLine().padding(.bottom, 4)

                row(.cart, Theme.accent, Theme.peachSoft, "Sản phẩm (\(o.productCount))", Theme.ink, "Xem và sửa sản phẩm trong đơn") {
                    ui.dismissSheet()
                    ui.push(.order(o.id))
                }
                HairLine()
                row(.message, Theme.accent, Theme.peachSoft, "Bình luận", Theme.ink, "Xem các comment khách đã chốt đơn") {
                    ui.dismissSheet()
                    ui.push(.orderComments(o.id))
                }
                HairLine()
                row(.trash, Theme.red, Theme.redSoft, "Xoá đơn", Theme.red, "Không thể khôi phục sau khi xoá") {
                    ui.dismissSheet()
                    confirmDelete(o, store: store, ui: ui)
                }
            }
            Button { ui.dismissSheet() } label: {
                T("Đóng", 15, .bold)
                    .frame(maxWidth: .infinity)
                    .frame(height: 52)
                    .background(Capsule().fill(Theme.field))
            }
            .buttonStyle(.plain)
            .padding(.top, 14)
        }
        .padding(.horizontal, Metrics.gutter)
    }

    private func row(_ icon: IconName, _ tint: Color, _ fill: Color, _ title: String, _ titleColor: Color,
                     _ subtitle: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Icon(name: icon, size: 19, color: tint)
                    .frame(width: 40, height: 40)
                    .background(Circle().fill(fill))
                VStack(alignment: .leading, spacing: 3) {
                    T(title, 15, .bold, titleColor)
                    T(subtitle, 12, .medium, Theme.muted).lineLimit(1)
                }
                Spacer(minLength: 4)
                Icon(name: .chevronRight, size: 16, color: Theme.muted)
            }
            .padding(.horizontal, 4)
            .frame(height: 63)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Chi tiết đơn hàng

struct OrderDetailView: View {
    let orderId: String
    @EnvironmentObject var store: Store
    @EnvironmentObject var printer: PrinterManager
    @EnvironmentObject var ui: AppUI

    var body: some View {
        let order = store.order(id: orderId)
        SubPage(title: "Chi tiết đơn hàng", trailing: {
            if let o = order { StatusBadge(status: o.status, fontSize: 12, height: 25) }
        }) {
            if let o = order {
                ScrollView(showsIndicators: false) {
                    VStack(spacing: Metrics.gap) {
                        customerCard(o)
                        productsCard(o)
                    }
                    .padding(.horizontal, Metrics.gutter)
                    .padding(.bottom, 12)
                }
                actions(o)
            } else {
                Spacer()
                T("Đơn không còn tồn tại", 14, .medium, Theme.muted)
                Spacer()
            }
        }
    }

    private func customerCard(_ o: Order) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Button { ui.push(.customer(o.customer.id)) } label: {
                HStack(spacing: 12) {
                    Avatar(text: o.customer.initials, size: 52, fontSize: 18, seed: o.customer.id)
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 10) {
                            T(o.customer.nickname, 17, .bold).lineLimit(1).minimumScaleFactor(0.8)
                            if o.customer.isBigSpender { Badge(text: "Mua nhiều") }
                        }
                        T("@\(o.customer.uniqueId) · \(store.orders(of: o.customer).count) đơn", 13, .medium, Theme.muted).lineLimit(1)
                    }
                    Spacer(minLength: 0)
                    Icon(name: .chevronRight, size: 16, color: Theme.muted)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            HairLine()
            HStack(spacing: 8) {
                Icon(name: .calendar, size: 15, color: Theme.muted)
                T("Tạo lúc \(timeText(o.firstTs)) · \(weekdayLabel(o.firstTs)) \(fullDate(o.firstTs))", 13, .medium, Theme.muted)
                    .lineLimit(1).minimumScaleFactor(0.85)
            }
        }
        .padding(.horizontal, 15)
        .padding(.vertical, 14)
        .cardStyle(20)
    }

    private func productsCard(_ o: Order) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            T("Sản phẩm (\(o.productCount))", 14, .bold).padding(.bottom, 8)
            ForEach(Array(o.items.enumerated()), id: \.element.id) { index, it in
                if index > 0 { HairLine() }
                HStack(spacing: 11) {
                    T("\(index + 1)", 11, .bold, Theme.muted)
                        .frame(width: 22, height: 22)
                        .background(Circle().fill(Theme.field))
                    T("Mã \(it.comment)", 14, .bold).lineLimit(1)
                    T("\(it.qty) × \(money(it.price))", 12, .medium, Theme.muted).lineLimit(1).minimumScaleFactor(0.8)
                    Spacer(minLength: 4)
                    T(money(it.lineTotal), 14, .bold).lineLimit(1).fixedSize()
                }
                .frame(height: 42)
            }
            HStack {
                T("Tổng tiền", 14, .semibold)
                Spacer()
                T(money(o.total), 18, .heavy, Theme.ink, track: -0.4).lineLimit(1)
            }
            .padding(.horizontal, 14)
            .frame(height: 44)
            .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Theme.peachSoft))
            .padding(.top, 10)
        }
        .padding(.horizontal, 15)
        .padding(.top, 14)
        .padding(.bottom, 15)
        .cardStyle(20)
    }

    private func actions(_ o: Order) -> some View {
        VStack(spacing: 8) {
            PrimaryButton(title: "Chỉnh sửa đơn", icon: .pencil, fontSize: 15) { ui.push(.orderEdit(o.id)) }
            HStack(spacing: 8) {
                OutlineButton(title: deliveryLabel(o), icon: .truck, color: o.status == .delivered ? Theme.green : Theme.ink, height: 48) {
                    store.advanceDelivery(o)
                }
                OutlineButton(title: "In đơn", icon: .printer, height: 48) {
                    ui.notify(printOrder(o, store: store, printer: printer))
                }
                OutlineButton(title: "Xoá đơn", icon: .trash, color: Theme.red, height: 48) {
                    confirmDelete(o, store: store, ui: ui) { ui.pop() }
                }
            }
        }
        .padding(.horizontal, Metrics.gutter)
        .padding(.top, 4)
        .padding(.bottom, 10)
    }
}

// MARK: - Bình luận của đơn

struct OrderCommentsView: View {
    let orderId: String
    @EnvironmentObject var store: Store

    var body: some View {
        SubPage(title: "Bình luận chốt đơn") {
            ScrollView(showsIndicators: false) {
                VStack(spacing: 8.5) {
                    if let o = store.order(id: orderId) {
                        ForEach(o.items) { it in
                            HStack(alignment: .top, spacing: 12) {
                                Avatar(text: o.customer.initials, size: 40, fontSize: 14, seed: o.customer.id)
                                VStack(alignment: .leading, spacing: 3) {
                                    HStack(spacing: 6) {
                                        T(o.customer.nickname, 14, .bold).lineLimit(1)
                                        T(timeText(it.ts), 11, .medium, Theme.muted)
                                    }
                                    T(it.comment, 14, .medium)
                                }
                                Spacer(minLength: 4)
                                T(money(it.price), 14, .heavy).lineLimit(1).fixedSize()
                            }
                            .padding(13)
                            .cardStyle(18)
                        }
                    }
                }
                .padding(.horizontal, Metrics.gutter)
                .padding(.bottom, 16)
            }
        }
    }
}

// MARK: - Sửa / tạo đơn

/// Một dòng sản phẩm trong màn sửa đơn.
struct ItemEditor: View {
    @Binding var item: OrderItem
    let onDelete: () -> Void
    @State private var priceText = ""

    var body: some View {
        VStack(spacing: 12) {
            HStack(spacing: 8) {
                VStack(alignment: .leading, spacing: 6) {
                    T("Mã sản phẩm", 12, .medium, Theme.muted)
                    TextField("150", text: $item.comment)
                        .font(.bv(15, .semibold))
                        .padding(.horizontal, 13)
                        .frame(height: 44)
                        .cardStyle(14, fill: Theme.field)
                }
                VStack(alignment: .leading, spacing: 6) {
                    T("Đơn giá (₫)", 12, .medium, Theme.muted)
                    TextField("150000", text: $priceText)
                        .keyboardType(.numberPad)
                        .font(.bv(15, .semibold))
                        .padding(.horizontal, 13)
                        .frame(height: 44)
                        .cardStyle(14, fill: Theme.field)
                        .onChange(of: priceText) { value in
                            item.price = Int(value.filter(\.isNumber)) ?? 0
                        }
                }
            }
            HStack(spacing: 10) {
                T("Số lượng", 13, .medium, Theme.muted)
                Button { item.qty = max(item.qty - 1, 1) } label: {
                    Icon(name: .chevronDown, size: 16).frame(width: 34, height: 34).background(Circle().fill(Theme.field))
                }
                .buttonStyle(.plain)
                T("\(item.qty)", 15, .bold).frame(minWidth: 20)
                Button { item.qty += 1 } label: {
                    Icon(name: .plus, size: 16).frame(width: 34, height: 34).background(Circle().fill(Theme.field))
                }
                .buttonStyle(.plain)
                Spacer()
                Button(action: onDelete) {
                    Icon(name: .trash, size: 17, color: Theme.red)
                        .frame(width: 34, height: 34)
                        .background(Circle().fill(Theme.redSoft))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(14)
        .cardStyle(18)
        .onAppear { if priceText.isEmpty && item.price > 0 { priceText = String(item.price) } }
    }
}

struct OrderEditView: View {
    let orderId: String
    @EnvironmentObject var store: Store
    @EnvironmentObject var ui: AppUI
    @State private var items: [OrderItem] = []
    @State private var loaded = false

    private var order: Order? { store.order(id: orderId) }

    var body: some View {
        SubPage(title: "Chỉnh sửa đơn") {
            ScrollView(showsIndicators: false) {
                VStack(spacing: 10) {
                    ForEach($items) { $it in
                        ItemEditor(item: $it) { items.removeAll { $0.id == it.id } }
                    }
                    OutlineButton(title: "Thêm sản phẩm", icon: .plus, height: 48) {
                        let template = order?.items.last
                        items.append(OrderItem(id: UUID().uuidString, comment: "", price: 0, ts: template?.ts ?? Clock.now,
                                               sessionId: template?.sessionId, groupId: template?.groupId))
                    }
                }
                .padding(.horizontal, Metrics.gutter)
                .padding(.bottom, 12)
            }
            .scrollDismissesKeyboard(.interactively)
            PrimaryButton(title: items.isEmpty ? "Lưu (đơn sẽ bị xoá)" : "Lưu đơn · \(money(items.reduce(0) { $0 + $1.lineTotal }))") {
                if let o = order { store.updateOrder(o, items: items) }
                ui.pop()
            }
            .padding(.horizontal, Metrics.gutter)
            .padding(.vertical, 12)
        }
        .onAppear {
            guard !loaded else { return }
            loaded = true
            items = order?.items ?? []
        }
    }
}

struct OrderCreateView: View {
    @EnvironmentObject var store: Store
    @EnvironmentObject var ui: AppUI
    @State private var nickname = ""
    @State private var handle = ""
    @State private var items = [OrderItem(id: UUID().uuidString, comment: "", price: 0, ts: Clock.now)]

    private var canSave: Bool {
        !items.isEmpty && !(nickname.trimmingCharacters(in: .whitespaces).isEmpty && handle.trimmingCharacters(in: .whitespaces).isEmpty)
    }

    var body: some View {
        SubPage(title: "Tạo đơn") {
            ScrollView(showsIndicators: false) {
                VStack(spacing: 10) {
                    VStack(spacing: 14) {
                        LabeledField(label: "Tên khách", placeholder: "Linh Nguyễn", text: $nickname)
                        LabeledField(label: "Tài khoản TikTok", placeholder: "@linh.nguyen98", text: $handle, capitalize: false)
                    }
                    .padding(14)
                    .cardStyle(18)
                    ForEach($items) { $it in
                        ItemEditor(item: $it) { items.removeAll { $0.id == it.id } }
                    }
                    OutlineButton(title: "Thêm sản phẩm", icon: .plus, height: 48) {
                        items.append(OrderItem(id: UUID().uuidString, comment: "", price: 0, ts: Clock.now))
                    }
                }
                .padding(.horizontal, Metrics.gutter)
                .padding(.bottom, 12)
            }
            .scrollDismissesKeyboard(.interactively)
            PrimaryButton(title: "Tạo đơn · \(money(items.reduce(0) { $0 + $1.lineTotal }))", enabled: canSave) {
                let id = store.createOrder(nickname: nickname, uniqueId: handle, items: items)
                ui.pop()
                ui.push(.order(id))
            }
            .padding(.horizontal, Metrics.gutter)
            .padding(.vertical, 12)
        }
    }
}
