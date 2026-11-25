package dev.dropit.app.core.repository

import android.content.Intent
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

data class StagedShareFile(
    val id: String,
    val displayName: String,
    val mimeType: String,
    val sizeBytes: Long,
    val stagedFilePath: String,
)

data class PendingShare(
    val id: String,
    val text: String? = null,
    val files: List<StagedShareFile> = emptyList(),
    val receivedAt: Long = System.currentTimeMillis(),
) {
    val isEmpty: Boolean
        get() = text.isNullOrBlank() && files.isEmpty()
}

/**
 * Decoupling contract for Android ACTION_SEND / ACTION_SEND_MULTIPLE staging (Stage 2A -> Stage 3B).
 */
interface ShareInbox {
    val pendingShare: StateFlow<PendingShare?>

    suspend fun captureIntent(intent: Intent?): Boolean
    suspend fun consumePendingShare(): PendingShare?
    suspend fun discardPendingShare()
}

class PlaceholderShareInbox : ShareInbox {
    private val _pendingShare = MutableStateFlow<PendingShare?>(null)
    override val pendingShare: StateFlow<PendingShare?> = _pendingShare.asStateFlow()

    override suspend fun captureIntent(intent: Intent?): Boolean = false

    override suspend fun consumePendingShare(): PendingShare? {
        val current = _pendingShare.value
        _pendingShare.value = null
        return current
    }

    override suspend fun discardPendingShare() {
        _pendingShare.value = null
    }
}
