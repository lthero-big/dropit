package dev.dropit.app.ui.navigation

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
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
import dev.dropit.app.data.account.AccountSettingsRepository
import dev.dropit.app.di.AppContainer
import dev.dropit.app.ui.board.BoardScreen
import dev.dropit.app.ui.board.BoardViewModel
import dev.dropit.app.ui.onboarding.OnboardingScreen
import dev.dropit.app.ui.onboarding.OnboardingViewModel
import dev.dropit.app.ui.rooms.RoomViewModel
import dev.dropit.app.ui.settings.AdminSettingsSubPage
import dev.dropit.app.ui.settings.AdminSettingsViewModel
import dev.dropit.app.ui.settings.AppUpdateDialog
import dev.dropit.app.ui.settings.DevicesSubPage
import dev.dropit.app.ui.settings.DevicesViewModel
import dev.dropit.app.ui.settings.ForcePasswordChangeDialog
import dev.dropit.app.ui.settings.SecurityAndOAuthSubPage
import dev.dropit.app.ui.settings.SecurityViewModel
import dev.dropit.app.ui.settings.SettingsScreen
import dev.dropit.app.ui.settings.SettingsSubPage
import dev.dropit.app.ui.settings.SettingsViewModel
import dev.dropit.app.ui.settings.ShareLinksSubPage
import dev.dropit.app.ui.settings.ShareLinksViewModel
import dev.dropit.app.ui.settings.SharePresetsSubPage
import dev.dropit.app.ui.settings.SharePresetsViewModel
import dev.dropit.app.ui.settings.SpaceSharingSubPage
import dev.dropit.app.ui.settings.SpaceSharingViewModel
import dev.dropit.app.ui.settings.TokensAndDeviceCodeSubPage
import dev.dropit.app.ui.settings.TokensViewModel
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
        val scope: TargetScope?,
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
                    oauthCallbackBus = container.oauthCallbackBus,
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
                    OnboardingScreen(
                        viewModel = onboardingViewModel,
                        applyStatusBarsPadding = !rootState.hasPendingShare,
                    )
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
                    accountSettingsRepository = container.accountSettingsRepository,
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
                itemShareViewModel.resetSessionState()
                roomViewModel.clearDialogFeedback()
                // Asynchronous non-blocking update check once per authenticated session
                settingsViewModel.triggerBackgroundUpdateCheck(sessionKey)
            }

            DropitMainScaffold(
                sessionKey = sessionKey,
                serverOrigin = route.serverOrigin,
                rootState = rootState,
                boardViewModel = boardViewModel,
                transfersViewModel = transfersViewModel,
                roomViewModel = roomViewModel,
                itemShareViewModel = itemShareViewModel,
                shareTargetViewModel = shareTargetViewModel,
                settingsViewModel = settingsViewModel,
                accountSettingsRepository = container.accountSettingsRepository,
                mediaRepository = container.mediaRepository,
                imageLoader = imageLoader,
                onSessionExpired = appViewModel::markSessionExpired,
                onConsumeOAuthLinkResult = appViewModel::consumeLatestOAuthLinkResult,
                onThemeModeChange = appViewModel::setThemeMode,
                onSwitchAccount = appViewModel::switchAccount,
                onLogoutAndSwitchServer = appViewModel::logoutAndSwitchServer,
            )
        }
    }
}

