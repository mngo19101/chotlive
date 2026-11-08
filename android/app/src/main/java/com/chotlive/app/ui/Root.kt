package com.chotlive.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.MutableTransitionState
import androidx.compose.animation.core.spring
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.draggable
import androidx.compose.foundation.gestures.rememberDraggableState
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import com.chotlive.app.ChotLiveApp
import com.chotlive.app.data.AppearanceMode
import kotlin.math.roundToInt

// MARK: - Điều hướng

enum class AppTab(val title: String, val icon: IconName) {
    SALES("Doanh số", IconName.CHART),
    COMMENTS("Bình luận", IconName.MESSAGE_LINES),
    CUSTOMERS("Khách\nhàng", IconName.USERS),
    ORDERS("Đơn hàng", IconName.BAG),
    ME("Tôi", IconName.USER),
}

sealed interface Route {
    data class Session(val id: String) : Route
    data class Order(val id: String) : Route
    data class OrderEdit(val id: String) : Route
    data object OrderCreate : Route
    data class OrderComments(val id: String) : Route
    data class Customer(val id: String) : Route
    data class AddressEdit(val id: String) : Route
    data object Printer : Route
    data object Keywords : Route
    data object Notifications : Route
    data object Help : Route
    data object Appearance : Route
}

class PathEntry(val key: Long, val route: Route)
class SheetItem(val id: Long, val dim: Float, val content: @Composable () -> Unit)
class ConfirmItem(val title: String, val message: String, val action: String, val run: () -> Unit)

class AppUI {
    var tab by mutableStateOf(AppTab.SALES)
    val path = mutableStateListOf<PathEntry>()
    var sheet by mutableStateOf<SheetItem?>(null); private set
    var alert by mutableStateOf<String?>(null)
    var confirm by mutableStateOf<ConfirmItem?>(null)
    private var seq = 0L

    fun push(r: Route) { path.add(PathEntry(++seq, r)) }
    fun pop() { if (path.isNotEmpty()) path.removeAt(path.lastIndex) }
    fun popToRoot() { path.clear() }

    fun present(dim: Float = 0.45f, content: @Composable () -> Unit) {
        sheet = SheetItem(++seq, dim, content)
    }

    fun dismissSheet() { sheet = null }

    /** Hiện thông báo nếu có nội dung. */
    fun notify(message: String?) { if (message != null) alert = message }
}

val LocalAppUI = staticCompositionLocalOf<AppUI> { error("AppUI chưa được cung cấp") }
val LocalApp = staticCompositionLocalOf<ChotLiveApp> { error("App chưa được cung cấp") }

/** Độ tối nền sau bottom sheet (đo từ mẫu). */
const val SHEET_DIM = 0.545f

// MARK: - Gốc

@Composable
fun RootView(app: ChotLiveApp, onDarkChange: (Boolean) -> Unit) {
    val settings = app.settings
    val dark = when (settings.mode) {
        AppearanceMode.LIGHT -> false
        AppearanceMode.DARK -> true
        AppearanceMode.SYSTEM -> isSystemInDarkTheme()
    }
    LaunchedEffect(dark) { onDarkChange(dark) }
    val palette = remember(dark, settings.accent) { Palette(dark, settings.accent) }
    val scheme = if (dark) darkColorScheme(primary = palette.orangeDeep, surface = palette.card, background = palette.bg)
    else lightColorScheme(primary = palette.orangeDeep, surface = palette.card, background = palette.bg)

    CompositionLocalProvider(LocalPalette provides palette, LocalApp provides app) {
        MaterialTheme(colorScheme = scheme) {
            Box(Modifier.fillMaxSize().background(palette.bg)) {
                if (app.client.loggedIn) {
                    // Đổi tài khoản thì dựng lại toàn bộ màn hình, không giữ trang của tài khoản cũ.
                    key(app.client.baseURL + "|" + app.client.username) { MainShell(app) }
                } else {
                    Box(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding().imePadding()) { LoginScreen() }
                }
            }
            app.store.storageWarning?.let { msg ->
                InfoDialog("Thông báo", msg) { app.store.storageWarning = null }
            }
        }
    }
}

@Composable
fun InfoDialog(title: String, message: String, button: String = "OK", onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = C.card,
        title = { T(title, 18f, BV.BOLD) },
        text = { T(message, 14f, BV.MEDIUM, C.muted) },
        confirmButton = { TextButton(onClick = onDismiss) { T(button, 15f, BV.BOLD, C.accent) } },
    )
}

