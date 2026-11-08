import CoreBluetooth
import UIKit

struct NearbyDevice: Identifiable {
    let peripheral: CBPeripheral
    let name: String
    let likelyPrinter: Bool
    var id: UUID { peripheral.identifier }
}

/// Kết nối máy in nhiệt Bluetooth LE (Xprinter...) bằng CoreBluetooth và gửi lệnh ESC/POS.
/// Mọi callback chạy trên main queue. iPhone không dùng được máy chỉ có Bluetooth Classic (SPP).
final class PrinterManager: NSObject, ObservableObject, CBCentralManagerDelegate, CBPeripheralDelegate {
    @Published var devices: [NearbyDevice] = []
    @Published var connectedName: String?
    @Published var isRecognizedPrinter = false
    @Published var isScanning = false
    @Published var hasScanned = false
    @Published var statusText = "Đang khởi tạo Bluetooth..."

    private struct Job {
        let data: Data
        let completion: (String?) -> Void
        var offset = 0
        var settled = false
    }

    private var central: CBCentralManager!
    private var peripheral: CBPeripheral?
    /// Máy cũ đang ngắt: phải giữ tham chiếu đến khi iOS báo đã ngắt xong.
    private var retiring: [CBPeripheral] = []
    private var writeChar: CBCharacteristic?
    private var useResponse = false
    private var pendingServices = 0

    private var jobs: [Job] = []
    private var awaitingAck = false
    private var pacing = false
    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid

    private var scanStop: DispatchWorkItem?
    private var connectTimeout: DispatchWorkItem?
    private var writeWatchdog: DispatchWorkItem?

    private let lastKey = "lastPrinterUUID"
    private let connectTimeoutSeconds: TimeInterval = 15
    private let writeTimeoutSeconds: TimeInterval = 10
    private let settleSeconds: TimeInterval = 0.3

    override init() {
        super.init()
        central = CBCentralManager(delegate: self, queue: .main)
    }

    var isConnected: Bool { connectedName != nil && writeChar != nil }

    // MARK: - Quét / kết nối

