package dev.dropit.app.ui.board

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
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
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.AttachFile
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.CloudOff
import androidx.compose.material.icons.rounded.ContentPasteGo
import androidx.compose.material.icons.rounded.DeleteOutline
import androidx.compose.material.icons.rounded.Edit
import androidx.compose.material.icons.rounded.ExpandMore
import androidx.compose.material.icons.rounded.Inbox
import androidx.compose.material.icons.rounded.Lock
import androidx.compose.material.icons.rounded.PushPin
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.dropit.app.core.network.ClipItem
import dev.dropit.app.core.network.TargetScope
import dev.dropit.app.core.realtime.ConnectionState
import dev.dropit.app.core.repository.UploadFileRequest
import dev.dropit.app.ui.theme.DropitElevation
import dev.dropit.app.ui.theme.DropitTheme
import dev.dropit.app.ui.theme.groupDotColor
import kotlinx.coroutines.delay

@Composable
fun BoardScreen(
    viewModel: BoardViewModel,
    onNavigateToTransfers: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    val colors = DropitTheme.colors
    val shapes = DropitTheme.shapes
    val context = LocalContext.current
    val snackbarHostState = remember { SnackbarHostState() }

    // Periodic tick for relative times & remaining expiry countdowns
    var nowMs by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(30_000L)
            nowMs = System.currentTimeMillis()
        }
    }

    // Transient UI sheet / dialog states
    var showSpaceSwitcher by remember { mutableStateOf(false) }
    var showComposeSheet by remember { mutableStateOf(false) }
    var moreSheetItem by remember { mutableStateOf<ClipItem?>(null) }
    var editTextItem by remember { mutableStateOf<ClipItem?>(null) }
    var editLabelsItem by remember { mutableStateOf<ClipItem?>(null) }
    var retractConfirmItem by remember { mutableStateOf<ClipItem?>(null) }
    var showCreateGroupDialog by remember { mutableStateOf(false) }
    var renamingGroup by remember { mutableStateOf<String?>(null) }
    var deletingGroup by remember { mutableStateOf<String?>(null) }

    // Multi-file picker (ActivityResultContracts.OpenMultipleDocuments)
    val filePickerLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.OpenMultipleDocuments(),
    ) { uris ->
        val scope = state.activeScope ?: return@rememberLauncherForActivityResult
        if (uris.isEmpty()) return@rememberLauncherForActivityResult
        val requests = uris.map { uri ->
            resolveUploadRequest(
                context = context,
                uri = uri,
                scope = scope,
                groupName = state.defaultTargetGroup,
            )
        }
        viewModel.enqueueFileUploads(requests)
    }

    // Collapse search on system back press before leaving the board
    BackHandler(enabled = state.isSearchExpanded) {
        viewModel.setSearchExpanded(false)
    }

    // Snackbar delivery
    LaunchedEffect(state.snackbar) {
        val sb = state.snackbar ?: return@LaunchedEffect
        val result = snackbarHostState.showSnackbar(
            message = sb.message,
            actionLabel = if (sb.showTransfersAction) "查看传输" else null,
            duration = SnackbarDuration.Short,
        )
        viewModel.clearSnackbar()
        if (result == SnackbarResult.ActionPerformed && sb.showTransfersAction) {
            onNavigateToTransfers()
        }
    }

    Box(
        modifier = modifier
            .fillMaxSize()
            .background(colors.bg),
    ) {
        Column(modifier = Modifier.fillMaxSize()) {
            // Top Bar (surface0 + bottom 1.dp line1)
            BoardTopBar(
                state = state,
                onOpenSpaceSwitcher = { showSpaceSwitcher = true },
                onReconnect = viewModel::reconnectRealtime,
                onToggleSearch = { viewModel.setSearchExpanded(!state.isSearchExpanded) },
                onSearchQueryChanged = viewModel::setSearchQuery,
            )

            // Consolidated Offline Banner
            AnimatedVisibility(visible = state.offlineBannerMessage != null) {
                state.offlineBannerMessage?.let { msg ->
                    OfflineWarningBanner(
                        message = msg,
                        onRetry = viewModel::reconnectRealtime,
                    )
                }
            }

            // Read-Only Space Banner
            if (state.isReadOnly) {
                ReadOnlySpaceBanner(ownerName = state.activeSpace?.ownerName)
            }

            // Horizontal Type + Group Filter Strip
            BoardFilterBar(
                state = state,
                onSelectKind = viewModel::selectKindFilter,
                onSelectGroup = viewModel::selectGroupFilter,
                onCreateGroup = { showCreateGroupDialog = true },
                onRenameGroup = { renamingGroup = it },
                onDeleteGroup = { deletingGroup = it },
            )

            HorizontalDivider(thickness = 1.dp, color = colors.line1)

            // Board Content Area
            Box(modifier = Modifier.weight(1f)) {
                when {
                    state.isLoadingInitial && state.allItems.isEmpty() -> {
                        Box(
                            modifier = Modifier.fillMaxSize(),
                            contentAlignment = Alignment.Center,
                        ) {
                            Column(
                                horizontalAlignment = Alignment.CenterHorizontally,
                                verticalArrangement = Arrangement.spacedBy(10.dp),
                            ) {
                                CircularProgressIndicator(
                                    color = colors.brand,
                                    strokeWidth = 2.5.dp,
                                    modifier = Modifier.size(28.dp),
                                )
                                Text(
                                    text = "正在同步剪贴板…",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = colors.fg3,
                                )
                            }
                        }
                    }

                    state.filteredItems.isEmpty() -> {
                        BoardEmptyState(
                            hasSearchOrFilter = state.searchQuery.isNotBlank() ||
                                state.selectedGroupFilter != GroupFilter.All ||
                                state.selectedKindFilter != ContentTypeFilter.ALL,
                            isReadOnly = state.isReadOnly,
                            onClearFilters = {
                                viewModel.setSearchQuery("")
                                viewModel.selectGroupFilter(GroupFilter.All)
                                viewModel.selectKindFilter(ContentTypeFilter.ALL)
                            },
                            onComposeText = { showComposeSheet = true },
                        )
                    }

                    else -> {
                        LazyColumn(
                            modifier = Modifier.fillMaxSize(),
                            contentPadding = PaddingValues(
                                start = 14.dp,
                                end = 14.dp,
                                top = 12.dp,
                                bottom = if (state.isReadOnly) 24.dp else 96.dp,
                            ),
                            verticalArrangement = Arrangement.spacedBy(10.dp),
                        ) {
                            // Pinned summary strip when pinned items are present
                            if (state.pinnedItems.isNotEmpty()) {
                                item(key = "pin-bar-header") {
                                    PinnedSummaryBar(
                                        pinnedItems = state.pinnedItems,
                                        onCopyFirst = { first ->
                                            if (first.isText) {
                                                copyToClipboard(context, ClipFormatting.copyPayloadForItem(first))
                                                viewModel.markItemCopied(first.id)
                                            } else {
                                                moreSheetItem = first
                                            }
                                        },
                                    )
                                }
                            }

                            items(
                                items = state.filteredItems,
                                key = { it.id },
                            ) { item ->
                                BoardCard(
                                    item = item,
                                    isCopied = state.copiedItemId == item.id,
                                    nowMs = nowMs,
                                    onCopyText = { target ->
                                        copyToClipboard(context, ClipFormatting.copyPayloadForItem(target))
                                        viewModel.markItemCopied(target.id)
                                    },
                                    onDownloadFile = { target ->
                                        viewModel.downloadItem(target)
                                    },
                                    onShareItem = { target ->
                                        if (target.isText) {
                                            sharePlainText(context, ClipFormatting.copyPayloadForItem(target))
                                        } else {
                                            viewModel.prepareFileForShare(target) { fileUri ->
                                                shareFileUri(context, fileUri, target.mime ?: "*/*")
                                            }
                                        }
                                    },
                                    onOpenUrl = { url -> openExternalUrl(context, url) },
                                    onOpenMore = { target -> moreSheetItem = target },
                                    modifier = Modifier.animateItem(),
                                )
                            }
                        }
                    }
                }

                // Floating Paper Quick-Send Bar (hidden in read-only spaces!)
                if (!state.isReadOnly && state.activeScope != null) {
                    FloatingQuickSendBar(
                        isSending = state.isSendingText,
                        onNewText = { showComposeSheet = true },
                        onSendClipboard = {
                            // Foreground explicit read compliant with Android 10+ clipboard privacy rules.
                            val clipText = readForegroundClipboardText(context)
                            viewModel.sendFromClipboard(clipText)
                        },
                        onPickFiles = {
                            filePickerLauncher.launch(arrayOf("*/*"))
                        },
                        modifier = Modifier
                            .align(Alignment.BottomCenter)
                            .padding(horizontal = 16.dp, vertical = 14.dp),
                    )
                }

                SnackbarHost(
                    hostState = snackbarHostState,
                    modifier = Modifier
                        .align(Alignment.BottomCenter)
                        .padding(bottom = if (state.isReadOnly) 12.dp else 76.dp),
                )
            }
        }
    }

    // Sheets & Dialogs
    if (showSpaceSwitcher) {
        SpaceSwitcherSheet(
            spaces = state.spaces,
            activeSpaceId = state.activeSpace?.id,
            currentUserId = state.me?.user?.id,
            onSelectSpace = viewModel::selectSpace,
            onDismiss = { showSpaceSwitcher = false },
        )
    }

    if (showComposeSheet && !state.isReadOnly) {
        ComposeOrEditTextSheet(
            title = "发送文本",
            submitLabel = "发送",
            initialText = state.composerDraft,
            maxTextBytes = state.me?.maxTextBytes ?: 0L,
            isSubmitting = state.isSendingText,
            showGroupPicker = true,
            groups = state.groups,
            initialGroup = state.defaultTargetGroup,
            onDraftChanged = viewModel::updateComposerDraft,
            onSubmit = { text, group ->
                viewModel.sendText(rawText = text, targetGroup = group) {
                    showComposeSheet = false
                }
            },
            onDismiss = { showComposeSheet = false },
        )
    }

    moreSheetItem?.let { item ->
        ItemMoreActionsSheet(
            item = item,
            isReadOnly = state.isReadOnly,
            nowMs = nowMs,
            onCopy = {
                copyToClipboard(context, ClipFormatting.copyPayloadForItem(item))
                viewModel.markItemCopied(item.id)
            },
            onDownload = { viewModel.downloadItem(item) },
            onEditText = { editTextItem = item },
            onTogglePin = { viewModel.togglePin(item) },
            onEditLabelsAndGroup = { editLabelsItem = item },
            onShareLinkPlaceholder = {
                viewModel.showSnackbar("单项分享链接面板将于下一阶段补齐")
            },
            onRequestRetract = { retractConfirmItem = item },
            onDismiss = { moreSheetItem = null },
        )
    }

    editTextItem?.let { item ->
        ComposeOrEditTextSheet(
            title = "编辑文本",
            submitLabel = "保存",
            initialText = item.text.orEmpty(),
            maxTextBytes = state.me?.maxTextBytes ?: 0L,
            isSubmitting = state.isMutatingItem,
            showGroupPicker = false,
            groups = emptyList(),
            initialGroup = item.group,
            onSubmit = { updatedText, _ ->
                viewModel.editText(item.id, updatedText) {
                    editTextItem = null
                }
            },
            onDismiss = { editTextItem = null },
        )
    }

    editLabelsItem?.let { item ->
        EditLabelsAndGroupSheet(
            item = item,
            groups = state.groups,
            isSaving = state.isMutatingItem,
            onSave = { groupField, tags ->
                viewModel.updateItemLabels(item.id, groupField, tags) {
                    editLabelsItem = null
                }
            },
            onDismiss = { editLabelsItem = null },
        )
    }

    retractConfirmItem?.let { item ->
        ConfirmRetractDialog(
            onConfirm = {
                viewModel.retractItem(item.id) {
                    retractConfirmItem = null
                }
            },
            onDismiss = { retractConfirmItem = null },
        )
    }

    if (showCreateGroupDialog && !state.isReadOnly) {
        GroupNameDialog(
            title = "新建分组",
            confirmLabel = "创建",
            initialValue = "",
            existingGroups = state.groups,
            onConfirm = { name ->
                viewModel.createGroup(name) {
                    showCreateGroupDialog = false
                }
            },
            onDismiss = { showCreateGroupDialog = false },
        )
    }

    renamingGroup?.let { oldName ->
        GroupNameDialog(
            title = "重命名分组",
            confirmLabel = "保存",
            initialValue = oldName,
            existingGroups = state.groups,
            renamingFrom = oldName,
            onConfirm = { newName ->
                viewModel.renameGroup(oldName, newName) {
                    renamingGroup = null
                }
            },
            onDismiss = { renamingGroup = null },
        )
    }

    deletingGroup?.let { targetGroup ->
        ConfirmDeleteGroupDialog(
            groupName = targetGroup,
            onConfirm = {
                viewModel.deleteGroup(targetGroup) {
                    deletingGroup = null
                }
            },
            onDismiss = { deletingGroup = null },
        )
    }
}

