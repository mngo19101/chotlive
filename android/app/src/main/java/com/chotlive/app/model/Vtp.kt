package com.chotlive.app.model

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import java.io.ByteArrayOutputStream
import java.text.Normalizer
import java.util.Locale
import java.util.zip.CRC32

/**
 * Duyệt đơn, gom đơn theo khách và xuất file Excel Viettel Post.
 * Viết lại đúng cách tính của web (public/js/vtp-export.js) và bản iPhone để các bên ra cùng tiền thu hộ và cùng file.
 */
enum class ShipState(val raw: String) {
    /** Chưa duyệt (đơn mới). */
    ASK("ask"),
    /** Khách hẹn gom gửi sau. */
    HOLD("hold"),
    /** Đã duyệt, chờ xuất Viettel Post. */
    READY("ready"),
    /** Đã xuất file Viettel Post. */
    EXPORTED("exported"),
    /** Đã chuyển Đang giao / Đã giao mà không qua file xuất. */
    GONE("gone");

    val isPending: Boolean get() = this == ASK || this == HOLD || this == READY
}

object Vtp {
    const val DEFAULT_WEIGHT_G = 1000
    /** Từ cân nặng này Viettel Post cần kích thước kiện (dài, rộng, cao). */
    const val SIZE_REQUIRED_G = 10_000
    /** Đơn thu hộ dưới mức này mà shop trả cước thì cộng phí ship vào tiền thu hộ. */
    const val SMALL_ORDER_LIMIT = 17_000
    const val SMALL_ORDER_SHIP_FEE = 17_000
    /** Tên hàng hoá trên vận đơn: shop bán quần áo, không lấy tên/mã từ bình luận. */
    const val GOODS_NAME = "Quần áo"

    /** Gói dịch vụ; mặc định Flashsale thỏa thuận (VSL9), giống web. */
    val services = listOf("VSL9" to "Flashsale thỏa thuận", "STK" to "Chuyển phát tiêu chuẩn", "SCN" to "Chuyển phát nhanh")
    const val DEFAULT_SERVICE = "VSL9"

    fun state(o: Order): ShipState {
        if (o.status == OrderStatus.SHIPPING || o.status == OrderStatus.DELIVERED) {
            return if (o.ship?.state == ShipState.EXPORTED.raw) ShipState.EXPORTED else ShipState.GONE
        }
        return ShipState.entries.firstOrNull { it.raw == o.ship?.state } ?: ShipState.ASK
    }

    /** Đơn chưa gửi của cùng khách ở mọi ngày, cũ nhất trước. */
    fun pendingOrders(customerId: String, orders: List<Order>): List<Order> =
        orders.filter { it.customer.id == customerId && state(it).isPending }.sortedBy { it.lastTs }

    /** Đơn chưa gửi khác của khách, cũ hơn đơn đang xem: để hiện nhãn "Có N đơn gom từ dd/mm". */
    fun olderPending(order: Order, orders: List<Order>): List<Order> =
        pendingOrders(order.customer.id, orders).filter { it.id != order.id && it.lastTs <= order.lastTs }

    /** Đơn đã duyệt và mọi đơn chưa gửi khác của khách cũng đã duyệt: lúc xuất đã chung một vận đơn, không cần gộp nữa. */
    fun alreadyMerged(order: Order, others: List<Order>): Boolean =
        state(order) == ShipState.READY && others.all { state(it) == ShipState.READY }

    /** Đơn của khách đã xuất Viettel Post trong 3 ngày qua mà chưa giao xong: dễ thành 2 vận đơn. */
    fun recentExported(customerId: String, orders: List<Order>, now: Long = Clock.now): List<Order> =
        orders.filter {
            it.customer.id == customerId && it.status == OrderStatus.SHIPPING && it.ship?.state == ShipState.EXPORTED.raw &&
                now - (it.ship?.exportedAt ?: 0) < 3 * 86_400_000L
        }

    // MARK: - Tính tiền một vận đơn

    /** Một đơn trong vận đơn: tiền hàng, số món và cài đặt giao (có thể là bản tính thử trong bảng Duyệt đơn). */
    data class Line(val total: Int, val qty: Int, val ship: ShipInfo?)

