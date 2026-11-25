package dev.dropit.app.core.auth

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import dev.dropit.app.core.network.ServerUrl
import dev.dropit.app.core.network.parseScopeString
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

enum class ThemeMode(val storageValue: String) {
    SYSTEM("system"),
    LIGHT("light"),
    DARK("dark"),
    ;

    companion object {
        fun fromStorage(raw: String?): ThemeMode =
            entries.firstOrNull { it.storageValue.equals(raw, ignoreCase = true) } ?: SYSTEM
    }
}

enum class PendingOAuthFlowMode {
    LOGIN,
    LINK,
}

/**
 * Non-sensitive OAuth flow correlation state persisted across Chrome Custom Tabs round-trips
 * (never stores tokens or secrets).
 */
data class PendingOAuthFlowRecord(
    val mode: PendingOAuthFlowMode,
    val provider: String,
    val serverOrigin: String,
    val state: String,
)

data class AppSettings(
    val serverOrigin: String? = null,
    val deviceId: String = "",
    val themeMode: ThemeMode = ThemeMode.SYSTEM,
    val skipUpdateVersionCode: Int? = null,
    val legacyMigrated: Boolean = false,
    val tokenScopes: Set<String> = emptySet(),
    val mustChangePassword: Boolean = false,
)

/**
 * Stores non-sensitive client preferences (never Bearer tokens).
 */
interface SettingsStore {
    val settings: Flow<AppSettings>

    suspend fun current(): AppSettings
    suspend fun getServerOrigin(): String?
    suspend fun setServerOrigin(origin: String?)
    suspend fun getOrCreateDeviceId(): String
    suspend fun setDeviceId(deviceId: String)
    suspend fun setThemeMode(mode: ThemeMode)
    suspend fun setSkipUpdateVersionCode(versionCode: Int?)
    suspend fun isLegacyMigrated(): Boolean
    suspend fun markLegacyMigrated()
    suspend fun clearServerConfig()

    // Stage 7 non-sensitive auth metadata (default no-op for legacy test fakes)
    suspend fun getTokenScopes(): Set<String> = current().tokenScopes
    suspend fun setTokenScopes(scopes: Set<String>) = Unit
    suspend fun isMustChangePassword(): Boolean = current().mustChangePassword
    suspend fun setMustChangePassword(mustChange: Boolean) = Unit
    suspend fun clearAuthMetadata() {
        setTokenScopes(emptySet())
        setMustChangePassword(false)
        setPendingOAuthFlow(null)
    }

    suspend fun getPendingOAuthFlow(): PendingOAuthFlowRecord? = null
    suspend fun setPendingOAuthFlow(record: PendingOAuthFlowRecord?) = Unit
}

private val Context.dropitSettingsDataStore: DataStore<Preferences> by preferencesDataStore(name = "dropit_settings")

