package dev.dropit.app.data.update

import android.content.Intent
import dev.dropit.app.core.auth.AppSettings
import dev.dropit.app.core.auth.InMemorySettingsStore
import dev.dropit.app.core.network.AppUpdateManifest
import dev.dropit.app.core.network.DropitApiClient
import dev.dropit.app.core.network.SessionCredentialsProvider
import dev.dropit.app.core.repository.UpdateCheckResult
import dev.dropit.app.core.repository.UpdateInstallState
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

class DefaultAppUpdaterTest {

    private lateinit var server: MockWebServer
    private lateinit var okHttpClient: OkHttpClient
    private lateinit var baseUrl: String
    private lateinit var cacheDir: File

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        baseUrl = server.url("/").toString().trimEnd('/')
        okHttpClient = OkHttpClient.Builder().build()
        cacheDir = Files.createTempDirectory("dropit-updater-test").toFile()
    }

    @After
    fun tearDown() {
        server.shutdown()
        okHttpClient.dispatcher.executorService.shutdown()
        okHttpClient.connectionPool.evictAll()
        cacheDir.deleteRecursively()
    }

    private fun createUpdater(
        settingsStore: InMemorySettingsStore = InMemorySettingsStore(AppSettings(serverOrigin = baseUrl)),
        installer: FakeApkInstaller = FakeApkInstaller(),
        currentVersionCode: Int = 6,
        allowHttp: Boolean = true,
    ): DefaultAppUpdater {
        val creds = object : SessionCredentialsProvider {
            override suspend fun serverOrigin(): String? = settingsStore.getServerOrigin()
            override suspend fun accessToken(): String? = null
            override suspend fun deviceId(): String = "and-0123456789abcdefghij"
            override fun deviceName(): String = "dropit Android · Test"
        }
        val apiClient = DropitApiClient(
            okHttpClient = okHttpClient,
            credentialsProvider = creds,
            allowInsecureHttpForTest = allowHttp,
        )
        return DefaultAppUpdater(
            apiClient = apiClient,
            settingsStore = settingsStore,
            cacheDir = cacheDir,
            installer = installer,
            currentVersionCode = currentVersionCode,
            currentVersionName = "0.4.0-native",
            allowInsecureHttpForTest = allowHttp,
        )
    }

    @Test
    fun checkLatest_handlesNoReleaseUpToDateUpdateAvailableAndSkipVersion() = runTest {
        val settings = InMemorySettingsStore(AppSettings(serverOrigin = baseUrl))
        val updater = createUpdater(settingsStore = settings, currentVersionCode = 6)

        // 404 NO_RELEASE
        server.enqueue(MockResponse().setResponseCode(404).setBody("""{"error":{"code":"NO_RELEASE"}}"""))
        assertEquals(UpdateCheckResult.NoReleasePublished, updater.checkLatest(force = true))

        val sha = sha256("fake-apk-bytes".toByteArray())
        // Same versionCode -> UpToDate
        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setBody("""{"versionCode":6,"versionName":"0.4.0","notes":"same","size":14,"sha256":"$sha","url":"/api/app/android/download/dropit-0.4.0.apk"}"""),
        )
        assertTrue(updater.checkLatest(force = true) is UpdateCheckResult.UpToDate)

        // Newer versionCode -> UpdateAvailable
        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setBody("""{"versionCode":7,"versionName":"0.4.1","notes":"新增断点续传","size":14,"sha256":"$sha","url":"/api/app/android/download/dropit-0.4.1.apk"}"""),
        )
        val result = updater.checkLatest(force = true)
        assertTrue(result is UpdateCheckResult.UpdateAvailable)
        val available = result as UpdateCheckResult.UpdateAvailable
        assertEquals("$baseUrl/api/app/android/download/dropit-0.4.1.apk", available.downloadUrl)
        assertTrue(updater.shouldPromptAutoUpdate(available.manifest))

        // Skip version 7 -> auto prompt suppressed for 7, still prompts for 8.
        updater.skipVersion(7)
        assertFalse(updater.shouldPromptAutoUpdate(available.manifest))
        assertTrue(updater.shouldPromptAutoUpdate(available.manifest.copy(versionCode = 8)))
    }

    @Test
    fun downloadAndInstall_verifiesSha256AndLaunchesInstaller() = runTest {
        val apkBytes = ByteArray(2048) { (it * 7).toByte() }
        val expectedSha = sha256(apkBytes)
        val installer = FakeApkInstaller(canInstall = true)
        val updater = createUpdater(installer = installer)

        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setBody(Buffer().write(apkBytes)),
        )

        val manifest = AppUpdateManifest(
            versionCode = 7,
            versionName = "0.4.1",
            size = apkBytes.size.toLong(),
            sha256 = expectedSha,
            url = "/api/app/android/download/dropit-0.4.1.apk",
        )
        val finalState = updater.downloadAndInstall(manifest)
        assertEquals(UpdateInstallState.ReadyToInstall, finalState)
        assertEquals(UpdateInstallState.ReadyToInstall, updater.installState.value)
        assertNotNull(installer.launchedApk)
        assertEquals(apkBytes.size.toLong(), installer.launchedApk?.length())
    }

    @Test
    fun downloadAndInstall_rejectsRedirectAndSha256MismatchAndDeletesTempFiles() = runTest {
        val apkBytes = "corrupted-apk".toByteArray()
        val wrongSha = sha256("expected-apk".toByteArray())
        val installer = FakeApkInstaller(canInstall = true)
        val updater = createUpdater(installer = installer)

        // 1. Redirect must be refused.
        server.enqueue(
            MockResponse()
                .setResponseCode(302)
                .addHeader("Location", "https://evil.example/evil.apk"),
        )
        val manifest = AppUpdateManifest(
            versionCode = 7,
            versionName = "0.4.1",
            size = apkBytes.size.toLong(),
            sha256 = wrongSha,
            url = "/api/app/android/download/dropit-0.4.1.apk",
        )
        val redirectState = updater.downloadAndInstall(manifest)
        assertTrue(redirectState is UpdateInstallState.Failed)
        assertTrue((redirectState as UpdateInstallState.Failed).message.contains("重定向"))
        assertEquals(0, installer.launchCount)

        // 2. SHA-256 mismatch must fail and delete downloaded APK.
        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setBody(Buffer().write(apkBytes)),
        )
        val badShaState = updater.downloadAndInstall(manifest)
        assertTrue(badShaState is UpdateInstallState.Failed)
        assertTrue((badShaState as UpdateInstallState.Failed).message.contains("SHA-256"))
        assertEquals(0, installer.launchCount)
        assertFalse(File(cacheDir, "${DefaultAppUpdater.UPDATES_DIR_NAME}/${DefaultAppUpdater.APK_FILE_NAME}").exists())
    }

    @Test
    fun downloadAndInstall_reportsNeedsInstallPermissionAndReusesVerifiedApkAfterGrant() = runTest {
        val apkBytes = "valid-apk-payload-for-permission-flow".toByteArray()
        val expectedSha = sha256(apkBytes)
        val installer = FakeApkInstaller(canInstall = false)
        val updater = createUpdater(installer = installer)

        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setBody(Buffer().write(apkBytes)),
        )

        val manifest = AppUpdateManifest(
            versionCode = 7,
            versionName = "0.4.1",
            size = apkBytes.size.toLong(),
            sha256 = expectedSha,
            url = "/api/app/android/download/dropit-0.4.1.apk",
        )

        // Missing permission -> downloads & verifies APK, opens settings, returns NeedsInstallPermission.
        val firstState = updater.downloadAndInstall(manifest)
        assertEquals(UpdateInstallState.NeedsInstallPermission, firstState)
        assertEquals(1, installer.settingsOpenedCount)
        assertEquals(0, installer.launchCount)

        // User grants permission and taps again -> reuses verified cached APK without hitting network again!
        installer.canInstall = true
        val secondState = updater.downloadAndInstall(manifest)
        assertEquals(UpdateInstallState.ReadyToInstall, secondState)
        assertEquals(1, installer.launchCount)
        assertEquals(1, server.requestCount)
    }

    @Test
    fun downloadAndInstall_rejectsSizeMismatchAndProductionHttpOrigin() = runTest {
        val installer = FakeApkInstaller(canInstall = true)
        val updater = createUpdater(installer = installer)

        val actualBytes = "short".toByteArray()
        val manifest = AppUpdateManifest(
            versionCode = 7,
            versionName = "0.4.1",
            size = 100L,
            sha256 = sha256(actualBytes),
            url = "/api/app/android/download/dropit-0.4.1.apk",
        )
        server.enqueue(MockResponse().setResponseCode(200).setBody(Buffer().write(actualBytes)))
        val sizeFail = updater.downloadAndInstall(manifest)
        assertTrue(sizeFail is UpdateInstallState.Failed)
        assertEquals(0, installer.launchCount)

        // Production updater (allowHttp = false) refuses http:// origin without sending any request.
        val prodUpdater = createUpdater(installer = installer, allowHttp = false)
        val httpFail = prodUpdater.downloadAndInstall(manifest.copy(size = actualBytes.size.toLong()))
        assertTrue(httpFail is UpdateInstallState.Failed)
        assertTrue((httpFail as UpdateInstallState.Failed).message.contains("https"))
    }

    @Test
    fun downloadAndInstall_cancellationCleansPartFileResetsIdleAndRethrows() = runTest {
        val apkBytes = ByteArray(256 * 1024) { (it % 251).toByte() }
        val installer = FakeApkInstaller(canInstall = true)
        val updater = createUpdater(installer = installer)

        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setBody(Buffer().write(apkBytes))
                .throttleBody(4096, 150, TimeUnit.MILLISECONDS),
        )

        val manifest = AppUpdateManifest(
            versionCode = 7,
            versionName = "0.4.1",
            size = apkBytes.size.toLong(),
            sha256 = sha256(apkBytes),
            url = "/api/app/android/download/dropit-0.4.1.apk",
        )

        var caughtCancellation = false
        val job = launch(Dispatchers.IO) {
            try {
                updater.downloadAndInstall(manifest)
            } catch (ce: CancellationException) {
                caughtCancellation = true
                throw ce
            }
        }

        val partApk = File(cacheDir, "${DefaultAppUpdater.UPDATES_DIR_NAME}/${DefaultAppUpdater.APK_FILE_NAME}.part")
        updater.installState.first { it is UpdateInstallState.Downloading }
        kotlinx.coroutines.withContext(Dispatchers.IO) {
            val deadline = System.currentTimeMillis() + 2_000L
            while (!partApk.exists() && System.currentTimeMillis() < deadline) {
                Thread.sleep(20)
            }
        }
        job.cancel()
        job.join()

        assertTrue("CancellationException must propagate instead of being swallowed as Failed", caughtCancellation)
        assertEquals(UpdateInstallState.Idle, updater.installState.value)
        assertFalse("Partial APK file must be deleted on cancellation", partApk.exists())
        assertEquals(0, installer.launchCount)
    }

    private fun sha256(bytes: ByteArray): String =
        UpdateFiles.hex(MessageDigest.getInstance("SHA-256").digest(bytes))

    private class FakeApkInstaller(var canInstall: Boolean = true) : ApkInstaller {
        var launchedApk: File? = null
        var launchCount: Int = 0
        var settingsOpenedCount: Int = 0

        override fun canRequestPackageInstalls(): Boolean = canInstall

        override fun buildInstallIntent(apkFile: File): Intent = Intent()

        override fun launchInstaller(apkFile: File) {
            launchedApk = apkFile
            launchCount += 1
        }

        override fun openUnknownAppSourcesSettings() {
            settingsOpenedCount += 1
        }
    }
}
