@file:OptIn(ExperimentalLayoutApi::class)

package com.chotlive.app.ui

import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.chotlive.app.data.AppJson
import com.chotlive.app.model.DeliveryAddress
import com.chotlive.app.model.PriceParser
import kotlinx.serialization.Serializable
import java.text.Collator
import java.util.Locale

// MARK: - Dữ liệu địa giới hành chính

/**
 * AddressData.json nhúng trong app, để chọn khu vực không cần mạng.
 * - "new" (34 tỉnh): thanglequoc/vietnamese-provinces-database (MIT), sau sáp nhập.
 * - "old" (63 tỉnh, 3 cấp): kenzouno1/DiaGioiHanhChinhVN, trước khi bỏ cấp huyện ngày 1/7/2025.
 */
@Serializable
data class AreaUnit(val n: String, val d: List<AreaUnit>? = null, val w: List<String>? = null)

object AddressBook {
    @Serializable
    private data class Payload(val new: List<AreaUnit> = emptyList(), val old: List<AreaUnit> = emptyList())

    @Volatile private var payload: Payload? = null

    private fun load(context: Context): Payload = payload ?: synchronized(this) {
        payload ?: try {
            val text = context.assets.open("AddressData.json").bufferedReader().use { it.readText() }
            AppJson.decodeFromString(Payload.serializer(), text)
        } catch (e: Exception) {
            Payload()
        }.also { payload = it }
    }

    fun new(context: Context) = load(context).new
    fun old(context: Context) = load(context).old

    private val collator: Collator = Collator.getInstance(Locale("vi", "VN"))

    /** So chữ tiếng Việt, số trong tên so theo giá trị: "Phường 2" đứng trước "Phường 10". */
    private fun compareNatural(a: String, b: String): Int {
        val re = Regex("\\d+|\\D+")
        val pa = re.findAll(a).map { it.value }.toList()
        val pb = re.findAll(b).map { it.value }.toList()
        for (i in 0 until minOf(pa.size, pb.size)) {
            val x = pa[i]
            val y = pb[i]
            val c = if (x[0].isDigit() && y[0].isDigit()) (x.toBigInteger().compareTo(y.toBigInteger())) else collator.compare(x, y)
            if (c != 0) return c
        }
        return pa.size - pb.size
    }

    fun sorted(names: List<String>): List<String> = names.sortedWith { a, b -> compareNatural(a, b) }

    /** Tỉnh xếp theo tên riêng, không theo chữ "TP." / "Tỉnh". */
    fun sortedProvinces(names: List<String>): List<String> {
        fun key(s: String): String {
            for (prefix in listOf("TP. ", "Tỉnh ")) if (s.startsWith(prefix)) return s.drop(prefix.length)
            return s
        }
        return names.sortedWith { a, b -> compareNatural(key(a), key(b)) }
    }
}

// MARK: - Sửa địa chỉ

