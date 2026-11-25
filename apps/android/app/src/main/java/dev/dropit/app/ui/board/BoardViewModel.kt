package dev.dropit.app.ui.board

import android.net.Uri
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import dev.dropit.app.core.network.ApiError
import dev.dropit.app.core.network.ApiErrorCode
import dev.dropit.app.core.network.ClipItem
import dev.dropit.app.core.network.GroupInfo
import dev.dropit.app.core.network.MeResponse
import dev.dropit.app.core.network.OptionalField
import dev.dropit.app.core.network.RoomInfo
import dev.dropit.app.core.network.SessionExpiredEvent
import dev.dropit.app.core.network.Space
import dev.dropit.app.core.network.TargetScope
import dev.dropit.app.core.network.WsEvent
import dev.dropit.app.core.realtime.BoardSnapshotState
import dev.dropit.app.core.realtime.ConnectionState
import dev.dropit.app.core.realtime.RealtimeClient
import dev.dropit.app.core.repository.BoardRepository
import dev.dropit.app.core.repository.DownloadFileRequest
import dev.dropit.app.core.repository.SpaceRepository
import dev.dropit.app.core.repository.TransferManager
import dev.dropit.app.core.repository.UploadFileRequest
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

sealed class GroupFilter {
    data object All : GroupFilter()
    data class Named(val name: String) : GroupFilter()
    data object Ungrouped : GroupFilter()
}

enum class ContentTypeFilter(val label: String) {
    ALL("全部"),
    TEXT("文本"),
    FILES("文件"),
}

data class BoardSnackbar(
    val message: String,
    val showTransfersAction: Boolean = false,
)

data class BoardUiState(
    val isLoadingInitial: Boolean = true,
    val isRefreshing: Boolean = false,
    val offlineBannerMessage: String? = null,
    val me: MeResponse? = null,
    val spaces: List<Space> = emptyList(),
    val activeSpace: Space? = null,
    val activeRoom: RoomInfo? = null,
    val isRoomOwner: Boolean = false,
    val activeScope: TargetScope? = null,
    val connectionState: ConnectionState = ConnectionState.DISCONNECTED,
    val presenceDevices: Int = 0,
    val allItems: List<ClipItem> = emptyList(),
    val groups: List<String> = emptyList(),
    val hasSnapshot: Boolean = false,
    val selectedGroupFilter: GroupFilter = GroupFilter.All,
    val selectedKindFilter: ContentTypeFilter = ContentTypeFilter.ALL,
    val isSearchExpanded: Boolean = false,
    val searchQuery: String = "",
    val copiedItemId: String? = null,
    val isSendingText: Boolean = false,
    val isMutatingItem: Boolean = false,
    val composerDraft: String = "",
    val snackbar: BoardSnackbar? = null,
    val sessionExpired: Boolean = false,
) {
    val isReadOnly: Boolean
        get() = activeRoom == null && activeSpace?.isReadOnly == true

    val groupInfos: List<GroupInfo>
        get() {
            val counts = allItems.groupingBy { it.group }.eachCount()
            return groups.map { name -> GroupInfo(name = name, itemCount = counts[name] ?: 0) }
        }

    val ungroupedCount: Int
        get() = allItems.count { it.group.isNullOrBlank() }

    val filteredItems: List<ClipItem>
        get() {
            val query = searchQuery.trim().lowercase()
            return allItems.filter { item ->
                val matchesKind = when (selectedKindFilter) {
                    ContentTypeFilter.ALL -> true
                    ContentTypeFilter.TEXT -> item.isText
                    ContentTypeFilter.FILES -> item.isFile
                }
                if (!matchesKind) return@filter false

                val matchesGroup = when (val gf = selectedGroupFilter) {
                    GroupFilter.All -> true
                    GroupFilter.Ungrouped -> item.group.isNullOrBlank()
                    is GroupFilter.Named -> item.group == gf.name
                }
                if (!matchesGroup) return@filter false

                if (query.isEmpty()) return@filter true
                val haystacks = buildList {
                    item.text?.let { add(it) }
                    item.filename?.let { add(it) }
                    item.group?.let { add(it) }
                    addAll(item.tags)
                }
                haystacks.any { it.lowercase().contains(query) }
            }
        }

    val pinnedItems: List<ClipItem>
        get() = filteredItems.filter { it.pinned }

    val defaultTargetGroup: String?
        get() = (selectedGroupFilter as? GroupFilter.Named)?.name
}

