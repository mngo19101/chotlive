package com.chotlive.app.print

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothProfile
import android.bluetooth.BluetoothSocket
import android.bluetooth.BluetoothStatusCodes
import android.content.Context
import android.os.Build
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.io.IOException
import java.util.UUID

/** Đường truyền tới máy in đã mở. */
interface PrinterLink {
    val isOpen: Boolean
    /** Máy có kênh in được nhận ra (BLE) hoặc là máy Bluetooth Classic. */
    val isRecognized: Boolean
    suspend fun write(data: ByteArray)
    fun close()
}

/** Kết nối đã chết từ trước khi gửi byte nào: an toàn để nối lại rồi gửi lại cả tem. */
class StaleLinkException : IOException("Máy in mất kết nối.")

const val NOT_A_PRINTER = "Thiết bị này không có kênh in. Hãy chọn đúng máy in Bluetooth."
const val CONNECT_FAILED = "Không kết nối được. Kiểm tra máy in đã bật, ở gần điện thoại và không nối với điện thoại khác."

/** Máy in Bluetooth LE (GATT). */
@SuppressLint("MissingPermission")
class GattLink private constructor(private val device: BluetoothDevice, private val onLost: () -> Unit) :
    BluetoothGattCallback(), PrinterLink {

    private var gatt: BluetoothGatt? = null
    private var ch: BluetoothGattCharacteristic? = null
    private var noResponse = false
    private var mtu = 23
    @Volatile override var isOpen = false
        private set
    override var isRecognized = false
        private set

    @Volatile private var connectDone: CompletableDeferred<Boolean>? = null
    @Volatile private var servicesDone: CompletableDeferred<Boolean>? = null
    @Volatile private var mtuDone: CompletableDeferred<Int>? = null
    @Volatile private var writeDone: CompletableDeferred<Int>? = null

    private suspend fun connect(context: Context) {
        val c = CompletableDeferred<Boolean>().also { connectDone = it }
        gatt = device.connectGatt(context, false, this, BluetoothDevice.TRANSPORT_LE)
        if (withTimeoutOrNull(15_000) { c.await() } != true) {
            close()
            throw IOException(CONNECT_FAILED)
        }
        val g = gatt ?: throw IOException(CONNECT_FAILED)
        val s = CompletableDeferred<Boolean>().also { servicesDone = it }
        if (!g.discoverServices() || withTimeoutOrNull(12_000) { s.await() } != true) {
            close()
            throw IOException("Không đọc được thông tin thiết bị.")
        }
        val m = CompletableDeferred<Int>().also { mtuDone = it }
        if (g.requestMtu(247)) mtu = withTimeoutOrNull(3_000) { m.await() } ?: 23

        val writable = mutableListOf<BluetoothGattCharacteristic>()
        val candidates = mutableListOf<PrinterProfile.Candidate>()
        for (service in g.services) {
            for (char in service.characteristics) {
                val p = char.properties
                val wnr = p and BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE != 0
                if (p and BluetoothGattCharacteristic.PROPERTY_WRITE != 0 || wnr) {
                    writable += char
                    candidates += PrinterProfile.Candidate(service.uuid.toString(), char.uuid.toString(), wnr)
                }
            }
        }
        val selection = PrinterProfile.pick(candidates)
        if (selection == null) {
            close()
            throw IOException(NOT_A_PRINTER)
        }
        ch = writable[selection.index]
        noResponse = candidates[selection.index].canWriteWithoutResponse
        isRecognized = selection.isRecognized
        isOpen = true
    }

    override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
        if (newState == BluetoothProfile.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS) {
            connectDone?.complete(true)
        } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
            val wasOpen = isOpen
            isOpen = false
            connectDone?.complete(false)
            servicesDone?.complete(false)
            mtuDone?.complete(23)
            writeDone?.complete(-1)
            g.close()
            if (gatt === g) gatt = null
            if (wasOpen) onLost()
        }
    }

    override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
        servicesDone?.complete(status == BluetoothGatt.GATT_SUCCESS)
    }

    override fun onMtuChanged(g: BluetoothGatt, mtu: Int, status: Int) {
        mtuDone?.complete(if (status == BluetoothGatt.GATT_SUCCESS) mtu else 23)
    }

    override fun onCharacteristicWrite(g: BluetoothGatt, c: BluetoothGattCharacteristic, status: Int) {
        writeDone?.complete(status)
    }

    @Suppress("DEPRECATION")
    private fun startWrite(g: BluetoothGatt, c: BluetoothGattCharacteristic, part: ByteArray, type: Int): Boolean =
        if (Build.VERSION.SDK_INT >= 33) {
            g.writeCharacteristic(c, part, type) == BluetoothStatusCodes.SUCCESS
        } else {
            c.writeType = type
            c.value = part
            g.writeCharacteristic(c)
        }

    override suspend fun write(data: ByteArray) {
        val g = gatt ?: throw StaleLinkException()
        val c = ch ?: throw StaleLinkException()
        val size = PrinterProfile.chunkSize(mtu - 3)
        val type = if (noResponse) BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE else BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
        var off = 0
        while (off < data.size) {
            if (!isOpen) throw if (off == 0) StaleLinkException() else IOException("Máy in mất kết nối giữa chừng.")
            val end = minOf(off + size, data.size)
            val part = data.copyOfRange(off, end)
            val done = CompletableDeferred<Int>().also { writeDone = it }
            var started = false
            for (attempt in 0 until 50) {
                started = startWrite(g, c, part, type)
                if (started) break
                delay(20)
            }
            if (!started) throw if (off == 0) StaleLinkException() else IOException("Máy in không nhận dữ liệu.")
            val status = withTimeoutOrNull(10_000) { done.await() }
                ?: throw IOException("Máy in không phản hồi. Kiểm tra giấy, nắp máy rồi in lại.")
            if (status == -1) throw if (off == 0) StaleLinkException() else IOException("Máy in mất kết nối giữa chừng.")
            if (status != BluetoothGatt.GATT_SUCCESS) throw IOException("Máy in báo lỗi khi nhận dữ liệu (mã $status).")
            off = end
            if (noResponse) delay(PrinterProfile.pacingDelayMs(part.size))
        }
        // Ghi không phản hồi không có xác nhận: chờ một chút để gói cuối rời máy rồi mới báo xong.
        if (noResponse) delay(300)
    }

    override fun close() {
        isOpen = false
        gatt?.let {
            try {
                it.disconnect()
                it.close()
            } catch (_: Exception) {
            }
        }
        gatt = null
    }

    companion object {
        suspend fun open(context: Context, device: BluetoothDevice, onLost: () -> Unit): GattLink {
            val link = GattLink(device, onLost)
            link.connect(context)
            return link
        }
    }
}

