@file:OptIn(ExperimentalLayoutApi::class)

package com.chotlive.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.layout.layout
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.chotlive.app.model.OrderStatus
import com.chotlive.app.model.PriceParser
import androidx.compose.material3.Text as MText

val Capsule: Shape = RoundedCornerShape(percent = 50)
fun rounded(r: Float): Shape = RoundedCornerShape(r.dp)

/** Cỡ chữ cố định như bản iPhone, không phóng theo cỡ chữ hệ thống để bố cục giữ đúng mẫu. */
@Composable
fun fixedSp(size: Float): TextUnit = (size / LocalDensity.current.fontScale).sp

/** Text theo kiểu chữ của mẫu thiết kế. `shrink` thu nhỏ chữ cho vừa một dòng (minimumScaleFactor). */
@Composable
fun T(
    text: String,
    size: Float,
    weight: BV = BV.MEDIUM,
    color: Color = C.ink,
    modifier: Modifier = Modifier,
    track: Float = 0f,
    maxLines: Int = Int.MAX_VALUE,
    align: TextAlign? = null,
    shrink: Boolean = false,
    lineHeight: Float? = null,
) {
    var factor by remember(text, size) { mutableFloatStateOf(1f) }
    val scale = LocalDensity.current.fontScale
    MText(
        text = text,
        modifier = modifier,
        color = color,
        fontSize = (size * factor / scale).sp,
        fontFamily = BeVietnam,
        fontWeight = weight.weight,
        letterSpacing = (track / scale).sp,
        textAlign = align,
        maxLines = if (shrink) 1 else maxLines,
        softWrap = !shrink && maxLines != 1,
        overflow = if (shrink || maxLines != Int.MAX_VALUE) TextOverflow.Ellipsis else TextOverflow.Clip,
        lineHeight = lineHeight?.let { (it / scale).sp } ?: TextUnit.Unspecified,
        // Chỉ co khi tràn chiều ngang. hasVisualOverflow còn bật khi dấu chồng (ễ, ằ, ọ) cao vượt dòng,
        // làm tên tiếng Việt bị co nhỏ dù thừa chỗ.
        onTextLayout = { r ->
            val wide = r.didOverflowWidth || (r.lineCount > 0 && r.isLineEllipsized(r.lineCount - 1))
            if (shrink && wide && factor > 0.55f) factor *= 0.93f
        },
    )
}

/** Đoạn chữ ghép nhiều kiểu (số đậm + nhãn nhạt). */
@Composable
fun TA(text: AnnotatedString, modifier: Modifier = Modifier, maxLines: Int = 1) {
    MText(text, modifier = modifier, maxLines = maxLines, overflow = TextOverflow.Ellipsis, fontFamily = BeVietnam)
}

@Composable
fun spanStyle(size: Float, weight: BV, color: Color) =
    SpanStyle(fontSize = fixedSp(size), fontWeight = weight.weight, color = color, fontFamily = BeVietnam)

@Composable
fun annotated(vararg parts: Pair<String, SpanStyle>): AnnotatedString = buildAnnotatedString {
    for ((s, style) in parts) withStyle(style) { append(s) }
}

// MARK: - Thẻ, đường kẻ

@Composable
fun Modifier.cardStyle(radius: Float = 20f, fill: Color = C.card, border: Color = C.line): Modifier {
    val shape = rounded(radius)
    return this.clip(shape).background(fill, shape).border(1.dp, border, shape)
}

@Composable
fun Modifier.capsule(fill: Color, border: Color? = null, width: Float = 1f): Modifier {
    val m = this.clip(Capsule).background(fill, Capsule)
    return if (border != null) m.border(width.dp, border, Capsule) else m
}

/** Cho hàng cuộn ngang tràn ra hai mép màn hình (lề trang vẫn giữ ở đầu và cuối hàng). */
fun Modifier.bleed(gutter: Float = Metrics.GUTTER): Modifier = this.layout { m, c ->
    val extra = (gutter * density).toInt() * 2
    val p = m.measure(c.copy(minWidth = 0, maxWidth = if (c.hasBoundedWidth) c.maxWidth + extra else c.maxWidth))
    val w = if (c.hasBoundedWidth) c.maxWidth else p.width
    layout(w, p.height) { p.place(-extra / 2, 0) }
}

fun Modifier.tap(enabled: Boolean = true, onClick: () -> Unit): Modifier =
    this.clickable(enabled = enabled, onClick = onClick)

/** Bấm không có hiệu ứng gợn (cho vùng lớn như thẻ có nút riêng bên trong). */
@Composable
fun Modifier.plainTap(enabled: Boolean = true, onClick: () -> Unit): Modifier =
    this.clickable(remember { MutableInteractionSource() }, indication = null, enabled = enabled, onClick = onClick)

