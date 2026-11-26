package dev.dropit.app.ui.board

import android.app.Application
import android.net.Uri
import androidx.compose.foundation.layout.Column
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.media3.datasource.DataSource
import androidx.test.ext.junit.runners.AndroidJUnit4
import coil.ImageLoader
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
import dev.dropit.app.core.repository.DownloadEnqueueResult
import dev.dropit.app.core.repository.DownloadFileRequest
import dev.dropit.app.core.repository.MediaRepository
import dev.dropit.app.core.repository.PlaceholderItemShareRepository
import dev.dropit.app.core.repository.PlaceholderRoomRepository
import dev.dropit.app.core.repository.SavedDownloadRecord
import dev.dropit.app.core.repository.SpaceRepository
import dev.dropit.app.core.repository.StagedShareFile
import dev.dropit.app.core.repository.TransferManager
import dev.dropit.app.core.repository.TransferTask
import dev.dropit.app.core.repository.UploadFileRequest
import dev.dropit.app.ui.rooms.RoomViewModel
import dev.dropit.app.ui.share.ItemShareViewModel
import dev.dropit.app.ui.theme.DropitTheme
import dev.dropit.app.ui.viewer.TextMarkdownViewer
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(application = Application::class, sdk = [34])
class BoardSavedDownloadUiTest {

    @get:Rule
    val composeRule = createComposeRule()

    private val sampleFile = ClipItem(
        id = "item-pdf-1",
        spaceId = "sp-1",
        kind = "file",
        filename = "设计规范_v4.pdf",
        mime = "application/pdf",
        size = 2_048_000L,
        createdAt = 1_700_000_000_000L,
    )

    @Test
    fun boardCard_rendersDistinctSaveStates_unsavedSavingAndSaved() {
        val nowMs = 1_700_000_060_000L
        composeRule.setContent {
            DropitTheme {
                Column {
                    BoardCard(
                        item = sampleFile.copy(id = "f-unsaved", filename = "unsaved.pdf"),
                        isCopied = false,
                        nowMs = nowMs,
                        fileSaveState = FileSaveState.NOT_SAVED,
                        onCopyText = {},
                        onDownloadFile = {},
                        onShareItem = {},
                        onOpenUrl = {},
                        onOpenMore = {},
                    )
                    BoardCard(
                        item = sampleFile.copy(id = "f-saving", filename = "saving.pdf"),
                        isCopied = false,
                        nowMs = nowMs,
                        fileSaveState = FileSaveState.SAVING,
                        onCopyText = {},
                        onDownloadFile = {},
                        onShareItem = {},
                        onOpenUrl = {},
                        onOpenMore = {},
                    )
                    BoardCard(
                        item = sampleFile.copy(id = "f-saved", filename = "saved.pdf"),
                        isCopied = false,
                        nowMs = nowMs,
                        fileSaveState = FileSaveState.SAVED,
                        onCopyText = {},
                        onDownloadFile = {},
                        onShareItem = {},
                        onOpenUrl = {},
                        onOpenMore = {},
                    )
                }
            }
        }
        composeRule.waitForIdle()

        composeRule.onNodeWithText("保存").assertIsDisplayed()
        composeRule.onNodeWithText("保存中").assertIsDisplayed()
        composeRule.onNodeWithText("已保存").assertIsDisplayed()
        composeRule.onNodeWithContentDescription("已保存到本地，点击打开或重新下载").assertIsDisplayed()
    }