/** Máy in Bluetooth Classic (SPP / RFCOMM) — loại mà iPhone không dùng được, Android thì được. */
@SuppressLint("MissingPermission")
class SppLink private constructor(private val socket: BluetoothSocket) : PrinterLink {
    @Volatile override var isOpen = true
        private set
    override val isRecognized = true

    override suspend fun write(data: ByteArray) = withContext(Dispatchers.IO) {
        var off = 0
        try {
            val out = socket.outputStream
            while (off < data.size) {
                val n = minOf(1024, data.size - off)
                out.write(data, off, n)
                off += n
            }
            out.flush()
            // Bộ đệm của máy in nhỏ: chờ dữ liệu ra hết trước khi báo xong.
            delay(minOf(1500L, 200L + data.size / 20))
        } catch (e: IOException) {
            isOpen = false
            throw if (off == 0) StaleLinkException() else IOException("Máy in mất kết nối giữa chừng.")
        }
    }

    override fun close() {
        isOpen = false
        try {
            socket.close()
        } catch (_: IOException) {
        }
    }

    companion object {
        private val SPP: UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")

        suspend fun open(adapter: BluetoothAdapter, device: BluetoothDevice): SppLink = withContext(Dispatchers.IO) {
            try {
                adapter.cancelDiscovery()
            } catch (_: Exception) {
            }
            val attempts = listOf<() -> BluetoothSocket>(
                { device.createRfcommSocketToServiceRecord(SPP) },
                { device.createInsecureRfcommSocketToServiceRecord(SPP) },
                {
                    // Một số máy in giá rẻ chỉ nhận kênh 1.
                    device.javaClass.getMethod("createRfcommSocket", Int::class.javaPrimitiveType)
                        .invoke(device, 1) as BluetoothSocket
                },
            )
            var last: Exception? = null
            for (make in attempts) {
                var s: BluetoothSocket? = null
                try {
                    s = make()
                    s.connect()
                    return@withContext SppLink(s)
                } catch (e: Exception) {
                    last = e
                    try {
                        s?.close()
                    } catch (_: IOException) {
                    }
                }
            }
            throw IOException(CONNECT_FAILED, last)
        }
    }
}