    data class Summary(
        val allPaid: Boolean = false,
        val senderPays: Boolean = false,
        /** Bảng chọn người nhận trả nhưng đơn phải xuất người gửi trả (đơn dưới 17.000đ / bank đủ). */
        val forcedSender: Boolean = false,
        /** Phí ship đã cộng vào thu hộ (đơn nhỏ / bank đủ mà người nhận trả ship). */
        val shipFee: Int = 0,
        /** `shipFee` là cước thật Viettel Post báo (true) hay còn tạm tính theo 17.000đ (false). */
        val feeIsReal: Boolean = false,
        val deposit: Int = 0,
        val autoCod: Int = 0,
        val codOverridden: Boolean = false,
        val goods: Int = 0,
        val cod: Int = 0,
        val weightG: Int = DEFAULT_WEIGHT_G,
        /** Dài, rộng, cao (cm); null khi chưa nhập. */
        val size: Triple<Int, Int, Int>? = null,
        val qty: Int = 0,
        val receiver: String = "",
        val phone: String = "",
        val address: VtpAddress.Resolved = VtpAddress.Resolved(),
        val note: String = "",
        val problems: List<String> = emptyList(),
    )

    private fun <T> last(lines: List<Line>, field: (ShipInfo) -> T?): T? {
        for (l in lines.asReversed()) l.ship?.let(field)?.let { return it }
        return null
    }

    private val phonePattern = Regex("^(\\+?84|0)\\d{9,10}$")

    /**
     * `lines` cũ nhất trước: cài đặt của đơn mới nhất thắng, giống web.
     * `realFee`: cước thật Viettel Post vừa báo cho nháp này. Có thì đơn thu hộ thấp hơn cước đó chuyển
     * người gửi trả cước và cộng đúng cước đó vào thu hộ; chưa có thì tạm tính theo 17.000đ.
     */
    fun summarize(lines: List<Line>, address: DeliveryAddress?, nickname: String, realFee: Int? = null): Summary {
        // "shipOnly": dữ liệu cũ của web, coi như đã bank.
        val goodsPaid = { l: Line -> l.ship?.pay == "paid" || l.ship?.pay == "shipOnly" }
        val allPaid = lines.isNotEmpty() && lines.all(goodsPaid)
        val goods = lines.sumOf { maxOf(0, it.total) }
        val unpaidRaw = lines.filter { !goodsPaid(it) }.sumOf { maxOf(0, it.total) }
        val deposit = minOf(unpaidRaw, lines.sumOf { maxOf(0, it.ship?.deposit ?: 0) })
        val unpaid = unpaidRaw - deposit
        val feeIsReal = (realFee ?: 0) > 0
        val fee = if (feeIsReal) realFee!! else (last(lines) { it.shipFee } ?: SMALL_ORDER_SHIP_FEE)
        // Ngưỡng "đơn nhỏ": thu hộ thấp hơn tiền ship. Không thấp hơn 17.000đ, vì dưới mức đó Viettel Post
        // từ chối đơn người nhận trả cước dù cước thật có rẻ hơn.
        val limit = maxOf(SMALL_ORDER_LIMIT, fee)
        val payerRaw = last(lines) { it.payer?.takeIf { p -> p.isNotEmpty() } }
        val payer = if (payerRaw == "sender" || payerRaw == "receiver") payerRaw else if (allPaid) "sender" else "receiver"
        val override = last(lines) { it.codOverride }

        // Đơn thu hộ dưới 17.000đ: Viettel Post báo lỗi nếu người nhận trả cước, nên luôn xuất
        // người gửi trả và khách trả lại phí ship qua tiền thu hộ, kể cả khi bảng chọn người nhận.
        val small = !allPaid && unpaid < limit
        // Đã bank đủ mà người nhận trả ship: Viettel Post báo lỗi khi COD 0đ + người nhận trả,
        // nên xuất thành người gửi trả cước và thu hộ đúng phí ship.
        val bankShipByReceiver = allPaid && payer == "receiver"
        // Tiền thu hộ nhập tay cũng theo đúng quy tắc đó: số nhập dưới 17.000đ thì người gửi trả cước
        // và cộng phí ship vào số đã nhập, để khách nhận hàng trả đủ cả tiền ship.
        val overrideSmall = !allPaid && override != null && override < limit
        val senderPays = payer == "sender" || bankShipByReceiver || small || overrideSmall
        val addFee = bankShipByReceiver || small
        val autoCod = (if (allPaid) 0 else unpaid) + (if (addFee) fee else 0)
        val cod = if (override != null) (if (overrideSmall) override + fee else override) else autoCod
        val shipFee = if (override != null) (if (overrideSmall) fee else 0) else (if (addFee) fee else 0)
        val weightG = lines.mapNotNull { it.ship?.weightG }.filter { it > 0 }.maxOrNull() ?: DEFAULT_WEIGHT_G
        val l = last(lines) { it.lengthCm }
        val w = last(lines) { it.widthCm }
        val h = last(lines) { it.heightCm }
        val size = if (l != null && w != null && h != null && l > 0 && w > 0 && h > 0) Triple(l, w, h) else null

        val resolved = VtpAddress.resolve(address)
        val phone = (address?.phone ?: "").filter { it.isDigit() || it == '+' }
        val problems = mutableListOf<String>()
        if (!phonePattern.matches(phone)) problems += "Thiếu số điện thoại"
        if (!resolved.ok) problems += resolved.reason
        if (weightG >= SIZE_REQUIRED_G && size == null) problems += "Từ 10kg phải nhập kích thước"
        return Summary(
            allPaid = allPaid, senderPays = senderPays, forcedSender = payer == "receiver" && senderPays,
            shipFee = shipFee, feeIsReal = feeIsReal, deposit = deposit, autoCod = autoCod, codOverridden = override != null,
            goods = goods, cod = cod, weightG = weightG, size = size, qty = lines.sumOf { it.qty },
            receiver = cleanName(address?.receiver?.takeIf { it.isNotEmpty() } ?: nickname),
            phone = phone, address = resolved, note = address?.note ?: "", problems = problems,
        )
    }

