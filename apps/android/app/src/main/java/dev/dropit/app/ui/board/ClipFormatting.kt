package dev.dropit.app.ui.board

import androidx.compose.ui.graphics.Color
import dev.dropit.app.core.network.ClipItem
import dev.dropit.app.ui.theme.DropitFileTypeColors
import java.net.URI
import kotlin.math.max

enum class ClipVisualKind {
    SHORT_TEXT,
    LONG_TEXT,
    LINK,
    CODE,
    COLOR,
    IMAGE,
    VIDEO,
    AUDIO,
    FILE,
}

enum class FileTypeCategory {
    PDF,
    ARCHIVE,
    AUDIO,
    VIDEO,
    IMAGE,
    DESIGN,
    CODE,
    DOC,
    FILE,
}

data class FileTypeBadgeInfo(
    val category: FileTypeCategory,
    val label: String,
    val ext: String,
    val tint: Color,
)

data class ParsedCodeBlock(
    val language: String,
    val body: String,
)

data class ParsedLinkInfo(
    val rawUrl: String,
    val host: String,
    val displayPath: String,
    val initial: String,
)

data class ExpiryDisplay(
    val label: String,
    val isExpiringSoon: Boolean,
)

object ClipFormatting {
    const val AGING_WINDOW_MS: Long = 20L * 60_000L
    const val MAX_GROUPS: Int = 24
    const val MAX_GROUP_NAME_LENGTH: Int = 32
    val RESERVED_GROUP_NAMES: Set<String> = setOf("全部", "未分组")

    private val COLOR_REGEX = Regex(
        "^(#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|(?:rgba?|hsla?|oklch|oklab|lab|lch)\\([^()\\n]{1,60}\\))$",
    )
    private val FENCED_CODE_REGEX = Regex("^```([\\w+-]*)\\n?([\\s\\S]*?)\\n?```$")
    private val MARKDOWN_LIST_OR_HEADING_REGEX = Regex("^\\s*(?:[-*+]|\\d+\\.)\\s|^#{1,6}\\s")
    private val CODE_HINTS = listOf(
        Regex(
            "^\\s*(?:import|export|const|let|var|function|class|def|return|if|for|while|package|#include|using|SELECT|INSERT|UPDATE)\\b",
            RegexOption.MULTILINE,
        ),
        Regex("[;{}]\\s*$", RegexOption.MULTILINE),
        Regex("=>|::|\\$\\(|</?[a-z][\\w-]*[\\s>]"),
    )
    private val URL_EXTRACT_REGEX = Regex("https?://[^\\s<>\"'\\])]+")

    private val PDF_REGEX = Regex("\\.(pdf)$", RegexOption.IGNORE_CASE)
    private val ARCHIVE_REGEX = Regex("\\.(zip|tar|zst|gz|7z|rar)(\\.|$)", RegexOption.IGNORE_CASE)
    private val AUDIO_REGEX = Regex("\\.(m4a|mp3|wav|flac|ogg|oga|aac|opus)$", RegexOption.IGNORE_CASE)
    private val VIDEO_REGEX = Regex("\\.(mp4|mov|webm|m4v|ogv)$", RegexOption.IGNORE_CASE)
    private val IMAGE_REGEX = Regex("\\.(png|jpe?g|gif|webp|heic|avif|bmp|svg)$", RegexOption.IGNORE_CASE)
    private val DESIGN_REGEX = Regex("\\.(fig|sketch|psd)$", RegexOption.IGNORE_CASE)
    private val CODE_FILE_REGEX = Regex("\\.(ts|tsx|js|json|sh|py|go|rs|kt|kts|java|xml|yml|yaml)$", RegexOption.IGNORE_CASE)
    private val DOC_REGEX = Regex("\\.(md|txt|docx?|rtf|csv|xlsx?|pptx?)$", RegexOption.IGNORE_CASE)

