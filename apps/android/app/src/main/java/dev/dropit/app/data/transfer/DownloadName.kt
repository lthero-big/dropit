package dev.dropit.app.data.transfer

import java.io.ByteArrayOutputStream
import java.nio.charset.Charset
import java.nio.charset.StandardCharsets
import java.util.Locale
import java.util.regex.Pattern

/**
 * Pure Kotlin port of mobile/android/app/src/main/java/dev/dropit/app/DownloadName.java.
 * Handles RFC 5987 `filename*=` UTF-8 percent-decoding (preserving `+`), safe path/character
 * sanitization, and generic MIME fallback inference.
 */
object DownloadName {
    private val EXTENDED = Pattern.compile(
        "(?:^|;)\\s*filename\\*\\s*=\\s*([A-Za-z0-9!#\$&+^_`{}~.-]*)'[^']*'([^;\\s]+)",
        Pattern.CASE_INSENSITIVE,
    )
    private val PLAIN = Pattern.compile(
        "(?:^|;)\\s*filename\\s*=\\s*(?:\"((?:[^\"\\\\]|\\\\.)*)\"|([^;\\s]+))",
        Pattern.CASE_INSENSITIVE,
    )
    private val EXTENSION_REGEX = Regex("[A-Za-z0-9]{1,16}")

    /** Real file name from a Content-Disposition header (filename* first, then filename), or null. */
    fun fromContentDisposition(header: String?): String? {
        if (header == null) return null
        val extendedMatcher = EXTENDED.matcher(header)
        if (extendedMatcher.find()) {
            val charset = extendedMatcher.group(1)
            val encoded = extendedMatcher.group(2)
            if (encoded != null) {
                val name = sanitize(percentDecode(encoded, charset))
                if (name != null) return name
            }
        }
        val plainMatcher = PLAIN.matcher(header)
        if (plainMatcher.find()) {
            val quoted = plainMatcher.group(1)
            val unquoted = plainMatcher.group(2)
            val raw = quoted?.replace(Regex("\\\\(.)"), "$1") ?: unquoted
            return sanitize(raw)
        }
        return null
    }

    /** %XX decoding in the given charset (default UTF-8). '+' stays a plus, unlike URLDecoder. */
    fun percentDecode(value: String, charset: String?): String {
        val out = ByteArrayOutputStream()
        var i = 0
        while (i < value.length) {
            val c = value[i]
            if (c == '%' && i + 2 < value.length) {
                val hi = hex(value[i + 1])
                val lo = hex(value[i + 2])
                if (hi >= 0 && lo >= 0) {
                    out.write(hi * 16 + lo)
                    i += 3
                    continue
                }
            }
            val bytes = c.toString().toByteArray(StandardCharsets.UTF_8)
            out.write(bytes, 0, bytes.size)
            i += 1
        }
        var cs: Charset = StandardCharsets.UTF_8
        if (!charset.isNullOrEmpty()) {
            runCatching { cs = Charset.forName(charset) }
        }
        return String(out.toByteArray(), cs)
    }

    private fun hex(c: Char): Int = when (c) {
        in '0'..'9' -> c - '0'
        in 'a'..'f' -> c - 'a' + 10
        in 'A'..'F' -> c - 'A' + 10
        else -> -1
    }

    /** Safe single file name: no path, no control or reserved characters, at most 180 chars. */
    fun sanitize(name: String?): String? {
        if (name == null) return null
        val slash = maxOf(name.lastIndexOf('/'), name.lastIndexOf('\\'))
        val base = name.substring(slash + 1)
        val out = StringBuilder(base.length)
        var i = 0
        while (i < base.length) {
            val cp = base.codePointAt(i)
            i += Character.charCount(cp)
            if (cp < 0x20 || cp == 0x7f || (cp <= 0x7f && ":*?\"<>|".indexOf(cp.toChar()) >= 0)) {
                out.append('_')
            } else {
                out.appendCodePoint(cp)
            }
        }
        var clean = out.toString().trim()
        while (clean.startsWith(".")) {
            clean = clean.substring(1)
        }
        if (clean.isEmpty()) return null
        if (clean.length > 180) {
            val ext = extension(clean)
            val suffix = if (ext == null || ext.length > 16) "" else ".$ext"
            clean = clean.substring(0, 180 - suffix.length) + suffix
        }
        return clean
    }

