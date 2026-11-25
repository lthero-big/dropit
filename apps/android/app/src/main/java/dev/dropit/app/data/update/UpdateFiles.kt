package dev.dropit.app.data.update

import dev.dropit.app.core.network.AppUpdateManifest
import dev.dropit.app.core.network.UpdateSource
import java.net.URI
import java.util.Locale

/**
 * Pure JVM SemVer 2.0.0 representation for reliable release comparisons.
 */
data class SemVer(
    val major: Int,
    val minor: Int,
    val patch: Int,
    val preRelease: List<String> = emptyList(),
) : Comparable<SemVer> {

    override fun compareTo(other: SemVer): Int {
        if (major != other.major) return major.compareTo(other.major)
        if (minor != other.minor) return minor.compareTo(other.minor)
        if (patch != other.patch) return patch.compareTo(other.patch)
        if (preRelease.isEmpty() && other.preRelease.isEmpty()) return 0
        if (preRelease.isEmpty()) return 1 // release > pre-release
        if (other.preRelease.isEmpty()) return -1
        val count = minOf(preRelease.size, other.preRelease.size)
        for (i in 0 until count) {
            val a = preRelease[i]
            val b = other.preRelease[i]
            if (a == b) continue
            val aNum = a.toLongOrNull()
            val bNum = b.toLongOrNull()
            return when {
                aNum != null && bNum != null -> aNum.compareTo(bNum)
                aNum != null -> -1 // numeric identifiers have lower precedence than non-numeric
                bNum != null -> 1
                else -> a.compareTo(b)
            }
        }
        return preRelease.size.compareTo(other.preRelease.size)
    }

    companion object {
        private val SEMVER_REGEX = Regex(
            "^v?(\\d+)\\.(\\d+)\\.(\\d+)(?:-([0-9A-Za-z.-]+))?(?:\\+[0-9A-Za-z.-]+)?$",
        )

        fun parse(raw: String?): SemVer? {
            val cleaned = raw?.trim().orEmpty()
            if (cleaned.isEmpty()) return null
            val match = SEMVER_REGEX.matchEntire(cleaned) ?: return null
            val major = match.groupValues[1].toIntOrNull() ?: return null
            val minor = match.groupValues[2].toIntOrNull() ?: return null
            val patch = match.groupValues[3].toIntOrNull() ?: return null
            val preRaw = match.groupValues[4]
            val preParts = if (preRaw.isEmpty()) {
                emptyList()
            } else {
                val parts = preRaw.split('.')
                if (parts.any { it.isEmpty() }) return null
                parts
            }
            return SemVer(major = major, minor = minor, patch = patch, preRelease = preParts)
        }
    }
}

/**
 * Reliable version comparison combining semantic version (`versionName`) and Android `versionCode`.
 */
object UpdateVersionComparator {

    fun compare(
        aVersionName: String,
        aVersionCode: Int,
        bVersionName: String,
        bVersionCode: Int,
    ): Int {
        val semA = SemVer.parse(aVersionName)
        val semB = SemVer.parse(bVersionName)
        if (aVersionCode > 0 && bVersionCode > 0) {
            if (aVersionCode == bVersionCode) return 0
            if (semA != null && semB != null) {
                val semCmp = semA.compareTo(semB)
                if (semCmp != 0) return semCmp
            }
            return aVersionCode.compareTo(bVersionCode)
        }
        if (semA != null && semB != null) {
            return semA.compareTo(semB)
        }
        return 0
    }

    fun isNewer(
        candidateVersionName: String,
        candidateVersionCode: Int,
        currentVersionName: String,
        currentVersionCode: Int,
    ): Boolean = compare(
        aVersionName = candidateVersionName,
        aVersionCode = candidateVersionCode,
        bVersionName = currentVersionName,
        bVersionCode = currentVersionCode,
    ) > 0

    fun isSameVersionName(a: String?, b: String?): Boolean {
        val cleanA = a?.trim().orEmpty()
        val cleanB = b?.trim().orEmpty()
        if (cleanA.isEmpty() || cleanB.isEmpty()) return false
        val semA = SemVer.parse(cleanA)
        val semB = SemVer.parse(cleanB)
        if (semA != null && semB != null) {
            return semA.compareTo(semB) == 0
        }
        return cleanA.equals(cleanB, ignoreCase = true)
    }
}

/**
 * Security & validation helpers for both self-hosted and GitHub Releases APK updates.
 * - Self-hosted updates: strictly same-origin HTTPS `/api/app/android/download/<name>.apk`, no redirects.
 * - GitHub Releases updates: strictly HTTPS on `github.com` / `*.githubusercontent.com` allowlist,
 *   verified against the companion `.apk.sha256` file and capped at 200 MB.
 */
