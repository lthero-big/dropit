package dev.dropit.app.data.transfer

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

@Database(
    entities = [TransferTaskEntity::class, SavedDownloadEntity::class],
    version = 2,
    exportSchema = false,
)
abstract class TransferDatabase : RoomDatabase() {
    abstract fun transferDao(): TransferDao

    companion object {
        private const val DB_NAME = "dropit_transfers.db"

        /**
         * Non-destructive migration from v1 to v2:
         * - Creates independent `saved_downloads` index table scoped by `(serverOrigin, accountId, remoteItemId)`.
         * - Backfills the most recent succeeded system-download record per item from existing `transfer_tasks`
         *   so upgraded users immediately see saved indicators for previously downloaded files.
         * - Compatible with SQLite 3.8+ (API 23+): avoids window functions by ordering ascending with `INSERT OR REPLACE`.
         */
        val MIGRATION_1_2: Migration = object : Migration(1, 2) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    """
                    CREATE TABLE IF NOT EXISTS `saved_downloads` (
                        `serverOrigin` TEXT NOT NULL,
                        `accountId` TEXT NOT NULL,
                        `remoteItemId` TEXT NOT NULL,
                        `localUri` TEXT NOT NULL,
                        `fileName` TEXT NOT NULL,
                        `mimeType` TEXT NOT NULL,
                        `fileSize` INTEGER NOT NULL,
                        `savedAt` INTEGER NOT NULL,
                        PRIMARY KEY(`serverOrigin`, `accountId`, `remoteItemId`)
                    )
                    """.trimIndent(),
                )
                db.execSQL(
                    """
                    CREATE INDEX IF NOT EXISTS `index_saved_downloads_serverOrigin_accountId`
                    ON `saved_downloads` (`serverOrigin`, `accountId`)
                    """.trimIndent(),
                )
                db.execSQL(
                    """
                    CREATE INDEX IF NOT EXISTS `index_saved_downloads_savedAt`
                    ON `saved_downloads` (`savedAt`)
                    """.trimIndent(),
                )
                db.execSQL(
                    """
                    INSERT OR REPLACE INTO `saved_downloads` (
                        `serverOrigin`, `accountId`, `remoteItemId`, `localUri`,
                        `fileName`, `mimeType`, `fileSize`, `savedAt`
                    )
                    SELECT
                        t.`serverOrigin`,
                        COALESCE(t.`accountId`, ''),
                        t.`remoteItemId`,
                        t.`localResultUri`,
                        t.`fileName`,
                        t.`mimeType`,
                        CASE WHEN t.`transferredBytes` > 0 THEN t.`transferredBytes` ELSE t.`totalBytes` END,
                        CASE WHEN t.`updatedAt` > 0 THEN t.`updatedAt` ELSE t.`createdAt` END
                    FROM `transfer_tasks` AS t
                    WHERE t.`direction` = 'DOWNLOAD'
                      AND t.`status` = 'SUCCEEDED'
                      AND t.`shareAfterDownload` = 0
                      AND t.`remoteItemId` IS NOT NULL AND t.`remoteItemId` != ''
                      AND t.`localResultUri` IS NOT NULL AND t.`localResultUri` != ''
                    ORDER BY t.`updatedAt` ASC, t.`createdAt` ASC, t.`id` ASC
                    """.trimIndent(),
                )
            }
        }

        fun create(context: Context): TransferDatabase =
            Room.databaseBuilder(
                context.applicationContext,
                TransferDatabase::class.java,
                DB_NAME,
            )
                .addMigrations(MIGRATION_1_2)
                .build()
    }
}
