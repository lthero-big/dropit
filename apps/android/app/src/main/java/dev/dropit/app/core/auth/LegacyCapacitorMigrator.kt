package dev.dropit.app.core.auth

import android.content.Context
import dev.dropit.app.core.network.ServerUrl
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

interface LegacyPrefsReader {
    fun getString(prefsName: String, key: String): String?
}

class AndroidLegacyPrefsReader(context: Context) : LegacyPrefsReader {
    private val appContext = context.applicationContext

    override fun getString(prefsName: String, key: String): String? = runCatching {
        appContext.getSharedPreferences(prefsName, Context.MODE_PRIVATE).getString(key, null)
    }.getOrNull()
}

sealed class MigrationResult {
    data object AlreadyMigrated : MigrationResult()
    data object NothingToMigrate : MigrationResult()
    data class Migrated(
        val serverOrigin: String?,
        val tokenMigrated: Boolean,
        val deviceIdMigrated: Boolean,
        val skipUpdateVersionCode: Int?,
    ) : MigrationResult()
}

/**
 * Idempotent one-time migrator from the legacy Capacitor shell (0.3.2 / code 5) into
 * [SettingsStore] + [TokenVault].
 *
 * Reads:
 * - `SharedPreferences("CapacitorStorage")`: `server`, `token`, `deviceId`, `skipUpdate`
 * - `SharedPreferences("dropit_app")`: `origin` (fallback if `CapacitorStorage["server"]` is absent/invalid)
 *
 * Guarantees:
 * - Only populates fields that are currently empty in the new stores.
 * - Never clears or overwrites already-migrated login state on repeated launches.
 * - Tolerates corrupted/invalid legacy entries without failing app startup.
 * - Preserves legacy `read/write` and `read/write/web` device tokens as-is.
 */
class LegacyCapacitorMigrator(
    private val legacyPrefs: LegacyPrefsReader,
    private val settingsStore: SettingsStore,
    private val tokenVault: TokenVault,
) {
    private val mutex = Mutex()

    suspend fun migrateIfNeeded(): MigrationResult = mutex.withLock {
        if (settingsStore.isLegacyMigrated()) {
            return@withLock MigrationResult.AlreadyMigrated
        }

        val currentSettings = settingsStore.current()
        var migratedServer: String? = null
        var tokenMigrated = false
        var deviceIdMigrated = false
        var migratedSkipUpdate: Int? = null

        // 1. Server origin: prefer CapacitorStorage["server"], fallback to dropit_app["origin"]
        if (currentSettings.serverOrigin.isNullOrBlank()) {
            val rawServer = safeRead(CAPACITOR_PREFS, KEY_SERVER)
            val rawOrigin = safeRead(DROPIT_APP_PREFS, KEY_ORIGIN)
            val validOrigin = normalizeOrNull(rawServer) ?: normalizeOrNull(rawOrigin)
            if (validOrigin != null) {
                settingsStore.setServerOrigin(validOrigin)
                migratedServer = validOrigin
            }
        }

        // 2. Device Bearer token -> encrypted TokenVault (never plain DataStore)
        if (!tokenVault.hasToken()) {
            val legacyToken = sanitizeToken(safeRead(CAPACITOR_PREFS, KEY_TOKEN))
            if (legacyToken != null) {
                runCatching {
                    tokenVault.saveToken(legacyToken)
                    tokenMigrated = true
                }
            }
        }

        // 3. Device ID
        if (currentSettings.deviceId.isBlank()) {
            val legacyDeviceId = safeRead(CAPACITOR_PREFS, KEY_DEVICE_ID)?.trim()
            if (ServerUrl.isValidDeviceId(legacyDeviceId)) {
                settingsStore.setDeviceId(legacyDeviceId!!)
                deviceIdMigrated = true
            }
        }

        // 4. Skipped update versionCode
        if (currentSettings.skipUpdateVersionCode == null) {
            val legacySkip = safeRead(CAPACITOR_PREFS, KEY_SKIP_UPDATE)?.trim()?.toIntOrNull()
            if (legacySkip != null && legacySkip > 0) {
                settingsStore.setSkipUpdateVersionCode(legacySkip)
                migratedSkipUpdate = legacySkip
            }
        }

        settingsStore.markLegacyMigrated()

        val anyMigrated = migratedServer != null || tokenMigrated || deviceIdMigrated || migratedSkipUpdate != null
        if (anyMigrated) {
            MigrationResult.Migrated(
                serverOrigin = migratedServer,
                tokenMigrated = tokenMigrated,
                deviceIdMigrated = deviceIdMigrated,
                skipUpdateVersionCode = migratedSkipUpdate,
            )
        } else {
            MigrationResult.NothingToMigrate
        }
    }

    private fun safeRead(prefsName: String, key: String): String? =
        runCatching { legacyPrefs.getString(prefsName, key) }.getOrNull()

    private fun normalizeOrNull(raw: String?): String? {
        if (raw.isNullOrBlank()) return null
        return runCatching { ServerUrl.normalizeServerUrl(raw) }.getOrNull()
    }

    private fun sanitizeToken(raw: String?): String? {
        val trimmed = raw?.trim().orEmpty()
        if (trimmed.isEmpty()) return null
        if (trimmed.any { it.isWhitespace() || it.code <= 0x1f || it.code == 0x7f }) return null
        return trimmed
    }

    companion object {
        const val CAPACITOR_PREFS = "CapacitorStorage"
        const val DROPIT_APP_PREFS = "dropit_app"
        const val KEY_SERVER = "server"
        const val KEY_TOKEN = "token"
        const val KEY_DEVICE_ID = "deviceId"
        const val KEY_SKIP_UPDATE = "skipUpdate"
        const val KEY_ORIGIN = "origin"
    }
}
