package dev.dropit.app.ui.share

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.MeetingRoom
import androidx.compose.material.icons.rounded.Person
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.dropit.app.core.network.ServerUrl
import dev.dropit.app.core.repository.StagedShareFile
import dev.dropit.app.ui.board.ClipFormatting
import dev.dropit.app.ui.theme.DropitMonoTypography
import dev.dropit.app.ui.theme.DropitTheme
import dev.dropit.app.ui.theme.groupDotColor

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun ShareTargetSheet(
    state: ShareTargetUiState,
    maxTextBytes: Long = 0L,
    isLoadingSpaces: Boolean = false,
    spacesLoadError: String? = null,
    onRetryLoadSpaces: () -> Unit = {},
    onSelectTarget: (ShareDestination) -> Unit,
    onSelectGroup: (String?) -> Unit,
    onTextChanged: (String) -> Unit,
    onRemoveFile: (String) -> Unit,
    onConfirmSend: () -> Unit,
    onCancel: () -> Unit,
) {
    val pending = state.pendingShare ?: return
    val colors = DropitTheme.colors
    val shapes = DropitTheme.shapes
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val textByteCount = remember(state.editedText) { ClipFormatting.utf8ByteCount(state.editedText) }
    val isTextOverLimit = maxTextBytes > 0L && textByteCount > maxTextBytes

    ModalBottomSheet(
        onDismissRequest = {
            if (!state.isSubmitting) onCancel()
        },
        sheetState = sheetState,
        shape = shapes.sheet,
        containerColor = colors.surface1,
        contentColor = colors.fg,
        tonalElevation = 0.dp,
        scrimColor = MaterialTheme.colorScheme.scrim,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .navigationBarsPadding()
                .imePadding()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp)
                .padding(bottom = 20.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            // Header
            Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text(
                    text = "发送到 dropit",
                    style = MaterialTheme.typography.titleMedium,
                    color = colors.fg,
                )
                Text(
                    text = "确认目标空间与内容后再发送，避免误发到其他空间。",
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.fg3,
                )
            }

            // Target Space / Room Picker
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                FlowRow(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    Text(
                        text = "目标空间 / 临时房间",
                        style = MaterialTheme.typography.labelMedium,
                        color = colors.fg2,
                    )
                    if (state.excludedReadOnlyCount > 0) {
                        Text(
                            text = "已自动隐藏 ${state.excludedReadOnlyCount} 个只读空间",
                            style = MaterialTheme.typography.labelSmall,
                            color = colors.fg3,
                        )
                    }
                }

                if (state.availableTargets.isEmpty()) {
                    Surface(
                        modifier = Modifier
                            .fillMaxWidth()
                            .semantics { liveRegion = LiveRegionMode.Polite },
                        shape = shapes.md,
                        color = colors.warnSoft,
                        border = BorderStroke(1.dp, colors.warn.copy(alpha = 0.35f)),
                        tonalElevation = 0.dp,
                    ) {
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(horizontal = 12.dp, vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            Text(
                                text = when {
                                    isLoadingSpaces -> "正在加载可写入空间…"
                                    !spacesLoadError.isNullOrBlank() -> "无法加载空间：$spacesLoadError"
                                    else -> "暂无可写入的空间（仅只读空间不可接收分享）"
                                },
                                style = MaterialTheme.typography.bodySmall,
                                color = colors.fg,
                                modifier = Modifier.weight(1f),
                            )
                            if (!isLoadingSpaces) {
                                TextButton(
                                    onClick = onRetryLoadSpaces,
                                    modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                                    colors = ButtonDefaults.textButtonColors(contentColor = colors.warn),
                                ) {
                                    Text("重试", fontWeight = FontWeight.SemiBold)
                                }
                            }
                        }
                    }
                } else {
                    FlowRow(
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        state.availableTargets.forEach { target ->
                            val selected = state.selectedTarget?.scope == target.scope
                            Surface(
                                modifier = Modifier
                                    .defaultMinSize(minHeight = 48.dp)
                                    .clickable(enabled = !state.isSubmitting) {
                                        onSelectTarget(target)
                                    },
                                shape = shapes.md,
                                color = if (selected) colors.fg else colors.surface0,
                                border = BorderStroke(1.dp, if (selected) colors.fg else colors.line2),
                                tonalElevation = 0.dp,
                            ) {
                                Row(
                                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                                ) {
                                    Icon(
                                        imageVector = if (target is ShareDestination.RoomDestination) {
                                            Icons.Rounded.MeetingRoom
                                        } else {
                                            Icons.Rounded.Person
                                        },
                                        contentDescription = null,
                                        tint = if (selected) colors.bg else colors.fg2,
                                        modifier = Modifier.size(16.dp),
                                    )
                                    Text(
                                        text = target.label,
                                        style = MaterialTheme.typography.labelMedium,
                                        color = if (selected) colors.bg else colors.fg,
                                        fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Medium,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                    Text(
                                        text = target.badge,
                                        style = MaterialTheme.typography.labelSmall,
                                        color = if (selected) colors.bg.copy(alpha = 0.78f) else colors.fg3,
                                    )
                                }
                            }
                        }
                    }
                }
            }

            // Target Group Picker
            if (state.availableGroups.isNotEmpty()) {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(
                        text = "目标分组",
                        style = MaterialTheme.typography.labelMedium,
                        color = colors.fg2,
                    )
                    FlowRow(
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                        verticalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        ShareGroupPill(
                            label = "未分组",
                            dotColor = null,
                            selected = state.selectedGroup == null,
                            enabled = !state.isSubmitting,
                            onClick = { onSelectGroup(null) },
                        )
                        state.availableGroups.forEach { groupName ->
                            ShareGroupPill(
                                label = groupName,
                                dotColor = groupDotColor(groupName, colors.isDark, colors.fg4),
                                selected = state.selectedGroup == groupName,
                                enabled = !state.isSubmitting,
                                onClick = { onSelectGroup(groupName) },
                            )
                        }
                    }
                }
            }

            // Editable Shared Text (shown whenever share has text or no files remain)
            if (pending.text != null || state.editedText.isNotEmpty() || state.files.isEmpty()) {
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    OutlinedTextField(
                        value = state.editedText,
                        onValueChange = onTextChanged,
                        enabled = !state.isSubmitting,
                        modifier = Modifier
                            .fillMaxWidth()
                            .defaultMinSize(minHeight = 96.dp),
                        label = { Text("分享文本（可编辑）") },
                        placeholder = { Text("输入要发送的文本…", color = colors.fg4) },
                        isError = isTextOverLimit,
                        maxLines = 6,
                        shape = shapes.md,
                        textStyle = MaterialTheme.typography.bodyLarge.copy(color = colors.fg),
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedContainerColor = colors.surface0,
                            unfocusedContainerColor = colors.surface0,
                            focusedBorderColor = colors.line3,
                            unfocusedBorderColor = colors.line2,
                            errorBorderColor = colors.destructive,
                            cursorColor = colors.brand,
                        ),
                    )
                    if (maxTextBytes > 0L && state.editedText.isNotEmpty()) {
                        Text(
                            text = if (isTextOverLimit) {
                                "文本超出限制（${ServerUrl.formatSize(textByteCount.toLong())} / ${ServerUrl.formatSize(maxTextBytes)}）"
                            } else {
                                "${ServerUrl.formatSize(textByteCount.toLong())} / ${ServerUrl.formatSize(maxTextBytes)}"
                            },
                            style = DropitMonoTypography.meta,
                            color = if (isTextOverLimit) colors.destructive else colors.fg3,
                        )
                    }
                }
            }

            // Staged Files List
            if (state.files.isNotEmpty()) {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            text = "待发送文件（${state.files.size} 个）",
                            style = MaterialTheme.typography.labelMedium,
                            color = colors.fg2,
                        )
                        Text(
                            text = "共 ${ServerUrl.formatSize(state.totalFileBytes)}",
                            style = DropitMonoTypography.meta,
                            color = colors.fg3,
                        )
                    }

                    Surface(
                        modifier = Modifier
                            .fillMaxWidth()
                            .heightIn(max = 220.dp),
                        shape = shapes.md,
                        color = colors.surface0,
                        border = BorderStroke(1.dp, colors.line1),
                        tonalElevation = 0.dp,
                    ) {
                        Column(
                            modifier = Modifier
                                .fillMaxWidth()
                                .verticalScroll(rememberScrollState()),
                        ) {
                            state.files.forEachIndexed { index, file ->
                                StagedFileRow(
                                    file = file,
                                    enabled = !state.isSubmitting,
                                    onRemove = { onRemoveFile(file.id) },
                                )
                                if (index < state.files.lastIndex) {
                                    HorizontalDivider(thickness = 1.dp, color = colors.line1)
                                }
                            }
                        }
                    }
                }
            }

            // Error banner
            state.errorMessage?.let { err ->
                Surface(
                    modifier = Modifier
                        .fillMaxWidth()
                        .semantics { liveRegion = LiveRegionMode.Polite },
                    shape = shapes.md,
                    color = colors.brandSoft,
                    border = BorderStroke(1.dp, colors.destructive.copy(alpha = 0.35f)),
                    tonalElevation = 0.dp,
                ) {
                    Text(
                        text = err,
                        style = MaterialTheme.typography.bodySmall,
                        color = colors.destructive,
                        modifier = Modifier.padding(12.dp),
                    )
                }
            }

            // Bottom Actions
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                TextButton(
                    onClick = onCancel,
                    enabled = !state.isSubmitting,
                    modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                    colors = ButtonDefaults.textButtonColors(contentColor = colors.fg2),
                ) {
                    Text("取消")
                }
                Spacer(modifier = Modifier.weight(1f))
                Button(
                    onClick = onConfirmSend,
                    enabled = state.canSubmit && !isTextOverLimit,
                    modifier = Modifier.defaultMinSize(minWidth = 120.dp, minHeight = 48.dp),
                    shape = shapes.md,
                    colors = ButtonDefaults.buttonColors(
                        containerColor = colors.brand,
                        contentColor = colors.brandFg,
                        disabledContainerColor = colors.brand.copy(alpha = 0.4f),
                        disabledContentColor = colors.brandFg,
                    ),
                ) {
                    if (state.isSubmitting) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(16.dp),
                            strokeWidth = 2.dp,
                            color = colors.brandFg,
                        )
                    } else {
                        Text(
                            text = "确认发送",
                            fontWeight = FontWeight.SemiBold,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun StagedFileRow(
    file: StagedShareFile,
    enabled: Boolean,
    onRemove: () -> Unit,
) {
    val colors = DropitTheme.colors
    val shapes = DropitTheme.shapes
    val fontScale = LocalDensity.current.fontScale
    val badge = remember(file.displayName, file.mimeType) {
        ClipFormatting.resolveFileTypeBadge(file.displayName, file.mimeType)
    }
    val maxNameChars = if (fontScale >= 1.3f) 18 else 24
    val displayName = remember(file.displayName, maxNameChars) {
        ClipFormatting.middleEllipsizeFilename(file.displayName, maxChars = maxNameChars)
    }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = 12.dp, end = 4.dp, top = 6.dp, bottom = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Surface(
            shape = shapes.xs,
            color = badge.tint,
            tonalElevation = 0.dp,
        ) {
            Text(
                text = badge.ext,
                style = DropitMonoTypography.meta,
                color = Color.White,
                modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
            )
        }
        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            Text(
                text = displayName,
                style = MaterialTheme.typography.bodyMedium,
                color = colors.fg,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = ServerUrl.formatSize(file.sizeBytes),
                style = DropitMonoTypography.meta,
                color = colors.fg3,
            )
        }
        IconButton(
            onClick = onRemove,
            enabled = enabled,
            modifier = Modifier.size(48.dp),
        ) {
            Icon(
                imageVector = Icons.Rounded.Close,
                contentDescription = "移除文件 ${file.displayName}",
                tint = colors.fg3,
                modifier = Modifier.size(18.dp),
            )
        }
    }
}

@Composable
private fun ShareGroupPill(
    label: String,
    dotColor: Color?,
    selected: Boolean,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    val colors = DropitTheme.colors
    val shapes = DropitTheme.shapes
    Box(
        modifier = Modifier
            .defaultMinSize(minWidth = 48.dp, minHeight = 48.dp)
            .clip(shapes.pill)
            .clickable(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Surface(
            shape = shapes.pill,
            color = if (selected) colors.fg else colors.surface0,
            border = BorderStroke(1.dp, if (selected) colors.fg else colors.line2),
            tonalElevation = 0.dp,
        ) {
            Row(
                modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                if (dotColor != null) {
                    Box(
                        modifier = Modifier
                            .size(7.dp)
                            .clip(CircleShape)
                            .background(dotColor),
                    )
                }
                Text(
                    text = label,
                    style = MaterialTheme.typography.labelMedium,
                    color = if (selected) colors.bg else colors.fg2,
                )
            }
        }
    }
}
