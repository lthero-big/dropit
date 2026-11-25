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

data class AppSettings(
    val serverOrigin: String? = null,
    val deviceId: String = "",
    val themeMode: ThemeMode = ThemeMode.SYSTEM,
    val skipUpdateVersionCode: Int? = null,
    val legacyMigrated: Boolean = false,
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
        }
    }

    companion object {
        private val KEY_SERVER_ORIGIN = stringPreferencesKey("server_origin")
        private val KEY_DEVICE_ID = stringPreferencesKey("device_id")
        private val KEY_THEME_MODE = stringPreferencesKey("theme_mode")
        private val KEY_SKIP_UPDATE_VERSION_CODE = intPreferencesKey("skip_update_version_code")
        private val KEY_LEGACY_MIGRATED = booleanPreferencesKey("legacy_migrated")
    }
}

class InMemorySettingsStore(
    initial: AppSettings = AppSettings(),
    private val deviceIdGenerator: () -> String = { ServerUrl.newDeviceId() },
) : SettingsStore {
    private val state = MutableStateFlow(initial)
    private val mutex = Mutex()

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
        state.value = state.value.copy(serverOrigin = null, skipUpdateVersionCode = null)
    }
}
