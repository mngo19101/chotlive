package com.chotlive.app.net

import android.os.Handler
import android.os.Looper
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.chotlive.app.data.AccountAccess
import com.chotlive.app.data.AppJson
import com.chotlive.app.data.AuthStorage
import com.chotlive.app.data.CommentCursor
import com.chotlive.app.data.CommentsPage
import com.chotlive.app.data.LiveInfo
import com.chotlive.app.data.ServerSnapshot
import com.chotlive.app.data.Store
import com.chotlive.app.data.SyncUpdate
import com.chotlive.app.data.arr
import com.chotlive.app.data.asObj
import com.chotlive.app.data.bool
import com.chotlive.app.data.num
import com.chotlive.app.data.obj
import com.chotlive.app.data.str
import com.chotlive.app.model.LiveComment
import com.chotlive.app.model.PriceParser
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.UUID
import java.util.concurrent.TimeUnit

class ClientError(message: String) : Exception(message)

/** Live vừa báo lỗi hoặc kết thúc. `seq` tăng mỗi lần để màn hình biết có sự kiện mới. */
data class LiveEvent(val username: String, val state: String, val message: String, val seq: Int)

/** Đăng nhập server ChốtLive, nhận bình luận TikTok Live và đồng bộ dữ liệu qua WebSocket (/ws). */
class LiveClient(private val auth: AuthStorage, private val notifySupport: (String) -> Unit) {
    var loggedIn by mutableStateOf(false); private set
    var username by mutableStateOf(""); private set
    var socketConnected by mutableStateOf(false); private set
    var liveState by mutableStateOf("idle"); private set     // idle | connecting | connected | error | ended | disconnected
    var liveMessage by mutableStateOf(""); private set
    var liveUsername by mutableStateOf(""); private set
    var viewers by mutableIntStateOf(0); private set
    /** Các live server đang theo dõi cùng lúc. */
    var lives by mutableStateOf(listOf<LiveInfo>()); private set
    var lastLiveEvent by mutableStateOf<LiveEvent?>(null); private set
    /** Số thiết bị đang mở cùng tài khoản trên cùng server. */
    var clientsCount by mutableIntStateOf(0); private set
    /** Server bản mới có đồng bộ dữ liệu; bản cũ chỉ gửi bình luận. */
    var serverSupportsSync by mutableStateOf(false); private set
    /** Các tài khoản ChốtLive đã đăng nhập trên máy. */
    var savedAccounts by mutableStateOf(listOf<AuthStorage.SavedAccount>()); private set
    /** Dùng thử, gói hoặc đã hết hạn của tài khoản đang dùng. */
    var access by mutableStateOf<AccountAccess?>(null); private set
    /** Thông báo vừa bị chặn theo dõi live vì hết hạn. */
    var accessNotice by mutableStateOf<String?>(null)
    /** Số tin Admin trả lời mà khách chưa đọc. */
    var supportUnread by mutableIntStateOf(0); private set
    /** Tin chat hỗ trợ mới nhất vừa tới qua server. */
    var lastSupportMessage by mutableStateOf<SupportMessage?>(null); private set
    /** Màn chat đang mở: tin Admin tới lúc này không cần báo. */
    var supportChatOpen = false

    var onChat: ((LiveComment) -> Unit)? = null
    /** Báo đổi tài khoản trước khi nhận bình luận, để dữ liệu không rơi vào vùng của người khác. */
    var onAccountChange: ((String?) -> Unit)? = null
    var onSnapshot: ((ServerSnapshot) -> Unit)? = null
    var onSyncAck: ((Int) -> Unit)? = null
    var onSocketClosed: (() -> Unit)? = null
    /** Vừa nối server xong, kèm toàn bộ dữ liệu của tài khoản. */
    var onHello: ((ServerSnapshot) -> Unit)? = null
        set(value) {
            field = value
            val snap = pendingHello
            if (snap != null && value != null) {
                pendingHello = null
                value(snap)
            }
        }

