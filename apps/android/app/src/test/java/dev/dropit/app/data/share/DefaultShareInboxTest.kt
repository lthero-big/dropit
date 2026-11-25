package dev.dropit.app.data.share

import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.File
import java.nio.file.Files

class DefaultShareInboxTest {

    private lateinit var stagingRoot: File

    @Before
    fun setUp() {
        stagingRoot = Files.createTempDirectory("dropit-share-inbox-test").toFile()
    }

    @After
    fun tearDown() {
        stagingRoot.deleteRecursively()
    }

    @Test
    fun stagePayload_mergesSubjectAndTextAlignedWithCoreJs() = runTest {
        val inbox = DefaultShareInbox(stagingRootDir = stagingRoot, extractor = { null })

        assertTrue(
            inbox.stagePayload(
                ExtractedSharePayload(
                    subject = "项目周报",
                    text = "https://dropit.lthero.com/docs",
                ),
            ),
        )
        assertEquals("项目周报\nhttps://dropit.lthero.com/docs", inbox.pendingShare.value?.text)

        // When text already contains subject, do not duplicate it.
        assertTrue(
            inbox.stagePayload(
                ExtractedSharePayload(
                    subject = "dropit",
                    text = "dropit 实时剪贴板",
                ),
            ),
        )
        assertEquals("dropit 实时剪贴板", inbox.pendingShare.value?.text)

        // Blank text with no streams returns false and keeps current state untouched.
        assertFalse(inbox.stagePayload(ExtractedSharePayload(subject = "仅有标题", text = "   ")))
    }

    @Test
    fun stagePayload_copiesMultipleFilesPrivatelyAndSurvivesProcessRestart() = runTest {
        val bytes1 = "第一张图片数据".toByteArray(Charsets.UTF_8)
        val bytes2 = ByteArray(4096) { (it % 251).toByte() }

        val inbox1 = DefaultShareInbox(stagingRootDir = stagingRoot, extractor = { null })
        val accepted = inbox1.stagePayload(
            ExtractedSharePayload(
                text = "附上两个文件",
                subject = "分享",
                streams = listOf(
                    ShareStreamSource(
                        displayName = "截图 01.png",
                        mimeType = "image/png",
                        openStream = { ByteArrayInputStream(bytes1) },
                    ),
                    ShareStreamSource(
                        displayName = "../恶意路径/合同.pdf",
                        mimeType = "application/pdf",
                        openStream = { ByteArrayInputStream(bytes2) },
                    ),
                ),
            ),
        )
        assertTrue(accepted)

        val pending = inbox1.pendingShare.value!!
        assertEquals("分享\n附上两个文件", pending.text)
        assertEquals(2, pending.files.size)
        assertEquals("截图 01.png", pending.files[0].displayName)
        assertEquals(bytes1.size.toLong(), pending.files[0].sizeBytes)
        assertEquals("合同.pdf", pending.files[1].displayName)
        assertEquals(bytes2.size.toLong(), pending.files[1].sizeBytes)

        val stagedFile1 = File(pending.files[0].stagedFilePath)
        val stagedFile2 = File(pending.files[1].stagedFilePath)
        assertTrue(stagedFile1.isFile)
        assertTrue(stagedFile2.isFile)
        assertTrue(stagedFile2.canonicalPath.startsWith(stagingRoot.canonicalPath))
        assertArrayEquals(bytes1, stagedFile1.readBytes())
        assertArrayEquals(bytes2, stagedFile2.readBytes())

        // Simulate process death & cold restart: a fresh DefaultShareInbox restores pendingShare from disk.
        val inbox2 = DefaultShareInbox(stagingRootDir = stagingRoot, extractor = { null })
        val restored = inbox2.pendingShare.value
        assertNotNull(restored)
        assertEquals(pending.id, restored?.id)
        assertEquals(pending.text, restored?.text)
        assertEquals(2, restored?.files?.size)
        assertArrayEquals(bytes1, File(restored!!.files[0].stagedFilePath).readBytes())
    }

    @Test
    fun discardAndReplace_cleanUpStagedFilesWhileConsumeKeepsFilesForTransferManager() = runTest {
        val inbox = DefaultShareInbox(stagingRootDir = stagingRoot, extractor = { null })

        // 1. Stage first share, then discard -> files must be deleted from disk.
        assertTrue(
            inbox.stagePayload(
                ExtractedSharePayload(
                    streams = listOf(
                        ShareStreamSource("old.txt", "text/plain") { ByteArrayInputStream("old".toByteArray()) },
                    ),
                ),
            ),
        )
        val oldFile = File(inbox.pendingShare.value!!.files.first().stagedFilePath)
        assertTrue(oldFile.exists())

        inbox.discardPendingShare()
        assertNull(inbox.pendingShare.value)
        assertFalse("Discarded share file must be deleted", oldFile.exists())

        // 2. Stage share A, replace with share B -> share A files must be deleted.
        assertTrue(
            inbox.stagePayload(
                ExtractedSharePayload(
                    streams = listOf(
                        ShareStreamSource("a.txt", "text/plain") { ByteArrayInputStream("aaa".toByteArray()) },
                    ),
                ),
            ),
        )
        val fileA = File(inbox.pendingShare.value!!.files.first().stagedFilePath)
        assertTrue(fileA.exists())

        assertTrue(
            inbox.stagePayload(
                ExtractedSharePayload(
                    streams = listOf(
                        ShareStreamSource("b.txt", "text/plain") { ByteArrayInputStream("bbb".toByteArray()) },
                    ),
                ),
            ),
        )
        val fileB = File(inbox.pendingShare.value!!.files.first().stagedFilePath)
        assertFalse("Replaced share A file must be cleaned up", fileA.exists())
        assertTrue(fileB.exists())

        // 3. Consume share B -> pendingShare cleared, manifest removed, staged file preserved for TransferManager.
        val consumed = inbox.consumePendingShare()
        assertNotNull(consumed)
        assertNull(inbox.pendingShare.value)
        assertTrue("Consumed staged file remains until TransferManager finishes", fileB.exists())

        // Fresh restart after consume should not resurrect the consumed share.
        val restarted = DefaultShareInbox(stagingRootDir = stagingRoot, extractor = { null })
        assertNull(restarted.pendingShare.value)
    }

    @Test
    fun captureIntent_returnsFalseWhenExtractorIgnoresIntent() = runTest {
        val inbox = DefaultShareInbox(stagingRootDir = stagingRoot, extractor = { null })
        assertFalse(inbox.captureIntent(null))
        assertNull(inbox.pendingShare.value)
    }
}
