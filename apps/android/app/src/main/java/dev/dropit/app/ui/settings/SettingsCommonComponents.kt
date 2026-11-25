package dev.dropit.app.ui.settings

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.displayCutoutPadding
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.ContentCopy
import androidx.compose.material.icons.rounded.ErrorOutline
import androidx.compose.material.icons.rounded.Lock
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Share
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.dropit.app.core.auth.AccountCapabilityState
import dev.dropit.app.ui.theme.DropitElevation
import dev.dropit.app.ui.theme.DropitMonoTypography
import dev.dropit.app.ui.theme.DropitTheme
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@Composable
internal fun SettingsSubPageScaffold(
    title: String,
    onBack: () -> Unit,
    isLoading: Boolean = false,
    onRefresh: (() -> Unit)? = null,
    headerActions: @Composable RowScope.() -> Unit = {},
    scrollable: Boolean = true,
    content: @Composable ColumnScope.() -> Unit,
) {
    val colors = DropitTheme.colors

    BackHandler(onBack = onBack)

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(colors.bg)
            .navigationBarsPadding()
            .imePadding(),
    ) {
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
                    .padding(horizontal = 8.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                IconButton(
                    onClick = onBack,
                    modifier = Modifier.defaultMinSize(minWidth = 48.dp, minHeight = 48.dp),
                ) {
                    Icon(
                        imageVector = Icons.AutoMirrored.Rounded.ArrowBack,
                        contentDescription = "返回",
                        tint = colors.fg,
                    )
                }
                Text(
                    text = title,
                    style = MaterialTheme.typography.titleMedium,
                    color = colors.fg,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                headerActions()
                if (onRefresh != null) {
                    IconButton(
                        onClick = onRefresh,
                        enabled = !isLoading,
                        modifier = Modifier.defaultMinSize(minWidth = 48.dp, minHeight = 48.dp),
                    ) {
                        if (isLoading) {
                            CircularProgressIndicator(
                                modifier = Modifier.size(18.dp),
                                strokeWidth = 2.dp,
                                color = colors.brand,
                            )
                        } else {
                            Icon(
                                imageVector = Icons.Rounded.Refresh,
                                contentDescription = "刷新",
                                tint = colors.fg2,
                            )
                        }
                    }
                }
            }
        }
        HorizontalDivider(thickness = 1.dp, color = colors.line1)

        if (scrollable) {
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .verticalScroll(rememberScrollState())
                    .padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp),
                content = content,
            )
        } else {
            Column(
                modifier = Modifier.fillMaxSize(),
                content = content,
            )
        }
    }
}

@Composable
internal fun InsufficientScopeUpgradeCard(
    message: String = AccountCapabilityState.DEFAULT_MESSAGE,
    onReauthenticate: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = DropitTheme.colors
    val shapes = DropitTheme.shapes

    Surface(
        modifier = modifier
            .fillMaxWidth()
            .semantics { liveRegion = LiveRegionMode.Polite },
        shape = shapes.lg,
        color = colors.warnSoft,
        border = BorderStroke(1.dp, colors.warn.copy(alpha = 0.4f)),
        tonalElevation = 0.dp,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Icon(
                    imageVector = Icons.Rounded.Lock,
                    contentDescription = null,
                    tint = colors.warn,
                    modifier = Modifier.size(20.dp),
                )
                Text(
                    text = "需要重新登录以解锁应用内设置",
                    style = MaterialTheme.typography.titleMedium,
                    color = colors.fg,
                )
            }
            Text(
                text = message,
                style = MaterialTheme.typography.bodySmall,
                color = colors.fg2,
            )
            Button(
                onClick = onReauthenticate,
                modifier = Modifier
                    .fillMaxWidth()
                    .defaultMinSize(minHeight = 48.dp),
                shape = shapes.md,
                colors = ButtonDefaults.buttonColors(
                    containerColor = colors.brand,
                    contentColor = colors.brandFg,
                ),
            ) {
                Text(
                    text = "重新登录（密码或 GitHub / Google）",
                    fontWeight = FontWeight.SemiBold,
                )
            }
        }
    }
}

@Composable
internal fun SettingsSectionCard(
    title: String? = null,
    subtitle: String? = null,
    modifier: Modifier = Modifier,
    content: @Composable ColumnScope.() -> Unit,
) {
    val colors = DropitTheme.colors
    val shapes = DropitTheme.shapes
    Surface(
        modifier = modifier.fillMaxWidth(),
        shape = shapes.lg,
        color = colors.surface1,
        border = BorderStroke(1.dp, colors.line1),
        shadowElevation = DropitElevation.card(colors.isDark),
        tonalElevation = 0.dp,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            if (title != null || subtitle != null) {
                Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    if (title != null) {
                        Text(
                            text = title,
                            style = MaterialTheme.typography.titleMedium,
                            color = colors.fg,
                        )
                    }
                    if (subtitle != null) {
                        Text(
                            text = subtitle,
                            style = MaterialTheme.typography.bodySmall,
                            color = colors.fg3,
                        )
                    }
                }
            }
            content()
        }
    }
}

