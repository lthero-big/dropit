package dev.dropit.app.ui.board

import android.net.Uri
import dev.dropit.app.core.network.ApiError
import dev.dropit.app.core.network.ClipItem
import dev.dropit.app.core.network.GroupInfo
import dev.dropit.app.core.network.MeResponse
import dev.dropit.app.core.network.OptionalField
import dev.dropit.app.core.network.ScopeDetails
import dev.dropit.app.core.network.SessionExpiredEvent
import dev.dropit.app.core.network.Space
import dev.dropit.app.core.network.TargetScope
import dev.dropit.app.core.network.User
import dev.dropit.app.core.network.WsEvent
import dev.dropit.app.core.realtime.BoardSnapshotState
import dev.dropit.app.core.realtime.BoardStateReducer
import dev.dropit.app.core.realtime.ConnectionState
import dev.dropit.app.core.repository.BoardRepository
import dev.dropit.app.core.repository.DownloadFileRequest
import dev.dropit.app.core.repository.SpaceRepository
import dev.dropit.app.core.repository.StagedShareFile
import dev.dropit.app.core.repository.TransferManager
import dev.dropit.app.core.repository.TransferTask
import dev.dropit.app.core.repository.UploadFileRequest
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

@OptIn(ExperimentalCoroutinesApi::class)
class BoardViewModelTest {

    private val testDispatcher = StandardTestDispatcher()

    private lateinit var spaceRepo: FakeSpaceRepository
    private lateinit var boardRepo: FakeBoardRepository
    private lateinit var realtime: FakeRealtimeBridge
    private lateinit var transferManager: FakeTransferManager
    private lateinit var sessionExpiredFlow: MutableSharedFlow<SessionExpiredEvent>

    private val personalSpace = Space(
        id = "sp-personal",
        name = "我的空间",
        ownerId = "u-1",
        expiresAt = null,
        role = "owner",
    )
    private val readOnlySpace = Space(
        id = "sp-viewer",
        name = "团队资料",
        ownerId = "u-2",
        expiresAt = null,
        role = "viewer",
        ownerName = "Alice",
    )

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        spaceRepo = FakeSpaceRepository(
            me = MeResponse(
                user = User(id = "u-1", email = "me@example.com", name = "Me"),
                maxTextBytes = 64 * 1024L,
                maxFileBytes = 100 * 1024 * 1024L,
            ),
            spaces = listOf(readOnlySpace, personalSpace),
        )
        boardRepo = FakeBoardRepository()
        realtime = FakeRealtimeBridge()
        transferManager = FakeTransferManager()
        sessionExpiredFlow = MutableSharedFlow(extraBufferCapacity = 4)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun createViewModel(
        onSessionExpired: () -> Unit = {},
        ioDispatcher: CoroutineDispatcher = testDispatcher,
        autoLoad: Boolean = true,
    ): BoardViewModel = BoardViewModel(
        spaceRepository = spaceRepo,
        boardRepository = boardRepo,
        realtimeBridge = realtime,
        transferManager = transferManager,
        sessionExpiredEvents = sessionExpiredFlow,
        onSessionExpired = onSessionExpired,
        ioDispatcher = ioDispatcher,
        autoLoad = autoLoad,
    )

