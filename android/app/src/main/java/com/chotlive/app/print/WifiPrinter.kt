package com.chotlive.app.print

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.IOException
import java.net.ConnectException
import java.net.InetSocketAddress
import java.net.NoRouteToHostException
import java.net.Socket
import java.net.SocketTimeoutException

/** Địa chỉ máy in nhiệt nối mạng (dây LAN hoặc WiFi). Máy nhận lệnh ESC/POS thô qua TCP, thường ở cổng 9100. */
data class WifiPrinterAddress(val host: String, val port: Int) {
    val label: String get() = "$host:$port"

    companion object {
        const val DEFAULT_PORT = 9100

        /** Đọc IP và cổng người dùng gõ. Trả null khi IP hoặc cổng sai định dạng.
         *  Ô cổng để trống thì dùng 9100; dán cả "192.168.1.13:9100" vào ô IP cũng được. */
        fun parse(rawHost: String, rawPort: String): WifiPrinterAddress? {
            var host = rawHost.trim()
            var portText = rawPort.trim()
            val colon = host.indexOf(':')
            if (colon >= 0) {
                portText = host.substring(colon + 1)
                host = host.substring(0, colon)
            }
            if (!isIPv4(host)) return null
            if (portText.isEmpty()) return WifiPrinterAddress(host, DEFAULT_PORT)
            if (portText.length > 5 || !portText.all { it in '0'..'9' }) return null
            val port = portText.toInt()
            return if (port in 1..65535) WifiPrinterAddress(host, port) else null
        }

        fun isIPv4(s: String): Boolean {
            val parts = s.split('.')
            if (parts.size != 4) return false
            for (p in parts) {
                if (p.length !in 1..3 || !p.all { it in '0'..'9' } || p.toInt() > 255) return false
            }
            return parts[0] != "0"
        }
    }
}

/**
 * Gửi tem tới máy in mạng: mỗi tem mở một kết nối TCP, gửi hết rồi đóng.
 * Máy in mạng thường chỉ nhận một kết nối một lúc, giữ kết nối lâu sẽ chặn điện thoại khác in.
 * Người gọi phải gửi lần lượt từng tem (PrinterManager đã khoá bằng mutex).
 */
object WifiPrinter {
    private const val CONNECT_TIMEOUT_MS = 8_000
    private const val SEND_TIMEOUT_MS = 30_000L
    private const val DRAIN_MS = 3_000L

    /** null là đã gửi hết, ngược lại là lý do lỗi. */
    suspend fun send(context: Context, a: WifiPrinterAddress, data: ByteArray): String? = withContext(Dispatchers.IO) {
        val socket = Socket()
        try {
            // WiFi không có Internet thì Android có thể đi mạng di động: buộc socket đi qua WiFi để tới được máy in.
            wifiNetwork(context)?.let { runCatching { it.bindSocket(socket) } }
            socket.tcpNoDelay = true
            socket.connect(InetSocketAddress(a.host, a.port), CONNECT_TIMEOUT_MS)
            coroutineScope {
                // Máy in hết giấy có thể ngừng đọc làm lệnh ghi treo mãi: đóng socket để gỡ ra.
                val watchdog = launch {
                    delay(SEND_TIMEOUT_MS)
                    runCatching { socket.close() }
                }
                try {
                    socket.getOutputStream().apply {
                        write(data)
                        flush()
                    }
                    socket.shutdownOutput()
                } finally {
                    watchdog.cancel()
                }
            }
            drain(socket)
            null
        } catch (e: ConnectException) {
            if (e.message?.contains("ECONNREFUSED") == true)
                "Máy in ${a.host} không nhận kết nối ở cổng ${a.port}. Kiểm tra lại Port (thường là 9100)."
            else unreachable(a)
        } catch (e: NoRouteToHostException) {
            unreachable(a)
        } catch (e: SocketTimeoutException) {
            unreachable(a)
        } catch (e: IOException) {
            if (socket.isConnected) "Máy in không nhận hết dữ liệu. Kiểm tra giấy, nắp máy rồi in lại."
            else "${unreachable(a)} (${e.message})"
        } finally {
            runCatching { socket.close() }
        }
    }

    /** Đợi máy in đọc hết và tự đóng kết nối; máy không tự đóng thì thôi sau vài giây. */
    private fun drain(socket: Socket) {
        val end = System.currentTimeMillis() + DRAIN_MS
        try {
            val input = socket.getInputStream()
            val buf = ByteArray(256)
            while (true) {
                val left = end - System.currentTimeMillis()
                if (left <= 0) return
                socket.soTimeout = left.toInt()
                if (input.read(buf) < 0) return
            }
        } catch (_: IOException) {
        }
    }

    @Suppress("DEPRECATION")
    private fun wifiNetwork(context: Context): android.net.Network? {
        val cm = context.getSystemService(ConnectivityManager::class.java) ?: return null
        return cm.allNetworks.firstOrNull { n ->
            val caps = cm.getNetworkCapabilities(n) ?: return@firstOrNull false
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) || caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)
        }
    }

    private fun unreachable(a: WifiPrinterAddress) =
        "Không nối được máy in ${a.label}. Kiểm tra máy in đã bật, điện thoại dùng cùng WiFi với máy in và IP đúng."
}
