package com.chotlive.app

import com.chotlive.app.data.AppJson
import com.chotlive.app.data.ServerSnapshot
import com.chotlive.app.data.Store
import com.chotlive.app.data.wholeNumbers
import com.chotlive.app.model.AddressBook
import com.chotlive.app.model.Customer
import com.chotlive.app.model.DeliveryAddress
import com.chotlive.app.model.LiveComment
import com.chotlive.app.model.Order
import com.chotlive.app.model.OrderItem
import com.chotlive.app.model.ShipInfo
import com.chotlive.app.model.ShipState
import com.chotlive.app.model.Vtp
import com.chotlive.app.model.VtpAddress
import com.chotlive.app.model.VtpTrack
import com.chotlive.app.model.Xlsx
import com.chotlive.app.ui.weightText
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.nio.file.Files

/** Duyệt đơn và xuất Viettel Post: cùng kết quả với web (test/vtp-export.test.js) và bản iPhone (VtpExportTests). */
class VtpTest {
    private val address = DeliveryAddress(receiver = "Lan Anh 🌸", phone = "0912 345 678", street = "12 Trần Thái Tông",
        region = "Phường Cầu Giấy, TP.Hà Nội")

    @Before
    fun loadAddressBook() {
        AddressBook.source = { File("src/main/assets/AddressData.json").readText() }
    }

    private fun customer(id: String = "lan.anh", a: DeliveryAddress? = address) =
        Customer(id = id, uniqueId = id, userId = "", nickname = "Lan", address = a)

    private fun order(key: String, price: Int = 150_000, qty: Int = 1, ts: Long = 1_000_000, ship: ShipInfo?,
                      shipping: Boolean = false, delivered: Boolean = false): Order =
        Order(key, customer(), listOf(OrderItem(id = "$key-1", comment = "chốt", price = price, ts = ts, qty = qty, groupId = key,
            ship = ship, shipping = shipping, delivered = delivered, orderCode = "HD$key")))

    private fun line(price: Int, ship: ShipInfo) = Vtp.Line(price, 1, ship)
    private fun cod(lines: List<Vtp.Line>, fee: Int? = null) = Vtp.summarize(lines, address, "Lan", fee)

    @Test
    fun shipStateFollowsWebRules() {
        assertEquals(ShipState.ASK, Vtp.state(order("a", ship = null)))
        assertEquals(ShipState.HOLD, Vtp.state(order("a", ship = ShipInfo(state = "hold"))))
        assertEquals(ShipState.GONE, Vtp.state(order("a", ship = ShipInfo(state = "ready"), shipping = true)))
        assertEquals(ShipState.EXPORTED, Vtp.state(order("a", ship = ShipInfo(state = "exported"), shipping = true)))
    }

    @Test
    fun ordersSharingAWaybillShowOneCardWithTheWaybillCod() {
        // Gộp 2 đơn 220.000 + 210.000 thành một vận đơn, shop sửa thu hộ còn 40.000.
        val sent = { cod: Int? -> ShipInfo(state = "exported", pay = "cod", codOverride = cod, vtpCode = "157166042039", vtpFee = 18_480) }
        val a = order("a", 220_000, ts = 1_000, ship = sent(null), shipping = true)
        val b = order("b", 210_000, ts = 2_000, ship = sent(40_000), shipping = true)
        val other = order("c", 99_000, ts = 3_000, ship = ShipInfo(state = "ready"))
        val all = listOf(b, other, a)
        val key = { o: Order -> o.id.substringAfterLast('|') }
        assertEquals(listOf("a", "b"), VtpTrack.sameWaybill(b, all).map(key))
        assertEquals(40_000, VtpTrack.waybillCod(VtpTrack.sameWaybill(a, all)))
        assertEquals(listOf("b", "c"), VtpTrack.oneCardPerWaybill(all).map(key))
        assertEquals(listOf("c"), VtpTrack.sameWaybill(other, all).map(key))
        // Không sửa thu hộ: thu đủ tiền hàng hai đơn.
        val a2 = order("a", 220_000, ts = 1_000, ship = sent(null), shipping = true)
        val b2 = order("b", 210_000, ts = 2_000, ship = sent(null), shipping = true)
        assertEquals(430_000, VtpTrack.waybillCod(listOf(a2, b2)))
    }

