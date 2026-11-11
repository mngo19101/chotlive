package com.chotlive.app

import android.app.Application
import android.media.AudioManager
import android.media.ToneGenerator
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.setValue
import com.chotlive.app.data.AuthStorage
import com.chotlive.app.data.Settings
import com.chotlive.app.data.Store
import com.chotlive.app.model.LiveComment
import com.chotlive.app.model.Order
import com.chotlive.app.net.LiveClient
import com.chotlive.app.net.SupportNotifier
import com.chotlive.app.print.PrinterManager
import com.chotlive.app.print.TicketRenderer
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.launch

/** Giữ các đối tượng dùng chung của app (giống các @StateObject trong ChotLiveApp.swift). */
class ChotLiveApp : Application() {
    lateinit var settings: Settings; private set
    lateinit var auth: AuthStorage; private set
    lateinit var store: Store; private set
    lateinit var client: LiveClient; private set
    lateinit var printer: PrinterManager; private set
    lateinit var tickets: TicketRenderer; private set
    lateinit var notifier: SupportNotifier; private set
    private val scope = MainScope()
    private var lastAlert = 0L
    /** Tăng mỗi lần bấm thông báo Admin trả lời: màn hình chính mở chat hỗ trợ. */
    var openSupportRequest by mutableIntStateOf(0)

    override fun onCreate() {
        super.onCreate()
        instance = this
        settings = Settings(this)
        auth = AuthStorage(this)
        notifier = SupportNotifier(this)
        store = Store(filesDir, auth.currentAccountKey())
        client = LiveClient(auth) { notifier.notify(it) }
        printer = PrinterManager(this)
        tickets = TicketRenderer(this, { settings.paperWidth }, { settings.shopName })

        client.onChat = { c ->
            store.addComment(c, client.liveUsername)
            if (store.isClosingComment(c)) playCommentAlert()
        }
        client.onAccountChange = { store.switchAccount(it) }
        client.onSnapshot = { store.applyServer(it) }
        client.onSyncAck = { id -> if (store.acknowledgeSync(id)) client.flushSync(store) }
        // Server từ chối gói: không chờ xác nhận nữa (không thì app ngừng đồng bộ tới khi nối lại),
        // đợi rồi gửi lại. Dữ liệu quá lớn thì thử thưa hơn vì gửi lại ngay cũng bị từ chối.
        client.onSyncError = { id, code ->
            if (store.syncRejected(id)) client.retrySync(store, if (code == "STATE_TOO_LARGE") 60_000L else 5_000L)
        }
        client.onSocketClosed = { store.syncInterrupted() }
        store.onLocalChange = { client.scheduleSync(store) }
        // Đặt sau cùng: có thể chạy ngay nếu server đã trả lời trước khi app sẵn sàng.
        client.onHello = { snap ->
            store.applyServer(snap)
            client.flushSync(store)
            scope.launch { client.catchUpComments(store) }
        }
    }

    /** Âm thanh / rung khi có bình luận chốt đơn (cài trong Tôi › Thông báo). */
    private fun playCommentAlert() {
        val now = System.currentTimeMillis()
        if (now - lastAlert < 1000) return
        lastAlert = now
        if (settings.notifySound) {
            try {
                ToneGenerator(AudioManager.STREAM_NOTIFICATION, 80).apply {
                    startTone(ToneGenerator.TONE_PROP_BEEP2, 150)
                    scope.launch {
                        kotlinx.coroutines.delay(400)
                        release()
                    }
                }
            } catch (_: Exception) {
            }
        }
        if (settings.notifyHaptic) {
            val vib = if (Build.VERSION.SDK_INT >= 31) getSystemService(VibratorManager::class.java)?.defaultVibrator
            else @Suppress("DEPRECATION") getSystemService(Vibrator::class.java)
            vib?.vibrate(VibrationEffect.createOneShot(60, VibrationEffect.DEFAULT_AMPLITUDE))
        }
    }

    /** Chốt 1 bình luận: luôn lưu vào khách/đơn hàng, rồi in tem nếu đã nối máy in.
     *  Chỉ đánh dấu đã in sau khi gửi hết dữ liệu tem. Trả về thông báo (null nếu thành công). */
    suspend fun printComment(c: LiveComment): String? {
        val items = store.saveToCustomer(c)
        if (!printer.hasPrinter) {
            return "Đã lưu đơn của ${c.nickname}. Chưa kết nối máy in nên chưa in tem — vào Tôi › Máy in để kết nối."
        }
        printer.sendAndWait(tickets.liveTicketBytes(c))?.let {
            return "Đã lưu đơn của ${c.nickname} nhưng chưa in được tem. $it"
        }
        items.forEach { store.markPrinted(it.id) }
        return null
    }

    /** In tem cho tất cả sản phẩm của đơn, dừng ở tem lỗi đầu tiên. Trả về thông báo (null nếu thành công). */
    suspend fun printOrder(o: Order): String? {
        if (!printer.hasPrinter) return "Chưa kết nối máy in — vào Tôi › Máy in để kết nối."
        var done = 0
        for (it in o.items) {
            val c = LiveComment(id = it.id, uniqueId = o.customer.uniqueId, userId = o.customer.userId,
                nickname = o.customer.nickname, text = it.ticketText, ts = it.ts, price = it.lineTotal)
            printer.sendAndWait(tickets.ticketBytes(c))?.let { err ->
                return "Mới gửi được $done/${o.items.size} tem. $err"
            }
            store.markPrinted(it.id)
            done++
        }
        return null
    }

    companion object {
        lateinit var instance: ChotLiveApp
            private set
    }
}
