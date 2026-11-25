package dev.dropit.app.ui.settings

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.widget.Toast
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
import androidx.compose.foundation.layout.displayCutoutPadding
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.KeyboardArrowRight
import androidx.compose.material.icons.automirrored.rounded.Logout
import androidx.compose.material.icons.rounded.AdminPanelSettings
import androidx.compose.material.icons.rounded.ContentCopy
import androidx.compose.material.icons.rounded.Devices
import androidx.compose.material.icons.rounded.Group
import androidx.compose.material.icons.rounded.Key
import androidx.compose.material.icons.rounded.Link
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Security
import androidx.compose.material.icons.rounded.SwitchAccount
import androidx.compose.material.icons.rounded.Tune
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.dropit.app.BuildConfig
import dev.dropit.app.core.auth.AccountCapabilityState
import dev.dropit.app.core.auth.ThemeMode
import dev.dropit.app.core.network.MeResponse
import dev.dropit.app.core.network.ServerUrl
import dev.dropit.app.ui.theme.DropitBrandMark
import dev.dropit.app.ui.theme.DropitElevation
import dev.dropit.app.ui.theme.DropitMonoTypography
import dev.dropit.app.ui.theme.DropitTheme

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun SettingsScreen(
    serverOrigin: String,
    me: MeResponse?,
    themeMode: ThemeMode,
    isLoggingOut: Boolean,
    settingsState: SettingsUiState,
    hasAdminScope: Boolean,
    accountCapability: AccountCapabilityState,
    onOpenSubPage: (SettingsSubPage) -> Unit,
    onReauthenticateForUpgrade: () -> Unit,
    onThemeModeChange: (ThemeMode) -> Unit,
    onCheckUpdate: () -> Unit,
    onSwitchAccount: () -> Unit,
    onLogoutAndSwitchServer: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = DropitTheme.colors
    val shapes = DropitTheme.shapes
    val context = LocalContext.current
    val stackThemeOptions = LocalDensity.current.fontScale >= 1.5f
    var confirmSwitchAccount by remember { mutableStateOf(false) }
    var confirmSwitchServer by remember { mutableStateOf(false) }

    val user = me?.user
    val isAdmin = user?.isAdmin == true
    val nativeEntries = remember(isAdmin, hasAdminScope) {
        NativeSettingsMenu.entriesForUser(isAdmin = isAdmin, hasAdminScope = hasAdminScope)
    }
    val versionLabel = remember {
        ServerUrl.versionLabel(
            version = BuildConfig.VERSION_NAME,
            commit = BuildConfig.BUILD_COMMIT,
            date = BuildConfig.BUILD_DATE,
        )
    }

    Column(
        modifier = modifier
            .fillMaxSize()
            .background(colors.bg),
    ) {
        // Top Header
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
                    .padding(horizontal = 16.dp, vertical = 14.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = "设置",
                    style = MaterialTheme.typography.titleLarge,
                    color = colors.fg,
                )
            }
        }
        HorizontalDivider(thickness = 1.dp, color = colors.line1)

        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            // 1. Account, Quota & Server Card
            Surface(
                modifier = Modifier.fillMaxWidth(),
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
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Text(
                            text = user?.name?.takeIf { it.isNotBlank() } ?: "已登录设备",
                            style = MaterialTheme.typography.titleMedium,
                            color = colors.fg,
                        )
                        if (isAdmin) {
                            Surface(
                                shape = shapes.pill,
                                color = colors.brandSoft,
                                tonalElevation = 0.dp,
                            ) {
                                Text(
                                    text = "管理员",
                                    style = MaterialTheme.typography.labelSmall,
                                    color = colors.brand,
                                    modifier = Modifier.padding(horizontal = 7.dp, vertical = 2.dp),
                                )
                            }
                        }
                    }

                    if (!user?.email.isNullOrBlank()) {
                        Text(
                            text = user!!.email,
                            style = MaterialTheme.typography.bodySmall,
                            color = colors.fg3,
                        )
                    }

                    // Storage quota bar
                    if (me != null && me.quotaBytes > 0L) {
                        val usedTotal = (me.usedBytes + me.reservedBytes).coerceAtLeast(0L)
                        val ratio = (usedTotal.toFloat() / me.quotaBytes.toFloat()).coerceIn(0f, 1f)
                        val barColor = when {
                            ratio >= 0.95f -> colors.destructive
                            ratio >= 0.80f -> colors.warn
                            else -> colors.brand
                        }
                        Column(verticalArrangement = Arrangement.spacedBy(5.dp)) {
                            FlowRow(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalArrangement = Arrangement.spacedBy(2.dp),
                            ) {
                                Text(
                                    text = "空间配额",
                                    style = MaterialTheme.typography.labelSmall,
                                    color = colors.fg3,
                                )
                                Text(
                                    text = "${ServerUrl.formatSize(usedTotal)} / ${ServerUrl.formatSize(me.quotaBytes)}",
                                    style = DropitMonoTypography.meta,
                                    color = barColor,
                                )
                            }
                            LinearProgressIndicator(
                                progress = { ratio },
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .height(4.dp)
                                    .clip(shapes.xs),
                                color = barColor,
                                trackColor = colors.surface2,
                            )
                        }
                    }

                    HorizontalDivider(thickness = 1.dp, color = colors.line1, modifier = Modifier.padding(vertical = 2.dp))

                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .defaultMinSize(minHeight = 48.dp)
                            .clip(shapes.sm)
                            .clickable {
                                copyText(context, serverOrigin)
                                Toast.makeText(context, "已复制服务器地址", Toast.LENGTH_SHORT).show()
                            }
                            .padding(vertical = 4.dp)
                            .semantics { contentDescription = "复制当前服务器地址 $serverOrigin" },
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.SpaceBetween,
                    ) {
                        Column(
                            modifier = Modifier.weight(1f),
                            verticalArrangement = Arrangement.spacedBy(2.dp),
                        ) {
                            Text(
                                text = "当前服务器",
                                style = MaterialTheme.typography.labelSmall,
                                color = colors.fg3,
                            )
                            Text(
                                text = serverOrigin,
                                style = DropitMonoTypography.url,
                                color = colors.fg2,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                        Icon(
                            imageVector = Icons.Rounded.ContentCopy,
                            contentDescription = null,
                            tint = colors.fg3,
                            modifier = Modifier.size(16.dp),
                        )
                    }
                }
            }

            // Legacy device-code upgrade banner when token lacks `account` scope
            if (accountCapability is AccountCapabilityState.InsufficientScopeForAccountSettings) {
                InsufficientScopeUpgradeCard(
                    message = accountCapability.message,
                    onReauthenticate = onReauthenticateForUpgrade,
                )
            }

            // 2. Theme Appearance Card
            Surface(
                modifier = Modifier.fillMaxWidth(),
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
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    Text(
                        text = "外观与纸感主题",
                        style = MaterialTheme.typography.titleMedium,
                        color = colors.fg,
                    )
                    val options = listOf(
                        ThemeMode.SYSTEM to "跟随系统",
                        ThemeMode.LIGHT to "浅色纸感",
                        ThemeMode.DARK to "深色纸感",
                    )
                    if (stackThemeOptions) {
                        Column(
                            modifier = Modifier.fillMaxWidth(),
                            verticalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            options.forEach { (mode, label) ->
                                val selected = themeMode == mode
                                Surface(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .defaultMinSize(minHeight = 48.dp)
                                        .clickable { onThemeModeChange(mode) },
                                    shape = shapes.md,
                                    color = if (selected) colors.fg else colors.surface0,
                                    border = BorderStroke(1.dp, if (selected) colors.fg else colors.line2),
                                    tonalElevation = 0.dp,
                                ) {
                                    Box(
                                        contentAlignment = Alignment.Center,
                                        modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
                                    ) {
                                        Text(
                                            text = label,
                                            style = MaterialTheme.typography.labelMedium,
                                            color = if (selected) colors.bg else colors.fg2,
                                        )
                                    }
                                }
                            }
                        }
                    } else {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            options.forEach { (mode, label) ->
                                val selected = themeMode == mode
                                Surface(
                                    modifier = Modifier
                                        .weight(1f)
                                        .defaultMinSize(minHeight = 48.dp)
                                        .clickable { onThemeModeChange(mode) },
                                    shape = shapes.md,
                                    color = if (selected) colors.fg else colors.surface0,
                                    border = BorderStroke(1.dp, if (selected) colors.fg else colors.line2),
                                    tonalElevation = 0.dp,
                                ) {
                                    Box(
                                        contentAlignment = Alignment.Center,
                                        modifier = Modifier.padding(horizontal = 6.dp, vertical = 10.dp),
                                    ) {
                                        Text(
                                            text = label,
                                            style = MaterialTheme.typography.labelMedium,
                                            color = if (selected) colors.bg else colors.fg2,
                                            maxLines = 1,
                                            overflow = TextOverflow.Ellipsis,
                                        )
                                    }
                                }
                            }
                        }
                    }
                }
            }

            // 3. Native Account & Admin Settings Menu (Real-time global sync)
            Surface(
                modifier = Modifier.fillMaxWidth(),
                shape = shapes.lg,
                color = colors.surface1,
                border = BorderStroke(1.dp, colors.line1),
                shadowElevation = DropitElevation.card(colors.isDark),
                tonalElevation = 0.dp,
            ) {
                Column(modifier = Modifier.fillMaxWidth()) {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 8.dp),
                        verticalArrangement = Arrangement.spacedBy(3.dp),
                    ) {
                        Text(
                            text = "账户与全局设置",
                            style = MaterialTheme.typography.titleMedium,
                            color = colors.fg,
                        )
                        Text(
                            text = "所有修改均在应用内原生完成，并即时同步至 PC 与 Web 端",
                            style = MaterialTheme.typography.labelSmall,
                            color = colors.fg3,
                        )
                    }

                    nativeEntries.forEachIndexed { index, subPage ->
                        NativeSettingsEntryRow(
                            subPage = subPage,
                            icon = iconForSubPage(subPage),
                            onClick = { onOpenSubPage(subPage) },
                        )
                        if (index < nativeEntries.lastIndex) {
                            HorizontalDivider(
                                thickness = 1.dp,
                                color = colors.line1,
                                modifier = Modifier.padding(horizontal = 16.dp),
                            )
                        }
                    }
                }
            }

            // 4. App Update & About Card
            Surface(
                modifier = Modifier.fillMaxWidth(),
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
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        DropitBrandMark(size = 36.dp)
                        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            Text(
                                text = "dropit",
                                style = MaterialTheme.typography.titleMedium,
                                color = colors.fg,
                            )
                            Text(
                                text = versionLabel,
                                style = DropitMonoTypography.meta,
                                color = colors.fg3,
                            )
                        }
                    }

                    OutlinedButton(
                        onClick = onCheckUpdate,
                        enabled = !settingsState.isCheckingUpdate,
                        modifier = Modifier
                            .fillMaxWidth()
                            .defaultMinSize(minHeight = 48.dp),
                        shape = shapes.md,
                        border = BorderStroke(1.dp, colors.line2),
                        colors = ButtonDefaults.outlinedButtonColors(contentColor = colors.fg),
                    ) {
                        if (settingsState.isCheckingUpdate) {
                            CircularProgressIndicator(
                                modifier = Modifier.size(16.dp),
                                strokeWidth = 2.dp,
                                color = colors.brand,
                            )
                            Spacer(modifier = Modifier.width(8.dp))
                            Text("正在检查更新…")
                        } else {
                            Icon(
                                imageVector = Icons.Rounded.Refresh,
                                contentDescription = null,
                                modifier = Modifier.size(17.dp),
                            )
                            Spacer(modifier = Modifier.width(6.dp))
                            Text("检查更新", fontWeight = FontWeight.Medium)
                        }
                    }

                    settingsState.updateStatusMessage?.let { status ->
                        Text(
                            text = status,
                            style = MaterialTheme.typography.bodySmall,
                            color = if (settingsState.updateStatusIsError) colors.destructive else colors.fg3,
                        )
                    }
                }
            }

            // 5. Switch Account & Switch Server
            Surface(
                modifier = Modifier.fillMaxWidth(),
                shape = shapes.lg,
                color = colors.surface1,
                border = BorderStroke(1.dp, colors.line1),
                shadowElevation = DropitElevation.card(colors.isDark),
                tonalElevation = 0.dp,
            ) {
                Column(modifier = Modifier.fillMaxWidth()) {
                    SettingsSessionActionRow(
                        title = "切换账号",
                        subtitle = "保留当前服务器地址，退出当前账号并重新登录",
                        icon = Icons.Rounded.SwitchAccount,
                        isDestructive = false,
                        isBusy = isLoggingOut,
                        onClick = { confirmSwitchAccount = true },
                    )
                    HorizontalDivider(
                        thickness = 1.dp,
                        color = colors.line1,
                        modifier = Modifier.padding(horizontal = 16.dp),
                    )
                    SettingsSessionActionRow(
                        title = "更换服务器",
                        subtitle = "退出登录并清除当前服务器配置，返回服务器配置页",
                        icon = Icons.AutoMirrored.Rounded.Logout,
                        isDestructive = true,
                        isBusy = isLoggingOut,
                        onClick = { confirmSwitchServer = true },
                    )
                }
            }

            Spacer(modifier = Modifier.height(8.dp))
        }
    }

    if (confirmSwitchAccount) {
        AlertDialog(
            onDismissRequest = { confirmSwitchAccount = false },
            shape = shapes.lg,
            containerColor = colors.surface1,
            titleContentColor = colors.fg,
            textContentColor = colors.fg2,
            tonalElevation = 0.dp,
            title = {
                Text("确认切换账号？", style = MaterialTheme.typography.titleMedium)
            },
            text = {
                Text(
                    text = "将吊销当前设备令牌，并清理当前账号的临时房间状态、图片缓存、待发分享与传输队列；当前服务器地址（$serverOrigin）将被保留，退出后可直接登录其他账号。",
                    style = MaterialTheme.typography.bodySmall,
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        confirmSwitchAccount = false
                        onSwitchAccount()
                    },
                    modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                    colors = ButtonDefaults.textButtonColors(contentColor = colors.brand),
                ) {
                    Text("确认切换", fontWeight = FontWeight.SemiBold)
                }
            },
            dismissButton = {
                TextButton(
                    onClick = { confirmSwitchAccount = false },
                    modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                    colors = ButtonDefaults.textButtonColors(contentColor = colors.fg2),
                ) {
                    Text("取消")
                }
            },
        )
    }

    if (confirmSwitchServer) {
        AlertDialog(
            onDismissRequest = { confirmSwitchServer = false },
            shape = shapes.lg,
            containerColor = colors.surface1,
            titleContentColor = colors.fg,
            textContentColor = colors.fg2,
            tonalElevation = 0.dp,
            title = {
                Text("确认更换服务器？", style = MaterialTheme.typography.titleMedium)
            },
            text = {
                Text(
                    text = "将吊销当前设备令牌，并清除本地服务器配置、临时房间状态、图片缓存、更新缓存及未完成的传输队列，返回服务器配置页重新连接服务器。",
                    style = MaterialTheme.typography.bodySmall,
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        confirmSwitchServer = false
                        onLogoutAndSwitchServer()
                    },
                    modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                    colors = ButtonDefaults.textButtonColors(contentColor = colors.destructive),
                ) {
                    Text("确认更换", fontWeight = FontWeight.SemiBold)
                }
            },
            dismissButton = {
                TextButton(
                    onClick = { confirmSwitchServer = false },
                    modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                    colors = ButtonDefaults.textButtonColors(contentColor = colors.fg2),
                ) {
                    Text("取消")
                }
            },
        )
    }
}