    @Test
    fun wsSnapshotReplacement_replacesStaleListAndSortsPinnedFirst() = runTest(testDispatcher) {
        val staleItem = ClipItem(id = "old-1", spaceId = "sp-personal", kind = "text", text = "stale", createdAt = 100)
        boardRepo.snapshot = WsEvent.Snapshot(
            items = listOf(staleItem),
            groups = listOf("旧分组"),
            serverTime = 100,
            expiresAt = null,
        )

        val vm = createViewModel()
        advanceUntilIdle()

        assertEquals(personalSpace.id, vm.uiState.value.activeSpace?.id)
        assertEquals(listOf("old-1"), vm.uiState.value.allItems.map { it.id })

        // Authoritative WS snapshot arrives after reconnect -> stale item must disappear, pinned sorted first
        val freshA = ClipItem(id = "a", spaceId = "sp-personal", kind = "text", text = "newer", createdAt = 300)
        val freshB = ClipItem(id = "b", spaceId = "sp-personal", kind = "text", text = "pinned", createdAt = 200, pinned = true)
        realtime.emitEvent(
            TargetScope.SpaceScope("sp-personal"),
            WsEvent.Snapshot(
                items = listOf(freshA, freshB),
                groups = listOf("工作", "个人"),
                serverTime = 400,
                expiresAt = null,
            ),
        )
        advanceUntilIdle()

        assertEquals(listOf("b", "a"), vm.uiState.value.allItems.map { it.id })
        assertEquals(listOf("工作", "个人"), vm.uiState.value.groups)
        assertEquals(listOf("b"), vm.uiState.value.pinnedItems.map { it.id })
    }

    @Test
    fun searchAndGroupAndKindFilters_filterItemsAccurately() = runTest(testDispatcher) {
        val items = listOf(
            ClipItem(id = "1", spaceId = "sp-personal", kind = "text", text = "Kotlin Compose 规范", group = "工作", tags = listOf("android"), createdAt = 30),
            ClipItem(id = "2", spaceId = "sp-personal", kind = "file", filename = "架构评审纪要.pdf", size = 2048, group = "工作", createdAt = 20),
            ClipItem(id = "3", spaceId = "sp-personal", kind = "text", text = "周末购物清单", group = null, createdAt = 10),
        )
        boardRepo.snapshot = WsEvent.Snapshot(items = items, groups = listOf("工作", "个人"), serverTime = 100, expiresAt = null)

        val vm = createViewModel()
        advanceUntilIdle()

        assertEquals(3, vm.uiState.value.filteredItems.size)
        assertEquals(1, vm.uiState.value.ungroupedCount)

        vm.selectGroupFilter(GroupFilter.Named("工作"))
        assertEquals(listOf("1", "2"), vm.uiState.value.filteredItems.map { it.id })

        vm.selectKindFilter(ContentTypeFilter.FILES)
        assertEquals(listOf("2"), vm.uiState.value.filteredItems.map { it.id })

        vm.selectKindFilter(ContentTypeFilter.ALL)
        vm.selectGroupFilter(GroupFilter.Ungrouped)
        assertEquals(listOf("3"), vm.uiState.value.filteredItems.map { it.id })

        vm.selectGroupFilter(GroupFilter.All)
        vm.setSearchExpanded(true)
        vm.setSearchQuery("纪要")
        assertEquals(listOf("2"), vm.uiState.value.filteredItems.map { it.id })

        vm.setSearchQuery("android")
        assertEquals(listOf("1"), vm.uiState.value.filteredItems.map { it.id })

        vm.setSearchExpanded(false)
        assertEquals("", vm.uiState.value.searchQuery)
        assertEquals(3, vm.uiState.value.filteredItems.size)
    }

    @Test
    fun readOnlySpace_blocksAllWriteOperationsAndAllowsDownloads() = runTest(testDispatcher) {
        val fileItem = ClipItem(id = "f1", spaceId = "sp-viewer", kind = "file", filename = "说明.pdf", size = 1024, createdAt = 10)
        val textItem = ClipItem(id = "t1", spaceId = "sp-viewer", kind = "text", text = "只读通知", createdAt = 20)
        boardRepo.snapshot = WsEvent.Snapshot(items = listOf(textItem, fileItem), groups = listOf("文档"), serverTime = 50, expiresAt = null)

        val vm = createViewModel()
        advanceUntilIdle()

        vm.selectSpace(readOnlySpace.id)
        advanceUntilIdle()

        assertTrue(vm.uiState.value.isReadOnly)

        vm.sendText("attempt write")
        vm.sendFromClipboard("clipboard write")
        vm.editText("t1", "edited")
        vm.togglePin(textItem)
        vm.updateItemLabels("t1", OptionalField.Present("文档"), listOf("tag"))
        vm.retractItem("t1")
        vm.createGroup("新分组")
        vm.renameGroup("文档", "新文档")
        vm.deleteGroup("文档")
        advanceUntilIdle()

        assertEquals(0, boardRepo.mutationCallCount)
        assertNotNull(vm.uiState.value.snackbar)

        vm.downloadItem(fileItem)
        advanceUntilIdle()
        assertEquals(1, transferManager.downloadedItems.size)
        assertEquals("f1", transferManager.downloadedItems.first().item.id)
    }

