package dev.dropit.app.data.media

import java.nio.ByteBuffer
import java.nio.charset.Charset
import java.nio.charset.CodingErrorAction

data class DecodedTextPreview(
    val text: String,
    val charsetName: String,
    val truncated: Boolean,
    val totalBytes: Long? = null,
)

/**
 * Encoding-aware, size-bounded decoder for long text and Markdown previews.
 *
 * Handles:
 * - UTF-8 / UTF-16LE / UTF-16BE BOM detection and stripping
 * - `Content-Type` `charset=...` parameter parsing
 * - Boundary-safe truncation so incomplete trailing multi-byte UTF-8 sequences (e.g. CJK/emoji)
 *   are trimmed cleanly instead of producing replacement garbage (`\uFFFD`)
 * - Graceful fallback (UTF-8 strict -> GB18030 if valid -> UTF-8 replace) without throwing
 */
object TextPreviewDecoder {
    private val CHARSET_PARAM = Regex("""charset\s*=\s*"?([^";\s]+)"?""", RegexOption.IGNORE_CASE)
    private val CONTENT_RANGE_TOTAL = Regex("""bytes\s+\d+-\d+/(\d+|\*)""", RegexOption.IGNORE_CASE)

    fun decode(
        rawBytes: ByteArray,
        contentType: String?,
        maxBytes: Int,
        wasTruncated: Boolean,
        totalBytes: Long? = null,
    ): DecodedTextPreview {
        val effectiveLimit = maxBytes.coerceAtLeast(1)
        val truncatedByLength = rawBytes.size > effectiveLimit
        val truncated = wasTruncated || truncatedByLength
        val bounded = if (truncatedByLength) rawBytes.copyOf(effectiveLimit) else rawBytes

        if (bounded.isEmpty()) {
            return DecodedTextPreview(
                text = "",
                charsetName = "UTF-8",
                truncated = truncated,
                totalBytes = totalBytes ?: 0L,
            )
        }

        // 1. BOM detection takes precedence over untrusted/default headers.
        val bom = detectBom(bounded)
        if (bom != null) {
            val payload = bounded.copyOfRange(bom.bomLength, bounded.size)
            val safePayload = trimIncompleteTrailingBytes(payload, bom.charset, truncated)
            val text = decodeWithFallback(safePayload, bom.charset)
            return DecodedTextPreview(
                text = text,
                charsetName = bom.charset.name(),
                truncated = truncated,
                totalBytes = totalBytes,
            )
        }

        // 2. Explicit Content-Type charset parameter (if valid and supported on JVM/Android).
        val headerCharset = parseCharsetFromContentType(contentType)
        if (headerCharset != null) {
            val safePayload = trimIncompleteTrailingBytes(bounded, headerCharset, truncated)
            val text = decodeWithFallback(safePayload, headerCharset)
            return DecodedTextPreview(
                text = text,
                charsetName = headerCharset.name(),
                truncated = truncated,
                totalBytes = totalBytes,
            )
        }

        // 3. Default UTF-8 strict decode (after trimming any incomplete trailing UTF-8 sequence when truncated).
        val utf8Payload = trimIncompleteTrailingBytes(bounded, Charsets.UTF_8, truncated)
        decodeStrict(utf8Payload, Charsets.UTF_8)?.let { text ->
            return DecodedTextPreview(
                text = text,
                charsetName = Charsets.UTF_8.name(),
                truncated = truncated,
                totalBytes = totalBytes,
            )
        }

        // 4. Fallback for legacy Chinese text files encoded in GB18030 / GBK.
        val gb18030 = runCatching { Charset.forName("GB18030") }.getOrNull()
        if (gb18030 != null) {
            decodeStrict(bounded, gb18030)?.let { text ->
                return DecodedTextPreview(
                    text = text,
                    charsetName = gb18030.name(),
                    truncated = truncated,
                    totalBytes = totalBytes,
                )
            }
        }

        // 5. Final lossy UTF-8 decode so previews never crash on unexpected bytes.
        return DecodedTextPreview(
            text = decodeWithFallback(utf8Payload, Charsets.UTF_8),
            charsetName = Charsets.UTF_8.name(),
            truncated = truncated,
            totalBytes = totalBytes,
        )
    }

