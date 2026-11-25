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
    fun nativeSettingsMenu_containsSevenPagesAndGatesAdminByRoleAndScope() {
        val regularEntries = NativeSettingsMenu.entriesForUser(isAdmin = false, hasAdminScope = false)
        assertEquals(6, regularEntries.size)
        assertFalse(regularEntries.contains(SettingsSubPage.ADMIN))
        assertTrue(regularEntries.contains(SettingsSubPage.SHARE_PRESETS))
        assertTrue(regularEntries.contains(SettingsSubPage.SHARE_LINKS))
        assertTrue(regularEntries.contains(SettingsSubPage.SPACE_SHARING))
        assertTrue(regularEntries.contains(SettingsSubPage.DEVICES))
        assertTrue(regularEntries.contains(SettingsSubPage.TOKENS_AND_DEVICE_CODE))
        assertTrue(regularEntries.contains(SettingsSubPage.SECURITY_AND_OAUTH))

        // Admin role with legacy device-code token (missing admin scope) must NOT expose Admin entry
        val adminWithoutScope = NativeSettingsMenu.entriesForUser(isAdmin = true, hasAdminScope = false)
        assertEquals(6, adminWithoutScope.size)
        assertFalse(adminWithoutScope.contains(SettingsSubPage.ADMIN))

        // Non-admin role even if scope were present must NOT expose Admin entry
        val userWithScope = NativeSettingsMenu.entriesForUser(isAdmin = false, hasAdminScope = true)
        assertEquals(6, userWithScope.size)
        assertFalse(userWithScope.contains(SettingsSubPage.ADMIN))

        // Admin role + admin scope sees all 7 native secondary pages
        val adminEntries = NativeSettingsMenu.entriesForUser(isAdmin = true, hasAdminScope = true)
        assertEquals(7, adminEntries.size)
        assertTrue(adminEntries.contains(SettingsSubPage.ADMIN))
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

        vm.triggerBackgroundUpdateCheck("https://dropit.lthero.com#1")
        vm.triggerBackgroundUpdateCheck("https://dropit.lthero.com#1")
        advanceUntilIdle()

        assertEquals(1, updater.checkCallCount)
        assertEquals(newerManifest, vm.uiState.value.promptManifest)
        assertTrue(vm.uiState.value.isAutoPrompt)

        vm.skipPromptedVersion()
        advanceUntilIdle()

        assertEquals(7, updater.skippedVersionCode)
        assertNull(vm.uiState.value.promptManifest)

        vm.triggerBackgroundUpdateCheck("https://dropit.lthero.com#2")
        advanceUntilIdle()
        assertNull(vm.uiState.value.promptManifest)

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

        updater.downloadOutcome = UpdateInstallState.Failed("安装包校验失败（SHA-256 不一致）")
        vm.startDownloadAndInstall()
        advanceUntilIdle()
        val failed = vm.uiState.value.installState as UpdateInstallState.Failed
        assertTrue(failed.message.contains("SHA-256"))
    }

    @Test
    fun manualCheck_reportsUpToDateAndNoReleaseCleanly() = runTest(testDispatcher) {
        val updater = FakeAppUpdater(checkResult = UpdateCheckResult.UpToDate("0.4.1"))
        val vm = SettingsViewModel(appUpdater = updater, ioDispatcher = testDispatcher)

        vm.checkForUpdateManually()
        advanceUntilIdle()
        assertNull(vm.uiState.value.promptManifest)
        assertTrue(vm.uiState.value.updateStatusMessage!!.contains("已是最新版本"))
        assertFalse(vm.uiState.value.updateStatusIsError)

        updater.checkResult = UpdateCheckResult.NoReleasePublished
        vm.checkForUpdateManually()
        advanceUntilIdle()
        assertEquals("暂未检测到已发布的 Android 安装包", vm.uiState.value.updateStatusMessage)

        updater.checkResult = UpdateCheckResult.Error("网络连接失败")
        vm.triggerBackgroundUpdateCheck("https://dropit.lthero.com#offline")
        advanceUntilIdle()
        assertNull(vm.uiState.value.promptManifest)
    }

    @Test
    fun sessionSwitch_clearsStaleUpdateStatusAndPromptBeforeCheckingNewSession() = runTest(testDispatcher) {
        val updater = FakeAppUpdater(
            checkResult = UpdateCheckResult.UpdateAvailable(
                manifest = newerManifest,
                downloadUrl = "https://server-a.example.com${newerManifest.url}",
            ),
        )
        val vm = SettingsViewModel(appUpdater = updater, ioDispatcher = testDispatcher)

        vm.triggerBackgroundUpdateCheck("https://server-a.example.com#1")
        advanceUntilIdle()
        assertEquals(newerManifest, vm.uiState.value.promptManifest)

        updater.checkResult = UpdateCheckResult.NoReleasePublished
        vm.triggerBackgroundUpdateCheck("https://server-b.example.com#2")
        advanceUntilIdle()

        assertNull(vm.uiState.value.promptManifest)
        assertNull(vm.uiState.value.updateStatusMessage)
        assertFalse(vm.uiState.value.isAutoPrompt)
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
