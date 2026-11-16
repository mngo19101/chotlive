package com.chotlive.app

import com.chotlive.app.data.AccountAccess
import com.chotlive.app.data.AppJson
import com.chotlive.app.data.ServerSnapshot
import com.chotlive.app.data.Store
import com.chotlive.app.data.SyncUpdate
import com.chotlive.app.data.wholeNumbers
import com.chotlive.app.model.Customer
import com.chotlive.app.model.DeliveryAddress
import com.chotlive.app.model.LiveComment
import com.chotlive.app.model.OrderItem
import com.chotlive.app.model.PriceParser
import com.chotlive.app.model.ShipInfo
import com.chotlive.app.model.money
import com.chotlive.app.print.PrinterProfile
import com.chotlive.app.print.WifiPrinterAddress
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files

class PriceParserTest {
    /** Kết quả lấy từ public/js/price.js (parsePrice) của bản web, để hai bên bắt giá giống nhau. */
    private val web = listOf(
        "59" to 59000, "5k" to 5000, "1tr2" to 1200000, "chốt 150" to 150000, "Mã 150" to 150000,
        "lấy 2 cái 150" to 150000, "Chốt 120 với 180" to 180000, "1.200.000" to 1200000, "1,5tr" to 1500000,
        "0905123456" to 0, "280k" to 280000, "2 cu" to 2000000, "150 nghìn" to 150000, "sz 38 mã 250" to 250000,
        "99.000đ" to 99000, "abc" to 0, "3tr5" to 3500000, "mã a12" to 0, "120,5" to 120500, "7" to 7000,
    )

    @Test
    fun matchesWebParser() {
        for ((text, price) in web) assertEquals(text, price, PriceParser.parse(text))
    }

    /** BL-12: cùng danh sách với PRICE_VECTORS của test/price.test.js (0 ở đây là null bên web). */
    private val bl12 = listOf(
        "chốt mã 150 sđt 0912 345 678" to 150000, "lấy 150 0912.345.678" to 150000, "150 sđt 0912-345-678" to 150000,
        "sđt 098.812.3456 lấy 250" to 250000, "0988 123 456 mã 99" to 99000, "024 3826 1234 mã 120" to 120000,
        "+84 912 345 678 mã 150" to 150000, "0912345678 150" to 150000, "0912 345 678" to 0,
        "2.500k" to 2500000, "1,200k" to 1200000, "1.5k" to 1500, "150k" to 150000, "150 k" to 150000,
        "1.5tr" to 1500000, "150,000" to 150000, "150.000đ" to 150000, "1.200.000" to 1200000, "1,5tr" to 1500000,
        "Chốt 120 với 180" to 180000, "lấy 2 cái 150" to 150000, "mã 090 150 180" to 180000,
        "cho em xin giá" to 0, "" to 0,
    )

    @Test
    fun phoneNumbersAndGroupedThousandsBl12() {
        for ((text, price) in bl12) assertEquals(text, price, PriceParser.parse(text))
        for (text in listOf("0912 345 678", "0912.345.678", "150 0912 345 678")) assertFalse(text, PriceParser.isOnlyCodes(text))
        assertTrue(PriceParser.isOnlyCodes("mã 150"))
        assertEquals(listOf(150000), PriceParser.orderTokens("chốt mã 150 sđt 0912 345 678").map { it.price })
    }

    /** Size và số lượng không phải giá: cùng danh sách với SIZE_QTY_VECTORS của test/price.test.js. */
    private val sizeQty = listOf(
        "size 38 0912 345 678" to 0, "size 38" to 0, "sz 38 mã 250" to 250000, "size: 40 lấy 150" to 150000,
        "lấy 2 cái" to 0, "chốt 2 cái 150" to 150000, "lấy 2 cái 150" to 150000, "sl 2" to 0,
        "số lượng: 3 mã 120" to 120000, "50 kg" to 0, "nặng 50 kg mã 199" to 199000, "mã 99 bộ đồ" to 99000,
        "150 cái" to 150000, "38" to 38000,
    )

