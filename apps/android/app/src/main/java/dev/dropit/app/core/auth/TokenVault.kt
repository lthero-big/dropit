package dev.dropit.app.core.auth

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

interface TokenVault {
    suspend fun getToken(): String?
    suspend fun saveToken(token: String)
    suspend fun clearToken()
    suspend fun hasToken(): Boolean = !getToken().isNullOrBlank()
}

/**
 * Pure AES-256-GCM encryption helper used by [AndroidKeystoreTokenVault].
 * Format: `v1:<hex-iv>:<hex-ciphertext-with-tag>`.
 * Uses standard JCE/Keystore randomized IV generation during ENCRYPT_MODE so it works
 * identically with AndroidKeyStore (setRandomizedEncryptionRequired=true) and JVM JCE tests.
 */
object AesGcmCrypto {
    private const val TRANSFORMATION = "AES/GCM/NoPadding"
    private const val TAG_LENGTH_BITS = 128
    private const val VERSION_PREFIX = "v1"
    private val HEX_CHARS = "0123456789abcdef".toCharArray()

    fun encrypt(plainText: String, key: SecretKey): String {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key)
        val iv = cipher.iv
        require(iv != null && iv.isNotEmpty()) { "Cipher did not produce a valid GCM IV" }
        val cipherBytes = cipher.doFinal(plainText.toByteArray(Charsets.UTF_8))
        return "$VERSION_PREFIX:${toHex(iv)}:${toHex(cipherBytes)}"
    }

    fun decrypt(blob: String, key: SecretKey): String {
        val parts = blob.split(':')
        require(parts.size == 3 && parts[0] == VERSION_PREFIX) { "Unsupported ciphertext format" }
        val iv = fromHex(parts[1])
        val cipherBytes = fromHex(parts[2])
        require(iv.size == 12 && cipherBytes.size > 16) { "Invalid GCM payload length" }
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TAG_LENGTH_BITS, iv))
        val plainBytes = cipher.doFinal(cipherBytes)
        return String(plainBytes, Charsets.UTF_8)
    }

    internal fun toHex(bytes: ByteArray): String {
        val out = CharArray(bytes.size * 2)
        for (i in bytes.indices) {
            val v = bytes[i].toInt() and 0xFF
            out[i * 2] = HEX_CHARS[v ushr 4]
            out[i * 2 + 1] = HEX_CHARS[v and 0x0F]
        }
        return String(out)
    }

    internal fun fromHex(hex: String): ByteArray {
        require(hex.length % 2 == 0) { "Odd hex length" }
        val out = ByteArray(hex.length / 2)
        for (i in out.indices) {
            val hi = hexDigit(hex[i * 2])
            val lo = hexDigit(hex[i * 2 + 1])
            require(hi >= 0 && lo >= 0) { "Invalid hex character" }
            out[i] = ((hi shl 4) or lo).toByte()
        }
        return out
    }

    private fun hexDigit(c: Char): Int = when (c) {
        in '0'..'9' -> c - '0'
        in 'a'..'f' -> c - 'a' + 10
        in 'A'..'F' -> c - 'A' + 10
        else -> -1
    }
}

/**
 * Encrypts the device Bearer token using an Android Keystore AES-256-GCM key before
 * persisting the ciphertext in private SharedPreferences. Plaintext tokens are never written to disk.
 */
class AndroidKeystoreTokenVault(
    context: Context,
    private val keyAlias: String = DEFAULT_KEY_ALIAS,
) : TokenVault {
    private val prefs = context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    private val mutex = Mutex()

    override suspend fun getToken(): String? = mutex.withLock {
        withContext(Dispatchers.IO) {
            val blob = prefs.getString(KEY_ENCRYPTED_TOKEN, null) ?: return@withContext null
            runCatching {
                val key = getOrCreateSecretKey()
                AesGcmCrypto.decrypt(blob, key).takeIf { it.isNotBlank() }
            }.getOrNull()
        }
    }

    override suspend fun saveToken(token: String) = mutex.withLock {
        require(token.isNotBlank()) { "Token must not be blank" }
        withContext(Dispatchers.IO) {
            val key = getOrCreateSecretKey()
            val encrypted = AesGcmCrypto.encrypt(token, key)
            prefs.edit().putString(KEY_ENCRYPTED_TOKEN, encrypted).commit()
            Unit
        }
    }

    override suspend fun clearToken() = mutex.withLock {
        withContext(Dispatchers.IO) {
            prefs.edit().remove(KEY_ENCRYPTED_TOKEN).commit()
            Unit
        }
    }

    private fun getOrCreateSecretKey(): SecretKey {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        val existing = (keyStore.getEntry(keyAlias, null) as? KeyStore.SecretKeyEntry)?.secretKey
        if (existing != null) return existing

        val keyGenerator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        val spec = KeyGenParameterSpec.Builder(
            keyAlias,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setRandomizedEncryptionRequired(true)
            .build()
        keyGenerator.init(spec)
        return keyGenerator.generateKey()
    }

    companion object {
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val DEFAULT_KEY_ALIAS = "dropit_device_token_aes256_gcm_v1"
        private const val PREFS_NAME = "dropit_token_vault"
        private const val KEY_ENCRYPTED_TOKEN = "encrypted_token"
    }
}

/**
 * In-memory [TokenVault] suitable for unit tests and Compose previews.
 */
class InMemoryTokenVault(initialToken: String? = null) : TokenVault {
    private val mutex = Mutex()
    private var token: String? = initialToken

    override suspend fun getToken(): String? = mutex.withLock { token }

    override suspend fun saveToken(token: String) = mutex.withLock {
        require(token.isNotBlank()) { "Token must not be blank" }
        this.token = token
    }

    override suspend fun clearToken() = mutex.withLock {
        this.token = null
    }
}
