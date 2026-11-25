package dev.dropit.app.ui.board

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
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.ContentCopy
import androidx.compose.material.icons.rounded.DeleteOutline
import androidx.compose.material.icons.rounded.Download
import androidx.compose.material.icons.rounded.Edit
import androidx.compose.material.icons.rounded.Folder
import androidx.compose.material.icons.rounded.Label
import androidx.compose.material.icons.rounded.Link
import androidx.compose.material.icons.rounded.Lock
import androidx.compose.material.icons.rounded.MeetingRoom
import androidx.compose.material.icons.rounded.Person
import androidx.compose.material.icons.rounded.PushPin
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.dropit.app.core.network.ClipItem
import dev.dropit.app.core.network.OptionalField
import dev.dropit.app.core.network.ServerUrl
import dev.dropit.app.core.network.Space
import dev.dropit.app.ui.theme.DropitMonoTypography
import dev.dropit.app.ui.theme.DropitTheme
import dev.dropit.app.ui.theme.groupDotColor

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SpaceSwitcherSheet(
    spaces: List<Space>,
    activeSpaceId: String?,
    currentUserId: String?,
    onSelectSpace: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    val colors = DropitTheme.colors
    val shapes = DropitTheme.shapes
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)

    ModalBottomSheet(
        onDismissRequest = onDismiss,
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
                .padding(horizontal = 20.dp)
                .padding(bottom = 20.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text(
                text = "切换空间",
                style = MaterialTheme.typography.titleMedium,
                color = colors.fg,
            )

            if (spaces.isEmpty()) {
                Text(
                    text = "暂无可用空间，请检查网络后重试。",
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.fg3,
                    modifier = Modifier.padding(vertical = 8.dp),
                )
            } else {
                spaces.forEach { space ->
                    val isSelected = space.id == activeSpaceId
                    val isPersonal = currentUserId != null && space.isPersonalFor(currentUserId)
                    val roleLabel = when {
                        isPersonal -> "我的"
                        space.isReadOnly -> "受邀 · 只读"
                        else -> "受邀 · 可编辑"
                    }
                    Surface(
                        modifier = Modifier
                            .fillMaxWidth()
                            .defaultMinSize(minHeight = 56.dp)
                            .clickable {
                                onSelectSpace(space.id)
                                onDismiss()
                            },
                        shape = shapes.md,
                        color = if (isSelected) colors.surface2 else colors.surface0,
                        border = BorderStroke(1.dp, if (isSelected) colors.line3 else colors.line1),
                        tonalElevation = 0.dp,
                    ) {
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(horizontal = 14.dp, vertical = 12.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            Icon(
                                imageVector = if (space.isReadOnly) Icons.Rounded.Lock else Icons.Rounded.Person,
                                contentDescription = null,
                                tint = if (space.isReadOnly) colors.warn else colors.fg2,
                                modifier = Modifier.size(20.dp),
                            )
                            Column(
                                modifier = Modifier.weight(1f),
                                verticalArrangement = Arrangement.spacedBy(2.dp),
                            ) {
                                Text(
                                    text = space.name.ifBlank { if (isPersonal) "我的空间" else "共享空间" },
                                    style = MaterialTheme.typography.bodyMedium,
                                    fontWeight = FontWeight.SemiBold,
                                    color = colors.fg,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                                val subtitle = buildString {
                                    append(roleLabel)
                                    if (!isPersonal && !space.ownerName.isNullOrBlank()) {
                                        append(" · 来自 ${space.ownerName}")
                                    }
                                }
                                Text(
                                    text = subtitle,
                                    style = MaterialTheme.typography.labelSmall,
                                    color = if (space.isReadOnly) colors.warn else colors.fg3,
                                )
                            }
                            if (isSelected) {
                                Icon(
                                    imageVector = Icons.Rounded.Check,
                                    contentDescription = "当前空间",
                                    tint = colors.brand,
                                    modifier = Modifier.size(20.dp),
                                )
                            }
                        }
                    }
                }
            }

            HorizontalDivider(thickness = 1.dp, color = colors.line1, modifier = Modifier.padding(vertical = 4.dp))

            // Stage 3B placeholder section for Temporary Rooms
            Surface(
                modifier = Modifier.fillMaxWidth(),
                shape = shapes.md,
                color = colors.surface0,
                border = BorderStroke(1.dp, colors.line1),
                tonalElevation = 0.dp,
            ) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 14.dp, vertical = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    Icon(
                        imageVector = Icons.Rounded.MeetingRoom,
                        contentDescription = null,
                        tint = colors.fg3,
                        modifier = Modifier.size(20.dp),
                    )
                    Column(modifier = Modifier.weight(1f)) {
                        Text(
                            text = "临时房间",
                            style = MaterialTheme.typography.bodyMedium,
                            color = colors.fg2,
                        )
                        Text(
                            text = "创建与加入临时房间将于下一阶段补齐",
                            style = MaterialTheme.typography.labelSmall,
                            color = colors.fg4,
                        )
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ItemMoreActionsSheet(
    item: ClipItem,
    isReadOnly: Boolean,
    nowMs: Long,
    onCopy: () -> Unit,
    onDownload: () -> Unit,
    onEditText: () -> Unit,
    onTogglePin: () -> Unit,
    onEditLabelsAndGroup: () -> Unit,
    onShareLinkPlaceholder: () -> Unit,
    onRequestRetract: () -> Unit,
    onDismiss: () -> Unit,
) {
    val colors = DropitTheme.colors
    val shapes = DropitTheme.shapes
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val expiry = remember(item.expiresAt, nowMs) { ClipFormatting.formatRemainingExpiry(item.expiresAt, nowMs) }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
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
                .padding(bottom = 16.dp),
        ) {
            // Item Summary Header
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 20.dp, vertical = 6.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                val summaryTitle = if (item.isText) {
                    item.text.orEmpty().trim().lineSequence().firstOrNull().orEmpty().ifBlank { "文本内容" }
                } else {
                    ClipFormatting.middleEllipsizeFilename(item.filename ?: "文件", 38)
                }
                Text(
                    text = summaryTitle,
                    style = MaterialTheme.typography.titleMedium,
                    color = colors.fg,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                val metaParts = buildList {
                    add(if (item.isText) "文本" else "文件")
                    if (item.size > 0L) add(ServerUrl.formatSize(item.size))
                    expiry?.let { add(it.label) }
                    if (isReadOnly) add("只读空间")
                }.joinToString(" · ")
                Text(
                    text = metaParts,
                    style = DropitMonoTypography.meta,
                    color = colors.fg3,
                )
            }

            HorizontalDivider(thickness = 1.dp, color = colors.line1, modifier = Modifier.padding(vertical = 8.dp))

            if (item.isText) {
                SheetActionRow(
                    icon = Icons.Rounded.ContentCopy,
                    label = "复制内容",
                    tint = colors.fg,
                    onClick = {
                        onDismiss()
                        onCopy()
                    },
                )
            } else {
                SheetActionRow(
                    icon = Icons.Rounded.Download,
                    label = "保存到下载目录",
                    tint = colors.fg,
                    onClick = {
                        onDismiss()
                        onDownload()
                    },
                )
            }

            if (!isReadOnly) {
                if (item.isText) {
                    SheetActionRow(
                        icon = Icons.Rounded.Edit,
                        label = "编辑文本",
                        tint = colors.fg,
                        onClick = {
                            onDismiss()
                            onEditText()
                        },
                    )
                }

                SheetActionRow(
                    icon = Icons.Rounded.PushPin,
                    label = if (item.pinned) "取消置顶" else "置顶这条内容",
                    tint = colors.fg,
                    onClick = {
                        onDismiss()
                        onTogglePin()
                    },
                )

                SheetActionRow(
                    icon = Icons.Rounded.Label,
                    label = "修改分组与标签",
                    tint = colors.fg,
                    onClick = {
                        onDismiss()
                        onEditLabelsAndGroup()
                    },
                )

                SheetActionRow(
                    icon = Icons.Rounded.Link,
                    label = "生成单项分享链接",
                    subtitle = "完整分享管理面板将在下一阶段接入",
                    tint = colors.fg2,
                    onClick = {
                        onDismiss()
                        onShareLinkPlaceholder()
                    },
                )

                HorizontalDivider(thickness = 1.dp, color = colors.line1, modifier = Modifier.padding(vertical = 6.dp))

                SheetActionRow(
                    icon = Icons.Rounded.DeleteOutline,
                    label = "撤回（删除）",
                    tint = colors.destructive,
                    onClick = {
                        onDismiss()
                        onRequestRetract()
                    },
                )
            }
        }
    }
}

@Composable
private fun SheetActionRow(
    icon: ImageVector,
    label: String,
    tint: Color,
    subtitle: String? = null,
    onClick: () -> Unit,
) {
    val colors = DropitTheme.colors
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .defaultMinSize(minHeight = 52.dp)
            .clickable(onClick = onClick)
            .padding(horizontal = 20.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Icon(
            imageVector = icon,
            contentDescription = null,
            tint = tint,
            modifier = Modifier.size(21.dp),
        )
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = label,
                style = MaterialTheme.typography.bodyMedium,
                color = tint,
                fontWeight = if (tint == colors.destructive) FontWeight.Medium else FontWeight.Normal,
            )
            if (subtitle != null) {
                Text(
                    text = subtitle,
                    style = MaterialTheme.typography.labelSmall,
                    color = colors.fg4,
                )
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun ComposeOrEditTextSheet(
    title: String,
    submitLabel: String,
    initialText: String,
    maxTextBytes: Long,
    isSubmitting: Boolean,
    showGroupPicker: Boolean,
    groups: List<String>,
    initialGroup: String?,
    onDraftChanged: ((String) -> Unit)? = null,
    onSubmit: (text: String, selectedGroup: String?) -> Unit,
    onDismiss: () -> Unit,
) {
    val colors = DropitTheme.colors
    val shapes = DropitTheme.shapes
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    var text by remember(initialText) { mutableStateOf(initialText) }
    var selectedGroup by remember(initialGroup) { mutableStateOf(initialGroup) }
    val byteCount = remember(text) { ClipFormatting.utf8ByteCount(text) }
    val isOverLimit = maxTextBytes > 0L && byteCount > maxTextBytes

    ModalBottomSheet(
        onDismissRequest = onDismiss,
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
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = title,
                    style = MaterialTheme.typography.titleMedium,
                    color = colors.fg,
                )
                val limitSuffix = if (maxTextBytes > 0L) " / ${ServerUrl.formatSize(maxTextBytes)}" else ""
                Text(
                    text = "${ServerUrl.formatSize(byteCount.toLong())}$limitSuffix",
                    style = DropitMonoTypography.meta,
                    color = if (isOverLimit) colors.destructive else colors.fg3,
                )
            }

            if (showGroupPicker && groups.isNotEmpty()) {
                FlowRow(
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    GroupChoicePill(
                        label = "未分组",
                        dotColor = null,
                        selected = selectedGroup == null,
                        onClick = { selectedGroup = null },
                    )
                    groups.forEach { groupName ->
                        GroupChoicePill(
                            label = groupName,
                            dotColor = groupDotColor(groupName, colors.isDark, colors.fg4),
                            selected = selectedGroup == groupName,
                            onClick = { selectedGroup = groupName },
                        )
                    }
                }
            }

            OutlinedTextField(
                value = text,
                onValueChange = {
                    text = it
                    onDraftChanged?.invoke(it)
                },
                modifier = Modifier
                    .fillMaxWidth()
                    .defaultMinSize(minHeight = 148.dp),
                placeholder = {
                    Text(
                        text = "输入或粘贴要同步的文本、链接或代码…",
                        color = colors.fg4,
                    )
                },
                isError = isOverLimit,
                maxLines = 10,
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

            if (isOverLimit) {
                Text(
                    text = "文本大小已超过服务器单条限制，请精简后再发送。",
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.destructive,
                )
            }

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                TextButton(
                    onClick = onDismiss,
                    modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                    colors = ButtonDefaults.textButtonColors(contentColor = colors.fg2),
                ) {
                    Text("取消")
                }
                Spacer(modifier = Modifier.weight(1f))
                Button(
                    onClick = { onSubmit(text, selectedGroup) },
                    enabled = !isSubmitting && text.isNotBlank() && !isOverLimit,
                    modifier = Modifier.defaultMinSize(minWidth = 104.dp, minHeight = 48.dp),
                    shape = shapes.md,
                    colors = ButtonDefaults.buttonColors(
                        containerColor = colors.brand,
                        contentColor = colors.brandFg,
                        disabledContainerColor = colors.brand.copy(alpha = 0.4f),
                        disabledContentColor = colors.brandFg,
                    ),
                ) {
                    if (isSubmitting) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(16.dp),
                            strokeWidth = 2.dp,
                            color = colors.brandFg,
                        )
                    } else {
                        Text(submitLabel, fontWeight = FontWeight.Medium)
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun EditLabelsAndGroupSheet(
    item: ClipItem,
    groups: List<String>,
    isSaving: Boolean,
    onSave: (group: OptionalField<String?>, tags: List<String>) -> Unit,
    onDismiss: () -> Unit,
) {
    val colors = DropitTheme.colors
    val shapes = DropitTheme.shapes
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    var selectedGroup by remember(item.id) { mutableStateOf(item.group) }
    var tagsInput by remember(item.id) { mutableStateOf(item.tags.joinToString(", ")) }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
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
                .padding(horizontal = 20.dp)
                .padding(bottom = 20.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Text(
                text = "修改分组与标签",
                style = MaterialTheme.typography.titleMedium,
                color = colors.fg,
            )

            Text(
                text = "所属分组",
                style = MaterialTheme.typography.labelMedium,
                color = colors.fg2,
            )

            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                GroupChoicePill(
                    label = "未分组",
                    dotColor = null,
                    selected = selectedGroup == null,
                    onClick = { selectedGroup = null },
                )
                groups.forEach { groupName ->
                    GroupChoicePill(
                        label = groupName,
                        dotColor = groupDotColor(groupName, colors.isDark, colors.fg4),
                        selected = selectedGroup == groupName,
                        onClick = { selectedGroup = groupName },
                    )
                }
            }

            OutlinedTextField(
                value = tagsInput,
                onValueChange = { tagsInput = it },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                label = { Text("标签（多个用逗号分隔）") },
                placeholder = { Text("例如：重要, 会议", color = colors.fg4) },
                shape = shapes.md,
                textStyle = MaterialTheme.typography.bodyMedium.copy(color = colors.fg),
                colors = OutlinedTextFieldDefaults.colors(
                    focusedContainerColor = colors.surface0,
                    unfocusedContainerColor = colors.surface0,
                    focusedBorderColor = colors.line3,
                    unfocusedBorderColor = colors.line2,
                    cursorColor = colors.brand,
                ),
            )

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.End,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                TextButton(
                    onClick = onDismiss,
                    modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                    colors = ButtonDefaults.textButtonColors(contentColor = colors.fg2),
                ) {
                    Text("取消")
                }
                Spacer(modifier = Modifier.width(8.dp))
                Button(
                    onClick = {
                        val parsedTags = tagsInput
                            .split(',', '，')
                            .map { it.trim() }
                            .filter { it.isNotEmpty() }
                            .distinct()
                        onSave(OptionalField.Present(selectedGroup), parsedTags)
                    },
                    enabled = !isSaving,
                    modifier = Modifier.defaultMinSize(minWidth = 96.dp, minHeight = 48.dp),
                    shape = shapes.md,
                    colors = ButtonDefaults.buttonColors(
                        containerColor = colors.brand,
                        contentColor = colors.brandFg,
                    ),
                ) {
                    Text("保存", fontWeight = FontWeight.Medium)
                }
            }
        }
    }
}

@Composable
private fun GroupChoicePill(
    label: String,
    dotColor: Color?,
    selected: Boolean,
    onClick: () -> Unit,
) {
    val colors = DropitTheme.colors
    val shapes = DropitTheme.shapes
    Surface(
        modifier = Modifier
            .defaultMinSize(minHeight = 40.dp)
            .clickable(onClick = onClick),
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

@Composable
fun GroupNameDialog(
    title: String,
    confirmLabel: String,
    initialValue: String,
    existingGroups: List<String>,
    renamingFrom: String? = null,
    onConfirm: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    val colors = DropitTheme.colors
    val shapes = DropitTheme.shapes
    var name by remember(initialValue) { mutableStateOf(initialValue) }
    val error = remember(name, existingGroups, renamingFrom) {
        if (name.isEmpty()) null else ClipFormatting.validateGroupName(name, existingGroups, renamingFrom)
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        shape = shapes.lg,
        containerColor = colors.surface1,
        titleContentColor = colors.fg,
        textContentColor = colors.fg2,
        tonalElevation = 0.dp,
        icon = {
            Icon(
                imageVector = Icons.Rounded.Folder,
                contentDescription = null,
                tint = colors.brand,
            )
        },
        title = {
            Text(text = title, style = MaterialTheme.typography.titleMedium)
        },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                    placeholder = { Text("输入分组名称", color = colors.fg4) },
                    isError = error != null,
                    shape = shapes.md,
                    textStyle = MaterialTheme.typography.bodyMedium.copy(color = colors.fg),
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedContainerColor = colors.surface0,
                        unfocusedContainerColor = colors.surface0,
                        focusedBorderColor = colors.line3,
                        unfocusedBorderColor = colors.line2,
                        errorBorderColor = colors.destructive,
                        cursorColor = colors.brand,
                    ),
                )
                if (error != null) {
                    Text(
                        text = error,
                        style = MaterialTheme.typography.labelSmall,
                        color = colors.destructive,
                    )
                }
            }
        },
        confirmButton = {
            TextButton(
                onClick = { onConfirm(name) },
                enabled = name.isNotBlank() && error == null,
                modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                colors = ButtonDefaults.textButtonColors(contentColor = colors.brand),
            ) {
                Text(confirmLabel, fontWeight = FontWeight.SemiBold)
            }
        },
        dismissButton = {
            TextButton(
                onClick = onDismiss,
                modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                colors = ButtonDefaults.textButtonColors(contentColor = colors.fg2),
            ) {
                Text("取消")
            }
        },
    )
}