@Composable
private fun BoardTopBar(
    state: BoardUiState,
    onOpenSpaceSwitcher: () -> Unit,
    onReconnect: () -> Unit,
    onToggleSearch: () -> Unit,
    onSearchQueryChanged: (String) -> Unit,
) {
    val colors = DropitTheme.colors
    val shapes = DropitTheme.shapes

    Surface(
        modifier = Modifier.fillMaxWidth(),
        color = colors.surface0,
        tonalElevation = 0.dp,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .statusBarsPadding()
                .displayCutoutPadding(),
        ) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 12.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                // Space Switcher Pill (>= 48.dp touch target)
                Row(
                    modifier = Modifier
                        .weight(1f, fill = false)
                        .defaultMinSize(minHeight = 48.dp)
                        .clip(shapes.md)
                        .clickable(onClick = onOpenSpaceSwitcher)
                        .padding(horizontal = 8.dp, vertical = 6.dp)
                        .semantics { contentDescription = "切换空间" },
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Text(
                        text = state.activeSpace?.name?.ifBlank { "我的空间" } ?: "dropit",
                        style = MaterialTheme.typography.titleLarge,
                        color = colors.fg,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f, fill = false),
                    )
                    Icon(
                        imageVector = Icons.Rounded.ExpandMore,
                        contentDescription = null,
                        tint = colors.fg3,
                        modifier = Modifier.size(20.dp),
                    )
                    if (state.isReadOnly) {
                        Surface(
                            shape = shapes.pill,
                            color = colors.warnSoft,
                            border = BorderStroke(1.dp, colors.warn.copy(alpha = 0.35f)),
                            tonalElevation = 0.dp,
                        ) {
                            Text(
                                text = "只读",
                                style = MaterialTheme.typography.labelSmall,
                                color = colors.warn,
                                modifier = Modifier.padding(horizontal = 7.dp, vertical = 2.dp),
                            )
                        }
                    }
                }

                // Right cluster: Realtime Status + Search Toggle
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(2.dp),
                ) {
                    ConnectionStatusPill(
                        connectionState = state.connectionState,
                        presenceDevices = state.presenceDevices,
                        onClick = onReconnect,
                    )
                    IconButton(
                        onClick = onToggleSearch,
                        modifier = Modifier.size(48.dp),
                    ) {
                        Icon(
                            imageVector = if (state.isSearchExpanded) Icons.Rounded.Close else Icons.Rounded.Search,
                            contentDescription = if (state.isSearchExpanded) "关闭搜索" else "搜索剪贴板内容",
                            tint = if (state.isSearchExpanded) colors.brand else colors.fg2,
                        )
                    }
                }
            }

            AnimatedVisibility(visible = state.isSearchExpanded) {
                OutlinedTextField(
                    value = state.searchQuery,
                    onValueChange = onSearchQueryChanged,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 14.dp)
                        .padding(bottom = 10.dp),
                    singleLine = true,
                    placeholder = {
                        Text(
                            text = "搜索文本、文件名或标签…",
                            style = MaterialTheme.typography.bodySmall,
                            color = colors.fg4,
                        )
                    },
                    leadingIcon = {
                        Icon(
                            imageVector = Icons.Rounded.Search,
                            contentDescription = null,
                            tint = colors.fg3,
                            modifier = Modifier.size(18.dp),
                        )
                    },
                    trailingIcon = if (state.searchQuery.isNotEmpty()) {
                        {
                            IconButton(
                                onClick = { onSearchQueryChanged("") },
                                modifier = Modifier.size(48.dp),
                            ) {
                                Icon(
                                    imageVector = Icons.Rounded.Close,
                                    contentDescription = "清空搜索词",
                                    tint = colors.fg3,
                                    modifier = Modifier.size(18.dp),
                                )
                            }
                        }
                    } else {
                        null
                    },
                    shape = shapes.md,
                    textStyle = MaterialTheme.typography.bodySmall.copy(color = colors.fg),
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedContainerColor = colors.surface1,
                        unfocusedContainerColor = colors.surface1,
                        focusedBorderColor = colors.line3,
                        unfocusedBorderColor = colors.line2,
                        cursorColor = colors.brand,
                    ),
                )
            }
        }
    }
}

