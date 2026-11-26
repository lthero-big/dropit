package dev.dropit.app.data.transfer

import android.app.Application
import android.content.Context
import android.net.Uri
import androidx.room.Room
import androidx.sqlite.db.SupportSQLiteDatabase
import androidx.sqlite.db.SupportSQLiteOpenHelper
import androidx.sqlite.db.framework.FrameworkSQLiteOpenHelperFactory
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.dropit.app.core.repository.TransferDirection
import dev.dropit.app.core.repository.TransferStatus
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import java.io.File
import java.nio.file.Files

@RunWith(AndroidJUnit4::class)
@Config(application = Application::class, sdk = [34])
class TransferDatabaseMigrationTest {

    private lateinit var context: Context
    private lateinit var dbName: String
    private lateinit var tempDir: File

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        dbName = "test_transfer_migration_${System.nanoTime()}.db"
        tempDir = Files.createTempDirectory("dropit-migration-checker").toFile()
    }

    @After
    fun tearDown() {
        context.deleteDatabase(dbName)
        tempDir.deleteRecursively()
    }

    @Test
    fun migration1To2_createsSavedDownloadsTable_backfillsLatestSucceededSystemDownloads_andValidatesRoomSchema() =
        runTest {
            // 1. Create authentic v1 SQLite database matching TransferDatabase version 1 schema
            val helperConfig = SupportSQLiteOpenHelper.Configuration.builder(context)
                .name(dbName)
                .callback(
                    object : SupportSQLiteOpenHelper.Callback(1) {
                        override fun onCreate(db: SupportSQLiteDatabase) {
                            db.execSQL(
                                """
                                CREATE TABLE IF NOT EXISTS `transfer_tasks` (
                                    `id` TEXT NOT NULL,
                                    `serverOrigin` TEXT NOT NULL,
                                    `accountId` TEXT,
                                    `targetScopeType` TEXT NOT NULL,
                                    `targetScopeId` TEXT NOT NULL,
                                    `groupName` TEXT,
                                    `direction` TEXT NOT NULL,
                                    `fileName` TEXT NOT NULL,
                                    `mimeType` TEXT NOT NULL,
                                    `totalBytes` INTEGER NOT NULL,
                                    `transferredBytes` INTEGER NOT NULL,
                                    `remoteUploadId` TEXT,
                                    `chunkSize` INTEGER NOT NULL,
                                    `completedChunks` TEXT NOT NULL,
                                    `localStagedPath` TEXT,
                                    `localResultUri` TEXT,
                                    `remoteItemId` TEXT,
                                    `shareAfterDownload` INTEGER NOT NULL,
                                    `status` TEXT NOT NULL,
                                    `errorMessage` TEXT,
                                    `createdAt` INTEGER NOT NULL,
                                    `updatedAt` INTEGER NOT NULL,
                                    PRIMARY KEY(`id`)
                                )
                                """.trimIndent(),
                            )
                            db.execSQL(
                                "CREATE INDEX IF NOT EXISTS `index_transfer_tasks_serverOrigin_accountId` ON `transfer_tasks` (`serverOrigin`, `accountId`)",
                            )
                            db.execSQL(
                                "CREATE INDEX IF NOT EXISTS `index_transfer_tasks_status` ON `transfer_tasks` (`status`)",
                            )

                            // Older succeeded download for item-1 (must be superseded by newer one)
                            db.execSQL(
                                """
                                INSERT INTO transfer_tasks VALUES (
                                    'dl-old', 'https://dropit.example', 'acct-1', 'space', 'sp-1', NULL,
                                    'DOWNLOAD', 'report.pdf', 'application/pdf', 1000, 1000, NULL, 0, '',
                                    NULL, 'content://downloads/old', 'item-1', 0, 'SUCCEEDED', NULL, 100, 150
                                )
                                """.trimIndent(),
                            )
                            // Newer succeeded download for item-1 (must win backfill)
                            db.execSQL(
                                """
                                INSERT INTO transfer_tasks VALUES (
                                    'dl-new', 'https://dropit.example', 'acct-1', 'space', 'sp-1', NULL,
                                    'DOWNLOAD', 'report (1).pdf', 'application/pdf', 1000, 1024, NULL, 0, '',
                                    NULL, 'content://downloads/new', 'item-1', 0, 'SUCCEEDED', NULL, 200, 300
                                )
                                """.trimIndent(),
                            )
                            // Succeeded download with shareAfterDownload = 1 (must NOT be backfilled)
                            db.execSQL(
                                """
                                INSERT INTO transfer_tasks VALUES (
                                    'dl-share', 'https://dropit.example', 'acct-1', 'space', 'sp-1', NULL,
                                    'DOWNLOAD', 'shared.png', 'image/png', 500, 500, NULL, 0, '',
                                    NULL, 'content://fileprovider/share/1', 'item-share', 1, 'SUCCEEDED', NULL, 250, 260
                                )
                                """.trimIndent(),
                            )
                            // Failed download & Upload (must NOT be backfilled)
                            db.execSQL(
                                """
                                INSERT INTO transfer_tasks VALUES (
                                    'dl-fail', 'https://dropit.example', 'acct-1', 'space', 'sp-1', NULL,
                                    'DOWNLOAD', 'broken.zip', 'application/zip', 500, 100, NULL, 0, '',
                                    NULL, NULL, 'item-fail', 0, 'FAILED', 'network', 260, 270
                                )
                                """.trimIndent(),
                            )
                            db.execSQL(
                                """
                                INSERT INTO transfer_tasks VALUES (
                                    'up-ok', 'https://dropit.example', 'acct-1', 'space', 'sp-1', NULL,
                                    'UPLOAD', 'sent.txt', 'text/plain', 20, 20, NULL, 0, '',
                                    NULL, NULL, NULL, 0, 'SUCCEEDED', NULL, 280, 290
                                )
                                """.trimIndent(),
                            )
                            // Another account & null accountId (verify strict isolation and COALESCE)
                            db.execSQL(
                                """
                                INSERT INTO transfer_tasks VALUES (
                                    'dl-acct2', 'https://dropit.example', 'acct-2', 'space', 'sp-2', NULL,
                                    'DOWNLOAD', 'other.pdf', 'application/pdf', 777, 777, NULL, 0, '',
                                    NULL, 'content://downloads/acct2', 'item-1', 0, 'SUCCEEDED', NULL, 400, 410
                                )
                                """.trimIndent(),
                            )
                            db.execSQL(
                                """
                                INSERT INTO transfer_tasks VALUES (
                                    'dl-null-acct', 'https://dropit.example', NULL, 'space', 'sp-3', NULL,
                                    'DOWNLOAD', 'anon.txt', 'text/plain', 333, 333, NULL, 0, '',
                                    NULL, 'content://downloads/anon', 'item-anon', 0, 'SUCCEEDED', NULL, 500, 510
                                )
                                """.trimIndent(),
                            )
                        }

                        override fun onUpgrade(db: SupportSQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit
                    },
                )
                .build()
            FrameworkSQLiteOpenHelperFactory().create(helperConfig).writableDatabase.close()

            // 2. Open with Room v2 + explicit MIGRATION_1_2 (Room validates exact schema + indices)
            val roomDb = Room.databaseBuilder(context, TransferDatabase::class.java, dbName)
                .addMigrations(TransferDatabase.MIGRATION_1_2)
                .allowMainThreadQueries()
                .build()
            try {
                val dao = roomDb.transferDao()

                // Verify backfilled rows
                val acct1Saved = dao.listSavedDownloadsByScope("https://dropit.example", "acct-1")
                assertEquals(1, acct1Saved.size)
                assertEquals("item-1", acct1Saved.single().remoteItemId)
                assertEquals("content://downloads/new", acct1Saved.single().localUri)
                assertEquals("report (1).pdf", acct1Saved.single().fileName)
                assertEquals(1024L, acct1Saved.single().fileSize)
                assertEquals(300L, acct1Saved.single().savedAt)

                // Excluded rows must not appear
                assertNull(dao.getSavedDownload("https://dropit.example", "acct-1", "item-share"))
                assertNull(dao.getSavedDownload("https://dropit.example", "acct-1", "item-fail"))

                // Isolated account-2 and null-account rows preserved accurately
                val acct2Saved = dao.listSavedDownloadsByScope("https://dropit.example", "acct-2")
                assertEquals(1, acct2Saved.size)
                assertEquals("content://downloads/acct2", acct2Saved.single().localUri)

                val anonSaved = dao.listSavedDownloadsByScope("https://dropit.example", "")
                assertEquals(1, anonSaved.size)
                assertEquals("item-anon", anonSaved.single().remoteItemId)

                // Clearing completed transfer history must NOT delete saved_downloads
                dao.deleteCompletedForScope("https://dropit.example", "acct-1")
                assertTrue(
                    dao.listByScope("https://dropit.example", "acct-1")
                        .none { it.status == TransferStatus.SUCCEEDED.name },
                )
                assertNotNull(dao.getSavedDownload("https://dropit.example", "acct-1", "item-1"))

                // Active download lookup only matches QUEUED/RUNNING system downloads
                dao.upsert(
                    TransferTaskEntity(
                        id = "dl-active",
                        serverOrigin = "https://dropit.example",
                        accountId = "acct-1",
                        targetScopeType = "space",
                        targetScopeId = "sp-1",
                        direction = TransferDirection.DOWNLOAD.name,
                        fileName = "live.bin",
                        mimeType = "application/octet-stream",
                        totalBytes = 100L,
                        remoteItemId = "item-live",
                        shareAfterDownload = false,
                        status = TransferStatus.RUNNING.name,
                        createdAt = 600L,
                        updatedAt = 600L,
                    ),
                )
                assertEquals(
                    "dl-active",
                    dao.findActiveDownloadForItem("https://dropit.example", "acct-1", "item-live")?.id,
                )

                // Reassigning accountId handles conflict via UPDATE OR REPLACE cleanly
                dao.upsertSavedDownload(
                    SavedDownloadEntity(
                        serverOrigin = "https://dropit.example",
                        accountId = "tok:deadbeef",
                        remoteItemId = "item-1",
                        localUri = "content://downloads/reassigned",
                        fileName = "report-latest.pdf",
                        mimeType = "application/pdf",
                        fileSize = 2048L,
                        savedAt = 999L,
                    ),
                )
                dao.reassignSavedDownloadsAccountId("https://dropit.example", "tok:deadbeef", "acct-1")
                val reassigned = dao.getSavedDownload("https://dropit.example", "acct-1", "item-1")
                assertNotNull(reassigned)
                assertEquals("content://downloads/reassigned", reassigned?.localUri)
                assertTrue(dao.listSavedDownloadsByScope("https://dropit.example", "tok:deadbeef").isEmpty())
            } finally {
                roomDb.close()
            }
        }

    @Test
    fun androidLocalSavedFileChecker_verifiesLocalFilesSizeMismatchAndDeletedEntries() = runTest {
        val checker = AndroidLocalSavedFileChecker(context)
        val file = File(tempDir, "测试文档.pdf").apply { writeBytes(ByteArray(128) { 9 }) }
        val fileUri = Uri.fromFile(file).toString()

        assertTrue(checker.exists(fileUri, expectedSize = 128L))
        assertTrue(checker.exists(file.absolutePath, expectedSize = 128L))
        assertTrue(checker.exists(fileUri, expectedSize = 0L))
        assertFalse("Size mismatch must return false", checker.exists(fileUri, expectedSize = 256L))
        assertFalse("Blank URI must return false", checker.exists("", expectedSize = 128L))
        assertFalse("Nonexistent content URI must return false", checker.exists("content://media/external/downloads/999999", expectedSize = 128L))

        assertTrue(file.delete())
        assertFalse("Deleted file must return false", checker.exists(fileUri, expectedSize = 128L))
    }
}
