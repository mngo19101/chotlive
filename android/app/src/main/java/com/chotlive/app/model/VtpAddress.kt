package com.chotlive.app.model

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.text.Collator
import java.text.Normalizer
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap

// MARK: - Dữ liệu địa giới hành chính

/**
 * AddressData.json nhúng trong app, để chọn khu vực không cần mạng. Cùng danh mục Viettel Post với web và bản iPhone
 * (tạo bằng scripts/build-ios-address-data.mjs), nên tên chọn ở đây Viettel Post nhận ngay.
 * - "new" (34 tỉnh, 3.321 phường/xã): "TP.Hà Nội" → "Phường Cầu Giấy".
 * - "old" (63 tỉnh, 701 quận/huyện, 10.396 phường/xã): "TP.Hồ Chí Minh" → "Q.1" → "P.Bến Nghé".
 */
@Serializable
data class AreaUnit(
    val n: String,
    val d: List<AreaUnit>? = null,
    val w: List<String>? = null,
    /** Địa chỉ cũ: phường mới tương ứng của từng phường trong `w` ("Phường Sài Gòn, TP.Hồ Chí Minh"). */
    val e: List<String>? = null,
)

object AddressBook {
    @Serializable
    private data class Payload(val new: List<AreaUnit> = emptyList(), val old: List<AreaUnit> = emptyList())

    private val json = Json { ignoreUnknownKeys = true }

    /** Cách đọc nội dung AddressData.json: app gán lúc khởi động (đọc từ assets), test gán file trong thư mục dự án. */
    @Volatile var source: (() -> String)? = null

    @Volatile private var payload: Payload? = null

    private fun load(): Payload = payload ?: synchronized(this) {
        payload ?: (try {
            json.decodeFromString(Payload.serializer(), source?.invoke() ?: "{}")
        } catch (e: Exception) {
            Payload()
        }).also { if (source != null) payload = it }
    }

    val new: List<AreaUnit> get() = load().new
    val old: List<AreaUnit> get() = load().old

    private val collator: Collator = Collator.getInstance(Locale("vi", "VN"))
    private val chunks = Regex("\\d+|\\D+")

    /** So chữ tiếng Việt, số trong tên so theo giá trị: "Phường 2" đứng trước "Phường 10". */
    private fun compareNatural(a: String, b: String): Int {
        val pa = chunks.findAll(a).map { it.value }.toList()
        val pb = chunks.findAll(b).map { it.value }.toList()
        for (i in 0 until minOf(pa.size, pb.size)) {
            val x = pa[i]
            val y = pb[i]
            val c = if (x[0].isDigit() && y[0].isDigit()) x.toBigInteger().compareTo(y.toBigInteger()) else collator.compare(x, y)
            if (c != 0) return c
        }
        return pa.size - pb.size
    }

    fun sorted(names: List<String>): List<String> = names.sortedWith { a, b -> compareNatural(a, b) }

    /** Tỉnh xếp theo tên riêng, không theo chữ "TP." / "T.". */
    fun sortedProvinces(names: List<String>): List<String> {
        fun key(s: String): String {
            for (prefix in listOf("TP.", "T.")) if (s.startsWith(prefix)) return s.drop(prefix.length)
            return s
        }
        return names.sortedWith { a, b -> compareNatural(key(a), key(b)) }
    }
}

/**
 * Đối chiếu địa chỉ của khách với danh mục Viettel Post, viết lại từ public/js/vtp-address(-old).js của web.
 * Có quận/huyện là địa chỉ cũ (3 cấp), không có là địa chỉ mới (2 cấp), giống công tắc trong bảng chọn khu vực.
 */
