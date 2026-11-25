package dev.dropit.app.core.network

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import java.security.SecureRandom
import java.util.Random
import kotlin.math.max
import kotlin.math.roundToLong

class ServerUrlException(message: String) : IllegalArgumentException(message)

object ServerUrl {
    val INSTALL_KINDS: Set<String> = setOf("docker", "docker-build", "source")
    private val SCHEME_REGEX = Regex("^([a-zA-Z][a-zA-Z0-9+.-]*):(.*)$")
    private val SEMVER_REGEX = Regex("^\\d+\\.\\d+\\.\\d+(?:[-+][0-9A-Za-z.-]{1,40})?$")
    private val DEVICE_ID_REGEX = Regex("^[A-Za-z0-9_-]{6,64}$")
    private val COMMIT_HEX_REGEX = Regex("^[0-9a-f]{7,40}$")
    private const val DEVICE_ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
    private val DEFAULT_RANDOM = SecureRandom()

    /**
     * Normalizes a user-entered dropit server address, matching mobile/www/core.js:
     * - Trims whitespace and rejects empty input.
     * - Prepends https:// when no scheme is present.
     * - Rejects any non-https scheme.
     * - Rejects URLs containing username or password credentials.
     * - Strips trailing slashes from the path and omits default :443 port.
     */
    fun normalizeServerUrl(input: String?): String {
        var text = input?.trim().orEmpty()
        if (text.isEmpty()) {
            throw ServerUrlException("请输入服务器地址")
        }
        val schemeMatch = SCHEME_REGEX.matchEntire(text)
        if (schemeMatch == null) {
            text = "https://$text"
        } else {
            val scheme = schemeMatch.groupValues[1].lowercase()
            if (scheme != "https") {
                throw ServerUrlException("只支持 https:// 地址")
            }
            if (!schemeMatch.groupValues[2].startsWith("//")) {
                throw ServerUrlException("地址格式不正确")
            }
        }

        // Check raw authority for embedded credentials (including empty user:pass@host)
        val afterScheme = text.substringAfter("://")
        val authorityEnd = afterScheme.indexOfAny(charArrayOf('/', '?', '#')).let { if (it < 0) afterScheme.length else it }
        val rawAuthority = afterScheme.substring(0, authorityEnd)
        if (rawAuthority.isEmpty()) {
            throw ServerUrlException("地址格式不正确")
        }
        if (rawAuthority.contains('@')) {
            throw ServerUrlException("地址里不能带用户名或密码")
        }
        if (text.any { it.isWhitespace() || it.code <= 0x1f || it.code == 0x7f }) {
            throw ServerUrlException("地址格式不正确")
        }

        val parsed = text.toHttpUrlOrNull() ?: throw ServerUrlException("地址格式不正确")
        if (parsed.scheme != "https") {
            throw ServerUrlException("只支持 https:// 地址")
        }
        if (parsed.username.isNotEmpty() || parsed.password.isNotEmpty()) {
            throw ServerUrlException("地址里不能带用户名或密码")
        }
        if (parsed.host.isBlank()) {
            throw ServerUrlException("地址格式不正确")
        }

        val hostPart = if (parsed.host.contains(':')) "[${parsed.host}]" else parsed.host
        val portPart = if (parsed.port != 443) ":${parsed.port}" else ""
        val pathPart = parsed.encodedPath.trimEnd('/')
        return "https://$hostPart$portPart$pathPart"
    }

    /**
     * Validates a parsed [VersionInfo] from GET /api/version.
     */
    fun isDropitVersion(info: VersionInfo?): Boolean {
        if (info == null) return false
        val cleanVersion = info.version.removePrefix("v")
        if (!SEMVER_REGEX.matches(cleanVersion)) return false
        if (info.install !in INSTALL_KINDS) return false
        return true
    }

    /**
     * Validates a raw JSON payload from GET /api/version before trusting the server.
     */
    fun isDropitVersionJson(element: JsonElement?): Boolean {
        val obj = element as? JsonObject ?: return false
        val versionPrimitive = obj["version"] as? JsonPrimitive ?: return false
        if (!versionPrimitive.isString) return false
        val version = versionPrimitive.content.removePrefix("v")
        if (!SEMVER_REGEX.matches(version)) return false

        val installPrimitive = obj["install"] as? JsonPrimitive ?: return false
        if (!installPrimitive.isString || installPrimitive.content !in INSTALL_KINDS) return false

        val commitElem = obj["commit"]
        if (commitElem != null && commitElem !is JsonNull) {
            val commitPrimitive = commitElem as? JsonPrimitive ?: return false
            if (!commitPrimitive.isString) return false
        }
        return true
    }