    @Test
    fun clickingSavedCard_showsOpenOrRedownloadDialogWithoutNetworkDownload_andRedownloadTriggersEnqueue() {
        val savedRecord = SavedDownloadRecord(
            serverOrigin = "https://dropit.example",
            accountId = "u-1",
            remoteItemId = sampleFile.id,
            localUri = "content://media/external/downloads/88",
            fileName = "设计规范_v4.pdf",
            mimeType = "application/pdf",
            fileSize = 2_048_000L,
            savedAt = 1_700_000_050_000L,
        )
        val transferManager = UiFakeTransferManager(
            initialSaved = mapOf(sampleFile.id to savedRecord),
            existingIds = mutableSetOf(sampleFile.id),
        )
        val boardViewModel = createBoardViewModel(sampleFile, transferManager)
        val roomViewModel = RoomViewModel(
            roomRepository = PlaceholderRoomRepository(),
            serverOriginProvider = { "https://dropit.example" },
            ioDispatcher = Dispatchers.Unconfined,
        )
        val itemShareViewModel = ItemShareViewModel(PlaceholderItemShareRepository(), { "https://dropit.example" }, ioDispatcher = Dispatchers.Unconfined)

        composeRule.setContent {
            DropitTheme {
                BoardScreen(
                    viewModel = boardViewModel,
                    roomViewModel = roomViewModel,
                    itemShareViewModel = itemShareViewModel,
                    mediaRepository = StubMediaRepository(),
                    imageLoader = ImageLoader.Builder(androidx.test.core.app.ApplicationProvider.getApplicationContext()).build(),
                    onNavigateToTransfers = {},
                    onOpenImageLightbox = { _, _, _ -> },
                    onOpenMediaPlayer = { _, _, _ -> },
                    onOpenTextReader = {},
                )
            }
        }
        composeRule.waitForIdle()

        // Tapping "已保存" opens dialog without starting download
        composeRule.onNodeWithText("已保存").performClick()
        composeRule.waitForIdle()

        composeRule.onNodeWithText("文件已保存到本地").assertIsDisplayed()
        composeRule.onNodeWithText("打开文件").assertIsDisplayed()
        composeRule.onNodeWithText("重新下载").assertIsDisplayed()
        composeRule.onNodeWithText("取消").assertIsDisplayed()
        assertEquals("Clicking saved item must skip network download", 0, transferManager.enqueuedDownloads.size)

        // Tapping "重新下载" closes dialog and triggers new download
        composeRule.onNodeWithText("重新下载").performClick()
        composeRule.waitForIdle()

        composeRule.onNodeWithText("文件已保存到本地").assertDoesNotExist()
        assertEquals(1, transferManager.enqueuedDownloads.size)
        assertEquals(sampleFile.id, transferManager.enqueuedDownloads.first().item.id)
    }

    @Test
    fun clickingSavedCardWhenLocalFileDeleted_cleansIndexAndRedownloadsImmediatelyWithoutDialog() {
        val savedRecord = SavedDownloadRecord(
            serverOrigin = "https://dropit.example",
            accountId = "u-1",
            remoteItemId = sampleFile.id,
            localUri = "content://media/external/downloads/deleted",
            fileName = "设计规范_v4.pdf",
            mimeType = "application/pdf",
            fileSize = 2_048_000L,
            savedAt = 1_700_000_050_000L,
        )
        // existingIds is empty -> simulates user deleted the local file externally
        val transferManager = UiFakeTransferManager(
            initialSaved = mapOf(sampleFile.id to savedRecord),
            existingIds = mutableSetOf(),
            skipAutoPruneOnVerifyAll = true,
        )
        val boardViewModel = createBoardViewModel(sampleFile, transferManager)
        val roomViewModel = RoomViewModel(
            roomRepository = PlaceholderRoomRepository(),
            serverOriginProvider = { "https://dropit.example" },
            ioDispatcher = Dispatchers.Unconfined,
        )
        val itemShareViewModel = ItemShareViewModel(PlaceholderItemShareRepository(), { "https://dropit.example" }, ioDispatcher = Dispatchers.Unconfined)

        composeRule.setContent {
            DropitTheme {
                BoardScreen(
                    viewModel = boardViewModel,
                    roomViewModel = roomViewModel,
                    itemShareViewModel = itemShareViewModel,
                    mediaRepository = StubMediaRepository(),
                    imageLoader = ImageLoader.Builder(androidx.test.core.app.ApplicationProvider.getApplicationContext()).build(),
                    onNavigateToTransfers = {},
                    onOpenImageLightbox = { _, _, _ -> },
                    onOpenMediaPlayer = { _, _, _ -> },
                    onOpenTextReader = {},
                )
            }
        }
        composeRule.waitForIdle()

        composeRule.onNodeWithText("已保存").performClick()
        composeRule.waitForIdle()

        composeRule.onNodeWithText("文件已保存到本地").assertDoesNotExist()
        assertEquals(1, transferManager.enqueuedDownloads.size)
        assertTrue(transferManager.savedDownloads.value.isEmpty())
    }

