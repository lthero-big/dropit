package dev.dropit.app.ui.settings

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import dev.dropit.app.core.network.AppUpdateManifest
import dev.dropit.app.core.repository.AppUpdater
import dev.dropit.app.core.repository.UpdateCheckResult
import dev.dropit.app.core.repository.UpdateInstallState
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

enum class BrowserEntryId {
    SHARE_LINKS,
    SHARE_PRESETS,
    DEVICES,
    LOGIN_METHODS,
    PASSWORD,
    SPACE_SHARING,
    TOKENS,
    ADMIN,
}

data class BrowserManagementEntry(
    val id: BrowserEntryId,
    val title: String,
    val subtitle: String,
    val relativePath: String,
    val adminOnly: Boolean = false,
) {
    fun resolveUrl(serverOrigin: String): String {
        val base = serverOrigin.trim().trimEnd('/')
        return if (base.isEmpty()) relativePath else "$base$relativePath"
    }
}

/**
 * Pure definition of `browserSession()` / `adminBrowser()` guarded entries per
 * `docs/android-native-ux-spec.md` §2.8 & §3.2.
 */
object SettingsBrowserLinks {
    const val SECURITY_NOTICE = "为保护账户安全，此页在系统浏览器打开（需完整浏览器会话验证）"

    private val ALL_ENTRIES: List<BrowserManagementEntry> = listOf(
        BrowserManagementEntry(
            id = BrowserEntryId.SHARE_LINKS,
            title = "分享管理中心",
            subtitle = "查看全部历史分享、二次复制有效链接与彻底删除记录",
            relativePath = "/settings?tab=share-links",
        ),
        BrowserManagementEntry(
            id = BrowserEntryId.SHARE_PRESETS,
            title = "分享选项预设",
            subtitle = "自定义常用有效期与访问次数选项",
            relativePath = "/settings?tab=share-presets",
        ),
        BrowserManagementEntry(
            id = BrowserEntryId.DEVICES,
            title = "登录设备",
            subtitle = "查看已登录的浏览器会话并踢出其他设备",
            relativePath = "/settings?tab=devices",
        ),
        BrowserManagementEntry(
            id = BrowserEntryId.LOGIN_METHODS,
            title = "登录方式与 OAuth 绑定",
            subtitle = "管理 GitHub / Google 登录绑定与解绑",
            relativePath = "/settings?tab=login-methods",
        ),
        BrowserManagementEntry(
            id = BrowserEntryId.PASSWORD,
            title = "修改密码",
            subtitle = "设置或更改账户登录密码",
            relativePath = "/settings?tab=password",
        ),
        BrowserManagementEntry(
            id = BrowserEntryId.SPACE_SHARING,
            title = "空间成员与邀请",
            subtitle = "管理受邀成员权限（只读/可编辑）与邀请链接",
            relativePath = "/settings?tab=space-sharing",
        ),
        BrowserManagementEntry(
            id = BrowserEntryId.TOKENS,
            title = "访问令牌与设备码确认",
            subtitle = "管理 PAT 个人访问令牌与设备授权",
            relativePath = "/settings?tab=tokens",
        ),
        BrowserManagementEntry(
            id = BrowserEntryId.ADMIN,
            title = "管理员设置",
            subtitle = "邀请码、用户管理、注册策略、临时房间与运行时限制",
            relativePath = "/admin",
            adminOnly = true,
        ),
    )

    fun entriesForUser(isAdmin: Boolean): List<BrowserManagementEntry> =
        if (isAdmin) ALL_ENTRIES else ALL_ENTRIES.filterNot { it.adminOnly }
}

data class SettingsUiState(
    val isCheckingUpdate: Boolean = false,
    val updateStatusMessage: String? = null,
    val updateStatusIsError: Boolean = false,
    val promptManifest: AppUpdateManifest? = null,
    val isAutoPrompt: Boolean = false,
    val installState: UpdateInstallState = UpdateInstallState.Idle,
) {
    val isUpdateDialogVisible: Boolean
        get() = promptManifest != null
}