    fun lines(orders: List<Order>): List<Line> = orders.map { Line(it.total, it.productCount, it.ship) }

    private val badNameChars = Regex("[^\\p{L}\\p{N}\\s.'-]")
    private val spaces = Regex("\\s+")

    /** Viettel Post không nhận emoji/ký tự lạ trong tên người nhận. */
    fun cleanName(s: String): String =
        Normalizer.normalize(s, Normalizer.Form.NFC).replace(badNameChars, " ").replace(spaces, " ").trim()

    // MARK: - Gom theo khách

    /** Một khách = một vận đơn: mọi đơn ĐÃ DUYỆT của khách ở mọi ngày gộp lại. */
    data class Group(
        val customer: Customer,
        val orders: List<Order>,
        val recentExported: List<Order>,
        val summary: Summary,
        /** Bản tạm tính (chưa cộng cước thật): chữ ký hỏi cước lấy từ đây để không đổi khi cước thật được áp vào. */
        val baseSummary: Summary? = null,
    ) {
        val id: String get() = customer.id
        val isBad: Boolean get() = summary.problems.isNotEmpty()
    }

    fun readyGroups(all: List<Order>, now: Long = Clock.now): List<Group> =
        all.filter { state(it) == ShipState.READY }.groupBy { it.customer.id }.values.map { list ->
            val orders = list.sortedBy { it.lastTs }
            val c = orders[0].customer
            Group(c, orders, recentExported(c.id, all, now), summarize(lines(orders), c.address, c.nickname))
        }.sortedBy { it.orders[0].lastTs }

    // MARK: - File Excel

    val headers = listOf(
        "STT", "Mã đơn hàng ", "Tên người nhận (*)", "Số ĐT người nhận (*)", "Địa chỉ nhận (*)", "Tên hàng hóa (*)",
        "Số lượng", "Trọng lượng (gram)  (*)", "Giá trị hàng (VND) (*)", "Tiền thu hộ COD (VND)", "Loại hàng hóa (*)",
        "Tính chất hàng hóa đặc biệt", "Dịch vụ  (*)", "Dịch vụ cộng thêm ", "Thu tiền xem hàng", "Dài (cm)", "Rộng (cm)",
        "Cao (cm)", "Người trả cước", "Yêu cầu khác", "Thời gian hẹn lấy", "Thời gian giao",
    )

    sealed interface Cell {
        data class Text(val value: String) : Cell
        data class Number(val value: Int) : Cell
    }

