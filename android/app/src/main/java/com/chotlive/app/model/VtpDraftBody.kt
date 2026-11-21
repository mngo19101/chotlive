package com.chotlive.app.model

import com.chotlive.app.net.VtpDraftClient
import com.chotlive.app.net.VtpDraftKho
import com.chotlive.app.net.VtpDraftPlace
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.security.MessageDigest

/**
 * Dựng nội dung nháp Viettel Post (InsertOrderDraftForWeb) từ một khách đã gom (Vtp.Group) và biết nháp
 * trên Viettel Post còn khớp đơn hiện tại không. Giống VtpDraftBody.swift.
 *
 * Tiền thu hộ, ai trả cước, cân nặng, người nhận lấy NGUYÊN từ `Vtp.summarize` (cùng cách tính với file Excel
 * và vận đơn API đối tác), không tính lại ở đây.
 */
object VtpDraftBody {
    /** 1: không thu hộ; 2: thu hộ tiền hàng + cước (người nhận trả); 3: thu hộ tiền hàng; 4: chỉ thu hộ cước. */
    fun payment(cod: Int, senderPays: Boolean): Int = if (cod > 0) (if (senderPays) 3 else 2) else (if (senderPays) 1 else 4)

    /** Lý do không đẩy nháp được (trống = đẩy được). */
    fun problems(g: Vtp.Group): List<String> {
        val p = g.summary.problems.toMutableList()
        if (g.orders.any { !it.ship?.vtpCode.isNullOrEmpty() }) p += "Khách đã có vận đơn"
        return p
    }

    /** Địa chỉ đưa cho dịch vụ tra mã của Viettel Post (`VtpDraftClient.locate`). */
    fun addressLine(g: Vtp.Group): String = g.summary.address.line

    fun make(g: Vtp.Group, kho: VtpDraftKho, place: VtpDraftPlace, service: String, now: Long = Clock.now): JsonObject {
        val s = g.summary
        val quantity = maxOf(1, s.qty)
        val (len, wid, hei) = s.size ?: Triple(0, 0, 0)
        val svc = service.ifEmpty { Vtp.DEFAULT_SERVICE }
        val weight = maxOf(1, s.weightG)
        return buildJsonObject {
            put("ORDER_NUMBER", "")
            put("ORDER_REFERENCE", reference(g))
            put("ORDER_TYPE", 1)
            put("TYPE", 12)
            put("DELIVERY_DATE", VtpDraftClient.dateText(now))
            put("GROUPADDRESS_ID", kho.id)
            put("CUS_ID", kho.cusId)
            put("SENDER_FULLNAME", clip(kho.name))
            put("SENDER_ADDRESS", clip(kho.address))
            put("SENDER_PHONE", kho.phone)
            put("SENDER_EMAIL", "")
            put("SENDER_PROVINCE", kho.province.toString())
            put("SENDER_DISTRICT", kho.district.toString())
            put("SENDER_WARD", kho.ward.toString())
            put("SENDER_LATITUDE", 0)
            put("SENDER_LONGITUDE", 0)
            put("RECEIVER_FULLNAME", clip(s.receiver))
            put("RECEIVER_ADDRESS", clip(s.address.line))
            put("RECEIVER_PHONE", s.phone)
            put("RECEIVER_EMAIL", "")
            put("RECEIVER_PROVINCE", place.province)
            put("RECEIVER_DISTRICT", place.district)
            put("RECEIVER_WARD", place.ward)
            put("RECEIVER_LATITUDE", 0)
            put("RECEIVER_LONGITUDE", 0)
            put("PRODUCT_NAME", Vtp.GOODS_NAME)
            put("PRODUCT_DESCRIPTION", "")
            put("PRODUCT_QUANTITY", quantity)
            put("PRODUCT_PRICE", s.goods)
            put("PRODUCT_WEIGHT", weight)
            put("PRODUCT_LENGTH", len)
            put("PRODUCT_WIDTH", wid)
            put("PRODUCT_HEIGHT", hei)
            put("PRODUCT_TYPE", "HH")
            put("ORDER_PAYMENT", payment(s.cod, s.senderPays))
            put("ORDER_SERVICE", svc)
            put("ORDER_SERVICE_ADD", "")
            put("ORDER_VOUCHER", "")
            put("ORDER_NOTE", clip(s.note))
            put("DELIVERY_CODE", -1)
            put("MONEY_COLLECTION", s.cod)
            for (k in listOf("MONEY_TOTALFEE", "MONEY_FEECOD", "MONEY_FEEVAS", "MONEY_FEEINSURRANCE", "MONEY_FEE",
                "MONEY_FEEOTHER", "MONEY_TOTALVAT", "MONEY_TOTAL")) put(k, 0)
            put("LIST_ITEM", JsonArray(listOf(buildJsonObject {
                put("ORDER_NUMBER_ITEM", 1)
                put("PRODUCT_NAME", Vtp.GOODS_NAME)
                put("PRODUCT_QUANTITY", quantity)
                put("PRODUCT_WEIGHT", weight)
                put("PRODUCT_PRICE", s.goods)
            })))
            put("OPTION_LOCATION", 0)
            put("REMOVE_PICKUP_DATE", true)
            put("XMG_EXTRA_MONEY", 0)
        }
    }