    @Test
    fun writableSpace_textSendEditPinLabelsRetractAndGroupCrud() = runTest(testDispatcher) {
        boardRepo.snapshot = WsEvent.Snapshot(items = emptyList(), groups = listOf("工作"), serverTime = 10, expiresAt = null)
        val vm = createViewModel()
        advanceUntilIdle()

        vm.sendFromClipboard("   ")
        assertTrue(vm.uiState.value.snackbar!!.message.contains("剪贴板为空"))
        assertEquals(0, boardRepo.mutationCallCount)

        vm.sendFromClipboard("来自剪贴板的文本")
        advanceUntilIdle()
        assertEquals(1, vm.uiState.value.allItems.size)
        val created = vm.uiState.value.allItems.first()
        assertEquals("来自剪贴板的文本", created.text)

        vm.editText(created.id, "已修改的文本")
        advanceUntilIdle()
        assertEquals("已修改的文本", vm.uiState.value.allItems.first().text)

        vm.togglePin(vm.uiState.value.allItems.first())
        advanceUntilIdle()
        assertTrue(vm.uiState.value.allItems.first().pinned)

        vm.updateItemLabels(created.id, OptionalField.Present("工作"), listOf("重点", "评审"))
        advanceUntilIdle()
        assertEquals("工作", vm.uiState.value.allItems.first().group)
        assertEquals(listOf("重点", "评审"), vm.uiState.value.allItems.first().tags)

        vm.createGroup("全部")
        assertTrue(vm.uiState.value.snackbar!!.message.contains("保留名称"))

        vm.createGroup("临时收集")
        advanceUntilIdle()
        assertTrue("临时收集" in vm.uiState.value.groups)
        assertEquals(GroupFilter.Named("临时收集"), vm.uiState.value.selectedGroupFilter)

        vm.renameGroup("临时收集", "灵感")
        advanceUntilIdle()
        assertTrue("灵感" in vm.uiState.value.groups)
        assertEquals(GroupFilter.Named("灵感"), vm.uiState.value.selectedGroupFilter)

        vm.deleteGroup("灵感")
        advanceUntilIdle()
        assertFalse("灵感" in vm.uiState.value.groups)
        assertEquals(GroupFilter.All, vm.uiState.value.selectedGroupFilter)

        vm.retractItem(created.id)
        advanceUntilIdle()
        assertTrue(vm.uiState.value.allItems.isEmpty())
    }

    @Test
    fun offlineLoad_showsBannerWithoutCrashAndRecoversOnRetry() = runTest(testDispatcher) {
        spaceRepo.error = ApiError.network(IOException("no network"))
        val vm = createViewModel()
        advanceUntilIdle()

        assertFalse(vm.uiState.value.isLoadingInitial)
        assertNotNull(vm.uiState.value.offlineBannerMessage)
        assertNull(vm.uiState.value.activeSpace)

        spaceRepo.error = null
        vm.reconnectRealtime()
        advanceUntilIdle()

        assertNull(vm.uiState.value.offlineBannerMessage)
        assertEquals(personalSpace.id, vm.uiState.value.activeSpace?.id)
    }