    /** Các dòng của trang tính, bố cục giống hệt file mẫu của Viettel Post (tiêu đề cột ở dòng 7). */
    fun rows(groups: List<Group>, service: String = DEFAULT_SERVICE): List<List<Cell?>> {
        fun t(s: String): Cell = Cell.Text(s)
        fun n(v: Int): Cell = Cell.Number(v)
        val rows = mutableListOf<List<Cell?>>(
            emptyList(),
            listOf(null, null, null, t("TẬP ĐOÀN CÔNG NGHIỆP - VIỄN THÔNG QUÂN ĐỘI")),
            listOf(null, null, null, t("TỔNG CÔNG TY CỔ PHẦN BƯU CHÍNH VIETTEL")),
            emptyList(),
            listOf(null, null, null, null, null, t("DANH SÁCH ĐƠN HÀNG")),
            listOf(t("(*) là các trường bắt buộc nhập")),
            headers.map { t(it) },
        )
        groups.forEachIndexed { i, g ->
            val s = g.summary
            val codes = g.orders.mapNotNull { it.code }.filter { it.isNotEmpty() }.joinToString("+").take(50)
            val note = s.note.take(150)
            val row = mutableListOf<Cell?>(n(i + 1), if (codes.isEmpty()) null else t(codes))
            row += listOf(t(s.receiver), t(s.phone), t(s.address.line), t(GOODS_NAME))
            row += listOf(n(maxOf(s.qty, 1)), n(s.weightG), n(s.goods), n(s.cod))
            row += listOf(t("Bưu kiện"), null, t(service.ifEmpty { DEFAULT_SERVICE }))
            row += listOf(null, null) // Dịch vụ cộng thêm: để trống, không SMS; Thu tiền xem hàng
            row += s.size?.let { listOf(n(it.first), n(it.second), n(it.third)) } ?: listOf(null, null, null)
            row += t(if (s.senderPays) "Người gửi trả" else "Người nhận trả")
            row += if (note.isEmpty()) null else t(note)
            row += listOf(null, null)
            rows += row
        }
        return rows
    }

    fun fileName(now: Long = Clock.now): String {
        val d = Clock.date(now)
        return String.format(Locale.US, "ViettelPost_%04d%02d%02d_%02d%02d.xlsx", d.year, d.monthValue, d.dayOfMonth, d.hour, d.minute)
    }

    fun xlsx(groups: List<Group>, service: String = DEFAULT_SERVICE): ByteArray =
        Xlsx.build(rows(groups, service), "Danh sách",
            listOf(6, 16, 22, 15, 48, 30, 9, 12, 14, 14, 12, 12, 14, 12, 10, 8, 8, 8, 16, 24, 16, 12))
}

/** File .xlsx tối giản (gói ZIP lưu thẳng, chuỗi trong sharedStrings), giống public/js/xlsx-writer.js. */
object Xlsx {
    fun crc32(data: ByteArray): Long = CRC32().apply { update(data) }.value

    private fun ByteArrayOutputStream.le16(v: Int) {
        write(v and 0xFF)
        write((v shr 8) and 0xFF)
    }

    private fun ByteArrayOutputStream.le32(v: Long) {
        for (i in 0 until 4) write(((v shr (8 * i)) and 0xFF).toInt())
    }

    fun zip(files: List<Pair<String, ByteArray>>): ByteArray {
        val out = ByteArrayOutputStream()
        val central = ByteArrayOutputStream()
        for ((fileName, data) in files) {
            val name = fileName.toByteArray(Charsets.UTF_8)
            val crc = crc32(data)
            val size = data.size.toLong()
            val offset = out.size().toLong()
            out.le32(0x04034B50); out.le16(20); out.le16(0x0800)
            out.le16(0); out.le16(0); out.le16(0) // lưu thẳng, không giờ
            out.le32(crc); out.le32(size); out.le32(size)
            out.le16(name.size); out.le16(0)
            out.write(name)
            out.write(data)

            central.le32(0x02014B50); central.le16(20); central.le16(20)
            central.le16(0x0800); central.le16(0); central.le16(0); central.le16(0)
            central.le32(crc); central.le32(size); central.le32(size)
            central.le16(name.size); central.le16(0); central.le16(0)
            central.le16(0); central.le16(0); central.le32(0); central.le32(offset)
            central.write(name)
        }
        val centralOffset = out.size().toLong()
        val centralBytes = central.toByteArray()
        out.write(centralBytes)
        out.le32(0x06054B50); out.le16(0); out.le16(0)
        out.le16(files.size); out.le16(files.size)
        out.le32(centralBytes.size.toLong()); out.le32(centralOffset); out.le16(0)
        return out.toByteArray()
    }

