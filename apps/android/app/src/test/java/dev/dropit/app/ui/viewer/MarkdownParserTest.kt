package dev.dropit.app.ui.viewer

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class MarkdownParserTest {

    @Test
    fun parseBlocks_recognizesHeadingsCodeQuotesListsAndDividers() {
        val sample = """
            # 设计文档
            
            > 纸感设计系统摘要
            
            - 第一项
            - 第二项
            
            1. 步骤一
            2. 步骤二
            
            ```kotlin
            val app = "dropit"
            println(app)
            ```
            
            ---
            
            访问 https://dropit.lthero.com 查看线上服务。
        """.trimIndent()

        val blocks = MarkdownParser.parseBlocks(sample)
        assertTrue(blocks[0] is MarkdownBlock.Heading)
        assertEquals(1, (blocks[0] as MarkdownBlock.Heading).level)
        assertEquals("设计文档", (blocks[0] as MarkdownBlock.Heading).text)

        assertTrue(blocks[1] is MarkdownBlock.BlockQuote)
        assertEquals("纸感设计系统摘要", (blocks[1] as MarkdownBlock.BlockQuote).text)

        assertTrue(blocks[2] is MarkdownBlock.BulletItem)
        assertTrue(blocks[3] is MarkdownBlock.BulletItem)
        assertTrue(blocks[4] is MarkdownBlock.OrderedItem)
        assertTrue(blocks[5] is MarkdownBlock.OrderedItem)

        val code = blocks[6] as MarkdownBlock.CodeBlock
        assertEquals("kotlin", code.language)
        assertEquals("val app = \"dropit\"\nprintln(app)", code.code)

        assertTrue(blocks[7] is MarkdownBlock.Divider)
        assertTrue(blocks[8] is MarkdownBlock.Paragraph)
    }

    @Test
    fun parseInline_extractsLinksBoldItalicInlineCodeAndBareUrls() {
        val spans = MarkdownParser.parseInline(
            "参考 **重要** *说明* `code()` 与 [官网](https://dropit.lthero.com) 以及 https://example.com/path。",
        )
        assertTrue(spans.any { it == InlineSpan.Bold("重要") })
        assertTrue(spans.any { it == InlineSpan.Italic("说明") })
        assertTrue(spans.any { it == InlineSpan.Code("code()") })
        assertTrue(spans.any { it == InlineSpan.Link("官网", "https://dropit.lthero.com") })
        assertTrue(spans.any { it == InlineSpan.Link("https://example.com/path", "https://example.com/path") })
    }

    @Test
    fun formatMediaTime_formatsMinutesAndHoursDeterministically() {
        assertEquals("00:00", formatMediaTime(0L))
        assertEquals("01:05", formatMediaTime(65_000L))
        assertEquals("1:02:03", formatMediaTime(3_723_000L))
    }
}
