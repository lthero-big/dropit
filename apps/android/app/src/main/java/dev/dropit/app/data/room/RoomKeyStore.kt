package dev.dropit.app.data.room

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import dev.dropit.app.core.auth.AesGcmCrypto
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey

/**
 * Persists per-server temporary room secrets (`deviceKey`), owned room tokens,
 * and remembered room access tokens (`code -> roomToken`).
 *
 * The secret `deviceKey` proves room ownership to `POST /api/rooms` and
 * `PUT /api/rooms/:room/code`, so production storage encrypts it with Android Keystore
 * AES-256-GCM and clears all entries atomically on server switch.
 */
interface RoomKeyStore {
    suspend fun getOrCreateDeviceKey(serverOrigin: String): String
    suspend fun getDeviceKey(serverOrigin: String): String?
    suspend fun saveOwnedRoomToken(serverOrigin: String, roomToken: String)
    suspend fun getOwnedRoomToken(serverOrigin: String): String?
    suspend fun rememberRoomAccess(serverOrigin: String, code: String, roomToken: String)
    suspend fun getRememberedRoomToken(serverOrigin: String, code: String): String?
    suspend fun forgetRoomAccess(serverOrigin: String, code: String)
    suspend fun clearForOrigin(serverOrigin: String)
    suspend fun clearAll()
}

object RoomKeyGenerator {
    private val DEVICE_KEY_PATTERN = Regex("^[A-Za-z0-9_-]{32,128}$")
    private const val BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    private val secureRandom = SecureRandom()

    fun generateDeviceKey(): String {
        val bytes = ByteArray(32)
        secureRandom.nextBytes(bytes)
        return encodeBase64UrlNoPadding(bytes)
    }

    fun isValidDeviceKey(value: String?): Boolean =
        value != null && DEVICE_KEY_PATTERN.matches(value)

    internal fun encodeBase64UrlNoPadding(bytes: ByteArray): String {
        val out = StringBuilder((bytes.size * 4 + 2) / 3)
        var i = 0
        while (i < bytes.size) {
            val b0 = bytes[i].toInt() and 0xFF
            val hasB1 = i + 1 < bytes.size
            val hasB2 = i + 2 < bytes.size
            val b1 = if (hasB1) bytes[i + 1].toInt() and 0xFF else 0
            val b2 = if (hasB2) bytes[i + 2].toInt() and 0xFF else 0

            out.append(BASE64URL_ALPHABET[b0 ushr 2])
            out.append(BASE64URL_ALPHABET[((b0 and 0x03) shl 4) or (b1 ushr 4)])
            if (hasB1) {
                out.append(BASE64URL_ALPHABET[((b1 and 0x0F) shl 2) or (b2 ushr 6)])
            }
            if (hasB2) {
                out.append(BASE64URL_ALPHABET[b2 and 0x3F])
            }
            i += 3
        }
        return out.toString()
    }
}

@Serializable
internal data class PersistedRoomSecrets(
    val origins: Map<String, OriginRoomSecrets> = emptyMap(),
)

@Serializable
internal data class OriginRoomSecrets(
    val deviceKey: String? = null,
    val ownedRoomToken: String? = null,
    val accessByCode: Map<String, String> = emptyMap(),
)

/**
 * Android Keystore AES-256-GCM backed [RoomKeyStore].
 * Stores all server-scoped room secrets in a single encrypted blob inside private SharedPreferences
 * so secret room keys are never written to disk in plaintext and [clearAll] wipes everything atomically.
 */
