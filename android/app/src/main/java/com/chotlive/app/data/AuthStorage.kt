package com.chotlive.app.data

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import java.security.KeyStore
import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Token đăng nhập được mã hoá bằng khoá nằm trong Android Keystore (tương tự Keychain bên iPhone). */
private object TokenVault {
    private const val ALIAS = "chotlive.auth"

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        )
        return gen.generateKey()
    }

    fun seal(plain: String): String? = try {
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, key())
        val out = c.iv + c.doFinal(plain.toByteArray(Charsets.UTF_8))
        Base64.encodeToString(out, Base64.NO_WRAP)
    } catch (e: Exception) {
        null
    }

    fun open(sealed: String): String? = try {
        val raw = Base64.decode(sealed, Base64.NO_WRAP)
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, raw, 0, 12))
        String(c.doFinal(raw, 12, raw.size - 12), Charsets.UTF_8)
    } catch (e: Exception) {
        null
    }
}

/**
 * Các phiên đăng nhập ChốtLive đã lưu trên máy — mỗi tài khoản một token riêng,
 * nên có thể đổi qua lại giữa nhiều tài khoản mà không cần nhập lại mật khẩu.
 */
class AuthStorage(context: Context) {
    @Serializable
    data class SavedAccount(val key: String, val server: String, val user: String)

    private val prefs: SharedPreferences = context.getSharedPreferences("auth", Context.MODE_PRIVATE)
    private val tokens: SharedPreferences = context.getSharedPreferences("auth_tokens", Context.MODE_PRIVATE)

    val server: String? get() = prefs.getString(SERVER_KEY, null)
    val user: String? get() = prefs.getString(USER_KEY, null)

    // MARK: - Danh sách tài khoản đã lưu

    fun savedAccounts(): List<SavedAccount> {
        val raw = prefs.getString(SAVED_KEY, null) ?: return emptyList()
        return try {
            AppJson.decodeFromString(ListSerializer(SavedAccount.serializer()), raw)
        } catch (e: Exception) {
            emptyList()
        }
    }

    private fun setSavedAccounts(list: List<SavedAccount>) {
        prefs.edit().putString(SAVED_KEY, AppJson.encodeToString(ListSerializer(SavedAccount.serializer()), list)).apply()
    }

    private fun remember(account: SavedAccount) {
        setSavedAccounts(savedAccounts().filter { it.key != account.key } + account)
    }

    /** Token đã lưu của một tài khoản (đang dùng hay không cũng vậy). */
    fun token(key: String): String? = tokens.getString(tokenAccount(key), null)?.let { TokenVault.open(it) }

    // MARK: - Phiên đang dùng

    fun currentAccountKey(): String? {
        val s = server
        val u = user
        if (s.isNullOrEmpty() || u.isNullOrEmpty()) return null
        return accountKey(s, u)
    }

    fun currentToken(): String = currentAccountKey()?.let { token(it) } ?: ""

    /** Lưu một phiên đăng nhập (đăng nhập lần đầu hoặc thêm tài khoản khác) và đặt làm tài khoản hiện tại. */
    fun saveSession(server: String, user: String, token: String) {
        val key = accountKey(server, user)
        prefs.edit().putString(SERVER_KEY, server).putString(USER_KEY, user).apply()
        TokenVault.seal(token)?.let { tokens.edit().putString(tokenAccount(key), it).apply() }
        remember(SavedAccount(key, server, user))
    }

    /** Chuyển sang một tài khoản đã lưu (đã có token hợp lệ), không cần đăng nhập lại. */
    fun switchCurrent(key: String): SavedAccount? {
        val account = savedAccounts().firstOrNull { it.key == key } ?: return null
        prefs.edit().putString(SERVER_KEY, account.server).putString(USER_KEY, account.user).apply()
        return account
    }

    /** Đăng xuất tài khoản đang dùng: xoá token và khỏi danh sách đã lưu. */
    fun clearCurrentSession() {
        val key = currentAccountKey() ?: return
        setSavedAccounts(savedAccounts().filter { it.key != key })
        tokens.edit().remove(tokenAccount(key)).apply()
    }

    /** Quên một tài khoản đã lưu khác — không tác động tới tài khoản đang dùng. */
    fun forgetAccount(key: String) {
        if (currentAccountKey() == key) return
        setSavedAccounts(savedAccounts().filter { it.key != key })
        tokens.edit().remove(tokenAccount(key)).apply()
    }

    companion object {
        private const val SERVER_KEY = "serverURL"
        private const val USER_KEY = "authUser"
        private const val SAVED_KEY = "savedAppAccounts"

        /** Mỗi tài khoản trên mỗi server có một vùng dữ liệu riêng. */
        fun accountKey(server: String, user: String): String =
            server.trim().lowercase() + "|" + user.trim().lowercase()

        /** Tên thư mục dữ liệu của tài khoản. */
        fun folderName(account: String): String =
            MessageDigest.getInstance("SHA-256").digest(account.toByteArray(Charsets.UTF_8))
                .take(16).joinToString("") { "%02x".format(it) }

        private fun tokenAccount(key: String) = "token:$key"
    }
}
