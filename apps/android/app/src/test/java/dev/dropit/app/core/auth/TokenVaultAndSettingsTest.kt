package dev.dropit.app.core.auth

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import javax.crypto.AEADBadTagException
import javax.crypto.KeyGenerator

class TokenVaultAndSettingsTest {

    @get:Rule
    val tempFolder = TemporaryFolder()

    @Test
    fun aesGcmCrypto_encryptsWithRandomIvAndDetectsTampering() {
        val keyGen = KeyGenerator.getInstance("AES").apply { init(256) }
        val secretKey = keyGen.generateKey()
        val token = "dropit_device_secret_token_9876543210abcdef"

        val blob1 = AesGcmCrypto.encrypt(token, secretKey)
        val blob2 = AesGcmCrypto.encrypt(token, secretKey)

        // Ciphertext must never contain plaintext and must use fresh random IVs
        assertFalse(blob1.contains(token))
        assertNotEquals(blob1, blob2)
        assertEquals(token, AesGcmCrypto.decrypt(blob1, secretKey))
        assertEquals(token, AesGcmCrypto.decrypt(blob2, secretKey))

        // Flip a byte in ciphertext -> AEADBadTagException
        val tampered = blob1.dropLast(1) + if (blob1.last() == 'a') 'b' else 'a'
        try {
            AesGcmCrypto.decrypt(tampered, secretKey)
            fail("Expected AEADBadTagException for tampered ciphertext")
        } catch (_: AEADBadTagException) {
            // expected
        }
    }

    @Test
    fun dataStoreSettingsStore_persistsAllFieldsWithoutToken() = runTest {
        val dataStore = PreferenceDataStoreFactory.create(
            scope = backgroundScope,
            produceFile = { tempFolder.newFile("dropit_settings.preferences_pb") },
        )
        val store = DataStoreSettingsStore(dataStore)

        assertNull(store.getServerOrigin())
        assertFalse(store.isLegacyMigrated())
        assertEquals(ThemeMode.SYSTEM, store.current().themeMode)

        store.setServerOrigin("https://dropit.lthero.com")
        val id1 = store.getOrCreateDeviceId()
        val id2 = store.getOrCreateDeviceId()
        assertEquals(id1, id2)
        assertTrue(id1.startsWith("and-"))

        store.setThemeMode(ThemeMode.DARK)
        store.setSkipUpdateVersionCode(8)
        store.markLegacyMigrated()

        val snap = store.current()
        assertEquals("https://dropit.lthero.com", snap.serverOrigin)
        assertEquals(ThemeMode.DARK, snap.themeMode)
        assertEquals(8, snap.skipUpdateVersionCode)
        assertTrue(snap.legacyMigrated)

        // clearServerConfig clears server + skipUpdate but retains deviceId, theme, legacyMigrated
        store.clearServerConfig()
        val afterClear = store.current()
        assertNull(afterClear.serverOrigin)
        assertNull(afterClear.skipUpdateVersionCode)
        assertEquals(id1, afterClear.deviceId)
        assertEquals(ThemeMode.DARK, afterClear.themeMode)
        assertTrue(afterClear.legacyMigrated)
    }
}