object VtpAddress {
    data class Resolved(
        val ok: Boolean = false,
        val reason: String = "",
        val isOld: Boolean = false,
        val province: String = "",
        val district: String = "",
        val ward: String = "",
        val street: String = "",
        val newWard: String = "",
        val newProvince: String = "",
    ) {
        /** "Số nhà, Phường, (Quận,) Tỉnh" đúng tên Viettel Post. */
        val line: String get() = listOf(street, ward, district, province).filter { it.isNotEmpty() }.joinToString(", ")

        /** "Cầu Giấy, Hà Nội": phần khu vực rút gọn để hiện trong danh sách. */
        val shortArea: String
            get() = listOf(district.ifEmpty { ward }, province).filter { it.isNotEmpty() }.joinToString(", ") { plainName(it) }

        companion object {
            private val prefixes = listOf("TP.", "T.", "Q.", "H.", "TX.", "P.", "X.", "TT.", "Phường ", "Xã ", "Đặc khu ")

            fun plainName(s: String): String {
                for (p in prefixes) if (s.startsWith(p)) return s.drop(p.length)
                return s
            }
        }
    }

    // MARK: - So khớp tên

    private val marks = Regex("[\\u0300-\\u036F]")
    private val provincePrefix = Regex("^(thanh pho|tinh|tp\\.?|t\\.)\\s*")
    private val nonWord = Regex("[^a-z0-9]+")
    private val leadingZero = Regex("\\b0+(\\d)")
    private val spaces = Regex("\\s+")
    private val oldPrefixes = listOf(
        "^(thanh pho|tp)\\s+", "^(tinh|t)\\s+", "^(quan|q)\\s+", "^(huyen|h)\\s+",
        "^(thi xa|tx)\\s+", "^(phuong|p)\\s+", "^(thi tran|tt)\\s+", "^(xa|x)\\s+",
    ).map { Regex(it) }
    private val kinds = listOf(
        "^(thanh pho|tp)\\b" to "tp", "^(tinh|t)\\b" to "t", "^(quan|q)\\b" to "q", "^(huyen|h)\\b" to "h",
        "^(thi xa|tx)\\b" to "tx", "^(phuong|p)\\b" to "p", "^(thi tran|tt)\\b" to "tt", "^(xa|x)\\b" to "x",
    ).map { Regex(it.first) to it.second }

    // Danh mục có hơn 10.000 tên và mỗi lần so khớp chạy nhiều biểu thức chính quy: nhớ lại kết quả theo tên.
    private val normalizeCache = ConcurrentHashMap<String, String>()
    private val kindCache = ConcurrentHashMap<String, String>()
    private val oldKeyCache = ConcurrentHashMap<String, String>()
    private val plainKeyCache = ConcurrentHashMap<String, String>()

    /** Bỏ dấu, viết thường, bỏ tiền tố tỉnh/thành để so khớp tên gõ tay. */
    fun normalize(s: String): String = normalizeCache.getOrPut(s) {
        var n = Normalizer.normalize(s, Normalizer.Form.NFD).replace(marks, "")
        n = n.replace("đ", "d").replace("Đ", "D").lowercase()
        n = n.replace(provincePrefix, "")
        n.replace(nonWord, " ").trim()
    }

    /** Chữ "Ð" (eth) Viettel Post dùng trong vài tên tỉnh coi như "Đ". */
    private fun fixEth(s: String) = s.replace("Ð", "Đ")

    /** Loại cấp hành chính để "Quận 1" không khớp nhầm "H.1". */
    fun kind(s: String): String = kindCache.getOrPut(s) {
        val n = normalize(s.replace(".", ". "))
        kinds.firstOrNull { it.first.containsMatchIn(n) }?.second ?: ""
    }

    /** Tên bỏ dấu, bỏ tiền tố cấp, "Phường 01" = "P.1". */
    fun oldKey(s: String): String = oldKeyCache.getOrPut(s) {
        var n = normalize(fixEth(s).replace(".", ". "))
        oldPrefixes.firstOrNull { it.containsMatchIn(n) }?.let { n = n.replace(it, "") }
        n = n.replace(leadingZero, "$1")
        n.replace(spaces, " ").trim()
    }

    private fun plainKey(s: String): String = plainKeyCache.getOrPut(s) { normalize(fixEth(s)).replace(leadingZero, "$1") }

    fun sameName(a: String, b: String): Boolean {
        val ka = oldKey(a)
        val kb = oldKey(b)
        return ka == kb || ka == plainKey(b) || plainKey(a) == kb
    }