    @Test
    fun sessionExpired401_thenReLoginSameServer_recoversAndHandlesSubsequent401() = runTest(testDispatcher) {
        var expiredCallbackCount = 0
        val vm = createViewModel(
            onSessionExpired = { expiredCallbackCount++ },
            autoLoad = false,
        )

        // Session generation 1
        vm.activateSession("https://dropit.lthero.com#1")
        advanceUntilIdle()
        assertEquals(1, realtime.connectCount)
        assertFalse(vm.uiState.value.sessionExpired)

        // First 401 expires session 1
        sessionExpiredFlow.tryEmit(SessionExpiredEvent("https://dropit.lthero.com", "/api/spaces/sp-personal/items"))
        advanceUntilIdle()
        assertTrue(vm.uiState.value.sessionExpired)
        assertEquals(1, expiredCallbackCount)
        assertTrue(realtime.disconnected)

        // User re-authenticates to the SAME server -> session generation 2
        vm.activateSession("https://dropit.lthero.com#2")
        advanceUntilIdle()
        assertFalse(vm.uiState.value.sessionExpired)
        assertEquals(2, realtime.connectCount)
        assertFalse(realtime.disconnected)

        // Foreground resume works again after recovery
        vm.onBackground()
        vm.onForeground()
        assertEquals(ConnectionState.CONNECTED, realtime.connectionState.value)

        // Second 401 on the new session must be handled again (not stuck permanently ignored!)
        sessionExpiredFlow.tryEmit(SessionExpiredEvent("https://dropit.lthero.com", "/api/spaces/sp-personal/items"))
        advanceUntilIdle()
        assertTrue(vm.uiState.value.sessionExpired)
        assertEquals(2, expiredCallbackCount)
        assertTrue(realtime.disconnected)
    }

    @Test
    fun uiCallbacks_executeOnMainThreadNotIoDispatcher() = runBlocking {
        val mainExecutor = Executors.newSingleThreadExecutor { r -> Thread(r, "test-main-thread") }
        val ioExecutor = Executors.newSingleThreadExecutor { r -> Thread(r, "test-io-thread") }
        val mainDispatcher = mainExecutor.asCoroutineDispatcher()
        val ioDispatcher = ioExecutor.asCoroutineDispatcher()
        try {
            val expectedMainThread = mainExecutor.submit<Thread> { Thread.currentThread() }.get()
            val expectedIoThread = ioExecutor.submit<Thread> { Thread.currentThread() }.get()
            Dispatchers.setMain(mainDispatcher)
            val fileItem = ClipItem(id = "f-share", spaceId = "sp-personal", kind = "file", filename = "report.pdf", size = 1024)
            transferManager.shareResult = Result.success(Uri.EMPTY)

            val vm = createViewModel(ioDispatcher = ioDispatcher, autoLoad = true)

            // Wait until initial load finishes and activeScope is populated
            val deadline = System.currentTimeMillis() + 3_000L
            while (vm.uiState.value.activeScope == null && System.currentTimeMillis() < deadline) {
                Thread.sleep(10)
            }
            assertNotNull(vm.uiState.value.activeScope)

            val sendThread = AtomicReference<Thread>()
            val sendLatch = CountDownLatch(1)
            vm.sendText("hello thread check") {
                sendThread.set(Thread.currentThread())
                sendLatch.countDown()
            }
            assertTrue(sendLatch.await(3, TimeUnit.SECONDS))
            assertEquals(expectedMainThread, sendThread.get())
            assertFalse(sendThread.get() == expectedIoThread)

            val shareThread = AtomicReference<Thread>()
            val shareLatch = CountDownLatch(1)
            vm.prepareFileForShare(fileItem) { _ ->
                shareThread.set(Thread.currentThread())
                shareLatch.countDown()
            }
            assertTrue(shareLatch.await(3, TimeUnit.SECONDS))
            assertEquals(expectedMainThread, shareThread.get())
            assertFalse(shareThread.get() == expectedIoThread)
        } finally {
            Dispatchers.setMain(testDispatcher)
            mainExecutor.shutdownNow()
            ioExecutor.shutdownNow()
        }
    }

