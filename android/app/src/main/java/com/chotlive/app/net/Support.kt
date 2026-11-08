package com.chotlive.app.net

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.chotlive.app.MainActivity
import com.chotlive.app.R
import com.chotlive.app.data.bool
import com.chotlive.app.data.num
import com.chotlive.app.data.str
import kotlinx.serialization.json.JsonObject

data class SupportMessage(val id: Int, val sessionId: String, val sender: String, val text: String, val ts: Long) {
    val fromAdmin: Boolean get() = sender == "admin"

    companion object {
        fun from(d: JsonObject): SupportMessage? {
            val id = d.num("id")?.toInt() ?: return null
            val sessionId = d.str("sessionId") ?: return null
            val sender = d.str("sender") ?: return null
            val text = d.str("text") ?: return null
            return SupportMessage(id, sessionId, sender, text, d.num("ts")?.toLong() ?: 0)
        }
    }
}

data class SupportSession(
    val id: String, val createdAt: Long, val lastAt: Long, val closesAt: Long,
    val open: Boolean, val lastText: String, val lastSender: String,
) {
    companion object {
        fun from(d: JsonObject): SupportSession? {
            val id = d.str("id") ?: return null
            return SupportSession(
                id = id,
                createdAt = d.num("createdAt")?.toLong() ?: 0,
                lastAt = d.num("lastAt")?.toLong() ?: 0,
                closesAt = d.num("closesAt")?.toLong() ?: 0,
                open = d.bool("open") ?: false,
                lastText = d.str("lastText") ?: "",
                lastSender = d.str("lastSender") ?: "",
            )
        }
    }
}

data class SupportThread(val session: SupportSession, val messages: List<SupportMessage>) {
    val id: String get() = session.id
}

/** Báo khi Admin trả lời. Chỉ chạy lúc app còn nối server (đang mở hoặc vừa chuyển sang nền). */
class SupportNotifier(private val context: Context) {
    private var counter = 0

    init {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val ch = NotificationChannel(CHANNEL, "Hỗ trợ", NotificationManager.IMPORTANCE_HIGH)
            ch.description = "Báo khi quản trị viên trả lời tin nhắn hỗ trợ"
            context.getSystemService(NotificationManager::class.java).createNotificationChannel(ch)
        }
    }

    fun notify(text: String) {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) return
        val intent = Intent(context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            .putExtra(MainActivity.EXTRA_OPEN_SUPPORT, true)
        val pending = PendingIntent.getActivity(context, 1, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val n = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_chat)
            .setContentTitle("Admin đã trả lời")
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(pending)
            .build()
        try {
            NotificationManagerCompat.from(context).notify(1000 + (counter++ % 50), n)
        } catch (e: SecurityException) {
            // Người dùng tắt quyền thông báo.
        }
    }

    companion object {
        private const val CHANNEL = "support"
    }
}