    /** Extension without the dot (lower case), or null. */
    fun extension(name: String?): String? {
        if (name == null) return null
        val dot = name.lastIndexOf('.')
        if (dot <= 0 || dot == name.length - 1) return null
        val ext = name.substring(dot + 1)
        return if (EXTENSION_REGEX.matches(ext)) ext.lowercase(Locale.ROOT) else null
    }

    /** MIME types that say nothing about the file, so the extension decides. */
    fun genericMime(mime: String?): Boolean {
        if (mime == null) return true
        val m = baseMime(mime)
        return m.isEmpty() ||
            m == "application/octet-stream" ||
            m == "binary/octet-stream" ||
            m == "application/download" ||
            m == "application/force-download" ||
            m == "application/x-download" ||
            m == "application/unknown"
    }

    fun baseMime(mime: String?): String {
        if (mime == null) return ""
        val semi = mime.indexOf(';')
        val prefix = if (semi >= 0) mime.substring(0, semi) else mime
        return prefix.trim().lowercase(Locale.ROOT)
    }

    data class ResolvedDownloadMeta(
        val fileName: String,
        val mimeType: String,
    )

    /**
     * Resolves final safe download file name and MIME type from Content-Disposition,
     * fallback clip metadata, and extension/MIME lookup callbacks.
     */
    fun resolve(
        contentDisposition: String?,
        fallbackFileName: String?,
        responseMime: String?,
        fallbackMime: String? = null,
        mimeFromExtension: (String) -> String? = ::defaultMimeForExtension,
        extensionFromMime: (String) -> String? = ::defaultExtensionForMime,
    ): ResolvedDownloadMeta {
        var name = fromContentDisposition(contentDisposition)
            ?: sanitize(fallbackFileName)
            ?: "dropit-download"
        val ext = extension(name)
        val rawMime = when {
            !genericMime(responseMime) -> baseMime(responseMime)
            !genericMime(fallbackMime) -> baseMime(fallbackMime)
            else -> baseMime(responseMime)
        }
        val finalMime = if (genericMime(rawMime)) {
            val guessed = ext?.let(mimeFromExtension)?.takeIf { !genericMime(it) }
            guessed ?: "application/octet-stream"
        } else {
            if (ext == null) {
                val guessedExt = extensionFromMime(rawMime)
                if (!guessedExt.isNullOrBlank()) {
                    name = sanitize("$name.$guessedExt") ?: name
                }
            }
            rawMime
        }
        return ResolvedDownloadMeta(fileName = name, mimeType = finalMime)
    }

    private val COMMON_MIME_BY_EXT: Map<String, String> = mapOf(
        "pdf" to "application/pdf",
        "png" to "image/png",
        "jpg" to "image/jpeg",
        "jpeg" to "image/jpeg",
        "webp" to "image/webp",
        "gif" to "image/gif",
        "svg" to "image/svg+xml",
        "mp4" to "video/mp4",
        "webm" to "video/webm",
        "mov" to "video/quicktime",
        "mp3" to "audio/mpeg",
        "m4a" to "audio/mp4",
        "wav" to "audio/wav",
        "ogg" to "audio/ogg",
        "txt" to "text/plain",
        "md" to "text/markdown",
        "json" to "application/json",
        "csv" to "text/csv",
        "zip" to "application/zip",
        "gz" to "application/gzip",
        "tar" to "application/x-tar",
        "apk" to "application/vnd.android.package-archive",
    )

    private val COMMON_EXT_BY_MIME: Map<String, String> = mapOf(
        "application/pdf" to "pdf",
        "image/png" to "png",
        "image/jpeg" to "jpg",
        "image/webp" to "webp",
        "image/gif" to "gif",
        "video/mp4" to "mp4",
        "video/webm" to "webm",
        "audio/mpeg" to "mp3",
        "audio/mp4" to "m4a",
        "audio/wav" to "wav",
        "text/plain" to "txt",
        "text/markdown" to "md",
        "application/json" to "json",
        "application/zip" to "zip",
        "application/vnd.android.package-archive" to "apk",
    )

    fun defaultMimeForExtension(ext: String): String? =
        COMMON_MIME_BY_EXT[ext.lowercase(Locale.ROOT)]

    fun defaultExtensionForMime(mime: String): String? =
        COMMON_EXT_BY_MIME[baseMime(mime)]
}