    fun escape(s: String): String {
        val out = StringBuilder()
        var i = 0
        while (i < s.length) {
            val cp = s.codePointAt(i)
            i += Character.charCount(cp)
            when {
                cp in 0x00..0x08 || cp == 0x0B || cp == 0x0C || cp in 0x0E..0x1F -> {} // ký tự điều khiển làm hỏng XML của Excel
                cp == 0x26 -> out.append("&amp;")
                cp == 0x3C -> out.append("&lt;")
                cp == 0x3E -> out.append("&gt;")
                cp == 0x22 -> out.append("&quot;")
                else -> out.appendCodePoint(cp)
            }
        }
        return out.toString()
    }

    fun colName(i: Int): String {
        var s = ""
        var n = i + 1
        while (n > 0) {
            s = ('A' + (n - 1) % 26) + s
            n = (n - 1) / 26
        }
        return s
    }

    fun build(rows: List<List<Vtp.Cell?>>, sheetName: String = "Sheet1", colWidths: List<Int> = emptyList()): ByteArray {
        val strings = mutableListOf<String>()
        val index = HashMap<String, Int>()
        fun sid(s: String): Int = index.getOrPut(s) {
            strings.add(s)
            strings.size - 1
        }

        val rowXml = StringBuilder()
        rows.forEachIndexed { r, row ->
            val cells = StringBuilder()
            row.forEachIndexed { c, cell ->
                val ref = "${colName(c)}${r + 1}"
                when (cell) {
                    null -> {}
                    is Vtp.Cell.Number -> cells.append("<c r=\"$ref\"><v>${cell.value}</v></c>")
                    is Vtp.Cell.Text -> if (cell.value.isNotEmpty()) cells.append("<c r=\"$ref\" t=\"s\"><v>${sid(cell.value)}</v></c>")
                }
            }
            rowXml.append("<row r=\"${r + 1}\">").append(cells).append("</row>")
        }

        val cols = if (colWidths.isEmpty()) "" else "<cols>" + colWidths.mapIndexed { i, w ->
            "<col min=\"${i + 1}\" max=\"${i + 1}\" width=\"$w\" customWidth=\"1\"/>"
        }.joinToString("") + "</cols>"
        val head = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n"
        val ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
        val rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
        val pkg = "http://schemas.openxmlformats.org/package/2006"
        val ct = "application/vnd.openxmlformats-officedocument.spreadsheetml"

        val sheet = head + "<worksheet xmlns=\"$ns\">$cols<sheetData>$rowXml</sheetData></worksheet>"
        val sst = head + "<sst xmlns=\"$ns\" count=\"${strings.size}\" uniqueCount=\"${strings.size}\">" +
            strings.joinToString("") { "<si><t xml:space=\"preserve\">${escape(it)}</t></si>" } + "</sst>"

        val files = listOf(
            "[Content_Types].xml" to head + "<Types xmlns=\"$pkg/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/xl/workbook.xml\" ContentType=\"$ct.sheet.main+xml\"/><Override PartName=\"/xl/worksheets/sheet1.xml\" ContentType=\"$ct.worksheet+xml\"/><Override PartName=\"/xl/sharedStrings.xml\" ContentType=\"$ct.sharedStrings+xml\"/><Override PartName=\"/xl/styles.xml\" ContentType=\"$ct.styles+xml\"/></Types>",
            "_rels/.rels" to head + "<Relationships xmlns=\"$pkg/relationships\"><Relationship Id=\"rId1\" Type=\"$rel/officeDocument\" Target=\"xl/workbook.xml\"/></Relationships>",
            "xl/workbook.xml" to head + "<workbook xmlns=\"$ns\" xmlns:r=\"$rel\"><sheets><sheet name=\"${escape(sheetName)}\" sheetId=\"1\" r:id=\"rId1\"/></sheets></workbook>",
            "xl/_rels/workbook.xml.rels" to head + "<Relationships xmlns=\"$pkg/relationships\"><Relationship Id=\"rId1\" Type=\"$rel/worksheet\" Target=\"worksheets/sheet1.xml\"/><Relationship Id=\"rId2\" Type=\"$rel/sharedStrings\" Target=\"sharedStrings.xml\"/><Relationship Id=\"rId3\" Type=\"$rel/styles\" Target=\"styles.xml\"/></Relationships>",
            "xl/styles.xml" to head + "<styleSheet xmlns=\"$ns\"><fonts count=\"1\"><font><sz val=\"11\"/><name val=\"Calibri\"/></font></fonts><fills count=\"2\"><fill><patternFill patternType=\"none\"/></fill><fill><patternFill patternType=\"gray125\"/></fill></fills><borders count=\"1\"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count=\"1\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\"/></cellStyleXfs><cellXfs count=\"1\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\"/></cellXfs></styleSheet>",
            "xl/worksheets/sheet1.xml" to sheet,
            "xl/sharedStrings.xml" to sst,
        )
        return zip(files.map { it.first to it.second.toByteArray(Charsets.UTF_8) })
    }
}

