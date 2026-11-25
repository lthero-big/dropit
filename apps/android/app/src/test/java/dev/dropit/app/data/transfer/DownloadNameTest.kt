package dev.dropit.app.data.transfer

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Full migration of mobile/android/app/src/test/java/dev/dropit/app/DownloadNameTest.java
 * plus Kotlin resolution tests for generic MIME fallback and Chinese filenames.
 */
class DownloadNameTest {

    @Test
    fun prefersRfc5987Name() {
        assertEquals(
            "报告 2026.pdf",
            DownloadName.fromContentDisposition(
                "attachment; filename=\"download.pdf\"; filename*=UTF-8''%E6%8A%A5%E5%91%8A%202026.pdf",
            ),
        )
        assertEquals(
            "a+b (1).zip",
            DownloadName.fromContentDisposition(
                "attachment; filename=\"a+b _1_.zip\"; filename*=UTF-8''a%2Bb%20%281%29.zip",
            ),
        )
        assertEquals(
            "photo.jpg",
            DownloadName.fromContentDisposition("attachment; FILENAME*=utf-8'en'photo.jpg"),
        )
    }

    @Test
    fun fallsBackToPlainName() {
        assertEquals("notes.txt", DownloadName.fromContentDisposition("attachment; filename=\"notes.txt\""))
        assertEquals("notes.txt", DownloadName.fromContentDisposition("attachment; filename=notes.txt"))
        assertEquals("a\"b.txt".replace('"', '_'), DownloadName.fromContentDisposition("attachment; filename=\"a\\\"b.txt\""))
        assertNull(DownloadName.fromContentDisposition("attachment"))
        assertNull(DownloadName.fromContentDisposition(null))
    }

    @Test
    fun sanitizesPathsAndReservedCharacters() {
        assertEquals(
            "passwd",
            DownloadName.fromContentDisposition("attachment; filename*=UTF-8''..%2F..%2Fetc%2Fpasswd"),
        )
        assertEquals("a_b_c.txt", DownloadName.sanitize("a:b\nc.txt"))
        assertEquals("env", DownloadName.sanitize(".env"))
        assertNull(DownloadName.sanitize("..."))
        val longName = DownloadName.sanitize("x".repeat(300) + ".mp4")
        assertEquals(180, longName?.length)
        assertTrue(longName!!.endsWith(".mp4"))
    }

    @Test
    fun extensionsAndGenericTypes() {
        assertEquals("pdf", DownloadName.extension("报告.PDF"))
        assertNull(DownloadName.extension("README"))
        assertTrue(DownloadName.genericMime("application/octet-stream"))
        assertTrue(DownloadName.genericMime(null))
        assertFalse(DownloadName.genericMime("image/png; charset=binary"))
        assertEquals("image/png", DownloadName.baseMime("Image/PNG; x=y"))
    }

    @Test
    fun resolveInfersMimeFromChineseFilenameWhenServerSendsOctetStream() {
        val resolved = DownloadName.resolve(
            contentDisposition = "attachment; filename=\"download\"; filename*=UTF-8''%E5%90%88%E5%90%8C%202026+final.pdf",
            fallbackFileName = "fallback.bin",
            responseMime = "application/octet-stream",
            fallbackMime = null,
        )
        assertEquals("合同 2026+final.pdf", resolved.fileName)
        assertEquals("application/pdf", resolved.mimeType)
    }

    @Test
    fun resolveAppendsExtensionWhenFilenameMissingExtensionAndMimeSpecific() {
        val resolved = DownloadName.resolve(
            contentDisposition = "attachment; filename=\"screenshot\"",
            fallbackFileName = null,
            responseMime = "image/png; charset=binary",
        )
        assertEquals("screenshot.png", resolved.fileName)
        assertEquals("image/png", resolved.mimeType)
    }
}