object UpdateFiles {
    const val MAX_BYTES: Long = 200L * 1024L * 1024L
    const val MAX_SHA256_FILE_BYTES: Int = 4 * 1024
    const val GITHUB_TAG_PREFIX: String = "android-v"

    private val DOWNLOAD_PATH_REGEX =
        Regex("^/api/app/android/download/[A-Za-z0-9][A-Za-z0-9._-]{0,120}\\.apk$")
    private val SHA256_HEX_REGEX = Regex("^[0-9a-f]{64}$")
    private val VERSION_NAME_REGEX = Regex("^[0-9A-Za-z][0-9A-Za-z._+-]{0,39}$")
    private val HOST_LABEL_REGEX = Regex("^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")

    private val VERSION_CODE_TABLE_REGEX =
        Regex("""versionCode[^|\r\n]*\|\s*`?(\d{1,9})`?\s*\|""", RegexOption.IGNORE_CASE)
    private val VERSION_CODE_KV_REGEX =
        Regex("""\bversionCode\b\s*[:=]\s*`?(\d{1,9})`?""", RegexOption.IGNORE_CASE)
    private val VERSION_CODE_PAREN_REGEX =
        Regex("""\(\s*code\s+(\d{1,9})\s*\)""", RegexOption.IGNORE_CASE)

    fun isUpdateUrl(serverOrigin: String?, url: String?): Boolean =
        isUpdateUrl(serverOrigin = serverOrigin, url = url, allowInsecureHttpForTest = false)

    internal fun isUpdateUrl(
        serverOrigin: String?,
        url: String?,
        allowInsecureHttpForTest: Boolean,
    ): Boolean {
        if (serverOrigin == null || url == null) return false
        return try {
            val uri = URI(url)
            val scheme = uri.scheme?.lowercase(Locale.ROOT) ?: return false
            val allowedScheme = scheme == "https" || (allowInsecureHttpForTest && scheme == "http")
            if (!allowedScheme || uri.host == null || uri.rawUserInfo != null) return false
            if (uri.rawQuery != null || uri.rawFragment != null) return false
            val port = uri.port
            val defaultPort = (scheme == "https" && (port == -1 || port == 443)) ||
                (scheme == "http" && (port == -1 || port == 80))
            val host = uri.host.lowercase(Locale.ROOT)
            val origin = "$scheme://$host${if (defaultPort) "" else ":$port"}"
            val path = uri.rawPath
            origin == serverOrigin && isDownloadPath(path)
        } catch (_: Exception) {
            false
        }
    }

    fun isAllowedGitHubDownloadUrl(
        url: String?,
        allowInsecureHttpForTest: Boolean = false,
    ): Boolean {
        if (url.isNullOrBlank()) return false
        return try {
            val uri = URI(url.trim())
            val scheme = uri.scheme?.lowercase(Locale.ROOT) ?: return false
            val host = uri.host?.lowercase(Locale.ROOT) ?: return false
            if (uri.rawUserInfo != null) return false

            if (allowInsecureHttpForTest && scheme == "http" && (host == "127.0.0.1" || host == "localhost")) {
                return true
            }
            if (scheme != "https") return false
            isAllowedGitHubHost(host)
        } catch (_: Exception) {
            false
        }
    }

    fun isAllowedGitHubHost(host: String?): Boolean {
        val normalized = host?.trim()?.lowercase(Locale.ROOT) ?: return false
        if (normalized == "github.com") return true
        val suffix = ".githubusercontent.com"
        if (!normalized.endsWith(suffix)) return false
        val prefix = normalized.removeSuffix(suffix)
        if (prefix.isEmpty()) return false
        return prefix.split('.').all { label -> HOST_LABEL_REGEX.matches(label) }
    }

    fun parseGitHubReleaseTag(tagName: String?): String? {
        val raw = tagName?.trim().orEmpty()
        if (!raw.startsWith(GITHUB_TAG_PREFIX)) return null
        val version = raw.removePrefix(GITHUB_TAG_PREFIX)
        if (!VERSION_NAME_REGEX.matches(version)) return null
        if (SemVer.parse(version) == null) return null
        return version
    }