@Composable
fun AddressEditScreen(customerId: String) {
    val app = LocalApp.current
    val store = app.store
    val ui = LocalAppUI.current
    val customer = store.customers.firstOrNull { it.id == customerId }
    var address by remember {
        mutableStateOf((customer?.address ?: DeliveryAddress()).let { a ->
            if (a.receiver.isEmpty() && customer != null) a.copy(receiver = customer.nickname) else a
        })
    }
    val canSave = listOf(address.phone, address.receiver, address.street, address.region).all { it.isNotBlank() }

    SubPage("Sửa địa chỉ", customer?.let { "${it.nickname} · @${it.uniqueId}" }, headerBottom = 20f) {
        Column(
            Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(start = Metrics.GUTTER.dp, end = Metrics.GUTTER.dp, bottom = 16.dp),
            verticalArrangement = Arrangement.spacedBy(17.dp),
        ) {
            AddressSection(IconName.USER, "Người nhận") {
                AddressField("Số điện thoại", address.phone, KeyboardType.Phone) { address = address.copy(phone = it) }
                AddressField("Họ tên", address.receiver) { address = address.copy(receiver = it) }
            }
            AddressSection(IconName.PIN, "Địa chỉ nhận hàng") {
                AddressField("Địa chỉ", address.street) { address = address.copy(street = it) }
                Column(verticalArrangement = Arrangement.spacedBy(6.4.dp)) {
                    RequiredLabel("Phường / Quận / Tỉnh")
                    Row(
                        Modifier.fillMaxWidth().heightIn(min = 50.dp).cardStyle(16f, C.field)
                            .tap {
                                val current = address.region
                                ui.present(SHEET_DIM) { AreaPickerSheet(current) { address = address.copy(region = it) } }
                            }
                            .padding(start = 17.dp, end = 16.dp, top = 11.5.dp, bottom = 11.5.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        // Tên tỉnh không bị tách làm hai dòng.
                        val parts = address.region.split(", ").toMutableList()
                        val text = if (parts.isEmpty() || address.region.isEmpty()) "" else {
                            val last = parts.removeAt(parts.lastIndex).replace(" ", " ")
                            (parts + last).joinToString(", ")
                        }
                        T(text, 16f, BV.SEMIBOLD, modifier = Modifier.weight(1f), lineHeight = 22f)
                        Icon(IconName.CHEVRON_DOWN, 16f, color = C.muted)
                    }
                }
            }
            AddressSection(IconName.MESSAGE_SQUARE, "Ghi chú giao") {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(9.dp)) {
                    for (option in DeliveryAddress.noteOptions) {
                        val selected = address.hasNote(option)
                        Row(
                            Modifier.height(38.6.dp).capsule(if (selected) C.peachTint else C.card, if (selected) C.peachLine else C.line)
                                .tap { address = address.toggleNote(option) }.padding(horizontal = 15.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            if (selected) Icon(IconName.CHECK, 14f, 2.6f, C.accentDeep)
                            T(option, 14f, BV.SEMIBOLD, if (selected) C.accentDeep else C.ink, maxLines = 1)
                        }
                    }
                }
            }
        }
        FooterBar {
            Row(horizontalArrangement = Arrangement.spacedBy(12.5.dp)) {
                Box(Modifier.width(83.5.dp).height(55.5.dp).capsule(C.card, C.line).tap { ui.pop() }, contentAlignment = Alignment.Center) {
                    T("Huỷ", 16f, BV.BOLD)
                }
                PrimaryButton("Lưu thay đổi", Modifier.weight(1f), fontSize = 18f, height = 55.5f, enabled = canSave) {
                    store.setAddress(address, customerId)
                    ui.pop()
                }
            }
        }
    }
}

@Composable
private fun AddressSection(icon: IconName, title: String, content: @Composable () -> Unit) {
    Column(
        Modifier.fillMaxWidth().cardStyle(24f).padding(start = 19.dp, end = 19.dp, top = 19.dp, bottom = 20.dp),
        verticalArrangement = Arrangement.spacedBy(14.5.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Box(Modifier.size(32.dp).clip(CircleShape).background(C.peachTint), contentAlignment = Alignment.Center) {
                Icon(icon, 15f, 2.3f, C.accent)
            }
            T(title, 17f, BV.BOLD, maxLines = 1)
        }
        content()
    }
}

@Composable
private fun RequiredLabel(title: String) {
    TA(annotated("$title " to spanStyle(13f, BV.SEMIBOLD, C.muted), "*" to spanStyle(14f, BV.BOLD, C.red)))
}

@Composable
private fun AddressField(title: String, value: String, keyboard: KeyboardType = KeyboardType.Text, onChange: (String) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(6.4.dp)) {
        RequiredLabel(title)
        Box(Modifier.fillMaxWidth().height(50.dp).cardStyle(16f, C.field).padding(horizontal = 17.dp), contentAlignment = Alignment.CenterStart) {
            PlainField(value, onChange, "", 16f, BV.SEMIBOLD, Modifier.fillMaxWidth(), keyboard)
        }
    }
}

