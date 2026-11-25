package dev.dropit.app.data.update

import dev.dropit.app.core.network.AppUpdateManifest
import dev.dropit.app.core.network.UpdateSource
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.charset.StandardCharsets
import java.security.MessageDigest

/**
 * Full migration of mobile/android/app/src/test/java/dev/dropit/app/UpdateFilesTest.java
 * plus GitHub Releases semver, versionCode, .apk.sha256, and redirect host allowlist tests.
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
            versionCode = 8,
            versionName = "0.4.2",
            notes = "bugfix",
            size = UpdateFiles.MAX_BYTES,
            sha256 = validSha,
            url = "/api/app/android/download/dropit-0.4.2.apk",
        )
        assertTrue(UpdateFiles.isValidManifest(valid))
        assertFalse(UpdateFiles.isValidManifest(valid.copy(size = UpdateFiles.MAX_BYTES + 1)))
        assertFalse(UpdateFiles.isValidManifest(valid.copy(size = 0L)))
        assertFalse(UpdateFiles.isValidManifest(valid.copy(url = "/api/app/android/download/../evil.apk")))
        assertFalse(UpdateFiles.isValidManifest(valid.copy(sha256 = "not-a-sha256")))

        // GitHub manifest allows versionCode == 0 when versionName + GitHub HTTPS URL + sha256 are valid
        val validGh = AppUpdateManifest(
            versionCode = 0,
            versionName = "0.4.2",
            size = 1024L,
            sha256 = validSha,
            url = "https://github.com/lthero-big/dropit/releases/download/android-v0.4.2/dropit-android-0.4.2-abc1234.apk",
            source = UpdateSource.GITHUB,
        )
        assertTrue(UpdateFiles.isValidManifest(validGh))
        assertFalse(UpdateFiles.isValidManifest(validGh.copy(url = "http://github.com/lthero-big/dropit/a.apk")))
        assertFalse(UpdateFiles.isValidManifest(validGh.copy(url = "https://evil.example/a.apk")))
    }

    @Test
    fun githubDownloadUrlAllowlistEnforcesHttpsAndStrictHostMatching() {
        assertTrue(UpdateFiles.isAllowedGitHubDownloadUrl("https://github.com/lthero-big/dropit/releases/download/android-v0.4.2/app.apk"))
        assertTrue(UpdateFiles.isAllowedGitHubDownloadUrl("https://objects.githubusercontent.com/github-production-release-asset/123?sig=abc"))
        assertTrue(UpdateFiles.isAllowedGitHubDownloadUrl("https://release-assets.githubusercontent.com/foo/bar.apk"))
        assertTrue(UpdateFiles.isAllowedGitHubDownloadUrl("https://GITHUB.COM/lthero-big/dropit/releases/download/android-v0.4.2/app.apk"))

        // Reject HTTP downgrade, unknown hosts, suffix tricks, userinfo
        assertFalse(UpdateFiles.isAllowedGitHubDownloadUrl("http://github.com/lthero-big/dropit/a.apk"))
        assertFalse(UpdateFiles.isAllowedGitHubDownloadUrl("http://objects.githubusercontent.com/a.apk"))
        assertFalse(UpdateFiles.isAllowedGitHubDownloadUrl("https://evil.example/a.apk"))
        assertFalse(UpdateFiles.isAllowedGitHubDownloadUrl("https://evilgithubusercontent.com/a.apk"))
        assertFalse(UpdateFiles.isAllowedGitHubDownloadUrl("https://github.com.evil.com/a.apk"))
        assertFalse(UpdateFiles.isAllowedGitHubDownloadUrl("https://githubusercontent.com/a.apk"))
        assertFalse(UpdateFiles.isAllowedGitHubDownloadUrl("https://user:pass@github.com/a.apk"))
        assertFalse(UpdateFiles.isAllowedGitHubDownloadUrl("javascript:alert(1)"))
    }

    @Test
    fun parsesGitHubReleaseTagVersionCodeAndSha256FileStrictly() {
        assertEquals("0.4.2", UpdateFiles.parseGitHubReleaseTag("android-v0.4.2"))
        assertEquals("1.10.3", UpdateFiles.parseGitHubReleaseTag("android-v1.10.3"))
        assertNull(UpdateFiles.parseGitHubReleaseTag("v0.4.2"))
        assertNull(UpdateFiles.parseGitHubReleaseTag("android-v"))
        assertNull(UpdateFiles.parseGitHubReleaseTag("android-vnot-semver"))

        val releaseBody = """
            ## dropit Android 原生客户端 v0.4.2 (code 8)
            | 项目 | 值 |
            | --- | --- |
            | 版本号 (`versionName`) | `0.4.2` |
            | 版本号 (`versionCode`) | `8` |
        """.trimIndent()
        assertEquals(8, UpdateFiles.extractVersionCodeFromReleaseBody(releaseBody))
        assertEquals(9, UpdateFiles.extractVersionCodeFromReleaseBody("versionCode: 9"))
        assertEquals(10, UpdateFiles.extractVersionCodeFromReleaseBody("Release notes", "dropit Android v0.5.0 (code 10)"))
        assertEquals(0, UpdateFiles.extractVersionCodeFromReleaseBody("No version code here"))

        val validSha = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        assertEquals(
            validSha,
            UpdateFiles.parseSha256File("$validSha  dropit-android-0.4.2-abc1234.apk\n", "dropit-android-0.4.2-abc1234.apk"),
        )
        assertEquals(
            validSha,
            UpdateFiles.parseSha256File("$validSha *dropit-android-0.4.2-abc1234.apk", "dropit-android-0.4.2-abc1234.apk"),
        )
        assertEquals(validSha, UpdateFiles.parseSha256File(validSha, "dropit-android-0.4.2-abc1234.apk"))
        // Reject uppercase, wrong filename, malformed content
        assertNull(UpdateFiles.parseSha256File(validSha.uppercase(), "dropit-android-0.4.2-abc1234.apk"))
        assertNull(UpdateFiles.parseSha256File("$validSha  other-file.apk", "dropit-android-0.4.2-abc1234.apk"))
        assertNull(UpdateFiles.parseSha256File("not-a-hash  dropit-android-0.4.2-abc1234.apk", "dropit-android-0.4.2-abc1234.apk"))
        assertNull(UpdateFiles.parseSha256File("   "))
    }

    @Test
    fun semVerAndVersionComparatorAvoidDowngradeAndFalsePositives() {
        assertTrue(UpdateVersionComparator.isNewer("0.4.2", 8, "0.4.1", 7))
        assertTrue(UpdateVersionComparator.isNewer("0.4.2", 0, "0.4.1", 7))
        assertTrue(UpdateVersionComparator.isNewer("0.10.0", 0, "0.4.2", 8))
        assertTrue(UpdateVersionComparator.isNewer("0.4.0", 7, "0.4.0-native", 6))
        assertFalse(UpdateVersionComparator.isNewer("0.4.0", 6, "0.4.0-native", 6))
        assertTrue(UpdateVersionComparator.isNewer("0.4.2", 9, "0.4.2", 8))

        // Same version or downgrade must NOT be treated as newer
        assertFalse(UpdateVersionComparator.isNewer("0.4.2", 8, "0.4.2", 8))
        assertFalse(UpdateVersionComparator.isNewer("0.4.2", 0, "0.4.2", 8))
        assertFalse(UpdateVersionComparator.isNewer("0.4.1", 7, "0.4.2", 8))
        assertFalse(UpdateVersionComparator.isNewer("0.4.1", 99, "0.4.2", 8))
        assertTrue(UpdateVersionComparator.isSameVersionName("0.4.2", "0.4.2"))
        assertFalse(UpdateVersionComparator.isSameVersionName("0.4.1", "0.4.2"))
    }
}
