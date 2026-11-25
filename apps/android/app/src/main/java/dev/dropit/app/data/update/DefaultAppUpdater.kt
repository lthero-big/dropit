package dev.dropit.app.data.update

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import dev.dropit.app.BuildConfig
import dev.dropit.app.core.auth.SettingsStore
import dev.dropit.app.core.network.ApiError
import dev.dropit.app.core.network.ApiErrorCode
import dev.dropit.app.core.network.AppUpdateManifest
import dev.dropit.app.core.network.DropitApiClient
import dev.dropit.app.core.repository.AppUpdater
import dev.dropit.app.core.repository.UpdateCheckResult
import dev.dropit.app.core.repository.UpdateInstallState
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.security.MessageDigest
import java.util.concurrent.TimeUnit
import kotlin.coroutines.coroutineContext
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * Platform installer abstraction for checking `REQUEST_INSTALL_PACKAGES` and launching the
 * system APK installer via FileProvider.
 */
interface ApkInstaller {
    fun canRequestPackageInstalls(): Boolean
    fun buildInstallIntent(apkFile: File): Intent
    fun launchInstaller(apkFile: File)
    fun openUnknownAppSourcesSettings()
}

class AndroidApkInstaller(
    context: Context,
) : ApkInstaller {
    private val appContext = context.applicationContext
    private val authority = "${appContext.packageName}.fileprovider"

    override fun canRequestPackageInstalls(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return true
        return appContext.packageManager.canRequestPackageInstalls()
    }

    override fun buildInstallIntent(apkFile: File): Intent {
        val contentUri: Uri = FileProvider.getUriForFile(appContext, authority, apkFile)
        return Intent(Intent.ACTION_VIEW)
            .setDataAndType(contentUri, APK_MIME_TYPE)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
    }

    override fun launchInstaller(apkFile: File) {
        appContext.startActivity(buildInstallIntent(apkFile))
    }

    override fun openUnknownAppSourcesSettings() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        runCatching {
            val intent = Intent(
                Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:${appContext.packageName}"),
            ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            appContext.startActivity(intent)
        }
    }

    companion object {
        const val APK_MIME_TYPE = "application/vnd.android.package-archive"
    }
}

/**
 * Concrete self-hosted APK updater implementing [AppUpdater].
 * - Checks `GET /api/app/android/latest` against [currentVersionCode] and `skipUpdateVersionCode`.
 * - Enforces same-origin HTTPS `/api/app/android/download/<name>.apk`, disables HTTP redirects,
 *   caps download size at 200 MB, and verifies exact byte length + SHA-256 before installation.
 * - Reports `NeedsInstallPermission` clearly when `REQUEST_INSTALL_PACKAGES` is not granted.
 */
