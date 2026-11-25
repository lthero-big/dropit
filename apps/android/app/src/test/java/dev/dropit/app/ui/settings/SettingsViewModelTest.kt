package dev.dropit.app.ui.settings

import dev.dropit.app.core.network.AppUpdateManifest
import dev.dropit.app.core.repository.AppUpdater
import dev.dropit.app.core.repository.UpdateCheckResult
import dev.dropit.app.core.repository.UpdateInstallState
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class SettingsViewModelTest {

    private val testDispatcher = StandardTestDispatcher()

    private val newerManifest = AppUpdateManifest(
        versionCode = 7,
        versionName = "0.4.1",
        notes = "修复传输稳定性并优化纸感细节",
        size = 18_400_000L,
        sha256 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        url = "/api/app/android/download/dropit-0.4.1.apk",
    )

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    @Test
    fun browserManagementLinks_matchSpecPathsAndGateAdminEntryByRole() {
        val origin = "https://dropit.lthero.com/"
        val normalEntries = SettingsBrowserLinks.entriesForUser(isAdmin = false)
        assertFalse(normalEntries.any { it.id == BrowserEntryId.ADMIN })

        val resolvedPaths = normalEntries.associate { it.id to it.resolveUrl(origin) }
        assertEquals("https://dropit.lthero.com/settings?tab=share-links", resolvedPaths[BrowserEntryId.SHARE_LINKS])
        assertEquals("https://dropit.lthero.com/settings?tab=share-presets", resolvedPaths[BrowserEntryId.SHARE_PRESETS])
        assertEquals("https://dropit.lthero.com/settings?tab=devices", resolvedPaths[BrowserEntryId.DEVICES])
        assertEquals("https://dropit.lthero.com/settings?tab=login-methods", resolvedPaths[BrowserEntryId.LOGIN_METHODS])
        assertEquals("https://dropit.lthero.com/settings?tab=password", resolvedPaths[BrowserEntryId.PASSWORD])
        assertEquals("https://dropit.lthero.com/settings?tab=space-sharing", resolvedPaths[BrowserEntryId.SPACE_SHARING])
        assertEquals("https://dropit.lthero.com/settings?tab=tokens", resolvedPaths[BrowserEntryId.TOKENS])

        val adminEntries = SettingsBrowserLinks.entriesForUser(isAdmin = true)
        val adminEntry = adminEntries.firstOrNull { it.id == BrowserEntryId.ADMIN }
        assertNotNull(adminEntry)
        assertEquals("https://dropit.lthero.com/admin", adminEntry!!.resolveUrl(origin))
        assertTrue(SettingsBrowserLinks.SECURITY_NOTICE.contains("系统浏览器"))
    }

    @Test
    fun backgroundUpdateCheck_promptsOnceAndRespectsSkipVersionWhileManualCheckAlwaysPrompts() = runTest(testDispatcher) {
        val updater = FakeAppUpdater(
            checkResult = UpdateCheckResult.UpdateAvailable(
                manifest = newerManifest,
                downloadUrl = "https://dropit.lthero.com${newerManifest.url}",
            ),
        )
        val vm = SettingsViewModel(appUpdater = updater, ioDispatcher = testDispatcher)

        // First session background check prompts with isAutoPrompt = true
        vm.triggerBackgroundUpdateCheck("https://dropit.lthero.com#1")
        vm.triggerBackgroundUpdateCheck("https://dropit.lthero.com#1") // deduplicated
        advanceUntilIdle()

        assertEquals(1, updater.checkCallCount)
        assertEquals(newerManifest, vm.uiState.value.promptManifest)
        assertTrue(vm.uiState.value.isAutoPrompt)

        // User chooses "跳过这个版本"
        vm.skipPromptedVersion()
        advanceUntilIdle()

        assertEquals(7, updater.skippedVersionCode)
        assertNull(vm.uiState.value.promptManifest)

        // Next session background check does NOT prompt because version 7 was skipped
        vm.triggerBackgroundUpdateCheck("https://dropit.lthero.com#2")
        advanceUntilIdle()
        assertNull(vm.uiState.value.promptManifest)

        // Manual check in Settings STILL opens the update dialog with isAutoPrompt = false
        vm.checkForUpdateManually()
        advanceUntilIdle()
        assertEquals(newerManifest, vm.uiState.value.promptManifest)
        assertFalse(vm.uiState.value.isAutoPrompt)
    }

    @Test
    fun downloadAndInstall_propagatesPermissionAndSha256FailureStates() = runTest(testDispatcher) {
        val updater = FakeAppUpdater(
            checkResult = UpdateCheckResult.UpdateAvailable(
                manifest = newerManifest,
                downloadUrl = "https://dropit.lthero.com${newerManifest.url}",
            ),
            downloadOutcome = UpdateInstallState.NeedsInstallPermission,
        )
        val vm = SettingsViewModel(appUpdater = updater, ioDispatcher = testDispatcher)
        vm.checkForUpdateManually()
        advanceUntilIdle()

        vm.startDownloadAndInstall()
        advanceUntilIdle()
        assertEquals(UpdateInstallState.NeedsInstallPermission, vm.uiState.value.installState)

        // SHA-256 verification failure surfaced clearly
        updater.downloadOutcome = UpdateInstallState.Failed("安装包校验失败（SHA-256 不一致）")
        vm.startDownloadAndInstall()
        advanceUntilIdle()
        val failed = vm.uiState.value.installState as UpdateInstallState.Failed
        assertTrue(failed.message.contains("SHA-256"))
    }

    @Test
    fun manualCheck_reportsUpToDateAndNoReleaseCleanly() = runTest(testDispatcher) {
        val updater = FakeAppUpdater(checkResult = UpdateCheckResult.UpToDate("0.4.0-native"))
        val vm = SettingsViewModel(appUpdater = updater, ioDispatcher = testDispatcher)

        vm.checkForUpdateManually()
        advanceUntilIdle()
        assertNull(vm.uiState.value.promptManifest)
        assertTrue(vm.uiState.value.updateStatusMessage!!.contains("已是最新版本"))
        assertFalse(vm.uiState.value.updateStatusIsError)

        updater.checkResult = UpdateCheckResult.NoReleasePublished
        vm.checkForUpdateManually()
        advanceUntilIdle()
        assertTrue(vm.uiState.value.updateStatusMessage!!.contains("尚未发布"))

        // Background check silently ignores network errors
        updater.checkResult = UpdateCheckResult.Error("网络连接失败")
        vm.triggerBackgroundUpdateCheck("https://dropit.lthero.com#offline")
        advanceUntilIdle()
        assertNull(vm.uiState.value.promptManifest)
    }

    private class FakeAppUpdater(
        var checkResult: UpdateCheckResult,
        var downloadOutcome: UpdateInstallState = UpdateInstallState.ReadyToInstall,
    ) : AppUpdater {
        private val _installState = MutableStateFlow<UpdateInstallState>(UpdateInstallState.Idle)
        override val installState: StateFlow<UpdateInstallState> = _installState.asStateFlow()

        var checkCallCount = 0
        var skippedVersionCode: Int? = null

        override suspend fun checkLatest(force: Boolean): UpdateCheckResult {
            checkCallCount++
            return checkResult
        }

        override suspend fun shouldPromptAutoUpdate(manifest: AppUpdateManifest): Boolean =
            skippedVersionCode == null || skippedVersionCode != manifest.versionCode

        override suspend fun downloadAndInstall(manifest: AppUpdateManifest): UpdateInstallState {
            _installState.value = downloadOutcome
            return downloadOutcome
        }

        override suspend fun skipVersion(versionCode: Int) {
            skippedVersionCode = versionCode
        }

        override fun resetInstallState() {
            _installState.value = UpdateInstallState.Idle
        }
    }
}