    @Test
    fun sizeAndQuantityAreNotPrices() {
        for ((text, price) in sizeQty) assertEquals(text, price, PriceParser.parse(text))
    }

    @Test
    fun orderTokensJoinLinkedCodes() {
        assertEquals(listOf(120000, 180000), PriceParser.orderTokens("Chốt 120 với 180").map { it.price })
        assertEquals(listOf(150000), PriceParser.orderTokens("lấy 2 cái 150").map { it.price })
    }

    @Test
    fun onlyCodes() {
        assertTrue(PriceParser.isOnlyCodes("280"))
        assertTrue(PriceParser.isOnlyCodes("mã 150, 180"))
        assertFalse(PriceParser.isOnlyCodes("Mã 130 giá sao"))
    }

    @Test
    fun segmentsHighlightCodes() {
        val parts = PriceParser.segments("Chốt mã 150 nha")
        assertEquals(listOf("Chốt", "mã 150", "nha"), parts.map { it.text })
        assertEquals(listOf(false, true, false), parts.map { it.isCode })
    }

    @Test
    fun moneyFormat() {
        assertEquals("4.860.000 ₫", money(4_860_000))
        assertEquals("0 ₫", money(0))
    }
}

class PrinterProfileTest {
    private fun c(s: String, ch: String, wnr: Boolean = true) = PrinterProfile.Candidate(s, ch, wnr)

    @Test
    fun normalizeTreatsLongAndShortUUIDsAsTheSame() {
        assertEquals("2AF1", PrinterProfile.normalize("00002af1-0000-1000-8000-00805f9b34fb"))
    }

    @Test
    fun picksKnownEndpointOverUnknown() {
        val s = PrinterProfile.pick(listOf(c("1234", "5678"), c("18F0", "2AF1")))
        assertEquals(1, s?.index)
        assertTrue(s!!.isRecognized)
    }

    @Test
    fun isscUsesDataChannel() {
        val s = PrinterProfile.pick(listOf(
            c("49535343-FE7D-4AE5-8FA9-9FAFD205E455", "49535343-ACA3-481C-91EC-D85E28A60318"),
            c("49535343-FE7D-4AE5-8FA9-9FAFD205E455", "49535343-8841-43F4-A8D4-ECBE34729BB3"),
        ))
        assertEquals(1, s?.index)
    }

    @Test
    fun neverWritesToFirmwareOrGenericServices() {
        assertNull(PrinterProfile.pick(listOf(c("FE59", "1234"), c("1800", "2A00"))))
    }

    @Test
    fun chunkStaysWithinMtu() {
        assertEquals(20, PrinterProfile.chunkSize(20))
        assertEquals(180, PrinterProfile.chunkSize(244))
    }
}

class AccessTest {
    @Test
    fun countdownMatchesWeb() {
        val now = 1_000_000_000_000L
        assertEquals("2 ngày 13 giờ 04 phút 09 giây", AccountAccess.countdownText(now + ((2 * 86400 + 13 * 3600 + 4 * 60 + 9) * 1000L), now))
        assertEquals("04 phút 09 giây", AccountAccess.countdownText(now + 249_000, now))
        assertEquals("01 giây", AccountAccess.countdownText(now + 300, now))
    }
}

class StoreTest {
    private fun newDir() = Files.createTempDirectory("chotlive").toFile()

    private fun comment(id: String, text: String, uid: String = "linh", session: String = "s1") =
        LiveComment(id = id, uniqueId = uid, userId = "u-$uid", nickname = "Linh", text = text, ts = 1_700_000_000_000L,
            price = PriceParser.parse(text), sessionId = session)

    @Test
    fun commentWithTwoCodesMakesTwoItemsInOneOrder() {
        val store = Store(newDir(), "srv|a")
        val items = store.saveToCustomer(comment("c1", "Chốt 120 với 180"))
        assertEquals(listOf(120000, 180000), items.map { it.price })
        assertEquals(listOf("c1", "c1#2"), items.map { it.id })
        assertEquals(1, store.allOrders().size)
        assertEquals(300000, store.allOrders()[0].total)
        // Bấm in lại cùng bình luận không tạo món mới.
        assertEquals(items, store.saveToCustomer(comment("c1", "Chốt 120 với 180")))
        assertEquals(2, store.customers[0].items.size)
    }

