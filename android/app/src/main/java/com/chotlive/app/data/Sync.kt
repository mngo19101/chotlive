package com.chotlive.app.data

import com.chotlive.app.model.Customer
import com.chotlive.app.model.LiveComment
import com.chotlive.app.model.LiveSession
import com.chotlive.app.model.TikTokAccount
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull

/** Định dạng dữ liệu trao đổi với server và lưu trên máy (mốc thời gian tính bằng mili giây). */
val AppJson = Json {
    ignoreUnknownKeys = true
    coerceInputValues = true
    explicitNulls = false
    encodeDefaults = true
    isLenient = true
}

/** Toàn bộ dữ liệu của tài khoản do server gửi xuống. */
@Serializable
data class ServerSnapshot(
    val customers: List<Customer> = emptyList(),
    val sessions: List<LiveSession> = emptyList(),
    val accounts: List<TikTokAccount> = emptyList(),
    val activeAccountId: String? = null,
    val printedCommentIds: List<String>? = null,
)

/** Thay đổi trên máy gửi lên server: chỉ gồm những gì vừa đổi. */
@Serializable
data class SyncUpdate(
    val type: String = "native_update",
    val id: Int,
    val customers: List<Customer>,
    val deletedItemIds: List<String>,
    val accounts: List<TikTokAccount>? = null,
    val deletedAccountIds: List<String>? = null,
    val activeAccountId: String? = null,
    /** Dữ liệu có sẵn trên máy từ trước khi đồng bộ, chỉ gửi ở lần đầu. */
    val sessions: List<LiveSession>? = null,
    val comments: List<LiveComment>? = null,
)

/** Những thay đổi chưa được server xác nhận. Lưu cùng dữ liệu để tắt app giữa chừng vẫn gửi được sau. */
@Serializable
data class SyncState(
    val syncedOnce: Boolean = false,
    val dirtyCustomers: Set<String> = emptySet(),
    val deletedItems: Set<String> = emptySet(),
    val deletedAccounts: Set<String> = emptySet(),
    val accountsDirty: Boolean = false,
) {
    val hasChanges: Boolean
        get() = !syncedOnce || dirtyCustomers.isNotEmpty() || deletedItems.isNotEmpty() || deletedAccounts.isNotEmpty() || accountsDirty
}

/** File lưu trên máy của một tài khoản. */
@Serializable
data class LocalSnapshot(
    val comments: List<LiveComment> = emptyList(),
    val customers: List<Customer> = emptyList(),
    val sessions: List<LiveSession> = emptyList(),
    val accounts: List<TikTokAccount> = emptyList(),
    val activeAccountId: String? = null,
    val keywords: List<String>? = null,
    val sync: SyncState? = null,
)

@Serializable
data class CommentsPage(val comments: List<LiveComment> = emptyList(), val hasMore: Boolean = false)

/** Vị trí để lấy trang bình luận cũ hơn. Nhiều bình luận có thể trùng thời gian nên phải kèm id. */
data class CommentCursor(val ms: Long, val id: String) {
    companion object {
        fun oldest(comments: List<LiveComment>): CommentCursor? =
            comments.map { CommentCursor(it.ts, it.id) }
                .minWithOrNull(compareBy<CommentCursor> { it.ms }.thenBy { it.id })
    }
}

/** Một live server đang theo dõi. */
data class LiveInfo(
    val username: String,
    val state: String,      // connecting | connected | reconnecting
    val message: String = "",
    val viewers: Int = 0,
    val sessionId: String = "",
) {
    val id: String get() = username.lowercase()

    companion object {
        fun from(o: JsonObject): LiveInfo? {
            val username = o.str("username")
            if (username.isNullOrEmpty()) return null
            return LiveInfo(
                username = username,
                state = o.str("state") ?: "connecting",
                message = o.str("message") ?: "",
                viewers = o.num("viewers")?.toInt() ?: 0,
                sessionId = o.str("sessionId") ?: "",
            )
        }
    }
}

/** Quyền dùng của tài khoản do server tính. Chỉ để hiển thị: việc chặn theo dõi live nằm ở server. */
data class AccountAccess(
    val status: String,     // admin | plan | trial | expired
    val canFollowLive: Boolean,
    val endsAt: Long?,
    val code: String = "",  // TRIAL_EXPIRED | PLAN_EXPIRED khi đã hết hạn
    val message: String = "",
) {
    companion object {
        fun from(o: JsonObject?): AccountAccess? {
            o ?: return null
            val status = o.str("status") ?: return null
            return AccountAccess(
                status = status,
                canFollowLive = o.bool("canFollowLive") ?: true,
                endsAt = o.num("endsAt")?.toLong(),
                code = o.str("code") ?: "",
                message = o.str("message") ?: "",
            )
        }

        /** Thời gian dùng thử còn lại, đếm tới từng giây: "2 ngày 13 giờ 04 phút 09 giây". */
        fun countdownText(end: Long?, now: Long): String {
            val total = Math.ceil(maxOf(0L, (end ?: now) - now) / 1000.0).toInt()
            val days = total / 86400
            val hours = total % 86400 / 3600
            val minutes = total % 3600 / 60
            val seconds = total % 60
            val pad = { n: Int -> if (n < 10) "0$n" else "$n" }
            val parts = mutableListOf<String>()
            if (days > 0) parts += "$days ngày"
            if (total >= 3600) parts += "$hours giờ"
            if (total >= 60) parts += "${pad(minutes)} phút"
            parts += "${pad(seconds)} giây"
            return parts.joinToString(" ")
        }

        fun remainingText(end: Long?, now: Long): String {
            val hours = (maxOf(0L, (end ?: now) - now) / 3_600_000).toInt()
            if (hours < 1) return "dưới 1 giờ"
            if (hours < 24) return "$hours giờ"
            return if (hours % 24 == 0) "${hours / 24} ngày" else "${hours / 24} ngày ${hours % 24} giờ"
        }
    }
}

// MARK: - Đọc JSON

fun JsonObject.str(k: String): String? = (this[k] as? JsonPrimitive)?.takeIf { it.isString }?.content
fun JsonObject.num(k: String): Double? = (this[k] as? JsonPrimitive)?.let { it.doubleOrNull ?: it.longOrNull?.toDouble() }
fun JsonObject.bool(k: String): Boolean? = (this[k] as? JsonPrimitive)?.booleanOrNull
fun JsonObject.obj(k: String): JsonObject? = this[k] as? JsonObject
fun JsonObject.arr(k: String): JsonArray? = this[k] as? JsonArray
fun JsonElement.asObj(): JsonObject? = this as? JsonObject