    @Test
    fun textMarkdownViewer_showsSavedIndicatorAndInvokesSaveCallback() {
        val mdFile = ClipItem(
            id = "md-1",
            spaceId = "sp-1",
            kind = "file",
            filename = "notes.md",
            mime = "text/markdown",
            size = 128L,
            createdAt = 1_700_000_000_000L,
        )
        var saveClicked = 0
        composeRule.setContent {
            DropitTheme {
                TextMarkdownViewer(
                    item = mdFile,
                    nowMs = 1_700_000_060_000L,
                    fileSaveState = FileSaveState.SAVED,
                    onCopyText = {},
                    onShareText = {},
                    onOpenUrl = {},
                    onDownloadFallback = { saveClicked += 1 },
                    onClose = {},
                )
            }
        }
        composeRule.waitForIdle()

        composeRule.onNodeWithContentDescription("已保存到本地，点击打开或重新下载")
            .assertIsDisplayed()
            .performClick()
        assertEquals(1, saveClicked)
    }

    private fun createBoardViewModel(
        item: ClipItem,
        transferManager: TransferManager,
    ): BoardViewModel {
        val personalSpace = Space(id = "sp-1", name = "我的空间", ownerId = "u-1", expiresAt = null, role = "owner")
        val spaceRepo = object : SpaceRepository {
            override suspend fun getMe(): MeResponse = MeResponse(
                user = User(id = "u-1", email = "u@example.com", name = "User"),
            )
            override suspend fun getSpaces(): List<Space> = listOf(personalSpace)
            override suspend fun getScopeDetails(scope: TargetScope): ScopeDetails = ScopeDetails(scope.scopeId, "我的空间")
            override fun pickDefaultSpace(spaces: List<Space>, userId: String): Space? = spaces.firstOrNull()
        }
        val snapshot = WsEvent.Snapshot(items = listOf(item), groups = emptyList(), serverTime = 1_700_000_000_000L, expiresAt = null)
        val boardRepo = object : BoardRepository {
            override suspend fun fetchSnapshot(scope: TargetScope): WsEvent.Snapshot = snapshot
            override suspend fun createText(scope: TargetScope, text: String, group: String?): ClipItem = item
            override suspend fun editText(scope: TargetScope, itemId: String, text: String): ClipItem = item
            override suspend fun setPinned(scope: TargetScope, itemId: String, pinned: Boolean): ClipItem = item
            override suspend fun setTags(scope: TargetScope, itemId: String, tags: List<String>): ClipItem = item
            override suspend fun setGroup(scope: TargetScope, itemId: String, group: String?): ClipItem = item
            override suspend fun updateLabels(
                scope: TargetScope,
                itemId: String,
                pinned: Boolean?,
                tags: List<String>?,
                group: OptionalField<String?>,
            ): ClipItem = item
            override suspend fun retractItem(scope: TargetScope, itemId: String) = Unit
            override suspend fun getGroups(scope: TargetScope): List<String> = emptyList()
            override suspend fun createGroup(scope: TargetScope, name: String): List<String> = emptyList()
            override suspend fun renameGroup(scope: TargetScope, oldName: String, newName: String): List<String> = emptyList()
            override suspend fun deleteGroup(scope: TargetScope, name: String): List<String> = emptyList()
            override fun buildGroupInfos(groups: List<String>, items: List<ClipItem>): List<GroupInfo> = emptyList()
        }
        val realtime = object : BoardRealtimeBridge {
            private val _conn = MutableStateFlow(ConnectionState.CONNECTED)
            override val connectionState: StateFlow<ConnectionState> = _conn.asStateFlow()
            private val _board = MutableStateFlow(BoardSnapshotState())
            override val boardState: StateFlow<BoardSnapshotState> = _board.asStateFlow()
            override fun connect(targetScope: TargetScope) {
                _board.value = BoardSnapshotState(scope = targetScope)
            }
            override fun disconnect(clearState: Boolean) = Unit
            override fun reconnectNow() = Unit
            override fun onAppBackground() = Unit
            override fun onAppForeground() = Unit
            override fun applyLocalSnapshot(targetScope: TargetScope, snapshot: WsEvent.Snapshot) {
                _board.value = BoardStateReducer.reduce(BoardSnapshotState(scope = targetScope), snapshot)
            }
        }
        return BoardViewModel(
            spaceRepository = spaceRepo,
            boardRepository = boardRepo,
            realtimeBridge = realtime,
            transferManager = transferManager,
            sessionExpiredEvents = MutableSharedFlow<SessionExpiredEvent>(),
            ioDispatcher = Dispatchers.Unconfined,
            autoLoad = true,
        )
    }

