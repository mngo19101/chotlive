package com.chotlive.app.model

import java.text.Normalizer
import kotlin.math.roundToLong

/** Bắt giá từ bình luận (port từ public/js/price.js). "59" -> 59.000, "5k" -> 5.000, "1tr2" -> 1.200.000. */
object PriceParser {
    private val regex = Regex(
        """(?<![a-z\d])(\d{1,3}(?:[.,]\d{3})+|\d+(?:[.,]\d+)?)\s*(k|tr(?:ieu)?|cu|nghin|ngan|vnd|d)?(\d{1,3})?(?![a-z\d])"""
    )
    private val grouped = Regex("""^\d{1,3}(?:[.,]\d{3})+$""")
    private val marks = Regex("""\p{Mn}+""")

    fun stripAccents(s: String): String =
        marks.replace(Normalizer.normalize(s, Normalizer.Form.NFD), "")
            .replace("đ", "d").replace("Đ", "D")
            .let { Normalizer.normalize(it, Normalizer.Form.NFC) }

    /** Một số/giá tìm thấy trong bình luận. `start`/`end` là vị trí trong chuỗi đã bỏ dấu. */
    data class Token(val start: Int, val end: Int, val code: String, val price: Int)

    /** Trả về giá (đồng) hoặc 0 nếu không có giá. */
    fun parse(text: String): Int = tokens(text).maxOfOrNull { it.price } ?: 0

    private fun folded(text: String): String =
        stripAccents(Normalizer.normalize(text, Normalizer.Form.NFC).lowercase())

    /** Mọi số/giá trong bình luận, theo thứ tự xuất hiện. */
    fun tokens(text: String, multiplier: Double = 1000.0, minPrice: Double = 1.0, maxPrice: Double = 50_000_000.0): List<Token> {
        val s = folded(text)
        val found = mutableListOf<Token>()
        for (m in regex.findAll(s)) {
            val rawNum = m.groupValues[1]
            val unit = m.groupValues[2]
            val trail = m.groupValues[3]
            val digitsOnly = rawNum.replace(".", "").replace(",", "")
            if (digitsOnly.length >= 9) continue // số điện thoại / mã đơn

            val isGrouped = grouped.matches(rawNum)
            val bigUnit = unit in setOf("k", "tr", "trieu", "cu")
            val n: Double = if (isGrouped && !bigUnit) {
                digitsOnly.toDoubleOrNull() ?: 0.0
            } else {
                rawNum.replace(",", ".").toDoubleOrNull() ?: Double.NaN
            }
            if (n.isNaN()) continue

            var v: Double = when (unit) {
                "k", "nghin", "ngan" -> {
                    if (trail.isNotEmpty()) continue
                    n * 1000
                }
                "tr", "trieu", "cu" ->
                    n * 1_000_000 + (if (trail.isEmpty()) 0.0 else ("0.$trail".toDoubleOrNull() ?: 0.0) * 1_000_000)
                else -> {
                    if (trail.isNotEmpty()) continue
                    if (n >= 1000) n else n * multiplier
                }
            }
            v = Math.round(v).toDouble()
            if (v < minPrice || v > maxPrice) continue
            found.add(Token(m.range.first, m.range.last + 1, rawNum + unit + trail, v.roundToLong().toInt()))
        }
        return found
    }

    /** Các số đi liền nhau chỉ cách bởi "với", "và", dấu phẩy... ("120 với 180"). */
    private val connector = Regex("""^\s*(?:[,;+&/-]|va|voi)?\s*(?:ma\s+)?$""")
    private val codePrefix = Regex("""(?<![a-z\d])ma\s+$""")
    private val fillers = Regex("""(?<![a-z\d])(?:ma|va|voi)(?![a-z\d])|[\s,;+&/.-]""")

    /** Các mã khách chốt trong 1 bình luận: số có giá lớn nhất và các số nối liền với nó.
     *  Số nhỏ hơn 10k không tính vì thường là số lượng hoặc size ("lấy 2 cái 150"). */
    fun orderTokens(text: String): List<Token> {
        val all = tokens(text)
        if (all.isEmpty()) return emptyList()
        val best = all.indices.maxByOrNull { all[it].price } ?: return emptyList()
        val s = folded(text)
        fun linked(a: Token, b: Token): Boolean = connector.matches(s.substring(a.end, b.start))
        var from = best
        var to = best
        while (from > 0 && all[from - 1].price >= 10_000 && linked(all[from - 1], all[from])) from--
        while (to < all.size - 1 && all[to + 1].price >= 10_000 && linked(all[to], all[to + 1])) to++
        return all.subList(from, to + 1).toList()
    }

    /** Bình luận chỉ ghi mã/giá, không có chữ nào khác ("280", "mã 150, 180"). */
    fun isOnlyCodes(text: String): Boolean {
        val all = tokens(text)
        if (all.isEmpty()) return false
        val s = folded(text)
        val rest = StringBuilder()
        var cursor = 0
        for (t in all) {
            rest.append(s, cursor, t.start).append(' ')
            cursor = t.end
        }
        rest.append(s.substring(cursor))
        return fillers.replace(rest, "").isEmpty()
    }

    data class Segment(val text: String, val isCode: Boolean)

    /** Tách bình luận thành từng từ, phần mã ("Mã 150", "120") đứng riêng để tô nền. */
    fun segments(text: String): List<Segment> {
        val original = Normalizer.normalize(text, Normalizer.Form.NFC)
        val s = folded(text)
        fun words(x: String) = x.split(Regex("\\s+")).filter { it.isNotEmpty() }.map { Segment(it, false) }
        // Bỏ dấu làm đổi độ dài (rất hiếm) thì không tô để khỏi tô lệch chữ.
        if (s.length != original.length) return words(original)
        val result = mutableListOf<Segment>()
        var cursor = 0
        for (t in orderTokens(text)) {
            var start = t.start
            val before = s.substring(cursor, start)
            codePrefix.find(before)?.let { start = cursor + it.range.first }
            result += words(original.substring(cursor, start))
            result += Segment(original.substring(start, t.end), true)
            cursor = t.end
        }
        return result + words(original.substring(cursor))
    }
}

/** "419.000": số tiền không kèm đơn vị (dùng trong ô nhập). */
fun groupedNumber(n: Int): String {
    val neg = n < 0
    val digits = kotlin.math.abs(n.toLong()).toString()
    val sb = StringBuilder()
    digits.forEachIndexed { i, c ->
        if (i > 0 && (digits.length - i) % 3 == 0) sb.append('.')
        sb.append(c)
    }
    return (if (neg) "-" else "") + sb
}

/** Dùng trên tem in. */
fun vnd(n: Int): String = groupedNumber(n) + "đ"

/** Dùng trên giao diện: "4.860.000 ₫". */
fun money(n: Int): String = groupedNumber(n) + " ₫"
