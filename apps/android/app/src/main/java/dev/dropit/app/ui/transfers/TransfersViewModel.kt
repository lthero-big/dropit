package dev.dropit.app.ui.transfers

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import dev.dropit.app.core.network.ServerUrl
import dev.dropit.app.core.network.TargetScope
import dev.dropit.app.core.repository.TransferDirection
import dev.dropit.app.core.repository.TransferManager
import dev.dropit.app.core.repository.TransferStatus
import dev.dropit.app.core.repository.TransferTask
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.Locale
import kotlin.math.max
import kotlin.math.roundToInt

data class TransfersUiState(
    val tasks: List<TransferTask> = emptyList(),
    val activeCount: Int = 0,
    val completedCount: Int = 0,
    val failedCount: Int = 0,
    val busyTaskIds: Set<String> = emptySet(),
    val isClearingCompleted: Boolean = false,
    val snackbarMessage: String? = null,
) {
    val canClearCompleted: Boolean
        get() = completedCount > 0 && !isClearingCompleted
}

object TransferFormatting {
    fun formatSpeed(bytesPerSec: Long): String? {
        if (bytesPerSec <= 0L) return null
        return when {
            bytesPerSec < 1024L -> "$bytesPerSec B/s"
            bytesPerSec < 1024L * 1024L -> "${max(1L, bytesPerSec / 1024L)} KB/s"
            else -> String.format(Locale.US, "%.1f MB/s", bytesPerSec.toDouble() / (1024.0 * 1024.0))
        }
    }

    fun formatEta(etaSeconds: Long?): String? {
        if (etaSeconds == null || etaSeconds <= 0L) return null
        val hours = etaSeconds / 3600L
        val minutes = (etaSeconds % 3600L) / 60L
        val seconds = etaSeconds % 60L
        return when {
            hours > 0L -> "剩余 ${hours} 小时 ${minutes} 分"
            minutes > 0L -> if (seconds > 0L) "剩余 ${minutes} 分 ${seconds} 秒" else "剩余 ${minutes} 分"
            else -> "剩余 ${seconds} 秒"
        }
    }

    fun formatStatusLine(task: TransferTask): String {
        val percent = (task.progress * 100f).roundToInt().coerceIn(0, 100)
        return when (task.status) {
            TransferStatus.QUEUED -> {
                if (task.totalBytes > 0L) {
                    "等待中 · ${ServerUrl.formatSize(task.totalBytes)}"
                } else {
                    "等待中"
                }
            }

            TransferStatus.RUNNING -> {
                val isFinalizing = task.direction == TransferDirection.UPLOAD &&
                    task.totalBytes > 0L &&
                    task.transferredBytes >= task.totalBytes
                if (isFinalizing) {
                    "正在合片处理… · ${ServerUrl.formatSize(task.totalBytes)}"
                } else {
                    buildList {
                        add("$percent%")
                        if (task.totalBytes > 0L) {
                            add("${ServerUrl.formatSize(task.transferredBytes)} / ${ServerUrl.formatSize(task.totalBytes)}")
                        } else if (task.transferredBytes > 0L) {
                            add(ServerUrl.formatSize(task.transferredBytes))
                        }
                        formatSpeed(task.speedBytesPerSec)?.let { add(it) }
                        formatEta(task.etaSeconds)?.let { add(it) }
                    }.joinToString(" · ")
                }
            }

            TransferStatus.PAUSED -> {
                val reason = task.errorMessage?.takeIf { it.isNotBlank() }
                if (reason != null) {
                    "$reason · $percent%"
                } else {
                    "已暂停 · $percent% · 可断点续传"
                }
            }

            TransferStatus.FAILED -> {
                "失败 · ${task.errorMessage?.takeIf { it.isNotBlank() } ?: "传输中断，请点击重试"}"
            }

            TransferStatus.SUCCEEDED -> {
                val sizeText = if (task.totalBytes > 0L) " · ${ServerUrl.formatSize(task.totalBytes)}" else ""
                if (task.direction == TransferDirection.UPLOAD) {
                    "已发送$sizeText"
                } else {
                    "已保存到「下载」$sizeText"
                }
            }

            TransferStatus.CANCELLED -> "已取消"
        }
    }

