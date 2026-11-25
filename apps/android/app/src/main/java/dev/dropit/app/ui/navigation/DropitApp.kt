package dev.dropit.app.ui.navigation

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.ContentPaste
import androidx.compose.material.icons.rounded.Settings
import androidx.compose.material.icons.rounded.SwapVert
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import coil.ImageLoader
import dev.dropit.app.core.auth.ThemeMode
import dev.dropit.app.core.network.ClipItem
import dev.dropit.app.core.network.TargetScope
import dev.dropit.app.core.repository.MediaRepository
import dev.dropit.app.di.AppContainer
import dev.dropit.app.ui.board.BoardScreen
import dev.dropit.app.ui.board.BoardViewModel
import dev.dropit.app.ui.onboarding.OnboardingScreen
import dev.dropit.app.ui.onboarding.OnboardingViewModel
import dev.dropit.app.ui.rooms.RoomViewModel
import dev.dropit.app.ui.settings.AppUpdateDialog
import dev.dropit.app.ui.settings.SettingsScreen
import dev.dropit.app.ui.settings.SettingsViewModel
import dev.dropit.app.ui.share.ItemShareViewModel
import dev.dropit.app.ui.share.ShareTargetSheet
import dev.dropit.app.ui.share.ShareTargetViewModel
import dev.dropit.app.ui.theme.DropitTheme
import dev.dropit.app.ui.transfers.TransfersScreen
import dev.dropit.app.ui.transfers.TransfersViewModel
import dev.dropit.app.ui.viewer.ImageLightbox
import dev.dropit.app.ui.viewer.MediaPlayerViewer
import dev.dropit.app.ui.viewer.TextMarkdownViewer
import kotlinx.coroutines.delay

enum class MainTab(
    val label: String,
    val icon: ImageVector,
) {
    BOARD("内容", Icons.Rounded.ContentPaste),
    TRANSFERS("传输", Icons.Rounded.SwapVert),
    SETTINGS("设置", Icons.Rounded.Settings),
}

private sealed class ActiveViewer {
    data class Images(
        val images: List<ClipItem>,
        val initialIndex: Int,
        val scope: TargetScope,
    ) : ActiveViewer()

    data class Media(
        val item: ClipItem,
        val isVideo: Boolean,
        val scope: TargetScope,
    ) : ActiveViewer()