    private class UiFakeTransferManager(
        initialSaved: Map<String, SavedDownloadRecord>,
        private val existingIds: MutableSet<String>,
        private val skipAutoPruneOnVerifyAll: Boolean = false,
    ) : TransferManager {
        private val _tasks = MutableStateFlow<List<TransferTask>>(emptyList())
        override val tasks: StateFlow<List<TransferTask>> = _tasks.asStateFlow()
        private val _activeCount = MutableStateFlow(0)
        override val activeCount: StateFlow<Int> = _activeCount.asStateFlow()
        private val _savedDownloads = MutableStateFlow(initialSaved)
        override val savedDownloads: StateFlow<Map<String, SavedDownloadRecord>> = _savedDownloads.asStateFlow()
        private val _activeDownloadItemIds = MutableStateFlow<Set<String>>(emptySet())
        override val activeDownloadItemIds: StateFlow<Set<String>> = _activeDownloadItemIds.asStateFlow()

        val enqueuedDownloads = mutableListOf<DownloadFileRequest>()

        override suspend fun enqueueUploads(requests: List<UploadFileRequest>): List<String> = emptyList()
        override suspend fun enqueueStagedUploads(
            stagedFiles: List<StagedShareFile>,
            targetScope: TargetScope,
            groupName: String?,
        ): List<String> = emptyList()

        override suspend fun enqueueDownload(request: DownloadFileRequest): String {
            enqueuedDownloads.add(request)
            return "dl-${enqueuedDownloads.size}"
        }

        override suspend fun enqueueDownloadOrReuse(request: DownloadFileRequest): DownloadEnqueueResult =
            DownloadEnqueueResult.Started(enqueueDownload(request))

        override suspend fun verifySavedDownload(remoteItemId: String): SavedDownloadRecord? {
            val record = _savedDownloads.value[remoteItemId] ?: return null
            return if (remoteItemId in existingIds) {
                record
            } else {
                _savedDownloads.value = _savedDownloads.value - remoteItemId
                null
            }
        }

        override suspend fun verifyAllSavedDownloads() {
            if (!skipAutoPruneOnVerifyAll) {
                _savedDownloads.value = _savedDownloads.value.filterKeys { it in existingIds }
            }
        }

        override suspend fun downloadForShare(item: ClipItem, targetScope: TargetScope): Result<Uri> =
            Result.failure(UnsupportedOperationException())
        override suspend fun cancel(taskId: String) = Unit
        override suspend fun retry(taskId: String) = Unit
        override suspend fun clearCompleted() = Unit
        override suspend fun clearAllForScopeSwitch() = Unit
    }

    private class StubMediaRepository : MediaRepository {
        override suspend fun thumbnailUrl(scope: TargetScope, itemId: String): String = ""
        override suspend fun previewUrl(scope: TargetScope, itemId: String): String = ""
        override suspend fun mediaUrl(scope: TargetScope, itemId: String): String = ""
        override suspend fun downloadUrl(scope: TargetScope, itemId: String): String = ""
        override fun createImageLoader(): ImageLoader = error("unused")
        override fun createMediaDataSourceFactory(): DataSource.Factory = error("unused")
        override suspend fun fetchTextContent(scope: TargetScope, itemId: String, maxBytes: Int): String = ""
        override suspend fun clearCaches() = Unit
    }
}