    @Test
    fun newItemSkipsAnOrderWhoseWaybillIsUnresolved() {
        val store = Store(newDir(), "srv|a")
        store.saveToCustomer(comment("c1", "150"))
        val first = store.allOrders().single()
        // Lần tạo vận đơn chưa rõ kết quả (máy chủ ghi): Viettel Post có thể đã tạo với số thu hộ 150.000đ.
        store.setShip(mapOf(first.id to ShipInfo(state = "ready", pay = "cod", vtpKind = "unknown")))
        store.saveToCustomer(comment("c2", "90"))
        assertEquals(2, store.allOrders().size)
        assertEquals(150000, store.allOrders().first { it.id == first.id }.total)
        // Đơn đã về Chờ gửi sau khi huỷ vận đơn thì vẫn nhận thêm món.
        val other = Store(newDir(), "srv|b")
        other.saveToCustomer(comment("c1", "150"))
        val o = other.allOrders().single()
        other.setShip(mapOf(o.id to ShipInfo(state = "ready", pay = "cod", vtpKind = "cancelled", vtpOldCode = "VTP1")))
        other.saveToCustomer(comment("c2", "90"))
        assertEquals(1, other.allOrders().size)
    }

    @Test
    fun dataSurvivesRestartAndStaysPerAccount() {
        val dir = newDir()
        val a = Store(dir, "srv|a")
        a.saveToCustomer(comment("c1", "150"))
        a.setAddress(DeliveryAddress(receiver = "Linh", phone = "0905"), "linh")
        a.awaitWrites()
        val again = Store(dir, "srv|a")
        assertEquals(1, again.customers.size)
        assertEquals("0905", again.customers[0].address?.phone)
        assertTrue(Store(dir, "srv|b").customers.isEmpty())
    }

    @Test
    fun corruptFileIsKeptAside() {
        val dir = newDir()
        val a = Store(dir, "srv|a")
        a.saveToCustomer(comment("c1", "150"))
        a.awaitWrites()
        val file = dir.walkTopDown().first { it.name == "chotlive.json" }
        file.writeText("{hỏng")
        val b = Store(dir, "srv|a")
        assertTrue(b.customers.isEmpty())
        assertNotNull(b.storageWarning)
        assertTrue(file.parentFile!!.listFiles()!!.any { it.name.startsWith("chotlive.loi-") })
    }

    @Test
    fun syncSendsChangesAndKeepsThemUntilAcknowledged() {
        val store = Store(newDir(), "srv|a")
        store.saveToCustomer(comment("c1", "150"))
        val first = store.makeSyncUpdate()!!
        assertEquals(1, first.customers.size)
        assertNotNull(first.comments) // lần đầu gửi cả dữ liệu cũ trên máy
        assertNull(store.makeSyncUpdate()) // đang chờ xác nhận
        // Server gửi bản cũ hơn trong lúc chờ: khách vừa đổi trên máy được giữ nguyên.
        store.applyServer(ServerSnapshot(customers = listOf(Customer(id = "linh", uniqueId = "linh", nickname = "Cũ"))))
        assertEquals("Linh", store.customers.first { it.id == "linh" }.nickname)
        assertFalse(store.acknowledgeSync(first.id))
        assertTrue(store.syncState.syncedOnce)
        assertTrue(store.syncState.dirtyCustomers.isEmpty())
        // Đã xác nhận: bản của server thắng.
        store.applyServer(ServerSnapshot(customers = listOf(Customer(id = "linh", uniqueId = "linh", nickname = "Mới",
            items = listOf(OrderItem(id = "c1", comment = "150", price = 150000))))))
        assertEquals("Mới", store.customers[0].nickname)
    }

