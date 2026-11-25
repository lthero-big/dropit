package dev.dropit.app.ui.board

import dev.dropit.app.core.network.ClipItem
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ClipFormattingTest {

    @Test
    fun classifyClip_detectsAllSixTextAndMediaMorphologies() {
        assertEquals(
            ClipVisualKind.SHORT_TEXT,
            ClipFormatting.classifyClip(ClipItem(id = "1", spaceId = "s", kind = "text", text = "短文本测试")),
        )
        assertEquals(
            ClipVisualKind.LONG_TEXT,
            ClipFormatting.classifyClip(
                ClipItem(id = "2", spaceId = "s", kind = "text", text = "第一行说明\n第二行说明\n第三行说明"),
            ),
        )
        assertEquals(
            ClipVisualKind.LINK,
            ClipFormatting.classifyClip(ClipItem(id = "3", spaceId = "s", kind = "text", text = "https://dropit.lthero.com/docs")),
        )
        assertEquals(
            ClipVisualKind.COLOR,
            ClipFormatting.classifyClip(ClipItem(id = "4", spaceId = "s", kind = "text", text = "#D0021B")),
        )
        assertEquals(
            ClipVisualKind.CODE,
            ClipFormatting.classifyClip(
                ClipItem(id = "5", spaceId = "s", kind = "text", text = "```kotlin\nval x = 42\n```"),
            ),
        )
        assertEquals(
            ClipVisualKind.IMAGE,
            ClipFormatting.classifyClip(
                ClipItem(id = "6", spaceId = "s", kind = "file", filename = "photo.png", hasThumbnail = true),
            ),
        )
        assertEquals(
            ClipVisualKind.VIDEO,
            ClipFormatting.classifyClip(
                ClipItem(id = "7", spaceId = "s", kind = "file", filename = "demo.mp4", mime = "video/mp4"),
            ),
        )
        assertEquals(
            ClipVisualKind.AUDIO,
            ClipFormatting.classifyClip(
                ClipItem(id = "8", spaceId = "s", kind = "file", filename = "voice.m4a", mime = "audio/mp4"),
            ),
        )
        assertEquals(
            ClipVisualKind.FILE,
            ClipFormatting.classifyClip(
                ClipItem(id = "9", spaceId = "s", kind = "file", filename = "需求文档.pdf", mime = "application/pdf"),
            ),
        )
    }

    @Test
    fun copyPayloadForItem_stripsSurroundingCodeFence() {
        val codeItem = ClipItem(
            id = "c1",
            spaceId = "s",
            kind = "text",
            text = "```ts\nconst ok = true\n```",
        )
        assertEquals("const ok = true", ClipFormatting.copyPayloadForItem(codeItem))

        val parsed = ClipFormatting.stripCodeFence(codeItem.text!!)
        assertEquals("ts", parsed.language)
        assertEquals("const ok = true", parsed.body)
    }

    @Test
    fun middleEllipsizeFilename_preservesExtensionForLongChineseNames() {
        val longName = "2026年度产品设计评审会议纪要汇总与行动项终稿.pdf"
        val result = ClipFormatting.middleEllipsizeFilename(longName, maxChars = 22)
        assertTrue(result.endsWith(".pdf"))
        assertTrue(result.contains("…"))
        assertTrue(result.length <= 22)

        // Tight budget with long extension & special characters (+, spaces) must stay bounded and keep extension
        val specialName = "2026 年度设计 + 研发评审终稿说明文档.markdown"
        val tight = ClipFormatting.middleEllipsizeFilename(specialName, maxChars = 18)
        assertTrue(tight.endsWith(".markdown"))
        assertTrue(tight.contains("…"))
        assertTrue(tight.length <= 18)
    }

    @Test
    fun isPreviewableTextFile_detectsTextCodeMarkdownAndExcludesBinaries() {
        assertTrue(
            ClipFormatting.isPreviewableTextFile(
                ClipItem(id = "1", spaceId = "s", kind = "file", filename = "说明文档.md", mime = "text/markdown"),
            ),
        )
        assertTrue(
            ClipFormatting.isPreviewableTextFile(
                ClipItem(id = "2", spaceId = "s", kind = "file", filename = "config.json", mime = "application/json"),
            ),
        )
        assertFalse(
            ClipFormatting.isPreviewableTextFile(
                ClipItem(id = "3", spaceId = "s", kind = "file", filename = "报告.pdf", mime = "application/pdf"),
            ),
        )
        assertFalse(
            ClipFormatting.isPreviewableTextFile(
                ClipItem(id = "4", spaceId = "s", kind = "file", filename = "表格.xlsx", mime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
            ),
        )
    }

    @Test
    fun validateGroupName_enforcesReservedNamesDuplicatesAndLimit() {
        assertNotNull(ClipFormatting.validateGroupName("", emptyList()))
        assertNotNull(ClipFormatting.validateGroupName("全部", emptyList()))
        assertNotNull(ClipFormatting.validateGroupName("未分组", emptyList()))
        assertNotNull(ClipFormatting.validateGroupName("工作", listOf("工作")))
        assertNull(ClipFormatting.validateGroupName("工作", listOf("工作"), renamingFrom = "工作"))

        // Server enforces max 24 Unicode code points and rejects control characters
        assertNull(ClipFormatting.validateGroupName("一".repeat(24), emptyList()))
        assertNotNull(ClipFormatting.validateGroupName("一".repeat(25), emptyList()))
        assertNotNull(ClipFormatting.validateGroupName("工作\u0007", emptyList()))
        // Collapses internal whitespace before duplicate check
        assertNotNull(ClipFormatting.validateGroupName("前端  团队", listOf("前端 团队")))

        val fullGroups = (1..24).map { "分组$it" }
        assertNotNull(ClipFormatting.validateGroupName("分组25", fullGroups))
        assertNull(ClipFormatting.validateGroupName("改名后", fullGroups, renamingFrom = "分组1"))
    }

    @Test
    fun formatRemainingExpiry_highlightsAgingWindowUnder20Minutes() {
        val now = 1_000_000L
        val expiringSoon = ClipFormatting.formatRemainingExpiry(now + 10 * 60_000L, now)!!
        assertTrue(expiringSoon.isExpiringSoon)

        val fresh = ClipFormatting.formatRemainingExpiry(now + 120 * 60_000L, now)!!
        assertFalse(fresh.isExpiringSoon)
    }
}
