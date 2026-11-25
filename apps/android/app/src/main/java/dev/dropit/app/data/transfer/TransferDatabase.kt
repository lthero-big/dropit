package dev.dropit.app.data.transfer

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase

@Database(
    entities = [TransferTaskEntity::class],
    version = 1,
    exportSchema = false,
)
abstract class TransferDatabase : RoomDatabase() {
    abstract fun transferDao(): TransferDao

    companion object {
        private const val DB_NAME = "dropit_transfers.db"

        fun create(context: Context): TransferDatabase =
            Room.databaseBuilder(
                context.applicationContext,
                TransferDatabase::class.java,
                DB_NAME,
            )
                .fallbackToDestructiveMigration()
                .build()
    }
}