class DataStoreSettingsStore(
    private val dataStore: DataStore<Preferences>,
    private val deviceIdGenerator: () -> String = { ServerUrl.newDeviceId() },
) : SettingsStore {

    constructor(context: Context) : this(context.applicationContext.dropitSettingsDataStore)

    private val deviceIdMutex = Mutex()

    override val settings: Flow<AppSettings> = dataStore.data.map { prefs ->
        AppSettings(
            serverOrigin = prefs[KEY_SERVER_ORIGIN]?.takeIf { it.isNotBlank() },
            deviceId = prefs[KEY_DEVICE_ID].orEmpty(),
            themeMode = ThemeMode.fromStorage(prefs[KEY_THEME_MODE]),
            skipUpdateVersionCode = prefs[KEY_SKIP_UPDATE_VERSION_CODE]?.takeIf { it > 0 },
            legacyMigrated = prefs[KEY_LEGACY_MIGRATED] ?: false,
            tokenScopes = parseScopeString(prefs[KEY_TOKEN_SCOPES]),
            mustChangePassword = prefs[KEY_MUST_CHANGE_PASSWORD] ?: false,
        )
    }

    override suspend fun current(): AppSettings = settings.first()

    override suspend fun getServerOrigin(): String? = current().serverOrigin

    override suspend fun setServerOrigin(origin: String?) {
        dataStore.edit { prefs ->
            val cleaned = origin?.trim().orEmpty()
            if (cleaned.isEmpty()) {
                prefs.remove(KEY_SERVER_ORIGIN)
            } else {
                prefs[KEY_SERVER_ORIGIN] = cleaned
            }
        }
    }

    override suspend fun getOrCreateDeviceId(): String = deviceIdMutex.withLock {
        val existing = current().deviceId
        if (ServerUrl.isValidDeviceId(existing)) return existing
        val generated = deviceIdGenerator()
        dataStore.edit { prefs ->
            prefs[KEY_DEVICE_ID] = generated
        }
        generated
    }

    override suspend fun setDeviceId(deviceId: String) {
        if (!ServerUrl.isValidDeviceId(deviceId)) return
        dataStore.edit { prefs ->
            prefs[KEY_DEVICE_ID] = deviceId
        }
    }

    override suspend fun setThemeMode(mode: ThemeMode) {
        dataStore.edit { prefs ->
            prefs[KEY_THEME_MODE] = mode.storageValue
        }
    }

    override suspend fun setSkipUpdateVersionCode(versionCode: Int?) {
        dataStore.edit { prefs ->
            if (versionCode == null || versionCode <= 0) {
                prefs.remove(KEY_SKIP_UPDATE_VERSION_CODE)
            } else {
                prefs[KEY_SKIP_UPDATE_VERSION_CODE] = versionCode
            }
        }
    }

    override suspend fun isLegacyMigrated(): Boolean = current().legacyMigrated

    override suspend fun markLegacyMigrated() {
        dataStore.edit { prefs ->
            prefs[KEY_LEGACY_MIGRATED] = true
        }
    }

    override suspend fun clearServerConfig() {
        dataStore.edit { prefs ->
            prefs.remove(KEY_SERVER_ORIGIN)
            prefs.remove(KEY_SKIP_UPDATE_VERSION_CODE)
            prefs.remove(KEY_TOKEN_SCOPES)
            prefs.remove(KEY_MUST_CHANGE_PASSWORD)
            prefs.remove(KEY_PENDING_OAUTH_FLOW)
        }
    }

    override suspend fun getTokenScopes(): Set<String> = current().tokenScopes

    override suspend fun setTokenScopes(scopes: Set<String>) {
        val serialized = scopes.map { it.trim() }.filter { it.isNotEmpty() }.sorted().joinToString(" ")
        dataStore.edit { prefs ->
            if (serialized.isEmpty()) {
                prefs.remove(KEY_TOKEN_SCOPES)
            } else {
                prefs[KEY_TOKEN_SCOPES] = serialized
            }
        }
    }

    override suspend fun isMustChangePassword(): Boolean = current().mustChangePassword

    override suspend fun setMustChangePassword(mustChange: Boolean) {
        dataStore.edit { prefs ->
            if (!mustChange) {
                prefs.remove(KEY_MUST_CHANGE_PASSWORD)
            } else {
                prefs[KEY_MUST_CHANGE_PASSWORD] = true
            }
        }
    }

    override suspend fun clearAuthMetadata() {
        dataStore.edit { prefs ->
            prefs.remove(KEY_TOKEN_SCOPES)
            prefs.remove(KEY_MUST_CHANGE_PASSWORD)
            prefs.remove(KEY_PENDING_OAUTH_FLOW)
        }
    }

    override suspend fun getPendingOAuthFlow(): PendingOAuthFlowRecord? {
        val raw = dataStore.data.first()[KEY_PENDING_OAUTH_FLOW] ?: return null
        return decodePendingFlow(raw)
    }

    override suspend fun setPendingOAuthFlow(record: PendingOAuthFlowRecord?) {
        dataStore.edit { prefs ->
            if (record == null) {
                prefs.remove(KEY_PENDING_OAUTH_FLOW)
            } else {
                prefs[KEY_PENDING_OAUTH_FLOW] = encodePendingFlow(record)
            }
        }
    }

    companion object {
        private val KEY_SERVER_ORIGIN = stringPreferencesKey("server_origin")
        private val KEY_DEVICE_ID = stringPreferencesKey("device_id")
        private val KEY_THEME_MODE = stringPreferencesKey("theme_mode")
        private val KEY_SKIP_UPDATE_VERSION_CODE = intPreferencesKey("skip_update_version_code")
        private val KEY_LEGACY_MIGRATED = booleanPreferencesKey("legacy_migrated")
        private val KEY_TOKEN_SCOPES = stringPreferencesKey("token_scopes")
        private val KEY_MUST_CHANGE_PASSWORD = booleanPreferencesKey("must_change_password")
        private val KEY_PENDING_OAUTH_FLOW = stringPreferencesKey("pending_oauth_flow")

        internal fun encodePendingFlow(record: PendingOAuthFlowRecord): String =
            listOf(record.mode.name, record.provider, record.serverOrigin, record.state).joinToString("\n")

        internal fun decodePendingFlow(raw: String): PendingOAuthFlowRecord? {
            val parts = raw.split('\n')
            if (parts.size != 4) return null
            val mode = runCatching { PendingOAuthFlowMode.valueOf(parts[0]) }.getOrNull() ?: return null
            val provider = parts[1].trim()
            val serverOrigin = parts[2].trim()
            val state = parts[3].trim()
            if (provider.isEmpty() || serverOrigin.isEmpty() || state.isEmpty()) return null
            return PendingOAuthFlowRecord(
                mode = mode,
                provider = provider,
                serverOrigin = serverOrigin,
                state = state,
            )
        }
    }
}

