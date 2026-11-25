package dev.dropit.app.ui.share

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import dev.dropit.app.core.network.ApiError
import dev.dropit.app.core.network.RoomInfo
import dev.dropit.app.core.network.ServerUrl
import dev.dropit.app.core.network.Space
import dev.dropit.app.core.network.TargetScope
import dev.dropit.app.core.repository.BoardRepository
import dev.dropit.app.core.repository.PendingShare
import dev.dropit.app.core.repository.ShareInbox
import dev.dropit.app.core.repository.StagedShareFile
import dev.dropit.app.core.repository.TransferManager
import dev.dropit.app.ui.board.ClipFormatting
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

sealed class ShareDestination {
    abstract val scope: TargetScope
    abstract val label: String
    abstract val badge: String

    data class SpaceDestination(
        val space: Space,
        val isPersonal: Boolean,
    ) : ShareDestination() {
        override val scope: TargetScope get() = TargetScope.SpaceScope(space.id)
        override val label: String
            get() = space.name.ifBlank { if (isPersonal) "我的空间" else "共享空间" }
        override val badge: String
            get() = if (isPersonal) "我的" else "受邀 · 可编辑"
    }

    data class RoomDestination(
        val room: RoomInfo,
    ) : ShareDestination() {
        override val scope: TargetScope get() = TargetScope.RoomScope(room.token)
        override val label: String
            get() = "临时房间 · ${room.code ?: room.token.take(6)}"
        override val badge: String = "临时房间"
    }
}

data class ShareTargetUiState(
    val pendingShare: PendingShare? = null,
    val editedText: String = "",
    val files: List<StagedShareFile> = emptyList(),
    val availableTargets: List<ShareDestination> = emptyList(),
    val excludedReadOnlyCount: Int = 0,
    val selectedTarget: ShareDestination? = null,
    val availableGroups: List<String> = emptyList(),
    val isLoadingGroups: Boolean = false,
    val selectedGroup: String? = null,
    val isSubmitting: Boolean = false,
    val errorMessage: String? = null,
) {
    val hasContentToSend: Boolean
        get() = editedText.isNotBlank() || files.isNotEmpty()

    val canSubmit: Boolean
        get() = pendingShare != null && selectedTarget != null && hasContentToSend && !isSubmitting

    val totalFileBytes: Long
        get() = files.sumOf { it.sizeBytes.coerceAtLeast(0L) }
}