@Composable
fun HairLine(modifier: Modifier = Modifier) {
    Box(modifier.fillMaxWidth().height(1.dp).background(C.line))
}

@Composable
fun VLine(height: Float) {
    Box(Modifier.width(1.dp).height(height.dp).background(C.line))
}

@Composable
fun Avatar(text: String, seed: String, size: Float = 44f, fontSize: Float = 15f) {
    val hash = seed.fold(0) { acc, ch -> (acc * 9 + ch.code) and 0xFFFF }
    val isPeach = (hash shr 3) and 1 == 0
    Box(Modifier.size(size.dp).clip(CircleShape).background(if (isPeach) C.peach else C.slate), contentAlignment = Alignment.Center) {
        T(text, fontSize, BV.BOLD, maxLines = 1)
    }
}

@Composable
fun Badge(text: String, color: Color = C.accent, fill: Color = C.peachSoft, fontSize: Float = 11f, height: Float = 19f, hPad: Float = 8f) {
    Box(Modifier.height(height.dp).capsule(fill).padding(horizontal = hPad.dp), contentAlignment = Alignment.Center) {
        T(text, fontSize, BV.SEMIBOLD, color, maxLines = 1)
    }
}

@Composable
fun OrderStatus.badgeColor(): Color = when (this) {
    OrderStatus.NEW, OrderStatus.SHIPPING -> C.accent
    OrderStatus.PRINTED -> C.ink
    OrderStatus.DELIVERED -> C.green
}

@Composable
fun OrderStatus.badgeFill(): Color = when (this) {
    OrderStatus.NEW, OrderStatus.SHIPPING -> C.peachSoft
    OrderStatus.PRINTED -> C.grayBadge
    OrderStatus.DELIVERED -> C.greenSoft
}

@Composable
fun StatusBadge(status: OrderStatus, fontSize: Float = 11f, height: Float = 19f) {
    Badge(status.label, status.badgeColor(), status.badgeFill(), fontSize, height, if (height >= 25) 12f else 8f)
}

// MARK: - Tiêu đề

/** Tiêu đề lớn đầu tab. */
@Composable
fun PageHeader(subtitle: String, title: String, trailing: @Composable RowScope.() -> Unit = {}) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
            T(subtitle, 13f, BV.MEDIUM, C.muted, shrink = true)
            T(title, 28f, BV.HEAVY, C.ink, track = -0.5f, maxLines = 1)
        }
        trailing()
    }
}

/** Nút cam có dấu cộng ở góc phải tiêu đề ("Live mới", "Tạo đơn"). */
@Composable
fun HeaderAddButton(title: String, onClick: () -> Unit) {
    OnAccent {
        Row(
            Modifier.width(108.dp).height(44.dp).capsule(C.orange).tap(onClick = onClick),
            horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterHorizontally),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(IconName.PLUS, 16f, 2.4f)
            T(title, 14f, BV.BOLD, maxLines = 1)
        }
    }
}

@Composable
fun CircleButton(icon: IconName, iconSize: Float = 20f, color: Color = C.ink, enabled: Boolean = true, size: Float = 44f, onClick: () -> Unit) {
    Box(
        Modifier.size(size.dp).clip(CircleShape).background(C.card).border(1.dp, C.line, CircleShape).tap(enabled, onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, iconSize, color = if (enabled) color else C.faint)
    }
}

@Composable
fun Chip(title: String, selected: Boolean, onClick: () -> Unit) {
    OnAccent(selected) {
        Box(
            Modifier.height(36.dp).capsule(if (selected) C.orange else C.card, if (selected) null else C.line)
                .tap(onClick = onClick).padding(horizontal = 15.dp),
            contentAlignment = Alignment.Center,
        ) {
            T(title, 13f, if (selected) BV.BOLD else BV.SEMIBOLD, maxLines = 1)
        }
    }
}

// MARK: - Ô nhập

@Composable
fun textStyle(size: Float, weight: BV, color: Color = C.ink, align: TextAlign = TextAlign.Start) = TextStyle(
    fontSize = fixedSp(size), fontWeight = weight.weight, fontFamily = BeVietnam, color = color, textAlign = align,
)