    var baseURL: String = ""; private set
    private var token = ""
    private var ws: WebSocket? = null
    private var pendingHello: ServerSnapshot? = null
    private var eventSeq = 0
    private val main = Handler(Looper.getMainLooper())
    private val scope = MainScope()
    private var syncJob: Job? = null
    private var accessJob: Job? = null
    private var reconnectJob: Job? = null

    private val http = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .pingInterval(25, TimeUnit.SECONDS)
        .build()

    private val pingRunnable = object : Runnable {
        override fun run() {
            send(buildJsonObject { put("type", "ping") })
            main.postDelayed(this, 20_000)
        }
    }

    private val currentAccountKey: String get() = AuthStorage.accountKey(baseURL, username)

    init {
        val tk = auth.currentToken()
        baseURL = auth.server ?: ""
        username = auth.user ?: ""
        token = tk
        savedAccounts = auth.savedAccounts()
        if (tk.isNotEmpty() && baseURL.isNotEmpty()) {
            loggedIn = true
            openSocket()
        }
    }

    // MARK: - Đăng nhập

    suspend fun login(server: String, user: String, password: String) =
        authenticate(server, "/api/auth/login", user,
            buildJsonObject { put("username", user); put("password", password) }, "Đăng nhập thất bại")

    /** Tạo tài khoản mới; server trả về phiên đăng nhập nên vào app được ngay. */
    suspend fun register(server: String, user: String, password: String, confirmPassword: String) =
        authenticate(server, "/api/auth/register", user,
            buildJsonObject { put("username", user); put("password", password); put("confirmPassword", confirmPassword) },
            "Đăng ký thất bại")

    private suspend fun authenticate(server: String, path: String, user: String, body: JsonObject, failure: String) {
        val base = normalize(server)
        val url = (base + path).toHttpUrlOrNull() ?: throw ClientError("Địa chỉ server không hợp lệ")
        val req = Request.Builder().url(url).post(body.toString().toRequestBody(JSON)).build()
        val (code, json) = call(req) ?: throw ClientError("Không kết nối được máy chủ. Vui lòng kiểm tra mạng rồi thử lại.")
        val tk = json.str("token")
        if (code != 200 || tk == null) throw ClientError(json.str("error") ?: failure)
        val userObj = json.obj("user")
        baseURL = base
        token = tk
        username = userObj?.str("username") ?: user
        updateAccess(AccountAccess.from(userObj?.obj("access")))
        auth.saveSession(base, username, tk)
        savedAccounts = auth.savedAccounts()
        onAccountChange?.invoke(AuthStorage.accountKey(base, username))
        loggedIn = true
        openSocket()
    }

    private fun fireAndForget(server: String, t: String, path: String) {
        val url = (server + path).toHttpUrlOrNull() ?: return
        val req = Request.Builder().url(url).header("Authorization", "Bearer $t").post(ByteArray(0).toRequestBody(null)).build()
        scope.launch { call(req) }
    }

    /** Đăng xuất tài khoản đang dùng. Dữ liệu đã lưu trên máy vẫn được giữ lại. */
    fun logout() {
        if (token.isNotEmpty()) fireAndForget(baseURL, token, "/api/auth/logout")
        closeSocket()
        token = ""
        auth.clearCurrentSession()
        savedAccounts = auth.savedAccounts()
        onAccountChange?.invoke(null)
        loggedIn = false
        liveState = "idle"
        resetLiveInfo()
    }

    /** Nút Đăng xuất: đăng xuất mọi tài khoản trên máy. */
    fun logoutAll() {
        savedAccounts.forEach { forgetSavedAccount(it.key) }
        logout()
    }

    private fun resetLiveInfo() {
        lives = emptyList()
        lastLiveEvent = null
        clientsCount = 0
        serverSupportsSync = false
        updateAccess(null)
        accessNotice = null
        supportUnread = 0
        lastSupportMessage = null
    }