    fun classifyClip(item: ClipItem): ClipVisualKind {
        if (item.isFile) {
            if (item.hasThumbnail) return ClipVisualKind.IMAGE
            val mime = item.mime.orEmpty().lowercase()
            val name = item.filename.orEmpty()
            return when {
                mime.startsWith("image/") || IMAGE_REGEX.containsMatchIn(name) -> ClipVisualKind.IMAGE
                mime.startsWith("video/") || VIDEO_REGEX.containsMatchIn(name) -> ClipVisualKind.VIDEO
                mime.startsWith("audio/") || AUDIO_REGEX.containsMatchIn(name) -> ClipVisualKind.AUDIO
                else -> ClipVisualKind.FILE
            }
        }
        val text = item.text.orEmpty()
        if (parseLink(text) != null) return ClipVisualKind.LINK
        if (parseColor(text) != null) return ClipVisualKind.COLOR
        if (looksLikeCode(text)) return ClipVisualKind.CODE
        val trimmed = text.trim()
        return if (trimmed.length <= 80 && !trimmed.contains('\n')) {
            ClipVisualKind.SHORT_TEXT
        } else {
            ClipVisualKind.LONG_TEXT
        }
    }

    fun parseLink(text: String): ParsedLinkInfo? {
        val value = text.trim()
        if (value.isEmpty() || value.any { it.isWhitespace() }) return null
        val uri = runCatching { URI(value) }.getOrNull() ?: return null
        val scheme = uri.scheme?.lowercase() ?: return null
        if (scheme != "http" && scheme != "https") return null
        val host = uri.host?.takeIf { it.isNotBlank() } ?: return null
        val path = buildString {
            append(host)
            if (uri.port != -1 && uri.port != 80 && uri.port != 443) {
                append(":${uri.port}")
            }
            val rawPath = uri.rawPath.orEmpty()
            if (rawPath.isNotEmpty() && rawPath != "/") {
                append(rawPath)
            }
            val rawQuery = uri.rawQuery
            if (!rawQuery.isNullOrEmpty()) {
                append("?$rawQuery")
            }
        }
        val cleanHost = host.removePrefix("www.")
        val initial = cleanHost.firstOrNull()?.uppercaseChar()?.toString() ?: "L"
        return ParsedLinkInfo(
            rawUrl = value,
            host = cleanHost,
            displayPath = path,
            initial = initial,
        )
    }

    fun extractUrls(text: String): List<String> =
        URL_EXTRACT_REGEX.findAll(text).map { it.value.trimEnd('.', ',', ';', ')', ']') }.distinct().toList()

    fun parseColor(text: String): String? {
        val value = text.trim()
        return if (COLOR_REGEX.matches(value)) value else null
    }

    /**
     * Parses a `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, or `rgb(r, g, b)` color into an ARGB Long.
     */
    fun parseColorToArgb(text: String): Long? {
        val value = text.trim()
        if (value.startsWith("#")) {
            val hex = value.substring(1)
            return when (hex.length) {
                3 -> {
                    val r = hex[0].digitToIntOrNull(16) ?: return null
                    val g = hex[1].digitToIntOrNull(16) ?: return null
                    val b = hex[2].digitToIntOrNull(16) ?: return null
                    (0xFFL shl 24) or (((r * 17).toLong()) shl 16) or (((g * 17).toLong()) shl 8) or (b * 17).toLong()
                }
                4 -> {
                    val r = hex[0].digitToIntOrNull(16) ?: return null
                    val g = hex[1].digitToIntOrNull(16) ?: return null
                    val b = hex[2].digitToIntOrNull(16) ?: return null
                    val a = hex[3].digitToIntOrNull(16) ?: return null
                    (((a * 17).toLong()) shl 24) or (((r * 17).toLong()) shl 16) or (((g * 17).toLong()) shl 8) or (b * 17).toLong()
                }
                6 -> {
                    val rgb = hex.toLongOrNull(16) ?: return null
                    (0xFFL shl 24) or rgb
                }
                8 -> {
                    val rrggbb = hex.substring(0, 6).toLongOrNull(16) ?: return null
                    val aa = hex.substring(6, 8).toLongOrNull(16) ?: return null
                    (aa shl 24) or rrggbb
                }
                else -> null
            }
        }
        val rgbMatch = Regex("^rgba?\\(\\s*(\\d{1,3})\\s*[,\\s]\\s*(\\d{1,3})\\s*[,\\s]\\s*(\\d{1,3})(?:\\s*[,/]\\s*([0-9.]+%?))?\\s*\\)$", RegexOption.IGNORE_CASE)
            .matchEntire(value)
        if (rgbMatch != null) {
            val r = rgbMatch.groupValues[1].toIntOrNull()?.coerceIn(0, 255) ?: return null
            val g = rgbMatch.groupValues[2].toIntOrNull()?.coerceIn(0, 255) ?: return null
            val b = rgbMatch.groupValues[3].toIntOrNull()?.coerceIn(0, 255) ?: return null
            return (0xFFL shl 24) or (r.toLong() shl 16) or (g.toLong() shl 8) or b.toLong()
        }
        return null
    }