/** Ô nhập trơn: chữ gợi ý, kiểu chữ của mẫu. */
@Composable
fun PlainField(
    value: String,
    onChange: (String) -> Unit,
    placeholder: String,
    size: Float = 15f,
    weight: BV = BV.SEMIBOLD,
    modifier: Modifier = Modifier,
    keyboard: KeyboardType = KeyboardType.Text,
    capitalize: Boolean = true,
    password: Boolean = false,
    singleLine: Boolean = true,
    maxLines: Int = 1,
    imeAction: ImeAction = ImeAction.Default,
    onDone: (() -> Unit)? = null,
) {
    BasicTextField(
        value = value,
        onValueChange = onChange,
        modifier = modifier,
        singleLine = singleLine,
        maxLines = if (singleLine) 1 else maxLines,
        textStyle = textStyle(size, weight),
        cursorBrush = SolidColor(C.orangeDeep),
        visualTransformation = if (password) PasswordVisualTransformation() else VisualTransformation.None,
        keyboardOptions = KeyboardOptions(
            capitalization = if (capitalize) KeyboardCapitalization.Sentences else KeyboardCapitalization.None,
            autoCorrectEnabled = capitalize && !password,
            keyboardType = if (password) KeyboardType.Password else keyboard,
            imeAction = if (onDone != null) ImeAction.Done else imeAction,
        ),
        keyboardActions = KeyboardActions(onDone = { onDone?.invoke() }),
        decorationBox = { inner ->
            Box(contentAlignment = Alignment.CenterStart) {
                if (value.isEmpty()) T(placeholder, size, BV.MEDIUM, C.placeholder, maxLines = 1)
                inner()
            }
        },
    )
}

@Composable
fun SearchField(value: String, onChange: (String) -> Unit, modifier: Modifier = Modifier, placeholder: String = "Tìm tên hoặc @tiktok") {
    Row(
        modifier.height(44.dp).capsule(C.card, C.line).padding(horizontal = 17.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(13.dp),
    ) {
        Icon(IconName.SEARCH, 17f, 2.3f, C.muted)
        PlainField(value, onChange, placeholder, 14f, BV.MEDIUM, Modifier.weight(1f), capitalize = false)
        if (value.isNotEmpty()) {
            Box(Modifier.plainTap { onChange("") }) { Icon(IconName.CLOSE, 16f, color = C.muted) }
        }
    }
}

/** Ô nhập có nhãn dùng cho các màn sửa. */
@Composable
fun LabeledField(
    label: String,
    placeholder: String,
    value: String,
    onChange: (String) -> Unit,
    keyboard: KeyboardType = KeyboardType.Text,
    capitalize: Boolean = true,
    password: Boolean = false,
) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        T(label, 12f, BV.MEDIUM, C.muted)
        Box(Modifier.fillMaxWidth().height(44.dp).cardStyle(14f, C.field).padding(horizontal = 15.dp), contentAlignment = Alignment.CenterStart) {
            PlainField(value, onChange, placeholder, 15f, BV.SEMIBOLD, Modifier.fillMaxWidth(), keyboard, capitalize, password)
        }
    }
}

// MARK: - Nút

/** Nút cam to chiếm hết chiều ngang ("Áp dụng", "Chỉnh sửa đơn"). */
@Composable
fun PrimaryButton(
    title: String,
    modifier: Modifier = Modifier,
    icon: IconName? = null,
    fontSize: Float = 16f,
    height: Float = 52f,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    OnAccent {
        Row(
            modifier.fillMaxWidth().height(height.dp).alpha(if (enabled) 1f else 0.5f).capsule(C.orange).tap(enabled, onClick),
            horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (icon != null) Icon(icon, 15f, 2.3f)
            T(title, fontSize, BV.BOLD, maxLines = 1)
        }
    }
}

/** Nút trắng viền mảnh. */
@Composable
fun OutlineButton(
    title: String,
    modifier: Modifier = Modifier,
    icon: IconName? = null,
    color: Color? = null,
    height: Float = 44f,
    filled: Boolean = false,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    OnAccent(filled) {
        val tint = color ?: C.ink
        Row(
            modifier.height(height.dp).alpha(if (enabled) 1f else 0.5f)
                .capsule(if (filled) C.orange else C.card, if (filled) null else C.line).tap(enabled, onClick).padding(horizontal = 6.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterHorizontally),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (icon != null) Icon(icon, 15f, 2.3f, tint)
            T(title, 14f, BV.BOLD, tint, shrink = true)
        }
    }
}

/** Công tắc kiểu iPhone. */
@Composable
fun Toggle(on: Boolean, onChange: (Boolean) -> Unit) {
    Box(
        Modifier.width(52.dp).height(32.dp).capsule(if (on) C.orange else C.bar).plainTap { onChange(!on) }.padding(horizontal = 4.dp),
        contentAlignment = if (on) Alignment.CenterEnd else Alignment.CenterStart,
    ) {
        Box(Modifier.size(24.dp).clip(CircleShape).background(Color.White))
    }
}

