import SwiftUI

// MARK: - Đơn hàng

struct OrdersView: View {
    @EnvironmentObject var store: Store
    @EnvironmentObject var client: LiveClient
    @EnvironmentObject var printer: PrinterManager
    @EnvironmentObject var ui: AppUI
    @State private var search = ""
    /// 0 tất cả (mọi ngày), 1 đơn mới, 2 chờ gửi, 3 gom sau, 4 đang giao (theo ngày đang chọn)
    @State private var filter = 0
    @State private var dateFilter = DateFilter.make(.today)

    private func matches(_ o: Order, _ tab: Int) -> Bool {
        switch tab {
        case 1: return Vtp.state(o) == .ask
        case 2: return Vtp.state(o) == .ready
        case 3: return Vtp.state(o) == .hold
        case 4: return o.status == .shipping
        default: return true
        }
    }

    var body: some View {
        let every = store.allOrders()
        let scoped = every.filter { dateFilter.contains($0.lastTs) }
        let groups = Vtp.readyGroups(every)
        let shown = list(every: every, scoped: scoped)
        GeometryReader { geo in
            ScrollView(showsIndicators: false) {
                VStack(spacing: Metrics.gap) {
                    PageHeader(subtitle: filter == 0 ? "\(every.count) đơn · mọi ngày" : "\(scoped.count) đơn · \(dateFilter.pillLabel)",
                               title: "Đơn hàng") {
                        HeaderAddButton(title: "Tạo đơn") { ui.push(.orderCreate) }
                    }
                    HStack(spacing: 8) {
                        SearchField(text: $search, placeholder: client.vtpConnected ? "Tìm tên, @tiktok, mã vận đơn" : "Tìm tên hoặc @tiktok")
                        CircleButton(icon: .filter) {
                            ui.present(dim: 0.9) { DateFilterSheet(filter: dateFilter) { dateFilter = $0 } }
                        }
                    }
                    // Cả 5 tab nằm gọn một hàng, không phải kéo ngang. Hàng chip cuộn ngang cũ (lề âm)
                    // làm trang rộng hơn màn hình nên kéo qua lại bị lộ khoảng trắng.
                    HStack(spacing: 4) {
                        StatusTab(title: "Tất cả", count: VtpTrack.oneCardPerWaybill(every).count, selected: filter == 0) { filter = 0 }
                        statusTab("Đơn mới", 1, scoped)
                        statusTab("Chờ gửi", 2, scoped)
                        statusTab("Gom sau", 3, scoped)
                        statusTab("Đang giao", 4, scoped)
                    }
                    .padding(4)
                    .cardStyle(18)

                    if !groups.isEmpty {
                        ReadyExportBanner(groups: groups, connected: client.vtpConnected) {
                            ui.present(dim: 0.42) { VtpExportSheet() }
                        }
                    }

                    if filter == 4 {
                        let attention = shown.filter(VtpTrack.needsAction)
                        if !attention.isEmpty { VtpAttentionBanner(orders: attention) }
                    }

                    if shown.isEmpty {
                        T("Chưa có đơn nào. Bấm nút in trên một bình luận hoặc “Tạo đơn” để thêm đơn.", 13, .medium, Theme.muted)
                            .multilineTextAlignment(.center)
                            .padding(.top, 30)
                    }
                    LazyVStack(spacing: 11) {
                        ForEach(shown) { o in card(o, every: every) }
                    }
                }
                .padding(.horizontal, Metrics.gutter)
                .padding(.top, 2)
                .padding(.bottom, 16)
                // Khoá đúng bề ngang màn hình: thẻ đơn nào lỡ rộng hơn (thẻ chỉ dựng khi cuộn tới) cũng không
                // làm trang rộng ra rồi kéo ngang được, lộ khoảng trắng hai bên.
                .frame(width: geo.size.width)
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .background(Theme.bg)
    }

    /// Tab Tất cả: đơn mọi ngày, tìm cả đơn ngày cũ. Các tab khác: theo ngày đang chọn.
    private func list(every: [Order], scoped: [Order]) -> [Order] {
        var l = (filter == 0 ? every : scoped).filter { matches($0, filter) }
        let q = search.trimmingCharacters(in: .whitespaces).lowercased()
        if !q.isEmpty {
            l = l.filter {
                $0.customer.matchesName(q)
                    || ($0.code ?? "").lowercased().contains(q) || ($0.customer.address?.phone ?? "").contains(q)
                    || ($0.ship?.vtpCode ?? "").lowercased().contains(q.replacingOccurrences(of: " ", with: ""))
            }
        }
        if filter == 4 {
            // Đơn Viettel Post báo giao hỏng / hoàn lên đầu.
            l.sort { a, b in
                let x = VtpTrack.needsAction(a), y = VtpTrack.needsAction(b)
                return x != y ? x : a.lastTs > b.lastTs
            }
        }
        // Nhiều đơn của khách gộp chung một vận đơn: một thẻ, tiền là tiền thu hộ của vận đơn.
        return VtpTrack.oneCardPerWaybill(l)
    }

    private func statusTab(_ title: String, _ tab: Int, _ scoped: [Order]) -> some View {
        StatusTab(title: title, count: VtpTrack.oneCardPerWaybill(scoped.filter { matches($0, tab) }).count,
                  selected: filter == tab) { filter = tab }
    }

    private func openReview(_ o: Order) {
        ui.present(dim: 0.42) { ShipReviewSheet(orderId: o.id) }
    }

    private func card(_ o: Order, every: [Order]) -> some View {
        let st = Vtp.state(o)
        let older = st.isPending ? Vtp.olderPending(o, in: every) : []
        let hasOldGom = st == .ask && !older.isEmpty
        let day = Clock.isToday(o.lastTs) ? "" : " · \(dayMonth(o.lastTs))"
        // Đã có vận đơn: tiền trên thẻ là tiền Viettel Post thu hộ (gồm COD nhập tay, cọc, các đơn gộp chung).
        let mates = VtpTrack.sameWaybill(o, in: every)
        let hasWaybill = VtpTrack.code(o) != nil
        let amount = hasWaybill ? VtpTrack.waybillCod(mates) : o.total
        let products = mates.reduce(0) { $0 + $1.productCount }
        let merged = mates.count > 1 ? " · gộp \(mates.count) đơn" : ""
        return VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                Avatar(text: o.customer.initials, size: 40, fontSize: 14, seed: o.customer.id)
                    .offset(y: 1)
                VStack(spacing: 2) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        T(o.customer.displayName, 15, .bold).lineLimit(1).offset(y: 2)
                        Spacer(minLength: 0)
                        T(money(amount), 17, .heavy, Theme.ink, track: -0.4).lineLimit(1).fixedSize()
                    }
                    HStack(spacing: 6) {
                        T("@\(o.customer.uniqueId) · \(products) sản phẩm\(merged) · \(timeText(o.lastTs))\(day)", 12, .medium, Theme.muted)
                            .lineLimit(1)
                            .minimumScaleFactor(0.8)
                            .offset(y: 1)
                        Spacer(minLength: 0)
                        if st == .ask { Badge(text: "Đơn mới").offset(y: 2) }
                        if hasWaybill { T("thu hộ", 11.5, .semibold, Theme.muted).fixedSize().offset(y: 1) }
                    }
                }
            }
            .contentShape(Rectangle())
            .onTapGesture { ui.push(.order(o.id)) }

