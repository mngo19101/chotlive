package com.chotlive.app.ui

import android.Manifest
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.chotlive.app.model.dayMonth
import com.chotlive.app.model.timeText
import com.chotlive.app.net.SupportMessage
import com.chotlive.app.net.SupportThread
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** Kiểu Messenger: danh sách phiên theo ngày, bấm vào một phiên mới thấy tin nhắn và ô chat. */
@Composable
fun SupportChatScreen() {
    val app = LocalApp.current
    val client = app.client
    val scope = rememberCoroutineScope()
    var threads by remember { mutableStateOf(listOf<SupportThread>()) }
    /** null = đang xem danh sách. */
    var selectedId by remember { mutableStateOf<String?>(null) }
    var composingNew by remember { mutableStateOf(false) }
    var draft by remember { mutableStateOf("") }
    var sending by remember { mutableStateOf(false) }
    var loaded by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    val selected = threads.firstOrNull { it.id == selectedId }
    val hasOpen = threads.any { it.session.open }
    val inThread = composingNew || selected != null
    val canType = composingNew || (selected?.session?.open ?: false)
    val canSend = !sending && draft.isNotBlank()

    val notifPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {}

    suspend fun reload() {
        val list = client.fetchSupportThreads()
        // Không gán lại khi không có gì đổi để màn hình khỏi vẽ lại mỗi 3 giây.
        if (list != null && list != threads) threads = list
        loaded = true
    }

    DisposableEffect(Unit) {
        client.supportChatOpen = true
        onDispose { client.supportChatOpen = false }
    }
    LaunchedEffect(Unit) {
        if (Build.VERSION.SDK_INT >= 33) notifPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        client.checkSocket()
        reload()
        client.markSupportRead()
        // Hỏi lại server định kỳ: tin từ Telegram vẫn hiện ngay dù kết nối realtime bị rớt.
        while (true) {
            delay(3000)
            reload()
            if (client.supportUnread > 0) client.markSupportRead()
        }
    }
    LaunchedEffect(client.lastSupportMessage?.id) {
        if (client.lastSupportMessage != null) reload()
    }

    suspend fun send() {
        val text = draft.trim()
        if (text.isEmpty()) return
        sending = true
        error = null
        try {
            val m = client.sendSupport(text)
            draft = ""
            composingNew = false
            selectedId = m.sessionId
            reload()
        } catch (e: Exception) {
            error = e.message
        }
        sending = false
    }

    SubPage("Chat với quản trị viên", trailing = {
        if (!inThread && !hasOpen) {
            Box(Modifier.height(44.dp).capsule(C.orangeDeep).tap { composingNew = true }.padding(horizontal = 16.dp),
                contentAlignment = Alignment.Center) { T("+ Phiên mới", 13f, BV.BOLD, Color.White) }
        }
    }) {
        if (!inThread) {
            LazyColumn(
                Modifier.weight(1f),
                contentPadding = PaddingValues(start = Metrics.GUTTER.dp, end = Metrics.GUTTER.dp, bottom = 16.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                item {
                    T("Phiên tự đóng sau 24 giờ không có tin mới. Tin nhắn lưu 30 ngày.", 12f, BV.MEDIUM, C.muted, Modifier.padding(bottom = 4.dp))
                    if (loaded && threads.isEmpty()) {
                        EmptyNote("Chưa có phiên chat nào. Bấm “Phiên mới” để nhắn cho quản trị viên.", 32f)
                    }
                }
                items(threads, key = { it.id }) { t ->
                    val last = t.messages.lastOrNull()
                    Row(
                        Modifier.fillMaxWidth().cardStyle(16f).tap { selectedId = t.id; error = null }.padding(16.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        Box(Modifier.size(10.dp).clip(CircleShape).background(if (t.session.open) C.green else C.faint))
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                            T("Phiên ${dayMonth(t.session.createdAt)}", 15f, BV.BOLD)
                            T(last?.let { (if (it.fromAdmin) "Quản trị viên: " else "Bạn: ") + it.text } ?: "Chưa có tin nhắn",
                                13f, BV.MEDIUM, C.muted, maxLines = 1)
                        }
                        Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(3.dp)) {
                            T(if (t.session.open) "Đang mở" else "Đã đóng", 11f, BV.BOLD, if (t.session.open) C.green else C.muted)
                            T(timeText(last?.ts ?: t.session.lastAt), 11f, BV.MEDIUM, C.muted)
                        }
                    }
                }
            }
        } else {
            Row(Modifier.fillMaxWidth().padding(start = Metrics.GUTTER.dp, end = Metrics.GUTTER.dp, bottom = 8.dp),
                verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.plainTap { selectedId = null; composingNew = false; draft = "" }) { T("‹ Các phiên", 14f, BV.BOLD, C.accent) }
                Box(Modifier.weight(1f), contentAlignment = Alignment.Center) {
                    T(selected?.let { "Phiên ${dayMonth(it.session.createdAt)}" } ?: "Phiên mới", 14f, BV.BOLD)
                }
                if (selected?.session?.open == true) {
                    Box(Modifier.height(34.dp).border(1.dp, C.line, Capsule).clip(Capsule).tap {
                        scope.launch {
                            client.endSupportSession()
                            reload()
                        }
                    }.padding(horizontal = 12.dp), contentAlignment = Alignment.Center) { T("Kết thúc", 13f, BV.SEMIBOLD, C.muted) }
                } else {
                    Box(Modifier.width(70.dp))
                }
            }
            val messages = selected?.messages ?: emptyList()
            val listState = rememberLazyListState()
            LaunchedEffect(messages.size) { if (messages.isNotEmpty()) listState.animateScrollToItem(messages.size) }
            LazyColumn(
                Modifier.weight(1f),
                state = listState,
                contentPadding = PaddingValues(start = Metrics.GUTTER.dp, end = Metrics.GUTTER.dp, bottom = 8.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                item {
                    if (messages.isEmpty()) {
                        T("Nhắn cho quản trị viên nếu bạn cần hỗ trợ. Khi có trả lời, app sẽ báo cho bạn.", 13f, BV.MEDIUM, C.muted,
                            Modifier.fillMaxWidth().padding(top = 24.dp), align = TextAlign.Center)
                    }
                }
                items(messages, key = { it.id }) { m -> Bubble(m) }
            }
            if (canType) {
                Column(Modifier.padding(horizontal = Metrics.GUTTER.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    error?.let { T(it, 12f, BV.SEMIBOLD, C.red) }
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Box(
                            Modifier.weight(1f).heightIn(min = 46.dp).clip(rounded(23f)).background(C.card).border(1.dp, C.line, rounded(23f))
                                .padding(horizontal = 16.dp, vertical = 12.dp),
                            contentAlignment = Alignment.CenterStart,
                        ) {
                            PlainField(draft, { draft = it }, "Nhập tin nhắn…", 15f, BV.MEDIUM, Modifier.fillMaxWidth(),
                                singleLine = false, maxLines = 4)
                        }
                        Box(Modifier.size(46.dp).clip(CircleShape).background(if (canSend) C.orangeDeep else C.faint)
                            .tap(canSend) { scope.launch { send() } }, contentAlignment = Alignment.Center) {
                            Icon(IconName.ARROW_RIGHT, 18f, 2.4f, Color.White)
                        }
                    }
                }
            } else {
                T("Phiên này đã đóng. Quay lại danh sách và bấm “Phiên mới” để nhắn tiếp.", 12f, BV.SEMIBOLD, C.muted,
                    Modifier.fillMaxWidth().padding(Metrics.GUTTER.dp), align = TextAlign.Center)
            }
        }
    }
}

@Composable
private fun Bubble(m: SupportMessage) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = if (m.fromAdmin) Arrangement.Start else Arrangement.End) {
        Column(Modifier.widthIn(max = 290.dp), horizontalAlignment = if (m.fromAdmin) Alignment.Start else Alignment.End,
            verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Box(
                Modifier.clip(rounded(18f)).background(if (m.fromAdmin) C.card else C.orangeDeep)
                    .then(if (m.fromAdmin) Modifier.border(1.dp, C.line, rounded(18f)) else Modifier)
                    .padding(horizontal = 14.dp, vertical = 10.dp)
            ) { T(m.text, 14f, BV.MEDIUM, if (m.fromAdmin) C.ink else Color.White) }
            T((if (m.fromAdmin) "Quản trị viên · " else "") + timeText(m.ts), 10f, BV.MEDIUM, C.muted)
        }
    }
}