/** Tab và các trang con giữ nguyên trạng thái khi bị che: chỉ không được vẽ (giống NavigationStack của iPhone). */
@Composable
private fun Layer(visible: Boolean, content: @Composable () -> Unit) {
    Box(
        Modifier.fillMaxSize().layout { m, c ->
            val p = m.measure(c)
            layout(p.width, p.height) { if (visible) p.place(0, 0) }
        }
    ) { content() }
}

@Composable
fun MainShell(app: ChotLiveApp) {
    val ui = remember { AppUI() }
    val client = app.client
    val store = app.store
    val focus = LocalFocusManager.current

    CompositionLocalProvider(LocalAppUI provides ui) {
        BackHandler(enabled = ui.sheet != null || ui.path.isNotEmpty()) {
            if (ui.sheet != null) ui.dismissSheet() else ui.pop()
        }
        // Mở chat hỗ trợ khi bấm thông báo Admin trả lời.
        val openSupport = app.openSupportRequest
        LaunchedEffect(openSupport) {
            if (openSupport > 0) {
                ui.dismissSheet()
                ui.tab = AppTab.ME
                ui.path.clear()
                ui.push(Route.Help)
            }
        }
        // Server bản cũ không tự ghi phiên: máy tự ghi theo trạng thái live.
        var first by remember { mutableStateOf(true) }
        LaunchedEffect(client.liveState) {
            val initial = first
            first = false
            if (client.serverSupportsSync) return@LaunchedEffect
            if (initial && client.liveState != "connected") return@LaunchedEffect
            store.syncLive(client.liveState, client.liveUsername)
        }

        Box(
            Modifier.fillMaxSize().background(C.bg)
                .pointerInput(Unit) { detectTapGestures(onTap = { focus.clearFocus() }) }
        ) {
            Box(Modifier.fillMaxSize().statusBarsPadding()) {
                Layer(ui.path.isEmpty()) { TabsContainer(ui) }
                ui.path.forEachIndexed { i, entry ->
                    key(entry.key) {
                        Layer(i == ui.path.lastIndex) {
                            Box(Modifier.fillMaxSize().background(C.bg).navigationBarsPadding().imePadding()) {
                                Destination(entry.route)
                            }
                        }
                    }
                }
            }
            SheetLayer(ui)
        }

        ui.alert?.let { InfoDialog("Thông báo", it) { ui.alert = null } }
        client.accessNotice?.let { InfoDialog("Không thể theo dõi live", it, "Đã hiểu") { client.accessNotice = null } }
        ui.confirm?.let { item ->
            AlertDialog(
                onDismissRequest = { ui.confirm = null },
                containerColor = C.card,
                title = { T(item.title, 18f, BV.BOLD) },
                text = { T(item.message, 14f, BV.MEDIUM, C.muted) },
                dismissButton = { TextButton(onClick = { ui.confirm = null }) { T("Huỷ", 15f, BV.BOLD, C.ink) } },
                confirmButton = {
                    TextButton(onClick = {
                        ui.confirm = null
                        item.run()
                    }) { T(item.action, 15f, BV.BOLD, C.red) }
                },
            )
        }
    }
}

@Composable
private fun Destination(route: Route) {
    when (route) {
        is Route.Session -> SessionDetailScreen(route.id)
        is Route.Order -> OrderDetailScreen(route.id)
        is Route.OrderEdit -> OrderEditScreen(route.id)
        Route.OrderCreate -> OrderCreateScreen()
        is Route.OrderComments -> OrderCommentsScreen(route.id)
        is Route.Customer -> CustomerDetailScreen(route.id)
        is Route.AddressEdit -> AddressEditScreen(route.id)
        Route.Printer -> PrinterScreen()
        Route.Keywords -> KeywordsScreen()
        Route.Notifications -> NotificationsScreen()
        Route.Help -> SupportChatScreen()
        Route.Appearance -> AppearanceScreen()
    }
}

@Composable
private fun TabsContainer(ui: AppUI) {
    Column(Modifier.fillMaxSize().background(C.bg)) {
        Box(Modifier.weight(1f)) {
            Layer(ui.tab == AppTab.SALES) { DashboardScreen() }
            Layer(ui.tab == AppTab.COMMENTS) { LiveScreen() }
            Layer(ui.tab == AppTab.CUSTOMERS) { CustomersScreen() }
            Layer(ui.tab == AppTab.ORDERS) { OrdersScreen() }
            Layer(ui.tab == AppTab.ME) { SettingsScreen() }
        }
        TabBar(ui.tab) { ui.tab = it }
    }
}