class AndroidKeystoreRoomKeyStore(
    context: Context,
    private val keyAlias: String = DEFAULT_KEY_ALIAS,
    private val deviceKeyGenerator: () -> String = { RoomKeyGenerator.generateDeviceKey() },
    private val json: Json = Json { ignoreUnknownKeys = true; isLenient = true },
) : RoomKeyStore {
    private val prefs = context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    private val mutex = Mutex()

    override suspend fun getOrCreateDeviceKey(serverOrigin: String): String = mutex.withLock {
        val originKey = normalizeOriginKey(serverOrigin)
        withContext(Dispatchers.IO) {
            val state = loadStateLocked()
            val existing = state.origins[originKey]?.deviceKey
            if (RoomKeyGenerator.isValidDeviceKey(existing)) {
                return@withContext existing!!
            }
            val generated = deviceKeyGenerator()
            require(RoomKeyGenerator.isValidDeviceKey(generated)) { "Generated room device key is invalid" }
            val currentOrigin = state.origins[originKey] ?: OriginRoomSecrets()
            val nextOrigins = state.origins.toMutableMap().apply {
                put(originKey, currentOrigin.copy(deviceKey = generated))
            }
            saveStateLocked(PersistedRoomSecrets(nextOrigins))
            generated
        }
    }

    override suspend fun getDeviceKey(serverOrigin: String): String? = mutex.withLock {
        val originKey = normalizeOriginKey(serverOrigin)
        withContext(Dispatchers.IO) {
            loadStateLocked().origins[originKey]?.deviceKey?.takeIf { RoomKeyGenerator.isValidDeviceKey(it) }
        }
    }

    override suspend fun saveOwnedRoomToken(serverOrigin: String, roomToken: String) = mutex.withLock {
        val originKey = normalizeOriginKey(serverOrigin)
        if (roomToken.isBlank()) return@withLock
        withContext(Dispatchers.IO) {
            val state = loadStateLocked()
            val currentOrigin = state.origins[originKey] ?: OriginRoomSecrets()
            val nextOrigins = state.origins.toMutableMap().apply {
                put(originKey, currentOrigin.copy(ownedRoomToken = roomToken))
            }
            saveStateLocked(PersistedRoomSecrets(nextOrigins))
        }
    }

    override suspend fun getOwnedRoomToken(serverOrigin: String): String? = mutex.withLock {
        val originKey = normalizeOriginKey(serverOrigin)
        withContext(Dispatchers.IO) {
            loadStateLocked().origins[originKey]?.ownedRoomToken?.takeIf { it.isNotBlank() }
        }
    }

    override suspend fun rememberRoomAccess(serverOrigin: String, code: String, roomToken: String) = mutex.withLock {
        val originKey = normalizeOriginKey(serverOrigin)
        val trimmedCode = code.trim()
        if (trimmedCode.isEmpty() || roomToken.isBlank()) return@withLock
        withContext(Dispatchers.IO) {
            val state = loadStateLocked()
            val currentOrigin = state.origins[originKey] ?: OriginRoomSecrets()
            val updatedMap = LinkedHashMap(currentOrigin.accessByCode).apply {
                remove(trimmedCode)
                put(trimmedCode, roomToken)
            }
            val capped = trimAccessMap(updatedMap)
            val nextOrigins = state.origins.toMutableMap().apply {
                put(originKey, currentOrigin.copy(accessByCode = capped))
            }
            saveStateLocked(PersistedRoomSecrets(nextOrigins))
        }
    }

    override suspend fun getRememberedRoomToken(serverOrigin: String, code: String): String? = mutex.withLock {
        val originKey = normalizeOriginKey(serverOrigin)
        val trimmedCode = code.trim()
        if (trimmedCode.isEmpty()) return@withLock null
        withContext(Dispatchers.IO) {
            loadStateLocked().origins[originKey]?.accessByCode?.get(trimmedCode)?.takeIf { it.isNotBlank() }
        }
    }

    override suspend fun forgetRoomAccess(serverOrigin: String, code: String) = mutex.withLock {
        val originKey = normalizeOriginKey(serverOrigin)
        val trimmedCode = code.trim()
        if (trimmedCode.isEmpty()) return@withLock
        withContext(Dispatchers.IO) {
            val state = loadStateLocked()
            val currentOrigin = state.origins[originKey] ?: return@withContext
            if (!currentOrigin.accessByCode.containsKey(trimmedCode)) return@withContext
            val nextMap = currentOrigin.accessByCode.toMutableMap().apply { remove(trimmedCode) }
            val nextOrigins = state.origins.toMutableMap().apply {
                put(originKey, currentOrigin.copy(accessByCode = nextMap))
            }
            saveStateLocked(PersistedRoomSecrets(nextOrigins))
        }
    }

    override suspend fun clearForOrigin(serverOrigin: String) = mutex.withLock {
        val originKey = normalizeOriginKey(serverOrigin)
        withContext(Dispatchers.IO) {
            val state = loadStateLocked()
            if (!state.origins.containsKey(originKey)) return@withContext
            val nextOrigins = state.origins.toMutableMap().apply { remove(originKey) }
            if (nextOrigins.isEmpty()) {
                prefs.edit().remove(KEY_ENCRYPTED_STATE).commit()
            } else {
                saveStateLocked(PersistedRoomSecrets(nextOrigins))
            }
            Unit
        }
    }

    override suspend fun clearAll() = mutex.withLock {
        withContext(Dispatchers.IO) {
            prefs.edit().remove(KEY_ENCRYPTED_STATE).commit()
            Unit
        }
    }

    private fun loadStateLocked(): PersistedRoomSecrets {
        val blob = prefs.getString(KEY_ENCRYPTED_STATE, null) ?: return PersistedRoomSecrets()
        return runCatching {
            val key = getOrCreateSecretKey()
            val plaintext = AesGcmCrypto.decrypt(blob, key)
            json.decodeFromString(PersistedRoomSecrets.serializer(), plaintext)
        }.getOrDefault(PersistedRoomSecrets())
    }

    private fun saveStateLocked(state: PersistedRoomSecrets) {
        val key = getOrCreateSecretKey()
        val plaintext = json.encodeToString(state)
        val encrypted = AesGcmCrypto.encrypt(plaintext, key)
        prefs.edit().putString(KEY_ENCRYPTED_STATE, encrypted).commit()
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
        private const val DEFAULT_KEY_ALIAS = "dropit_room_secret_key_aes256_gcm_v1"
        private const val PREFS_NAME = "dropit_room_vault"
        private const val KEY_ENCRYPTED_STATE = "encrypted_room_secrets"
        internal const val MAX_REMEMBERED_ROOMS_PER_ORIGIN = 50

        internal fun normalizeOriginKey(origin: String): String = origin.trim().trimEnd('/').lowercase()

        internal fun trimAccessMap(map: LinkedHashMap<String, String>): Map<String, String> {
            if (map.size <= MAX_REMEMBERED_ROOMS_PER_ORIGIN) return map.toMap()
            val entries = map.entries.toList().takeLast(MAX_REMEMBERED_ROOMS_PER_ORIGIN)
            return LinkedHashMap<String, String>(entries.size).apply {
                for ((k, v) in entries) put(k, v)
            }
        }
    }
}