            if !older.isEmpty && !Vtp.alreadyMerged(o, with: older) {
                // Bấm để thêm đơn này vào đơn đã gom trước đó: bảng Duyệt đơn tick sẵn mọi đơn chưa gửi của khách.
                Button { openReview(o) } label: {
                    tag(hasOldGom ? "Có \(older.count) đơn gom từ \(dayMonth(older[0].lastTs)) · bấm để gộp"
                                  : "Còn \(older.count) đơn cũ từ \(dayMonth(older[0].lastTs)) · bấm để gộp",
                        Theme.gomInk, Theme.gomTag)
                }
                .buttonStyle(.plain)
            } else if !older.isEmpty {
                tag("Gửi chung với \(older.count) đơn từ \(dayMonth(older[0].lastTs))", Theme.accent, Theme.peachSoft)
            } else if st == .hold {
                tag("Khách hẹn gom sau", Theme.gomInk, Theme.gomTag)
            } else if st == .ready {
                tag("Sẵn sàng gửi", Theme.accent, Theme.peachSoft)
            }
            if let code = VtpTrack.code(o) {
                vtpTag(o, code)
            } else if let e = VtpTrack.lastError(o) {
                HStack(spacing: 8) {
                    tag("Lỗi tạo vận đơn: \(e)", Theme.red, Theme.redSoft)
                    Button { ui.push(.addressEdit(o.customer.id)) } label: { T("Sửa", 12.5, .bold, Theme.accent) }
                        .buttonStyle(.plain)
                }
            } else if let old = VtpTrack.cancelledCode(o) {
                tag("Vận đơn \(VtpTrack.pretty(old)) đã huỷ · gửi lại", Theme.red, Theme.redSoft)
            }

