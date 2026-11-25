package dev.dropit.app.core.auth

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LegacyCapacitorMigratorTest {

    private class FakeLegacyPrefs(
        private val data: MutableMap<Pair<String, String>, String?> = mutableMapOf(),
        private val throwingKeys: Set<Pair<String, String>> = emptySet(),
    ) : LegacyPrefsReader {
        override fun getString(prefsName: String, key: String): String? {
            if ((prefsName to key) in throwingKeys) {
                throw ClassCastException("Corrupted preference type for $prefsName/$key")
            }
            return data[prefsName to key]
        }
    }

    @Test
    fun firstLaunch_migratesCapacitorStorageIntoNewStores() = runTest {
        val legacy = FakeLegacyPrefs(
            mutableMapOf(
                (LegacyCapacitorMigrator.CAPACITOR_PREFS to LegacyCapacitorMigrator.KEY_SERVER) to "https://dropit.lthero.com/",
                (LegacyCapacitorMigrator.CAPACITOR_PREFS to LegacyCapacitorMigrator.KEY_TOKEN) to "legacy_rw_web_token_abc1234567890",
                (LegacyCapacitorMigrator.CAPACITOR_PREFS to LegacyCapacitorMigrator.KEY_DEVICE_ID) to "and-LegacyDeviceId123456",
                (LegacyCapacitorMigrator.CAPACITOR_PREFS to LegacyCapacitorMigrator.KEY_SKIP_UPDATE) to "5",
            ),
        )
        val settings = InMemorySettingsStore()
        val vault = InMemoryTokenVault()
        val migrator = LegacyCapacitorMigrator(legacy, settings, vault)

        val result = migrator.migrateIfNeeded()
        assertTrue(result is MigrationResult.Migrated)
        val migrated = result as MigrationResult.Migrated
        assertEquals("https://dropit.lthero.com", migrated.serverOrigin)
        assertTrue(migrated.tokenMigrated)
        assertTrue(migrated.deviceIdMigrated)
        assertEquals(5, migrated.skipUpdateVersionCode)

        val saved = settings.current()
        assertEquals("https://dropit.lthero.com", saved.serverOrigin)
        assertEquals("and-LegacyDeviceId123456", saved.deviceId)
        assertEquals(5, saved.skipUpdateVersionCode)
        assertTrue(saved.legacyMigrated)
        assertEquals("legacy_rw_web_token_abc1234567890", vault.getToken())
    }

    @Test
    fun fallsBackToDropitAppOriginWhenCapacitorServerMissingOrInvalid() = runTest {
        val legacy = FakeLegacyPrefs(
            mutableMapOf(
                (LegacyCapacitorMigrator.CAPACITOR_PREFS to LegacyCapacitorMigrator.KEY_SERVER) to "http://insecure.example.com",
                (LegacyCapacitorMigrator.DROPIT_APP_PREFS to LegacyCapacitorMigrator.KEY_ORIGIN) to "https://fallback.dropit.dev/",
                (LegacyCapacitorMigrator.CAPACITOR_PREFS to LegacyCapacitorMigrator.KEY_TOKEN) to "valid_token_xyz",
            ),
        )
        val settings = InMemorySettingsStore()
        val vault = InMemoryTokenVault()
        val migrator = LegacyCapacitorMigrator(legacy, settings, vault)

        val result = migrator.migrateIfNeeded() as MigrationResult.Migrated
        assertEquals("https://fallback.dropit.dev", result.serverOrigin)
        assertEquals("https://fallback.dropit.dev", settings.getServerOrigin())
        assertEquals("valid_token_xyz", vault.getToken())
    }

    @Test
    fun repeatedLaunches_areIdempotentAndNeverClearMigratedLoginState() = runTest {
        val map = mutableMapOf<Pair<String, String>, String?>(
            (LegacyCapacitorMigrator.CAPACITOR_PREFS to LegacyCapacitorMigrator.KEY_SERVER) to "https://dropit.lthero.com",
            (LegacyCapacitorMigrator.CAPACITOR_PREFS to LegacyCapacitorMigrator.KEY_TOKEN) to "migrated_token_001",
            (LegacyCapacitorMigrator.CAPACITOR_PREFS to LegacyCapacitorMigrator.KEY_DEVICE_ID) to "and-Device123456789012",
        )
        val legacy = FakeLegacyPrefs(map)
        val settings = InMemorySettingsStore()
        val vault = InMemoryTokenVault()
        val migrator = LegacyCapacitorMigrator(legacy, settings, vault)

        assertTrue(migrator.migrateIfNeeded() is MigrationResult.Migrated)

        // Even if legacy prefs disappear or change later, repeated launches must NOT clear or overwrite state
        map.clear()
        assertEquals(MigrationResult.AlreadyMigrated, migrator.migrateIfNeeded())
        assertEquals(MigrationResult.AlreadyMigrated, migrator.migrateIfNeeded())

        assertEquals("https://dropit.lthero.com", settings.getServerOrigin())
        assertEquals("migrated_token_001", vault.getToken())
        assertEquals("and-Device123456789012", settings.current().deviceId)
    }

    @Test
    fun existingNewStoreValues_areNeverOverwrittenByLegacyValues() = runTest {
        val legacy = FakeLegacyPrefs(
            mutableMapOf(
                (LegacyCapacitorMigrator.CAPACITOR_PREFS to LegacyCapacitorMigrator.KEY_SERVER) to "https://old.example.com",
                (LegacyCapacitorMigrator.CAPACITOR_PREFS to LegacyCapacitorMigrator.KEY_TOKEN) to "old_token",
                (LegacyCapacitorMigrator.CAPACITOR_PREFS to LegacyCapacitorMigrator.KEY_DEVICE_ID) to "and-OldDevice1234567890",
                (LegacyCapacitorMigrator.CAPACITOR_PREFS to LegacyCapacitorMigrator.KEY_SKIP_UPDATE) to "4",
            ),
        )
        val settings = InMemorySettingsStore(
            AppSettings(
                serverOrigin = "https://new.example.com",
                deviceId = "and-NewDevice1234567890",
                skipUpdateVersionCode = 7,
                legacyMigrated = false,
            ),
        )
        val vault = InMemoryTokenVault(initialToken = "new_token")
        val migrator = LegacyCapacitorMigrator(legacy, settings, vault)

        val result = migrator.migrateIfNeeded()
        assertEquals(MigrationResult.NothingToMigrate, result)
        assertEquals("https://new.example.com", settings.getServerOrigin())
        assertEquals("new_token", vault.getToken())
        assertEquals("and-NewDevice1234567890", settings.current().deviceId)
        assertEquals(7, settings.current().skipUpdateVersionCode)
        assertTrue(settings.isLegacyMigrated())
    }

    @Test
    fun corruptedLegacyValues_areIgnoredGracefullyWithoutFailingStartup() = runTest {
        val legacy = FakeLegacyPrefs(
            data = mutableMapOf(
                (LegacyCapacitorMigrator.CAPACITOR_PREFS to LegacyCapacitorMigrator.KEY_SERVER) to "https://user:pass@evil.example.com",
                (LegacyCapacitorMigrator.DROPIT_APP_PREFS to LegacyCapacitorMigrator.KEY_ORIGIN) to "not-a-url ://??",
                (LegacyCapacitorMigrator.CAPACITOR_PREFS to LegacyCapacitorMigrator.KEY_TOKEN) to "token with\nnewline",
                (LegacyCapacitorMigrator.CAPACITOR_PREFS to LegacyCapacitorMigrator.KEY_DEVICE_ID) to "x",
            ),
            throwingKeys = setOf(
                LegacyCapacitorMigrator.CAPACITOR_PREFS to LegacyCapacitorMigrator.KEY_SKIP_UPDATE,
            ),
        )
        val settings = InMemorySettingsStore()
        val vault = InMemoryTokenVault()
        val migrator = LegacyCapacitorMigrator(legacy, settings, vault)

        val result = migrator.migrateIfNeeded()
        assertEquals(MigrationResult.NothingToMigrate, result)
        assertNull(settings.getServerOrigin())
        assertNull(vault.getToken())
        assertEquals("", settings.current().deviceId)
        assertNull(settings.current().skipUpdateVersionCode)
        assertTrue(settings.isLegacyMigrated())
    }
}