/**
 * In-memory [RoomKeyStore] for JVM unit tests and integration verification.
 */
class InMemoryRoomKeyStore(
    private val deviceKeyGenerator: () -> String = { RoomKeyGenerator.generateDeviceKey() },
) : RoomKeyStore {
    private val mutex = Mutex()
    private val origins = LinkedHashMap<String, OriginRoomSecrets>()

    override suspend fun getOrCreateDeviceKey(serverOrigin: String): String = mutex.withLock {
        val key = AndroidKeystoreRoomKeyStore.normalizeOriginKey(serverOrigin)
        val existing = origins[key]?.deviceKey
        if (RoomKeyGenerator.isValidDeviceKey(existing)) return@withLock existing!!
        val generated = deviceKeyGenerator()
        require(RoomKeyGenerator.isValidDeviceKey(generated)) { "Generated room device key is invalid" }
        val current = origins[key] ?: OriginRoomSecrets()
        origins[key] = current.copy(deviceKey = generated)
        generated
    }

    override suspend fun getDeviceKey(serverOrigin: String): String? = mutex.withLock {
        val key = AndroidKeystoreRoomKeyStore.normalizeOriginKey(serverOrigin)
        origins[key]?.deviceKey?.takeIf { RoomKeyGenerator.isValidDeviceKey(it) }
    }

    override suspend fun saveOwnedRoomToken(serverOrigin: String, roomToken: String) = mutex.withLock {
        if (roomToken.isBlank()) return@withLock
        val key = AndroidKeystoreRoomKeyStore.normalizeOriginKey(serverOrigin)
        val current = origins[key] ?: OriginRoomSecrets()
        origins[key] = current.copy(ownedRoomToken = roomToken)
    }

    override suspend fun getOwnedRoomToken(serverOrigin: String): String? = mutex.withLock {
        val key = AndroidKeystoreRoomKeyStore.normalizeOriginKey(serverOrigin)
        origins[key]?.ownedRoomToken?.takeIf { it.isNotBlank() }
    }

    override suspend fun rememberRoomAccess(serverOrigin: String, code: String, roomToken: String) = mutex.withLock {
        val trimmedCode = code.trim()
        if (trimmedCode.isEmpty() || roomToken.isBlank()) return@withLock
        val key = AndroidKeystoreRoomKeyStore.normalizeOriginKey(serverOrigin)
        val current = origins[key] ?: OriginRoomSecrets()
        val next = LinkedHashMap(current.accessByCode).apply {
            remove(trimmedCode)
            put(trimmedCode, roomToken)
        }
        origins[key] = current.copy(accessByCode = AndroidKeystoreRoomKeyStore.trimAccessMap(next))
    }

    override suspend fun getRememberedRoomToken(serverOrigin: String, code: String): String? = mutex.withLock {
        val trimmedCode = code.trim()
        if (trimmedCode.isEmpty()) return@withLock null
        val key = AndroidKeystoreRoomKeyStore.normalizeOriginKey(serverOrigin)
        origins[key]?.accessByCode?.get(trimmedCode)?.takeIf { it.isNotBlank() }
    }

    override suspend fun forgetRoomAccess(serverOrigin: String, code: String) = mutex.withLock {
        val trimmedCode = code.trim()
        if (trimmedCode.isEmpty()) return@withLock
        val key = AndroidKeystoreRoomKeyStore.normalizeOriginKey(serverOrigin)
        val current = origins[key] ?: return@withLock
        if (!current.accessByCode.containsKey(trimmedCode)) return@withLock
        val next = current.accessByCode.toMutableMap().apply { remove(trimmedCode) }
        origins[key] = current.copy(accessByCode = next)
    }

    override suspend fun clearForOrigin(serverOrigin: String) = mutex.withLock {
        origins.remove(AndroidKeystoreRoomKeyStore.normalizeOriginKey(serverOrigin))
        Unit
    }

    override suspend fun clearAll() = mutex.withLock {
        origins.clear()
    }

    suspend fun allOrigins(): Set<String> = mutex.withLock { origins.keys.toSet() }
}