            HStack(spacing: 8) {
                if let code = VtpTrack.code(o) {
                    OutlineButton(title: "In tem", icon: .printer, filled: true) {
                        VtpActions.printLabels([code], client: client, ui: ui)
                    }
                    OutlineButton(title: "Theo dõi", icon: .truck) { ui.push(.order(o.id)) }
                } else {
                    OutlineButton(title: o.isPrinted ? "In lại" : "In đơn", icon: .printer, filled: !o.isPrinted) {
                        Task { @MainActor in
                            ui.notify(await printOrder(o, store: store, printer: printer))
                        }
                    }
                    OutlineButton(title: shipButtonLabel(o), icon: st == .ask ? .check : .truck, color: shipButtonColor(o)) {
                        openReview(o)
                    }
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
            .padding(.top, 3)
        }
        .padding(.horizontal, 15)
        .padding(.top, 15)
        .padding(.bottom, 14)
        .cardStyle(20, fill: hasOldGom ? Theme.gomFill : Theme.card, border: hasOldGom ? Theme.gomLine : Theme.line)
    }

    private func tag(_ text: String, _ color: Color, _ fill: Color) -> some View {
        T(text, 12, .semibold, color)
            .lineLimit(1)
            .minimumScaleFactor(0.85)
            .padding(.horizontal, 10)
            .frame(height: 24)
            .background(Capsule().fill(fill))
    }

    /// Mã vận đơn + trạng thái Viettel Post trên thẻ đơn; đỏ khi cần xử lý.
    private func vtpTag(_ o: Order, _ code: String) -> some View {
        let bad = VtpTrack.needsAction(o)
        let done = o.status == .delivered
        let ink = bad ? Theme.red : (done ? Theme.green : Theme.accent)
        return HStack(spacing: 6) {
            T(VtpTrack.pretty(code), 12, .heavy, Theme.ink).lineLimit(1).fixedSize()
            T("·", 12, .bold, Theme.muted)
            T(VtpTrack.statusName(o), 12, .semibold, ink).lineLimit(1).minimumScaleFactor(0.8)
        }
        .padding(.horizontal, 10)
        .frame(height: 24)
        .background(Capsule().fill(bad ? Theme.redSoft : (done ? Theme.greenSoft : Theme.peachSoft)))
    }
}

/// Một ô trong hàng tab trạng thái đơn: số đơn to ở trên, tên tab nhỏ ở dưới, chia đều chiều ngang.
private struct StatusTab: View {
    let title: String
    let count: Int
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 1) {
                T("\(count)", 16, .heavy, selected ? Theme.ink : (count > 0 ? Theme.ink : Theme.muted))
                    .lineLimit(1)
                T(title, 11.5, selected ? .bold : .semibold, selected ? Theme.ink : Theme.muted)
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
            }
            .padding(.horizontal, 2)
            .frame(maxWidth: .infinity)
            .frame(height: 48)
            .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(selected ? Theme.orange : Color.clear))
            .onAccent(selected)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

