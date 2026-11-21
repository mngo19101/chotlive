package com.chotlive.app.net

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import com.chotlive.app.data.TokenVault
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.math.BigInteger
import java.net.ConnectException
import java.net.URI
import java.net.UnknownHostException
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.util.Base64
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlin.math.abs
import kotlin.math.roundToLong

// Tiện ích cho phần "đẩy nháp Viettel Post" chạy trên máy (xem VtpDraftClient.kt), giống VtpDraftUtil.swift.

/** Đọc JSON lỏng của Viettel Post (số có thể là chuỗi, null...). */
object VtpJ {
    fun parse(text: String): JsonElement? = try { Json.parseToJsonElement(text) } catch (e: Exception) { null }
    fun obj(e: JsonElement?): JsonObject? = e as? JsonObject

    fun str(e: JsonElement?): String? {
        val p = e as? JsonPrimitive ?: return null
        if (p is JsonNull) return null
        if (p.isString) return p.content
        // Số nguyên dạng 12.0 thì bỏ phần lẻ, giống NSNumber.stringValue.
        val d = p.doubleOrNull
        if (d != null && d.isFinite() && d == Math.floor(d) && abs(d) < 1e15) return d.toLong().toString()
        return p.content
    }

    fun double(e: JsonElement?): Double? = str(e)?.trim()?.toDoubleOrNull()?.takeIf { it.isFinite() }

    fun int(e: JsonElement?): Int? {
        val d = double(e) ?: return null
        if (abs(d) >= 1e15) return null
        return d.roundToLong().toInt()
    }

    fun bool(e: JsonElement?): Boolean {
        val p = e as? JsonPrimitive ?: return false
        if (p is JsonNull) return false
        if (p.isString) return p.content == "true" || p.content == "1"
        p.booleanOrNull?.let { return it }
        return (p.doubleOrNull ?: 0.0) != 0.0
    }

    /** Viettel Post web coi là thành công khi `error` đúng bằng false (không thiếu, không null). */
    fun isFalse(e: JsonElement?): Boolean {
        val p = e as? JsonPrimitive ?: return false
        if (p is JsonNull || p.isString) return false
        p.booleanOrNull?.let { return !it }
        return p.doubleOrNull == 0.0
    }

    fun b64u(d: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(d)
    fun unb64u(s: String): ByteArray? = try { Base64.getUrlDecoder().decode(s) } catch (e: Exception) { null }

    /** Đọc trường `exp` (mili giây) của JWT, không kiểm chữ ký. */
    fun jwtExpiry(token: String?): Long? {
        val parts = token?.split(".") ?: return null
        if (parts.size != 3) return null
        val d = unb64u(parts[1]) ?: return null
        val exp = double(obj(parse(String(d, Charsets.UTF_8)))?.get("exp")) ?: return null
        return (exp * 1000).roundToLong()
    }
}

/** Che token và số điện thoại trước khi ghi nhật ký hay hiện ra màn hình. */
object VtpMask {
    private val phone = Regex("(?<!\\d)(?:0|\\+?84)\\d{8,10}(?!\\d)")
    private val jwt = Regex("eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+")
    private val longHex = Regex("(?<![A-Za-z0-9])[A-Fa-f0-9]{32,}(?![A-Za-z0-9])")

    fun text(s: String): String {
        var t = jwt.replace(s, "<token>")
        t = longHex.replace(t, "<mã>")
        return phone.replace(t) { m -> m.value.take(4) + " *** " + m.value.takeLast(3) }
    }
}

/** Lỗi đẩy nháp; `message` là chữ hiện cho người dùng. */
sealed class VtpDraftError(message: String) : Exception(message) {
    object NotLoggedIn : VtpDraftError("Chưa đăng nhập Viettel Post trên máy này")
    object SessionExpired : VtpDraftError("Phiên Viettel Post đã hết, đăng nhập lại")
    /** Cloudflare của Viettel Post chặn mạng này (403 trang HTML) hoặc báo gửi quá nhiều (429). */
    object Blocked : VtpDraftError("Viettel Post đang chặn kết nối từ mạng này, thử lại sau")
    class Network(message: String) : VtpDraftError(message)
    /** Lời Viettel Post báo, giữ nguyên để người dùng biết lý do thật. */
    class Server(message: String) : VtpDraftError(message)
}

class VtpDraftReply(val status: Int, val json: JsonElement?, val text: String, val nonce: String?)

/** Trả lời thô của một lần gửi (để test thay bằng hàm giả). */
class VtpDraftRaw(val status: Int, val text: String, val nonce: String?)

/** Gửi POST JSON; ném IOException khi mất mạng. */
typealias VtpDraftTransport = suspend (url: String, body: String, headers: Map<String, String>) -> VtpDraftRaw

object VtpDraftHttp {
    private val client = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()
    private val jsonType = "application/json".toMediaType()