/** Vòng chọn: tích cam khi chọn, viền xám khi chưa. */
@Composable
fun CheckDot(selected: Boolean, size: Float = 24f, checkSize: Float = 14f) {
    if (selected) {
        OnAccent {
            Box(Modifier.size(size.dp).clip(CircleShape).background(C.orange), contentAlignment = Alignment.Center) {
                Icon(IconName.CHECK, checkSize, 2.8f)
            }
        }
    } else {
        Box(Modifier.size(size.dp).border(1.5.dp, C.bar, CircleShape))
    }
}

// MARK: - Khung trang

/** Khung trang con: nút lùi tròn, tiêu đề, nội dung; không có thanh tab. */
@Composable
fun SubPage(
    title: String,
    subtitle: String? = null,
    accessory: (@Composable () -> Unit)? = null,
    headerBottom: Float = 14f,
    trailing: @Composable RowScope.() -> Unit = {},
    content: @Composable ColumnScope.() -> Unit,
) {
    val ui = LocalAppUI.current
    Column(Modifier.fillMaxSize().background(C.bg)) {
        Row(
            Modifier.fillMaxWidth().padding(start = Metrics.GUTTER.dp, end = Metrics.GUTTER.dp, top = 6.dp, bottom = headerBottom.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(if (subtitle == null) 12.dp else 14.dp),
        ) {
            CircleButton(IconName.CHEVRON_LEFT) { ui.pop() }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Box(Modifier.weight(1f, fill = false)) { T(title, 20f, BV.HEAVY, C.ink, track = -0.3f, shrink = true) }
                    accessory?.invoke()
                }
                if (subtitle != null) T(subtitle, 13f, BV.MEDIUM, C.muted, shrink = true)
            }
            trailing()
        }
        content()
    }
}

/** Thanh nút dưới đáy trang con: nền trắng, kẻ mảnh phía trên. */
@Composable
fun FooterBar(content: @Composable () -> Unit) {
    Column(Modifier.fillMaxWidth().background(C.card)) {
        HairLine()
        Box(Modifier.padding(start = Metrics.GUTTER.dp, end = Metrics.GUTTER.dp, top = 14.dp, bottom = 14.dp)) { content() }
    }
}

/** Nội dung bình luận, phần mã ("Mã 150") được tô nền. */
@Composable
fun CommentText(text: String, size: Float = 15f, highlight: Boolean = true) {
    val parts = if (highlight) remember(text) { PriceParser.segments(text) } else emptyList()
    if (parts.any { it.isCode }) {
        FlowRow(
            horizontalArrangement = Arrangement.spacedBy((size * 0.26f).dp),
            verticalArrangement = Arrangement.spacedBy(3.dp),
        ) {
            for (part in parts) {
                if (part.isCode) {
                    Box(
                        Modifier.height((size + 4).dp).clip(rounded(7f)).background(C.peachCode).padding(horizontal = 5.dp),
                        contentAlignment = Alignment.Center,
                    ) { T(part.text, size, BV.BOLD, maxLines = 1) }
                } else {
                    Box(Modifier.height((size + 4).dp), contentAlignment = Alignment.Center) { T(part.text, size, BV.MEDIUM, maxLines = 1) }
                }
            }
        }
    } else {
        T(text, size, BV.MEDIUM)
    }
}

/** Tiêu đề bottom sheet với nút đóng tròn. */
@Composable
fun SheetTitle(title: String, subtitle: String? = null, size: Float = 20f) {
    val ui = LocalAppUI.current
    Row(Modifier.fillMaxWidth(), verticalAlignment = if (subtitle == null) Alignment.CenterVertically else Alignment.Top) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.5.dp)) {
            T(title, size, BV.HEAVY, C.ink, track = -0.3f)
            if (subtitle != null) T(subtitle, 13f, BV.MEDIUM, C.muted, shrink = true)
        }
        Box(Modifier.size(44.dp).clip(CircleShape).background(C.field).tap { ui.dismissSheet() }, contentAlignment = Alignment.Center) {
            Icon(IconName.CLOSE, 20f)
        }
    }
}

@Composable
fun SectionLabel(text: String) {
    T(text, 13f, BV.BOLD, C.muted, Modifier.padding(start = 4.dp, bottom = 8.dp))
}

@Composable
fun EmptyNote(text: String, top: Float = 30f) {
    T(text, 13f, BV.MEDIUM, C.muted, Modifier.fillMaxWidth().padding(top = top.dp), align = TextAlign.Center)
}

@Composable
fun Gap(h: Float) = Spacer(Modifier.height(h.dp))
