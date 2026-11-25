package dev.dropit.app.ui.transfers

import android.net.Uri
import dev.dropit.app.core.network.ClipItem
import dev.dropit.app.core.network.TargetScope
import dev.dropit.app.core.repository.DownloadFileRequest
import dev.dropit.app.core.repository.StagedShareFile
import dev.dropit.app.core.repository.TransferDirection
import dev.dropit.app.core.repository.TransferManager
import dev.dropit.app.core.repository.TransferStatus
import dev.dropit.app.core.repository.TransferTask
import dev.dropit.app.core.repository.UploadFileRequest
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
class TransfersViewModelTest {

    private val testDispatcher = StandardTestDispatcher()

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    @Test
    fun cancelRetryAndClearCompleted_updateQueueStateAndCallManager() = runTest(testDispatcher) {
        val manager = FakeTransferManager(
            initialTasks = listOf(
                TransferTask(
                    id = "t-run",
                    serverOrigin = "https://dropit.lthero.com",
                    targetScope = TargetScope.SpaceScope("sp-1"),
                    groupName = "工作",
                    direction = TransferDirection.UPLOAD,
                    fileName = "产品评审方案.pdf",
                    mimeType = "application/pdf",
                    totalBytes = 10_000_000L,
                    transferredBytes = 4_200_000L,
                    speedBytesPerSec = 2_000_000L,
                    etaSeconds = 3L,
                    status = TransferStatus.RUNNING,
                ),
                TransferTask(
                    id = "t-fail",
                    serverOrigin = "https://dropit.lthero.com",
                    targetScope = TargetScope.RoomScope("rm-1"),
                    direction = TransferDirection.UPLOAD,
                    fileName = "会议录像.mp4",
                    mimeType = "video/mp4",
                    totalBytes = 50_000_000L,
                    transferredBytes = 10_000_000L,
                    status = TransferStatus.FAILED,
                    errorMessage = "网络中断",
                ),
                TransferTask(
                    id = "t-done",
                    serverOrigin = "https://dropit.lthero.com",
                    targetScope = TargetScope.SpaceScope("sp-1"),
                    direction = TransferDirection.DOWNLOAD,
                    fileName = "发票.png",
                    mimeType = "image/png",
                    totalBytes = 204_800L,
                    transferredBytes = 204_800L,
                    status = TransferStatus.SUCCEEDED,
                    localResultUri = "content://downloads/1",
                ),
            ),
        )

        val vm = TransfersViewModel(transferManager = manager, ioDispatcher = testDispatcher)
        advanceUntilIdle()

        assertEquals(3, vm.uiState.value.tasks.size)
        assertEquals(1, vm.uiState.value.activeCount)
        assertEquals(1, vm.uiState.value.completedCount)
        assertEquals(1, vm.uiState.value.failedCount)
        assertTrue(vm.uiState.value.canClearCompleted)

        vm.cancelTask("t-run")
        advanceUntilIdle()
        assertEquals(listOf("t-run"), manager.cancelledIds)
        assertEquals(TransferStatus.CANCELLED, vm.uiState.value.tasks.first { it.id == "t-run" }.status)
        assertEquals(2, vm.uiState.value.completedCount)

        vm.retryTask("t-fail")
        advanceUntilIdle()
        assertEquals(listOf("t-fail"), manager.retriedIds)
        assertEquals(TransferStatus.QUEUED, vm.uiState.value.tasks.first { it.id == "t-fail" }.status)
        assertEquals(0, vm.uiState.value.failedCount)

        vm.clearCompleted()
        advanceUntilIdle()
        assertEquals(1, manager.clearCompletedCount)
        assertEquals(listOf("t-fail"), vm.uiState.value.tasks.map { it.id })
        assertFalse(vm.uiState.value.canClearCompleted)
    }

