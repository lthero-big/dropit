package dev.dropit.app.ui.navigation

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.displayCutoutPadding
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.Logout
import androidx.compose.material.icons.rounded.ContentPaste
import androidx.compose.material.icons.rounded.Download
import androidx.compose.material.icons.rounded.Settings
import androidx.compose.material.icons.rounded.SwapVert
import androidx.compose.material.icons.rounded.Upload
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.dropit.app.BuildConfig
import dev.dropit.app.core.auth.ThemeMode
import dev.dropit.app.core.network.ServerUrl
import dev.dropit.app.core.repository.TransferDirection
import dev.dropit.app.core.repository.TransferStatus
import dev.dropit.app.core.repository.TransferTask
import dev.dropit.app.di.AppContainer
import dev.dropit.app.ui.board.BoardScreen
import dev.dropit.app.ui.board.BoardViewModel
import dev.dropit.app.ui.board.ClipFormatting
import dev.dropit.app.ui.onboarding.OnboardingScreen
import dev.dropit.app.ui.onboarding.OnboardingViewModel
import dev.dropit.app.ui.theme.DropitElevation
import dev.dropit.app.ui.theme.DropitMonoTypography
import dev.dropit.app.ui.theme.DropitTheme

enum class MainTab(
    val label: String,
    val icon: ImageVector,
) {
    BOARD("内容", Icons.Rounded.ContentPaste),
    TRANSFERS("传输", Icons.Rounded.SwapVert),
    SETTINGS("设置", Icons.Rounded.Settings),
}

@Composable
fun DropitApp(
    container: AppContainer,
    appViewModel: AppViewModel,
) {
    val rootState by appViewModel.uiState.collectAsStateWithLifecycle()
    val colors = DropitTheme.colors

    when (val route = rootState.route) {
        AppRoute.Initializing -> {
            // Local-first warm paper placeholder during sub-frame local DataStore/Keystore read
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .background(colors.bg),
            )
        }

        is AppRoute.Onboarding -> {
            val onboardingViewModel: OnboardingViewModel = viewModel(
                key = "onboarding",
                factory = OnboardingViewModel.Factory(
                    authRepository = container.authRepository,
                    initialServerOrigin = route.serverOrigin,
                    initialSessionExpired = route.sessionExpired,
                ),
            )
            LaunchedEffect(route.serverOrigin, route.sessionExpired) {
                onboardingViewModel.syncEntry(route.serverOrigin, route.sessionExpired)
            }
            OnboardingScreen(viewModel = onboardingViewModel)
        }

        is AppRoute.Main -> {
            val sessionKey = "${route.serverOrigin}#${route.sessionGeneration}"
            val boardViewModel: BoardViewModel = viewModel(
                key = "board",
                factory = BoardViewModel.Factory(
                    spaceRepository = container.spaceRepository,
                    boardRepository = container.boardRepository,
                    realtimeClient = container.realtimeClient,
                    transferManager = container.transferManager,
                    sessionExpiredEvents = container.apiClient.sessionExpiredEvents,
                    onSessionExpired = appViewModel::markSessionExpired,
                ),
            )
            LaunchedEffect(sessionKey) {
                boardViewModel.activateSession(sessionKey)
            }
            DropitMainScaffold(
                serverOrigin = route.serverOrigin,
                rootState = rootState,
                boardViewModel = boardViewModel,
                onThemeModeChange = appViewModel::setThemeMode,
                onLogoutAndSwitchServer = appViewModel::logoutAndSwitchServer,
            )
        }
    }
}