@Composable
private fun ConnectionStatusPill(
    connectionState: ConnectionState,
    presenceDevices: Int,
    onClick: () -> Unit,
) {
    val colors = DropitTheme.colors
    val shapes = DropitTheme.shapes
    val (dotColor, bgColor, label) = when (connectionState) {
        ConnectionState.CONNECTED -> Triple(
            colors.ok,
            colors.okSoft,
            if (presenceDevices > 0) "$presenceDevices 台在线" else "已连接",
        )
        ConnectionState.CONNECTING,
        ConnectionState.RECONNECTING,
        -> Triple(colors.warn, colors.warnSoft, "重连中")
        ConnectionState.DISCONNECTED,
        ConnectionState.UNAUTHORIZED,
        -> Triple(colors.destructive, colors.brandSoft, "已离线")
    }

    Box(
        modifier = Modifier
            .defaultMinSize(minHeight = 48.dp)
            .clickable(onClick = onClick)
            .padding(horizontal = 4.dp)
            .semantics {
                contentDescription = "实时连接状态：$label，点击重新连接"
            },
        contentAlignment = Alignment.Center,
    ) {
        Surface(
            shape = shapes.pill,
            color = bgColor,
            tonalElevation = 0.dp,
        ) {
            Row(
                modifier = Modifier.padding(horizontal = 9.dp, vertical = 5.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(5.dp),
            ) {
                Box(
                    modifier = Modifier
                        .size(7.dp)
                        .clip(CircleShape)
                        .background(dotColor),
                )
                Text(
                    text = label,
                    style = MaterialTheme.typography.labelSmall,
                    color = dotColor,
                    maxLines = 1,
                    softWrap = false,
                )
            }
        }
    }
}

@Composable
private fun OfflineWarningBanner(
    message: String,
    onRetry: () -> Unit,
) {
    val colors = DropitTheme.colors
    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .semantics { liveRegion = LiveRegionMode.Polite },
        color = colors.warnSoft,
        tonalElevation = 0.dp,
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 14.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Icon(
                imageVector = Icons.Rounded.CloudOff,
                contentDescription = null,
                tint = colors.warn,
                modifier = Modifier.size(16.dp),
            )
            Text(
                text = message,
                style = MaterialTheme.typography.bodySmall,
                color = colors.fg,
                modifier = Modifier.weight(1f),
            )
            TextButton(
                onClick = onRetry,
                modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                colors = ButtonDefaults.textButtonColors(contentColor = colors.warn),
            ) {
                Text("重试", fontWeight = FontWeight.SemiBold)
            }
        }
    }
}

