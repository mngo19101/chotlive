package com.chotlive.app.model

import kotlinx.serialization.Serializable
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZonedDateTime

/** Đồng hồ của app (mili giây). */
object Clock {
    val now: Long get() = System.currentTimeMillis()
    val zone: ZoneId get() = ZoneId.systemDefault()

    fun date(ms: Long): ZonedDateTime = Instant.ofEpochMilli(ms).atZone(zone)
    fun day(ms: Long): LocalDate = date(ms).toLocalDate()
    fun today(): LocalDate = day(now)
    fun startOfDay(d: LocalDate): Long = d.atStartOfDay(zone).toInstant().toEpochMilli()
    fun isToday(ms: Long) = day(ms) == today()
    fun isYesterday(ms: Long) = day(ms) == today().minusDays(1)
    fun minuteOfDay(ms: Long): Int = date(ms).let { it.hour * 60 + it.minute }
}

@Serializable
data class LiveComment(
    val id: String,
    val uniqueId: String = "",
    val userId: String = "",
    val nickname: String = "",
    val text: String = "",
    val ts: Long = 0,
    val price: Int = 0,
    val printed: Boolean = false,
    val sessionId: String? = null,
)

/** Một phiên live đã ghi lại (từ lúc kết nối tới lúc ngắt). */
@Serializable
data class LiveSession(
    val id: String,
    val tiktok: String = "",
    val start: Long = 0,
    val end: Long? = null,
    val commentCount: Int = 0,
    val lastActivity: Long? = null,
) {
    val isLive: Boolean get() = end == null

    val title: String
        get() = when (Clock.date(start).hour) {
            in 5 until 11 -> "Phiên sáng"
            in 11 until 14 -> "Phiên trưa"
            in 14 until 18 -> "Phiên chiều"
            else -> "Phiên tối"
        }

    val duration: String
        get() {
            val mins = maxOf(((end ?: Clock.now) - start) / 60000, 0).toInt()
            return if (mins >= 60) "${mins / 60}g ${mins % 60}p" else "${mins}p"
        }
}

@Serializable
data class OrderItem(
    val id: String,          // = id bình luận
    val comment: String = "",
    val price: Int = 0,
    val ts: Long = 0,
    val printed: Boolean = false,
    val delivered: Boolean = false,
    val shipping: Boolean = false,
    val qty: Int = 1,
    /** Phiên live mà món này được chốt. */
    val sessionId: String? = null,
    /** Các món cùng groupId của 1 khách gộp thành 1 đơn. null = gộp theo ngày (dữ liệu cũ). */
    val groupId: String? = null,
    /** Mã sản phẩm. null = dữ liệu cũ, lấy từ nội dung bình luận. */
    val code: String? = null,
    /** Bình luận sinh ra món này (1 bình luận có thể chốt nhiều mã). */
    val commentId: String? = null,
) {
    val lineTotal: Int get() = price * maxOf(qty, 1)

    /** Mã để hiển thị và sửa. */
    val codeText: String get() = code ?: PriceParser.orderTokens(comment).firstOrNull()?.code ?: comment

    /** "Mã 150"; bình luận không có mã thì giữ nguyên nội dung bình luận. */
    val productLabel: String
        get() {
            val c = codeText
            return if (c == comment && c.contains(" ")) c else "Mã $c"
        }

    /** Nội dung in trên tem: bình luận chốt nhiều mã thì mỗi tem chỉ ghi mã của tem đó. */
    val ticketText: String
        get() = if (comment.isEmpty() || PriceParser.orderTokens(comment).size > 1) productLabel else comment
}

enum class OrderStatus(val label: String) {
    NEW("Đơn mới"), PRINTED("Đã in"), SHIPPING("Đang giao"), DELIVERED("Đã giao")
}

/** Đơn hàng = các món của 1 khách trong 1 phiên live (hoặc 1 đơn tạo tay). */
data class Order(val key: String, val customer: Customer, val items: List<OrderItem>) {
    val id: String get() = customer.id + "|" + key
    val total: Int get() = items.sumOf { it.lineTotal }
    val productCount: Int get() = items.sumOf { maxOf(it.qty, 1) }
    val lastTs: Long get() = items.maxOfOrNull { it.ts } ?: 0
    val firstTs: Long get() = items.minOfOrNull { it.ts } ?: 0
    val isPrinted: Boolean get() = items.isNotEmpty() && items.all { it.printed }

    val status: OrderStatus
        get() {
            if (items.isEmpty()) return OrderStatus.NEW
            if (items.all { it.delivered }) return OrderStatus.DELIVERED
            if (items.all { it.shipping || it.delivered }) return OrderStatus.SHIPPING
            if (items.all { it.printed }) return OrderStatus.PRINTED
            return OrderStatus.NEW
        }
}