    private val badRef = Regex("[^A-Za-z0-9_+-]+")

    /** Mã đơn ChốtLive của các đơn trong nháp (giống cột "Mã đơn hàng" file Excel), tối đa 50 ký tự. */
    fun reference(g: Vtp.Group): String {
        val codes = g.orders.mapNotNull { it.code }.filter { it.isNotEmpty() }.joinToString("+")
        return badRef.replace(codes, "-").take(50)
    }

    /** Viettel Post giới hạn 150 BYTE: cắt theo byte, không cắt giữa ký tự. */
    fun clip(s: String, max: Int = 150): String {
        val out = StringBuilder()
        var bytes = 0
        var i = 0
        while (i < s.length) {
            val cp = s.codePointAt(i)
            val ch = String(Character.toChars(cp))
            val n = ch.toByteArray(Charsets.UTF_8).size
            if (bytes + n > max) break
            out.append(ch)
            bytes += n
            i += Character.charCount(cp)
        }
        return out.toString()
    }

    // MARK: - Nháp còn khớp đơn không

    /**
     * Băm những gì quyết định nội dung nháp: người nhận, địa chỉ, tiền, ai trả cước, cân nặng, kích thước,
     * dịch vụ, ghi chú và danh sách đơn. Đổi một trong số đó là nháp trên Viettel Post đã cũ. Cùng cách băm
     * với iPhone để nháp đẩy từ máy này vẫn được máy kia coi là khớp.
     */
    fun hash(g: Vtp.Group, service: String): String {
        // Bản tạm tính (chưa áp cước thật): cước Viettel Post báo về sau không làm nháp vừa đẩy bị coi là cũ.
        val s = g.baseSummary ?: g.summary
        val size = s.size?.let { "${it.first}x${it.second}x${it.third}" } ?: ""
        val parts = listOf(
            s.receiver, s.phone, s.address.line, s.goods.toString(), s.cod.toString(), if (s.senderPays) "S" else "R",
            s.weightG.toString(), size, maxOf(1, s.qty).toString(), service.ifEmpty { Vtp.DEFAULT_SERVICE }, s.note,
            g.orders.map { it.id }.sorted().joinToString(","),
        )
        val digest = MessageDigest.getInstance("SHA-256").digest(parts.joinToString("|").toByteArray(Charsets.UTF_8))
        return digest.take(8).joinToString("") { "%02x".format(it) }
    }

    sealed class Status {
        /** Chưa đẩy lần nào (hoặc đã bỏ nhãn). */
        object NotPushed : Status()
        /** Đã có nháp trên Viettel Post, khớp đơn hiện tại. */
        data class Pushed(val code: String, val at: Long?) : Status()
        /** Có nháp nhưng đơn đã sửa / thêm đơn sau khi đẩy: cần đẩy lại. */
        data class Stale(val code: String) : Status()
        /** Lần đẩy gần nhất lỗi và chưa có nháp nào. */
        data class Failed(val error: String) : Status()
    }

    fun status(g: Vtp.Group, service: String): Status {
        val ships = g.orders.map { it.ship }
        val codes = ships.mapNotNull { it?.draftCode }.filter { it.isNotEmpty() }.toSet()
        val code = codes.sorted().lastOrNull()
        if (code != null) {
            val current = hash(g, service)
            val allSame = codes.size == 1 && ships.all { it?.draftCode == code && it.draftHash == current }
            return if (allSame) Status.Pushed(code, ships.mapNotNull { it?.draftAt }.maxOrNull()) else Status.Stale(code)
        }
        val e = ships.mapNotNull { it?.draftError }.lastOrNull()
        if (!e.isNullOrEmpty()) return Status.Failed(e)
        return Status.NotPushed
    }

    /** Mọi mã nháp đang gắn với khách (thường 1; nhiều hơn khi có đơn đẩy riêng trước đó): để xoá hết khi đẩy lại. */
    fun codes(g: Vtp.Group): List<String> = g.orders.mapNotNull { it.ship?.draftCode }.filter { it.isNotEmpty() }.toSet().sorted()
}
