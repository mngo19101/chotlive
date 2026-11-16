import SwiftUI

@main
struct VtpNhapTestApp: App {
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            TabView {
                ConnectView()
                    .tabItem { Label("Kết nối", systemImage: "link") }
                OrdersView()
                    .tabItem { Label("Đẩy nháp", systemImage: "shippingbox") }
                LogView()
                    .tabItem { Label("Nhật ký", systemImage: "list.bullet.rectangle") }
            }
            .environmentObject(model)
            .environmentObject(model.log)
            .environmentObject(model.chotlive)
            .environmentObject(model.vtp)
            .tint(Color(red: 0.75, green: 0.31, blue: 0.05))
        }
    }
}

@MainActor
final class AppModel: ObservableObject {
    let log: LogStore
    let chotlive: ChotLiveReader
    let vtp: VtpWebClient

    init() {
        let log = LogStore()
        self.log = log
        chotlive = ChotLiveReader(log: log)
        vtp = VtpWebClient(log: log)
    }
}