@Composable
private fun ReadOnlySpaceBanner(ownerName: String?) {
    val colors = DropitTheme.colors
    val prefix = if (!ownerName.isNullOrBlank()) "$ownerName 邀请你" else "你当前以"
    Surface(
        modifier = Modifier.fillMaxWidth(),
        color = colors.warnSoft.copy(alpha = 0.7f),
        tonalElevation = 0.dp,
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 14.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Icon(
                imageVector = Icons.Rounded.Lock,
                contentDescription = null,
                tint = colors.warn,
                modifier = Modifier.size(15.dp),
            )
            Text(
                text = "${prefix}只读查看此空间，仅支持浏览、复制与保存。",
                style = MaterialTheme.typography.labelMedium,
                color = colors.fg2,
            )
        }
    }
}

@Composable
private fun BoardFilterBar(
    state: BoardUiState,
    onSelectKind: (ContentTypeFilter) -> Unit,
    onSelectGroup: (GroupFilter) -> Unit,
    onCreateGroup: () -> Unit,
    onRenameGroup: (String) -> Unit,
    onDeleteGroup: (String) -> Unit,
) {
    val colors = DropitTheme.colors

    Surface(
        modifier = Modifier.fillMaxWidth(),
        color = colors.surface0,
        tonalElevation = 0.dp,
    ) {
        Column(modifier = Modifier.fillMaxWidth()) {
            LazyRow(
                contentPadding = PaddingValues(horizontal = 14.dp, vertical = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                // Content type chips
                items(ContentTypeFilter.entries) { kind ->
                    FilterChipPill(
                        label = kind.label,
                        selected = state.selectedKindFilter == kind,
                        dotColor = null,
                        onClick = { onSelectKind(kind) },
                    )
                }

                item(key = "filter-divider") {
                    Box(
                        modifier = Modifier
                            .width(1.dp)
                            .height(18.dp)
                            .background(colors.line2),
                    )
                }

                // Group: All
                item(key = "group-all") {
                    FilterChipPill(
                        label = "全部分组 (${state.allItems.size})",
                        selected = state.selectedGroupFilter == GroupFilter.All,
                        dotColor = null,
                        onClick = { onSelectGroup(GroupFilter.All) },
                    )
                }

                // Custom groups
                items(state.groupInfos, key = { "group-${it.name}" }) { groupInfo ->
                    FilterChipPill(
                        label = "${groupInfo.name} (${groupInfo.itemCount})",
                        selected = state.selectedGroupFilter == GroupFilter.Named(groupInfo.name),
                        dotColor = groupDotColor(groupInfo.name, colors.isDark, colors.fg4),
                        onClick = { onSelectGroup(GroupFilter.Named(groupInfo.name)) },
                    )
                }

                // Ungrouped
                item(key = "group-ungrouped") {
                    FilterChipPill(
                        label = "未分组 (${state.ungroupedCount})",
                        selected = state.selectedGroupFilter == GroupFilter.Ungrouped,
                        dotColor = colors.fg4,
                        hollowDot = true,
                        onClick = { onSelectGroup(GroupFilter.Ungrouped) },
                    )
                }

                // Create group entry (writable spaces only)
                if (!state.isReadOnly) {
                    item(key = "group-add") {
                        Surface(
                            modifier = Modifier
                                .defaultMinSize(minHeight = 36.dp)
                                .clickable(onClick = onCreateGroup)
                                .semantics { contentDescription = "新建分组" },
                            shape = DropitTheme.shapes.pill,
                            color = colors.surface1,
                            border = BorderStroke(1.dp, colors.line2),
                            tonalElevation = 0.dp,
                        ) {
                            Row(
                                modifier = Modifier.padding(horizontal = 10.dp, vertical = 7.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(4.dp),
                            ) {
                                Icon(
                                    imageVector = Icons.Rounded.Add,
                                    contentDescription = null,
                                    tint = colors.fg2,
                                    modifier = Modifier.size(15.dp),
                                )
                                Text(
                                    text = "新建分组",
                                    style = MaterialTheme.typography.labelMedium,
                                    color = colors.fg2,
                                )
                            }
                        }
                    }
                }
            }

            // Inline manage bar when a custom group is selected in a writable space
            val activeNamedGroup = (state.selectedGroupFilter as? GroupFilter.Named)?.name
            if (activeNamedGroup != null && !state.isReadOnly) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 14.dp)
                        .padding(bottom = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Text(
                        text = "当前分组：$activeNamedGroup",
                        style = MaterialTheme.typography.labelSmall,
                        color = colors.fg3,
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        TextButton(
                            onClick = { onRenameGroup(activeNamedGroup) },
                            modifier = Modifier.defaultMinSize(minHeight = 40.dp),
                            colors = ButtonDefaults.textButtonColors(contentColor = colors.fg2),
                        ) {
                            Icon(
                                imageVector = Icons.Rounded.Edit,
                                contentDescription = null,
                                modifier = Modifier.size(14.dp),
                            )
                            Spacer(modifier = Modifier.width(4.dp))
                            Text("重命名", style = MaterialTheme.typography.labelSmall)
                        }
                        TextButton(
                            onClick = { onDeleteGroup(activeNamedGroup) },
                            modifier = Modifier.defaultMinSize(minHeight = 40.dp),
                            colors = ButtonDefaults.textButtonColors(contentColor = colors.destructive),
                        ) {
                            Icon(
                                imageVector = Icons.Rounded.DeleteOutline,
                                contentDescription = null,
                                modifier = Modifier.size(14.dp),
                            )
                            Spacer(modifier = Modifier.width(4.dp))
                            Text("删除分组", style = MaterialTheme.typography.labelSmall)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun FilterChipPill(
    label: String,
    selected: Boolean,
    dotColor: Color?,
    hollowDot: Boolean = false,
    onClick: () -> Unit,
) {
    val colors = DropitTheme.colors
    val shapes = DropitTheme.shapes
    Surface(
        modifier = Modifier
            .defaultMinSize(minHeight = 36.dp)
            .clickable(onClick = onClick),
        shape = shapes.pill,
        color = if (selected) colors.fg else colors.surface2,
        border = BorderStroke(1.dp, if (selected) colors.fg else colors.line2),
        tonalElevation = 0.dp,
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 11.dp, vertical = 7.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            if (dotColor != null) {
                Box(
                    modifier = Modifier
                        .size(7.dp)
                        .clip(CircleShape)
                        .then(
                            if (hollowDot) {
                                Modifier.background(Color.Transparent).padding(0.dp)
                            } else {
                                Modifier.background(dotColor)
                            },
                        ),
                ) {
                    if (hollowDot) {
                        Surface(
                            modifier = Modifier.size(7.dp),
                            shape = CircleShape,
                            color = Color.Transparent,
                            border = BorderStroke(1.2.dp, if (selected) colors.bg else dotColor),
                            tonalElevation = 0.dp,
                            content = {},
                        )
                    }
                }
            }
            Text(
                text = label,
                style = MaterialTheme.typography.labelMedium,
                color = if (selected) colors.bg else colors.fg2,
                maxLines = 1,
                softWrap = false,
            )
        }
    }
}

@Composable
private fun PinnedSummaryBar(
    pinnedItems: List<ClipItem>,
    onCopyFirst: (ClipItem) -> Unit,
) {
    val colors = DropitTheme.colors
    val shapes = DropitTheme.shapes
    val first = pinnedItems.first()
    val preview = if (first.isText) {
        first.text.orEmpty().trim().lineSequence().firstOrNull().orEmpty()
    } else {
        ClipFormatting.middleEllipsizeFilename(first.filename ?: "置顶文件", 24)
    }

    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .defaultMinSize(minHeight = 48.dp)
            .clickable { onCopyFirst(first) },
        shape = shapes.md,
        color = colors.surface0,
        border = BorderStroke(1.dp, colors.line2),
        tonalElevation = 0.dp,
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Icon(
                imageVector = Icons.Rounded.PushPin,
                contentDescription = "置顶条目",
                tint = colors.brand,
                modifier = Modifier.size(16.dp),
            )
            Text(
                text = "置顶 (${pinnedItems.size}) · $preview",
                style = MaterialTheme.typography.bodySmall,
                color = colors.fg2,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            Text(
                text = if (first.isText) "点按复制" else "查看",
                style = MaterialTheme.typography.labelSmall,
                color = colors.brand,
            )
        }
    }
}

@Composable
private fun FloatingQuickSendBar(
    isSending: Boolean,
    onNewText: () -> Unit,
    onSendClipboard: () -> Unit,
    onPickFiles: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = DropitTheme.colors
    val shapes = DropitTheme.shapes

    Surface(
        modifier = modifier,
        shape = shapes.pill,
        color = colors.surface1,
        border = BorderStroke(1.dp, colors.line2),
        shadowElevation = DropitElevation.floating(colors.isDark),
        tonalElevation = 0.dp,
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 6.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            // Primary action: New Text
            Surface(
                modifier = Modifier
                    .defaultMinSize(minHeight = 48.dp)
                    .clip(shapes.pill)
                    .clickable(enabled = !isSending, onClick = onNewText)
                    .semantics { contentDescription = "新建并发送文本" },
                shape = shapes.pill,
                color = colors.brand,
                tonalElevation = 0.dp,
            ) {
                Row(
                    modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Icon(
                        imageVector = Icons.Rounded.Edit,
                        contentDescription = null,
                        tint = colors.brandFg,
                        modifier = Modifier.size(18.dp),
                    )
                    Text(
                        text = "发文本",
                        style = MaterialTheme.typography.labelMedium,
                        color = colors.brandFg,
                        fontWeight = FontWeight.SemiBold,
                        maxLines = 1,
                        softWrap = false,
                    )
                }
            }

            // Foreground one-tap send from system clipboard
            Row(
                modifier = Modifier
                    .defaultMinSize(minHeight = 48.dp)
                    .clip(shapes.pill)
                    .clickable(enabled = !isSending, onClick = onSendClipboard)
                    .padding(horizontal = 12.dp, vertical = 10.dp)
                    .semantics { contentDescription = "从剪贴板发送" },
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(5.dp),
            ) {
                Icon(
                    imageVector = Icons.Rounded.ContentPasteGo,
                    contentDescription = null,
                    tint = colors.fg2,
                    modifier = Modifier.size(18.dp),
                )
                Text(
                    text = "剪贴板",
                    style = MaterialTheme.typography.labelMedium,
                    color = colors.fg,
                    maxLines = 1,
                    softWrap = false,
                )
            }

            // Multi-file picker
            Row(
                modifier = Modifier
                    .defaultMinSize(minHeight = 48.dp)
                    .clip(shapes.pill)
                    .clickable(onClick = onPickFiles)
                    .padding(horizontal = 12.dp, vertical = 10.dp)
                    .semantics { contentDescription = "选择并发送文件" },
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(5.dp),
            ) {
                Icon(
                    imageVector = Icons.Rounded.AttachFile,
                    contentDescription = null,
                    tint = colors.fg2,
                    modifier = Modifier.size(18.dp),
                )
                Text(
                    text = "发文件",
                    style = MaterialTheme.typography.labelMedium,
                    color = colors.fg,
                    maxLines = 1,
                    softWrap = false,
                )
            }
        }
    }
}

@Composable
private fun BoardEmptyState(
    hasSearchOrFilter: Boolean,
    isReadOnly: Boolean,
    onClearFilters: () -> Unit,
    onComposeText: () -> Unit,
) {
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
                imageVector = Icons.Rounded.Inbox,
                contentDescription = null,
                tint = colors.fg4,
                modifier = Modifier.size(44.dp),
            )
            Text(
                text = if (hasSearchOrFilter) "没有匹配的内容" else "剪贴板还是空的",
                style = MaterialTheme.typography.titleMedium,
                color = colors.fg,
            )
            Text(
                text = when {
                    hasSearchOrFilter -> "尝试换个关键词或切换回「全部分组」查看。"
                    isReadOnly -> "当前只读空间暂无条目，对方发送内容后会实时显示在这里。"
                    else -> "点击下方「发文本」「剪贴板」或「发文件」，即可跨设备实时同步。"
                },
                style = MaterialTheme.typography.bodySmall,
                color = colors.fg3,
            )
            if (hasSearchOrFilter) {
                TextButton(
                    onClick = onClearFilters,
                    modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                    colors = ButtonDefaults.textButtonColors(contentColor = colors.brand),
                ) {
                    Text("清空筛选条件")
                }
            } else if (!isReadOnly) {
                TextButton(
                    onClick = onComposeText,
                    modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                    colors = ButtonDefaults.textButtonColors(contentColor = colors.brand),
                ) {
                    Text("发送第一条文本")
                }
            }
        }
    }
}

private fun copyToClipboard(context: Context, text: String) {
    val manager = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return
    manager.setPrimaryClip(ClipData.newPlainText("dropit", text))
}

private fun readForegroundClipboardText(context: Context): String? {
    val manager = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return null
    val clip = manager.primaryClip ?: return null
    if (clip.itemCount <= 0) return null
    return clip.getItemAt(0)?.coerceToText(context)?.toString()
}

private fun sharePlainText(context: Context, text: String) {
    val intent = Intent(Intent.ACTION_SEND).apply {
        type = "text/plain"
        putExtra(Intent.EXTRA_TEXT, text)
    }
    runCatching {
        context.startActivity(Intent.createChooser(intent, "分享文本"))
    }.onFailure {
        Toast.makeText(context, "未找到可接收分享的应用", Toast.LENGTH_SHORT).show()
    }
}

private fun shareFileUri(context: Context, uri: Uri, mimeType: String) {
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

private fun openExternalUrl(context: Context, rawUrl: String) {
    val uri = runCatching { Uri.parse(rawUrl) }.getOrNull() ?: return
    val opened = runCatching {
        CustomTabsIntent.Builder().setShowTitle(true).build().launchUrl(context, uri)
    }.isSuccess
    if (!opened) {
        runCatching {
            context.startActivity(Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }.onFailure {
            Toast.makeText(context, "无法打开链接", Toast.LENGTH_SHORT).show()
        }
    }
}

private fun resolveUploadRequest(
    context: Context,
    uri: Uri,
    scope: TargetScope,
    groupName: String?,
): UploadFileRequest {
    var displayName = "未命名文件"
    var sizeBytes = 0L
    runCatching {
        context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)
            ?.use { cursor ->
                if (cursor.moveToFirst()) {
                    val nameIdx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    val sizeIdx = cursor.getColumnIndex(OpenableColumns.SIZE)
                    if (nameIdx >= 0 && !cursor.isNull(nameIdx)) {
                        displayName = cursor.getString(nameIdx).ifBlank { displayName }
                    }
                    if (sizeIdx >= 0 && !cursor.isNull(sizeIdx)) {
                        sizeBytes = cursor.getLong(sizeIdx).coerceAtLeast(0L)
                    }
                }
            }
    }
    val mimeType = context.contentResolver.getType(uri) ?: "application/octet-stream"
    return UploadFileRequest(
        uri = uri,
        fileName = displayName,
        mimeType = mimeType,
        sizeBytes = sizeBytes,
        targetScope = scope,
        groupName = groupName,
    )
}