/**
 * Thin UI-scoped bridge over [RealtimeClient] so [BoardViewModel] can be unit-tested deterministically
 * while keeping production binding zero-overhead.
 */
interface BoardRealtimeBridge {
    val connectionState: StateFlow<ConnectionState>
    val boardState: StateFlow<BoardSnapshotState>

    fun connect(targetScope: TargetScope)
    fun disconnect(clearState: Boolean = false)
    fun reconnectNow()
    fun onAppBackground()
    fun onAppForeground()
    fun applyLocalSnapshot(targetScope: TargetScope, snapshot: WsEvent.Snapshot)
}

class RealtimeClientBridge(
    private val client: RealtimeClient,
) : BoardRealtimeBridge {
    override val connectionState: StateFlow<ConnectionState> get() = client.connectionState
    override val boardState: StateFlow<BoardSnapshotState> get() = client.boardState

    override fun connect(targetScope: TargetScope) = client.connect(targetScope)
    override fun disconnect(clearState: Boolean) = client.disconnect(clearState)
    override fun reconnectNow() = client.reconnectNow()
    override fun onAppBackground() = client.onAppBackground()
    override fun onAppForeground() = client.onAppForeground()
    override fun applyLocalSnapshot(targetScope: TargetScope, snapshot: WsEvent.Snapshot) =
        client.applyLocalSnapshot(targetScope, snapshot)
}