    fun formatRgbLabel(argb: Long): String {
        val r = (argb shr 16) and 0xFF
        val g = (argb shr 8) and 0xFF
        val b = argb and 0xFF
        return "rgb($r, $g, $b)"
    }

    fun shouldUseLightForeground(argb: Long): Boolean {
        val r = ((argb shr 16) and 0xFF) / 255.0
        val g = ((argb shr 8) and 0xFF) / 255.0
        val b = (argb and 0xFF) / 255.0
        val luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b
        return luminance < 0.52
    }

    fun looksLikeCode(text: String): Boolean {
        val value = text.trim()
        if (FENCED_CODE_REGEX.matches(value)) return true
        val lines = value.split('\n').filter { it.trim().isNotEmpty() }
        if (lines.size < 2) return false
        if (lines.any { MARKDOWN_LIST_OR_HEADING_REGEX.containsMatchIn(it) }) return false
        val hits = CODE_HINTS.count { it.containsMatchIn(value) }
        val indented = lines.count { it.startsWith("  ") || it.startsWith("\t") }
        return hits >= 2 || (hits >= 1 && indented >= 1)
    }

    fun stripCodeFence(text: String): ParsedCodeBlock {
        val trimmed = text.trim()
        val match = FENCED_CODE_REGEX.matchEntire(trimmed)
        return if (match != null) {
            ParsedCodeBlock(
                language = match.groupValues[1],
                body = match.groupValues[2],
            )
        } else {
            ParsedCodeBlock(language = "", body = text)
        }
    }

    /**
     * Payload copied to system clipboard for a text item; strips surrounding ``` fences for code clips.
     */
    fun copyPayloadForItem(item: ClipItem): String {
        val raw = item.text.orEmpty()
        return if (classifyClip(item) == ClipVisualKind.CODE) {
            stripCodeFence(raw).body
        } else {
            raw
        }
    }

    fun resolveFileTypeBadge(filename: String?, mime: String? = null): FileTypeBadgeInfo {
        val name = filename.orEmpty()
        val ext = if (name.contains('.')) {
            name.substringAfterLast('.').uppercase().take(6).ifBlank { "FILE" }
        } else {
            "FILE"
        }
        val lowerMime = mime.orEmpty().lowercase()
        return when {
            PDF_REGEX.containsMatchIn(name) || lowerMime == "application/pdf" ->
                FileTypeBadgeInfo(FileTypeCategory.PDF, "PDF", ext, DropitFileTypeColors.Pdf)
            ARCHIVE_REGEX.containsMatchIn(name) ->
                FileTypeBadgeInfo(FileTypeCategory.ARCHIVE, "ARCHIVE", ext, DropitFileTypeColors.Archive)
            AUDIO_REGEX.containsMatchIn(name) || lowerMime.startsWith("audio/") ->
                FileTypeBadgeInfo(FileTypeCategory.AUDIO, "AUDIO", ext, DropitFileTypeColors.Audio)
            VIDEO_REGEX.containsMatchIn(name) || lowerMime.startsWith("video/") ->
                FileTypeBadgeInfo(FileTypeCategory.VIDEO, "VIDEO", ext, DropitFileTypeColors.Video)
            IMAGE_REGEX.containsMatchIn(name) || lowerMime.startsWith("image/") ->
                FileTypeBadgeInfo(FileTypeCategory.IMAGE, "IMAGE", ext, DropitFileTypeColors.Image)
            DESIGN_REGEX.containsMatchIn(name) ->
                FileTypeBadgeInfo(FileTypeCategory.DESIGN, "DESIGN", ext, DropitFileTypeColors.Design)
            CODE_FILE_REGEX.containsMatchIn(name) ->
                FileTypeBadgeInfo(FileTypeCategory.CODE, "CODE", ext, DropitFileTypeColors.Code)
            DOC_REGEX.containsMatchIn(name) || lowerMime.startsWith("text/") ->
                FileTypeBadgeInfo(FileTypeCategory.DOC, "DOC", ext, DropitFileTypeColors.Doc)
            else ->
                FileTypeBadgeInfo(FileTypeCategory.FILE, "FILE", ext, DropitFileTypeColors.Default)
        }
    }

