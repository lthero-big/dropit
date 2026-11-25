package dev.dropit.app.protocol

import dev.dropit.app.BuildConfig
import dev.dropit.app.core.network.AppUpdateManifest
import dev.dropit.app.core.network.ServerUrl
import dev.dropit.app.core.network.ServerUrlException
import dev.dropit.app.data.transfer.DownloadName
import dev.dropit.app.data.update.UpdateFiles
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * Always-on release and protocol contract invariants verified on every unit test run
 * (with or without a live dropit server).
 */
class ProtocolContractRegressionTest {

    @Test
    fun releaseMetadataMatchesOverwriteUpgradeContract() {
        assertEquals("dev.dropit.app", BuildConfig.APPLICATION_ID)
        assertTrue(
            "Native versionCode must strictly exceed legacy Capacitor 0.3.2 (code 5)",
            BuildConfig.VERSION_CODE > 5,
        )
        assertEquals(6, BuildConfig.VERSION_CODE)
        assertEquals("0.4.0", BuildConfig.VERSION_NAME)
        assertTrue(
            "versionName must match scripts/publish-android-apk.mjs validation regex",
            Regex("^[0-9A-Za-z][0-9A-Za-z._+-]{0,39}$").matches(BuildConfig.VERSION_NAME),
        )
        assertTrue(
            "Published APK path must satisfy UpdateFiles & server app-release.ts contract",
            UpdateFiles.isDownloadPath("/api/app/android/download/dropit-android-${BuildConfig.VERSION_NAME}.apk"),
        )
        val label = ServerUrl.versionLabel(BuildConfig.VERSION_NAME, "a1b2c3d4e5f6", "2026-11-25T06:00:00Z")
        assertEquals("版本 0.4.0 · a1b2c3d · 2026-11-25", label)
    }

    @Test
    fun updateManifestContractMatchesPublishAndroidApkScript() {
        val validSha = "a".repeat(64)
        val manifest = AppUpdateManifest(
            versionCode = 6,
            versionName = "0.4.0",
            notes = "Kotlin + Jetpack Compose 原生客户端",
            size = 12_345_678L,
            sha256 = validSha,
            publishedAt = "2026-11-25T06:00:00.000Z",
            url = "/api/app/android/download/dropit-android-0.4.0.apk",
        )
        assertTrue(UpdateFiles.isValidManifest(manifest))
        assertTrue(
            UpdateFiles.isUpdateUrl(
                "https://dropit.lthero.com",
                "https://dropit.lthero.com${manifest.url}",
            ),
        )
        // Must reject cross-origin, plain http, traversal, query params, and uppercase SHA
        assertFalse(
            UpdateFiles.isUpdateUrl(
                "https://dropit.lthero.com",
                "https://evil.example.com${manifest.url}",
            ),
        )
        assertFalse(
            UpdateFiles.isUpdateUrl(
                "https://dropit.lthero.com",
                "http://dropit.lthero.com${manifest.url}",
            ),
        )
        assertFalse(UpdateFiles.isDownloadPath("/api/app/android/download/../latest.json"))
        assertFalse(UpdateFiles.isValidManifest(manifest.copy(sha256 = "A".repeat(64))))
    }

    @Test
    fun serverUrlAndRfc5987DownloadNameSecurityContractsHold() {
        assertEquals("https://dropit.lthero.com", ServerUrl.normalizeServerUrl("dropit.lthero.com/"))
        assertEquals("https://dropit.lthero.com:8443", ServerUrl.normalizeServerUrl("dropit.lthero.com:8443/"))
        for (bad in listOf("http://dropit.lthero.com", "https://user:pass@dropit.lthero.com", "javascript:alert(1)")) {
            try {
                ServerUrl.normalizeServerUrl(bad)
                fail("Expected ServerUrlException for $bad")
            } catch (_: ServerUrlException) {
                // expected
            }
        }

        val header = """attachment; filename="download.pdf"; filename*=UTF-8''%E9%A1%B9%E7%9B%AE%2B%E6%8A%A5%E5%91%8A%20%282026%29.pdf"""
        assertEquals("项目+报告 (2026).pdf", DownloadName.fromContentDisposition(header))
        assertEquals("passwd.txt", DownloadName.sanitize("../../etc/passwd.txt"))
    }
}