// MARK: - Vận đơn tạo qua API

/** Cước dự tính và địa chỉ Viettel Post hiểu cho một nháp (máy chủ hỏi giá, không tạo đơn). */
data class VtpQuote(
    val ok: Boolean,
    val fee: Int,
    /** "Phường Thuỷ Xuân, Thành phố Huế": phường/tỉnh Viettel Post đọc ra từ dòng địa chỉ. */
    val parsed: String,
    /** false khi phường/tỉnh Viettel Post hiểu khác app; null khi chưa đối chiếu được. */
    val addrOk: Boolean?,
    val error: String,
) {
    companion object {
        fun failed(error: String) = VtpQuote(false, 0, "", null, error)

        /** Chữ ký của nháp: đổi địa chỉ, tiền, cân nặng hay gói thì hỏi lại cước. */
        fun signature(g: Vtp.Group, service: String): String {
            val s = g.baseSummary ?: g.summary
            val size = s.size?.let { "${it.first}x${it.second}x${it.third}" } ?: ""
            return listOf(g.id, s.address.line, "${s.cod}", "${s.goods}", "${s.weightG}", size, service).joinToString("|")
        }
    }
}

/** Trạng thái vận đơn Viettel Post trên một đơn, dùng chung cho thẻ đơn, chi tiết đơn và tab Đang giao. */
object VtpTrack {
    /** Khổ tem in: A6 (mặc định, giống web), A5, giấy nhiệt 100mm. */
    val labelSizes = listOf("a6" to "A6", "a5" to "A5", "k100" to "Giấy nhiệt 100mm")

    fun code(o: Order): String? = o.ship?.vtpCode?.takeIf { it.isNotEmpty() }

    fun kind(o: Order): String = o.ship?.vtpKind?.takeIf { it.isNotEmpty() } ?: if (code(o) == null) "" else "created"

    /** Giao hỏng / chờ phát lại / đang hoàn: cần shop xử lý. */
    fun needsAction(o: Order): Boolean =
        code(o) != null && kind(o) in listOf("attention", "returned") && o.status != OrderStatus.DELIVERED

    /** Viettel Post đã trả hàng về shop: đơn vẫn nằm ở tab Đang giao nhưng trạng thái hiện "Hoàn về". */
    fun isReturned(o: Order): Boolean = code(o) != null && kind(o) == "returned" && o.status != OrderStatus.DELIVERED

    /** Huỷ được khi bưu tá chưa lấy hàng. */
    fun canCancel(o: Order): Boolean {
        if (code(o) == null || o.status == OrderStatus.DELIVERED) return false
        val k = kind(o)
        val s = o.ship?.vtpStatus ?: 0
        return k == "created" || (k == "moving" && s > 0 && s < 200)
    }

    fun statusName(o: Order): String {
        if (o.status == OrderStatus.DELIVERED) return o.ship?.vtpStatusName ?: "Giao thành công"
        if (isReturned(o)) return "Hoàn về"
        return o.ship?.vtpStatusName?.takeIf { it.isNotEmpty() } ?: "Chờ lấy hàng"
    }

