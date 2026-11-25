package dev.dropit.app.ui.transfers

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.widget.Toast
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.displayCutoutPadding
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.OpenInNew
import androidx.compose.material.icons.rounded.ArrowDownward
import androidx.compose.material.icons.rounded.ArrowUpward
import androidx.compose.material.icons.rounded.CleaningServices
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Share
import androidx.compose.material.icons.rounded.SwapVert
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.dropit.app.core.repository.TransferDirection
import dev.dropit.app.core.repository.TransferStatus
import dev.dropit.app.core.repository.TransferTask
import dev.dropit.app.ui.board.ClipFormatting
import dev.dropit.app.ui.theme.DropitElevation
import dev.dropit.app.ui.theme.DropitMonoTypography
import dev.dropit.app.ui.theme.DropitTheme

@Composable
fun TransfersScreen(
    viewModel: TransfersViewModel,
    spaceNames: Map<String, String> = emptyMap(),
    modifier: Modifier = Modifier,
) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    val colors = DropitTheme.colors
    val shapes = DropitTheme.shapes
    val context = LocalContext.current
    val snackbarHostState = remember { SnackbarHostState() }

    LaunchedEffect(state.snackbarMessage) {
        val message = state.snackbarMessage ?: return@LaunchedEffect
        snackbarHostState.showSnackbar(
            message = message,
            duration = SnackbarDuration.Short,
        )
        viewModel.clearSnackbar()
    }

    Box(
        modifier = modifier
            .fillMaxSize()
            .background(colors.bg),
    ) {
        Column(modifier = Modifier.fillMaxSize()) {
            // Top Header (surface0 + Edge-to-Edge safe area)
            Surface(
                modifier = Modifier.fillMaxWidth(),
                color = colors.surface0,
                tonalElevation = 0.dp,
            ) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .statusBarsPadding()
                        .displayCutoutPadding()
                        .padding(start = 16.dp, end = 8.dp, top = 8.dp, bottom = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        modifier = Modifier.weight(1f),
                    ) {
                        Text(
                            text = "传输队列",
                            style = MaterialTheme.typography.titleLarge,
                            color = colors.fg,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        if (state.activeCount > 0) {
                            Surface(
                                shape = shapes.pill,
                                color = colors.brandSoft,
                                tonalElevation = 0.dp,
                            ) {
                                Text(
                                    text = "${state.activeCount} 项进行中",
                                    style = DropitMonoTypography.meta,
                                    color = colors.brand,
                                    modifier = Modifier.padding(horizontal = 8.dp, vertical = 3.dp),
                                )
                            }
                        }
                    }

                    if (state.completedCount > 0) {
                        TextButton(
                            onClick = viewModel::clearCompleted,
                            enabled = state.canClearCompleted,
                            modifier = Modifier
                                .defaultMinSize(minHeight = 48.dp)
                                .semantics { contentDescription = "清理已完成的传输记录" },
                            colors = ButtonDefaults.textButtonColors(contentColor = colors.fg2),
                        ) {
                            Icon(
                                imageVector = Icons.Rounded.CleaningServices,
                                contentDescription = null,
                                modifier = Modifier.size(16.dp),
                            )
                            Spacer(modifier = Modifier.width(5.dp))
                            Text(
                                text = "清理已完成",
                                style = MaterialTheme.typography.labelMedium,
                            )
                        }
                    }
                }
            }
            HorizontalDivider(thickness = 1.dp, color = colors.line1)

            if (state.tasks.isEmpty()) {
                TransfersEmptyState()
            } else {
                LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(14.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    items(
                        items = state.tasks,
                        key = { it.id },
                    ) { task ->
                        TransferTaskCard(
                            task = task,
                            scopeLabel = TransferFormatting.formatScopeBadge(task, spaceNames),
                            isBusy = task.id in state.busyTaskIds,
                            onCancel = { viewModel.cancelTask(task.id) },
                            onRetry = { viewModel.retryTask(task.id) },
                            onOpenDownloaded = { uriStr ->
                                openDownloadedUri(context, uriStr, task.mimeType)
                            },
                            onShareDownloaded = { uriStr ->
                                shareDownloadedUri(context, uriStr, task.mimeType)
                            },
                            modifier = Modifier.animateItem(),
                        )
                    }
                }
            }
        }

        SnackbarHost(
            hostState = snackbarHostState,
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .padding(bottom = 12.dp),
        )
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun TransferTaskCard(
    task: TransferTask,
    scopeLabel: String,
    isBusy: Boolean,
    onCancel: () -> Unit,
    onRetry: () -> Unit,
    onOpenDownloaded: (String) -> Unit,
    onShareDownloaded: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = DropitTheme.colors
    val shapes = DropitTheme.shapes
    val isUpload = task.direction == TransferDirection.UPLOAD
    val displayName = remember(task.fileName) {
        ClipFormatting.middleEllipsizeFilename(task.fileName.ifBlank { "未命名文件" }, maxChars = 40)
    }
    val statusLine = remember(
        task.status,
        task.transferredBytes,
        task.totalBytes,
        task.speedBytesPerSec,
        task.etaSeconds,
        task.errorMessage,
        task.direction,
    ) {
        TransferFormatting.formatStatusLine(task)
    }

    val cardBorder = when (task.status) {
        TransferStatus.FAILED -> colors.destructive.copy(alpha = 0.55f)
        TransferStatus.SUCCEEDED -> colors.ok.copy(alpha = 0.45f)
        else -> colors.line1
    }

    val progressColor = when (task.status) {
        TransferStatus.SUCCEEDED -> colors.ok
        TransferStatus.FAILED -> colors.destructive
        TransferStatus.PAUSED -> colors.fg4
        TransferStatus.CANCELLED -> colors.fg4
        else -> colors.brand
    }

    val isIndeterminate = task.status == TransferStatus.RUNNING &&
        (task.totalBytes <= 0L || (isUpload && task.transferredBytes >= task.totalBytes))

    Surface(
        modifier = modifier
            .fillMaxWidth()
            .semantics {
                if (task.status == TransferStatus.FAILED) {
                    liveRegion = LiveRegionMode.Polite
                }
            },
        shape = shapes.md,
        color = colors.surface1,
        border = BorderStroke(1.dp, cardBorder),
        shadowElevation = DropitElevation.card(colors.isDark),
        tonalElevation = 0.dp,
    ) {
        Column(modifier = Modifier.fillMaxWidth()) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 14.dp, vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                // Top row: direction badge + filename + scope pill
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    Box(
                        modifier = Modifier
                            .size(34.dp)
                            .clip(CircleShape)
                            .background(if (isUpload) colors.brandSoft else colors.okSoft),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(
                            imageVector = if (isUpload) Icons.Rounded.ArrowUpward else Icons.Rounded.ArrowDownward,
                            contentDescription = if (isUpload) "上传任务" else "下载任务",
                            tint = if (isUpload) colors.brand else colors.ok,
                            modifier = Modifier.size(18.dp),
                        )
                    }

                    Column(
                        modifier = Modifier.weight(1f),
                        verticalArrangement = Arrangement.spacedBy(3.dp),
                    ) {
                        Text(
                            text = displayName,
                            style = MaterialTheme.typography.bodyMedium,
                            fontWeight = FontWeight.Medium,
                            color = colors.fg,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                        )
                        Surface(
                            shape = shapes.pill,
                            color = colors.surface0,
                            border = BorderStroke(1.dp, colors.line2),
                            tonalElevation = 0.dp,
                        ) {
                            Text(
                                text = scopeLabel,
                                style = MaterialTheme.typography.labelSmall,
                                color = colors.fg3,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.padding(horizontal = 7.dp, vertical = 2.dp),
                            )
                        }
                    }
                }

                // Progress bar
                if (isIndeterminate) {
                    LinearProgressIndicator(
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(4.dp)
                            .clip(shapes.xs),
                        color = progressColor,
                        trackColor = colors.surface2,
                    )
                } else {
                    LinearProgressIndicator(
                        progress = {
                            if (task.status == TransferStatus.SUCCEEDED) 1f else task.progress
                        },
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(4.dp)
                            .clip(shapes.xs),
                        color = progressColor,
                        trackColor = colors.surface2,
                    )
                }

                // Status & metrics line (tabular monospace)
                Text(
                    text = statusLine,
                    style = DropitMonoTypography.meta,
                    color = when (task.status) {
                        TransferStatus.FAILED -> colors.destructive
                        TransferStatus.SUCCEEDED -> colors.ok
                        else -> colors.fg3
                    },
                )
            }

            // Action strip when actionable
            val hasDownloadResult = task.status == TransferStatus.SUCCEEDED &&
                task.direction == TransferDirection.DOWNLOAD &&
                !task.localResultUri.isNullOrBlank()
            val showActions = task.status == TransferStatus.QUEUED ||
                task.status == TransferStatus.RUNNING ||
                task.status == TransferStatus.PAUSED ||
                task.status == TransferStatus.FAILED ||
                hasDownloadResult

            if (showActions) {
                HorizontalDivider(thickness = 1.dp, color = colors.line1)
                FlowRow(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 6.dp),
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    if (task.status == TransferStatus.PAUSED || task.status == TransferStatus.FAILED) {
                        TextButton(
                            onClick = onRetry,
                            enabled = !isBusy,
                            modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                            colors = ButtonDefaults.textButtonColors(contentColor = colors.brand),
                        ) {
                            Icon(
                                imageVector = Icons.Rounded.Refresh,
                                contentDescription = null,
                                modifier = Modifier.size(16.dp),
                            )
                            Spacer(modifier = Modifier.width(5.dp))
                            Text(
                                text = if (task.status == TransferStatus.PAUSED) "继续传输" else "重试",
                                style = MaterialTheme.typography.labelMedium,
                                fontWeight = FontWeight.SemiBold,
                            )
                        }
                    }

                    if (task.status == TransferStatus.QUEUED ||
                        task.status == TransferStatus.RUNNING ||
                        task.status == TransferStatus.PAUSED ||
                        task.status == TransferStatus.FAILED
                    ) {
                        TextButton(
                            onClick = onCancel,
                            enabled = !isBusy,
                            modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                            colors = ButtonDefaults.textButtonColors(contentColor = colors.destructive),
                        ) {
                            Icon(
                                imageVector = Icons.Rounded.Close,
                                contentDescription = null,
                                modifier = Modifier.size(16.dp),
                            )
                            Spacer(modifier = Modifier.width(5.dp))
                            Text(
                                text = if (task.status == TransferStatus.FAILED) "移除" else "取消",
                                style = MaterialTheme.typography.labelMedium,
                            )
                        }
                    }

                    if (hasDownloadResult) {
                        val resultUri = task.localResultUri.orEmpty()
                        TextButton(
                            onClick = { onOpenDownloaded(resultUri) },
                            modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                            colors = ButtonDefaults.textButtonColors(contentColor = colors.fg2),
                        ) {
                            Icon(
                                imageVector = Icons.AutoMirrored.Rounded.OpenInNew,
                                contentDescription = null,
                                modifier = Modifier.size(16.dp),
                            )
                            Spacer(modifier = Modifier.width(5.dp))
                            Text(
                                text = "打开",
                                style = MaterialTheme.typography.labelMedium,
                            )
                        }
                        TextButton(
                            onClick = { onShareDownloaded(resultUri) },
                            modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                            colors = ButtonDefaults.textButtonColors(contentColor = colors.fg2),
                        ) {
                            Icon(
                                imageVector = Icons.Rounded.Share,
                                contentDescription = null,
                                modifier = Modifier.size(16.dp),
                            )
                            Spacer(modifier = Modifier.width(5.dp))
                            Text(
                                text = "分享",
                                style = MaterialTheme.typography.labelMedium,
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun TransfersEmptyState() {
    val colors = DropitTheme.colors
    Box(
        modifier = Modifier
            .fillMaxSize()
            .padding(32.dp),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Icon(
                imageVector = Icons.Rounded.SwapVert,
                contentDescription = null,
                tint = colors.fg4,
                modifier = Modifier.size(44.dp),
            )
            Text(
                text = "暂无传输任务",
                style = MaterialTheme.typography.titleMedium,
                color = colors.fg,
            )
            Text(
                text = "发送大文件或下载文件时会在这里显示实时进度、速度与断点续传状态。",
                style = MaterialTheme.typography.bodySmall,
                color = colors.fg3,
            )
        }
    }
}

private fun openDownloadedUri(context: Context, uriStr: String, mimeType: String) {
    val uri = runCatching { Uri.parse(uriStr) }.getOrNull() ?: return
    val intent = Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(uri, mimeType.ifBlank { "*/*" })
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    runCatching {
        context.startActivity(intent)
    }.onFailure {
        Toast.makeText(context, "未找到可打开此文件的应用", Toast.LENGTH_SHORT).show()
    }
}

private fun shareDownloadedUri(context: Context, uriStr: String, mimeType: String) {
    val uri = runCatching { Uri.parse(uriStr) }.getOrNull() ?: return
    val intent = Intent(Intent.ACTION_SEND).apply {
        type = mimeType.ifBlank { "*/*" }
        putExtra(Intent.EXTRA_STREAM, uri)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
    runCatching {
        context.startActivity(Intent.createChooser(intent, "分享文件"))
    }.onFailure {
        Toast.makeText(context, "未找到可接收分享的应用", Toast.LENGTH_SHORT).show()
    }
}