/** Thanh tab theo mẫu: 5 cột đều, nhãn "Khách hàng" xuống dòng. */
@Composable
fun TabBar(selection: AppTab, onSelect: (AppTab) -> Unit) {
    Column(Modifier.fillMaxWidth().background(C.tabBar)) {
        HairLine()
        Row(Modifier.fillMaxWidth().height(64.dp).padding(horizontal = 12.dp)) {
            for (t in AppTab.entries) {
                val active = selection == t
                Column(
                    Modifier.weight(1f).fillMaxSize().plainTap { onSelect(t) },
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(3.dp, Alignment.CenterVertically),
                ) {
                    Icon(t.icon, 22f, color = if (active) C.accent else C.muted)
                    T(t.title, 11f, BV.SEMIBOLD, if (active) C.accent else C.muted, align = TextAlign.Center, lineHeight = 12.5f)
                }
            }
        }
        Box(Modifier.navigationBarsPadding())
    }
}

// MARK: - Bottom sheet

/** Lớp phủ bottom sheet: nền tối, bo góc trên, kéo tay nắm xuống để đóng. */
@Composable
private fun SheetLayer(ui: AppUI) {
    val current = ui.sheet
    val last = remember { arrayOfNulls<SheetItem>(1) }
    if (current != null) last[0] = current
    val item = current ?: last[0]
    val state = remember { MutableTransitionState(false) }
    state.targetState = current != null
    if (item == null || (!state.currentState && !state.targetState)) return

    var drag by remember { mutableFloatStateOf(0f) }
    val density = LocalDensity.current

    Box(Modifier.fillMaxSize()) {
        AnimatedVisibility(state, enter = fadeIn(), exit = fadeOut()) {
            // Lớp phủ luôn tối, kể cả khi app đang nền Tối.
            val dimColor = if (item.dim >= 0.9f) hex(0x2B3036) else hex(0x14181F).copy(alpha = item.dim)
            Box(Modifier.fillMaxSize().background(dimColor).plainTap { ui.dismissSheet() })
        }
        AnimatedVisibility(
            state,
            modifier = Modifier.align(Alignment.BottomCenter),
            enter = slideInVertically(spring(dampingRatio = 0.92f, stiffness = 500f)) { it },
            exit = slideOutVertically(spring(dampingRatio = 0.92f, stiffness = 500f)) { it },
        ) {
            BoxWithConstraints(Modifier.fillMaxSize().statusBarsPadding()) {
                val maxH = maxHeight
                Column(
                    Modifier.align(Alignment.BottomCenter)
                        .offset { IntOffset(0, drag.coerceAtLeast(0f).roundToInt()) }
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp))
                        .background(C.card)
                        .plainTap { }
                        .navigationBarsPadding()
                        .imePadding()
                        .padding(bottom = 16.dp)
                ) {
                    // Chỉ kéo ở vùng tay nắm để không tranh cử chỉ với danh sách cuộn.
                    Box(
                        Modifier.fillMaxWidth().height(22.dp).draggable(
                            rememberDraggableState { drag += it },
                            Orientation.Vertical,
                            onDragStopped = {
                                if (drag > with(density) { 90.dp.toPx() }) ui.dismissSheet()
                                drag = 0f
                            },
                        ),
                        contentAlignment = Alignment.Center,
                    ) {
                        Box(Modifier.width(40.dp).height(4.dp).clip(Capsule).background(C.grabber))
                    }
                    key(item.id) {
                        CompositionLocalProvider(LocalSheetMaxHeight provides maxH) { item.content() }
                    }
                }
            }
        }
    }
}

/** Chiều cao tối đa của vùng sheet (để sheet dài tự tính chiều cao như Metrics.sheetHeight bên iPhone). */
val LocalSheetMaxHeight = staticCompositionLocalOf { 600.dp }

/** Chiều cao nội dung sheet có mép trên cách đỉnh vùng nội dung `topGap`; bàn phím mở thì sheet thấp lại. */
@Composable
fun sheetHeight(topGap: Dp): Dp {
    val d = LocalDensity.current
    val bottom = with(d) { maxOf(WindowInsets.ime.getBottom(d), WindowInsets.navigationBars.getBottom(d)).toDp() }
    return maxOf(LocalSheetMaxHeight.current - topGap - 38.dp - bottom, 200.dp)
}