    /** Chuyển sang một tài khoản đã lưu khác, không cần nhập lại mật khẩu. */
    fun switchAccount(key: String) {
        if (key == currentAccountKey) return
        val account = auth.switchCurrent(key) ?: return
        val tk = auth.token(key) ?: return
        closeSocket()
        baseURL = account.server
        username = account.user
        token = tk
        savedAccounts = auth.savedAccounts()
        onAccountChange?.invoke(key)
        loggedIn = true
        liveState = "idle"
        liveMessage = ""
        liveUsername = ""
        viewers = 0
        resetLiveInfo()
        openSocket()
    }

    /** Quên một tài khoản đã lưu khác — không tác động tới tài khoản đang dùng. */
    fun forgetSavedAccount(key: String) {
        if (key == currentAccountKey) return
        val t = auth.token(key)
        val account = savedAccounts.firstOrNull { it.key == key }
        if (t != null && account != null) fireAndForget(account.server, t, "/api/auth/logout")
        auth.forgetAccount(key)
        savedAccounts = auth.savedAccounts()
    }

    // MARK: - TikTok Live

    /** Thêm một live để theo dõi; các live đang theo dõi vẫn chạy tiếp. */
    fun connectLive(tiktok: String) {
        if (!serverSupportsSync) liveState = "connecting"
        liveMessage = ""
        lastLiveEvent = null
        send(buildJsonObject { put("type", "connect"); put("username", tiktok) })
    }

    /** Dừng đúng một live. Không truyền tên thì dừng tất cả. */
    fun disconnectLive(name: String? = null) {
        send(buildJsonObject { put("type", "disconnect"); if (name != null) put("username", name) })
        if (!serverSupportsSync) liveState = "idle"
    }

    fun live(tiktok: String): LiveInfo? = lives.firstOrNull { it.username.equals(tiktok, ignoreCase = true) }

    // MARK: - Đồng bộ dữ liệu

    /** Gom các thay đổi gần nhau rồi gửi một lần. */
    fun scheduleSync(store: Store) {
        syncJob?.cancel()
        syncJob = scope.launch {
            delay(300)
            flushSync(store)
        }
    }

    fun flushSync(store: Store) {
        val socket = ws ?: return
        if (!serverSupportsSync) return
        val update = store.makeSyncUpdate() ?: return
        val text = try {
            AppJson.encodeToString(SyncUpdate.serializer(), update)
        } catch (e: Exception) {
            store.syncInterrupted()
            return
        }
        if (!socket.send(text)) store.syncInterrupted()
    }

    /** Lấy bù những bình luận có trong lúc app không nối được (khoá màn hình, mất mạng). */
    suspend fun catchUpComments(store: Store) {
        if (!serverSupportsSync) return
        // Lùi lại một chút để không sót bình luận về sát lúc mất kết nối; trùng thì tự bỏ qua.
        var since: Long? = store.latestCommentDate?.minus(120_000)
        repeat(10) {
            val page = fetchComments(since?.let { mapOf("since" to it.toString()) } ?: emptyMap(), 1000) ?: return
            store.addComments(page.comments)
            val last = page.comments.maxOfOrNull { it.ts }
            if (!page.hasMore || since == null || last == null) return
            since = last
        }
    }

    /** Lấy một trang bình luận cũ hơn của phiên để xem. Không có vị trí thì lấy từ mới nhất. */
    suspend fun fetchOlderComments(sessionId: String, before: CommentCursor?): CommentsPage? {
        if (!serverSupportsSync) return null
        val q = mutableMapOf("sessionId" to sessionId)
        if (before != null) {
            q["before"] = before.ms.toString()
            q["beforeId"] = before.id
        }
        return fetchComments(q, 200)
    }