    /**
     * Formats the client device name and truncates safely by Unicode code points to 40 chars.
     */
    fun deviceName(model: String?): String {
        val cleaned = model?.trim().orEmpty().ifEmpty { "Android" }
        return truncateCodePoints("dropit Android · $cleaned", 40)
    }

    fun isValidDeviceId(deviceId: String?): Boolean =
        deviceId != null && DEVICE_ID_REGEX.matches(deviceId)

    /**
     * Generates a stable random device id (`and-<20 alphanumeric chars>`).
     */
    fun newDeviceId(random: Random = DEFAULT_RANDOM): String {
        val sb = StringBuilder(24)
        sb.append("and-")
        repeat(20) {
            sb.append(DEVICE_ID_ALPHABET[random.nextInt(DEVICE_ID_ALPHABET.length)])
        }
        return sb.toString()
    }

    /**
     * Builds dropit device identity HTTP headers matching mobile/www/core.js.
     */
    fun deviceHeaders(deviceId: String?, deviceName: String?): Map<String, String> {
        val headers = LinkedHashMap<String, String>(3)
        headers["X-Dropit-Device-Kind"] = "phone"
        if (isValidDeviceId(deviceId)) {
            headers["X-Dropit-Device"] = deviceId!!
        }
        if (!deviceName.isNullOrEmpty()) {
            headers["X-Dropit-Device-Name"] = encodeURIComponent(truncateCodePoints(deviceName, 40))
        }
        return headers
    }

    /**
     * Formats build metadata as `版本 <version> · <shortCommit> · <YYYY-MM-DD>`.
     */
    fun versionLabel(version: String?, commit: String?, date: String?): String {
        val parts = ArrayList<String>(3)
        parts.add("版本 ${version?.takeIf { it.isNotBlank() } ?: "?"}")
        val cleanCommit = commit?.trim().orEmpty()
        if (cleanCommit.isNotEmpty()) {
            val lower = cleanCommit.lowercase()
            parts.add(if (COMMIT_HEX_REGEX.matches(lower)) lower.take(7) else cleanCommit)
        }
        val cleanDate = date?.trim().orEmpty()
        if (cleanDate.length >= 10) {
            parts.add(cleanDate.take(10))
        } else if (cleanDate.isNotEmpty()) {
            parts.add(cleanDate)
        }
        return parts.joinToString(" · ")
    }

    /**
     * Merges Android share EXTRA_SUBJECT and EXTRA_TEXT identically to mobile/www/core.js.
     */
    fun sharedText(text: String?, subject: String?): String? {
        val cleanText = text?.trim().orEmpty()
        val cleanSubject = subject?.trim().orEmpty()
        if (cleanText.isEmpty()) return null
        return if (cleanSubject.isNotEmpty() && !cleanText.contains(cleanSubject)) {
            "$cleanSubject\n$cleanText"
        } else {
            cleanText
        }
    }

    fun formatSize(bytes: Long): String {
        val n = max(0L, bytes)
        return if (n < 1024L * 1024L) {
            val kb = max(1L, (n.toDouble() / 1024.0).roundToLong())
            "$kb KB"
        } else {
            String.format(java.util.Locale.US, "%.1f MB", n.toDouble() / (1024.0 * 1024.0))
        }
    }

    fun truncateCodePoints(input: String, maxCodePoints: Int): String {
        if (maxCodePoints <= 0) return ""
        val count = input.codePointCount(0, input.length)
        if (count <= maxCodePoints) return input
        val endIndex = input.offsetByCodePoints(0, maxCodePoints)
        return input.substring(0, endIndex)
    }

    /**
     * JavaScript-compatible encodeURIComponent (spaces become %20, never '+', matching server decodeURIComponent).
     */
    fun encodeURIComponent(value: String): String {
        val bytes = value.toByteArray(Charsets.UTF_8)
        val out = StringBuilder(bytes.size)
        for (b in bytes) {
            val c = b.toInt() and 0xFF
            val unescaped =
                (c in 'A'.code..'Z'.code) ||
                    (c in 'a'.code..'z'.code) ||
                    (c in '0'.code..'9'.code) ||
                    c == '-'.code || c == '_'.code || c == '.'.code ||
                    c == '!'.code || c == '~'.code || c == '*'.code ||
                    c == '\''.code || c == '('.code || c == ')'.code
            if (unescaped) {
                out.append(c.toChar())
            } else {
                out.append('%')
                out.append(HEX_DIGITS[c ushr 4])
                out.append(HEX_DIGITS[c and 0x0F])
            }
        }
        return out.toString()
    }

    private val HEX_DIGITS = "0123456789ABCDEF".toCharArray()
}
