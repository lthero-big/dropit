package dev.dropit.app.ui.share

import androidx.compose.foundation.BorderStroke
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
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.OpenInNew
import androidx.compose.material.icons.rounded.ContentCopy
import androidx.compose.material.icons.rounded.DeleteOutline
import androidx.compose.material.icons.rounded.Link
import androidx.compose.material.icons.rounded.Share
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.dropit.app.core.network.ItemShare
import dev.dropit.app.ui.board.ClipFormatting
import dev.dropit.app.ui.theme.DropitMonoTypography
import dev.dropit.app.ui.theme.DropitTheme

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun ItemShareSheet(
    state: ItemShareUiState,
    nowMs: Long,
    resolveShareUrl: (ItemShare) -> String?,
    resolveDirectUrl: (ItemShare) -> String?,
    onSelectExpiresIn: (String) -> Unit,
    onSelectMaxViews: (Int?) -> Unit,
    onCreateShare: () -> Unit,
    onRevokeShare: (String) -> Unit,
    onCopyUrl: (String) -> Unit,
    onSystemShareUrl: (String) -> Unit,
    onOpenPresetsInBrowser: () -> Unit,
    onDismiss: () -> Unit,
) {
    val item = state.item ?: return
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
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp)
                .padding(bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            // Header
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(
                    text = "单项分享链接",
                    style = MaterialTheme.typography.titleMedium,
                    color = colors.fg,
                )
                val itemTitle = if (item.isText) {
                    item.text.orEmpty().trim().lineSequence().firstOrNull().orEmpty().ifBlank { "文本条目" }
                } else {
                    ClipFormatting.middleEllipsizeFilename(item.filename ?: "文件", 34)
                }
                Text(
                    text = itemTitle,
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.fg2,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    text = "只读链接，知道链接的人无需登录即可查看；条目到期或撤回后自动失效。",
                    style = MaterialTheme.typography.labelSmall,
                    color = colors.fg3,
                )
            }

            // Expiry selector
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(
                    text = "有效期",
                    style = MaterialTheme.typography.labelMedium,
                    color = colors.fg2,
                )
                FlowRow(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    ItemShareViewModel.EXPIRY_OPTIONS.forEach { option ->
                        ShareOptionChip(
                            label = option.label,
                            selected = state.selectedExpiresIn == option.value,
                            enabled = !state.isCreating,
                            onClick = { onSelectExpiresIn(option.value) },
                        )
                    }
                }
            }

            // Max views selector
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(
                    text = "访问次数上限",
                    style = MaterialTheme.typography.labelMedium,
                    color = colors.fg2,
                )
                FlowRow(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    ItemShareViewModel.MAX_VIEWS_OPTIONS.forEach { option ->
                        ShareOptionChip(
                            label = option.label,
                            selected = state.selectedMaxViews == option.value,
                            enabled = !state.isCreating,
                            onClick = { onSelectMaxViews(option.value) },
                        )
                    }
                }
            }

            // Create action + presets browser hint
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Button(
                    onClick = onCreateShare,
                    enabled = !state.isCreating,
                    modifier = Modifier
                        .fillMaxWidth()
                        .defaultMinSize(minHeight = 48.dp),
                    shape = shapes.md,
                    colors = ButtonDefaults.buttonColors(
                        containerColor = colors.brand,
                        contentColor = colors.brandFg,
                    ),
                ) {
                    if (state.isCreating) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(16.dp),
                            strokeWidth = 2.dp,
                            color = colors.brandFg,
                        )
                    } else {
                        Icon(
                            imageVector = Icons.Rounded.Link,
                            contentDescription = null,
                            modifier = Modifier.size(18.dp),
                        )
                        Spacer(modifier = Modifier.width(6.dp))
                        Text("生成分享链接", fontWeight = FontWeight.SemiBold)
                    }
                }

                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .defaultMinSize(minHeight = 40.dp)
                        .clickable(onClick = onOpenPresetsInBrowser)
                        .padding(vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    Text(
                        text = "自定义分享预设需在系统浏览器设置中配置",
                        style = MaterialTheme.typography.labelSmall,
                        color = colors.fg3,
                    )
                    Icon(
                        imageVector = Icons.AutoMirrored.Rounded.OpenInNew,
                        contentDescription = "在系统浏览器打开分享预设",
                        tint = colors.fg3,
                        modifier = Modifier.size(13.dp),
                    )
                }
            }

            // Feedback / error banners
            state.feedbackMessage?.let { msg ->
                Surface(
                    modifier = Modifier.fillMaxWidth(),
                    shape = shapes.md,
                    color = colors.okSoft,
                    tonalElevation = 0.dp,
                ) {
                    Text(
                        text = msg,
                        style = MaterialTheme.typography.bodySmall,
                        color = colors.ok,
                        modifier = Modifier.padding(10.dp),
                    )
                }
            }

            state.errorMessage?.let { err ->
                Surface(
                    modifier = Modifier.fillMaxWidth(),
                    shape = shapes.md,
                    color = colors.brandSoft,
                    border = BorderStroke(1.dp, colors.destructive.copy(alpha = 0.35f)),
                    tonalElevation = 0.dp,
                ) {
                    Text(
                        text = err,
                        style = MaterialTheme.typography.bodySmall,
                        color = colors.destructive,
                        modifier = Modifier.padding(10.dp),
                    )
                }
            }

            // Latest generated share card
            state.latestCreatedShare?.let { created ->
                val shareUrl = resolveShareUrl(created)
                val directUrl = resolveDirectUrl(created)
                if (shareUrl != null || directUrl != null) {
                    Surface(
                        modifier = Modifier.fillMaxWidth(),
                        shape = shapes.md,
                        color = colors.surface0,
                        border = BorderStroke(1.dp, colors.ok.copy(alpha = 0.45f)),
                        tonalElevation = 0.dp,
                    ) {
                        Column(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(12.dp),
                            verticalArrangement = Arrangement.spacedBy(10.dp),
                        ) {
                            if (shareUrl != null) {
                                GeneratedLinkBlock(
                                    title = "分享页短链",
                                    url = shareUrl,
                                    hint = null,
                                    onCopy = { onCopyUrl(shareUrl) },
                                    onShare = { onSystemShareUrl(shareUrl) },
                                )
                            }
                            if (directUrl != null && item.isFile) {
                                HorizontalDivider(thickness = 1.dp, color = colors.line1)
                                GeneratedLinkBlock(
                                    title = "文件直链",
                                    url = directUrl,
                                    hint = "打开即下载，与分享页共用有效期和次数上限",
                                    onCopy = { onCopyUrl(directUrl) },
                                    onShare = { onSystemShareUrl(directUrl) },
                                )
                            }
                        }
                    }
                }
            }

            HorizontalDivider(thickness = 1.dp, color = colors.line1)

            // Active & historical shares list for this item
            Text(
                text = "当前条目的分享记录（${state.shares.size}）",
                style = MaterialTheme.typography.labelMedium,
                color = colors.fg2,
            )

            when {
                state.isLoadingList -> {
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(vertical = 16.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(22.dp),
                            strokeWidth = 2.dp,
                            color = colors.brand,
                        )
                    }
                }

                state.shares.isEmpty() -> {
                    Text(
                        text = "此条目暂未创建过分享链接。",
                        style = MaterialTheme.typography.bodySmall,
                        color = colors.fg3,
                        modifier = Modifier.padding(vertical = 6.dp),
                    )
                }

                else -> {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        state.shares.forEach { share ->
                            ShareHistoryCard(
                                share = share,
                                nowMs = nowMs,
                                shareUrl = resolveShareUrl(share),
                                isRevoking = share.id in state.revokingIds,
                                onCopy = { url -> onCopyUrl(url) },
                                onSystemShare = { url -> onSystemShareUrl(url) },
                                onRevoke = { onRevokeShare(share.id) },
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun GeneratedLinkBlock(
    title: String,
    url: String,
    hint: String?,
    onCopy: () -> Unit,
    onShare: () -> Unit,
) {
    val colors = DropitTheme.colors
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(
            text = title,
            style = MaterialTheme.typography.labelMedium,
            color = colors.fg,
            fontWeight = FontWeight.SemiBold,
        )
        Text(
            text = url,
            style = DropitMonoTypography.url,
            color = colors.fg2,
        )
        if (hint != null) {
            Text(
                text = hint,
                style = MaterialTheme.typography.labelSmall,
                color = colors.fg3,
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            TextButton(
                onClick = onCopy,
                modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                colors = ButtonDefaults.textButtonColors(contentColor = colors.brand),
            ) {
                Icon(
                    imageVector = Icons.Rounded.ContentCopy,
                    contentDescription = null,
                    modifier = Modifier.size(16.dp),
                )
                Spacer(modifier = Modifier.width(5.dp))
                Text("复制链接", fontWeight = FontWeight.SemiBold)
            }
            TextButton(
                onClick = onShare,
                modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                colors = ButtonDefaults.textButtonColors(contentColor = colors.fg2),
            ) {
                Icon(
                    imageVector = Icons.Rounded.Share,
                    contentDescription = null,
                    modifier = Modifier.size(16.dp),
                )
                Spacer(modifier = Modifier.width(5.dp))
                Text("系统分享")
            }
        }
    }
}

@Composable
private fun ShareHistoryCard(
    share: ItemShare,
    nowMs: Long,
    shareUrl: String?,
    isRevoking: Boolean,
    onCopy: (String) -> Unit,
    onSystemShare: (String) -> Unit,
    onRevoke: () -> Unit,
) {
    val colors = DropitTheme.colors
    val shapes = DropitTheme.shapes
    val status = remember(share.revoked, share.expiresAt, share.views, share.maxViews, nowMs) {
        ItemShareViewModel.resolveShareState(share, nowMs)
    }
    val isActive = status == ShareLinkState.ACTIVE
    val viewsLabel = if (share.maxViews != null) {
        "${share.views} / ${share.maxViews} 次"
    } else {
        "${share.views} 次 · 不限"
    }
    val expiryLabel = share.expiresAt?.let { exp ->
        ClipFormatting.formatRemainingExpiry(exp, nowMs)?.label
    } ?: "不过期"

    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = shapes.md,
        color = colors.surface0,
        border = BorderStroke(1.dp, colors.line1),
        tonalElevation = 0.dp,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 12.dp, vertical = 10.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Surface(
                        shape = shapes.pill,
                        color = if (isActive) colors.okSoft else colors.surface2,
                        tonalElevation = 0.dp,
                    ) {
                        Text(
                            text = status.label,
                            style = MaterialTheme.typography.labelSmall,
                            color = if (isActive) colors.ok else colors.fg4,
                            modifier = Modifier.padding(horizontal = 7.dp, vertical = 2.dp),
                        )
                    }
                    Text(
                        text = "$viewsLabel · $expiryLabel",
                        style = DropitMonoTypography.meta,
                        color = colors.fg3,
                    )
                }

                if (isActive) {
                    TextButton(
                        onClick = onRevoke,
                        enabled = !isRevoking,
                        modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                        colors = ButtonDefaults.textButtonColors(contentColor = colors.destructive),
                    ) {
                        Icon(
                            imageVector = Icons.Rounded.DeleteOutline,
                            contentDescription = null,
                            modifier = Modifier.size(16.dp),
                        )
                        Spacer(modifier = Modifier.width(4.dp))
                        Text("撤销", style = MaterialTheme.typography.labelMedium)
                    }
                }
            }

            if (isActive && shareUrl != null) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    Text(
                        text = shareUrl,
                        style = DropitMonoTypography.url,
                        color = colors.fg2,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                    TextButton(
                        onClick = { onCopy(shareUrl) },
                        modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                        colors = ButtonDefaults.textButtonColors(contentColor = colors.brand),
                    ) {
                        Text("复制", style = MaterialTheme.typography.labelMedium)
                    }
                    TextButton(
                        onClick = { onSystemShare(shareUrl) },
                        modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                        colors = ButtonDefaults.textButtonColors(contentColor = colors.fg2),
                    ) {
                        Text("分享", style = MaterialTheme.typography.labelMedium)
                    }
                }
            }
        }
    }
}

@Composable
private fun ShareOptionChip(
    label: String,
    selected: Boolean,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    val colors = DropitTheme.colors
    val shapes = DropitTheme.shapes
    Surface(
        modifier = Modifier
            .defaultMinSize(minHeight = 40.dp)
            .clickable(enabled = enabled, onClick = onClick),
        shape = shapes.pill,
        color = if (selected) colors.fg else colors.surface0,
        border = BorderStroke(1.dp, if (selected) colors.fg else colors.line2),
        tonalElevation = 0.dp,
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.labelMedium,
            color = if (selected) colors.bg else colors.fg2,
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 9.dp),
        )
    }
}