// MARK: - Chọn khu vực

@Composable
fun AreaPickerSheet(region: String, onConfirm: (String) -> Unit) {
    val context = LocalApp.current
    val ui = LocalAppUI.current
    val newData = remember { AddressBook.new(context) }
    val oldData = remember { AddressBook.old(context) }

    data class Start(val old: Boolean, val province: String?, val district: String?, val ward: String?)
    /** Đọc lại khu vực đang lưu; không khớp dữ liệu thì bắt đầu từ đầu. */
    val start = remember {
        val parts = region.split(", ").map { it.trim() }
        val provinceName = parts.lastOrNull()
        when {
            provinceName == null || region.isEmpty() -> Start(false, null, null, null)
            parts.size == 3 && oldData.firstOrNull { it.n == provinceName }?.d?.firstOrNull { it.n == parts[1] }?.w?.contains(parts[0]) == true ->
                Start(true, provinceName, parts[1], parts[0])
            parts.size == 2 && newData.firstOrNull { it.n == provinceName }?.w?.contains(parts[0]) == true ->
                Start(false, provinceName, null, parts[0])
            // Huyện đảo không có cấp xã.
            parts.size == 2 && oldData.firstOrNull { it.n == provinceName }?.d?.any { it.n == parts[0] } == true ->
                Start(true, provinceName, parts[0], null)
            else -> Start(false, null, null, null)
        }
    }
    var old by remember { mutableStateOf(start.old) }
    var province by remember { mutableStateOf(start.province) }
    var district by remember { mutableStateOf(start.district) }
    var ward by remember { mutableStateOf(start.ward) }
    // 0 tỉnh, 1 huyện, 2 xã
    var level by remember {
        mutableStateOf(if (start.province == null) 0 else if (start.old && start.ward == null) 1 else 2)
    }
    var query by remember { mutableStateOf("") }

    val provinces = if (old) oldData else newData
    val provinceUnit = provinces.firstOrNull { it.n == province }
    val districtUnit = provinceUnit?.d?.firstOrNull { it.n == district }
    val names = when (level) {
        0 -> AddressBook.sortedProvinces(provinces.map { it.n })
        1 -> AddressBook.sorted(provinceUnit?.d?.map { it.n } ?: emptyList())
        else -> AddressBook.sorted((if (old) districtUnit?.w else provinceUnit?.w) ?: emptyList())
    }
    val q = PriceParser.stripAccents(query.trim().lowercase())
    val shown = if (q.isEmpty()) names else names.filter { PriceParser.stripAccents(it.lowercase()).contains(q) }
    val selectedName = when (level) { 0 -> province; 1 -> district; else -> ward }
    val isComplete = ward != null || (old && district != null && districtUnit?.w?.isEmpty() == true)
    val summary = listOfNotNull(ward, district, province).joinToString(", ")

    fun select(name: String) {
        query = ""
        when (level) {
            0 -> {
                if (province != name) { province = name; district = null; ward = null }
                level = if (old) 1 else 2
            }
            1 -> {
                if (district != name) { district = name; ward = null }
                // Huyện đảo không có phường/xã: chọn huyện là đủ.
                val d = provinces.firstOrNull { it.n == province }?.d?.firstOrNull { it.n == name }
                if (d?.w?.isEmpty() == false) level = 2
            }
            else -> ward = name
        }
    }

    Column(Modifier.fillMaxWidth().height(sheetHeight(44.dp))) {
        Column(Modifier.padding(horizontal = Metrics.GUTTER.dp)) {
            Box(Modifier.padding(top = 7.dp)) { SheetTitle("Chọn khu vực", size = 23f) }
            Row(Modifier.padding(top = 16.dp).width(236.dp).height(38.dp).capsule(C.track).padding(4.dp)) {
                for ((title, value) in listOf("Địa chỉ mới" to false, "Địa chỉ cũ" to true)) {
                    val sel = old == value
                    OnAccent(sel) {
                        Box(Modifier.weight(1f).fillMaxSize().capsule(if (sel) C.orange else C.track).plainTap {
                            if (old != value) {
                                // Hai cách phân cấp khác nhau nên đổi chế độ thì chọn lại từ đầu.
                                old = value; province = null; district = null; ward = null; level = 0; query = ""
                            }
                        }, contentAlignment = Alignment.Center) { T(title, 13f, BV.BOLD, if (sel) C.ink else C.muted) }
                    }
                }
            }
            T(if (old) "Theo đơn vị hành chính cũ: Tỉnh / Thành phố → Quận / Huyện → Phường / Xã"
            else "Theo đơn vị hành chính mới: Tỉnh / Thành phố → Phường / Xã", 12.5f, BV.MEDIUM, C.muted,
                Modifier.padding(start = 2.dp, end = 2.dp, top = 8.dp), lineHeight = 17f)
            FlowRow(Modifier.padding(top = 15.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Step(level == 0, province, "Tỉnh / Thành phố") { level = 0; query = "" }
                if (old && province != null) Step(level == 1, district, "Quận / Huyện") { level = 1; query = "" }
                if (province != null && (!old || (district != null && districtUnit?.w?.isEmpty() == false))) {
                    Step(level == 2, ward, "Phường / Xã") { level = 2; query = "" }
                }
            }
            Row(
                Modifier.padding(top = 12.5.dp).fillMaxWidth().height(47.5.dp).capsule(C.field, C.line).padding(start = 19.dp, end = 16.dp),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                Icon(IconName.SEARCH, 17f, 2.3f, C.muted)
                PlainField(query, { query = it }, when (level) { 0 -> "Tìm tỉnh / thành phố"; 1 -> "Tìm quận / huyện"; else -> "Tìm phường / xã" },
                    15f, BV.MEDIUM, Modifier.weight(1f), capitalize = false)
            }
        }
        LazyColumn(Modifier.weight(1f).padding(top = 8.dp).padding(horizontal = Metrics.GUTTER.dp)) {
            itemsIndexed(shown, key = { _, n -> n }) { i, name ->
                if (i > 0) HairLine()
                val selected = selectedName == name
                Row(Modifier.fillMaxWidth().height(53.dp).tap { select(name) }.padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    T(name, 16f, if (selected) BV.BOLD else BV.MEDIUM, modifier = Modifier.weight(1f), maxLines = 1)
                    if (selected) CheckDot(true, 26f)
                }
            }
        }
        HairLine()
        Column(Modifier.padding(start = Metrics.GUTTER.dp, end = Metrics.GUTTER.dp, top = 12.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            T("Địa chỉ đã chọn", 12.5f, BV.MEDIUM, C.muted)
            T(summary.ifEmpty { " " }, 15f, BV.BOLD, shrink = true)
            Box(Modifier.padding(top = 6.5.dp)) {
                PrimaryButton("Xác nhận", fontSize = 18f, height = 55.5f, enabled = isComplete) {
                    onConfirm(summary)
                    ui.dismissSheet()
                }
            }
        }
    }
}

@Composable
private fun Step(active: Boolean, name: String?, placeholder: String, onClick: () -> Unit) {
    Row(
        Modifier.height(35.5.dp).capsule(C.card, if (active) C.ink else C.line, if (active) 1.5f else 1f).tap(onClick = onClick)
            .padding(horizontal = 13.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        if (!active && name != null) Icon(IconName.CHECK, 14f, 2.6f, C.green)
        T(name ?: placeholder, 14f, if (active) BV.BOLD else BV.SEMIBOLD, maxLines = 1)
    }
}