    @Test
    fun codRules() {
        // Gộp 2 đơn thu tiền hàng.
        assertEquals(419_000, cod(listOf(line(120_000, ShipInfo(pay = "cod")), line(299_000, ShipInfo(pay = "cod")))).cod)
        // Đơn nhỏ, người gửi trả: cộng 17.000đ.
        val small = cod(listOf(line(10_000, ShipInfo(pay = "cod", payer = "sender"))))
        assertEquals(27_000, small.cod)
        assertEquals(17_000, small.shipFee)
        assertTrue(small.senderPays)
        // Đơn nhỏ mà chọn người nhận trả: vẫn xuất người gửi trả và cộng 17.000đ.
        val smallReceiver = cod(listOf(line(15_000, ShipInfo(pay = "cod", payer = "receiver"))))
        assertEquals(32_000, smallReceiver.cod)
        assertTrue(smallReceiver.senderPays)
        assertTrue(smallReceiver.forcedSender)
        assertFalse(cod(listOf(line(17_000, ShipInfo(pay = "cod", payer = "receiver")))).senderPays)
        // Bank đủ + người gửi trả: 0đ. Bank đủ + người nhận trả: thu 17.000đ, xuất người gửi trả.
        assertEquals(0, cod(listOf(line(150_000, ShipInfo(pay = "paid", payer = "sender")))).cod)
        val bankReceiver = cod(listOf(line(150_000, ShipInfo(pay = "paid", payer = "receiver"))))
        assertEquals(17_000, bankReceiver.cod)
        assertTrue(bankReceiver.senderPays)
        // Cọc trừ vào COD; còn dưới 17.000đ mà người gửi trả thì cộng phí.
        assertEquals(100_000, cod(listOf(line(150_000, ShipInfo(pay = "cod", deposit = 50_000)))).cod)
        assertEquals(27_000, cod(listOf(line(150_000, ShipInfo(pay = "cod", payer = "sender", deposit = 140_000)))).cod)
        // Nhập tay thắng số tự tính.
        assertEquals(123_000, cod(listOf(line(150_000, ShipInfo(pay = "cod", codOverride = 123_000)))).cod)
        // Nhập tay dưới 17.000đ: người gửi trả cước, cộng 17.000đ vào số đã nhập.
        val low = cod(listOf(line(150_000, ShipInfo(pay = "cod", payer = "receiver", codOverride = 10_000))))
        assertEquals(27_000, low.cod)
        assertEquals(17_000, low.shipFee)
        assertTrue(low.senderPays)
        assertTrue(low.forcedSender)
        // Đơn nhỏ đã cộng ship mà nhập tay đúng 27.000đ: giữ nguyên, không cộng lần nữa.
        val kept = cod(listOf(line(10_000, ShipInfo(pay = "cod", codOverride = 27_000))))
        assertEquals(27_000, kept.cod)
        assertTrue(kept.senderPays)
        // Nhập tay đúng 17.000đ trở lên thì giữ người trả cước đã chọn.
        assertFalse(cod(listOf(line(150_000, ShipInfo(pay = "cod", payer = "receiver", codOverride = 17_000)))).senderPays)
    }

    /** Có cước thật Viettel Post: thu hộ thấp hơn cước đó thì người gửi trả cước, cộng đúng cước đó vào thu hộ. */
    @Test
    fun realFeeRules() {
        val near = listOf(line(17_500, ShipInfo(pay = "cod", payer = "receiver")))
        assertFalse(cod(near).senderPays)
        val real = cod(near, 18_480)
        assertTrue(real.senderPays)
        assertEquals(18_480, real.shipFee)
        assertEquals(35_980, real.cod)
        assertTrue(real.feeIsReal)
        assertEquals(28_480, cod(listOf(line(10_000, ShipInfo(pay = "cod"))), 18_480).cod)
        assertEquals(150_000, cod(listOf(line(150_000, ShipInfo(pay = "cod", payer = "receiver"))), 18_480).cod)
        assertEquals(36_480, cod(listOf(line(150_000, ShipInfo(pay = "cod", payer = "receiver", codOverride = 18_000))), 18_480).cod)
        // Cước thật rẻ hơn 17.000đ: ngưỡng vẫn là 17.000đ, tiền cộng vào là cước thật.
        assertEquals(33_700, cod(listOf(line(16_900, ShipInfo(pay = "cod"))), 16_800).cod)
        assertEquals(18_480, cod(listOf(line(150_000, ShipInfo(pay = "paid", payer = "receiver"))), 18_480).cod)
    }

