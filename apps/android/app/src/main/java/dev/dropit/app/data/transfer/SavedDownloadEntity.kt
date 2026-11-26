package dev.dropit.app.data.transfer

import androidx.room.Entity
import androidx.room.Index
import dev.dropit.app.core.repository.SavedDownloadRecord

/**
 * Independent local index of files saved to the device Downloads directory.
 *
 * Strictly isolated by `(serverOrigin, accountId, remoteItemId)` so clearing completed
 * transfer history never erases saved indicators, and switching accounts/servers never
 * leaks saved status across scopes.
 */
@Entity(
    tableName = "saved_downloads",
    primaryKeys = ["serverOrigin", "accountId", "remoteItemId"],
    indices = [
        Index(value = ["serverOrigin", "accountId"]),
        Index(value = ["savedAt"]),
    ],
)
data class SavedDownloadEntity(
    val serverOrigin: String,
    val accountId: String,
    val remoteItemId: String,
    val localUri: String,
    val fileName: String,
    val mimeType: String,
    val fileSize: Long,
    val savedAt: Long,
) {
    fun toDomain(): SavedDownloadRecord = SavedDownloadRecord(
        serverOrigin = serverOrigin,
        accountId = accountId.takeIf { it.isNotEmpty() },
        remoteItemId = remoteItemId,
        localUri = localUri,
        fileName = fileName,
        mimeType = mimeType,
        fileSize = fileSize,
        savedAt = savedAt,
    )

    companion object {
        fun normalizeAccountId(accountId: String?): String = accountId.orEmpty()
    }
}