    val live: VtpDraftTransport = { url, body, headers ->
        withContext(Dispatchers.IO) {
            val b = Request.Builder().url(url).post(body.toRequestBody(jsonType))
                .header("Accept", "application/json, text/plain, */*")
            for ((k, v) in headers) b.header(k, v)
            client.newCall(b.build()).execute().use { r ->
                VtpDraftRaw(r.code, r.body?.string() ?: "", r.header("X-Token-Nonce"))
            }
        }
    }

    suspend fun send(transport: VtpDraftTransport, url: String, body: JsonElement?, headers: Map<String, String>): VtpDraftReply {
        val raw = try {
            transport(url, body?.toString() ?: "", headers)
        } catch (e: IOException) {
            val offline = e is UnknownHostException || e is ConnectException
            throw VtpDraftError.Network(if (offline) "Mất mạng, thử lại khi có mạng" else "Viettel Post không trả lời, thử lại sau")
        }
        val json = VtpJ.parse(raw.text)
        if (raw.status == 429 || (raw.status == 403 && json == null)) throw VtpDraftError.Blocked
        return VtpDraftReply(raw.status, json, raw.text, raw.nonce)
    }
}

// MARK: - Khoá ký DPoP

/** Khoá P-256 của máy để ký DPoP. Khoá riêng không rời Android Keystore. */
class VtpDraftKey(val publicKey: ECPublicKey, private val private: PrivateKey) {
    /** Toạ độ x, y của khoá công khai, mỗi phần 32 byte. */
    val x: ByteArray get() = fixed(publicKey.w.affineX)
    val y: ByteArray get() = fixed(publicKey.w.affineY)

    /** Chữ ký ES256 dạng thô r||s (64 byte) như JWT cần. */
    fun sign(data: ByteArray): ByteArray {
        val s = Signature.getInstance("SHA256withECDSA")
        s.initSign(private)
        s.update(data)
        return derToRaw(s.sign())
    }

    companion object {
        private fun fixed(n: BigInteger): ByteArray {
            val b = n.toByteArray()
            return when {
                b.size == 32 -> b
                b.size > 32 -> b.copyOfRange(b.size - 32, b.size)
                else -> ByteArray(32 - b.size) + b
            }
        }

        /** Chữ ký DER (SEQUENCE { INTEGER r, INTEGER s }) → r||s. */
        fun derToRaw(der: ByteArray): ByteArray {
            var i = 2
            if (der[1].toInt() and 0x80 != 0) i += der[1].toInt() and 0x7f
            fun readInt(): BigInteger {
                require(der[i].toInt() == 0x02)
                val len = der[i + 1].toInt() and 0xff
                val v = BigInteger(1, der.copyOfRange(i + 2, i + 2 + len))
                i += 2 + len
                return v
            }
            val r = readInt()
            val s = readInt()
            return fixed(r) + fixed(s)
        }
    }
}

/** Nơi giữ khoá ký theo tên. Bản thật dùng Android Keystore; test dùng khoá phần mềm. */
interface VtpDraftKeys {
    fun load(alias: String): VtpDraftKey?
    fun create(alias: String): VtpDraftKey
    fun delete(alias: String)
}

object VtpDraftKeystore : VtpDraftKeys {
    private fun ks() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    override fun load(alias: String): VtpDraftKey? = try {
        val ks = ks()
        val priv = ks.getKey(alias, null) as? PrivateKey
        val pub = ks.getCertificate(alias)?.publicKey as? ECPublicKey
        if (priv != null && pub != null) VtpDraftKey(pub, priv) else null
    } catch (e: Exception) {
        null
    }