class ShareTargetViewModel(
    private val shareInbox: ShareInbox,
    private val boardRepository: BoardRepository,
    private val transferManager: TransferManager,
    private val onSessionExpired: () -> Unit = {},
    private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
) : ViewModel() {

    private val _uiState = MutableStateFlow(ShareTargetUiState())
    val uiState: StateFlow<ShareTargetUiState> = _uiState.asStateFlow()

    private var boundPendingShareId: String? = null
    private val submittedShareIds = HashSet<String>()
    private var groupFetchJob: Job? = null

    init {
        observePendingShare()
    }

    private fun observePendingShare() {
        viewModelScope.launch {
            shareInbox.pendingShare.collect { incoming ->
                if (incoming == null || incoming.isEmpty) {
                    boundPendingShareId = null
                    _uiState.update {
                        it.copy(
                            pendingShare = null,
                            editedText = "",
                            files = emptyList(),
                            selectedGroup = null,
                            isSubmitting = false,
                            errorMessage = null,
                        )
                    }
                    return@collect
                }
                if (incoming.id != boundPendingShareId) {
                    boundPendingShareId = incoming.id
                    _uiState.update { current ->
                        current.copy(
                            pendingShare = incoming,
                            editedText = incoming.text.orEmpty(),
                            files = incoming.files,
                            errorMessage = null,
                            isSubmitting = false,
                        )
                    }
                    _uiState.value.selectedTarget?.let { target ->
                        fetchGroupsForScope(target.scope)
                    }
                }
            }
        }
    }

    /**
     * Synchronizes selectable writable spaces and active temporary room from Board state.
     * Read-only spaces (`role == "viewer"`) are excluded per UX spec §2.5.
     * Defaults selection to the user's personal space whenever no valid selection exists.
     */
    fun syncTargets(
        spaces: List<Space>,
        currentUserId: String?,
        activeRoom: RoomInfo?,
        knownScopeGroups: Pair<TargetScope?, List<String>> = null to emptyList(),
    ) {
        val writableSpaces = spaces.filter { it.canWrite }
        val readOnlyCount = spaces.count { it.isReadOnly }

        val sortedSpaceDestinations = writableSpaces
            .sortedByDescending { space -> currentUserId != null && space.isPersonalFor(currentUserId) }
            .map { space ->
                ShareDestination.SpaceDestination(
                    space = space,
                    isPersonal = currentUserId != null && space.isPersonalFor(currentUserId),
                )
            }

        val destinations = buildList<ShareDestination> {
            addAll(sortedSpaceDestinations)
            if (activeRoom != null && activeRoom.token.isNotBlank()) {
                add(ShareDestination.RoomDestination(activeRoom))
            }
        }

        val currentSelection = _uiState.value.selectedTarget
        val retainedSelection = currentSelection?.let { sel ->
            destinations.firstOrNull { it.scope == sel.scope }
        }
        val defaultSelection = retainedSelection
            ?: sortedSpaceDestinations.firstOrNull { it.isPersonal }
            ?: destinations.firstOrNull()

        val initialGroups = if (defaultSelection != null && knownScopeGroups.first == defaultSelection.scope) {
            knownScopeGroups.second
        } else {
            _uiState.value.availableGroups
        }
        val nextGroup = _uiState.value.selectedGroup?.takeIf { it in initialGroups }

        _uiState.update { current ->
            current.copy(
                availableTargets = destinations,
                excludedReadOnlyCount = readOnlyCount,
                selectedTarget = defaultSelection,
                availableGroups = initialGroups,
                selectedGroup = nextGroup,
            )
        }

        if (_uiState.value.pendingShare != null && defaultSelection != null && knownScopeGroups.first != defaultSelection.scope) {
            fetchGroupsForScope(defaultSelection.scope)
        }
    }

    fun selectTarget(destination: ShareDestination) {
        if (_uiState.value.selectedTarget?.scope == destination.scope) return
        _uiState.update {
            it.copy(
                selectedTarget = destination,
                selectedGroup = null,
                availableGroups = emptyList(),
                errorMessage = null,
            )
        }
        fetchGroupsForScope(destination.scope)
    }

    fun selectGroup(group: String?) {
        _uiState.update { it.copy(selectedGroup = group) }
    }

    fun updateText(text: String) {
        _uiState.update { it.copy(editedText = text, errorMessage = null) }
    }

    fun removeFile(fileId: String) {
        _uiState.update { current ->
            current.copy(
                files = current.files.filterNot { it.id == fileId },
                errorMessage = null,
            )
        }
    }

    fun cancelShare() {
        if (_uiState.value.isSubmitting) return
        groupFetchJob?.cancel()
        viewModelScope.launch {
            withContext(ioDispatcher) {
                shareInbox.discardPendingShare()
            }
        }
    }

    /**
     * Submits edited text and/or staged files once into the selected scope & group,
     * guarding against duplicate taps or re-entry for the same [PendingShare.id].
     */
    fun submitShare(
        maxTextBytes: Long = 0L,
        onSubmitted: (feedbackMessage: String, hasFiles: Boolean) -> Unit = { _, _ -> },
    ) {
        val snapshot = _uiState.value
        val pending = snapshot.pendingShare ?: return
        val target = snapshot.selectedTarget ?: return
        if (snapshot.isSubmitting) return
        if (pending.id in submittedShareIds) return

        val trimmedText = snapshot.editedText.trim()
        val selectedFiles = snapshot.files
        if (trimmedText.isEmpty() && selectedFiles.isEmpty()) {
            _uiState.update { it.copy(errorMessage = "请至少保留一段文本或一个文件") }
            return
        }
        if (maxTextBytes > 0L && trimmedText.isNotEmpty() && ClipFormatting.utf8ByteCount(trimmedText) > maxTextBytes) {
            _uiState.update {
                it.copy(errorMessage = "分享文本已超出单条上限（${ServerUrl.formatSize(maxTextBytes)}），请精简后再发送")
            }
            return
        }

        submittedShareIds.add(pending.id)
        _uiState.update { it.copy(isSubmitting = true, errorMessage = null) }

        viewModelScope.launch {
            var textSent = false
            var filesEnqueued = 0
            try {
                withContext(ioDispatcher) {
                    if (trimmedText.isNotEmpty()) {
                        boardRepository.createText(
                            scope = target.scope,
                            text = trimmedText,
                            group = snapshot.selectedGroup,
                        )
                        textSent = true
                    }
                    if (selectedFiles.isNotEmpty()) {
                        val ids = transferManager.enqueueStagedUploads(
                            stagedFiles = selectedFiles,
                            targetScope = target.scope,
                            groupName = snapshot.selectedGroup,
                        )
                        filesEnqueued = if (ids.isNotEmpty()) ids.size else selectedFiles.size
                    }
                    shareInbox.consumePendingShare()
                }
                val message = when {
                    textSent && filesEnqueued > 0 -> "文本已发送，且 $filesEnqueued 个文件已加入传输队列"
                    filesEnqueued > 0 -> "已将 $filesEnqueued 个分享文件加入传输队列"
                    else -> "分享文本已发送至「${target.label}」"
                }
                _uiState.update { it.copy(isSubmitting = false) }
                onSubmitted(message, filesEnqueued > 0)
            } catch (e: ApiError) {
                // If text succeeded before file enqueue failed, strip already-sent text so retrying
                // only retries the remaining unsent files without creating duplicate text items.
                if (filesEnqueued == 0) {
                    submittedShareIds.remove(pending.id)
                }
                _uiState.update { current ->
                    current.copy(
                        isSubmitting = false,
                        editedText = if (textSent) "" else current.editedText,
                        errorMessage = if (textSent) {
                            "文本已发送，但文件加入队列失败：${e.userMessage}（点击确认发送可重试文件）"
                        } else {
                            e.userMessage
                        },
                    )
                }
                if (e.isUnauthorized) {
                    onSessionExpired()
                }
            } catch (e: Exception) {
                if (filesEnqueued == 0) {
                    submittedShareIds.remove(pending.id)
                }
                val detail = e.message?.takeIf { m -> m.isNotBlank() } ?: "发送分享内容失败，请重试"
                _uiState.update { current ->
                    current.copy(
                        isSubmitting = false,
                        editedText = if (textSent) "" else current.editedText,
                        errorMessage = if (textSent) {
                            "文本已发送，但文件加入队列失败：$detail（点击确认发送可重试文件）"
                        } else {
                            detail
                        },
                    )
                }
            }
        }
    }

    private fun fetchGroupsForScope(scope: TargetScope) {
        groupFetchJob?.cancel()
        groupFetchJob = viewModelScope.launch {
            _uiState.update { it.copy(isLoadingGroups = true) }
            val fetched = runCatching {
                withContext(ioDispatcher) {
                    boardRepository.getGroups(scope)
                }
            }.getOrDefault(emptyList())
            _uiState.update { current ->
                if (current.selectedTarget?.scope != scope) {
                    current.copy(isLoadingGroups = false)
                } else {
                    current.copy(
                        availableGroups = fetched,
                        selectedGroup = current.selectedGroup?.takeIf { it in fetched },
                        isLoadingGroups = false,
                    )
                }
            }
        }
    }

    override fun onCleared() {
        groupFetchJob?.cancel()
        super.onCleared()
    }

    class Factory(
        private val shareInbox: ShareInbox,
        private val boardRepository: BoardRepository,
        private val transferManager: TransferManager,
        private val onSessionExpired: () -> Unit,
    ) : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <T : ViewModel> create(modelClass: Class<T>): T {
            return ShareTargetViewModel(
                shareInbox = shareInbox,
                boardRepository = boardRepository,
                transferManager = transferManager,
                onSessionExpired = onSessionExpired,
            ) as T
        }
    }
}
