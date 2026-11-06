import CoreBluetooth
import Foundation

/// Kết nối máy in nhiệt Bluetooth LE (Xprinter...) bằng CoreBluetooth và gửi lệnh ESC/POS.
final class PrinterManager: NSObject, ObservableObject, CBCentralManagerDelegate, CBPeripheralDelegate {
    @Published var devices: [CBPeripheral] = []
    @Published var connectedName: String?
    @Published var isScanning = false
    @Published var statusText = "Đang khởi tạo Bluetooth..."

    private var central: CBCentralManager!
    private var peripheral: CBPeripheral?
    private var writeChar: CBCharacteristic?
    private var useResponse = false
    private var queue: [Data] = []
    private var awaiting = false
    private var userDisconnected = false

    private let lastKey = "lastPrinterUUID"

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
        central.scanForPeripherals(withServices: nil, options: [CBCentralManagerScanOptionAllowDuplicatesKey: false])
        DispatchQueue.main.asyncAfter(deadline: .now() + 12) { [weak self] in self?.stopScan() }
    }

    func stopScan() {
        central.stopScan()
        isScanning = false
    }

    func connect(_ p: CBPeripheral) {
        stopScan()
        userDisconnected = false
        peripheral = p
        p.delegate = self
        statusText = "Đang kết nối \(p.name ?? "máy in")..."
        central.connect(p)
    }

    func disconnect() {
        userDisconnected = true
        if let p = peripheral { central.cancelPeripheralConnection(p) }
        UserDefaults.standard.removeObject(forKey: lastKey)
        reset()
    }

    private func reset() {
        connectedName = nil
        writeChar = nil
        queue.removeAll()
        awaiting = false
    }

    // MARK: - CBCentralManagerDelegate

    func centralManagerDidUpdateState(_ c: CBCentralManager) {
        switch c.state {
        case .poweredOn:
            statusText = connectedName == nil ? "Chưa kết nối máy in" : statusText
            if let s = UserDefaults.standard.string(forKey: lastKey), let uuid = UUID(uuidString: s),
               let p = c.retrievePeripherals(withIdentifiers: [uuid]).first, peripheral == nil {
                connect(p)
            }
        case .poweredOff: statusText = "Bluetooth đang tắt"
        case .unauthorized: statusText = "Chưa cấp quyền Bluetooth cho app (Cài đặt > ChốtLive)"
        case .unsupported: statusText = "Thiết bị không hỗ trợ Bluetooth LE"
        default: statusText = "Bluetooth chưa sẵn sàng"
        }
    }

    func centralManager(_ c: CBCentralManager, didDiscover p: CBPeripheral, advertisementData: [String: Any], rssi RSSI: NSNumber) {
        let name = p.name ?? (advertisementData[CBAdvertisementDataLocalNameKey] as? String)
        guard name != nil else { return }
        if !devices.contains(where: { $0.identifier == p.identifier }) { devices.append(p) }
    }

    func centralManager(_ c: CBCentralManager, didConnect p: CBPeripheral) {
        p.discoverServices(nil)
    }

    func centralManager(_ c: CBCentralManager, didFailToConnect p: CBPeripheral, error: Error?) {
        statusText = "Kết nối thất bại: \(error?.localizedDescription ?? "không rõ")"
    }

    func centralManager(_ c: CBCentralManager, didDisconnectPeripheral p: CBPeripheral, error: Error?) {
        reset()
        if userDisconnected {
            statusText = "Đã ngắt kết nối"
        } else {
            statusText = "Mất kết nối, đang thử nối lại..."
            c.connect(p) // iOS tự nối lại khi máy in xuất hiện
        }
    }

    // MARK: - CBPeripheralDelegate

    func peripheral(_ p: CBPeripheral, didDiscoverServices error: Error?) {
        for s in p.services ?? [] { p.discoverCharacteristics(nil, for: s) }
    }

    func peripheral(_ p: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        guard writeChar == nil else { return }
        for ch in service.characteristics ?? [] {
            if ch.properties.contains(.writeWithoutResponse) || ch.properties.contains(.write) {
                writeChar = ch
                useResponse = !ch.properties.contains(.writeWithoutResponse)
                connectedName = p.name ?? "Máy in"
                statusText = "Đã kết nối \(connectedName ?? "")"
                UserDefaults.standard.set(p.identifier.uuidString, forKey: lastKey)
                return
            }
        }
    }

    func peripheral(_ p: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
        awaiting = false
        pump()
    }

    func peripheralIsReady(toSendWriteWithoutResponse p: CBPeripheral) {
        pump()
    }

    // MARK: - Gửi dữ liệu

    /// Gửi byte ESC/POS. Trả về false nếu chưa kết nối.
    @discardableResult
    func send(_ data: Data) -> Bool {
        guard let p = peripheral, writeChar != nil, connectedName != nil else { return false }
        let maxLen = p.maximumWriteValueLength(for: useResponse ? .withResponse : .withoutResponse)
        let chunk = max(20, min(maxLen, 180))
        var i = 0
        while i < data.count {
            queue.append(data.subdata(in: i..<min(i + chunk, data.count)))
            i += chunk
        }
        pump()
        return true
    }

    private func pump() {
        guard let p = peripheral, let c = writeChar else { return }
        while !queue.isEmpty && !awaiting {
            let chunk = queue[0]
            if useResponse {
                p.writeValue(chunk, for: c, type: .withResponse)
                queue.removeFirst()
                awaiting = true
                return
            }
            if !p.canSendWriteWithoutResponse { return }
            p.writeValue(chunk, for: c, type: .withoutResponse)
            queue.removeFirst()
        }
    }
}
