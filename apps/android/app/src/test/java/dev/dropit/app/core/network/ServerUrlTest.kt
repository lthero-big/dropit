package dev.dropit.app.core.network

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.util.Random

class ServerUrlTest {

    @Test
    fun normalizeServerUrl_acceptsBareHostAndHttps() {
        assertEquals("https://dropit.lthero.com", ServerUrl.normalizeServerUrl("dropit.lthero.com"))
        assertEquals("https://dropit.lthero.com:8443", ServerUrl.normalizeServerUrl("dropit.lthero.com:8443"))
        assertEquals("https://dropit.lthero.com:8443/sub", ServerUrl.normalizeServerUrl("dropit.lthero.com:8443/sub/"))
        assertEquals("https://dropit.lthero.com", ServerUrl.normalizeServerUrl("dropit.lthero.com:443/"))
        assertEquals("https://dropit.lthero.com", ServerUrl.normalizeServerUrl("  https://dropit.lthero.com/  "))
        assertEquals("https://dropit.lthero.com", ServerUrl.normalizeServerUrl("https://DROPIT.LTHERO.COM:443///"))
        assertEquals("https://dropit.lthero.com:8443/sub", ServerUrl.normalizeServerUrl("https://dropit.lthero.com:8443/sub/"))
        assertEquals("https://dropit.lthero.com/app", ServerUrl.normalizeServerUrl("dropit.lthero.com/app///"))
    }

    @Test
    fun normalizeServerUrl_rejectsBlankNonHttpsCredentialsAndMalformed() {
        assertThrowsUrlError("", "请输入服务器地址")
        assertThrowsUrlError("   ", "请输入服务器地址")
        assertThrowsUrlError("http://dropit.lthero.com", "只支持 https:// 地址")
        assertThrowsUrlError("HTTP://dropit.lthero.com", "只支持 https:// 地址")
        assertThrowsUrlError("ftp://dropit.lthero.com", "只支持 https:// 地址")
        assertThrowsUrlError("javascript:alert(1)", "只支持 https:// 地址")
        assertThrowsUrlError("https:foo", "地址格式不正确")
        assertThrowsUrlError("https://user:pass@dropit.lthero.com", "地址里不能带用户名或密码")
        assertThrowsUrlError("https://user@dropit.lthero.com", "地址里不能带用户名或密码")
        assertThrowsUrlError("https://:@dropit.lthero.com", "地址里不能带用户名或密码")
        assertThrowsUrlError("https://", "地址格式不正确")
        assertThrowsUrlError("https://bad host/path", "地址格式不正确")
    }

    @Test
    fun isDropitVersion_validatesSemverInstallAndCommit() {
        val json = Json { ignoreUnknownKeys = true }

        val validDocker = VersionInfo(version = "0.4.0", commit = "a1b2c3d", buildDate = "2026-11-25T00:00:00Z", install = "docker")
        val validPre = VersionInfo(version = "v1.2.3-rc.1", commit = null, buildDate = null, install = "docker-build")
        val validSource = VersionInfo(version = "0.0.0", commit = "1234567", buildDate = null, install = "source")

        assertTrue(ServerUrl.isDropitVersion(validDocker))
        assertTrue(ServerUrl.isDropitVersion(validPre))
        assertTrue(ServerUrl.isDropitVersion(validSource))

        assertFalse(ServerUrl.isDropitVersion(null))
        assertFalse(ServerUrl.isDropitVersion(validDocker.copy(version = "not-semver")))
        assertFalse(ServerUrl.isDropitVersion(validDocker.copy(version = "1.2")))
        assertFalse(ServerUrl.isDropitVersion(validDocker.copy(install = "kubernetes")))

        assertTrue(ServerUrl.isDropitVersionJson(json.parseToJsonElement("""{"version":"0.4.0","commit":null,"install":"docker"}""")))
        assertFalse(ServerUrl.isDropitVersionJson(json.parseToJsonElement("""{"version":"0.4.0","commit":12345,"install":"docker"}""")))
        assertFalse(ServerUrl.isDropitVersionJson(json.parseToJsonElement("""["not","an","object"]""")))
        assertFalse(ServerUrl.isDropitVersionJson(json.parseToJsonElement("""{"version":123,"install":"docker"}""")))
    }

    @Test
    fun deviceHeadersAndEncoding_matchServerExpectations() {
        val id = ServerUrl.newDeviceId(Random(42L))
        assertTrue(id.startsWith("and-"))
        assertEquals(24, id.length)
        assertTrue(ServerUrl.isValidDeviceId(id))

        val longModel = "Pixel 9 Pro Ultra Max 超级长设备型号名称测试超过四十个字符边界值"
        val formattedName = ServerUrl.deviceName(longModel)
        assertEquals(40, formattedName.codePointCount(0, formattedName.length))
        assertTrue(formattedName.startsWith("dropit Android · "))

        assertEquals("dropit Android · Android", ServerUrl.deviceName("   "))

        val headers = ServerUrl.deviceHeaders(id, "dropit Android · Pixel 9")
        assertEquals("phone", headers["X-Dropit-Device-Kind"])
        assertEquals(id, headers["X-Dropit-Device"])
        // Space must be %20 (JS encodeURIComponent), never '+'
        val encodedName = headers["X-Dropit-Device-Name"]!!
        assertFalse(encodedName.contains('+'))
        assertTrue(encodedName.contains("%20"))

        val invalidIdHeaders = ServerUrl.deviceHeaders("bad id!", "Pixel")
        assertNull(invalidIdHeaders["X-Dropit-Device"])
        assertEquals("phone", invalidIdHeaders["X-Dropit-Device-Kind"])
    }

    @Test
    fun helpers_versionLabelSharedTextAndFormatSize() {
        assertEquals(
            "版本 0.4.0-native · a1b2c3d · 2026-11-25",
            ServerUrl.versionLabel("0.4.0-native", "a1b2c3d4e5f67890", "2026-11-25T03:45:00Z"),
        )
        assertEquals("版本 0.4.0-native", ServerUrl.versionLabel("0.4.0-native", null, null))

        assertEquals("标题\nhttps://example.com", ServerUrl.sharedText("https://example.com", "标题"))
        assertEquals("标题 https://example.com", ServerUrl.sharedText("标题 https://example.com", "标题"))
        assertNull(ServerUrl.sharedText("   ", "标题"))

        assertEquals("1 KB", ServerUrl.formatSize(100))
        assertEquals("1.5 MB", ServerUrl.formatSize((1.5 * 1024 * 1024).toLong()))
    }

    private fun assertThrowsUrlError(input: String, expectedMessage: String) {
        try {
            ServerUrl.normalizeServerUrl(input)
            fail("Expected ServerUrlException for input='$input'")
        } catch (e: ServerUrlException) {
            assertEquals(expectedMessage, e.message)
        }
    }
}
