package com.chotlive.app.data

import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

enum class AppearanceMode(val label: String) {
    LIGHT("Sáng"), DARK("Tối"), SYSTEM("Theo máy");

    val key: String get() = name.lowercase()
}

enum class AccentChoice(val label: String) {
    VANG("Vàng"), XANH("Xanh dương"), NGOC("Xanh ngọc"), LA("Xanh lá"), HONG("Hồng"), TIM("Tím");

    val key: String get() = name.lowercase()
}

/** Cài đặt lưu trên máy này (giao diện, tem, thông báo). Đổi giá trị thì giao diện tự vẽ lại. */
class Settings(context: Context) {
    private val prefs = context.getSharedPreferences("settings", Context.MODE_PRIVATE)

    var mode by mutableStateOf(
        AppearanceMode.entries.firstOrNull { it.key == prefs.getString("appearanceMode", null) } ?: AppearanceMode.LIGHT
    ); private set
    var accent by mutableStateOf(
        AccentChoice.entries.firstOrNull { it.key == prefs.getString("appearanceAccent", null) } ?: AccentChoice.VANG
    ); private set
    /** Đã mở màn Giao diện lần nào chưa (để ẩn nhãn "MỚI"). */
    var appearanceSeen by mutableStateOf(prefs.getBoolean("appearanceSeen", false)); private set
    var paperWidth by mutableStateOf(if (prefs.getInt("paperWidth", 576) == 384) 384 else 576); private set
    var shopName by mutableStateOf(prefs.getString("shopName", null) ?: "ChốtLive"); private set
    var notifySound by mutableStateOf(prefs.getBoolean("notifySound", false)); private set
    var notifyHaptic by mutableStateOf(prefs.getBoolean("notifyHaptic", false)); private set
    /** Gói dịch vụ Viettel Post mặc định khi gửi (VSL9, STK, SCN). */
    var vtpService by mutableStateOf(prefs.getString("vtpServiceCode", null) ?: "VSL9"); private set
    /** Khổ tem in vận đơn: a6, a5, k100. */
    var vtpLabelSize by mutableStateOf(prefs.getString("vtpLabelSize", null) ?: "a6"); private set

    val appearanceSummary: String get() = "${mode.label} · ${accent.label}"

    fun updateMode(m: AppearanceMode) { mode = m; prefs.edit().putString("appearanceMode", m.key).apply() }
    fun updateAccent(a: AccentChoice) { accent = a; prefs.edit().putString("appearanceAccent", a.key).apply() }
    fun markAppearanceSeen() { appearanceSeen = true; prefs.edit().putBoolean("appearanceSeen", true).apply() }
    fun updatePaperWidth(w: Int) { paperWidth = w; prefs.edit().putInt("paperWidth", w).apply() }
    fun updateShopName(s: String) { shopName = s; prefs.edit().putString("shopName", s).apply() }
    fun updateNotifySound(on: Boolean) { notifySound = on; prefs.edit().putBoolean("notifySound", on).apply() }
    fun updateNotifyHaptic(on: Boolean) { notifyHaptic = on; prefs.edit().putBoolean("notifyHaptic", on).apply() }
    fun updateVtpService(code: String) { vtpService = code; prefs.edit().putString("vtpServiceCode", code).apply() }
    fun updateVtpLabelSize(code: String) { vtpLabelSize = code; prefs.edit().putString("vtpLabelSize", code).apply() }
}