class SettingsViewModel(
    private val appUpdater: AppUpdater,
    private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
) : ViewModel() {

    private val _uiState = MutableStateFlow(SettingsUiState())
    val uiState: StateFlow<SettingsUiState> = _uiState.asStateFlow()

    private var lastAutoCheckedSessionKey: String? = null

    init {
        viewModelScope.launch {
            appUpdater.installState.collect { installState ->
                _uiState.update { it.copy(installState = installState) }
            }
        }
    }

    /**
     * Non-blocking asynchronous update check triggered after entering Main home.
     * Runs at most once per authenticated session key, never blocks startup, and
     * silently ignores offline/network errors or skipped versions.
     */
    fun triggerBackgroundUpdateCheck(sessionKey: String) {
        if (lastAutoCheckedSessionKey == sessionKey) return
        lastAutoCheckedSessionKey = sessionKey

        viewModelScope.launch {
            val result = runCatching {
                withContext(ioDispatcher) {
                    appUpdater.checkLatest(force = false)
                }
            }.getOrNull() ?: return@launch

            if (result is UpdateCheckResult.UpdateAvailable) {
                val shouldPrompt = runCatching {
                    withContext(ioDispatcher) {
                        appUpdater.shouldPromptAutoUpdate(result.manifest)
                    }
                }.getOrDefault(false)

                if (shouldPrompt) {
                    appUpdater.resetInstallState()
                    _uiState.update {
                        it.copy(
                            promptManifest = result.manifest,
                            isAutoPrompt = true,
                            installState = UpdateInstallState.Idle,
                        )
                    }
                }
            }
        }
    }

    /**
     * Explicit user-initiated check from Settings page.
     * Always presents a newer release even if previously skipped on auto-check.
     */
    fun checkForUpdateManually() {
        if (_uiState.value.isCheckingUpdate) return
        _uiState.update {
            it.copy(
                isCheckingUpdate = true,
                updateStatusMessage = null,
                updateStatusIsError = false,
            )
        }
        viewModelScope.launch {
            val result = try {
                withContext(ioDispatcher) {
                    appUpdater.checkLatest(force = true)
                }
            } catch (e: Exception) {
                UpdateCheckResult.Error(e.message?.takeIf { it.isNotBlank() } ?: "检查更新失败，请稍后重试")
            }

            when (result) {
                is UpdateCheckResult.UpdateAvailable -> {
                    appUpdater.resetInstallState()
                    _uiState.update {
                        it.copy(
                            isCheckingUpdate = false,
                            updateStatusMessage = "发现新版本 ${result.manifest.versionName}",
                            updateStatusIsError = false,
                            promptManifest = result.manifest,
                            isAutoPrompt = false,
                            installState = UpdateInstallState.Idle,
                        )
                    }
                }

                is UpdateCheckResult.UpToDate -> {
                    _uiState.update {
                        it.copy(
                            isCheckingUpdate = false,
                            updateStatusMessage = "已是最新版本（${result.currentVersionName}）",
                            updateStatusIsError = false,
                        )
                    }
                }

                UpdateCheckResult.NoReleasePublished -> {
                    _uiState.update {
                        it.copy(
                            isCheckingUpdate = false,
                            updateStatusMessage = "服务器尚未发布 Android 安装包",
                            updateStatusIsError = false,
                        )
                    }
                }

                is UpdateCheckResult.Error -> {
                    _uiState.update {
                        it.copy(
                            isCheckingUpdate = false,
                            updateStatusMessage = result.message,
                            updateStatusIsError = true,
                        )
                    }
                }
            }
        }
    }

    fun startDownloadAndInstall() {
        val manifest = _uiState.value.promptManifest ?: return
        val currentInstall = _uiState.value.installState
        if (currentInstall is UpdateInstallState.Downloading || currentInstall is UpdateInstallState.Verifying) {
            return
        }
        viewModelScope.launch {
            val outcome = withContext(ioDispatcher) {
                appUpdater.downloadAndInstall(manifest)
            }
            _uiState.update { it.copy(installState = outcome) }
        }
    }

    fun skipPromptedVersion() {
        val manifest = _uiState.value.promptManifest ?: return
        val currentInstall = _uiState.value.installState
        if (currentInstall is UpdateInstallState.Downloading || currentInstall is UpdateInstallState.Verifying) {
            return
        }
        viewModelScope.launch {
            withContext(ioDispatcher) {
                appUpdater.skipVersion(manifest.versionCode)
            }
            appUpdater.resetInstallState()
            _uiState.update {
                it.copy(
                    promptManifest = null,
                    isAutoPrompt = false,
                    installState = UpdateInstallState.Idle,
                )
            }
        }
    }

    fun dismissUpdateDialog() {
        val currentInstall = _uiState.value.installState
        if (currentInstall is UpdateInstallState.Downloading || currentInstall is UpdateInstallState.Verifying) {
            return
        }
        appUpdater.resetInstallState()
        _uiState.update {
            it.copy(
                promptManifest = null,
                isAutoPrompt = false,
                installState = UpdateInstallState.Idle,
            )
        }
    }

    class Factory(
        private val appUpdater: AppUpdater,
    ) : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <T : ViewModel> create(modelClass: Class<T>): T {
            return SettingsViewModel(appUpdater = appUpdater) as T
        }
    }
}
