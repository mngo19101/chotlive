package com.chotlive.app.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import com.chotlive.app.R
import com.chotlive.app.data.AccentChoice
import kotlin.math.roundToInt

fun hex(v: Long): Color = Color(0xFF000000 or v)

/** Trộn hai màu: `share` là phần của màu `a` (0...1). */
fun mixHex(a: Long, b: Long, share: Double): Long {
    var out = 0L
    for (shift in listOf(16, 8, 0)) {
        val ca = ((a shr shift) and 0xFF).toDouble()
        val cb = ((b shr shift) and 0xFF).toDouble()
        val v = (ca * share + cb * (1 - share)).roundToInt().coerceIn(0, 255)
        out = out or (v.toLong() shl shift)
    }
    return out
}

/** Bảng màu của một màu chủ đạo (giống AccentPalette bên iPhone). */
class AccentPalette(
    val fill: Long, val deep: Long, val text: Long, val textDeep: Long, val darkText: Long, val darkTextDeep: Long,
    peach: Long? = null, peachSoft: Long? = null, peachLine: Long? = null, peachTint: Long? = null,
    peachCode: Long? = null, peachRow: Long? = null,
) {
    val peach = peach ?: mixHex(deep, LIGHT_CARD, 0.2)
    val peachSoft = peachSoft ?: mixHex(deep, LIGHT_CARD, 0.08)
    val peachLine = peachLine ?: mixHex(fill, LIGHT_CARD, 0.66)
    val peachTint = peachTint ?: mixHex(deep, LIGHT_CARD, 0.1)
    val peachCode = peachCode ?: mixHex(deep, LIGHT_CARD, 0.16)
    val peachRow = peachRow ?: mixHex(deep, LIGHT_CARD, 0.05)

    val darkPeach get() = mixHex(deep, DARK_CARD, 0.3)
    val darkPeachSoft get() = mixHex(deep, DARK_CARD, 0.14)
    val darkPeachLine get() = mixHex(deep, DARK_CARD, 0.45)
    val darkPeachTint get() = mixHex(deep, DARK_CARD, 0.18)
    val darkPeachCode get() = mixHex(deep, DARK_CARD, 0.26)
    val darkPeachRow get() = mixHex(deep, DARK_CARD, 0.1)

    companion object {
        const val LIGHT_CARD = 0xFFFFFFL
        const val DARK_CARD = 0x1A1D23L
    }
}

val AccentChoice.palette: AccentPalette
    get() = when (this) {
        // Giữ đúng các màu của mẫu thiết kế gốc.
        AccentChoice.VANG -> AccentPalette(0xFF9A4C, 0xEA6A09, 0xB5490C, 0x7A3300, 0xFFA94D, 0xFFC58A,
            peach = 0xFEE4CD, peachSoft = 0xFEF4EA, peachLine = 0xFFBD87, peachTint = 0xFFF1E4, peachCode = 0xFFE9D2, peachRow = 0xFFF7EC)
        AccentChoice.XANH -> AccentPalette(0x6E9CFF, 0x2563EB, 0x1D4ED8, 0x1E3A8A, 0x8AB0FF, 0xB5CDFF)
        AccentChoice.NGOC -> AccentPalette(0x3CC4B4, 0x0D9488, 0x0B6B62, 0x134E4A, 0x4FD1C1, 0x99E6DC)
        AccentChoice.LA -> AccentPalette(0x5CCB85, 0x16A34A, 0x166534, 0x14532D, 0x6EDB95, 0xA7EBC0)
        AccentChoice.HONG -> AccentPalette(0xFF85B5, 0xDB2777, 0xBE185D, 0x831843, 0xFF85BB, 0xFFB8D6)
        AccentChoice.TIM -> AccentPalette(0xA98BFF, 0x7C3AED, 0x6D28D9, 0x4C1D95, 0xB9A0FF, 0xD6C8FF)
    }

/** Mọi màu của giao diện, theo nền Sáng/Tối và màu chủ đạo đang chọn. */
data class Palette(val dark: Boolean, val accentChoice: AccentChoice) {
    private fun d(light: Long, dark: Long) = hex(if (this.dark) dark else light)
    private val p = accentChoice.palette

    val bg = d(0xF6F7F9, 0x0F1115)
    val card = d(0xFFFFFF, 0x1A1D23)
    val line = d(0xE6E8EC, 0x2C3038)
    val ink = d(0x14181F, 0xF2F3F5)
    val muted = d(0x5B6472, 0xA3AAB6)
    val faint = d(0x8B93A0, 0x7D8592)
    val placeholder = d(0x7D8592, 0x8A919D)
    val tabBar = d(0xFFFFFF, 0x15181D)
    val slate = d(0xE6E9F0, 0x2A2F3A)
    val green = d(0x107A54, 0x4ADE9C)
    val greenSoft = d(0xE6F7EF, 0x12291F)
    val greenBright = hex(0x4ADE9C)
    val red = d(0xB3261E, 0xFF8A80)
    val redSoft = d(0xFDECEC, 0x3A1A1C)
    val live = d(0xE5484D, 0xFF6369)
    val bar = d(0xCBD2DC, 0x3A3F48)
    val field = d(0xF6F7F9, 0x23272E)
    val track = d(0xEFF0F4, 0x262A31)
    val grayBadge = d(0xEBEEF3, 0x2A2E36)
    val grabber = d(0xD6D9DF, 0x3A3F48)

    // Nền nút màu chủ đạo sáng ở cả hai chế độ, chữ trên nút luôn tối (xem OnAccent).
    val orange = hex(p.fill)
    val orangeDeep = hex(p.deep)
    val accent = d(p.text, p.darkText)
    val accentDeep = d(p.textDeep, p.darkTextDeep)
    val peach = d(p.peach, p.darkPeach)
    val peachSoft = d(p.peachSoft, p.darkPeachSoft)
    val peachLine = d(p.peachLine, p.darkPeachLine)
    val peachTint = d(p.peachTint, p.darkPeachTint)
    val peachCode = d(p.peachCode, p.darkPeachCode)
    val peachRow = d(p.peachRow, p.darkPeachRow)
}

val LocalPalette = staticCompositionLocalOf { Palette(false, AccentChoice.VANG) }

/** Bảng màu đang dùng: `C.ink`, `C.card`... */
val C: Palette
    @Composable @ReadOnlyComposable get() = LocalPalette.current

/** Nền nút màu chủ đạo luôn sáng, nên chữ và icon bên trên dùng màu của chế độ Sáng kể cả khi app đang nền Tối. */
@Composable
fun OnAccent(active: Boolean = true, content: @Composable () -> Unit) {
    val p = LocalPalette.current
    if (active && p.dark) {
        CompositionLocalProvider(LocalPalette provides p.copy(dark = false), content = content)
    } else {
        content()
    }
}

enum class BV(val weight: FontWeight) {
    MEDIUM(FontWeight.Medium), SEMIBOLD(FontWeight.SemiBold), BOLD(FontWeight.Bold), HEAVY(FontWeight.ExtraBold)
}

val BeVietnam = FontFamily(
    Font(R.font.bevietnampro_medium, FontWeight.Medium),
    Font(R.font.bevietnampro_semibold, FontWeight.SemiBold),
    Font(R.font.bevietnampro_bold, FontWeight.Bold),
    Font(R.font.bevietnampro_extrabold, FontWeight.ExtraBold),
)

object Metrics {
    const val GUTTER = 20f
    const val GAP = 14.5f
}