    func startScan() {
        guard central.state == .poweredOn else { return }
        devices.removeAll()
        isScanning = true
        hasScanned = true
        central.scanForPeripherals(withServices: nil, options: [CBCentralManagerScanOptionAllowDuplicatesKey: false])
        scanStop?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.stopScan() }
        scanStop = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 12, execute: work)
    }

    func stopScan() {
        scanStop?.cancel()
        scanStop = nil
        central.stopScan()
        isScanning = false
    }

    /// Người dùng chọn thiết bị: có giới hạn thời gian để không treo ở "Đang kết nối".
    func connect(_ p: CBPeripheral) {
        stopScan()
        if p === peripheral {
            if !isConnected { armConnectTimeout() }
            return
        }
        beginConnecting(p)
        statusText = "Đang kết nối \(p.name ?? "máy in")..."
        armConnectTimeout()
    }

    func disconnect() {
        UserDefaults.standard.removeObject(forKey: lastKey)
        releasePeripheral(reason: "Đã ngắt kết nối máy in.")
        statusText = "Đã ngắt kết nối"
    }

    private func beginConnecting(_ p: CBPeripheral) {
        releasePeripheral(reason: "Đã chuyển sang máy in khác.")
        peripheral = p
        p.delegate = self
        central.connect(p)
    }

    /// Bỏ máy đang dùng. Sau hàm này callback của máy đó không còn ảnh hưởng gì.
    private func releasePeripheral(reason: String) {
        dropLink(reason: reason)
        guard let old = peripheral else { return }
        peripheral = nil
        old.delegate = nil
        retiring.append(old)
        central.cancelPeripheralConnection(old)
    }

    private func dropLink(reason: String) {
        failAllJobs(reason)
        connectTimeout?.cancel()
        connectTimeout = nil
        connectedName = nil
        writeChar = nil
        isRecognizedPrinter = false
        pendingServices = 0
    }

    private func failConnection(_ message: String) {
        releasePeripheral(reason: message)
        statusText = message
    }

    private func armConnectTimeout() {
        connectTimeout?.cancel()
        let work = DispatchWorkItem { [weak self] in
            self?.failConnection("Không kết nối được. Kiểm tra máy in đã bật, ở gần iPhone và không nối với điện thoại khác.")
        }
        connectTimeout = work
        DispatchQueue.main.asyncAfter(deadline: .now() + connectTimeoutSeconds, execute: work)
    }

    // MARK: - CBCentralManagerDelegate

    func centralManagerDidUpdateState(_ c: CBCentralManager) {
        guard c.state == .poweredOn else {
            // iOS không báo didDisconnect khi Bluetooth tắt, nên phải tự xoá trạng thái kết nối.
            dropLink(reason: "Bluetooth trên iPhone đang tắt.")
            peripheral = nil
            retiring.removeAll()
            isScanning = false
            switch c.state {
            case .poweredOff: statusText = "Bluetooth đang tắt"
            case .unauthorized: statusText = "Chưa cấp quyền Bluetooth cho app (Cài đặt > ChốtLive)"
            case .unsupported: statusText = "Thiết bị không hỗ trợ Bluetooth LE"
            default: statusText = "Bluetooth chưa sẵn sàng"
            }
            return
        }
        if connectedName == nil { statusText = "Chưa kết nối máy in" }
        if peripheral == nil, let s = UserDefaults.standard.string(forKey: lastKey), let uuid = UUID(uuidString: s),
           let p = c.retrievePeripherals(withIdentifiers: [uuid]).first {
            // Máy in có thể đang tắt: để iOS tự nối khi máy xuất hiện, không đặt giới hạn thời gian.
            beginConnecting(p)
            statusText = "Đang chờ \(p.name ?? "máy in"). Bật máy in để tự nối lại..."
        }
    }

    func centralManager(_ c: CBCentralManager, didDiscover p: CBPeripheral, advertisementData: [String: Any], rssi RSSI: NSNumber) {
        if let connectable = advertisementData[CBAdvertisementDataIsConnectable] as? Bool, !connectable { return }
        let name = p.name ?? (advertisementData[CBAdvertisementDataLocalNameKey] as? String)
        let services = (advertisementData[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID] ?? []).map(\.uuidString)
        let likely = PrinterProfile.looksLikePrinter(name: name, advertisedServices: services)
        guard name != nil || likely else { return }
        if let i = devices.firstIndex(where: { $0.id == p.identifier }) {
            // Tên và danh sách dịch vụ có thể đến ở hai gói quảng bá khác nhau: gộp lại, không ghi đè.
            let old = devices[i]
            devices[i] = NearbyDevice(peripheral: p, name: name ?? old.name, likelyPrinter: likely || old.likelyPrinter)
        } else {
            devices.append(NearbyDevice(peripheral: p, name: name ?? "Máy in không tên", likelyPrinter: likely))
        }
    }

    func centralManager(_ c: CBCentralManager, didConnect p: CBPeripheral) {
        guard p === peripheral else { return }
        statusText = "Đang đọc thông tin \(p.name ?? "máy in")..."
        armConnectTimeout()
        p.discoverServices(nil)
    }

    func centralManager(_ c: CBCentralManager, didFailToConnect p: CBPeripheral, error: Error?) {
        guard p === peripheral else { return }
        connectTimeout?.cancel()
        connectTimeout = nil
        peripheral = nil
        statusText = "Kết nối thất bại: \(error?.localizedDescription ?? "không rõ")"
    }

    func centralManager(_ c: CBCentralManager, didDisconnectPeripheral p: CBPeripheral, error: Error?) {
        if let i = retiring.firstIndex(where: { $0 === p }) {
            retiring.remove(at: i)
            return
        }
        guard p === peripheral else { return }
        dropLink(reason: "Máy in mất kết nối giữa chừng.")
        statusText = "Mất kết nối, đang thử nối lại..."
        c.connect(p) // iOS tự nối lại khi máy in xuất hiện
    }

    // MARK: - CBPeripheralDelegate

    func peripheral(_ p: CBPeripheral, didDiscoverServices error: Error?) {
        guard p === peripheral else { return }
        let services = p.services ?? []
        if let error {
            failConnection("Không đọc được thông tin thiết bị: \(error.localizedDescription)")
        } else if services.isEmpty {
            failConnection(notAPrinterMessage)
        } else {
            pendingServices = services.count
            for s in services { p.discoverCharacteristics(nil, for: s) }
        }
    }

    func peripheral(_ p: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        guard p === peripheral, pendingServices > 0 else { return }
        pendingServices -= 1
        // Đợi đọc hết mọi dịch vụ rồi mới chọn, vì thứ tự iOS trả về không cố định.
        if pendingServices == 0 { chooseWriteCharacteristic(p) }
    }

    private func chooseWriteCharacteristic(_ p: CBPeripheral) {
        var writable: [CBCharacteristic] = []
        var candidates: [PrinterProfile.Candidate] = []
        for s in p.services ?? [] {
            for ch in s.characteristics ?? [] where ch.properties.contains(.write) || ch.properties.contains(.writeWithoutResponse) {
                writable.append(ch)
                candidates.append(.init(service: s.uuid.uuidString, characteristic: ch.uuid.uuidString,
                                        canWriteWithoutResponse: ch.properties.contains(.writeWithoutResponse)))
            }
        }
        guard let selection = PrinterProfile.pick(candidates) else {
            failConnection(notAPrinterMessage)
            return
        }
        connectTimeout?.cancel()
        connectTimeout = nil
        writeChar = writable[selection.index]
        useResponse = !candidates[selection.index].canWriteWithoutResponse
        isRecognizedPrinter = selection.isRecognized
        let name = p.name ?? "Máy in"
        connectedName = name
        statusText = selection.isRecognized
            ? "Đã kết nối \(name)"
            : "Đã kết nối \(name) nhưng chưa nhận ra đây là máy in. Bấm In thử để kiểm tra."
        UserDefaults.standard.set(p.identifier.uuidString, forKey: lastKey)
    }

    private var notAPrinterMessage: String {
        "Thiết bị này không có kênh in. Hãy chọn đúng máy in Bluetooth LE."
    }

    func peripheral(_ p: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
        guard p === peripheral else { return }
        awaitingAck = false
        if let error {
            failAllJobs("Máy in báo lỗi khi nhận dữ liệu: \(error.localizedDescription)")
            return
        }
        pump()
    }

    func peripheralIsReady(toSendWriteWithoutResponse p: CBPeripheral) {
        guard p === peripheral else { return }
        pump()
    }

    // MARK: - Gửi dữ liệu

    /// Gửi byte ESC/POS, báo kết quả qua `completion` trên main queue: nil là đã gửi hết, ngược lại là lý do lỗi.
    /// Máy in không báo lại trạng thái giấy nên "đã gửi hết" chưa chắc đã ra giấy.
    func send(_ data: Data, completion: @escaping (String?) -> Void) {
        guard !data.isEmpty else {
            completion("Không tạo được nội dung tem.")
            return
        }
        guard isConnected else {
            completion("Chưa kết nối máy in.")
            return
        }
        jobs.append(Job(data: Data(data), completion: completion))
        holdBackgroundTime()
        // Bật ngay từ đầu: nếu iOS chưa cho ghi gói đầu tiên thì lệnh in vẫn không bị treo mãi.
        if writeWatchdog == nil { armWriteWatchdog() }
        pump()
    }

    @MainActor
    func sendAndWait(_ data: Data) async -> String? {
        await withCheckedContinuation { continuation in
            send(data) { continuation.resume(returning: $0) }
        }
    }

    private func pump() {
        guard let p = peripheral, let c = writeChar, !jobs.isEmpty, !awaitingAck, !pacing else { return }

        if jobs[0].offset >= jobs[0].data.count {
            finishCurrentJob()
            return
        }
        if !useResponse && !p.canSendWriteWithoutResponse { return } // peripheralIsReady sẽ gọi lại

        let size = PrinterProfile.chunkSize(maxWithoutResponse: p.maximumWriteValueLength(for: .withoutResponse))
        let start = jobs[0].offset
        let end = min(start + size, jobs[0].data.count)
        let chunk = jobs[0].data.subdata(in: start..<end)
        jobs[0].offset = end
        armWriteWatchdog()

        if useResponse {
            awaitingAck = true
            p.writeValue(chunk, for: c, type: .withResponse)
        } else {
            p.writeValue(chunk, for: c, type: .withoutResponse)
            pause(PrinterProfile.pacingDelay(bytes: chunk.count))
        }
    }

    private func finishCurrentJob() {
        // Ghi không phản hồi không có xác nhận: chờ một chút để gói cuối rời iPhone rồi mới báo xong.
        if !useResponse && !jobs[0].settled {
            jobs[0].settled = true
            pause(settleSeconds)
            return
        }
        let job = jobs.removeFirst()
        job.completion(nil)
        if jobs.isEmpty {
            writeWatchdog?.cancel()
            writeWatchdog = nil
            releaseBackgroundTime()
        } else {
            pump()
        }
    }

    private func pause(_ seconds: TimeInterval) {
        pacing = true
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { [weak self] in
            self?.pacing = false
            self?.pump()
        }
    }

    private func armWriteWatchdog() {
        writeWatchdog?.cancel()
        let work = DispatchWorkItem { [weak self] in
            self?.failAllJobs("Máy in không phản hồi. Kiểm tra giấy, nắp máy rồi in lại.")
        }
        writeWatchdog = work
        DispatchQueue.main.asyncAfter(deadline: .now() + writeTimeoutSeconds, execute: work)
    }

    private func failAllJobs(_ message: String) {
        let failed = jobs
        jobs.removeAll()
        awaitingAck = false
        pacing = false
        writeWatchdog?.cancel()
        writeWatchdog = nil
        releaseBackgroundTime()
        failed.forEach { $0.completion(message) }
    }

    // MARK: - Chạy nền

    /// Xin thêm thời gian để in xong tem khi người bán chuyển sang TikTok giữa chừng.
    private func holdBackgroundTime() {
        guard backgroundTask == .invalid else { return }
        MainActor.assumeIsolated {
            self.backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "ChotLivePrint") { [weak self] in
                self?.releaseBackgroundTime()
            }
        }
    }

    private func releaseBackgroundTime() {
        guard backgroundTask != .invalid else { return }
        let task = backgroundTask
        backgroundTask = .invalid
        MainActor.assumeIsolated {
            UIApplication.shared.endBackgroundTask(task)
        }
    }
}
