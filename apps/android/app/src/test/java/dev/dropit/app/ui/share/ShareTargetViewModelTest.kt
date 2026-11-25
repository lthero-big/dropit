package dev.dropit.app.ui.share

import android.content.Intent
import android.net.Uri
import dev.dropit.app.core.network.ClipItem
import dev.dropit.app.core.network.GroupInfo
import dev.dropit.app.core.network.OptionalField
import dev.dropit.app.core.network.RoomInfo
import dev.dropit.app.core.network.Space
import dev.dropit.app.core.network.TargetScope
import dev.dropit.app.core.network.WsEvent
import dev.dropit.app.core.repository.BoardRepository
import dev.dropit.app.core.repository.DownloadFileRequest
import dev.dropit.app.core.repository.PendingShare
import dev.dropit.app.core.repository.ShareInbox
import dev.dropit.app.core.repository.StagedShareFile
import dev.dropit.app.core.repository.TransferManager
import dev.dropit.app.core.repository.TransferTask
import dev.dropit.app.core.repository.UploadFileRequest
import dev.dropit.app.ui.navigation.ShareIntentGuard
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ShareTargetViewModelTest {

    private val testDispatcher = StandardTestDispatcher()

    private val personalSpace = Space(
        id = "sp-personal",
        name = "我的空间",
        ownerId = "user-1",
        expiresAt = null,
        role = "owner",
    )
    private val editorSpace = Space(
        id = "sp-editor",
        name = "设计协作",
        ownerId = "user-2",
        expiresAt = null,
        role = "editor",
        ownerName = "Bob",
    )
    private val readOnlySpace = Space(
        id = "sp-viewer",
        name = "公告板",
        ownerId = "user-3",
        expiresAt = null,
        role = "viewer",
        ownerName = "Carol",
    )
    private val activeRoom = RoomInfo(
        token = "room-secret-token",
        code = "k7Rm2x",
        hasPin = false,
        expiresAt = 9_999_999_999L,
        url = "/r/k7Rm2x",
    )

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    @Test
    fun shareIntentGuard_ignoresHistoryFlagAndNonShareActions() {
        assertTrue(ShareIntentGuard.shouldCapture(Intent.ACTION_SEND, 0))
        assertTrue(ShareIntentGuard.shouldCapture(Intent.ACTION_SEND_MULTIPLE, 0))
        assertFalse(ShareIntentGuard.shouldCapture(Intent.ACTION_SEND, Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY))
        assertFalse(
            ShareIntentGuard.shouldCapture(
                Intent.ACTION_SEND_MULTIPLE,
                Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY or Intent.FLAG_ACTIVITY_NEW_TASK,
            ),
        )
        assertFalse(ShareIntentGuard.shouldCapture(Intent.ACTION_MAIN, 0))
        assertFalse(ShareIntentGuard.shouldCapture(null, 0))
    }

    @Test
    fun targetSelection_defaultsToPersonalExcludesReadOnlyAndSupportsSwitchingToRoom() = runTest(testDispatcher) {
        val inbox = FakeShareInbox()
        val boardRepo = FakeBoardRepository(
            groupsByScope = mapOf(
                TargetScope.SpaceScope("sp-personal") to listOf("工作", "个人"),
                TargetScope.RoomScope("room-secret-token") to listOf("临时资料"),
            ),
        )
        val transferManager = FakeTransferManager()
        val vm = ShareTargetViewModel(
            shareInbox = inbox,
            boardRepository = boardRepo,
            transferManager = transferManager,
            ioDispatcher = testDispatcher,
        )

        val pending = PendingShare(
            id = "share-1",
            text = "分享一段文本",
            files = listOf(
                StagedShareFile("f1", "截图.png", "image/png", 2048L, "/tmp/f1.png"),
                StagedShareFile("f2", "合同.pdf", "application/pdf", 4096L, "/tmp/f2.pdf"),
            ),
        )
        inbox.setPending(pending)
        vm.syncTargets(
            spaces = listOf(readOnlySpace, editorSpace, personalSpace),
            currentUserId = "user-1",
            activeRoom = activeRoom,
            knownScopeGroups = TargetScope.SpaceScope("sp-personal") to listOf("工作", "个人"),
        )
        advanceUntilIdle()

        val state = vm.uiState.value
        assertEquals(1, state.excludedReadOnlyCount)
        assertEquals(3, state.availableTargets.size) // personal, editor, active room (read-only excluded)
        assertEquals(TargetScope.SpaceScope("sp-personal"), state.selectedTarget?.scope)
        assertFalse(state.availableTargets.any { it.scope == TargetScope.SpaceScope("sp-viewer") })

        // Switch target to active temporary room & choose a group
        val roomDest = state.availableTargets.first { it is ShareDestination.RoomDestination }
        vm.selectTarget(roomDest)
        advanceUntilIdle()

        assertEquals(TargetScope.RoomScope("room-secret-token"), vm.uiState.value.selectedTarget?.scope)
        assertEquals(listOf("临时资料"), vm.uiState.value.availableGroups)
        vm.selectGroup("临时资料")
        vm.updateText("编辑后的分享内容")
        vm.removeFile("f1")

        var callbackCount = 0
        var callbackHasFiles = false
        // Duplicate submit taps must only execute once!
        vm.submitShare { _, hasFiles ->
            callbackCount++
            callbackHasFiles = hasFiles
        }
        vm.submitShare { _, _ ->
            callbackCount++
        }
        advanceUntilIdle()

        assertEquals(1, callbackCount)
        assertTrue(callbackHasFiles)
        assertEquals(1, boardRepo.createdTexts.size)
        assertEquals(Triple(TargetScope.RoomScope("room-secret-token"), "编辑后的分享内容", "临时资料"), boardRepo.createdTexts.first())
        assertEquals(1, transferManager.stagedEnqueues.size)
        assertEquals(listOf("f2"), transferManager.stagedEnqueues.first().first.map { it.id })
        assertEquals(1, inbox.consumeCount)
        assertNull(vm.uiState.value.pendingShare)
    }

    @Test
    fun cancelShare_discardsPendingShareWithoutSending() = runTest(testDispatcher) {
        val inbox = FakeShareInbox()
        val boardRepo = FakeBoardRepository()
        val transferManager = FakeTransferManager()
        val vm = ShareTargetViewModel(
            shareInbox = inbox,
            boardRepository = boardRepo,
            transferManager = transferManager,
            ioDispatcher = testDispatcher,
        )

        inbox.setPending(PendingShare(id = "share-cancel", text = "取消发送"))
        advanceUntilIdle()
        assertEquals("取消发送", vm.uiState.value.editedText)

        vm.cancelShare()
        advanceUntilIdle()

        assertEquals(1, inbox.discardCount)
        assertEquals(0, boardRepo.createdTexts.size)
        assertNull(vm.uiState.value.pendingShare)
    }

    private class FakeShareInbox : ShareInbox {
        private val _pendingShare = MutableStateFlow<PendingShare?>(null)
        override val pendingShare: StateFlow<PendingShare?> = _pendingShare.asStateFlow()

        var consumeCount = 0
        var discardCount = 0

        fun setPending(share: PendingShare?) {
            _pendingShare.value = share
        }

        override suspend fun captureIntent(intent: Intent?): Boolean = false

        override suspend fun consumePendingShare(): PendingShare? {
            consumeCount++
            val current = _pendingShare.value
            _pendingShare.value = null
            return current
        }

        override suspend fun discardPendingShare() {
            discardCount++
            _pendingShare.value = null
        }
    }

    private class FakeBoardRepository(
        private val groupsByScope: Map<TargetScope, List<String>> = emptyMap(),
    ) : BoardRepository {
        val createdTexts = mutableListOf<Triple<TargetScope, String, String?>>()

        override suspend fun fetchSnapshot(scope: TargetScope): WsEvent.Snapshot =
            WsEvent.Snapshot(emptyList(), emptyList(), 0L, null)

        override suspend fun createText(scope: TargetScope, text: String, group: String?): ClipItem {
            createdTexts.add(Triple(scope, text, group))
            return ClipItem(id = "txt-${createdTexts.size}", spaceId = scope.scopeId, kind = "text", text = text, group = group)
        }

        override suspend fun editText(scope: TargetScope, itemId: String, text: String): ClipItem =
            throw UnsupportedOperationException()
        override suspend fun setPinned(scope: TargetScope, itemId: String, pinned: Boolean): ClipItem =
            throw UnsupportedOperationException()
        override suspend fun setTags(scope: TargetScope, itemId: String, tags: List<String>): ClipItem =
            throw UnsupportedOperationException()
        override suspend fun setGroup(scope: TargetScope, itemId: String, group: String?): ClipItem =
            throw UnsupportedOperationException()
        override suspend fun updateLabels(
            scope: TargetScope,
            itemId: String,
            pinned: Boolean?,
            tags: List<String>?,
            group: OptionalField<String?>,
        ): ClipItem = throw UnsupportedOperationException()
        override suspend fun retractItem(scope: TargetScope, itemId: String) = Unit
        override suspend fun getGroups(scope: TargetScope): List<String> = groupsByScope[scope].orEmpty()
        override suspend fun createGroup(scope: TargetScope, name: String): List<String> = emptyList()
        override suspend fun renameGroup(scope: TargetScope, oldName: String, newName: String): List<String> = emptyList()
        override suspend fun deleteGroup(scope: TargetScope, name: String): List<String> = emptyList()
        override fun buildGroupInfos(groups: List<String>, items: List<ClipItem>): List<GroupInfo> = emptyList()
    }

    private class FakeTransferManager : TransferManager {
        override val tasks: StateFlow<List<TransferTask>> = MutableStateFlow(emptyList())
        override val activeCount: StateFlow<Int> = MutableStateFlow(0)
        val stagedEnqueues = mutableListOf<Triple<List<StagedShareFile>, TargetScope, String?>>()

        override suspend fun enqueueUploads(requests: List<UploadFileRequest>): List<String> = emptyList()
        override suspend fun enqueueStagedUploads(
            stagedFiles: List<StagedShareFile>,
            targetScope: TargetScope,
            groupName: String?,
        ): List<String> {
            stagedEnqueues.add(Triple(stagedFiles, targetScope, groupName))
            return stagedFiles.map { "task-${it.id}" }
        }
        override suspend fun enqueueDownload(request: DownloadFileRequest): String = ""
        override suspend fun downloadForShare(item: ClipItem, targetScope: TargetScope): Result<Uri> =
            Result.failure(UnsupportedOperationException())
        override suspend fun cancel(taskId: String) = Unit
        override suspend fun retry(taskId: String) = Unit
        override suspend fun clearCompleted() = Unit
        override suspend fun clearAllForScopeSwitch() = Unit
    }
}
