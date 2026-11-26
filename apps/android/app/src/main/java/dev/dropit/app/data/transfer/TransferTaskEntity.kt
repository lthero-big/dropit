package dev.dropit.app.data.transfer

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey
import dev.dropit.app.core.network.TargetScope
import dev.dropit.app.core.repository.TransferDirection
import dev.dropit.app.core.repository.TransferStatus
import dev.dropit.app.core.repository.TransferTask

@Entity(
    tableName = "transfer_tasks",
    indices = [
        Index(value = ["serverOrigin", "accountId"]),
        Index(value = ["status"]),
    ],
)
data class TransferTaskEntity(
    @PrimaryKey val id: String,
    val serverOrigin: String,
    val accountId: String?,
    val targetScopeType: String,
    val targetScopeId: String,
    val groupName: String? = null,
    val direction: String,
    val fileName: String,
    val mimeType: String,
    val totalBytes: Long,
    val transferredBytes: Long = 0L,
    val remoteUploadId: String? = null,
    val chunkSize: Int = 0,
    val completedChunks: String = "",
    val localStagedPath: String? = null,
    val localResultUri: String? = null,
    val remoteItemId: String? = null,
    val shareAfterDownload: Boolean = false,
    val status: String,
    val errorMessage: String? = null,
    val createdAt: Long,
    val updatedAt: Long,
) {
    fun toTargetScope(): TargetScope = when (targetScopeType) {
        "room" -> TargetScope.RoomScope(targetScopeId)
        else -> TargetScope.SpaceScope(targetScopeId)
    }

    fun toDirection(): TransferDirection =
        runCatching { TransferDirection.valueOf(direction) }.getOrDefault(TransferDirection.UPLOAD)

    fun toStatus(): TransferStatus =
        runCatching { TransferStatus.valueOf(status) }.getOrDefault(TransferStatus.FAILED)

    fun completedChunkSet(): Set<Int> = CompletedChunksCodec.decode(completedChunks)

    fun toDomain(
        speedBytesPerSec: Long = 0L,
        etaSeconds: Long? = null,
        liveTransferredBytes: Long? = null,
    ): TransferTask {
        val domainStatus = toStatus()
        val isRunning = domainStatus == TransferStatus.RUNNING
        val effectiveTransferred = if (isRunning && liveTransferredBytes != null) {
            val merged = maxOf(transferredBytes, liveTransferredBytes)
            if (totalBytes > 0L) merged.coerceAtMost(totalBytes) else merged
        } else {
            transferredBytes
        }
        return TransferTask(
            id = id,
            serverOrigin = serverOrigin,
            accountId = accountId,
            targetScope = toTargetScope(),
            groupName = groupName,
            direction = toDirection(),
            fileName = fileName,
            mimeType = mimeType,
            totalBytes = totalBytes,
            transferredBytes = effectiveTransferred,
            speedBytesPerSec = if (isRunning) speedBytesPerSec else 0L,
            etaSeconds = if (isRunning) etaSeconds else null,
            status = domainStatus,
            errorMessage = errorMessage,
            localResultUri = localResultUri,
            remoteItemId = remoteItemId,
            shareAfterDownload = shareAfterDownload,
            createdAt = createdAt,
            updatedAt = updatedAt,
        )
    }
}

object CompletedChunksCodec {
    fun encode(chunks: Collection<Int>): String =
        chunks.filter { it >= 0 }.distinct().sorted().joinToString(",")

    fun decode(raw: String?): Set<Int> {
        if (raw.isNullOrBlank()) return emptySet()
        return raw.split(',')
            .mapNotNull { it.trim().toIntOrNull() }
            .filter { it >= 0 }
            .toSet()
    }
}