    /**
     * Preserves the trailing filename stem + extension while ellipsizing the middle for long Chinese names.
     */
    fun middleEllipsizeFilename(name: String, maxChars: Int = 34): String {
        val clean = name.trim()
        if (clean.length <= maxChars || maxChars < 10) return clean
        val dotIndex = clean.lastIndexOf('.')
        val hasExt = dotIndex > 0 && dotIndex >= clean.length - 10 && dotIndex < clean.length - 1
        val ext = if (hasExt) clean.substring(dotIndex) else ""
        val stem = if (hasExt) clean.substring(0, dotIndex) else clean
        val tailBudget = minOf(6, max(2, stem.length / 4))
        val headBudget = (maxChars - ext.length - tailBudget - 1).coerceAtLeast(4)
        if (headBudget + tailBudget + 1 >= stem.length) return clean
        return "${stem.take(headBudget)}…${stem.takeLast(tailBudget)}$ext"
    }

    fun formatRelativeTime(timestampMs: Long, nowMs: Long = System.currentTimeMillis()): String {
        if (timestampMs <= 0L) return ""
        val diffMs = max(0L, nowMs - timestampMs)
        val seconds = diffMs / 1000L
        return when {
            seconds < 45L -> "刚刚"
            seconds < 3600L -> "${max(1L, seconds / 60L)} 分钟前"
            seconds < 86_400L -> "${seconds / 3600L} 小时前"
            else -> "${seconds / 86_400L} 天前"
        }
    }

    fun formatRemainingExpiry(expiresAtMs: Long, nowMs: Long = System.currentTimeMillis()): ExpiryDisplay? {
        if (expiresAtMs <= 0L) return null
        val remainingMs = expiresAtMs - nowMs
        if (remainingMs <= 0L) {
            return ExpiryDisplay(label = "即将过期", isExpiringSoon = true)
        }
        val minutes = remainingMs / 60_000L
        val hours = remainingMs / 3_600_000L
        val days = remainingMs / 86_400_000L
        val label = when {
            minutes < 1L -> "< 1 分钟"
            minutes < 60L -> "剩 $minutes 分钟"
            hours < 24L -> "剩 $hours 小时"
            else -> "剩 $days 天"
        }
        return ExpiryDisplay(
            label = label,
            isExpiringSoon = remainingMs < AGING_WINDOW_MS,
        )
    }

    fun utf8ByteCount(text: String): Int = text.toByteArray(Charsets.UTF_8).size

    /**
     * Validates group names against server rules (`apps/server/src/domain.ts:58-70`).
     * Returns a Chinese error string when invalid, or `null` when valid.
     */
    fun validateGroupName(
        rawName: String,
        existingGroups: List<String>,
        renamingFrom: String? = null,
    ): String? {
        val trimmed = rawName.trim()
        if (trimmed.isEmpty()) return "请输入分组名称"
        if (trimmed.length > MAX_GROUP_NAME_LENGTH) return "分组名称不能超过 $MAX_GROUP_NAME_LENGTH 个字符"
        if (trimmed in RESERVED_GROUP_NAMES) return "「$trimmed」为系统保留名称，请换一个"
        if (trimmed.any { it.isISOControl() }) return "分组名称不能包含控制字符"
        val exists = existingGroups.any { it == trimmed && it != renamingFrom }
        if (exists) return "分组「$trimmed」已存在"
        if (renamingFrom == null && existingGroups.size >= MAX_GROUPS) {
            return "最多只能创建 $MAX_GROUPS 个分组"
        }
        return null
    }
}