class InMemorySettingsStore(
    initial: AppSettings = AppSettings(),
    private val deviceIdGenerator: () -> String = { ServerUrl.newDeviceId() },
) : SettingsStore {
    private val state = MutableStateFlow(initial)
    private val mutex = Mutex()
    private var pendingOAuthFlow: PendingOAuthFlowRecord? = null

    override val settings: Flow<AppSettings> = state.asStateFlow()

    override suspend fun current(): AppSettings = state.value

    override suspend fun getServerOrigin(): String? = state.value.serverOrigin

    override suspend fun setServerOrigin(origin: String?) = mutex.withLock {
        val cleaned = origin?.trim()?.takeIf { it.isNotEmpty() }
        state.value = state.value.copy(serverOrigin = cleaned)
    }

    override suspend fun getOrCreateDeviceId(): String = mutex.withLock {
        val existing = state.value.deviceId
        if (ServerUrl.isValidDeviceId(existing)) return@withLock existing
        val generated = deviceIdGenerator()
        state.value = state.value.copy(deviceId = generated)
        generated
    }

    override suspend fun setDeviceId(deviceId: String) = mutex.withLock {
        if (ServerUrl.isValidDeviceId(deviceId)) {
            state.value = state.value.copy(deviceId = deviceId)
        }
    }

    override suspend fun setThemeMode(mode: ThemeMode) = mutex.withLock {
        state.value = state.value.copy(themeMode = mode)
    }

    override suspend fun setSkipUpdateVersionCode(versionCode: Int?) = mutex.withLock {
        state.value = state.value.copy(skipUpdateVersionCode = versionCode?.takeIf { it > 0 })
    }

    override suspend fun isLegacyMigrated(): Boolean = state.value.legacyMigrated

    override suspend fun markLegacyMigrated() = mutex.withLock {
        state.value = state.value.copy(legacyMigrated = true)
    }

    override suspend fun clearServerConfig() = mutex.withLock {
        pendingOAuthFlow = null
        state.value = state.value.copy(
            serverOrigin = null,
            skipUpdateVersionCode = null,
            tokenScopes = emptySet(),
            mustChangePassword = false,
        )
    }

    override suspend fun getTokenScopes(): Set<String> = state.value.tokenScopes

    override suspend fun setTokenScopes(scopes: Set<String>) = mutex.withLock {
        val normalized = scopes.map { it.trim() }.filter { it.isNotEmpty() }.toSet()
        state.value = state.value.copy(tokenScopes = normalized)
    }

    override suspend fun isMustChangePassword(): Boolean = state.value.mustChangePassword

    override suspend fun setMustChangePassword(mustChange: Boolean) = mutex.withLock {
        state.value = state.value.copy(mustChangePassword = mustChange)
    }

    override suspend fun clearAuthMetadata() = mutex.withLock {
        pendingOAuthFlow = null
        state.value = state.value.copy(
            tokenScopes = emptySet(),
            mustChangePassword = false,
        )
    }

    override suspend fun getPendingOAuthFlow(): PendingOAuthFlowRecord? = mutex.withLock { pendingOAuthFlow }

    override suspend fun setPendingOAuthFlow(record: PendingOAuthFlowRecord?) = mutex.withLock {
        pendingOAuthFlow = record
    }
}