@Composable
fun ConfirmRetractDialog(
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
) {
    val colors = DropitTheme.colors
    val shapes = DropitTheme.shapes
    AlertDialog(
        onDismissRequest = onDismiss,
        shape = shapes.lg,
        containerColor = colors.surface1,
        titleContentColor = colors.fg,
        textContentColor = colors.fg2,
        tonalElevation = 0.dp,
        title = {
            Text(
                text = "确认撤回这条内容？",
                style = MaterialTheme.typography.titleMedium,
            )
        },
        text = {
            Text(
                text = "撤回后所有设备将立即移除此条目，关联的分享链接也会失效。",
                style = MaterialTheme.typography.bodySmall,
            )
        },
        confirmButton = {
            TextButton(
                onClick = onConfirm,
                modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                colors = ButtonDefaults.textButtonColors(contentColor = colors.destructive),
            ) {
                Text("确认撤回", fontWeight = FontWeight.SemiBold)
            }
        },
        dismissButton = {
            TextButton(
                onClick = onDismiss,
                modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                colors = ButtonDefaults.textButtonColors(contentColor = colors.fg2),
            ) {
                Text("取消")
            }
        },
    )
}

@Composable
fun ConfirmDeleteGroupDialog(
    groupName: String,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
) {
    val colors = DropitTheme.colors
    val shapes = DropitTheme.shapes
    AlertDialog(
        onDismissRequest = onDismiss,
        shape = shapes.lg,
        containerColor = colors.surface1,
        titleContentColor = colors.fg,
        textContentColor = colors.fg2,
        tonalElevation = 0.dp,
        title = {
            Text(
                text = "删除分组「$groupName」？",
                style = MaterialTheme.typography.titleMedium,
            )
        },
        text = {
            Text(
                text = "删除分组不会删除里面的内容，原有条目会自动归入「未分组」。",
                style = MaterialTheme.typography.bodySmall,
            )
        },
        confirmButton = {
            TextButton(
                onClick = onConfirm,
                modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                colors = ButtonDefaults.textButtonColors(contentColor = colors.destructive),
            ) {
                Text("删除分组", fontWeight = FontWeight.SemiBold)
            }
        },
        dismissButton = {
            TextButton(
                onClick = onDismiss,
                modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                colors = ButtonDefaults.textButtonColors(contentColor = colors.fg2),
            ) {
                Text("取消")
            }
        },
    )
}