    fun trackUrl(code: String): String =
        "https://viettelpost.vn/thong-tin-don-hang?peopleTracking=sender&orderNumber=" + java.net.URLEncoder.encode(code, "UTF-8")

    /** "1562 8812 0034": mã dài chia nhóm 4 số cho dễ đọc. */
    fun pretty(code: String): String =
        if (code.length > 8 && code.all { it.isDigit() }) code.chunked(4).joinToString(" ") else code

    /** Đơn chưa gửi mà lần tạo vận đơn gần nhất bị Viettel Post từ chối. */
    fun lastError(o: Order): String? =
        if (Vtp.state(o).isPending) o.ship?.vtpError?.takeIf { it.isNotEmpty() } else null

    /** Đơn đã về Chờ gửi vì vận đơn cũ bị huỷ. */
    fun cancelledCode(o: Order): String? =
        if (Vtp.state(o).isPending && o.ship?.vtpKind == "cancelled") o.ship?.vtpOldCode?.takeIf { it.isNotEmpty() } else null

    /** Các đơn chung vận đơn với đơn này (gộp lúc tạo), cũ nhất trước; chưa có vận đơn thì chỉ có chính nó. */
    fun sameWaybill(o: Order, all: List<Order>): List<Order> {
        val c = code(o) ?: return listOf(o)
        return all.filter { code(it) == c }.sortedBy { it.lastTs }.ifEmpty { listOf(o) }
    }

    /** Tiền thu hộ của vận đơn: tính lại như lúc tạo (COD nhập tay, tiền cọc, cước thật Viettel Post báo). */
    fun waybillCod(orders: List<Order>): Int {
        val c = orders.lastOrNull()?.customer ?: return 0
        val fee = orders.mapNotNull { it.ship?.vtpFee }.firstOrNull { it > 0 }
        return Vtp.summarize(Vtp.lines(orders), c.address, c.nickname, fee).cod
    }

    /** Danh sách đơn: các đơn chung một vận đơn chỉ giữ một thẻ (đơn gặp trước trong danh sách). */
    fun oneCardPerWaybill(list: List<Order>): List<Order> {
        val seen = HashSet<String>()
        return list.filter { o -> code(o)?.let { seen.add(it) } ?: true }
    }

    /** Dữ liệu một khách gửi lên máy chủ, cùng cách tính với file Excel và với web (vtpPayload). */
    fun payload(g: Vtp.Group, now: Long = Clock.now): JsonObject {
        val s = g.summary
        val codes = g.orders.mapNotNull { it.code }.filter { it.isNotEmpty() }.joinToString("+")
        val base = codes.ifEmpty { g.customer.id }
        // Vận đơn cũ đã huỷ thì Viettel Post không nhận lại đúng mã đơn đó: thêm hậu tố.
        val retry = if (g.orders.any { !it.ship?.vtpOldCode.isNullOrEmpty() }) "-" + now.toString(36).takeLast(4) else ""
        return buildJsonObject {
            put("key", g.id)
            putJsonArray("itemIds") { g.orders.forEach { o -> o.items.forEach { add(kotlinx.serialization.json.JsonPrimitive(it.id)) } } }
            put("ref", base.take(50 - retry.length) + retry)
            put("receiver", s.receiver)
            put("phone", s.phone)
            put("address", s.address.line)
            // Phường/tỉnh theo danh mục mới của Viettel Post để máy chủ đối chiếu với địa chỉ Viettel Post hiểu.
            putJsonObject("expect") {
                put("province", s.address.newProvince.ifEmpty { s.address.province })
                put("ward", s.address.newWard.ifEmpty { s.address.ward })
            }
            put("goodsName", Vtp.GOODS_NAME)
            put("qty", maxOf(s.qty, 1))
            put("weightG", s.weightG)
            put("goods", s.goods)
            put("cod", s.cod)
            put("senderPays", s.senderPays)
            put("note", s.note.take(150))
            s.size?.let { z ->
                put("size", buildJsonArray {
                    add(kotlinx.serialization.json.JsonPrimitive(z.first))
                    add(kotlinx.serialization.json.JsonPrimitive(z.second))
                    add(kotlinx.serialization.json.JsonPrimitive(z.third))
                })
            }
        }
    }
}
