package com.chotlive.app.model

import java.time.DayOfWeek
import java.time.LocalDate
import java.util.Locale

fun weekdayLabel(d: LocalDate): String =
    if (d.dayOfWeek == DayOfWeek.SUNDAY) "CN" else "T${d.dayOfWeek.value + 1}"

fun weekdayLabel(ms: Long) = weekdayLabel(Clock.day(ms))

fun shortDate(d: LocalDate): String = "${d.dayOfMonth}/${d.monthValue}"
fun shortDate(ms: Long) = shortDate(Clock.day(ms))

fun fullDate(d: LocalDate): String = "${shortDate(d)}/${d.year}"
fun fullDate(ms: Long) = fullDate(Clock.day(ms))

fun longWeekday(d: LocalDate): String {
    val w = weekdayLabel(d)
    return if (w == "CN") "Chủ nhật" else "Thứ " + w.drop(1)
}

fun timeText(ms: Long): String {
    val d = Clock.date(ms)
    return String.format(Locale.US, "%02d:%02d", d.hour, d.minute)
}

fun minuteText(m: Int): String = String.format(Locale.US, "%02d:%02d", m / 60, m % 60)

fun relativeDay(ms: Long): String = when {
    Clock.isToday(ms) -> "${timeText(ms)} nay"
    Clock.isYesterday(ms) -> "${timeText(ms)} hôm qua"
    else -> "${weekdayLabel(ms)} ${shortDate(ms)}"
}

fun compactMoney(n: Int): String = when {
    n >= 1_000_000 -> String.format(Locale.US, "%.2ftr", n / 1_000_000.0).replace(".", ",")
    n >= 1_000 -> "${n / 1_000}k"
    else -> "$n"
}

fun dayMonth(ms: Long): String {
    val d = Clock.date(ms)
    return String.format(Locale.US, "%02d/%02d", d.dayOfMonth, d.monthValue)
}

/** Nhãn trên nút chọn ngày: "Hôm nay · CN 25/10". */
val DateFilter.pillLabel: String
    get() = when (preset) {
        DateFilter.Preset.TODAY -> "Hôm nay · ${weekdayLabel(startDay)} ${shortDate(startDay)}"
        DateFilter.Preset.YESTERDAY -> "Hôm qua · ${weekdayLabel(startDay)} ${shortDate(startDay)}"
        DateFilter.Preset.LAST7 -> "7 ngày · đến ${shortDate(endDay)}"
        DateFilter.Preset.LAST30 -> "30 ngày · đến ${shortDate(endDay)}"
        DateFilter.Preset.THIS_MONTH, DateFilter.Preset.LAST_MONTH -> "Tháng ${startDay.monthValue}"
        DateFilter.Preset.CUSTOM ->
            if (isSingleDay) "${weekdayLabel(startDay)} ${shortDate(startDay)}"
            else "${shortDate(startDay)} – ${shortDate(endDay)}"
    }

/** Đuôi tiêu đề danh sách: "hôm nay", "hôm qua", "ngày 23/10"... */
val DateFilter.scopeLabel: String
    get() = when (preset) {
        DateFilter.Preset.TODAY -> "hôm nay"
        DateFilter.Preset.YESTERDAY -> "hôm qua"
        DateFilter.Preset.LAST7 -> "7 ngày qua"
        DateFilter.Preset.LAST30 -> "30 ngày qua"
        DateFilter.Preset.THIS_MONTH -> "tháng này"
        DateFilter.Preset.LAST_MONTH -> "tháng trước"
        DateFilter.Preset.CUSTOM -> if (isSingleDay) "ngày ${shortDate(startDay)}" else "đã chọn"
    }
