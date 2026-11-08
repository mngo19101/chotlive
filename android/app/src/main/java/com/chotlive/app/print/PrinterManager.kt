package com.chotlive.app.print

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.content.ContextCompat
import kotlinx.coroutines.Job
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.io.IOException

data class NearbyDevice(
    val address: String,
    val name: String,
    val likelyPrinter: Boolean,
    /** Thấy qua Bluetooth LE. */
    val ble: Boolean,
    /** Thấy qua Bluetooth Classic (SPP) hoặc đã ghép đôi kiểu Classic. */
    val classic: Boolean,
    val bonded: Boolean,
)

/**
 * Kết nối máy in nhiệt Bluetooth (Xprinter...) và gửi lệnh ESC/POS.
 * Khác iPhone: Android dùng được cả máy Bluetooth LE lẫn máy chỉ có Bluetooth Classic (SPP).
 */
@SuppressLint("MissingPermission")
class PrinterManager(private val context: Context) {
    var devices by mutableStateOf(listOf<NearbyDevice>()); private set
    var connectedName by mutableStateOf<String?>(null); private set
    var isRecognizedPrinter by mutableStateOf(false); private set
    var isScanning by mutableStateOf(false); private set
    var hasScanned by mutableStateOf(false); private set
    var statusText by mutableStateOf("Chưa kết nối máy in"); private set
    var isConnecting by mutableStateOf(false); private set

    private val adapter: BluetoothAdapter? = context.getSystemService(BluetoothManager::class.java)?.adapter
    private val prefs = context.getSharedPreferences("printer", Context.MODE_PRIVATE)
    private val scope = MainScope()
    private val mutex = Mutex()
    private var link: PrinterLink? = null
    private var scanJob: Job? = null
    private var reconnectJob: Job? = null
    private var receiverRegistered = false

    private val lastAddress: String? get() = prefs.getString(KEY_ADDRESS, null)
    private val lastName: String get() = prefs.getString(KEY_NAME, null) ?: "Máy in"

    val isConnected: Boolean get() = connectedName != null

    /** Đã chọn máy in: in được, nếu đang rớt kết nối thì app tự nối lại trước khi in. */
    val hasPrinter: Boolean get() = isConnected || lastAddress != null

    init {
        refreshStatus()
        scope.launch {
            delay(500)
            reconnectQuietly()
        }
    }

    // MARK: - Quyền