@MainActor
func confirmDelete(_ o: Order, store: Store, ui: AppUI, then: @escaping () -> Void = {}) {
    // Vận đơn còn hiệu lực mà xoá đơn thì bưu tá vẫn tới lấy hàng, app lại không còn gì để theo dõi.
    if let code = VtpTrack.code(o), o.status != .delivered {
        ui.notify("Đơn đang có vận đơn \(VtpTrack.pretty(code)). Huỷ vận đơn ở chi tiết đơn trước rồi mới xoá đơn.")
        return
    }
    ui.confirm = ConfirmItem(title: "Xoá đơn của \(o.customer.displayName)?",
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
                        T(o.customer.displayName, 16, .bold).lineLimit(1)
                        T("\(o.productCount) sản phẩm · \(timeText(o.lastTs))", 12, .medium, Theme.muted)
                    }
                    Spacer(minLength: 4)
                    T(money(o.total), 17, .heavy, Theme.ink, track: -0.4).lineLimit(1).fixedSize()
                }
                .padding(.horizontal, 4)
                .padding(.top, 8)
                .padding(.bottom, 12)
                HairLine().padding(.bottom, 12)

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
                Icon(name: icon, size: 17, weight: 2.3, color: tint)
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

/// Ô tổng khi tiền thu hộ đã sửa tay ở nháp: dòng nhỏ tiền hàng gốc, ô viền to là số shipper sẽ thu.
private struct EditedCodTotal: View {
    let goodsLabel: String
    let goods: Int
    let codLabel: String
    let cod: Int
    let fill: Color
    let ring: Color
    let tagColor: Color

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                T(goodsLabel, 13, .semibold, Theme.muted)
                Spacer()
                T(money(goods), 13, .semibold, Theme.muted).lineLimit(1)
            }
            .padding(.horizontal, 14)
            .padding(.top, 9)
            HStack {
                VStack(alignment: .leading, spacing: 1) {
                    T(codLabel, 14, .semibold).lineLimit(1)
                    HStack(spacing: 3) {
                        Icon(name: .pencil, size: 10, weight: 2.4, color: tagColor)
                        T("Đã sửa ở nháp", 11, .semibold, tagColor)
                    }
                }
                Spacer()
                T(money(cod), 18, .heavy, Theme.ink, track: -0.4).lineLimit(1)
            }
            .padding(.horizontal, 14)
            .frame(height: 50)
            .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(fill))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(ring, lineWidth: 2))
            .padding(.top, 7)
        }
    }
}

/// Một dòng sản phẩm ở chi tiết đơn, kèm đơn chứa nó (vận đơn gộp nhiều đơn).
private struct ProductRow: Identifiable {
    let order: Order
    let index: Int
    let item: OrderItem
    var id: String { item.id }
}

struct OrderDetailView: View {
    let orderId: String
    @EnvironmentObject var store: Store
    @EnvironmentObject var printer: PrinterManager
    @EnvironmentObject var ui: AppUI

