package dev.dropit.app.core.repository

import android.net.Uri
import dev.dropit.app.core.network.ClipItem
import dev.dropit.app.core.network.TargetScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

enum class TransferDirection {
    UPLOAD,
    DOWNLOAD,
}

enum class TransferStatus {
    QUEUED,
    RUNNING,
    PAUSED,
    FAILED,
    SUCCEEDED,
    CANCELLED,
}

data class TransferTask(
    val id: String,
    val serverOrigin: String,
    val accountId: String? = null,
    val targetScope: TargetScope,
    val groupName: String? = null,
    val direction: TransferDirection,
    val fileName: String,
    val mimeType: String,
    val totalBytes: Long,
    val transferredBytes: Long = 0L,
    val speedBytesPerSec: Long = 0L,
    val etaSeconds: Long? = null,
    val status: TransferStatus = TransferStatus.QUEUED,
    val errorMessage: String? = null,
    val localResultUri: String? = null,
    val createdAt: Long = 0L,
    val updatedAt: Long = 0L,
) {
    val progress: Float
        get() = if (totalBytes <= 0L) 0f else (transferredBytes.toFloat() / totalBytes.toFloat()).coerceIn(0f, 1f)

    val isActive: Boolean
        get() = status == TransferStatus.QUEUED || status == TransferStatus.RUNNING

    val isTerminal: Boolean
        get() = status == TransferStatus.SUCCEEDED || status == TransferStatus.FAILED || status == TransferStatus.CANCELLED
}

data class UploadFileRequest(
    val uri: Uri,
    val fileName: String,
    val mimeType: String,
    val sizeBytes: Long,
    val targetScope: TargetScope,
    val groupName: String? = null,
)

data class DownloadFileRequest(
    val item: ClipItem,
    val targetScope: TargetScope,
    val shareAfterDownload: Boolean = false,
)

/**
 * Decoupling contract for upload/download transfer queues (implemented in Stage 2A, bound by Stage 2B/3B UI).
 */
interface TransferManager {
    val tasks: StateFlow<List<TransferTask>>
    val activeCount: StateFlow<Int>

    suspend fun enqueueUploads(requests: List<UploadFileRequest>): List<String>
    suspend fun enqueueStagedUploads(
        stagedFiles: List<StagedShareFile>,
        targetScope: TargetScope,
        groupName: String? = null,
    ): List<String>

    suspend fun enqueueDownload(request: DownloadFileRequest): String
    suspend fun downloadForShare(item: ClipItem, targetScope: TargetScope): Result<Uri>
    suspend fun cancel(taskId: String)
    suspend fun retry(taskId: String)
    suspend fun clearCompleted()
    suspend fun clearAllForScopeSwitch()
}

class PlaceholderTransferManager : TransferManager {
    private val _tasks = MutableStateFlow<List<TransferTask>>(emptyList())
    override val tasks: StateFlow<List<TransferTask>> = _tasks.asStateFlow()

    private val _activeCount = MutableStateFlow(0)
    override val activeCount: StateFlow<Int> = _activeCount.asStateFlow()

    override suspend fun enqueueUploads(requests: List<UploadFileRequest>): List<String> = emptyList()

    override suspend fun enqueueStagedUploads(
        stagedFiles: List<StagedShareFile>,
        targetScope: TargetScope,
        groupName: String?,
    ): List<String> = emptyList()

    override suspend fun enqueueDownload(request: DownloadFileRequest): String = ""

    override suspend fun downloadForShare(item: ClipItem, targetScope: TargetScope): Result<Uri> =
        Result.failure(UnsupportedOperationException("TransferManager implementation pending Stage 2A"))

    override suspend fun cancel(taskId: String) = Unit
    override suspend fun retry(taskId: String) = Unit
    override suspend fun clearCompleted() = Unit
    override suspend fun clearAllForScopeSwitch() = Unit
}
