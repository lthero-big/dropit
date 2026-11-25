package dev.dropit.app.core.repository

import dev.dropit.app.BuildConfig
import dev.dropit.app.core.network.AppUpdateManifest
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

sealed class UpdateCheckResult {
    data class UpdateAvailable(
        val manifest: AppUpdateManifest,
        val downloadUrl: String,
    ) : UpdateCheckResult()

    data class UpToDate(val currentVersionName: String) : UpdateCheckResult()
    data object NoReleasePublished : UpdateCheckResult()
    data class Error(val message: String) : UpdateCheckResult()
}

sealed class UpdateInstallState {
    data object Idle : UpdateInstallState()
    data class Downloading(val receivedBytes: Long, val totalBytes: Long) : UpdateInstallState() {
        val progress: Float
            get() = if (totalBytes <= 0L) 0f else (receivedBytes.toFloat() / totalBytes.toFloat()).coerceIn(0f, 1f)
    }

    data object Verifying : UpdateInstallState()
    data object NeedsInstallPermission : UpdateInstallState()
    data object ReadyToInstall : UpdateInstallState()
    data class Failed(val message: String) : UpdateInstallState()
}

/**
 * Decoupling contract for self-hosted APK update checking, SHA-256 verification and installation (Stage 2A -> Stage 3B).
 */
interface AppUpdater {
    val installState: StateFlow<UpdateInstallState>

    suspend fun checkLatest(force: Boolean = false): UpdateCheckResult
    suspend fun shouldPromptAutoUpdate(manifest: AppUpdateManifest): Boolean
    suspend fun downloadAndInstall(manifest: AppUpdateManifest): UpdateInstallState
    suspend fun skipVersion(versionCode: Int)
    suspend fun skipVersion(manifest: AppUpdateManifest) {
        skipVersion(manifest.versionCode)
    }
    fun resetInstallState()
}

class PlaceholderAppUpdater : AppUpdater {
    private val _installState = MutableStateFlow<UpdateInstallState>(UpdateInstallState.Idle)
    override val installState: StateFlow<UpdateInstallState> = _installState.asStateFlow()

    override suspend fun checkLatest(force: Boolean): UpdateCheckResult =
        UpdateCheckResult.UpToDate(BuildConfig.VERSION_NAME)

    override suspend fun shouldPromptAutoUpdate(manifest: AppUpdateManifest): Boolean = false

    override suspend fun downloadAndInstall(manifest: AppUpdateManifest): UpdateInstallState =
        UpdateInstallState.Failed("AppUpdater implementation pending Stage 2A")

    override suspend fun skipVersion(versionCode: Int) = Unit

    override fun resetInstallState() {
        _installState.value = UpdateInstallState.Idle
    }
}