    private suspend fun fetchComments(extra: Map<String, String>, limit: Int): CommentsPage? {
        val url = (baseURL + "/api/comments").toHttpUrlOrNull()?.newBuilder()?.apply {
            addQueryParameter("format", "native")
            addQueryParameter("limit", limit.toString())
            extra.forEach { (k, v) -> addQueryParameter(k, v) }
        }?.build() ?: return null
        val req = Request.Builder().url(url).header("Authorization", "Bearer $token").build()
        val text = withContext(Dispatchers.IO) {
            try {
                http.newCall(req).execute().use { r -> if (r.code == 200) r.body?.string() else null }
            } catch (e: Exception) {
                null
            }
        } ?: return null
        val page = try {
            AppJson.decodeFromString(CommentsPage.serializer(), text)
        } catch (e: Exception) {
            return null
        }
        // Giá tính theo cùng quy tắc với bình luận nhận trực tiếp trên app.
        return page.copy(comments = page.comments.map { it.copy(price = PriceParser.parse(it.text)) })
    }

    // MARK: - Chat với Admin

    private suspend fun supportCall(path: String, method: String = "GET", body: JsonObject? = null): Pair<Int, JsonObject>? {
        if (!loggedIn || token.isEmpty()) return null
        val url = (baseURL + path).toHttpUrlOrNull() ?: return null
        val b = Request.Builder().url(url).header("Authorization", "Bearer $token")
        if (method == "POST") b.post((body ?: JsonObject(emptyMap())).toString().toRequestBody(JSON))
        return call(b.build())
    }

    /** Hỏi số tin chưa đọc (lúc mở app hoặc vừa nối lại server). */
    fun refreshSupportUnread() {
        scope.launch {
            val (code, json) = supportCall("/api/support/sessions") ?: return@launch
            if (code == 200) supportUnread = json.num("unread")?.toInt() ?: 0
        }
    }

    /** Mọi phiên kèm toàn bộ tin nhắn (mới nhất trước). */
    suspend fun fetchSupportThreads(): List<SupportThread>? {
        val (code, json) = supportCall("/api/support/sessions?full=1") ?: return null
        if (code != 200) return null
        supportUnread = json.num("unread")?.toInt() ?: supportUnread
        return json.arr("sessions")?.mapNotNull { e ->
            val d = e.asObj() ?: return@mapNotNull null
            val s = SupportSession.from(d) ?: return@mapNotNull null
            SupportThread(s, d.arr("messages")?.mapNotNull { m -> m.asObj()?.let { SupportMessage.from(it) } } ?: emptyList())
        } ?: emptyList()
    }

    suspend fun endSupportSession() {
        supportCall("/api/support/end", "POST")
    }

    suspend fun sendSupport(text: String): SupportMessage {
        val (code, json) = supportCall("/api/support/messages", "POST", buildJsonObject { put("text", text) })
            ?: throw ClientError("Không gửi được, vui lòng kiểm tra mạng rồi thử lại.")
        val m = json.obj("message")?.let { SupportMessage.from(it) }
        if (code != 200 || m == null) throw ClientError(json.str("error") ?: "Không gửi được tin nhắn.")
        return m
    }

    suspend fun markSupportRead() {
        supportUnread = 0
        supportCall("/api/support/read", "POST")
    }

    private fun handleSupport(m: JsonObject) {
        val msg = m.obj("message")?.let { SupportMessage.from(it) } ?: return
        lastSupportMessage = msg
        if (msg.sender != "admin") return
        if (supportChatOpen) {
            scope.launch { markSupportRead() }
        } else {
            supportUnread = m.num("unread")?.toInt() ?: (supportUnread + 1)
            notifySupport(msg.text)
        }
    }

    // MARK: - Dùng thử và gói

    private fun updateAccess(a: AccountAccess?) {
        access = a
        scheduleAccessCheck()
    }

    /** Hỏi lại server thời hạn dùng của tài khoản. */
    fun refreshAccess() {
        if (!loggedIn || token.isEmpty()) return
        val url = (baseURL + "/api/auth/me").toHttpUrlOrNull() ?: return
        val key = currentAccountKey
        val req = Request.Builder().url(url).header("Authorization", "Bearer $token").build()
        scope.launch {
            val reply = call(req)
            if (currentAccountKey != key) return@launch
            val raw = reply?.takeIf { it.first == 200 }?.second?.obj("user")?.obj("access")
            if (raw != null) updateAccess(AccountAccess.from(raw)) else scheduleAccessCheck()
        }
    }