    fun formatScopeBadge(
        task: TransferTask,
        spaceNames: Map<String, String> = emptyMap(),
    ): String {
        val scopeBase = when (val scope = task.targetScope) {
            is TargetScope.SpaceScope -> spaceNames[scope.spaceId]?.takeIf { it.isNotBlank() } ?: "私人空间"
            is TargetScope.RoomScope -> "临时房间"
        }
        val group = task.groupName?.takeIf { it.isNotBlank() }
        return if (group != null) "$scopeBase · $group" else scopeBase
    }
}

class TransfersViewModel(
    private val transferManager: TransferManager,
    private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
) : ViewModel() {

    private val _uiState = MutableStateFlow(TransfersUiState())
    val uiState: StateFlow<TransfersUiState> = _uiState.asStateFlow()

    init {
        observeTransfers()
    }

    private fun observeTransfers() {
        viewModelScope.launch {
            transferManager.tasks.collect { tasks ->
                val completed = tasks.count {
                    it.status == TransferStatus.SUCCEEDED || it.status == TransferStatus.CANCELLED
                }
                val failed = tasks.count { it.status == TransferStatus.FAILED }
                val activeFromList = tasks.count { it.isActive }
                _uiState.update { current ->
                    current.copy(
                        tasks = tasks,
                        activeCount = max(current.activeCount, activeFromList).let {
                            if (tasks.isEmpty()) 0 else activeFromList
                        },
                        completedCount = completed,
                        failedCount = failed,
                    )
                }
            }
        }
        viewModelScope.launch {
            transferManager.activeCount.collect { count ->
                _uiState.update { it.copy(activeCount = count) }
            }
        }
    }

    fun cancelTask(taskId: String) {
        if (taskId in _uiState.value.busyTaskIds) return
        _uiState.update { it.copy(busyTaskIds = it.busyTaskIds + taskId) }
        viewModelScope.launch {
            try {
                withContext(ioDispatcher) {
                    transferManager.cancel(taskId)
                }
                _uiState.update {
                    it.copy(
                        busyTaskIds = it.busyTaskIds - taskId,
                        snackbarMessage = "已取消传输任务",
                    )
                }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        busyTaskIds = it.busyTaskIds - taskId,
                        snackbarMessage = e.message?.takeIf { m -> m.isNotBlank() } ?: "取消任务失败",
                    )
                }
            }
        }
    }

    fun retryTask(taskId: String) {
        if (taskId in _uiState.value.busyTaskIds) return
        _uiState.update { it.copy(busyTaskIds = it.busyTaskIds + taskId) }
        viewModelScope.launch {
            try {
                withContext(ioDispatcher) {
                    transferManager.retry(taskId)
                }
                _uiState.update {
                    it.copy(
                        busyTaskIds = it.busyTaskIds - taskId,
                        snackbarMessage = "已重新加入传输队列",
                    )
                }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        busyTaskIds = it.busyTaskIds - taskId,
                        snackbarMessage = e.message?.takeIf { m -> m.isNotBlank() } ?: "重试任务失败",
                    )
                }
            }
        }
    }

    fun clearCompleted() {
        if (!_uiState.value.canClearCompleted) return
        _uiState.update { it.copy(isClearingCompleted = true) }
        viewModelScope.launch {
            try {
                withContext(ioDispatcher) {
                    transferManager.clearCompleted()
                }
                _uiState.update {
                    it.copy(
                        isClearingCompleted = false,
                        snackbarMessage = "已清理已完成的记录",
                    )
                }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        isClearingCompleted = false,
                        snackbarMessage = e.message?.takeIf { m -> m.isNotBlank() } ?: "清理失败",
                    )
                }
            }
        }
    }

    fun clearSnackbar() {
        _uiState.update { it.copy(snackbarMessage = null) }
    }

    class Factory(
        private val transferManager: TransferManager,
    ) : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <T : ViewModel> create(modelClass: Class<T>): T {
            return TransfersViewModel(transferManager = transferManager) as T
        }
    }
}