    // ---- Test Doubles ----

    private class FakeSpaceRepository(
        var me: MeResponse,
        var spaces: List<Space>,
        var error: Throwable? = null,
    ) : SpaceRepository {
        override suspend fun getMe(): MeResponse {
            error?.let { throw it }
            return me
        }

        override suspend fun getSpaces(): List<Space> {
            error?.let { throw it }
            return spaces
        }

        override suspend fun getScopeDetails(scope: TargetScope): ScopeDetails =
            ScopeDetails(id = scope.scopeId, name = "Scope")

        override fun pickDefaultSpace(spaces: List<Space>, userId: String): Space? =
            spaces.firstOrNull { it.isPersonalFor(userId) } ?: spaces.firstOrNull()
    }

    private class FakeBoardRepository : BoardRepository {
        var snapshot: WsEvent.Snapshot = WsEvent.Snapshot(emptyList(), emptyList(), 0L, null)
        private val items = mutableMapOf<String, ClipItem>()
        private var groups = mutableListOf<String>()
        private var nextId = 1
        var mutationCallCount = 0

        override suspend fun fetchSnapshot(scope: TargetScope): WsEvent.Snapshot {
            items.clear()
            snapshot.items.forEach { items[it.id] = it }
            groups = snapshot.groups.toMutableList()
            return snapshot
        }

        override suspend fun createText(scope: TargetScope, text: String, group: String?): ClipItem {
            mutationCallCount++
            val item = ClipItem(
                id = "created-${nextId++}",
                spaceId = scope.scopeId,
                kind = "text",
                text = text,
                size = text.toByteArray().size.toLong(),
                createdAt = 1_000L + nextId,
                updatedAt = 1_000L + nextId,
                expiresAt = 9_999_999L,
                group = group,
            )
            items[item.id] = item
            return item
        }

        override suspend fun editText(scope: TargetScope, itemId: String, text: String): ClipItem {
            mutationCallCount++
            val current = items[itemId] ?: ClipItem(id = itemId, spaceId = scope.scopeId, kind = "text")
            val updated = current.copy(text = text, updatedAt = current.updatedAt + 10)
            items[itemId] = updated
            return updated
        }

        override suspend fun setPinned(scope: TargetScope, itemId: String, pinned: Boolean): ClipItem {
            mutationCallCount++
            val current = items[itemId] ?: ClipItem(id = itemId, spaceId = scope.scopeId, kind = "text")
            val updated = current.copy(pinned = pinned)
            items[itemId] = updated
            return updated
        }

        override suspend fun setTags(scope: TargetScope, itemId: String, tags: List<String>): ClipItem =
            updateLabels(scope, itemId, tags = tags)

        override suspend fun setGroup(scope: TargetScope, itemId: String, group: String?): ClipItem =
            updateLabels(scope, itemId, group = OptionalField.Present(group))

        override suspend fun updateLabels(
            scope: TargetScope,
            itemId: String,
            pinned: Boolean?,
            tags: List<String>?,
            group: OptionalField<String?>,
        ): ClipItem {
            mutationCallCount++
            val current = items[itemId] ?: ClipItem(id = itemId, spaceId = scope.scopeId, kind = "text")
            val updated = current.copy(
                pinned = pinned ?: current.pinned,
                tags = tags ?: current.tags,
                group = if (group is OptionalField.Present) group.value else current.group,
            )
            items[itemId] = updated
            return updated
        }

        override suspend fun retractItem(scope: TargetScope, itemId: String) {
            mutationCallCount++
            items.remove(itemId)
        }

        override suspend fun getGroups(scope: TargetScope): List<String> = groups.toList()

