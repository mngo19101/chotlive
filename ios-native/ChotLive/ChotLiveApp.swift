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

/// In đúng 1 bình luận: lưu vào khách rồi gửi tem ra máy in. Trả về lỗi (nếu có).
@MainActor
func printComment(_ c: LiveComment, store: Store, printer: PrinterManager) -> String? {
    guard printer.isConnected else { return "Chưa kết nối máy in. Vào tab Máy in để kết nối." }
    store.saveToCustomer(c)
    let ok = printer.send(TicketRenderer.ticketBytes(comment: c))
    return ok ? nil : "Gửi lệnh in thất bại."
}