class DefaultAppUpdater(
    private val apiClient: DropitApiClient,
    private val settingsStore: SettingsStore,
    private val cacheDir: File,
    private val installer: ApkInstaller,
    private val currentVersionCode: Int = BuildConfig.VERSION_CODE,
    private val currentVersionName: String = BuildConfig.VERSION_NAME,
    private val allowInsecureHttpForTest: Boolean = false,
) : AppUpdater {

    private val _installState = MutableStateFlow<UpdateInstallState>(UpdateInstallState.Idle)
    override val installState: StateFlow<UpdateInstallState> = _installState.asStateFlow()

    private val downloadMutex = Mutex()
    private var lastCheckedOrigin: String? = null
    private var lastCheckResult: UpdateCheckResult? = null

    private val noRedirectClient: OkHttpClient by lazy {
        apiClient.okHttpClient.newBuilder()
            .followRedirects(false)
            .followSslRedirects(false)
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .build()
    }

    override suspend fun checkLatest(force: Boolean): UpdateCheckResult {
        val serverOrigin = settingsStore.getServerOrigin()?.trimEnd('/')
            ?: return UpdateCheckResult.Error("尚未配置服务器地址")

        if (!force && lastCheckedOrigin == serverOrigin) {
            val cached = lastCheckResult
            if (cached != null && cached !is UpdateCheckResult.Error) {
                return cached
            }
        }

        val result = try {
            val url = apiClient.buildUrl("/api/app/android/latest", serverOriginOverride = serverOrigin)
            val request = Request.Builder()
                .url(url)
                .get()
                .header("Accept", "application/json")
                .build()
            val manifest = apiClient.executeJson(
                request = request,
                authenticated = false,
                deserializer = AppUpdateManifest.serializer(),
            )
            interpretManifest(serverOrigin, manifest)
        } catch (e: ApiError) {
            if (e.httpStatus == 404 || e.errorCode == ApiErrorCode.NO_RELEASE) {
                UpdateCheckResult.NoReleasePublished
            } else {
                UpdateCheckResult.Error("检查更新失败：${e.userMessage}")
            }
        } catch (e: Exception) {
            UpdateCheckResult.Error("检查更新失败：${e.message ?: "网络异常"}")
        }

        lastCheckedOrigin = serverOrigin
        lastCheckResult = result
        return result
    }

    override suspend fun shouldPromptAutoUpdate(manifest: AppUpdateManifest): Boolean {
        if (manifest.versionCode <= currentVersionCode) return false
        val skipped = settingsStore.current().skipUpdateVersionCode
        return skipped == null || skipped != manifest.versionCode
    }

    override suspend fun downloadAndInstall(manifest: AppUpdateManifest): UpdateInstallState =
        downloadMutex.withLock {
            withContext(Dispatchers.IO) {
                val serverOrigin = settingsStore.getServerOrigin()?.trimEnd('/')
                if (serverOrigin.isNullOrBlank()) {
                    return@withContext fail("尚未配置服务器地址")
                }
                if (!UpdateFiles.isValidManifest(manifest)) {
                    return@withContext fail("更新信息无效")
                }
                val downloadUrl = "$serverOrigin${manifest.url}"
                if (!UpdateFiles.isUpdateUrl(serverOrigin, downloadUrl, allowInsecureHttpForTest)) {
                    return@withContext fail("更新只能从当前 https 服务器下载")
                }

                val updatesDir = File(cacheDir, UPDATES_DIR_NAME)
                val finalApk = File(updatesDir, APK_FILE_NAME)
                val partApk = File(updatesDir, "$APK_FILE_NAME.part")

                try {
                    if (!updatesDir.isDirectory && !updatesDir.mkdirs()) {
                        return@withContext fail("无法创建更新缓存目录")
                    }

                    // Reuse an already-downloaded verified APK (e.g., user just returned from granting permission).
                    val alreadyVerified = verifyExistingApk(finalApk, manifest.size, manifest.sha256)
                    if (!alreadyVerified) {
                        cleanupUpdateDir(updatesDir)
                        downloadAndVerifyApk(downloadUrl, manifest, partApk, finalApk)
                    }

                    if (!installer.canRequestPackageInstalls()) {
                        installer.openUnknownAppSourcesSettings()
                        _installState.value = UpdateInstallState.NeedsInstallPermission
                        return@withContext UpdateInstallState.NeedsInstallPermission
                    }

                    installer.launchInstaller(finalApk)
                    _installState.value = UpdateInstallState.ReadyToInstall
                    UpdateInstallState.ReadyToInstall
                } catch (e: Exception) {
                    runCatching { partApk.delete() }
                    runCatching { finalApk.delete() }
                    fail(e.message?.takeIf { it.isNotBlank() } ?: "更新下载失败")
                }
            }
        }

    override suspend fun skipVersion(versionCode: Int) {
        if (versionCode > 0) {
            settingsStore.setSkipUpdateVersionCode(versionCode)
        }
    }

    override fun resetInstallState() {
        _installState.value = UpdateInstallState.Idle
        lastCheckResult = null
        lastCheckedOrigin = null
    }

    fun clearCachedUpdates() {
        runCatching { File(cacheDir, UPDATES_DIR_NAME).deleteRecursively() }
    }

    private fun interpretManifest(serverOrigin: String, manifest: AppUpdateManifest): UpdateCheckResult {
        if (!UpdateFiles.isValidManifest(manifest)) {
            return UpdateCheckResult.Error("服务器返回的更新信息无效")
        }
        val downloadUrl = "$serverOrigin${manifest.url}"
        if (!UpdateFiles.isUpdateUrl(serverOrigin, downloadUrl, allowInsecureHttpForTest)) {
            return UpdateCheckResult.Error("服务器返回的更新下载地址不安全")
        }
        if (manifest.versionCode <= currentVersionCode) {
            return UpdateCheckResult.UpToDate(currentVersionName)
        }
        return UpdateCheckResult.UpdateAvailable(
            manifest = manifest.copy(notes = manifest.notes.take(MAX_NOTES_LENGTH)),
            downloadUrl = downloadUrl,
        )
    }

    private suspend fun downloadAndVerifyApk(
        downloadUrl: String,
        manifest: AppUpdateManifest,
        partApk: File,
        finalApk: File,
    ) {
        _installState.value = UpdateInstallState.Downloading(0L, manifest.size)

        val request = Request.Builder()
            .url(downloadUrl)
            .get()
            .build()
        val call = noRedirectClient.newCall(request)
        val response = executeCallCancellable(call)

        response.use { res ->
            if (res.code in 300..399) {
                throw IOException("已拒绝更新重定向（HTTP ${res.code}）")
            }
            if (res.code != 200) {
                throw IOException("下载更新失败（HTTP ${res.code}）")
            }
            val body = res.body ?: throw IOException("更新安装包响应为空")
            val contentLength = body.contentLength()
            if (contentLength > UpdateFiles.MAX_BYTES || (contentLength > 0L && contentLength != manifest.size)) {
                throw IOException("安装包大小与清单不一致")
            }

            val digest = MessageDigest.getInstance("SHA-256")
            var received = 0L
            var lastReported = 0L

            body.byteStream().use { input ->
                FileOutputStream(partApk).use { out ->
                    val buffer = ByteArray(64 * 1024)
                    while (true) {
                        coroutineContext.ensureActive()
                        val read = input.read(buffer)
                        if (read < 0) break
                        received += read
                        if (received > manifest.size || received > UpdateFiles.MAX_BYTES) {
                            throw IOException("安装包比服务器说明的大")
                        }
                        digest.update(buffer, 0, read)
                        out.write(buffer, 0, read)
                        if (received - lastReported >= PROGRESS_STEP_BYTES || received == manifest.size) {
                            lastReported = received
                            _installState.value = UpdateInstallState.Downloading(received, manifest.size)
                        }
                    }
                    out.flush()
                }
            }

            _installState.value = UpdateInstallState.Verifying
            if (received != manifest.size) {
                throw IOException("下载不完整")
            }
            val actualSha = UpdateFiles.hex(digest.digest())
            if (actualSha != manifest.sha256) {
                throw IOException("安装包校验失败（SHA-256 不一致）")
            }
            if (finalApk.exists() && !finalApk.delete()) {
                throw IOException("无法替换旧安装包缓存")
            }
            if (!partApk.renameTo(finalApk)) {
                FileInputStream(partApk).use { input ->
                    FileOutputStream(finalApk).use { out ->
                        input.copyTo(out, bufferSize = 64 * 1024)
                    }
                }
                partApk.delete()
            }
        }
    }

    private fun verifyExistingApk(file: File, expectedSize: Long, expectedSha256: String): Boolean {
        if (!file.isFile || file.length() != expectedSize) return false
        return runCatching {
            val digest = MessageDigest.getInstance("SHA-256")
            FileInputStream(file).use { input ->
                val buffer = ByteArray(64 * 1024)
                while (true) {
                    val read = input.read(buffer)
                    if (read < 0) break
                    digest.update(buffer, 0, read)
                }
            }
            UpdateFiles.hex(digest.digest()) == expectedSha256
        }.getOrDefault(false)
    }

    private fun cleanupUpdateDir(dir: File) {
        dir.listFiles()?.forEach { runCatching { it.delete() } }
    }

    private fun fail(message: String): UpdateInstallState.Failed {
        val state = UpdateInstallState.Failed(message)
        _installState.value = state
        return state
    }

    private suspend fun executeCallCancellable(call: Call): Response =
        suspendCancellableCoroutine { cont ->
            cont.invokeOnCancellation { call.cancel() }
            call.enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) {
                    if (cont.isActive) cont.resumeWithException(IOException("网络连接失败，请稍后重试", e))
                }

                override fun onResponse(call: Call, response: Response) {
                    if (cont.isActive) {
                        cont.resume(response)
                    } else {
                        response.close()
                    }
                }
            })
        }

    companion object {
        const val UPDATES_DIR_NAME = "updates"
        const val APK_FILE_NAME = "dropit-update.apk"
        private const val PROGRESS_STEP_BYTES = 128L * 1024L
        private const val MAX_NOTES_LENGTH = 4000
    }
}