@Composable
private fun SettingsSessionActionRow(
    title: String,
    subtitle: String,
    icon: ImageVector,
    isDestructive: Boolean,
    isBusy: Boolean,
    onClick: () -> Unit,
) {
    val colors = DropitTheme.colors
    val accent = if (isDestructive) colors.destructive else colors.fg
    val iconTint = if (isDestructive) colors.destructive else colors.fg2
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .defaultMinSize(minHeight = 56.dp)
            .clickable(enabled = !isBusy, onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 12.dp)
            .semantics { contentDescription = "$title，$subtitle" },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Icon(
            imageVector = icon,
            contentDescription = null,
            tint = iconTint,
            modifier = Modifier.size(20.dp),
        )
        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            Text(
                text = title,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.Medium,
                color = accent,
            )
            Text(
                text = subtitle,
                style = MaterialTheme.typography.labelSmall,
                color = colors.fg3,
            )
        }
        if (isBusy) {
            CircularProgressIndicator(
                modifier = Modifier.size(16.dp),
                strokeWidth = 2.dp,
                color = iconTint,
            )
        }
    }
}

@Composable
private fun NativeSettingsEntryRow(
    subPage: SettingsSubPage,
    icon: ImageVector,
    onClick: () -> Unit,
) {
    val colors = DropitTheme.colors
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .defaultMinSize(minHeight = 56.dp)
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 12.dp)
            .semantics { contentDescription = "${subPage.title}，${subPage.subtitle}" },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Icon(
            imageVector = icon,
            contentDescription = null,
            tint = if (subPage.adminOnly) colors.brand else colors.fg2,
            modifier = Modifier.size(20.dp),
        )
        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            Text(
                text = subPage.title,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.Medium,
                color = colors.fg,
            )
            Text(
                text = subPage.subtitle,
                style = MaterialTheme.typography.labelSmall,
                color = colors.fg3,
            )
        }
        Icon(
            imageVector = Icons.AutoMirrored.Rounded.KeyboardArrowRight,
            contentDescription = null,
            tint = colors.fg4,
            modifier = Modifier.size(20.dp),
        )
    }
}

private fun iconForSubPage(subPage: SettingsSubPage): ImageVector = when (subPage) {
    SettingsSubPage.SHARE_PRESETS -> Icons.Rounded.Tune
    SettingsSubPage.SHARE_LINKS -> Icons.Rounded.Link
    SettingsSubPage.SPACE_SHARING -> Icons.Rounded.Group
    SettingsSubPage.DEVICES -> Icons.Rounded.Devices
    SettingsSubPage.TOKENS_AND_DEVICE_CODE -> Icons.Rounded.Key
    SettingsSubPage.SECURITY_AND_OAUTH -> Icons.Rounded.Security
    SettingsSubPage.ADMIN -> Icons.Rounded.AdminPanelSettings
}

private fun copyText(context: Context, text: String) {
    val manager = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return
    manager.setPrimaryClip(ClipData.newPlainText("dropit", text))
}