    @Test
    fun transferFormatting_formatsSpeedEtaStatusAndScopeAccurately() {
        assertNull(TransferFormatting.formatSpeed(0L))
        assertEquals("512 B/s", TransferFormatting.formatSpeed(512L))
        assertEquals("256 KB/s", TransferFormatting.formatSpeed(256L * 1024L))
        assertEquals("2.5 MB/s", TransferFormatting.formatSpeed((2.5 * 1024 * 1024).toLong()))

        assertNull(TransferFormatting.formatEta(null))
        assertNull(TransferFormatting.formatEta(0L))
        assertEquals("剩余 8 秒", TransferFormatting.formatEta(8L))
        assertEquals("剩余 2 分 5 秒", TransferFormatting.formatEta(125L))
        assertEquals("剩余 1 小时 1 分", TransferFormatting.formatEta(3660L))

        val running = TransferTask(
            id = "1",
            serverOrigin = "https://dropit.lthero.com",
            targetScope = TargetScope.SpaceScope("sp-1"),
            groupName = "工作",
            direction = TransferDirection.UPLOAD,
            fileName = "报告.pdf",
            mimeType = "application/pdf",
            totalBytes = 10L * 1024 * 1024,
            transferredBytes = 5L * 1024 * 1024,
            speedBytesPerSec = 2L * 1024 * 1024,
            etaSeconds = 3L,
            status = TransferStatus.RUNNING,
        )
        val runningLine = TransferFormatting.formatStatusLine(running)
        assertTrue(runningLine.contains("50%"))
        assertTrue(runningLine.contains("2.0 MB/s"))
        assertTrue(runningLine.contains("剩余 3 秒"))
        assertEquals("我的空间 · 工作", TransferFormatting.formatScopeBadge(running, mapOf("sp-1" to "我的空间")))

        val interrupted = running.copy(
            status = TransferStatus.PAUSED,
            errorMessage = "应用重启后中断，点击重试可继续",
        )
        assertTrue(TransferFormatting.formatStatusLine(interrupted).contains("应用重启后中断"))
        assertTrue(TransferFormatting.formatStatusLine(interrupted).contains("50%"))

        val failed = running.copy(status = TransferStatus.FAILED, errorMessage = "空间已满")
        assertEquals("失败 · 空间已满", TransferFormatting.formatStatusLine(failed))

        val downloadDone = running.copy(
            direction = TransferDirection.DOWNLOAD,
            status = TransferStatus.SUCCEEDED,
            transferredBytes = running.totalBytes,
        )
        assertTrue(TransferFormatting.formatStatusLine(downloadDone).startsWith("已保存到「下载」"))
    }

    private class FakeTransferManager(
        initialTasks: List<TransferTask>,
    ) : TransferManager {
        private val _tasks = MutableStateFlow(initialTasks)
        override val tasks: StateFlow<List<TransferTask>> = _tasks.asStateFlow()

        private val _activeCount = MutableStateFlow(initialTasks.count { it.isActive })
        override val activeCount: StateFlow<Int> = _activeCount.asStateFlow()

        val cancelledIds = mutableListOf<String>()
        val retriedIds = mutableListOf<String>()
        var clearCompletedCount = 0

        override suspend fun enqueueUploads(requests: List<UploadFileRequest>): List<String> = emptyList()
        override suspend fun enqueueStagedUploads(
            stagedFiles: List<StagedShareFile>,
            targetScope: TargetScope,
            groupName: String?,
        ): List<String> = emptyList()

        override suspend fun enqueueDownload(request: DownloadFileRequest): String = ""
        override suspend fun downloadForShare(item: ClipItem, targetScope: TargetScope): Result<Uri> =
            Result.failure(UnsupportedOperationException())

        override suspend fun cancel(taskId: String) {
            cancelledIds.add(taskId)
            updateTasks(_tasks.value.map { if (it.id == taskId) it.copy(status = TransferStatus.CANCELLED) else it })
        }

        override suspend fun retry(taskId: String) {
            retriedIds.add(taskId)
            updateTasks(
                _tasks.value.map {
                    if (it.id == taskId) it.copy(status = TransferStatus.QUEUED, errorMessage = null) else it
                },
            )
        }

        override suspend fun clearCompleted() {
            clearCompletedCount++
            updateTasks(
                _tasks.value.filterNot {
                    it.status == TransferStatus.SUCCEEDED || it.status == TransferStatus.CANCELLED
                },
            )
        }

        override suspend fun clearAllForScopeSwitch() {
            updateTasks(emptyList())
        }

        private fun updateTasks(next: List<TransferTask>) {
            _tasks.value = next
            _activeCount.value = next.count { it.isActive }
        }
    }
}