    /**
     * Truncates an in-memory [String] so its UTF-8 byte representation never exceeds [maxBytes],
     * cutting strictly on character/surrogate-pair boundaries.
     */
    fun truncateUtf8(text: String, maxBytes: Int): DecodedTextPreview {
        val limit = maxBytes.coerceAtLeast(1)
        val raw = text.toByteArray(Charsets.UTF_8)
        if (raw.size <= limit) {
            return DecodedTextPreview(
                text = text,
                charsetName = Charsets.UTF_8.name(),
                truncated = false,
                totalBytes = raw.size.toLong(),
            )
        }
        val bounded = trimIncompleteTrailingBytes(raw.copyOf(limit), Charsets.UTF_8, truncated = true)
        return DecodedTextPreview(
            text = String(bounded, Charsets.UTF_8),
            charsetName = Charsets.UTF_8.name(),
            truncated = true,
            totalBytes = raw.size.toLong(),
        )
    }

    fun parseContentRangeTotal(contentRangeHeader: String?): Long? {
        if (contentRangeHeader.isNullOrBlank()) return null
        val match = CONTENT_RANGE_TOTAL.find(contentRangeHeader.trim()) ?: return null
        val total = match.groupValues.getOrNull(1) ?: return null
        return if (total == "*") null else total.toLongOrNull()
    }

    private data class BomInfo(val charset: Charset, val bomLength: Int)

    private fun detectBom(bytes: ByteArray): BomInfo? {
        if (bytes.size >= 3 &&
            bytes[0] == 0xEF.toByte() &&
            bytes[1] == 0xBB.toByte() &&
            bytes[2] == 0xBF.toByte()
        ) {
            return BomInfo(Charsets.UTF_8, 3)
        }
        if (bytes.size >= 2 &&
            bytes[0] == 0xFF.toByte() &&
            bytes[1] == 0xFE.toByte()
        ) {
            return BomInfo(Charsets.UTF_16LE, 2)
        }
        if (bytes.size >= 2 &&
            bytes[0] == 0xFE.toByte() &&
            bytes[1] == 0xFF.toByte()
        ) {
            return BomInfo(Charsets.UTF_16BE, 2)
        }
        return null
    }

    private fun parseCharsetFromContentType(contentType: String?): Charset? {
        if (contentType.isNullOrBlank()) return null
        val match = CHARSET_PARAM.find(contentType) ?: return null
        val name = match.groupValues.getOrNull(1)?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        return runCatching { Charset.forName(name) }.getOrNull()
    }

    private fun trimIncompleteTrailingBytes(
        bytes: ByteArray,
        charset: Charset,
        truncated: Boolean,
    ): ByteArray {
        if (!truncated || bytes.isEmpty()) return bytes
        if (charset == Charsets.UTF_16LE || charset == Charsets.UTF_16BE) {
            val evenLength = bytes.size - (bytes.size % 2)
            return if (evenLength == bytes.size) bytes else bytes.copyOf(evenLength)
        }
        if (charset != Charsets.UTF_8) return bytes

        // Walk back over at most 3 trailing continuation bytes (10xxxxxx) to locate the leading byte.
        var idx = bytes.size - 1
        var continuationCount = 0
        while (idx >= 0 && continuationCount < 3 && (bytes[idx].toInt() and 0xC0) == 0x80) {
            idx -= 1
            continuationCount += 1
        }
        if (idx < 0) return bytes

        val lead = bytes[idx].toInt() and 0xFF
        val expectedLength = when {
            lead and 0x80 == 0 -> 1
            lead and 0xE0 == 0xC0 -> 2
            lead and 0xF0 == 0xE0 -> 3
            lead and 0xF8 == 0xF0 -> 4
            else -> 1
        }
        val actualLength = bytes.size - idx
        return if (actualLength < expectedLength) {
            bytes.copyOf(idx)
        } else {
            bytes
        }
    }

    private fun decodeStrict(bytes: ByteArray, charset: Charset): String? {
        return try {
            val decoder = charset.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
            decoder.decode(ByteBuffer.wrap(bytes)).toString()
        } catch (_: Exception) {
            null
        }
    }

    private fun decodeWithFallback(bytes: ByteArray, charset: Charset): String {
        val decoder = charset.newDecoder()
            .onMalformedInput(CodingErrorAction.REPLACE)
            .onUnmappableCharacter(CodingErrorAction.REPLACE)
        return decoder.decode(ByteBuffer.wrap(bytes)).toString()
    }
}
