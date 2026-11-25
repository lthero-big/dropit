package dev.dropit.app.data.transfer

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import kotlinx.coroutines.flow.Flow

@Dao
interface TransferDao {
    @Query(
        """
        SELECT * FROM transfer_tasks
        WHERE serverOrigin = :serverOrigin
          AND ((:accountId IS NULL AND accountId IS NULL) OR accountId = :accountId)
        ORDER BY createdAt DESC, id DESC
        """,
    )
    fun observeByScope(serverOrigin: String, accountId: String?): Flow<List<TransferTaskEntity>>

    @Query(
        """
        SELECT * FROM transfer_tasks
        WHERE serverOrigin = :serverOrigin
          AND ((:accountId IS NULL AND accountId IS NULL) OR accountId = :accountId)
        ORDER BY createdAt DESC, id DESC
        """,
    )
    suspend fun listByScope(serverOrigin: String, accountId: String?): List<TransferTaskEntity>

    @Query("SELECT * FROM transfer_tasks ORDER BY createdAt DESC, id DESC")
    suspend fun listAll(): List<TransferTaskEntity>

    @Query("SELECT * FROM transfer_tasks WHERE id = :id LIMIT 1")
    suspend fun getById(id: String): TransferTaskEntity?

    @Query("SELECT * FROM transfer_tasks WHERE status = :status")
    suspend fun listByStatus(status: String): List<TransferTaskEntity>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(entity: TransferTaskEntity)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertAll(entities: List<TransferTaskEntity>)

    @Query(
        """
        UPDATE transfer_tasks
        SET status = :status,
            errorMessage = :errorMessage,
            updatedAt = :updatedAt
        WHERE id = :id
        """,
    )
    suspend fun updateStatus(id: String, status: String, errorMessage: String?, updatedAt: Long)

    @Query(
        """
        UPDATE transfer_tasks
        SET remoteUploadId = :remoteUploadId,
            chunkSize = :chunkSize,
            completedChunks = :completedChunks,
            transferredBytes = :transferredBytes,
            updatedAt = :updatedAt
        WHERE id = :id
        """,
    )
    suspend fun updateUploadSession(
        id: String,
        remoteUploadId: String?,
        chunkSize: Int,
        completedChunks: String,
        transferredBytes: Long,
        updatedAt: Long,
    )

    @Query(
        """
        UPDATE transfer_tasks
        SET transferredBytes = :transferredBytes,
            completedChunks = :completedChunks,
            updatedAt = :updatedAt
        WHERE id = :id
        """,
    )
    suspend fun updateProgress(
        id: String,
        transferredBytes: Long,
        completedChunks: String,
        updatedAt: Long,
    )

    @Query(
        """
        UPDATE transfer_tasks
        SET fileName = :fileName,
            mimeType = :mimeType,
            totalBytes = :totalBytes,
            updatedAt = :updatedAt
        WHERE id = :id
        """,
    )
    suspend fun updateFileMetadata(
        id: String,
        fileName: String,
        mimeType: String,
        totalBytes: Long,
        updatedAt: Long,
    )

    @Query(
        """
        UPDATE transfer_tasks
        SET status = :status,
            transferredBytes = :transferredBytes,
            localResultUri = :localResultUri,
            remoteUploadId = NULL,
            localStagedPath = NULL,
            errorMessage = NULL,
            updatedAt = :updatedAt
        WHERE id = :id
        """,
    )
    suspend fun markSucceeded(
        id: String,
        status: String,
        transferredBytes: Long,
        localResultUri: String?,
        updatedAt: Long,
    )

    @Query(
        """
        UPDATE transfer_tasks
        SET accountId = :newAccountId,
            updatedAt = :updatedAt
        WHERE serverOrigin = :serverOrigin AND accountId = :oldAccountId
        """,
    )
    suspend fun reassignAccountId(
        serverOrigin: String,
        oldAccountId: String,
        newAccountId: String,
        updatedAt: Long,
    )

    @Query(
        """
        DELETE FROM transfer_tasks
        WHERE serverOrigin = :serverOrigin
          AND ((:accountId IS NULL AND accountId IS NULL) OR accountId = :accountId)
          AND status IN ('SUCCEEDED', 'CANCELLED')
        """,
    )
    suspend fun deleteCompletedForScope(serverOrigin: String, accountId: String?)

    @Query(
        """
        DELETE FROM transfer_tasks
        WHERE serverOrigin = :serverOrigin
          AND ((:accountId IS NULL AND accountId IS NULL) OR accountId = :accountId)
        """,
    )
    suspend fun deleteByScope(serverOrigin: String, accountId: String?)

    @Query("DELETE FROM transfer_tasks WHERE id = :id")
    suspend fun deleteById(id: String)

    @Query("DELETE FROM transfer_tasks")
    suspend fun deleteAll()
}
