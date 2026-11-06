import SwiftUI

@main
struct ChotLiveApp: App {
    @StateObject private var store = Store()
    @StateObject private var printer = PrinterManager()
    @StateObject private var client = LiveClient()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(store)
                .environmentObject(printer)
                .environmentObject(client)
                .onAppear {
                    client.onChat = { [store] c in store.addComment(c) }
                }
        }
    }
}

/// Chốt 1 bình luận: luôn lưu vào khách/đơn hàng, rồi in tem nếu đã nối máy in.
/// Trả về thông báo (nil nếu in thành công).
@MainActor
func printComment(_ c: LiveComment, store: Store, printer: PrinterManager) -> String? {
    let item = store.saveToCustomer(c)
    guard printer.isConnected else {
        return "Đã lưu đơn của \(c.nickname). Chưa kết nối máy in nên chưa in tem — vào Tôi › Máy in để kết nối."
    }
    let ok = printer.send(TicketRenderer.ticketBytes(comment: c))
    if ok { store.markPrinted(itemId: item.id) }
    return ok ? nil : "Đã lưu đơn nhưng gửi lệnh in thất bại."
}