@Composable
private fun DropitMainScaffold(
    serverOrigin: String,
    rootState: AppRootUiState,
    boardViewModel: BoardViewModel,
    onThemeModeChange: (ThemeMode) -> Unit,
    onLogoutAndSwitchServer: () -> Unit,
) {
    val colors = DropitTheme.colors
    var selectedTab by rememberSaveable { mutableStateOf(MainTab.BOARD) }

    // Global back stack rule (§2.2): non-home tabs return to Board before exiting app.
    BackHandler(enabled = selectedTab != MainTab.BOARD) {
        selectedTab = MainTab.BOARD
    }

    Scaffold(
        modifier = Modifier.fillMaxSize(),
        containerColor = colors.bg,
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        bottomBar = {
            Column(modifier = Modifier.fillMaxWidth()) {
                HorizontalDivider(thickness = 1.dp, color = colors.line1)
                NavigationBar(
                    containerColor = colors.surface0,
                    contentColor = colors.fg,
                    tonalElevation = 0.dp,
                    modifier = Modifier.navigationBarsPadding(),
                ) {
                    MainTab.entries.forEach { tab ->
                        val selected = selectedTab == tab
                        NavigationBarItem(
                            selected = selected,
                            onClick = { selectedTab = tab },
                            icon = {
                                if (tab == MainTab.TRANSFERS && (rootState.activeTransferCount > 0 || rootState.failedTransferCount > 0)) {
                                    BadgedBox(
                                        badge = {
                                            Badge(
                                                containerColor = colors.brand,
                                                contentColor = colors.brandFg,
                                            ) {
                                                val badgeText = when {
                                                    rootState.activeTransferCount > 99 -> "99+"
                                                    rootState.activeTransferCount > 0 -> rootState.activeTransferCount.toString()
                                                    else -> "!"
                                                }
                                                Text(
                                                    text = badgeText,
                                                    style = MaterialTheme.typography.labelSmall,
                                                )
                                            }
                                        },
                                    ) {
                                        Icon(
                                            imageVector = tab.icon,
                                            contentDescription = tab.label,
                                        )
                                    }
                                } else {
                                    Icon(
                                        imageVector = tab.icon,
                                        contentDescription = tab.label,
                                    )
                                }
                            },
                            label = {
                                Text(
                                    text = tab.label,
                                    style = MaterialTheme.typography.labelMedium,
                                    maxLines = 1,
                                    softWrap = false,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            },
                            colors = NavigationBarItemDefaults.colors(
                                selectedIconColor = colors.brand,
                                selectedTextColor = colors.fg,
                                indicatorColor = colors.surface2,
                                unselectedIconColor = colors.fg3,
                                unselectedTextColor = colors.fg3,
                            ),
                        )
                    }
                }
            }
        },
    ) { innerPadding ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding),
        ) {
            when (selectedTab) {
                MainTab.BOARD -> BoardScreen(
                    viewModel = boardViewModel,
                    onNavigateToTransfers = { selectedTab = MainTab.TRANSFERS },
                )

                MainTab.TRANSFERS -> TransfersPlaceholderScreen(
                    tasks = rootState.transferTasks,
                    activeCount = rootState.activeTransferCount,
                )

                MainTab.SETTINGS -> {
                    val boardState by boardViewModel.uiState.collectAsStateWithLifecycle()
                    SettingsPlaceholderScreen(
                        serverOrigin = serverOrigin,
                        userName = boardState.me?.user?.name,
                        userEmail = boardState.me?.user?.email,
                        isAdmin = boardState.me?.user?.isAdmin == true,
                        themeMode = rootState.themeMode,
                        isLoggingOut = rootState.isLoggingOut,
                        onThemeModeChange = onThemeModeChange,
                        onLogoutAndSwitchServer = onLogoutAndSwitchServer,
                    )
                }
            }
        }
    }
}

/**
 * Stage 2B placeholder for Transfers tab; Stage 3B (RHEA-258) replaces this with full queue controls.
 */