    /** Hỏi lại ngay sau mốc hết hạn; đã quá mốc mà server vẫn chưa báo hết thì hỏi lại mỗi 5 giây. */
    private fun scheduleAccessCheck() {
        accessJob?.cancel()
        accessJob = null
        val a = access ?: return
        val end = a.endsAt ?: return
        if (!a.canFollowLive || a.status == "admin") return
        val delayMs = maxOf(5_000L, end - System.currentTimeMillis() + 1000)
        accessJob = scope.launch {
            delay(delayMs)
            refreshAccess()
        }
    }

    /** App quay lại màn hình: kiểm tra kết nối còn sống không, để nối lại ngay. */
    fun checkSocket() {
        if (!loggedIn) return
        refreshAccess()
        if (ws == null) openSocket() else send(buildJsonObject { put("type", "ping") })
    }

    // MARK: - WebSocket

    private fun openSocket() {
        closeSocket()
        if (token.isEmpty()) return
        val base = baseURL.toHttpUrlOrNull() ?: return
        val url = base.newBuilder().encodedPath("/ws")
            .addQueryParameter("token", token).addQueryParameter("native", "1").build()
        val wsUrl = url.toString().replaceFirst("https://", "wss://").replaceFirst("http://", "ws://")
        val request = Request.Builder().url(wsUrl).build()
        lateinit var socket: WebSocket
        socket = http.newWebSocket(request, object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                main.post {
                    if (ws !== socket) return@post
                    socketConnected = true
                    handle(text)
                }
            }

            override fun onOpen(webSocket: WebSocket, response: Response) {
                main.post { if (ws === socket) socketConnected = true }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                main.post { if (ws === socket) socketClosed() }
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                main.post { if (ws === socket) socketClosed() }
            }
        })
        ws = socket
        main.postDelayed(pingRunnable, 20_000)
    }

    private fun closeSocket() {
        main.removeCallbacks(pingRunnable)
        ws?.close(1001, null)
        ws = null
        socketConnected = false
        onSocketClosed?.invoke()
    }

    private fun send(obj: JsonObject) {
        ws?.send(obj.toString())
    }

    private fun socketClosed() {
        closeSocket()
        if (!loggedIn) return
        reconnectJob?.cancel()
        reconnectJob = scope.launch {
            delay(3000)
            if (loggedIn && ws == null) openSocket()
        }
    }

    /** Trạng thái chung cho các màn chỉ cần biết "có đang live không". */
    private fun applyLives(raw: List<JsonObject>) {
        val next = raw.mapNotNull { LiveInfo.from(it) }
        if (next != lives) lives = next
        viewers = next.sumOf { it.viewers }
        val lead = next.firstOrNull { it.state == "connected" } ?: next.firstOrNull()
        liveUsername = lead?.username ?: ""
        val state = lead?.state ?: "idle"
        if (state != liveState) liveState = state
    }

    private fun decodeSnapshot(m: JsonObject): ServerSnapshot? {
        // Lỗi đọc dữ liệu từ server: giữ nguyên dữ liệu trên máy, lần sau server gửi lại.
        val raw = m.obj("snapshot") ?: return null
        return try {
            AppJson.decodeFromJsonElement(ServerSnapshot.serializer(), raw)
        } catch (e: Exception) {
            null
        }
    }

    private fun handle(text: String) {
        val m = try {
            AppJson.parseToJsonElement(text).asObj()
        } catch (e: Exception) {
            null
        } ?: return
        when (m.str("type")) {
            "hello" -> {
                val version = m.num("version")?.toInt() ?: 0
                serverSupportsSync = version >= 4
                m.num("clientsCount")?.let { clientsCount = it.toInt() }
                m.obj("user")?.obj("access")?.let { updateAccess(AccountAccess.from(it)) }
                val livesRaw = m.arr("lives")
                if (serverSupportsSync && livesRaw != null) {
                    applyLives(livesRaw.mapNotNull { it.asObj() })
                } else {
                    m.obj("liveStatus")?.let { ls ->
                        liveUsername = ls.str("username") ?: ""
                        liveState = ls.str("state") ?: "idle"
                    }
                }
                if (serverSupportsSync) {
                    decodeSnapshot(m)?.let { snap ->
                        val h = onHello
                        if (h != null) h(snap) else pendingHello = snap
                    }
                }
                refreshSupportUnread()
            }
            "lives" -> m.arr("lives")?.let { applyLives(it.mapNotNull { e -> e.asObj() }) }
            "native_state" -> decodeSnapshot(m)?.let { onSnapshot?.invoke(it) }
            "native_ack" -> {
                m.num("clientsCount")?.let { clientsCount = it.toInt() }
                m.num("id")?.let { onSyncAck?.invoke(it.toInt()) }
            }
            "clients_count" -> m.num("clientsCount")?.let { clientsCount = it.toInt() }
            "access" -> m.obj("access")?.let { updateAccess(AccountAccess.from(it)) }
            "status" -> {
                val state = m.str("state") ?: "idle"
                val user = m.str("username") ?: ""
                liveMessage = m.str("message") ?: ""
                val code = m.str("code")
                if (code == "TRIAL_EXPIRED" || code == "PLAN_EXPIRED") accessNotice = liveMessage
                if (serverSupportsSync) {
                    if (state == "error" || state == "ended") lastLiveEvent = LiveEvent(user, state, liveMessage, ++eventSeq)
                } else {
                    if (user.isNotEmpty()) liveUsername = user
                    liveState = state
                }
            }
            "viewers" -> {
                val count = m.num("count")?.toInt() ?: 0
                val user = m.str("username")
                val i = if (serverSupportsSync && user != null) lives.indexOfFirst { it.username == user } else -1
                if (i >= 0) {
                    lives = lives.toMutableList().also { it[i] = it[i].copy(viewers = count) }
                    viewers = lives.sumOf { it.viewers }
                } else {
                    viewers = count
                }
            }
            "chat" -> {
                val body = m.str("comment") ?: ""
                val uid = m.str("uniqueId") ?: ""
                val c = LiveComment(
                    id = m.str("id") ?: UUID.randomUUID().toString().uppercase(),
                    uniqueId = uid,
                    userId = m.str("userId") ?: (m["userId"] as? JsonPrimitive)?.content ?: "",
                    nickname = m.str("nickname") ?: uid,
                    text = body,
                    ts = m.num("ts")?.toLong() ?: System.currentTimeMillis(),
                    price = PriceParser.parse(body),
                    sessionId = m.str("sessionId")?.takeIf { it.isNotEmpty() },
                )
                onChat?.invoke(c)
            }
            "support_message" -> handleSupport(m)
            "account_locked", "password_changed_force_login", "auth_error" -> {
                liveMessage = m.str("message") ?: "Phiên đăng nhập không còn hiệu lực"
                logout()
            }
        }
    }

    private suspend fun call(req: Request): Pair<Int, JsonObject>? = withContext(Dispatchers.IO) {
        try {
            http.newCall(req).execute().use { r ->
                val text = r.body?.string() ?: ""
                val json = try {
                    AppJson.parseToJsonElement(text).asObj()
                } catch (e: Exception) {
                    null
                }
                r.code to (json ?: JsonObject(emptyMap()))
            }
        } catch (e: Exception) {
            null
        }
    }

    companion object {
        private val JSON = "application/json".toMediaType()

        fun normalize(raw: String): String {
            var s = raw.trim().trimEnd('/')
            if (s.isEmpty()) return s
            if (!s.contains("://")) {
                val isIP = Regex("""^\d{1,3}(\.\d{1,3}){3}""").containsMatchIn(s)
                s = (if (isIP) "http://" else "https://") + s
            }
            return s
        }
    }
}