    @Test
    fun groupsMergeReadyOrdersOfAllDaysAndRows() {
        val old = order("05", price = 120_000, ts = 500_000, ship = ShipInfo(state = "ready", pay = "cod"))
        val now = order("08", price = 100_000, qty = 2, ts = 900_000, ship = ShipInfo(state = "ready", pay = "cod"))
        val held = order("07", ts = 700_000, ship = ShipInfo(state = "hold"))
        val groups = Vtp.readyGroups(listOf(now, held, old))
        assertEquals(1, groups.size)
        val g = groups[0]
        assertEquals(listOf("05", "08"), g.orders.map { it.key })
        assertEquals(320_000, g.summary.cod)
        assertEquals(3, g.summary.qty)
        assertEquals("Lan Anh", g.summary.receiver)
        assertEquals("0912345678", g.summary.phone)
        assertEquals(emptyList<String>(), g.summary.problems)

        val rows = Vtp.rows(groups)
        assertEquals(22, rows[6].size)
        val row = rows[7]
        assertEquals(22, row.size)
        assertEquals(Vtp.Cell.Text("HD05+HD08"), row[1])
        assertEquals(Vtp.Cell.Text("12 Trần Thái Tông, Phường Cầu Giấy, TP.Hà Nội"), row[4])
        assertEquals(Vtp.Cell.Text("Quần áo"), row[5])
        assertEquals(Vtp.Cell.Number(320_000), row[9])
        assertEquals(Vtp.Cell.Text("VSL9"), row[12])
        assertEquals(Vtp.Cell.Text("Người nhận trả"), row[18])
    }

    @Test
    fun heavyParcelNeedsSize() {
        val heavy = order("h", ship = ShipInfo(state = "ready", pay = "cod", weightG = 12_000))
        assertTrue(Vtp.readyGroups(listOf(heavy))[0].summary.problems.contains("Từ 10kg phải nhập kích thước"))
        val sized = order("h", ship = ShipInfo(state = "ready", pay = "cod", weightG = 12_000, lengthCm = 50, widthCm = 40, heightCm = 30))
        val g = Vtp.readyGroups(listOf(sized))
        assertEquals(emptyList<String>(), g[0].summary.problems)
        assertEquals(listOf(Vtp.Cell.Number(50), Vtp.Cell.Number(40), Vtp.Cell.Number(30)), Vtp.rows(g)[7].subList(15, 18))
        assertEquals("12kg", weightText(12_000))
        assertEquals("1,5kg", weightText(1_500))
    }

    @Test
    fun oldAndNewAddressResolveToViettelPostNames() {
        val old = VtpAddress.resolve(DeliveryAddress(street = "1 Lê Lợi", region = "Phường Bến Nghé, Quận 1, TP. Hồ Chí Minh"))
        assertTrue(old.reason, old.ok)
        assertEquals("1 Lê Lợi, P.Bến Nghé, Q.1, TP.Hồ Chí Minh", old.line)
        val new = VtpAddress.resolve(DeliveryAddress(street = "1 Trần Thái Tông", region = "Phường Cầu Giấy, Hà Nội"))
        assertTrue(new.reason, new.ok)
        assertEquals("TP.Hà Nội", new.province)
        assertEquals("Cầu Giấy, Hà Nội", new.shortArea)
        assertFalse(VtpAddress.resolve(DeliveryAddress(street = "", region = "Phường Cầu Giấy, TP.Hà Nội")).ok)
        assertFalse(VtpAddress.resolve(DeliveryAddress(street = "1 Lê Lợi", region = "Phường Không Có, TP.Hà Nội")).ok)
    }

    @Test
    fun xlsxIsZipWithSharedStrings() {
        val data = Vtp.xlsx(Vtp.readyGroups(listOf(order("a", ship = ShipInfo(state = "ready", pay = "cod")))))
        assertEquals(listOf(0x50, 0x4B, 0x03, 0x04), data.take(4).map { it.toInt() })
        assertEquals(listOf(0x50, 0x4B, 0x05, 0x06), data.takeLast(22).take(4).map { it.toInt() })
        assertEquals(0xCBF43926L, Xlsx.crc32("123456789".toByteArray()))
        // Đọc lại bằng trình giải nén của Java: đủ 7 phần, trang tính có tên khách.
        val names = mutableListOf<String>()
        var sheet = ""
        java.util.zip.ZipInputStream(data.inputStream()).use { z ->
            while (true) {
                val e = z.nextEntry ?: break
                names += e.name
                if (e.name == "xl/sharedStrings.xml") sheet = z.readBytes().toString(Charsets.UTF_8)
            }
        }
        assertEquals(7, names.size)
        assertTrue(sheet.contains("Lan Anh"))
        assertEquals("AB", Xlsx.colName(27))
    }