    data class TextReader(
        val item: ClipItem,
    ) : ActiveViewer()
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
            Column(modifier = Modifier.fillMaxSize()) {
                if (rootState.hasPendingShare) {
                    Surface(
                        modifier = Modifier.fillMaxWidth(),
                        color = colors.warnSoft,
                        tonalElevation = 0.dp,
                    ) {
                        Text(
                            text = "已暂存待发送的分享内容，完成登录后将自动弹出确认面板。",
                            style = MaterialTheme.typography.labelMedium,
                            color = colors.warn,
                            modifier = Modifier
                                .statusBarsPadding()
                                .padding(horizontal = 16.dp, vertical = 10.dp),
                        )
                    }
                }
                Box(modifier = Modifier.weight(1f)) {
                    OnboardingScreen(viewModel = onboardingViewModel)
                }
            }
        }

        is AppRoute.Main -> {
            val sessionKey = "${route.serverOrigin}#${route.sessionGeneration}"
            val serverOriginProvider = remember(container) {
                { container.authRepository.sessionState.value.serverOrigin.orEmpty() }
            }

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
            val transfersViewModel: TransfersViewModel = viewModel(
                key = "transfers",
                factory = TransfersViewModel.Factory(
                    transferManager = container.transferManager,
                ),
            )
            val roomViewModel: RoomViewModel = viewModel(
                key = "rooms",
                factory = RoomViewModel.Factory(
                    roomRepository = container.roomRepository,
                    serverOriginProvider = serverOriginProvider,
                    onSessionExpired = appViewModel::markSessionExpired,
                ),
            )
            val itemShareViewModel: ItemShareViewModel = viewModel(
                key = "item-share",
                factory = ItemShareViewModel.Factory(
                    itemShareRepository = container.itemShareRepository,
                    serverOriginProvider = serverOriginProvider,
                    onSessionExpired = appViewModel::markSessionExpired,
                ),
            )
            val shareTargetViewModel: ShareTargetViewModel = viewModel(
                key = "share-target",
                factory = ShareTargetViewModel.Factory(
                    shareInbox = container.shareInbox,
                    boardRepository = container.boardRepository,
                    transferManager = container.transferManager,
                    onSessionExpired = appViewModel::markSessionExpired,
                ),
            )
            val settingsViewModel: SettingsViewModel = viewModel(
                key = "settings",
                factory = SettingsViewModel.Factory(
                    appUpdater = container.appUpdater,
                ),
            )

            val imageLoader = remember(container, sessionKey) {
                container.mediaRepository.createImageLoader()
            }

            LaunchedEffect(sessionKey) {
                boardViewModel.activateSession(sessionKey)
                // Asynchronous non-blocking update check once per authenticated session
                settingsViewModel.triggerBackgroundUpdateCheck(sessionKey)
            }

            DropitMainScaffold(
                serverOrigin = route.serverOrigin,
                rootState = rootState,
                boardViewModel = boardViewModel,
                transfersViewModel = transfersViewModel,
                roomViewModel = roomViewModel,
                itemShareViewModel = itemShareViewModel,
                shareTargetViewModel = shareTargetViewModel,
                settingsViewModel = settingsViewModel,
                mediaRepository = container.mediaRepository,
                imageLoader = imageLoader,
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
    transfersViewModel: TransfersViewModel,
    roomViewModel: RoomViewModel,
    itemShareViewModel: ItemShareViewModel,
    shareTargetViewModel: ShareTargetViewModel,
    settingsViewModel: SettingsViewModel,
    mediaRepository: MediaRepository,
    imageLoader: ImageLoader,
    onThemeModeChange: (ThemeMode) -> Unit,
    onLogoutAndSwitchServer: () -> Unit,
) {
    val colors = DropitTheme.colors
    val context = LocalContext.current
    var selectedTab by rememberSaveable { mutableStateOf(MainTab.BOARD) }
    var activeViewer by remember { mutableStateOf<ActiveViewer?>(null) }

    val boardState by boardViewModel.uiState.collectAsStateWithLifecycle()
    val shareTargetState by shareTargetViewModel.uiState.collectAsStateWithLifecycle()
    val settingsState by settingsViewModel.uiState.collectAsStateWithLifecycle()

    var nowMs by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(30_000L)
            nowMs = System.currentTimeMillis()
        }
    }

    // Keep system share confirmation target list aligned with available writable spaces & active room
    LaunchedEffect(
        boardState.spaces,
        boardState.me?.user?.id,
        boardState.activeRoom,
        boardState.activeScope,
        boardState.groups,
    ) {
        shareTargetViewModel.syncTargets(
            spaces = boardState.spaces,
            currentUserId = boardState.me?.user?.id,
            activeRoom = boardState.activeRoom,
            knownScopeGroups = boardState.activeScope to boardState.groups,
        )
    }

    val spaceNames = remember(boardState.spaces) {
        boardState.spaces.associate { it.id to it.name.ifBlank { "我的空间" } }
    }

    // Global back stack rule (§2.2): non-home tabs return to Board before exiting app
    // (disabled whenever a fullscreen viewer is open so the viewer consumes Back first).
    BackHandler(enabled = activeViewer == null && selectedTab != MainTab.BOARD) {
        selectedTab = MainTab.BOARD
    }

    Box(modifier = Modifier.fillMaxSize()) {
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
                                    if (tab == MainTab.TRANSFERS &&
                                        (rootState.activeTransferCount > 0 || rootState.failedTransferCount > 0)
                                    ) {
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
                        roomViewModel = roomViewModel,
                        itemShareViewModel = itemShareViewModel,
                        mediaRepository = mediaRepository,
                        imageLoader = imageLoader,
                        onNavigateToTransfers = { selectedTab = MainTab.TRANSFERS },
                        onOpenImageLightbox = { images, index, scope ->
                            activeViewer = ActiveViewer.Images(images, index, scope)
                        },
                        onOpenMediaPlayer = { item, isVideo, scope ->
                            activeViewer = ActiveViewer.Media(item, isVideo, scope)
                        },
                        onOpenTextReader = { item ->
                            activeViewer = ActiveViewer.TextReader(item)
                        },
                    )

                    MainTab.TRANSFERS -> TransfersScreen(
                        viewModel = transfersViewModel,
                        spaceNames = spaceNames,
                    )

                    MainTab.SETTINGS -> SettingsScreen(
                        serverOrigin = serverOrigin,
                        me = boardState.me,
                        themeMode = rootState.themeMode,
                        isLoggingOut = rootState.isLoggingOut,
                        settingsState = settingsState,
                        onThemeModeChange = onThemeModeChange,
                        onCheckUpdate = settingsViewModel::checkForUpdateManually,
                        onLogoutAndSwitchServer = onLogoutAndSwitchServer,
                    )
                }
            }
        }

        // Immersive full-screen viewers (cover bottom navigation bar cleanly)
        when (val viewer = activeViewer) {
            is ActiveViewer.Images -> {
                ImageLightbox(
                    images = viewer.images,
                    initialIndex = viewer.initialIndex,
                    scope = viewer.scope,
                    mediaRepository = mediaRepository,
                    imageLoader = imageLoader,
                    onSaveOriginal = { item ->
                        boardViewModel.downloadItem(item)
                        Toast.makeText(context, "已开始保存原图到「下载」", Toast.LENGTH_SHORT).show()
                    },
                    onShareImage = { item ->
                        boardViewModel.prepareFileForShare(item) { uri ->
                            shareUri(context, uri, item.mime ?: "image/*")
                        }
                    },
                    onClose = { activeViewer = null },
                )
            }

            is ActiveViewer.Media -> {
                MediaPlayerViewer(
                    item = viewer.item,
                    isVideo = viewer.isVideo,
                    scope = viewer.scope,
                    mediaRepository = mediaRepository,
                    onDownloadFallback = { item ->
                        boardViewModel.downloadItem(item)
                        Toast.makeText(context, "已加入下载队列", Toast.LENGTH_SHORT).show()
                    },
                    onShareMedia = { item ->
                        boardViewModel.prepareFileForShare(item) { uri ->
                            shareUri(context, uri, item.mime ?: "*/*")
                        }
                    },
                    onClose = { activeViewer = null },
                )
            }

            is ActiveViewer.TextReader -> {
                TextMarkdownViewer(
                    item = viewer.item,
                    nowMs = nowMs,
                    onCopyText = { text ->
                        copyPlainText(context, text)
                        boardViewModel.markItemCopied(viewer.item.id)
                    },
                    onShareText = { text ->
                        shareText(context, text)
                    },
                    onOpenUrl = { url ->
                        openUrlExternally(context, url)
                    },
                    onClose = { activeViewer = null },
                )
            }

            null -> Unit
        }

        // System Share Confirmation Bottom Sheet (shown once authenticated & pending share exists)
        if (shareTargetState.pendingShare != null) {
            ShareTargetSheet(
                state = shareTargetState,
                onSelectTarget = shareTargetViewModel::selectTarget,
                onSelectGroup = shareTargetViewModel::selectGroup,
                onTextChanged = shareTargetViewModel::updateText,
                onRemoveFile = shareTargetViewModel::removeFile,
                onConfirmSend = {
                    shareTargetViewModel.submitShare { feedback, hasFiles ->
                        boardViewModel.showSnackbar(feedback, showTransfersAction = hasFiles)
                        if (hasFiles) {
                            selectedTab = MainTab.TRANSFERS
                        } else {
                            selectedTab = MainTab.BOARD
                        }
                    }
                },
                onCancel = shareTargetViewModel::cancelShare,
            )
        }

        // Non-blocking App Update Dialog
        settingsState.promptManifest?.let { manifest ->
            AppUpdateDialog(
                manifest = manifest,
                isAutoPrompt = settingsState.isAutoPrompt,
                installState = settingsState.installState,
                onDownloadAndInstall = settingsViewModel::startDownloadAndInstall,
                onSkipVersion = settingsViewModel::skipPromptedVersion,
                onDismiss = settingsViewModel::dismissUpdateDialog,
            )
        }
    }
}

private fun copyPlainText(context: Context, text: String) {
    val manager = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return
    manager.setPrimaryClip(ClipData.newPlainText("dropit", text))
}

private fun shareText(context: Context, text: String) {
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

private fun shareUri(context: Context, uri: Uri, mimeType: String) {
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

private fun openUrlExternally(context: Context, rawUrl: String) {
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