class BoardViewModel(
    private val spaceRepository: SpaceRepository,
    private val boardRepository: BoardRepository,
    private val realtimeBridge: BoardRealtimeBridge,
    private val transferManager: TransferManager,
    private val sessionExpiredEvents: Flow<SessionExpiredEvent>,
    private val onSessionExpired: () -> Unit = {},
    private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
    autoLoad: Boolean = true,
) : ViewModel() {

    constructor(
        spaceRepository: SpaceRepository,
        boardRepository: BoardRepository,
        realtimeClient: RealtimeClient,
        transferManager: TransferManager,
        sessionExpiredEvents: Flow<SessionExpiredEvent>,
        onSessionExpired: () -> Unit = {},
        autoLoad: Boolean = true,
    ) : this(
        spaceRepository = spaceRepository,
        boardRepository = boardRepository,
        realtimeBridge = RealtimeClientBridge(realtimeClient),
        transferManager = transferManager,
        sessionExpiredEvents = sessionExpiredEvents,
        onSessionExpired = onSessionExpired,
        autoLoad = autoLoad,
    )

    private val _uiState = MutableStateFlow(BoardUiState())
    val uiState: StateFlow<BoardUiState> = _uiState.asStateFlow()

    private var activeSessionKey: String? = null
    private var loadJob: Job? = null
    private var copiedClearJob: Job? = null
    private var sessionExpiredHandled = false

    init {
        observeRealtime()
        observeSessionExpired()
        if (autoLoad) {
            loadInitial()
        }
    }

    /**
     * Activates a fresh authenticated session (identified by `<serverOrigin>#<sessionGeneration>`).
     * Ensures that re-authenticating to the same server after a 401 or logout cleanly resets
     * expired state, reloads spaces/snapshot, reconnects WebSocket, and re-arms 401 handling.
     */
    fun activateSession(sessionKey: String) {
        if (activeSessionKey == sessionKey && !_uiState.value.sessionExpired) {
            return
        }
        activeSessionKey = sessionKey
        sessionExpiredHandled = false
        loadJob?.cancel()
        copiedClearJob?.cancel()
        _uiState.value = BoardUiState()
        loadInitial()
    }

    private fun observeRealtime() {
        viewModelScope.launch {
            realtimeBridge.connectionState.collect { connState ->
                _uiState.update { current ->
                    val offlineMsg = when (connState) {
                        ConnectionState.CONNECTED -> null
                        ConnectionState.UNAUTHORIZED -> null
                        else -> current.offlineBannerMessage
                    }
                    current.copy(
                        connectionState = connState,
                        offlineBannerMessage = offlineMsg,
                    )
                }
            }
        }

        viewModelScope.launch {
            realtimeBridge.boardState.collect { snap ->
                _uiState.update { current ->
                    val expectedScope = current.activeScope
                    if (expectedScope != null && snap.scope != null && snap.scope != expectedScope) {
                        return@update current
                    }
                    val nextGroupFilter = when (val gf = current.selectedGroupFilter) {
                        is GroupFilter.Named -> if (gf.name in snap.groups) gf else GroupFilter.All
                        else -> gf
                    }
                    current.copy(
                        allItems = snap.items.sortedWith(ITEM_COMPARATOR),
                        groups = snap.groups,
                        presenceDevices = snap.presenceDevices,
                        hasSnapshot = snap.hasSnapshot,
                        selectedGroupFilter = nextGroupFilter,
                    )
                }
            }
        }
    }

    private fun observeSessionExpired() {
        viewModelScope.launch {
            sessionExpiredEvents.collect {
                handleSessionExpired()
            }
        }
    }

    fun loadInitial() {
        loadJob?.cancel()
        loadJob = viewModelScope.launch {
            _uiState.update {
                it.copy(
                    isLoadingInitial = it.activeSpace == null,
                    isRefreshing = it.activeSpace != null,
                    offlineBannerMessage = null,
                )
            }
            try {
                val (me, spaces) = withContext(ioDispatcher) {
                    coroutineScope {
                        val meDeferred = async { spaceRepository.getMe() }
                        val spacesDeferred = async { spaceRepository.getSpaces() }
                        meDeferred.await() to spacesDeferred.await()
                    }
                }
                val currentActiveId = _uiState.value.activeSpace?.id
                val targetSpace = spaces.firstOrNull { it.id == currentActiveId }
                    ?: spaceRepository.pickDefaultSpace(spaces, me.user.id)

                val targetScope = targetSpace?.let { TargetScope.SpaceScope(it.id) }
                _uiState.update {
                    it.copy(
                        isLoadingInitial = false,
                        isRefreshing = false,
                        offlineBannerMessage = null,
                        me = me,
                        spaces = spaces,
                        activeSpace = targetSpace,
                        activeScope = targetScope,
                    )
                }
                if (targetScope != null) {
                    connectAndHydrateScope(targetScope)
                }
            } catch (e: ApiError) {
                if (e.isUnauthorized) {
                    handleSessionExpired()
                    return@launch
                }
                _uiState.update {
                    it.copy(
                        isLoadingInitial = false,
                        isRefreshing = false,
                        offlineBannerMessage = if (e.errorCode == ApiErrorCode.NETWORK_ERROR) {
                            "当前处于离线状态，无法连接服务器"
                        } else {
                            e.userMessage
                        },
                    )
                }
            } catch (_: Exception) {
                _uiState.update {
                    it.copy(
                        isLoadingInitial = false,
                        isRefreshing = false,
                        offlineBannerMessage = "当前处于离线状态，无法连接服务器",
                    )
                }
            }
        }
    }

    private suspend fun connectAndHydrateScope(scope: TargetScope) {
        realtimeBridge.connect(scope)
        try {
            val snapshot = withContext(ioDispatcher) {
                boardRepository.fetchSnapshot(scope)
            }
            if (_uiState.value.activeScope == scope) {
                realtimeBridge.applyLocalSnapshot(scope, snapshot)
            }
        } catch (e: ApiError) {
            if (e.isUnauthorized) {
                handleSessionExpired()
            } else if (e.errorCode == ApiErrorCode.NETWORK_ERROR) {
                _uiState.update { it.copy(offlineBannerMessage = "当前处于离线状态，无法同步最新内容") }
            }
        } catch (_: Exception) {
            // Keep UI responsive; WS reconnect loop will recover once network returns.
        }
    }

    fun selectSpace(spaceId: String) {
        val target = _uiState.value.spaces.firstOrNull { it.id == spaceId } ?: return
        if (_uiState.value.activeRoom == null && _uiState.value.activeSpace?.id == target.id) return
        val scope = TargetScope.SpaceScope(target.id)
        _uiState.update {
            it.copy(
                activeSpace = target,
                activeRoom = null,
                isRoomOwner = false,
                activeScope = scope,
                allItems = emptyList(),
                groups = emptyList(),
                hasSnapshot = false,
                selectedGroupFilter = GroupFilter.All,
                selectedKindFilter = ContentTypeFilter.ALL,
                isSearchExpanded = false,
                searchQuery = "",
                offlineBannerMessage = null,
            )
        }
        viewModelScope.launch {
            connectAndHydrateScope(scope)
        }
    }

    fun enterTemporaryRoom(room: RoomInfo, isOwner: Boolean) {
        val scope = TargetScope.RoomScope(room.token)
        _uiState.update {
            it.copy(
                activeRoom = room,
                isRoomOwner = isOwner,
                activeScope = scope,
                allItems = emptyList(),
                groups = emptyList(),
                hasSnapshot = false,
                selectedGroupFilter = GroupFilter.All,
                selectedKindFilter = ContentTypeFilter.ALL,
                isSearchExpanded = false,
                searchQuery = "",
                offlineBannerMessage = null,
                snackbar = BoardSnackbar("已进入临时房间 ${room.code ?: room.token.take(6)}"),
            )
        }
        viewModelScope.launch {
            connectAndHydrateScope(scope)
        }
    }

    fun updateActiveRoom(room: RoomInfo) {
        val current = _uiState.value
        if (current.activeRoom == null) return
        val nextScope = TargetScope.RoomScope(room.token)
        val scopeChanged = current.activeScope != nextScope
        _uiState.update {
            it.copy(
                activeRoom = room,
                activeScope = nextScope,
            )
        }
        if (scopeChanged) {
            viewModelScope.launch {
                connectAndHydrateScope(nextScope)
            }
        }
    }

    fun leaveTemporaryRoom() {
        val current = _uiState.value
        if (current.activeRoom == null) return
        val fallbackSpace = current.activeSpace
            ?: current.me?.let { spaceRepository.pickDefaultSpace(current.spaces, it.user.id) }
            ?: current.spaces.firstOrNull()
        val nextScope = fallbackSpace?.let { TargetScope.SpaceScope(it.id) }
        _uiState.update {
            it.copy(
                activeRoom = null,
                isRoomOwner = false,
                activeSpace = fallbackSpace,
                activeScope = nextScope,
                allItems = emptyList(),
                groups = emptyList(),
                hasSnapshot = false,
                selectedGroupFilter = GroupFilter.All,
                selectedKindFilter = ContentTypeFilter.ALL,
                isSearchExpanded = false,
                searchQuery = "",
                offlineBannerMessage = null,
            )
        }
        if (nextScope != null) {
            viewModelScope.launch {
                connectAndHydrateScope(nextScope)
            }
        } else {
            loadInitial()
        }
    }

    fun reconnectRealtime() {
        val scope = _uiState.value.activeScope
        if (scope == null) {
            loadInitial()
            return
        }
        _uiState.update { it.copy(offlineBannerMessage = null) }
        realtimeBridge.reconnectNow()
        viewModelScope.launch {
            try {
                val snapshot = withContext(ioDispatcher) {
                    boardRepository.fetchSnapshot(scope)
                }
                if (_uiState.value.activeScope == scope) {
                    realtimeBridge.applyLocalSnapshot(scope, snapshot)
                }
            } catch (e: ApiError) {
                if (e.isUnauthorized) {
                    handleSessionExpired()
                } else if (e.errorCode == ApiErrorCode.NETWORK_ERROR) {
                    _uiState.update { it.copy(offlineBannerMessage = "仍无法连接服务器，请检查网络") }
                }
            } catch (_: Exception) {
                _uiState.update { it.copy(offlineBannerMessage = "仍无法连接服务器，请检查网络") }
            }
        }
    }

    fun onForeground() {
        if (_uiState.value.sessionExpired) return
        realtimeBridge.onAppForeground()
    }

    fun onBackground() {
        realtimeBridge.onAppBackground()
    }

    fun setSearchExpanded(expanded: Boolean) {
        _uiState.update {
            it.copy(
                isSearchExpanded = expanded,
                searchQuery = if (expanded) it.searchQuery else "",
            )
        }
    }

    fun setSearchQuery(query: String) {
        _uiState.update { it.copy(searchQuery = query) }
    }

    fun selectGroupFilter(filter: GroupFilter) {
        _uiState.update { it.copy(selectedGroupFilter = filter) }
    }

    fun selectKindFilter(filter: ContentTypeFilter) {
        _uiState.update { it.copy(selectedKindFilter = filter) }
    }

    fun updateComposerDraft(text: String) {
        _uiState.update { it.copy(composerDraft = text) }
    }

    fun markItemCopied(itemId: String) {
        copiedClearJob?.cancel()
        _uiState.update { it.copy(copiedItemId = itemId) }
        showSnackbar("已复制到剪贴板")
        copiedClearJob = viewModelScope.launch {
            delay(1_600L)
            _uiState.update { if (it.copiedItemId == itemId) it.copy(copiedItemId = null) else it }
        }
    }

    fun sendText(
        rawText: String,
        targetGroup: String? = _uiState.value.defaultTargetGroup,
        onSuccess: () -> Unit = {},
    ) {
        if (!requireWritableScope()) return
        val scope = _uiState.value.activeScope ?: return
        val text = rawText.trim()
        if (text.isEmpty()) {
            showSnackbar("内容不能为空")
            return
        }
        val maxBytes = _uiState.value.me?.maxTextBytes ?: 0L
        if (maxBytes > 0L && ClipFormatting.utf8ByteCount(text) > maxBytes) {
            showSnackbar("文本超出单条上限（${maxBytes / 1024} KB）")
            return
        }

        _uiState.update { it.copy(isSendingText = true) }
        viewModelScope.launch {
            try {
                val created = withContext(ioDispatcher) {
                    boardRepository.createText(scope, text, group = targetGroup)
                }
                _uiState.update { current ->
                    val merged = (current.allItems.filterNot { it.id == created.id } + created)
                        .sortedWith(ITEM_COMPARATOR)
                    current.copy(
                        isSendingText = false,
                        composerDraft = "",
                        allItems = merged,
                        snackbar = BoardSnackbar("已发送"),
                    )
                }
                onSuccess()
            } catch (e: ApiError) {
                _uiState.update { it.copy(isSendingText = false) }
                handleMutationError(e)
            } catch (_: Exception) {
                _uiState.update { it.copy(isSendingText = false) }
                showSnackbar("发送失败，请重试")
            }
        }
    }

    /**
     * Triggered strictly by an explicit foreground user tap on "从剪贴板发送" (Android 10+ compliant).
     */
    fun sendFromClipboard(clipboardText: String?) {
        if (!requireWritableScope()) return
        val text = clipboardText?.trim().orEmpty()
        if (text.isEmpty()) {
            showSnackbar("剪贴板为空或不包含可发送的文本")
            return
        }
        sendText(rawText = text, targetGroup = _uiState.value.defaultTargetGroup)
    }

    fun enqueueFileUploads(requests: List<UploadFileRequest>) {
        if (!requireWritableScope()) return
        if (requests.isEmpty()) return
        viewModelScope.launch {
            try {
                val ids = withContext(ioDispatcher) {
                    transferManager.enqueueUploads(requests)
                }
                val count = if (ids.isNotEmpty()) ids.size else requests.size
                _uiState.update {
                    it.copy(
                        snackbar = BoardSnackbar(
                            message = "已将 $count 个文件加入传输队列",
                            showTransfersAction = true,
                        ),
                    )
                }
            } catch (e: ApiError) {
                handleMutationError(e)
            } catch (e: Exception) {
                showSnackbar(e.message?.takeIf { it.isNotBlank() } ?: "加入上传队列失败")
            }
        }
    }

    fun downloadItem(item: ClipItem) {
        val scope = _uiState.value.activeScope ?: return
        viewModelScope.launch {
            try {
                withContext(ioDispatcher) {
                    transferManager.enqueueDownload(
                        DownloadFileRequest(
                            item = item,
                            targetScope = scope,
                            shareAfterDownload = false,
                        ),
                    )
                }
                _uiState.update {
                    it.copy(
                        snackbar = BoardSnackbar(
                            message = "已开始保存「${ClipFormatting.middleEllipsizeFilename(item.filename ?: "文件", 20)}」",
                            showTransfersAction = true,
                        ),
                    )
                }
            } catch (e: ApiError) {
                handleMutationError(e)
            } catch (e: Exception) {
                showSnackbar(e.message?.takeIf { it.isNotBlank() } ?: "下载启动失败")
            }
        }
    }

    fun prepareFileForShare(item: ClipItem, onReady: (Uri) -> Unit) {
        val scope = _uiState.value.activeScope ?: return
        viewModelScope.launch {
            val result = withContext(ioDispatcher) {
                transferManager.downloadForShare(item, scope)
            }
            result.onSuccess { uri ->
                // Runs on Main thread so callers can safely invoke startActivity / Toast.
                onReady(uri)
            }.onFailure { err ->
                if (err is ApiError && err.isUnauthorized) {
                    handleSessionExpired()
                } else {
                    showSnackbar("文件暂无法分享：${err.message ?: "传输引擎将在合入后就绪"}")
                }
            }
        }
    }

    fun editText(itemId: String, newText: String, onSuccess: () -> Unit = {}) {
        if (!requireWritableScope()) return
        val scope = _uiState.value.activeScope ?: return
        val trimmed = newText.trim()
        if (trimmed.isEmpty()) {
            showSnackbar("内容不能为空")
            return
        }
        val maxBytes = _uiState.value.me?.maxTextBytes ?: 0L
        if (maxBytes > 0L && ClipFormatting.utf8ByteCount(trimmed) > maxBytes) {
            showSnackbar("文本超出单条上限（${maxBytes / 1024} KB）")
            return
        }

        _uiState.update { it.copy(isMutatingItem = true) }
        viewModelScope.launch {
            try {
                val updated = withContext(ioDispatcher) {
                    boardRepository.editText(scope, itemId, trimmed)
                }
                _uiState.update { current ->
                    val merged = (current.allItems.filterNot { it.id == updated.id } + updated)
                        .sortedWith(ITEM_COMPARATOR)
                    current.copy(
                        isMutatingItem = false,
                        allItems = merged,
                        snackbar = BoardSnackbar("已保存修改"),
                    )
                }
                onSuccess()
            } catch (e: ApiError) {
                _uiState.update { it.copy(isMutatingItem = false) }
                handleMutationError(e)
            } catch (_: Exception) {
                _uiState.update { it.copy(isMutatingItem = false) }
                showSnackbar("保存失败，请重试")
            }
        }
    }

    fun togglePin(item: ClipItem) {
        if (!requireWritableScope()) return
        val scope = _uiState.value.activeScope ?: return
        val nextPinned = !item.pinned
        _uiState.update { it.copy(isMutatingItem = true) }
        viewModelScope.launch {
            try {
                val updated = withContext(ioDispatcher) {
                    boardRepository.setPinned(scope, item.id, nextPinned)
                }
                _uiState.update { current ->
                    val merged = (current.allItems.filterNot { it.id == updated.id } + updated)
                        .sortedWith(ITEM_COMPARATOR)
                    current.copy(
                        isMutatingItem = false,
                        allItems = merged,
                        snackbar = BoardSnackbar(if (nextPinned) "已置顶" else "已取消置顶"),
                    )
                }
            } catch (e: ApiError) {
                _uiState.update { it.copy(isMutatingItem = false) }
                handleMutationError(e)
            } catch (_: Exception) {
                _uiState.update { it.copy(isMutatingItem = false) }
                showSnackbar("置顶状态更新失败")
            }
        }
    }

    fun updateItemLabels(
        itemId: String,
        group: OptionalField<String?>,
        tags: List<String>,
        onSuccess: () -> Unit = {},
    ) {
        if (!requireWritableScope()) return
        val scope = _uiState.value.activeScope ?: return
        val cleanTags = tags.map { it.trim() }.filter { it.isNotEmpty() }.distinct()
        _uiState.update { it.copy(isMutatingItem = true) }
        viewModelScope.launch {
            try {
                val updated = withContext(ioDispatcher) {
                    boardRepository.updateLabels(
                        scope = scope,
                        itemId = itemId,
                        tags = cleanTags,
                        group = group,
                    )
                }
                _uiState.update { current ->
                    val merged = (current.allItems.filterNot { it.id == updated.id } + updated)
                        .sortedWith(ITEM_COMPARATOR)
                    current.copy(
                        isMutatingItem = false,
                        allItems = merged,
                        snackbar = BoardSnackbar("已更新分组与标签"),
                    )
                }
                onSuccess()
            } catch (e: ApiError) {
                _uiState.update { it.copy(isMutatingItem = false) }
                handleMutationError(e)
            } catch (_: Exception) {
                _uiState.update { it.copy(isMutatingItem = false) }
                showSnackbar("更新分组与标签失败")
            }
        }
    }

    fun retractItem(itemId: String, onSuccess: () -> Unit = {}) {
        if (!requireWritableScope()) return
        val scope = _uiState.value.activeScope ?: return
        _uiState.update { it.copy(isMutatingItem = true) }
        viewModelScope.launch {
            try {
                withContext(ioDispatcher) {
                    boardRepository.retractItem(scope, itemId)
                }
                _uiState.update { current ->
                    current.copy(
                        isMutatingItem = false,
                        allItems = current.allItems.filterNot { it.id == itemId },
                        snackbar = BoardSnackbar("已撤回内容"),
                    )
                }
                onSuccess()
            } catch (e: ApiError) {
                _uiState.update { it.copy(isMutatingItem = false) }
                handleMutationError(e)
            } catch (_: Exception) {
                _uiState.update { it.copy(isMutatingItem = false) }
                showSnackbar("撤回失败，请重试")
            }
        }
    }

    fun createGroup(rawName: String, onSuccess: () -> Unit = {}) {
        if (!requireWritableScope()) return
        val scope = _uiState.value.activeScope ?: return
        val validationError = ClipFormatting.validateGroupName(rawName, _uiState.value.groups)
        if (validationError != null) {
            showSnackbar(validationError)
            return
        }
        val cleanName = rawName.trim()
        viewModelScope.launch {
            try {
                val updatedGroups = withContext(ioDispatcher) {
                    boardRepository.createGroup(scope, cleanName)
                }
                _uiState.update {
                    it.copy(
                        groups = updatedGroups,
                        selectedGroupFilter = GroupFilter.Named(cleanName),
                        snackbar = BoardSnackbar("已创建分组「$cleanName」"),
                    )
                }
                onSuccess()
            } catch (e: ApiError) {
                handleMutationError(e)
            } catch (_: Exception) {
                showSnackbar("创建分组失败")
            }
        }
    }

    fun renameGroup(oldName: String, rawNewName: String, onSuccess: () -> Unit = {}) {
        if (!requireWritableScope()) return
        val scope = _uiState.value.activeScope ?: return
        val validationError = ClipFormatting.validateGroupName(
            rawName = rawNewName,
            existingGroups = _uiState.value.groups,
            renamingFrom = oldName,
        )
        if (validationError != null) {
            showSnackbar(validationError)
            return
        }
        val cleanName = rawNewName.trim()
        viewModelScope.launch {
            try {
                val updatedGroups = withContext(ioDispatcher) {
                    boardRepository.renameGroup(scope, oldName, cleanName)
                }
                _uiState.update { current ->
                    val updatedItems = current.allItems.map { item ->
                        if (item.group == oldName) item.copy(group = cleanName) else item
                    }
                    val nextFilter = if (current.selectedGroupFilter == GroupFilter.Named(oldName)) {
                        GroupFilter.Named(cleanName)
                    } else {
                        current.selectedGroupFilter
                    }
                    current.copy(
                        groups = updatedGroups,
                        allItems = updatedItems,
                        selectedGroupFilter = nextFilter,
                        snackbar = BoardSnackbar("已重命名分组为「$cleanName」"),
                    )
                }
                onSuccess()
            } catch (e: ApiError) {
                handleMutationError(e)
            } catch (_: Exception) {
                showSnackbar("重命名分组失败")
            }
        }
    }

    fun deleteGroup(name: String, onSuccess: () -> Unit = {}) {
        if (!requireWritableScope()) return
        val scope = _uiState.value.activeScope ?: return
        viewModelScope.launch {
            try {
                val updatedGroups = withContext(ioDispatcher) {
                    boardRepository.deleteGroup(scope, name)
                }
                _uiState.update { current ->
                    val updatedItems = current.allItems.map { item ->
                        if (item.group == name) item.copy(group = null) else item
                    }
                    val nextFilter = if (current.selectedGroupFilter == GroupFilter.Named(name)) {
                        GroupFilter.All
                    } else {
                        current.selectedGroupFilter
                    }
                    current.copy(
                        groups = updatedGroups,
                        allItems = updatedItems,
                        selectedGroupFilter = nextFilter,
                        snackbar = BoardSnackbar("已删除分组「$name」"),
                    )
                }
                onSuccess()
            } catch (e: ApiError) {
                handleMutationError(e)
            } catch (_: Exception) {
                showSnackbar("删除分组失败")
            }
        }
    }

    fun showSnackbar(message: String, showTransfersAction: Boolean = false) {
        _uiState.update {
            it.copy(snackbar = BoardSnackbar(message = message, showTransfersAction = showTransfersAction))
        }
    }

    fun clearSnackbar() {
        _uiState.update { it.copy(snackbar = null) }
    }

    private fun requireWritableScope(): Boolean {
        if (_uiState.value.isReadOnly) {
            showSnackbar("当前空间为只读权限，无法修改")
            return false
        }
        if (_uiState.value.activeScope == null) {
            showSnackbar("尚未连接到可用空间")
            return false
        }
        return true
    }

    private fun handleMutationError(error: ApiError) {
        if (error.isUnauthorized) {
            handleSessionExpired()
            return
        }
        showSnackbar(error.userMessage)
    }

    private fun handleSessionExpired() {
        if (sessionExpiredHandled) return
        sessionExpiredHandled = true
        loadJob?.cancel()
        realtimeBridge.disconnect(clearState = false)
        _uiState.update { it.copy(sessionExpired = true, offlineBannerMessage = null) }
        onSessionExpired()
    }

    override fun onCleared() {
        loadJob?.cancel()
        copiedClearJob?.cancel()
        super.onCleared()
    }

    companion object {
        private val ITEM_COMPARATOR = compareByDescending<ClipItem> { it.pinned }
            .thenByDescending { it.createdAt }
            .thenBy { it.id }
    }

    class Factory(
        private val spaceRepository: SpaceRepository,
        private val boardRepository: BoardRepository,
        private val realtimeClient: RealtimeClient,
        private val transferManager: TransferManager,
        private val sessionExpiredEvents: Flow<SessionExpiredEvent>,
        private val onSessionExpired: () -> Unit,
    ) : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <T : ViewModel> create(modelClass: Class<T>): T {
            return BoardViewModel(
                spaceRepository = spaceRepository,
                boardRepository = boardRepository,
                realtimeClient = realtimeClient,
                transferManager = transferManager,
                sessionExpiredEvents = sessionExpiredEvents,
                onSessionExpired = onSessionExpired,
                autoLoad = false,
            ) as T
        }
    }
}