@Composable
private fun DropitMainScaffold(
    sessionKey: String,
    serverOrigin: String,
    rootState: AppRootUiState,
    boardViewModel: BoardViewModel,
    transfersViewModel: TransfersViewModel,
    roomViewModel: RoomViewModel,
    itemShareViewModel: ItemShareViewModel,
    shareTargetViewModel: ShareTargetViewModel,
    settingsViewModel: SettingsViewModel,
    accountSettingsRepository: AccountSettingsRepository,
    mediaRepository: MediaRepository,
    imageLoader: ImageLoader,
    onSessionExpired: () -> Unit,
    onConsumeOAuthLinkResult: () -> Unit,
    onThemeModeChange: (ThemeMode) -> Unit,
    onSwitchAccount: () -> Unit,
    onLogoutAndSwitchServer: () -> Unit,
) {
    val colors = DropitTheme.colors
    val context = LocalContext.current
    var selectedTab by rememberSaveable { mutableStateOf(MainTab.BOARD) }
    var activeSettingsSubPage by rememberSaveable { mutableStateOf<SettingsSubPage?>(null) }
    var activeViewer by remember { mutableStateOf<ActiveViewer?>(null) }

    val boardState by boardViewModel.uiState.collectAsStateWithLifecycle()
    val shareTargetState by shareTargetViewModel.uiState.collectAsStateWithLifecycle()
    val settingsState by settingsViewModel.uiState.collectAsStateWithLifecycle()

    LaunchedEffect(sessionKey) {
        activeSettingsSubPage = null
        activeViewer = null
    }

    // If an OAuth link callback returns after Activity recreation, open the Security & OAuth page
    // so the user immediately sees the link confirmation or error message.
    LaunchedEffect(rootState.latestOAuthLinkResult) {
        if (rootState.latestOAuthLinkResult != null && activeSettingsSubPage != SettingsSubPage.SECURITY_AND_OAUTH) {
            selectedTab = MainTab.SETTINGS
            activeSettingsSubPage = SettingsSubPage.SECURITY_AND_OAUTH
        }
    }

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

    // Global back stack rule (§2.2): viewers and native settings sub-pages consume Back first;
    // then non-home tabs return to Board before exiting app.
    BackHandler(enabled = activeViewer == null && activeSettingsSubPage == null && selectedTab != MainTab.BOARD) {
        selectedTab = MainTab.BOARD
    }

    Box(modifier = Modifier.fillMaxSize()) {
        Scaffold(
            modifier = Modifier.fillMaxSize(),
            containerColor = colors.bg,
            contentWindowInsets = WindowInsets(0, 0, 0, 0),
            bottomBar = {
                DropitBottomBar(
                    selectedTab = selectedTab,
                    activeTransferCount = rootState.activeTransferCount,
                    failedTransferCount = rootState.failedTransferCount,
                    onSelectTab = {
                        activeSettingsSubPage = null
                        selectedTab = it
                    },
                )
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
                            activeViewer = ActiveViewer.TextReader(item, boardState.activeScope)
                        },
                        suppressItemShareSheet = activeSettingsSubPage != null,
                        isViewerOpen = activeViewer != null,
                        onOpenSharePresets = {
                            activeSettingsSubPage = SettingsSubPage.SHARE_PRESETS
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
                        hasAdminScope = rootState.hasAdminScope,
                        accountCapability = rootState.accountCapability,
                        onOpenSubPage = { subPage -> activeSettingsSubPage = subPage },
                        onReauthenticateForUpgrade = onSwitchAccount,
                        onThemeModeChange = onThemeModeChange,
                        onCheckUpdate = settingsViewModel::checkForUpdateManually,
                        onSwitchAccount = onSwitchAccount,
                        onLogoutAndSwitchServer = onLogoutAndSwitchServer,
                    )
                }
            }
        }

        // Native Settings Secondary Pages (full-screen paper surfaces with back gesture support)
        activeSettingsSubPage?.let { subPage ->
            when (subPage) {
                SettingsSubPage.SHARE_PRESETS -> {
                    val vm: SharePresetsViewModel = viewModel(
                        key = "settings-share-presets-$sessionKey",
                        factory = SharePresetsViewModel.Factory(
                            repository = accountSettingsRepository,
                            onSessionExpired = onSessionExpired,
                        ),
                    )
                    SharePresetsSubPage(
                        viewModel = vm,
                        onBack = {
                            activeSettingsSubPage = null
                            itemShareViewModel.refreshPresets()
                        },
                        onReauthenticate = onSwitchAccount,
                        onPresetsSaved = { saved ->
                            itemShareViewModel.applyPresets(saved)
                        },
                    )
                }

                SettingsSubPage.SHARE_LINKS -> {
                    val vm: ShareLinksViewModel = viewModel(
                        key = "settings-share-links-$sessionKey",
                        factory = ShareLinksViewModel.Factory(
                            repository = accountSettingsRepository,
                            onSessionExpired = onSessionExpired,
                        ),
                    )
                    ShareLinksSubPage(
                        viewModel = vm,
                        onBack = { activeSettingsSubPage = null },
                        onReauthenticate = onSwitchAccount,
                    )
                }

                SettingsSubPage.SPACE_SHARING -> {
                    val vm: SpaceSharingViewModel = viewModel(
                        key = "settings-space-sharing-$sessionKey",
                        factory = SpaceSharingViewModel.Factory(
                            repository = accountSettingsRepository,
                            onSessionExpired = onSessionExpired,
                        ),
                    )
                    SpaceSharingSubPage(
                        viewModel = vm,
                        spaces = boardState.spaces,
                        currentUserId = boardState.me?.user?.id,
                        canManagePersonalInvites = boardState.me?.user?.isAdmin == true && rootState.hasAdminScope,
                        onSpacesChanged = { boardViewModel.loadInitial() },
                        onBack = { activeSettingsSubPage = null },
                        onReauthenticate = onSwitchAccount,
                    )
                }

                SettingsSubPage.DEVICES -> {
                    val vm: DevicesViewModel = viewModel(
                        key = "settings-devices-$sessionKey",
                        factory = DevicesViewModel.Factory(
                            repository = accountSettingsRepository,
                            onSessionExpired = onSessionExpired,
                        ),
                    )
                    DevicesSubPage(
                        viewModel = vm,
                        onBack = { activeSettingsSubPage = null },
                        onReauthenticate = onSwitchAccount,
                    )
                }

                SettingsSubPage.TOKENS_AND_DEVICE_CODE -> {
                    val vm: TokensViewModel = viewModel(
                        key = "settings-tokens-$sessionKey",
                        factory = TokensViewModel.Factory(
                            repository = accountSettingsRepository,
                            onSessionExpired = onSessionExpired,
                        ),
                    )
                    TokensAndDeviceCodeSubPage(
                        viewModel = vm,
                        onBack = { activeSettingsSubPage = null },
                        onReauthenticate = onSwitchAccount,
                    )
                }

                SettingsSubPage.SECURITY_AND_OAUTH -> {
                    val vm: SecurityViewModel = viewModel(
                        key = "settings-security-$sessionKey",
                        factory = SecurityViewModel.Factory(
                            repository = accountSettingsRepository,
                            onSessionExpired = onSessionExpired,
                        ),
                    )
                    SecurityAndOAuthSubPage(
                        viewModel = vm,
                        hasPassword = boardState.me?.hasPassword == true,
                        latestOAuthLinkResult = rootState.latestOAuthLinkResult,
                        onConsumeOAuthLinkResult = onConsumeOAuthLinkResult,
                        onPasswordUpdated = { boardViewModel.loadInitial() },
                        onBack = { activeSettingsSubPage = null },
                        onReauthenticate = onSwitchAccount,
                    )
                }

                SettingsSubPage.ADMIN -> {
                    val isAdminAllowed = boardState.me?.user?.isAdmin == true && rootState.hasAdminScope
                    if (!isAdminAllowed) {
                        LaunchedEffect(Unit) { activeSettingsSubPage = null }
                    } else {
                        val vm: AdminSettingsViewModel = viewModel(
                            key = "settings-admin-$sessionKey",
                            factory = AdminSettingsViewModel.Factory(
                                repository = accountSettingsRepository,
                                onSessionExpired = onSessionExpired,
                            ),
                        )
                        AdminSettingsSubPage(
                            viewModel = vm,
                            onBack = { activeSettingsSubPage = null },
                            onReauthenticate = onSwitchAccount,
                        )
                    }
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
                    fileSaveStateFor = { item -> boardState.fileSaveStateFor(item.id) },
                    onSaveOriginal = { item ->
                        boardViewModel.downloadItem(item) { feedback ->
                            Toast.makeText(context, feedback, Toast.LENGTH_SHORT).show()
                        }
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
                    fileSaveState = boardState.fileSaveStateFor(viewer.item.id),
                    onDownloadFallback = { item ->
                        boardViewModel.downloadItem(item) { feedback ->
                            Toast.makeText(context, feedback, Toast.LENGTH_SHORT).show()
                        }
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
                    scope = viewer.scope,
                    mediaRepository = mediaRepository,
                    fileSaveState = boardState.fileSaveStateFor(viewer.item.id),
                    onCopyText = { text ->
                        copyPlainText(context, text)
                        boardViewModel.markItemCopied(viewer.item.id)
                    },
                    onShareText = { text ->
                        shareText(context, text)
                    },
                    onDownloadFallback = if (viewer.item.isFile) {
                        {
                            boardViewModel.downloadItem(viewer.item) { feedback ->
                                Toast.makeText(context, feedback, Toast.LENGTH_SHORT).show()
                            }
                        }
                    } else {
                        null
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
            val maxTextBytes = boardState.me?.maxTextBytes ?: 0L
            ShareTargetSheet(
                state = shareTargetState,
                maxTextBytes = maxTextBytes,
                isLoadingSpaces = boardState.isLoadingInitial,
                spacesLoadError = boardState.offlineBannerMessage,
                onRetryLoadSpaces = boardViewModel::loadInitial,
                onSelectTarget = shareTargetViewModel::selectTarget,
                onSelectGroup = shareTargetViewModel::selectGroup,
                onTextChanged = shareTargetViewModel::updateText,
                onRemoveFile = shareTargetViewModel::removeFile,
                onConfirmSend = {
                    shareTargetViewModel.submitShare(maxTextBytes = maxTextBytes) { feedback, hasFiles ->
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

        // Blocking Native Forced Password Change Dialog when server requires changing a temporary password
        val requiresPasswordChange = rootState.mustChangePassword || boardState.me?.mustChangePassword == true
        if (requiresPasswordChange) {
            ForcePasswordChangeDialog(
                accountSettingsRepository = accountSettingsRepository,
                onPasswordChanged = {
                    Toast.makeText(context, "密码已修改", Toast.LENGTH_SHORT).show()
                    boardViewModel.loadInitial()
                },
                onSwitchAccount = onSwitchAccount,
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

@Composable
internal fun DropitBottomBar(
    selectedTab: MainTab,
    activeTransferCount: Int,
    failedTransferCount: Int,
    onSelectTab: (MainTab) -> Unit,
) {
    val colors = DropitTheme.colors
    Column(modifier = Modifier.fillMaxWidth()) {
        HorizontalDivider(thickness = 1.dp, color = colors.line1)
        NavigationBar(
            containerColor = colors.surface0,
            contentColor = colors.fg,
            tonalElevation = 0.dp,
        ) {
            MainTab.entries.forEach { tab ->
                val selected = selectedTab == tab
                NavigationBarItem(
                    selected = selected,
                    onClick = { onSelectTab(tab) },
                    icon = {
                        if (tab == MainTab.TRANSFERS &&
                            (activeTransferCount > 0 || failedTransferCount > 0)
                        ) {
                            BadgedBox(
                                badge = {
                                    Badge(
                                        containerColor = colors.brand,
                                        contentColor = colors.brandFg,
                                    ) {
                                        val badgeText = when {
                                            activeTransferCount > 99 -> "99+"
                                            activeTransferCount > 0 -> activeTransferCount.toString()
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
    dev.dropit.app.ui.common.CustomTabsHelper.openUrl(
        context = context,
        rawUrl = rawUrl,
        fallbackErrorMessage = "无法打开链接",
    )
}
