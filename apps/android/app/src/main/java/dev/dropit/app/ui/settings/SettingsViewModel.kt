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
        val isNewSession = lastAutoCheckedSessionKey != null
        lastAutoCheckedSessionKey = sessionKey
        if (isNewSession) {
            appUpdater.resetInstallState()
            _uiState.value = SettingsUiState()
        }

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