@Composable
private fun TransfersPlaceholderScreen(
    tasks: List<TransferTask>,
    activeCount: Int,
) {
    val colors = DropitTheme.colors
    val shapes = DropitTheme.shapes

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(colors.bg),
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
                    .padding(horizontal = 16.dp, vertical = 14.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(
                    text = "传输队列",
                    style = MaterialTheme.typography.titleLarge,
                    color = colors.fg,
                )
                if (activeCount > 0) {
                    Text(
                        text = "$activeCount 项进行中",
                        style = DropitMonoTypography.meta,
                        color = colors.brand,
                    )
                }
            }
        }
        HorizontalDivider(thickness = 1.dp, color = colors.line1)

        if (tasks.isEmpty()) {
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
                        text = "发送大文件或保存文件时会在这里展示实时进度；完整的暂停、断点续传与历史清理交互将在下一阶段补齐。",
                        style = MaterialTheme.typography.bodySmall,
                        color = colors.fg3,
                    )
                }
            }
        } else {
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(14.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                items(tasks, key = { it.id }) { task ->
                    Surface(
                        modifier = Modifier.fillMaxWidth(),
                        shape = shapes.md,
                        color = colors.surface1,
                        border = BorderStroke(1.dp, colors.line1),
                        shadowElevation = DropitElevation.card(colors.isDark),
                        tonalElevation = 0.dp,
                    ) {
                        Column(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(14.dp),
                            verticalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(8.dp),
                            ) {
                                Icon(
                                    imageVector = if (task.direction == TransferDirection.UPLOAD) {
                                        Icons.Rounded.Upload
                                    } else {
                                        Icons.Rounded.Download
                                    },
                                    contentDescription = null,
                                    tint = if (task.direction == TransferDirection.UPLOAD) colors.brand else colors.ok,
                                    modifier = Modifier.size(18.dp),
                                )
                                Text(
                                    text = ClipFormatting.middleEllipsizeFilename(task.fileName),
                                    style = MaterialTheme.typography.bodyMedium,
                                    fontWeight = FontWeight.Medium,
                                    color = colors.fg,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                    modifier = Modifier.weight(1f),
                                )
                            }
                            LinearProgressIndicator(
                                progress = { task.progress },
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .height(4.dp),
                                color = when (task.status) {
                                    TransferStatus.SUCCEEDED -> colors.ok
                                    TransferStatus.FAILED -> colors.destructive
                                    TransferStatus.PAUSED -> colors.fg4
                                    else -> colors.brand
                                },
                                trackColor = colors.surface2,
                            )
                            val statusText = when (task.status) {
                                TransferStatus.QUEUED -> "等待中 · ${ServerUrl.formatSize(task.totalBytes)}"
                                TransferStatus.RUNNING -> "${(task.progress * 100).toInt()}% · ${ServerUrl.formatSize(task.transferredBytes)} / ${ServerUrl.formatSize(task.totalBytes)}"
                                TransferStatus.PAUSED -> "已暂停 · ${(task.progress * 100).toInt()}%"
                                TransferStatus.FAILED -> "失败 · ${task.errorMessage ?: "传输中断"}"
                                TransferStatus.SUCCEEDED -> "已完成 · ${ServerUrl.formatSize(task.totalBytes)}"
                                TransferStatus.CANCELLED -> "已取消"
                            }
                            Text(
                                text = statusText,
                                style = DropitMonoTypography.meta,
                                color = if (task.status == TransferStatus.FAILED) colors.destructive else colors.fg3,
                            )
                        }
                    }
                }
            }
        }
    }
}

/**
 * Stage 2B placeholder for Settings tab with working theme switcher & sign-out flow.
 * Stage 3B (RHEA-258) expands this with browser-session links and non-blocking app updater.
 */