        override suspend fun createGroup(scope: TargetScope, name: String): List<String> {
            mutationCallCount++
            if (name !in groups) groups.add(name)
            return groups.toList()
        }

        override suspend fun renameGroup(scope: TargetScope, oldName: String, newName: String): List<String> {
            mutationCallCount++
            val idx = groups.indexOf(oldName)
            if (idx >= 0) groups[idx] = newName
            return groups.toList()
        }

        override suspend fun deleteGroup(scope: TargetScope, name: String): List<String> {
            mutationCallCount++
            groups.remove(name)
            return groups.toList()
        }

        override fun buildGroupInfos(groups: List<String>, items: List<ClipItem>): List<GroupInfo> {
            val counts = items.groupingBy { it.group }.eachCount()
            return groups.map { GroupInfo(it, counts[it] ?: 0) }
        }
    }

    private class FakeRealtimeBridge : BoardRealtimeBridge {
        private val _connectionState = MutableStateFlow(ConnectionState.DISCONNECTED)
        override val connectionState: StateFlow<ConnectionState> = _connectionState.asStateFlow()

        private val _boardState = MutableStateFlow(BoardSnapshotState())
        override val boardState: StateFlow<BoardSnapshotState> = _boardState.asStateFlow()

        var connectedScope: TargetScope? = null
        var connectCount: Int = 0
        var disconnected: Boolean = false

        override fun connect(targetScope: TargetScope) {
            connectCount++
            connectedScope = targetScope
            disconnected = false
            _boardState.value = BoardSnapshotState(scope = targetScope)
            _connectionState.value = ConnectionState.CONNECTED
        }

        override fun disconnect(clearState: Boolean) {
            disconnected = true
            _connectionState.value = ConnectionState.DISCONNECTED
            if (clearState) _boardState.value = BoardSnapshotState()
        }

        override fun reconnectNow() {
            _connectionState.value = ConnectionState.CONNECTED
        }

        override fun onAppBackground() {
            _connectionState.value = ConnectionState.DISCONNECTED
        }

        override fun onAppForeground() {
            if (connectedScope != null) _connectionState.value = ConnectionState.CONNECTED
        }

        override fun applyLocalSnapshot(targetScope: TargetScope, snapshot: WsEvent.Snapshot) {
            emitEvent(targetScope, snapshot)
        }

        fun emitEvent(targetScope: TargetScope, event: WsEvent) {
            val base = if (_boardState.value.scope == targetScope) {
                _boardState.value
            } else {
                BoardSnapshotState(scope = targetScope)
            }
            _boardState.value = BoardStateReducer.reduce(base, event)
        }
    }

    private class FakeTransferManager : TransferManager {
        private val _tasks = MutableStateFlow<List<TransferTask>>(emptyList())
        override val tasks: StateFlow<List<TransferTask>> = _tasks.asStateFlow()

        private val _activeCount = MutableStateFlow(0)
        override val activeCount: StateFlow<Int> = _activeCount.asStateFlow()

        val downloadedItems = mutableListOf<DownloadFileRequest>()
        var shareResult: Result<Uri> = Result.failure(UnsupportedOperationException("pending"))

        override suspend fun enqueueUploads(requests: List<UploadFileRequest>): List<String> =
            requests.indices.map { "up-$it" }

        override suspend fun enqueueStagedUploads(
            stagedFiles: List<StagedShareFile>,
            targetScope: TargetScope,
            groupName: String?,
        ): List<String> = emptyList()

        override suspend fun enqueueDownload(request: DownloadFileRequest): String {
            downloadedItems.add(request)
            return "dl-${downloadedItems.size}"
        }

        override suspend fun downloadForShare(item: ClipItem, targetScope: TargetScope): Result<Uri> = shareResult

        override suspend fun cancel(taskId: String) = Unit
        override suspend fun retry(taskId: String) = Unit
        override suspend fun clearCompleted() = Unit
        override suspend fun clearAllForScopeSwitch() = Unit
    }
}