    fun extractVersionCodeFromReleaseBody(body: String?, releaseName: String? = null): Int {
        val sources = listOfNotNull(body, releaseName)
        for (text in sources) {
            if (text.isBlank()) continue
            val tableMatch = VERSION_CODE_TABLE_REGEX.find(text)?.groupValues?.getOrNull(1)?.toIntOrNull()
            if (tableMatch != null && tableMatch > 0) return tableMatch
            val kvMatch = VERSION_CODE_KV_REGEX.find(text)?.groupValues?.getOrNull(1)?.toIntOrNull()
            if (kvMatch != null && kvMatch > 0) return kvMatch
            val parenMatch = VERSION_CODE_PAREN_REGEX.find(text)?.groupValues?.getOrNull(1)?.toIntOrNull()
            if (parenMatch != null && parenMatch > 0) return parenMatch
        }
        return 0
    }

    /**
     * Parses a standard `sha256sum` file (`<64-hex>  <filename>` or bare `<64-hex>`).
     * Strictly requires 64-character lowercase hex and, when a filename token is present,
     * checks that its basename matches [expectedFileName].
     */
    fun parseSha256File(rawContent: String?, expectedFileName: String? = null): String? {
        if (rawContent.isNullOrBlank()) return null
        val firstNonBlankLine = rawContent.lineSequence()
            .map { it.trim() }
            .firstOrNull { it.isNotEmpty() }
            ?: return null
        val tokens = firstNonBlankLine.split(Regex("\\s+"), limit = 2)
        val hash = tokens.firstOrNull()?.trim().orEmpty()
        if (!isSha256(hash)) return null
        if (tokens.size >= 2 && !expectedFileName.isNullOrBlank()) {
            val fileToken = tokens[1].trim().removePrefix("*").trim()
            if (fileToken.isNotEmpty()) {
                val baseName = fileToken.substringAfterLast('/').substringAfterLast('\\')
                if (baseName != expectedFileName) return null
            }
        }
        return hash
    }

    fun summarizeReleaseNotes(rawBody: String?, maxLength: Int = 4000): String {
        if (rawBody.isNullOrBlank()) return ""
        val lines = rawBody.replace("\r\n", "\n").split('\n')
        val out = mutableListOf<String>()
        var inCodeFence = false
        for (rawLine in lines) {
            val trimmed = rawLine.trim()
            if (trimmed.startsWith("```")) {
                inCodeFence = !inCodeFence
                continue
            }
            if (inCodeFence) continue
            // Skip pure Markdown table divider rows like | --- | --- |
            if (trimmed.startsWith("|") && trimmed.replace("|", "").replace("-", "").replace(":", "").isBlank()) {
                continue
            }
            val cleaned = when {
                trimmed.startsWith("|") && trimmed.endsWith("|") -> {
                    trimmed.trim('|')
                        .split('|')
                        .map { it.trim().replace("`", "").replace("**", "") }
                        .filter { it.isNotEmpty() }
                        .joinToString("：")
                }
                else -> trimmed
                    .replace(Regex("^#{1,6}\\s+"), "")
                    .replace(Regex("^>\\s*"), "")
                    .replace("**", "")
                    .replace("`", "")
            }
            if (cleaned.isEmpty()) {
                if (out.isNotEmpty() && out.last().isNotEmpty()) {
                    out.add("")
                }
            } else {
                out.add(cleaned)
            }
        }
        return out.joinToString("\n").trim().take(maxLength)
    }

    fun isDownloadPath(path: String?): Boolean {
        if (path == null) return false
        return !path.contains("..") && DOWNLOAD_PATH_REGEX.matches(path)
    }

    fun isSha256(hex: String?): Boolean =
        hex != null && SHA256_HEX_REGEX.matches(hex)

    fun hex(bytes: ByteArray): String {
        val out = StringBuilder(bytes.size * 2)
        for (b in bytes) {
            out.append(String.format(Locale.ROOT, "%02x", b.toInt() and 0xff))
        }
        return out.toString()
    }

    fun isValidManifest(manifest: AppUpdateManifest): Boolean =
        isValidManifest(manifest, allowInsecureHttpForTest = false)

    internal fun isValidManifest(
        manifest: AppUpdateManifest,
        allowInsecureHttpForTest: Boolean,
    ): Boolean = when (manifest.source) {
        UpdateSource.SELF_HOSTED -> manifest.versionCode > 0 &&
            manifest.versionName.isNotBlank() &&
            manifest.versionName.length <= 40 &&
            manifest.size in 1L..MAX_BYTES &&
            isSha256(manifest.sha256) &&
            isDownloadPath(manifest.url)

        UpdateSource.GITHUB -> manifest.versionName.isNotBlank() &&
            manifest.versionName.length <= 40 &&
            VERSION_NAME_REGEX.matches(manifest.versionName) &&
            manifest.size in 1L..MAX_BYTES &&
            isSha256(manifest.sha256) &&
            isAllowedGitHubDownloadUrl(manifest.url, allowInsecureHttpForTest)
    }
}