    @Test
    fun shipJsonFromServerAndBack() {
        val json = """{"id":"x","ship":{"state":"exported","pay":"cod","deposit":50000,"weightG":1500.4,"codOverride":null,
            "exportedAt":1794026406933.265,"vtpCode":"156288120034","vtpFee":22000,"vtpStatus":505,"vtpStatusName":"Chờ phát lại",
            "vtpKind":"attention","vtpNote":"Không liên lạc được người nhận","vtpEventAt":1},"orderCode":"HD1"}"""
        val item = AppJson.decodeFromJsonElement(OrderItem.serializer(), AppJson.parseToJsonElement(json).wholeNumbers())
        val s = item.ship!!
        assertEquals("exported", s.state)
        assertEquals(50_000, s.deposit)
        assertEquals(1500, s.weightG)
        assertNull(s.codOverride)
        assertEquals(1794026406933L, s.exportedAt)
        assertEquals("156288120034", s.vtpCode)
        assertEquals(505, s.vtpStatus)
        assertEquals("HD1", item.orderCode)

        val o = order("a", ship = s, shipping = true)
        assertEquals(ShipState.EXPORTED, Vtp.state(o))
        assertTrue(VtpTrack.needsAction(o))
        assertFalse(VtpTrack.canCancel(o))
        assertEquals("1562 8812 0034", VtpTrack.pretty("156288120034"))
        val created = order("b", ship = s.copy(vtpKind = "created", vtpStatus = 0), shipping = true)
        assertFalse(VtpTrack.needsAction(created))
        assertTrue(VtpTrack.canCancel(created))
        // Đã giao thì không còn cần xử lý.
        assertFalse(VtpTrack.needsAction(order("c", ship = s, delivered = true)))

        // Trường đã bỏ (COD nhập tay) không gửi lên: máy chủ coi trường thiếu là đã xoá.
        val back = AppJson.encodeToString(ShipInfo.serializer(), ShipInfo(state = "ready", pay = "cod"))
        assertFalse(back.contains("codOverride"))
        assertFalse(back.contains("vtpCode"))
    }

    @Test
    fun vtpPayloadMatchesExcelMoney() {
        val a = order("a", price = 120_000, ship = ShipInfo(state = "ready", pay = "cod", deposit = 20_000))
        val b = order("b", price = 80_000, ts = 2_000_000, ship = ShipInfo(state = "ready", pay = "cod"))
        val g = Vtp.readyGroups(listOf(a, b))[0]
        val p = VtpTrack.payload(g, 1_800_000_000_000)
        assertEquals(JsonPrimitive("lan.anh"), p["key"])
        assertEquals(JsonArray(listOf(JsonPrimitive("a-1"), JsonPrimitive("b-1"))), p["itemIds"])
        assertEquals(JsonPrimitive("HDa+HDb"), p["ref"])
        assertEquals(JsonPrimitive(180_000), p["cod"])
        assertEquals(JsonPrimitive(200_000), p["goods"])
        assertEquals(JsonPrimitive("0912345678"), p["phone"])
        assertEquals(JsonPrimitive("Lan Anh"), p["receiver"])
        assertEquals(JsonPrimitive(false), p["senderPays"])
        assertEquals(JsonPrimitive(g.summary.address.line), p["address"])
        assertNull(p["size"])

        // Vận đơn cũ đã huỷ: thêm hậu tố để Viettel Post nhận lại mã đơn.
        val c = order("c", ship = ShipInfo(state = "ready", pay = "cod", vtpOldCode = "156288120034", vtpKind = "cancelled"))
        val p2 = VtpTrack.payload(Vtp.readyGroups(listOf(c))[0])
        assertTrue((p2["ref"] as JsonPrimitive).content.startsWith("HDc-"))
        assertEquals("156288120034", VtpTrack.cancelledCode(c))
    }

    // MARK: - Kho dữ liệu

    private fun newStore() = Store(Files.createTempDirectory("chotlive").toFile(), "srv|a")

    private fun comment(id: String, text: String, session: String?, ts: Long = System.currentTimeMillis()) =
        LiveComment(id = id, uniqueId = "lan.anh", userId = "1", nickname = "Lan", text = text, ts = ts, price = 150_000, sessionId = session)