@Composable
internal fun SettingsBanner(
    message: String,
    isError: Boolean,
    modifier: Modifier = Modifier,
) {
    val colors = DropitTheme.colors
    val shapes = DropitTheme.shapes
    val bg = if (isError) colors.brandSoft else colors.okSoft
    val fg = if (isError) colors.destructive else colors.ok
    val icon = if (isError) Icons.Rounded.ErrorOutline else Icons.Rounded.CheckCircle

    Surface(
        modifier = modifier
            .fillMaxWidth()
            .semantics { liveRegion = LiveRegionMode.Polite },
        shape = shapes.md,
        color = bg,
        border = BorderStroke(1.dp, fg.copy(alpha = 0.35f)),
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
                imageVector = icon,
                contentDescription = null,
                tint = fg,
                modifier = Modifier.size(18.dp),
            )
            Text(
                text = message,
                style = MaterialTheme.typography.bodySmall,
                color = colors.fg,
                modifier = Modifier.weight(1f),
            )
        }
    }
}

@Composable
internal fun SettingsStatusPill(
    text: String,
    containerColor: Color,
    contentColor: Color,
) {
    Surface(
        shape = DropitTheme.shapes.pill,
        color = containerColor,
        tonalElevation = 0.dp,
    ) {
        Text(
            text = text,
            style = MaterialTheme.typography.labelSmall,
            color = contentColor,
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 3.dp),
        )
    }
}

@Composable
internal fun SettingsChoiceChip(
    label: String,
    selected: Boolean,
    enabled: Boolean = true,
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
            Text(
                text = label,
                style = MaterialTheme.typography.labelMedium,
                color = if (selected) colors.bg else colors.fg2,
                modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
            )
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun SettingsCopyBox(
    label: String,
    value: String,
    hint: String? = null,
    onCopy: () -> Unit,
    onShare: (() -> Unit)? = null,
    highlightSuccess: Boolean = false,
) {
    val colors = DropitTheme.colors
    val shapes = DropitTheme.shapes

    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = shapes.md,
        color = colors.surface0,
        border = BorderStroke(
            1.dp,
            if (highlightSuccess) colors.ok.copy(alpha = 0.5f) else colors.line2,
        ),
        tonalElevation = 0.dp,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Text(
                text = label,
                style = MaterialTheme.typography.labelMedium,
                fontWeight = FontWeight.SemiBold,
                color = colors.fg,
            )
            if (hint != null) {
                Text(
                    text = hint,
                    style = MaterialTheme.typography.labelSmall,
                    color = colors.fg3,
                )
            }
            Surface(
                modifier = Modifier.fillMaxWidth(),
                shape = shapes.sm,
                color = colors.codeBg,
                border = BorderStroke(1.dp, colors.line1),
                tonalElevation = 0.dp,
            ) {
                Text(
                    text = value,
                    style = DropitMonoTypography.url,
                    color = colors.fg,
                    modifier = Modifier.padding(10.dp),
                )
            }
            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
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
                    Text("复制", fontWeight = FontWeight.SemiBold)
                }
                if (onShare != null) {
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
                        Text("分享")
                    }
                }
            }
        }
    }
}

@Composable
internal fun SettingsConfirmDialog(
    title: String,
    message: String,
    confirmLabel: String,
    isDestructive: Boolean = true,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
) {
    val colors = DropitTheme.colors
    AlertDialog(
        onDismissRequest = onDismiss,
        shape = DropitTheme.shapes.lg,
        containerColor = colors.surface1,
        titleContentColor = colors.fg,
        textContentColor = colors.fg2,
        tonalElevation = 0.dp,
        title = { Text(title, style = MaterialTheme.typography.titleMedium) },
        text = { Text(message, style = MaterialTheme.typography.bodySmall) },
        confirmButton = {
            TextButton(
                onClick = onConfirm,
                modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                colors = ButtonDefaults.textButtonColors(
                    contentColor = if (isDestructive) colors.destructive else colors.brand,
                ),
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
internal fun paperTextFieldColors() = OutlinedTextFieldDefaults.colors(
    focusedContainerColor = DropitTheme.colors.surface0,
    unfocusedContainerColor = DropitTheme.colors.surface0,
    focusedBorderColor = DropitTheme.colors.line3,
    unfocusedBorderColor = DropitTheme.colors.line2,
    errorBorderColor = DropitTheme.colors.destructive,
    focusedLabelColor = DropitTheme.colors.fg2,
    unfocusedLabelColor = DropitTheme.colors.fg3,
    cursorColor = DropitTheme.colors.brand,
)

internal fun formatSettingsDateTime(epochMs: Long?): String {
    if (epochMs == null || epochMs <= 0L) return "—"
    return SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.getDefault()).format(Date(epochMs))
}

internal fun copySettingsText(context: Context, label: String, text: String) {
    val manager = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return
    manager.setPrimaryClip(ClipData.newPlainText(label, text))
    Toast.makeText(context, "已复制", Toast.LENGTH_SHORT).show()
}

internal fun shareSettingsText(context: Context, text: String) {
    val intent = Intent(Intent.ACTION_SEND).apply {
        type = "text/plain"
        putExtra(Intent.EXTRA_TEXT, text)
    }
    runCatching {
        context.startActivity(Intent.createChooser(intent, "分享"))
    }.onFailure {
        Toast.makeText(context, "未找到可接收分享的应用", Toast.LENGTH_SHORT).show()
    }
}

internal fun openSettingsCustomTab(context: Context, rawUrl: String) {
    dev.dropit.app.ui.common.CustomTabsHelper.openUrl(
        context = context,
        rawUrl = rawUrl,
        fallbackErrorMessage = "未找到可用的浏览器",
    )
}
