package dev.dropit.app.ui.viewer

sealed class MarkdownBlock {
    data class Heading(val level: Int, val text: String) : MarkdownBlock()
    data class CodeBlock(val language: String, val code: String) : MarkdownBlock()
    data class BlockQuote(val text: String) : MarkdownBlock()
    data class BulletItem(val text: String) : MarkdownBlock()
    data class OrderedItem(val number: String, val text: String) : MarkdownBlock()
    data object Divider : MarkdownBlock()
    data class Paragraph(val text: String) : MarkdownBlock()
}

sealed class InlineSpan {
    data class Plain(val text: String) : InlineSpan()
    data class Bold(val text: String) : InlineSpan()
    data class Italic(val text: String) : InlineSpan()
    data class Code(val text: String) : InlineSpan()
    data class Link(val label: String, val url: String) : InlineSpan()
}

object MarkdownParser {
    private val HEADING_REGEX = Regex("^(#{1,6})\\s+(.+)$")
    private val BULLET_REGEX = Regex("^\\s*[-*+]\\s+(.+)$")
    private val ORDERED_REGEX = Regex("^\\s*(\\d+\\.)\\s+(.+)$")
    private val DIVIDER_REGEX = Regex("^\\s*(?:[-*_]\\s*){3,}$")
    private val FENCE_START_REGEX = Regex("^```([\\w.+-]*)\\s*$")

    private val INLINE_TOKEN_REGEX = Regex(
        """(\[([^\]]+)\]\((https?://[^)\s]+)\)|`([^`\n]+)`|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*|(https?://[^\s<>"'\])。，、；：！？）】》]+))""",
    )

    fun parseBlocks(raw: String): List<MarkdownBlock> {
        val lines = raw.replace("\r\n", "\n").replace('\r', '\n').split('\n')
        val blocks = ArrayList<MarkdownBlock>()
        val paragraphLines = ArrayList<String>()

        fun flushParagraph() {
            if (paragraphLines.isNotEmpty()) {
                blocks.add(MarkdownBlock.Paragraph(paragraphLines.joinToString("\n")))
                paragraphLines.clear()
            }
        }

        var i = 0
        while (i < lines.size) {
            val line = lines[i]
            val trimmed = line.trim()

            // Fenced code block
            val fenceMatch = FENCE_START_REGEX.matchEntire(trimmed)
            if (fenceMatch != null) {
                flushParagraph()
                val language = fenceMatch.groupValues[1]
                val codeLines = ArrayList<String>()
                i++
                while (i < lines.size && !lines[i].trim().startsWith("```")) {
                    codeLines.add(lines[i])
                    i++
                }
                if (i < lines.size && lines[i].trim().startsWith("```")) {
                    i++
                }
                blocks.add(MarkdownBlock.CodeBlock(language = language, code = codeLines.joinToString("\n")))
                continue
            }

            if (trimmed.isEmpty()) {
                flushParagraph()
                i++
                continue
            }

            if (DIVIDER_REGEX.matches(line)) {
                flushParagraph()
                blocks.add(MarkdownBlock.Divider)
                i++
                continue
            }

            val headingMatch = HEADING_REGEX.matchEntire(trimmed)
            if (headingMatch != null) {
                flushParagraph()
                blocks.add(
                    MarkdownBlock.Heading(
                        level = headingMatch.groupValues[1].length.coerceIn(1, 6),
                        text = headingMatch.groupValues[2].trim(),
                    ),
                )
                i++
                continue
            }

            if (trimmed.startsWith(">")) {
                flushParagraph()
                val quoteLines = ArrayList<String>()
                while (i < lines.size && lines[i].trim().startsWith(">")) {
                    quoteLines.add(lines[i].trim().removePrefix(">").trimStart())
                    i++
                }
                blocks.add(MarkdownBlock.BlockQuote(quoteLines.joinToString("\n")))
                continue
            }

            val bulletMatch = BULLET_REGEX.matchEntire(line)
            if (bulletMatch != null) {
                flushParagraph()
                blocks.add(MarkdownBlock.BulletItem(bulletMatch.groupValues[1].trim()))
                i++
                continue
            }

            val orderedMatch = ORDERED_REGEX.matchEntire(line)
            if (orderedMatch != null) {
                flushParagraph()
                blocks.add(
                    MarkdownBlock.OrderedItem(
                        number = orderedMatch.groupValues[1],
                        text = orderedMatch.groupValues[2].trim(),
                    ),
                )
                i++
                continue
            }

            paragraphLines.add(line)
            i++
        }

        flushParagraph()
        return blocks
    }

    fun parseInline(text: String): List<InlineSpan> {
        if (text.isEmpty()) return emptyList()
        val spans = ArrayList<InlineSpan>()
        var cursor = 0

        for (match in INLINE_TOKEN_REGEX.findAll(text)) {
            if (match.range.first > cursor) {
                spans.add(InlineSpan.Plain(text.substring(cursor, match.range.first)))
            }
            val mdLinkLabel = match.groups[2]?.value
            val mdLinkUrl = match.groups[3]?.value
            val codeText = match.groups[4]?.value
            val boldText = match.groups[5]?.value
            val italicText = match.groups[6]?.value
            val bareUrl = match.groups[7]?.value

            when {
                mdLinkLabel != null && mdLinkUrl != null -> {
                    spans.add(InlineSpan.Link(label = mdLinkLabel, url = mdLinkUrl))
                }
                codeText != null -> {
                    spans.add(InlineSpan.Code(codeText))
                }
                boldText != null -> {
                    spans.add(InlineSpan.Bold(boldText))
                }
                italicText != null -> {
                    spans.add(InlineSpan.Italic(italicText))
                }
                bareUrl != null -> {
                    val cleanedUrl = bareUrl.trimEnd('.', ',', ';', ':', '!', '?', ')', ']')
                    val trailing = bareUrl.removePrefix(cleanedUrl)
                    if (cleanedUrl.isNotEmpty()) {
                        spans.add(InlineSpan.Link(label = cleanedUrl, url = cleanedUrl))
                    }
                    if (trailing.isNotEmpty()) {
                        spans.add(InlineSpan.Plain(trailing))
                    }
                }
                else -> {
                    spans.add(InlineSpan.Plain(match.value))
                }
            }
            cursor = match.range.last + 1
        }

        if (cursor < text.length) {
            spans.add(InlineSpan.Plain(text.substring(cursor)))
        }
        return spans
    }
}
