package dev.dropit.app.data.update

import dev.dropit.app.core.network.AppUpdateManifest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.charset.StandardCharsets
import java.security.MessageDigest

/**
 * Full migration of mobile/android/app/src/test/java/dev/dropit/app/UpdateFilesTest.java
 * plus manifest and custom-port boundary checks.
 */
class UpdateFilesTest {
    private val server = "https://dropit.lthero.com"

    @Test
    fun onlyTheServersOwnDownloadPath() {
        assertTrue(UpdateFiles.isUpdateUrl(server, "https://dropit.lthero.com/api/app/android/download/dropit-android-0.3.2.apk"))
        assertTrue(UpdateFiles.isUpdateUrl(server, "https://DROPIT.lthero.com:443/api/app/android/download/a.apk"))
        assertTrue(
            UpdateFiles.isUpdateUrl(
                "https://dropit.lthero.com:8443",
                "https://dropit.lthero.com:8443/api/app/android/download/a.apk",
            ),
        )
        assertFalse(UpdateFiles.isUpdateUrl(server, "http://dropit.lthero.com/api/app/android/download/a.apk"))
        assertFalse(UpdateFiles.isUpdateUrl(server, "https://evil.example/api/app/android/download/a.apk"))
        assertFalse(UpdateFiles.isUpdateUrl(server, "https://dropit.lthero.com:8443/api/app/android/download/a.apk"))
        assertFalse(UpdateFiles.isUpdateUrl(server, "https://u@dropit.lthero.com/api/app/android/download/a.apk"))
        assertFalse(UpdateFiles.isUpdateUrl(server, "https://dropit.lthero.com/api/app/android/download/../x.apk"))
        assertFalse(UpdateFiles.isUpdateUrl(server, "https://dropit.lthero.com/api/app/android/download/a.apk?x=1"))
        assertFalse(UpdateFiles.isUpdateUrl(server, "https://dropit.lthero.com/api/items/a.apk"))
        assertFalse(UpdateFiles.isUpdateUrl(null, "https://dropit.lthero.com/api/app/android/download/a.apk"))
    }

    @Test
    fun sha256Hex() {
        val digest = MessageDigest.getInstance("SHA-256").digest("abc".toByteArray(StandardCharsets.UTF_8))
        assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", UpdateFiles.hex(digest))
        assertTrue(UpdateFiles.isSha256(UpdateFiles.hex(digest)))
        assertFalse(UpdateFiles.isSha256("BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD"))
        assertFalse(UpdateFiles.isSha256("abc"))
    }

    @Test
    fun validatesManifestSizeCapAndDownloadPath() {
        val validSha = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        val valid = AppUpdateManifest(
            versionCode = 7,
            versionName = "0.4.1",
            notes = "bugfix",
            size = UpdateFiles.MAX_BYTES,
            sha256 = validSha,
            url = "/api/app/android/download/dropit-0.4.1.apk",
        )
        assertTrue(UpdateFiles.isValidManifest(valid))
        assertFalse(UpdateFiles.isValidManifest(valid.copy(size = UpdateFiles.MAX_BYTES + 1)))
        assertFalse(UpdateFiles.isValidManifest(valid.copy(size = 0L)))
        assertFalse(UpdateFiles.isValidManifest(valid.copy(url = "/api/app/android/download/../evil.apk")))
        assertFalse(UpdateFiles.isValidManifest(valid.copy(sha256 = "not-a-sha256")))
    }
}
