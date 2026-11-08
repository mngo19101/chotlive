package com.chotlive.app.print

import java.util.Locale

/** Chọn kênh ghi ESC/POS của máy in Bluetooth LE (giống PrinterProfile bên iPhone). */
object PrinterProfile {
    data class Candidate(val service: String, val characteristic: String, val canWriteWithoutResponse: Boolean)
    data class Selection(val index: Int, val isRecognized: Boolean)

    /** Cặp dịch vụ/kênh ghi ESC/POS phổ biến, ưu tiên từ trên xuống. */
    private val knownEndpoints = listOf(
        "18F0" to "2AF1",
        "E7810A71-73AE-499D-8C15-FAA9AEF0C3F2" to "BEF8D6C9-9C21-4C9E-B632-BD58C1009F9F",
        "49535343-FE7D-4AE5-8FA9-9FAFD205E455" to "49535343-8841-43F4-A8D4-ECBE34729BB3",
        "FF00" to "FF02",
        "FFE0" to "FFE1",
    )

    /** Dịch vụ cập nhật firmware và dịch vụ chung của Bluetooth: tuyệt đối không ghi dữ liệu in vào đây. */
    private val excludedServices = setOf(
        "FE59", "00001530-1212-EFDE-1523-785FEABCD123", "F000FFC0-0451-4000-B000-000000000000",
        "1800", "1801", "180A",
    )

    /** Kênh điều khiển của module ISSC: chỉ dùng khi không còn kênh nào khác. */
    private val controlCharacteristics = setOf(
        "49535343-ACA3-481C-91EC-D85E28A60318",
        "49535343-6DAA-4D02-ABF6-19569ACA69FE",
    )

    private val printerNameHints = listOf(
        "print", "xp-", "pos", "mtp", "rpp", "pt-", "goojprt", "hoin", "thermal", "q80", "n160", "epson", "tm-", "bixolon",
    )

    /** Không gửi nhanh hơn mức này: bộ đệm của máy in giá rẻ dễ tràn, nhất là khi in ảnh raster. */
    const val BYTES_PER_SECOND = 10_000.0

    /** "00002AF1-0000-1000-8000-00805F9B34FB" và "2af1" là cùng một UUID. */
    fun normalize(uuid: String): String {
        val u = uuid.uppercase(Locale.ROOT)
        val suffix = "-0000-1000-8000-00805F9B34FB"
        if (u.length == 36 && u.startsWith("0000") && u.endsWith(suffix)) return u.substring(4, 8)
        return u
    }

    /** Chọn kênh ghi tốt nhất. Trả về null nếu thiết bị không có kênh nào dùng được để in. */
    fun pick(candidates: List<Candidate>): Selection? {
        var best: Triple<Int, Int, Boolean>? = null
        candidates.forEachIndexed { i, c ->
            val (base, recognized) = classify(c) ?: return@forEachIndexed
            // Cùng hạng thì ưu tiên ghi không cần phản hồi vì nhanh hơn nhiều.
            val rank = base * 2 + if (c.canWriteWithoutResponse) 0 else 1
            if (best == null || rank < best!!.second) best = Triple(i, rank, recognized)
        }
        return best?.let { Selection(it.first, it.third) }
    }

    private fun classify(c: Candidate): Pair<Int, Boolean>? {
        val service = normalize(c.service)
        val characteristic = normalize(c.characteristic)
        if (excludedServices.contains(service)) return null
        if (controlCharacteristics.contains(characteristic)) return 300 to false
        val i = knownEndpoints.indexOfFirst { it.first == service && it.second == characteristic }
        if (i >= 0) return i to true
        if (knownEndpoints.any { it.first == service }) return 100 to true
        return 200 to false
    }

    /** Gói ghi không vượt MTU thực tế của kết nối, tránh long write mà nhiều module BLE không hỗ trợ. */
    fun chunkSize(maxWithoutResponse: Int): Int = maxOf(20, minOf(maxWithoutResponse, 180))

    fun pacingDelayMs(bytes: Int): Long = (bytes / BYTES_PER_SECOND * 1000).toLong()

    /** Chỉ để xếp thiết bị lên đầu danh sách, không dùng để ẩn: nhiều máy in có tên rất lạ. */
    fun looksLikePrinter(name: String?, advertisedServices: List<String>): Boolean {
        val services = advertisedServices.map { normalize(it) }
        if (knownEndpoints.any { services.contains(it.first) }) return true
        val lower = name?.lowercase(Locale.ROOT) ?: return false
        return printerNameHints.any { lower.contains(it) }
    }
}