    var body: some View {
        let order = store.order(id: orderId)
        SubPage(title: "Chi tiết đơn hàng", trailing: {
            if let o = order { ShipBadge(order: o) }
        }) {
            if let o = order {
                ScrollView(showsIndicators: false) {
                    let others = Vtp.state(o).isPending
                        ? Vtp.pendingOrders(of: o.customer.id, in: store.allOrders()).filter { $0.id != o.id } : []
                    VStack(spacing: Metrics.gap) {
                        customerCard(o)
                        // Đơn còn gom chung với đơn khác: số thu hộ sửa tay là của cả nhóm, hiện ở thẻ gom.
                        productsCard(o, showCod: VtpTrack.code(o) != nil || others.isEmpty)
                        VtpOrderBox(order: o)
                        if !others.isEmpty { gomCard(o, others) }
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
                            T(o.customer.displayName, 17, .bold).lineLimit(1).minimumScaleFactor(0.8)
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

    /// Đơn chung một vận đơn với đơn khác: hiện đủ sản phẩm của cả vận đơn, chia theo từng đơn.
    /// Tiền thu hộ sửa tay ở nháp (khác tiền hàng) thì ô to hiện số thu hộ đó, tiền hàng lùi xuống dòng nhỏ phía trên.
    private func productsCard(_ o: Order, showCod: Bool) -> some View {
        let mates = VtpTrack.sameWaybill(o, in: store.allOrders())
        let goods = mates.reduce(0) { $0 + $1.total }
        let cod = showCod ? VtpTrack.editedCod(mates).flatMap { $0 == goods ? nil : $0 } : nil
        var rows: [ProductRow] = []
        for m in mates { for it in m.items { rows.append(ProductRow(order: m, index: rows.count + 1, item: it)) } }
        return VStack(alignment: .leading, spacing: 0) {
            T(mates.count > 1 ? "Sản phẩm (\(mates.reduce(0) { $0 + $1.productCount })) · gộp \(mates.count) đơn"
                              : "Sản phẩm (\(o.productCount))", 14, .bold).padding(.bottom, 3)
            ForEach(rows) { r in
                if mates.count > 1, r.order.items.first?.id == r.item.id {
                    HStack(spacing: 6) {
                        T("Đơn \(dayMonth(r.order.lastTs)) · \(timeText(r.order.lastTs))", 12, .bold,
                          r.order.id == o.id ? Theme.accent : Theme.muted).lineLimit(1)
                        if r.order.id == o.id { T("· đơn đang xem", 12, .medium, Theme.muted).lineLimit(1) }
                        Spacer(minLength: 4)
                        T(money(r.order.total), 12, .bold, Theme.muted).lineLimit(1).fixedSize()
                    }
                    .padding(.top, r.index > 1 ? 10 : 4)
                    .padding(.bottom, 2)
                } else if r.index > 1 {
                    HairLine()
                }
                HStack(spacing: 11) {
                    T("\(r.index)", 11, .bold, Theme.muted)
                        .frame(width: 22, height: 22)
                        .background(Circle().fill(Theme.field))
                    T(r.item.productLabel, 14, .bold).lineLimit(1)
                    T("\(r.item.qty) × \(money(r.item.price))", 12, .medium, Theme.muted).lineLimit(1).minimumScaleFactor(0.8)
                    Spacer(minLength: 4)
                    T(money(r.item.lineTotal), 14, .bold).lineLimit(1).fixedSize()
                }
                .frame(height: 42)
            }
            if let cod {
                EditedCodTotal(goodsLabel: "Tiền hàng", goods: goods, codLabel: "Thu hộ (COD)", cod: cod,
                               fill: Theme.peachSoft, ring: Theme.accent, tagColor: Theme.accent)
            } else {
                HStack {
                    T(mates.count > 1 ? "Tổng tiền hàng" : "Tổng tiền", 14, .semibold)
                    Spacer()
                    T(money(goods), 18, .heavy, Theme.ink, track: -0.4).lineLimit(1)
                }
                .padding(.horizontal, 14)
                .frame(height: 44)
                .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Theme.peachSoft))
                .padding(.top, 7)
            }
        }
        .padding(.horizontal, 15)
        .padding(.top, 14)
        .padding(.bottom, 15)
        .cardStyle(20)
    }

    /// Các đơn chưa gửi khác của khách (đơn gom ngày trước…): xem nhanh và gộp đơn này vào chung một vận đơn.
    private func gomCard(_ o: Order, _ others: [Order]) -> some View {
        let merged = Vtp.alreadyMerged(o, with: others)
        let group = (others + [o]).sorted { $0.lastTs < $1.lastTs }
        let goods = group.reduce(0) { $0 + $1.total }
        // Chỉ nhóm đã gộp mới có chung số thu hộ sửa tay; chưa gộp thì số đó chỉ là của từng đơn.
        let cod = merged ? VtpTrack.editedCod(group).flatMap { $0 == goods ? nil : $0 } : nil
        return VStack(alignment: .leading, spacing: 0) {
            T("Đơn đã gom chưa gửi (\(others.count))", 14, .bold, Theme.gomInk).padding(.bottom, 3)
            ForEach(Array(others.enumerated()), id: \.element.id) { index, x in
                if index > 0 { HairLine() }
                Button { ui.push(.order(x.id)) } label: {
                    HStack(spacing: 10) {
                        VStack(alignment: .leading, spacing: 2) {
                            T("Đơn \(dayMonth(x.lastTs)) · \(timeText(x.lastTs))", 14, .bold).lineLimit(1)
                            T("\(x.productCount) sản phẩm · \(shipButtonLabel(x))", 12, .medium, Theme.muted).lineLimit(1)
                        }
                        Spacer(minLength: 4)
                        T(money(x.total), 14, .bold).lineLimit(1).fixedSize()
                        Icon(name: .chevronRight, size: 14, color: Theme.muted)
                    }
                    .frame(height: 50)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            if let cod {
                EditedCodTotal(goodsLabel: "Tiền hàng gửi chung", goods: goods, codLabel: "Gửi chung, thu hộ", cod: cod,
                               fill: Theme.gomTag, ring: Theme.gomInk.opacity(0.45), tagColor: Theme.gomInk)
            } else {
                HStack {
                    T(merged ? "Gửi chung, tổng" : "Tổng nếu gộp", 14, .semibold)
                    Spacer()
                    T(money(goods), 18, .heavy, Theme.ink, track: -0.4).lineLimit(1)
                }
                .padding(.horizontal, 14)
                .frame(height: 44)
                .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Theme.gomTag))
                .padding(.top, 7)
            }
            if !merged {
                OutlineButton(title: "Gộp vào đơn đã gom", icon: .truck, color: Theme.gomInk, height: 44) {
                    ui.present(dim: 0.42) { ShipReviewSheet(orderId: o.id) }
                }
                .padding(.top, 10)
            }
        }
        .padding(.horizontal, 15)
        .padding(.top, 14)
        .padding(.bottom, 15)
        .cardStyle(20, fill: Theme.gomFill, border: Theme.gomLine)
    }

    private func actions(_ o: Order) -> some View {
        VStack(spacing: 8) {
            PrimaryButton(title: "Chỉnh sửa đơn", icon: .pencil, fontSize: 15) { ui.push(.orderEdit(o.id)) }
            HStack(spacing: 8) {
                OutlineButton(title: shipButtonLabel(o), icon: Vtp.state(o) == .ask ? .check : .truck,
                              color: shipButtonColor(o), height: 48) {
                    ui.present(dim: 0.42) { ShipReviewSheet(orderId: o.id) }
                }
                OutlineButton(title: o.isPrinted ? "In lại" : "In đơn", icon: .printer, height: 48) {
                    Task { @MainActor in
                        ui.notify(await printOrder(o, store: store, printer: printer))
                    }
                }
                OutlineButton(title: "Xoá đơn", icon: .trash, color: Theme.red, height: 48) {
                    confirmDelete(o, store: store, ui: ui) { ui.pop() }
                }
            }
        }
        .padding(.horizontal, Metrics.gutter)
        .padding(.top, 4)
        .padding(.bottom, Metrics.safeBottom > 0 ? -5 : 10)
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
                    TextField("150", text: $item.codeText)
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
                    Icon(name: .minus, size: 16).frame(width: 34, height: 34).background(Circle().fill(Theme.field))
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
                if let o = order {
                    // Đơn đã có vận đơn thì tiền thu hộ đã gửi Viettel Post: đổi món ở đây không đổi được số đó.
                    if let code = VtpTrack.code(o), o.status != .delivered,
                       items.reduce(0, { $0 + $1.lineTotal }) != o.total {
                        ui.notify("Đơn đã có vận đơn \(VtpTrack.pretty(code)), tiền thu hộ đã gửi Viettel Post. Huỷ vận đơn ở chi tiết đơn rồi mới sửa món.")
                        return
                    }
                    store.updateOrder(o, items: items)
                    ui.notify(store.takeCodResetNotice())
                }
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