    fun sameUnit(a: String, b: String, allowed: List<String>? = null): Boolean {
        if (!sameName(a, b)) return false
        val ka = kind(a)
        val kb = kind(b)
        return ka.isEmpty() || kb.isEmpty() || ka == kb || (allowed != null && allowed.contains(ka) && allowed.contains(kb))
    }

    /** Đúng cấp trước; không có thì nhận khác cấp nếu tên chỉ có một ("X.Bình Khê" nay là "P.Bình Khê"). */
    private fun pick(names: List<String>, name: String): Int? {
        val i = names.indexOfFirst { sameUnit(it, name) }
        if (i >= 0) return i
        val loose = names.indices.filter { sameName(names[it], name) }
        return if (loose.size == 1) loose[0] else null
    }

    // MARK: - Tìm trong danh mục

    data class OldMatch(val province: String, val district: String, val ward: String, val newWard: String, val newProvince: String)

    fun findOld(province: String, district: String, ward: String): OldMatch? {
        if (province.isEmpty() || district.isEmpty() || ward.isEmpty()) return null
        for (p in AddressBook.old) {
            if (!sameUnit(p.n, province, listOf("t", "tp"))) continue
            val districts = p.d ?: emptyList()
            val di = pick(districts.map { it.n }, district) ?: continue
            val d = districts[di]
            val wards = d.w ?: emptyList()
            val wi = pick(wards, ward) ?: continue
            val parts = (d.e?.getOrNull(wi) ?: "").split(", ")
            return OldMatch(
                p.n, d.n, wards[wi],
                newWard = if (parts.size == 2) parts[0] else "", newProvince = if (parts.size == 2) parts[1] else "",
            )
        }
        return null
    }

    fun findNew(province: String, ward: String): Pair<String, String>? {
        if (ward.isEmpty()) return null
        val key = normalize(province)
        val prov = AddressBook.new.firstOrNull { it.n == province }
            ?: AddressBook.new.firstOrNull { key.isNotEmpty() && normalize(it.n) == key }
            ?: return null
        val wards = prov.w ?: emptyList()
        if (wards.contains(ward)) return prov.n to ward
        val w = normalize(ward)
        return wards.firstOrNull { normalize(it) == w }?.let { prov.n to it }
    }

    data class Parts(val ward: String, val district: String, val province: String)

    /** Tách "Phường, (Quận,) Tỉnh" đã lưu trong app. */
    fun split(region: String): Parts {
        val parts = region.split(",").map { it.trim() }.filter { it.isNotEmpty() }.toMutableList()
        val province = parts.removeLastOrNull() ?: ""
        val district = if (parts.size >= 2) parts.removeAt(parts.lastIndex) else ""
        return Parts(parts.joinToString(", "), district, province)
    }

    /** Địa chỉ có xuất sang Viettel Post được không, và viết ra sao. */
    fun resolve(a: DeliveryAddress?): Resolved {
        val parts = split(a?.region ?: "")
        return resolve(parts.province, parts.district, parts.ward, a?.street ?: "")
    }

    fun resolve(province: String, district: String, ward: String, street: String): Resolved {
        val base = Resolved(street = street.trim(), isOld = district.isNotBlank())
        val out = if (base.isOld) {
            val r = findOld(province, district, ward)
                ?: return base.copy(reason = "Địa chỉ cũ không có trong danh mục Viettel Post, chọn lại")
            base.copy(province = r.province, district = r.district, ward = r.ward, newWard = r.newWard, newProvince = r.newProvince)
        } else {
            if (province.isEmpty()) return base.copy(reason = "Chưa chọn tỉnh/thành theo Viettel Post")
            val r = findNew(province, ward) ?: return base.copy(reason = "Chưa chọn phường/xã theo Viettel Post")
            base.copy(province = r.first, ward = r.second)
        }
        if (out.street.isEmpty()) return out.copy(reason = "Thiếu số nhà, tên đường")
        return out.copy(ok = true)
    }
}
