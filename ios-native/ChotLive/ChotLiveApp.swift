import AudioToolbox
import SwiftUI
import UIKit

@main
struct ChotLiveApp: App {
    @StateObject private var store = Store()
    @StateObject private var printer = PrinterManager()
    @StateObject private var client = LiveClient()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(store)
                .environmentObject(printer)
                .environmentObject(client)
                .onAppear {
                    client.onChat = { [store, client] c in
                        store.addComment(c, tiktok: client.liveUsername)
                        if store.isClosingComment(c) { CommentAlert.play() }
                    }
                    client.onAccountChange = { [store] account in store.switchAccount(account) }
                    client.onSnapshot = { [store] snap in store.applyServer(snap) }
                    client.onSyncAck = { [store, client] id in
                        if store.acknowledgeSync(id: id) { client.flushSync(store) }
                    }
                    client.onSocketClosed = { [store] in store.syncInterrupted() }
                    store.onLocalChange = { [store, client] in
                        Task { @MainActor in client.scheduleSync(store) }
                    }
                    // Đặt sau cùng: có thể chạy ngay nếu server đã trả lời trước khi giao diện mở.
                    client.onHello = { [store, client] snap in
                        store.applyServer(snap)
                        client.flushSync(store)
                        Task { @MainActor in await client.catchUpComments(into: store) }
                    }
                }
                .onChange(of: scenePhase) { phase in
                    if phase == .active {
                        client.checkSocket()
                    } else {
                        store.save()
                    }
                }
        }
    }
}

/// Âm thanh / rung khi có bình luận chốt đơn (cài trong Tôi › Thông báo).
enum CommentAlert {
    static let soundKey = "notifySound"
    static let hapticKey = "notifyHaptic"
    private static var lastPlayed = Date.distantPast

    static func play() {
        guard Date().timeIntervalSince(lastPlayed) > 1 else { return }
        lastPlayed = Date()
        if UserDefaults.standard.bool(forKey: soundKey) { AudioServicesPlaySystemSound(1007) }
        if UserDefaults.standard.bool(forKey: hapticKey) {
            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        }
    }
}

/// Chốt 1 bình luận: luôn lưu vào khách/đơn hàng, rồi in tem nếu đã nối máy in.
/// Trả về thông báo (nil nếu in thành công).
@MainActor
func printComment(_ c: LiveComment, store: Store, printer: PrinterManager) -> String? {
    let items = store.saveToCustomer(c)
    guard printer.isConnected else {
        return "Đã lưu đơn của \(c.nickname). Chưa kết nối máy in nên chưa in tem — vào Tôi › Máy in để kết nối."
    }
    var ticket = c
    ticket.price = items.reduce(0) { $0 + $1.lineTotal }
    let ok = printer.send(TicketRenderer.ticketBytes(comment: ticket))
    if ok { items.forEach { store.markPrinted(itemId: $0.id) } }
    return ok ? nil : "Đã lưu đơn nhưng gửi lệnh in thất bại."
}

/// In tem cho tất cả sản phẩm của đơn. Trả về thông báo (nil nếu in thành công).
@MainActor
func printOrder(_ o: Order, store: Store, printer: PrinterManager) -> String? {
    guard printer.isConnected else {
        return "Chưa kết nối máy in — vào Tôi › Máy in để kết nối."
    }
    var failed = false
    for it in o.items {
        let c = LiveComment(id: it.id, uniqueId: o.customer.uniqueId, userId: o.customer.userId,
                            nickname: o.customer.nickname, text: it.ticketText, ts: it.ts, price: it.lineTotal)
        if printer.send(TicketRenderer.ticketBytes(comment: c)) {
            store.markPrinted(itemId: it.id)
        } else {
            failed = true
        }
    }
    return failed ? "Gửi lệnh in thất bại với một số sản phẩm." : nil
}