    override fun create(alias: String): VtpDraftKey {
        val gen = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
        gen.initialize(
            KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
                .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .build()
        )
        val kp = gen.generateKeyPair()
        return VtpDraftKey(kp.public as ECPublicKey, kp.private)
    }

    override fun delete(alias: String) {
        try { ks().deleteEntry(alias) } catch (e: Exception) { }
    }
}

/** Khoá phần mềm trong bộ nhớ, cho test. */
class VtpDraftMemoryKeys : VtpDraftKeys {
    private val map = HashMap<String, VtpDraftKey>()
    override fun load(alias: String) = map[alias]
    override fun create(alias: String): VtpDraftKey {
        val gen = KeyPairGenerator.getInstance("EC")
        gen.initialize(ECGenParameterSpec("secp256r1"))
        val kp = gen.generateKeyPair()
        return VtpDraftKey(kp.public as ECPublicKey, kp.private).also { map[alias] = it }
    }
    override fun delete(alias: String) { map.remove(alias) }
}

/** Chữ ký DPoP (X-Token) giống trang viettelpost.vn: JWT ES256, khoá P-256 của máy, ath = SHA-256 của token. */
object VtpDpop {
    fun proof(key: VtpDraftKey, method: String, url: String, accessToken: String?, nonce: String?,
              jti: String = UUID.randomUUID().toString().lowercase(), iatMs: Long = System.currentTimeMillis()): String {
        val u = URI(url)
        val header = buildJsonObject {
            put("typ", "dpop+jwt")
            put("alg", "ES256")
            put("jwk", buildJsonObject {
                put("kty", "EC")
                put("crv", "P-256")
                put("x", VtpJ.b64u(key.x))
                put("y", VtpJ.b64u(key.y))
            })
        }
        val payload = buildJsonObject {
            put("jti", jti)
            put("htm", method.uppercase())
            put("htu", "${u.scheme ?: "https"}://${u.host ?: ""}${u.rawPath ?: ""}")
            put("iat", iatMs / 1000)
            if (!accessToken.isNullOrEmpty()) put("ath", ath(accessToken))
            if (!nonce.isNullOrEmpty()) put("nonce", nonce)
        }
        val input = VtpJ.b64u(header.toString().toByteArray()) + "." + VtpJ.b64u(payload.toString().toByteArray())
        return input + "." + VtpJ.b64u(key.sign(input.toByteArray()))
    }

    fun ath(token: String): String = VtpJ.b64u(MessageDigest.getInstance("SHA-256").digest(token.toByteArray()))
}

// MARK: - Nơi lưu

/** Chỗ cất bí mật (token, refresh token). Bản thật mã hoá bằng khoá trong Android Keystore. */
interface VtpDraftSecrets {
    fun get(key: String): String?
    fun set(key: String, value: String?)
}

/** Cài đặt thường (mã máy, tên, kho). */
interface VtpDraftPrefs {
    fun string(key: String): String?
    fun setString(key: String, value: String?)
    fun bool(key: String): Boolean = string(key) == "1"
    fun setBool(key: String, value: Boolean) = setString(key, if (value) "1" else null)
}

class VtpDraftSharedPrefs(context: Context, name: String) : VtpDraftPrefs {
    private val p: SharedPreferences = context.getSharedPreferences(name, Context.MODE_PRIVATE)
    override fun string(key: String): String? = p.getString(key, null)
    override fun setString(key: String, value: String?) {
        p.edit().apply { if (value == null) remove(key) else putString(key, value) }.apply()
    }
}

class VtpDraftVault(context: Context) : VtpDraftSecrets {
    private val p = VtpDraftSharedPrefs(context, "vtp_draft_secrets")
    override fun get(key: String): String? = p.string(key)?.let { TokenVault.open(it) }
    override fun set(key: String, value: String?) = p.setString(key, value?.let { TokenVault.seal(it) })
}

class VtpDraftMemoryStore : VtpDraftSecrets, VtpDraftPrefs {
    val map = HashMap<String, String>()
    override fun get(key: String) = map[key]
    override fun set(key: String, value: String?) { if (value == null) map.remove(key) else map[key] = value }
    override fun string(key: String) = map[key]
    override fun setString(key: String, value: String?) = set(key, value)
}

class VtpDraftLogEntry(val time: Long, val title: String, val detail: String, val ok: Boolean) {
    val id: String = UUID.randomUUID().toString()
}