    @Test
    fun approveExportAndUndo() {
        val store = newStore()
        store.saveToCustomer(comment("c1", "chốt 150", "s1"))
        store.saveToCustomer(comment("c2", "chốt 150", "s2"))
        store.setAddress(address, "lan.anh")
        val ids = store.allOrders().map { it.id }
        assertEquals(2, ids.size)
        store.approve(ids, ShipState.READY, ShipInfo(pay = "cod", payer = "receiver", deposit = 50_000, weightG = 1000))
        val ready = Vtp.readyGroups(store.allOrders())
        assertEquals(1, ready.size)
        assertEquals(2, ready[0].orders.size)
        // Tiền cọc chỉ ghi ở đơn đầu, không trừ hai lần.
        assertEquals(250_000, ready[0].summary.cod)
        assertEquals(emptyList<String>(), ready[0].summary.problems)

        store.markExported(ready[0].orders)
        assertTrue(store.allOrders().all { Vtp.state(it) == ShipState.EXPORTED })
        assertTrue(Vtp.readyGroups(store.allOrders()).isEmpty())
        store.undoExport(store.allOrders()[0])
        assertTrue(store.allOrders().all { Vtp.state(it) == ShipState.READY })

        // Bỏ tick một đơn đã duyệt: đơn đó về chưa duyệt, không còn gộp chung.
        store.approve(listOf(ids[0]), ShipState.READY, ShipInfo(pay = "cod"), dropped = listOf(ids[1]))
        assertEquals(ShipState.ASK, Vtp.state(store.order(ids[1])!!))
        assertEquals(1, Vtp.readyGroups(store.allOrders())[0].orders.size)

        // Gửi lên máy chủ: món mang theo `ship` của đơn.
        val update = store.makeSyncUpdate()!!
        // Thứ tự món tuỳ giờ tạo bình luận: so cả hai trạng thái (đơn còn tick "ready", đơn bỏ tick "ask").
        assertEquals(setOf("ready", "ask"), update.customers[0].items.mapNotNull { it.ship?.state }.toSet())
    }

    @Test
    fun newItemAfterShippingOpensAnotherOrderAndClearsManualCod() {
        val store = newStore()
        store.saveToCustomer(comment("c1", "chốt 150", "s1"))
        val first = store.allOrders()[0]
        store.approve(listOf(first.id), ShipState.READY, ShipInfo(pay = "cod", codOverride = 99_000))
        // Đơn chưa gửi nhận thêm món: bỏ số thu hộ nhập tay và báo một lần.
        store.saveToCustomer(comment("c2", "chốt 150", "s1"))
        assertEquals(1, store.allOrders().size)
        assertNull(store.allOrders()[0].ship?.codOverride)
        assertTrue(store.takeCodResetNotice()!!.contains("Lan"))
        assertNull(store.takeCodResetNotice())

        // Đơn đã có vận đơn: món chốt thêm của cùng phiên sang đơn mới.
        store.applyVtpCreated(store.allOrders(), "156288120034", 22_000, "VSL9")
        assertEquals("156288120034", VtpTrack.code(store.allOrders()[0]))
        store.saveToCustomer(comment("c3", "chốt 150", "s1"))
        val orders = store.allOrders()
        assertEquals(2, orders.size)
        assertEquals(1, orders.count { Vtp.state(it) == ShipState.ASK })
        // Món chốt tiếp theo vào chung đơn mới đang mở, không mở thêm đơn thứ ba.
        store.saveToCustomer(comment("c4", "chốt 150", "s1"))
        assertEquals(2, store.allOrders().size)

        // Huỷ vận đơn: đơn về Chờ gửi, giữ mã cũ.
        store.applyVtpCancelled("156288120034")
        val back = store.allOrders().first { it.ship?.vtpOldCode != null }
        assertEquals(ShipState.READY, Vtp.state(back))
        assertEquals("156288120034", VtpTrack.cancelledCode(back))
    }

    @Test
    fun displayNameFollowsReceiver() {
        val store = newStore()
        store.saveToCustomer(comment("c1", "chốt 150", "s1"))
        assertEquals("Lan", store.customers[0].displayName)
        store.setAddress(address.copy(receiver = "Nguyễn Lan Anh"), "lan.anh")
        val c = store.customers[0]
        assertEquals("Nguyễn Lan Anh", c.displayName)
        assertEquals("NA", c.initials)
        assertTrue(c.matchesName("lan"))
        assertTrue(c.matchesName("nguyễn"))
        // Máy chủ gửi về đơn có mã vận đơn: giữ nguyên trên máy.
        val snap = ServerSnapshot(customers = listOf(c.copy(items = c.items.map { it.copy(ship = ShipInfo(state = "ready")) })))
        store.acknowledgeSync(store.makeSyncUpdate()!!.id)
        store.applyServer(snap)
        assertEquals(ShipState.READY, Vtp.state(store.allOrders()[0]))
    }
}
