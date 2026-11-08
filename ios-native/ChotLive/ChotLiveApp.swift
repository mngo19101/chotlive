import AudioToolbox
import SwiftUI
import UIKit

@main
struct ChotLiveApp: App {
    @StateObject private var store = Store()
    @StateObject private var printer = PrinterManager()
    @StateObject private var client = LiveClient()
    @StateObject private var appearance = Appearance()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(store)
                .environmentObject(printer)
                .environmentObject(client)
                .environmentObject(appearance)
                .onAppear {
                    KeyboardDismisser.shared.install()
                    SupportNotifier.shared.install()
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
                        KeyboardDismisser.shared.install()
                        client.checkSocket()
                    } else {
                        store.save()
                    }
                }
        }
    }
}

/// Chạm ra ngoài ô nhập thì ẩn bàn phím, ở mọi màn hình và sheet. Gắn vào cửa sổ và không chặn chạm,
/// nên nút bấm và cuộn vẫn chạy bình thường.
@MainActor
final class KeyboardDismisser: NSObject, UIGestureRecognizerDelegate {
    static let shared = KeyboardDismisser()

    private lazy var tap: UITapGestureRecognizer = {
        let tap = UITapGestureRecognizer(target: self, action: #selector(KeyboardDismisser.dismissKeyboard))
        tap.cancelsTouchesInView = false
        tap.delaysTouchesEnded = false
        tap.requiresExclusiveTouchType = false
        tap.delegate = self
        return tap
    }()

    func install() {
        guard tap.view == nil else { return }
        let windows = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap { $0.windows }
        (windows.first { $0.isKeyWindow } ?? windows.first)?.addGestureRecognizer(tap)
    }

    @objc private func dismissKeyboard() {
        tap.view?.endEditing(true)
    }

    /// Chạm vào ô nhập là để đặt con trỏ hoặc đổi ô, không ẩn bàn phím.
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        var view = touch.view
        while let current = view {
            if current is UITextInput { return false }
            view = current.superview
        }
        return true
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                           shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
        true
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
/// Chỉ đánh dấu đã in sau khi gửi hết dữ liệu tem. Trả về thông báo (nil nếu thành công).
@MainActor
func printComment(_ c: LiveComment, store: Store, printer: PrinterManager) async -> String? {
    let items = store.saveToCustomer(c)
    guard printer.isConnected else {
        return "Đã lưu đơn của \(c.nickname). Chưa kết nối máy in nên chưa in tem — vào Tôi › Máy in để kết nối."
    }
    if let error = await printer.sendAndWait(TicketRenderer.liveTicketBytes(comment: c)) {
        return "Đã lưu đơn của \(c.nickname) nhưng chưa in được tem. \(error)"
    }
    items.forEach { store.markPrinted(itemId: $0.id) }
    return nil
}

/// In tem cho tất cả sản phẩm của đơn, dừng ở tem lỗi đầu tiên. Trả về thông báo (nil nếu thành công).
@MainActor
func printOrder(_ o: Order, store: Store, printer: PrinterManager) async -> String? {
    guard printer.isConnected else {
        return "Chưa kết nối máy in — vào Tôi › Máy in để kết nối."
    }
    var done = 0
    for it in o.items {
        let c = LiveComment(id: it.id, uniqueId: o.customer.uniqueId, userId: o.customer.userId,
                            nickname: o.customer.nickname, text: it.ticketText, ts: it.ts, price: it.lineTotal)
        if let error = await printer.sendAndWait(TicketRenderer.ticketBytes(comment: c)) {
            return "Mới gửi được \(done)/\(o.items.count) tem. \(error)"
        }
        store.markPrinted(itemId: it.id)
        done += 1
    }
    return nil
}