    fun requiredPermissions(): Array<String> =
        if (Build.VERSION.SDK_INT >= 31) arrayOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT)
        else arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)

    private fun granted(p: String) = ContextCompat.checkSelfPermission(context, p) == PackageManager.PERMISSION_GRANTED

    fun hasPermissions(): Boolean = requiredPermissions().all { granted(it) }

    private fun canConnect(): Boolean = Build.VERSION.SDK_INT < 31 || granted(Manifest.permission.BLUETOOTH_CONNECT)

    val bluetoothEnabled: Boolean get() = adapter?.isEnabled == true

    fun refreshStatus() {
        val a = adapter
        when {
            a == null -> statusText = "Máy này không có Bluetooth"
            !canConnect() -> statusText = "Chưa cấp quyền Thiết bị lân cận cho app"
            !a.isEnabled -> statusText = "Bluetooth đang tắt"
            connectedName == null && !isConnecting -> statusText =
                if (lastAddress != null) "Chưa nối được $lastName. Bật máy in để app tự nối lại." else "Chưa kết nối máy in"
        }
    }

    // MARK: - Quét

    private val scanCallback = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, r: ScanResult) {
            if (Build.VERSION.SDK_INT >= 26 && !r.isConnectable) return
            val name = r.scanRecord?.deviceName ?: try {
                r.device.name
            } catch (_: SecurityException) {
                null
            }
            val services = r.scanRecord?.serviceUuids?.map { it.uuid.toString() } ?: emptyList()
            val likely = PrinterProfile.looksLikePrinter(name, services)
            if (name == null && !likely) return
            upsert(NearbyDevice(r.device.address, name ?: "Máy in không tên", likely, ble = true, classic = false,
                bonded = r.device.bondState == BluetoothDevice.BOND_BONDED))
        }
    }

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(ctx: Context, intent: Intent) {
            if (intent.action != BluetoothDevice.ACTION_FOUND) return
            @Suppress("DEPRECATION")
            val device: BluetoothDevice = (if (Build.VERSION.SDK_INT >= 33)
                intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE, BluetoothDevice::class.java)
            else intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE)) ?: return
            val name = device.name ?: intent.getStringExtra(BluetoothDevice.EXTRA_NAME) ?: return
            if (device.type == BluetoothDevice.DEVICE_TYPE_LE) return
            upsert(NearbyDevice(device.address, name, PrinterProfile.looksLikePrinter(name, emptyList()),
                ble = device.type == BluetoothDevice.DEVICE_TYPE_DUAL, classic = true,
                bonded = device.bondState == BluetoothDevice.BOND_BONDED))
        }
    }

    private fun upsert(d: NearbyDevice) {
        val i = devices.indexOfFirst { it.address == d.address }
        devices = if (i < 0) devices + d else devices.toMutableList().also {
            // Tên và kiểu kết nối có thể đến ở hai lần thấy khác nhau: gộp lại, không ghi đè.
            val old = it[i]
            it[i] = old.copy(
                name = if (old.name == "Máy in không tên") d.name else old.name,
                likelyPrinter = old.likelyPrinter || d.likelyPrinter,
                ble = old.ble || d.ble,
                classic = old.classic || d.classic,
                bonded = old.bonded || d.bonded,
            )
        }
    }

    fun startScan() {
        val a = adapter ?: return refreshStatus()
        if (!a.isEnabled || !hasPermissions()) return refreshStatus()
        stopScan()
        // Máy đã ghép đôi trong Cài đặt Bluetooth hiện ngay, không cần chờ quét.
        devices = a.bondedDevices.orEmpty().mapNotNull { d ->
            val name = d.name ?: return@mapNotNull null
            NearbyDevice(d.address, name, PrinterProfile.looksLikePrinter(name, emptyList()),
                ble = d.type == BluetoothDevice.DEVICE_TYPE_LE || d.type == BluetoothDevice.DEVICE_TYPE_DUAL,
                classic = d.type != BluetoothDevice.DEVICE_TYPE_LE, bonded = true)
        }
        isScanning = true
        hasScanned = true
        try {
            a.bluetoothLeScanner?.startScan(null,
                ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build(), scanCallback)
        } catch (_: Exception) {
        }
        try {
            ContextCompat.registerReceiver(context, receiver, IntentFilter(BluetoothDevice.ACTION_FOUND), ContextCompat.RECEIVER_EXPORTED)
            receiverRegistered = true
            a.startDiscovery()
        } catch (_: Exception) {
        }
        scanJob = scope.launch {
            delay(12_000)
            stopScan()
        }
    }

    fun stopScan() {
        scanJob?.cancel()
        scanJob = null
        val a = adapter
        if (a != null && canConnect()) {
            try {
                a.bluetoothLeScanner?.stopScan(scanCallback)
            } catch (_: Exception) {
            }
            try {
                a.cancelDiscovery()
            } catch (_: Exception) {
            }
        }
        if (receiverRegistered) {
            try {
                context.unregisterReceiver(receiver)
            } catch (_: Exception) {
            }
            receiverRegistered = false
        }
        isScanning = false
    }

    // MARK: - Kết nối

    private enum class Transport { GATT, SPP }

    /** Máy đã ghép đôi kiểu Classic thì nối SPP trước (ổn định hơn); máy thấy qua BLE thì nối BLE trước. */
    private fun order(d: NearbyDevice): List<Transport> = when {
        d.classic && d.bonded -> listOfNotNull(Transport.SPP, Transport.GATT.takeIf { d.ble })
        d.ble -> listOfNotNull(Transport.GATT, Transport.SPP.takeIf { d.classic })
        else -> listOf(Transport.SPP)
    }

    private suspend fun open(address: String, transports: List<Transport>): Pair<PrinterLink, Transport> {
        val a = adapter ?: throw IOException("Máy này không có Bluetooth")
        if (!a.isEnabled) throw IOException("Bluetooth đang tắt. Hãy bật Bluetooth rồi thử lại.")
        val device = a.getRemoteDevice(address)
        var last: Exception? = null
        for (t in transports) {
            try {
                val l: PrinterLink = when (t) {
                    Transport.GATT -> GattLink.open(context, device) { scope.launch { linkLost() } }
                    Transport.SPP -> SppLink.open(a, device)
                }
                return l to t
            } catch (e: Exception) {
                last = e
            }
        }
        throw (last as? IOException) ?: IOException(CONNECT_FAILED, last)
    }

    private fun adopt(l: PrinterLink, t: Transport, address: String, name: String) {
        link?.takeIf { it !== l }?.close()
        link = l
        connectedName = name
        isRecognizedPrinter = l.isRecognized
        statusText = if (l.isRecognized) "Đã kết nối $name"
        else "Đã kết nối $name nhưng chưa nhận ra đây là máy in. Bấm In thử để kiểm tra."
        prefs.edit().putString(KEY_ADDRESS, address).putString(KEY_NAME, name).putString(KEY_TRANSPORT, t.name).apply()
    }

    /** Người dùng chọn thiết bị. */
    fun connect(d: NearbyDevice) {
        stopScan()
        reconnectJob?.cancel()
        scope.launch {
            mutex.withLock {
                dropLink()
                isConnecting = true
                statusText = "Đang kết nối ${d.name}..."
                try {
                    val (l, t) = open(d.address, order(d))
                    adopt(l, t, d.address, d.name)
                } catch (e: Exception) {
                    statusText = e.message ?: CONNECT_FAILED
                } finally {
                    isConnecting = false
                }
            }
        }
    }

    fun disconnect() {
        reconnectJob?.cancel()
        prefs.edit().remove(KEY_ADDRESS).remove(KEY_NAME).remove(KEY_TRANSPORT).apply()
        dropLink()
        statusText = "Đã ngắt kết nối"
    }

    private fun dropLink() {
        link?.close()
        link = null
        connectedName = null
        isRecognizedPrinter = false
    }

    private fun savedOrder(): List<Transport> {
        val first = prefs.getString(KEY_TRANSPORT, null)?.let { runCatching { Transport.valueOf(it) }.getOrNull() } ?: Transport.SPP
        return listOf(first, if (first == Transport.GATT) Transport.SPP else Transport.GATT)
    }

    /** Nối lại máy in dùng lần trước (mở app, hoặc máy in vừa rớt). */
    private suspend fun ensureLink() {
        if (link?.isOpen == true) return
        val address = lastAddress ?: throw IOException("Chưa kết nối máy in.")
        if (!canConnect()) throw IOException("Chưa cấp quyền Thiết bị lân cận cho app (Tôi › Máy in).")
        dropLink()
        statusText = "Đang nối lại $lastName..."
        val (l, t) = open(address, savedOrder())
        adopt(l, t, address, lastName)
    }

    private suspend fun reconnectQuietly() {
        if (lastAddress == null || !canConnect() || adapter?.isEnabled != true) return
        mutex.withLock {
            try {
                ensureLink()
            } catch (_: Exception) {
                refreshStatus()
            }
        }
    }

    private fun linkLost() {
        if (link?.isOpen == true) return
        connectedName = null
        isRecognizedPrinter = false
        if (lastAddress == null) return
        statusText = "Mất kết nối, đang thử nối lại..."
        reconnectJob?.cancel()
        reconnectJob = scope.launch {
            repeat(20) {
                delay(6_000)
                if (link?.isOpen == true || lastAddress == null) return@launch
                reconnectQuietly()
            }
        }
    }

    // MARK: - Gửi dữ liệu

    /** Gửi byte ESC/POS: null là đã gửi hết, ngược lại là lý do lỗi.
     *  Máy in không báo lại trạng thái giấy nên "đã gửi hết" chưa chắc đã ra giấy. */
    suspend fun sendAndWait(data: ByteArray): String? {
        if (data.isEmpty()) return "Không tạo được nội dung tem."
        return mutex.withLock {
            try {
                ensureLink()
                try {
                    link!!.write(data)
                } catch (e: StaleLinkException) {
                    // Kết nối đã chết trước khi gửi byte nào: nối lại rồi gửi lại cả tem.
                    dropLink()
                    ensureLink()
                    link!!.write(data)
                }
                null
            } catch (e: Exception) {
                if (link?.isOpen != true) {
                    dropLink()
                    refreshStatus()
                }
                e.message ?: "Không in được tem."
            }
        }
    }

    companion object {
        private const val KEY_ADDRESS = "lastPrinterAddress"
        private const val KEY_NAME = "lastPrinterName"
        private const val KEY_TRANSPORT = "lastPrinterTransport"
    }
}