    @Test
    fun deletedItemsStayDeletedUntilServerConfirms() {
        val store = Store(newDir(), "srv|a")
        store.saveToCustomer(comment("c1", "150"))
        store.acknowledgeSync(store.makeSyncUpdate()!!.id)
        val order = store.allOrders()[0]
        store.deleteOrder(order)
        val update = store.makeSyncUpdate()!!
        assertEquals(listOf("c1"), update.deletedItemIds)
        store.applyServer(ServerSnapshot(customers = listOf(Customer(id = "linh", uniqueId = "linh",
            items = listOf(OrderItem(id = "c1", comment = "150", price = 150000))))))
        assertTrue(store.customers.isEmpty())
    }

    @Test
    fun updateJsonMatchesServerFormat() {
        val store = Store(newDir(), "srv|a")
        store.saveToCustomer(comment("c1", "150"))
        val json = AppJson.encodeToString(SyncUpdate.serializer(), store.makeSyncUpdate()!!)
        assertTrue(json.contains("\"type\":\"native_update\""))
        assertTrue(json.contains("\"deletedItemIds\":[]"))
        assertFalse(json.contains("null"))
        // Đọc được gói của server có trường lạ và thiếu trường.
        val snap = AppJson.decodeFromString(ServerSnapshot.serializer(),
            """{"customers":[{"id":"x","items":[{"id":"i","price":5,"ts":1,"extra":1}]}],"sessions":[],"rev":3}""")
        assertEquals(1, snap.customers[0].items[0].qty)
    }

    @Test
    fun closingComments() {
        val store = Store(newDir(), "srv|a")
        assertTrue(store.isClosingComment(comment("1", "Chốt áo này")))
        assertTrue(store.isClosingComment(comment("2", "280")))
        assertFalse(store.isClosingComment(comment("3", "Mã 130 giá sao")))
    }

    @Test
    fun sessionCommentsShowNewestFirst() {
        val store = Store(newDir(), "srv|a")
        store.addComment(comment("kept", "hi").copy(ts = 1_794_000_100_000L), "")
        val old = comment("old", "hello").copy(ts = 1_794_000_000_000L)
        assertEquals(listOf("kept", "old"), store.sessionComments("s1", listOf(old)).map { it.id })
    }

    @Test
    fun fractionalTimestampsFromServerStillLoad() {
        // Server có lúc lưu mốc thời gian dạng số lẻ; trước đây cả gói bị bỏ và app hiện trống.
        val raw = """{"customers":[{"id":"linh","uniqueId":"linh","items":[{"id":"i1","comment":"150","price":150000,"ts":1794026406933.265,"qty":1}]}],
            "sessions":[{"id":"s1","tiktok":"shop","start":1794026406472.917,"end":1794029182848.665,"lastActivity":1794029146981.1768}],"accounts":[]}"""
        val snap = AppJson.decodeFromJsonElement(ServerSnapshot.serializer(), AppJson.parseToJsonElement(raw).wholeNumbers())
        assertEquals(1794026406933L, snap.customers[0].items[0].ts)
        assertEquals(1794029182849L, snap.sessions[0].end)
        val store = Store(newDir(), "srv|a")
        store.applyServer(snap)
        assertEquals(1, store.allOrders().size)
        assertEquals(1, store.sessions.size)
    }
    @Test
    fun wifiAddressParsesIpAndPort() {
        assertEquals(WifiPrinterAddress("192.168.1.13", 9100), WifiPrinterAddress.parse(" 192.168.1.13 ", "9100"))
        assertEquals(WifiPrinterAddress("192.168.1.13", 9100), WifiPrinterAddress.parse("192.168.1.13", ""))
        assertEquals(WifiPrinterAddress("10.0.0.5", 9101), WifiPrinterAddress.parse("10.0.0.5:9101", "9100"))
    }

    @Test
    fun wifiAddressRejectsTypos() {
        for ((host, port) in listOf("192.168.1" to "9100", "192.168.1.13." to "9100", "192.168.1.256" to "9100",
            "192,168,1,13" to "9100", "0.0.0.0" to "9100", "192.168.1.13" to "0", "192.168.1.13" to "70000",
            "192.168.1.13" to "91a")) {
            assertNull("$host:$port", WifiPrinterAddress.parse(host, port))
        }
    }
}