@Serializable
data class DeliveryAddress(
    val receiver: String = "",
    val phone: String = "",
    val street: String = "",
    val region: String = "",
    val note: String = "",
) {
    fun hasNote(option: String) = noteParts(note).any { it.equals(option, ignoreCase = true) }

    /** Bật / tắt một lựa chọn; ghi chú khác đã có trong dữ liệu vẫn được giữ. */
    fun toggleNote(option: String): DeliveryAddress {
        val parts = noteParts(note)
        val isOption = { p: String -> noteOptions.any { it.equals(p, ignoreCase = true) } }
        val chosen = noteOptions.filter { o -> parts.any { it.equals(o, ignoreCase = true) } }.toMutableList()
        if (chosen.contains(option)) chosen.remove(option) else chosen.add(option)
        val all = noteOptions.filter { chosen.contains(it) } + parts.filter { !isOption(it) }
        val result = all.mapIndexed { i, p ->
            if (i > 0 && isOption(p) && p.isNotEmpty()) p.first().lowercase() + p.drop(1) else p
        }
        return copy(note = result.joinToString(", "))
    }

    companion object {
        val noteOptions = listOf("Giao giờ hành chính", "Gọi trước khi giao", "Cho xem hàng")
        private fun noteParts(note: String) = note.split(",").map { it.trim() }.filter { it.isNotEmpty() }
    }
}

@Serializable
data class Customer(
    val id: String,          // uniqueId viết thường (hoặc userId)
    val uniqueId: String = "",
    val userId: String = "",
    val nickname: String = "",
    val items: List<OrderItem> = emptyList(),
    val address: DeliveryAddress? = null,
) {
    val total: Int get() = items.sumOf { it.lineTotal }
    val lastTs: Long get() = items.maxOfOrNull { it.ts } ?: 0
    val firstTs: Long get() = items.minOfOrNull { it.ts } ?: 0
    val itemsToday: List<OrderItem> get() = items.filter { Clock.isToday(it.ts) }
    val isNewToday: Boolean get() = items.isNotEmpty() && Clock.isToday(firstTs)
    val isBigSpender: Boolean get() = total >= BIG_SPENDER
    val initials: String get() = initialsOf(nickname)

    companion object {
        /** Mức chi tiêu được gắn nhãn "Mua nhiều". */
        const val BIG_SPENDER = 3_000_000
    }
}

@Serializable
data class TikTokAccount(
    val id: String,          // uniqueId viết thường
    val uniqueId: String = "",
    val displayName: String = "",
) {
    val initials: String get() = initialsOf(displayName)
}

fun initialsOf(name: String): String {
    // Lấy chữ cái (theo code point) đầu mỗi từ, bỏ qua từ không có chữ như emoji, để không cắt đôi emoji thành "�".
    fun firstLetter(w: String): String? {
        var i = 0
        while (i < w.length) {
            val cp = w.codePointAt(i)
            if (Character.isLetterOrDigit(cp)) return String(Character.toChars(cp))
            i += Character.charCount(cp)
        }
        return null
    }
    val letters = name.split(" ").mapNotNull { firstLetter(it) }
    val s = when {
        letters.size >= 2 -> letters.first() + letters.last()
        else -> name.filter { it.isLetterOrDigit() }.take(2)
    }
    return s.uppercase().ifEmpty { "?" }
}

/** Khoảng thời gian đang xem (dùng chung cho Bình luận và Đơn hàng). */
data class DateFilter(
    val preset: Preset = Preset.TODAY,
    val startDay: LocalDate,
    val endDay: LocalDate,
    val fromMinute: Int = 0,
    val toMinute: Int = 1439,
) {
    enum class Preset { TODAY, YESTERDAY, LAST7, LAST30, THIS_MONTH, LAST_MONTH, CUSTOM }

    val isSingleDay: Boolean get() = startDay == endDay
    val spanDays: Int get() = (endDay.toEpochDay() - startDay.toEpochDay()).toInt() + 1
    val canGoNext: Boolean get() = endDay < Clock.today()

    /** Lùi / tiến đúng bằng độ dài khoảng đang xem. */
    fun shifted(direction: Int): DateFilter {
        val offset = (direction * spanDays).toLong()
        val s = startDay.plusDays(offset)
        val e = endDay.plusDays(offset)
        val next = if (isSingleDay) single(s) else DateFilter(Preset.CUSTOM, s, e)
        return next.copy(fromMinute = fromMinute, toMinute = toMinute)
    }

    private fun dayInRange(ms: Long): Boolean {
        val d = Clock.day(ms)
        return d >= startDay && d <= endDay
    }

    fun contains(ms: Long): Boolean {
        if (!dayInRange(ms)) return false
        val m = Clock.minuteOfDay(ms)
        return m in fromMinute..toMinute
    }

    fun overlaps(s: LiveSession): Boolean {
        if (!dayInRange(s.start)) return false
        val from = Clock.minuteOfDay(s.start)
        val to = maxOf(Clock.minuteOfDay(s.end ?: Clock.now), from)
        return from <= toMinute && to >= fromMinute
    }

    companion object {
        fun make(preset: Preset): DateFilter {
            val today = Clock.today()
            val month = today.withDayOfMonth(1)
            return when (preset) {
                Preset.TODAY, Preset.CUSTOM -> DateFilter(preset, today, today)
                Preset.YESTERDAY -> today.minusDays(1).let { DateFilter(preset, it, it) }
                Preset.LAST7 -> DateFilter(preset, today.minusDays(6), today)
                Preset.LAST30 -> DateFilter(preset, today.minusDays(29), today)
                Preset.THIS_MONTH -> DateFilter(preset, month, today)
                Preset.LAST_MONTH -> DateFilter(preset, month.minusMonths(1), month.minusDays(1))
            }
        }

        fun single(d: LocalDate): DateFilter {
            val today = Clock.today()
            if (d == today) return make(Preset.TODAY)
            if (d == today.minusDays(1)) return make(Preset.YESTERDAY)
            return DateFilter(Preset.CUSTOM, d, d)
        }
    }
}