@Composable
private fun SettingsPlaceholderScreen(
    serverOrigin: String,
    userName: String?,
    userEmail: String?,
    isAdmin: Boolean,
    themeMode: ThemeMode,
    isLoggingOut: Boolean,
    onThemeModeChange: (ThemeMode) -> Unit,
    onLogoutAndSwitchServer: () -> Unit,
) {
    val colors = DropitTheme.colors
    val shapes = DropitTheme.shapes
    var confirmLogout by remember { mutableStateOf(false) }
    val versionLabel = remember {
        ServerUrl.versionLabel(
            version = BuildConfig.VERSION_NAME,
            commit = BuildConfig.BUILD_COMMIT,
            date = BuildConfig.BUILD_DATE,
        )
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(colors.bg),
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
            // Account & Server Card
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
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Text(
                            text = userName?.takeIf { it.isNotBlank() } ?: "已登录设备",
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
                    if (!userEmail.isNullOrBlank()) {
                        Text(
                            text = userEmail,
                            style = MaterialTheme.typography.bodySmall,
                            color = colors.fg3,
                        )
                    }
                    HorizontalDivider(thickness = 1.dp, color = colors.line1, modifier = Modifier.padding(vertical = 6.dp))
                    Text(
                        text = "当前服务器",
                        style = MaterialTheme.typography.labelSmall,
                        color = colors.fg3,
                    )
                    Text(
                        text = serverOrigin,
                        style = DropitMonoTypography.url,
                        color = colors.fg2,
                    )
                }
            }

            // Theme Appearance Card
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
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        val options = listOf(
                            ThemeMode.SYSTEM to "跟随系统",
                            ThemeMode.LIGHT to "浅色纸感",
                            ThemeMode.DARK to "深色纸感",
                        )
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

            // Version & Stage 3B info
            Surface(
                modifier = Modifier.fillMaxWidth(),
                shape = shapes.lg,
                color = colors.surface1,
                border = BorderStroke(1.dp, colors.line1),
                tonalElevation = 0.dp,
            ) {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Text(
                        text = "应用信息",
                        style = MaterialTheme.typography.titleMedium,
                        color = colors.fg,
                    )
                    Text(
                        text = versionLabel,
                        style = DropitMonoTypography.meta,
                        color = colors.fg2,
                    )
                    Text(
                        text = "账户高级入口与应用内检查更新将于下一阶段在此页补齐。",
                        style = MaterialTheme.typography.bodySmall,
                        color = colors.fg3,
                    )
                }
            }

            // Sign Out & Switch Server
            OutlinedButton(
                onClick = { confirmLogout = true },
                enabled = !isLoggingOut,
                modifier = Modifier
                    .fillMaxWidth()
                    .defaultMinSize(minHeight = 48.dp),
                shape = shapes.md,
                border = BorderStroke(1.dp, colors.destructive.copy(alpha = 0.45f)),
                colors = ButtonDefaults.outlinedButtonColors(contentColor = colors.destructive),
            ) {
                if (isLoggingOut) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(16.dp),
                        strokeWidth = 2.dp,
                        color = colors.destructive,
                    )
                } else {
                    Icon(
                        imageVector = Icons.AutoMirrored.Rounded.Logout,
                        contentDescription = null,
                        modifier = Modifier.size(18.dp),
                    )
                    Spacer(modifier = Modifier.size(8.dp))
                    Text(
                        text = "退出登录并更换服务器",
                        style = MaterialTheme.typography.bodyMedium,
                        fontWeight = FontWeight.Medium,
                    )
                }
            }
        }
    }

    if (confirmLogout) {
        AlertDialog(
            onDismissRequest = { confirmLogout = false },
            shape = shapes.lg,
            containerColor = colors.surface1,
            titleContentColor = colors.fg,
            textContentColor = colors.fg2,
            tonalElevation = 0.dp,
            title = {
                Text("确认退出登录？", style = MaterialTheme.typography.titleMedium)
            },
            text = {
                Text(
                    text = "将吊销当前设备令牌并清理本地服务器配置与待传输队列，之后可重新配置服务器。",
                    style = MaterialTheme.typography.bodySmall,
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        confirmLogout = false
                        onLogoutAndSwitchServer()
                    },
                    modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                    colors = ButtonDefaults.textButtonColors(contentColor = colors.destructive),
                ) {
                    Text("确认退出", fontWeight = FontWeight.SemiBold)
                }
            },
            dismissButton = {
                TextButton(
                    onClick = { confirmLogout = false },
                    modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                    colors = ButtonDefaults.textButtonColors(contentColor = colors.fg2),
                ) {
                    Text("取消")
                }
            },
        )
    }
}
