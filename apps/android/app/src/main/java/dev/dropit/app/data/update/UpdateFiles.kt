package dev.dropit.app.data.update

import dev.dropit.app.core.network.AppUpdateManifest
import java.net.URI
import java.util.Locale

/**
 * Pure Kotlin port of mobile/android/app/src/main/java/dev/dropit/app/UpdateFiles.java.
 * An update APK is only fetched from the configured server's own https origin and only from
 * /api/app/android/download/<name>.apk; it is only installed when its size and SHA-256 match.
 */
object UpdateFiles {
    const val MAX_BYTES: Long = 200L * 1024L * 1024L
    private val DOWNLOAD_PATH_REGEX =
        Regex("^/api/app/android/download/[A-Za-z0-9][A-Za-z0-9._-]{0,120}\\.apk$")
    private val SHA256_HEX_REGEX = Regex("^[0-9a-f]{64}$")

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
        manifest.versionCode > 0 &&
            manifest.versionName.isNotBlank() &&
            manifest.versionName.length <= 40 &&
            manifest.size in 1L..MAX_BYTES &&
            isSha256(manifest.sha256) &&
            isDownloadPath(manifest.url)
}
