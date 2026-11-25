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
import dev.dropit.app.core.network.UpdateSource
import dev.dropit.app.core.repository.AppUpdater
import dev.dropit.app.core.repository.UpdateCheckResult
import dev.dropit.app.core.repository.UpdateInstallState
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.builtins.ListSerializer
import okhttp3.Call
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import java.io.ByteArrayOutputStream
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

private class UpdateSecurityException(message: String) : IOException(message)

private class UpdateTransportException(message: String, cause: Throwable? = null) : IOException(message, cause)

private data class GitHubReleaseCandidate(
    val versionCode: Int,
    val versionName: String,
    val notes: String,
    val publishedAt: String?,
    val apkName: String,
    val apkSize: Long,
    val apkUrl: String,
    val sha256Url: String,
)

private sealed class SourceCheckOutcome<out T> {
    data class Found<T>(val value: T) : SourceCheckOutcome<T>()
    data object NoRelease : SourceCheckOutcome<Nothing>()
    data object Disabled : SourceCheckOutcome<Nothing>()
    data class Failed(val message: String) : SourceCheckOutcome<Nothing>()
}

/**
 * Dual-source APK updater implementing [AppUpdater].
 * - Primary source: GitHub Releases (`lthero-big/dropit`, tags `android-v*`, with `.apk` + `.apk.sha256`).
 * - Acceleration & fallback source: configured self-hosted server (`GET /api/app/android/latest`).
 * - When both sources carry the same latest version, prefers same-origin self-hosted download for
 *   faster domestic delivery and falls back to GitHub Release download on transport failure.
 * - Security invariants:
 *   - Self-hosted downloads enforce same-origin HTTPS `/api/app/android/download/<name>.apk` with redirects disabled.
 *   - GitHub downloads enforce HTTPS and a strict redirect host allowlist (`github.com`, `*.githubusercontent.com`,
 *     max 5 hops, no HTTP downgrade).
 *   - Every download caps size at 200 MB and verifies exact byte length + SHA-256 before launching the installer.
 */
class DefaultAppUpdater(
    private val apiClient: DropitApiClient,
    private val settingsStore: SettingsStore,
    private val cacheDir: File,
    private val installer: ApkInstaller,
    private val currentVersionCode: Int = BuildConfig.VERSION_CODE,
    private val currentVersionName: String = BuildConfig.VERSION_NAME,
    private val allowInsecureHttpForTest: Boolean = false,
    private val githubReleasesUrl: String? = DEFAULT_GITHUB_RELEASES_URL,
) : AppUpdater {

    private val _installState = MutableStateFlow<UpdateInstallState>(UpdateInstallState.Idle)
    override val installState: StateFlow<UpdateInstallState> = _installState.asStateFlow()

    private val downloadMutex = Mutex()
    private var lastCheckedKey: String? = null
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
        if (serverOrigin.isNullOrBlank() && githubReleasesUrl.isNullOrBlank()) {
            return UpdateCheckResult.Error("尚未配置服务器地址")
        }

        val cacheKey = "${serverOrigin.orEmpty()}|${githubReleasesUrl.orEmpty()}"
        if (!force && lastCheckedKey == cacheKey) {
            val cached = lastCheckResult
            if (cached != null && cached !is UpdateCheckResult.Error) {
                return cached
            }
        }

        val result = coroutineScope {
            val selfHostedDeferred = async {
                if (serverOrigin.isNullOrBlank()) {
                    SourceCheckOutcome.Disabled
                } else {
                    checkSelfHostedRelease(serverOrigin)
                }
            }
            val githubDeferred = async {
                val url = githubReleasesUrl?.trim()?.takeIf { it.isNotEmpty() }
                if (url == null) {
                    SourceCheckOutcome.Disabled
                } else {
                    checkGitHubReleases(url)
                }
            }

            val selfHostedOutcome = selfHostedDeferred.await()
            val githubOutcome = githubDeferred.await()

            resolveDualSourceOutcome(
                serverOrigin = serverOrigin,
                selfHostedOutcome = selfHostedOutcome,
                githubOutcome = githubOutcome,
            )
        }

        lastCheckedKey = cacheKey
        lastCheckResult = result
        return result
    }

    override suspend fun shouldPromptAutoUpdate(manifest: AppUpdateManifest): Boolean {
        if (!UpdateVersionComparator.isNewer(
                candidateVersionName = manifest.versionName,
                candidateVersionCode = manifest.versionCode,
                currentVersionName = currentVersionName,
                currentVersionCode = currentVersionCode,
            )
        ) {
            return false
        }
        val settings = settingsStore.current()
        if (manifest.versionCode > 0 && settings.skipUpdateVersionCode == manifest.versionCode) {
            return false
        }
        if (settings.skipUpdateVersionName != null &&
            UpdateVersionComparator.isSameVersionName(settings.skipUpdateVersionName, manifest.versionName)
        ) {
            return false
        }
        return true
    }

    override suspend fun downloadAndInstall(manifest: AppUpdateManifest): UpdateInstallState =
        downloadMutex.withLock {
            withContext(Dispatchers.IO) {
                val updatesDir = File(cacheDir, UPDATES_DIR_NAME)
                val finalApk = File(updatesDir, APK_FILE_NAME)
                val partApk = File(updatesDir, "$APK_FILE_NAME.part")

                try {
                    if (!UpdateFiles.isValidManifest(manifest, allowInsecureHttpForTest)) {
                        return@withContext fail("更新信息无效")
                    }

                    val primaryDownloadUrl = when (manifest.source) {
                        UpdateSource.SELF_HOSTED -> {
                            val serverOrigin = settingsStore.getServerOrigin()?.trimEnd('/')
                            if (serverOrigin.isNullOrBlank()) {
                                return@withContext fail("尚未配置服务器地址")
                            }
                            val url = "$serverOrigin${manifest.url}"
                            if (!UpdateFiles.isUpdateUrl(serverOrigin, url, allowInsecureHttpForTest)) {
                                return@withContext fail("更新只能从当前 https 服务器下载")
                            }
                            url
                        }

                        UpdateSource.GITHUB -> {
                            if (!UpdateFiles.isAllowedGitHubDownloadUrl(manifest.url, allowInsecureHttpForTest)) {
                                return@withContext fail("更新下载地址不在允许的 GitHub 安全域名范围内")
                            }
                            manifest.url
                        }
                    }

                    if (!updatesDir.isDirectory && !updatesDir.mkdirs()) {
                        return@withContext fail("无法创建更新缓存目录")
                    }

                    // Reuse an already-downloaded verified APK (e.g., after returning from install permission settings).
                    val alreadyVerified = verifyExistingApk(finalApk, manifest.size, manifest.sha256) ||
                        (
                            manifest.fallbackSize != null &&
                                manifest.fallbackSha256 != null &&
                                verifyExistingApk(finalApk, manifest.fallbackSize, manifest.fallbackSha256)
                            )

                    if (!alreadyVerified) {
                        cleanupUpdateDir(updatesDir)
                        when (manifest.source) {
                            UpdateSource.SELF_HOSTED -> {
                                try {
                                    downloadSelfHostedApk(
                                        downloadUrl = primaryDownloadUrl,
                                        expectedSize = manifest.size,
                                        expectedSha256 = manifest.sha256,
                                        partApk = partApk,
                                        finalApk = finalApk,
                                    )
                                } catch (transportErr: UpdateTransportException) {
                                    val fbUrl = manifest.fallbackUrl
                                    val fbSha = manifest.fallbackSha256
                                    val fbSize = manifest.fallbackSize
                                    if (fbUrl != null &&
                                        fbSha != null &&
                                        fbSize != null &&
                                        fbSize in 1L..UpdateFiles.MAX_BYTES &&
                                        UpdateFiles.isSha256(fbSha) &&
                                        UpdateFiles.isAllowedGitHubDownloadUrl(fbUrl, allowInsecureHttpForTest)
                                    ) {
                                        runCatching { partApk.delete() }
                                        runCatching { finalApk.delete() }
                                        downloadGitHubApk(
                                            downloadUrl = fbUrl,
                                            expectedSize = fbSize,
                                            expectedSha256 = fbSha,
                                            partApk = partApk,
                                            finalApk = finalApk,
                                        )
                                    } else {
                                        throw transportErr
                                    }
                                }
                            }

                            UpdateSource.GITHUB -> {
                                downloadGitHubApk(
                                    downloadUrl = primaryDownloadUrl,
                                    expectedSize = manifest.size,
                                    expectedSha256 = manifest.sha256,
                                    partApk = partApk,
                                    finalApk = finalApk,
                                )
                            }
                        }
                    }

                    if (!installer.canRequestPackageInstalls()) {
                        installer.openUnknownAppSourcesSettings()
                        _installState.value = UpdateInstallState.NeedsInstallPermission
                        return@withContext UpdateInstallState.NeedsInstallPermission
                    }

                    installer.launchInstaller(finalApk)
                    _installState.value = UpdateInstallState.ReadyToInstall
                    UpdateInstallState.ReadyToInstall
                } catch (ce: CancellationException) {
                    withContext(NonCancellable) {
                        runCatching { partApk.delete() }
                        _installState.value = UpdateInstallState.Idle
                    }
                    throw ce
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

    override suspend fun skipVersion(manifest: AppUpdateManifest) {
        if (manifest.versionCode > 0) {
            settingsStore.setSkipUpdateVersionCode(manifest.versionCode)
        }
        if (manifest.versionName.isNotBlank()) {
            settingsStore.setSkipUpdateVersionName(manifest.versionName)
        }
    }

    override fun resetInstallState() {
        _installState.value = UpdateInstallState.Idle
        lastCheckResult = null
        lastCheckedKey = null
    }

    fun clearCachedUpdates() {
        runCatching { File(cacheDir, UPDATES_DIR_NAME).deleteRecursively() }
    }

    private suspend fun checkSelfHostedRelease(serverOrigin: String): SourceCheckOutcome<AppUpdateManifest> = try {
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
        ).copy(source = UpdateSource.SELF_HOSTED)
        if (!UpdateFiles.isValidManifest(manifest, allowInsecureHttpForTest)) {
            SourceCheckOutcome.Failed("服务器返回的更新信息无效")
        } else {
            val downloadUrl = "$serverOrigin${manifest.url}"
            if (!UpdateFiles.isUpdateUrl(serverOrigin, downloadUrl, allowInsecureHttpForTest)) {
                SourceCheckOutcome.Failed("服务器返回的更新下载地址不安全")
            } else {
                SourceCheckOutcome.Found(manifest.copy(notes = manifest.notes.take(MAX_NOTES_LENGTH)))
            }
        }
    } catch (e: ApiError) {
        if (e.httpStatus == 404 || e.errorCode == ApiErrorCode.NO_RELEASE) {
            SourceCheckOutcome.NoRelease
        } else {
            SourceCheckOutcome.Failed("检查更新失败：${e.userMessage}")
        }
    } catch (ce: CancellationException) {
        throw ce
    } catch (e: Exception) {
        SourceCheckOutcome.Failed("检查更新失败：${e.message ?: "网络异常"}")
    }

    private suspend fun checkGitHubReleases(releasesUrl: String): SourceCheckOutcome<GitHubReleaseCandidate> = try {
        val request = Request.Builder()
            .url(releasesUrl)
            .get()
            .header("Accept", "application/vnd.github+json")
            .header("User-Agent", userAgent())
            .build()
        val response = executeCallCancellable(noRedirectClient.newCall(request))
        val rawBody = response.use { res ->
            if (res.code !in 200..299) {
                throw IOException("GitHub Releases 接口返回 HTTP ${res.code}")
            }
            val body = res.body ?: throw IOException("GitHub Releases 响应为空")
            readBoundedUtf8(body, MAX_RELEASES_JSON_BYTES)
        }
        val releases = apiClient.json.decodeFromString(ListSerializer(GitHubReleaseDto.serializer()), rawBody)
        val best = selectLatestGitHubRelease(releases)
        if (best == null) {
            SourceCheckOutcome.NoRelease
        } else {
            SourceCheckOutcome.Found(best)
        }
    } catch (ce: CancellationException) {
        throw ce
    } catch (e: Exception) {
        SourceCheckOutcome.Failed("检查 GitHub 更新失败：${e.message ?: "网络异常"}")
    }

    private fun selectLatestGitHubRelease(releases: List<GitHubReleaseDto>): GitHubReleaseCandidate? {
        var best: GitHubReleaseCandidate? = null
        for (release in releases) {
            if (release.draft || release.prerelease) continue
            val versionName = UpdateFiles.parseGitHubReleaseTag(release.tagName) ?: continue
            val apkAsset = release.assets.firstOrNull { asset ->
                asset.name.endsWith(".apk", ignoreCase = true) &&
                    !asset.name.endsWith(".apk.sha256", ignoreCase = true) &&
                    asset.size in 1L..UpdateFiles.MAX_BYTES &&
                    UpdateFiles.isAllowedGitHubDownloadUrl(asset.browserDownloadUrl, allowInsecureHttpForTest)
            } ?: continue
            val shaAsset = release.assets.firstOrNull { asset ->
                asset.name == "${apkAsset.name}.sha256" &&
                    UpdateFiles.isAllowedGitHubDownloadUrl(asset.browserDownloadUrl, allowInsecureHttpForTest)
            } ?: continue

            val versionCode = UpdateFiles.extractVersionCodeFromReleaseBody(release.body, release.name)
            val candidate = GitHubReleaseCandidate(
                versionCode = versionCode,
                versionName = versionName,
                notes = UpdateFiles.summarizeReleaseNotes(release.body, MAX_NOTES_LENGTH),
                publishedAt = release.publishedAt?.trim()?.takeIf { it.isNotEmpty() },
                apkName = apkAsset.name,
                apkSize = apkAsset.size,
                apkUrl = apkAsset.browserDownloadUrl,
                sha256Url = shaAsset.browserDownloadUrl,
            )
            val currentBest = best
            if (currentBest == null ||
                UpdateVersionComparator.compare(
                    aVersionName = candidate.versionName,
                    aVersionCode = candidate.versionCode,
                    bVersionName = currentBest.versionName,
                    bVersionCode = currentBest.versionCode,
                ) > 0
            ) {
                best = candidate
            }
        }
        return best
    }

    private suspend fun resolveDualSourceOutcome(
        serverOrigin: String?,
        selfHostedOutcome: SourceCheckOutcome<AppUpdateManifest>,
        githubOutcome: SourceCheckOutcome<GitHubReleaseCandidate>,
    ): UpdateCheckResult {
        val selfHosted = (selfHostedOutcome as? SourceCheckOutcome.Found)?.value
        val github = (githubOutcome as? SourceCheckOutcome.Found)?.value

        if (selfHosted == null && github == null) {
            val selfFailed = selfHostedOutcome as? SourceCheckOutcome.Failed
            val ghFailed = githubOutcome as? SourceCheckOutcome.Failed
            return when {
                ghFailed != null && selfHostedOutcome !is SourceCheckOutcome.Found -> UpdateCheckResult.Error(ghFailed.message)
                selfFailed != null -> UpdateCheckResult.Error(selfFailed.message)
                else -> UpdateCheckResult.NoReleasePublished
            }
        }

        if (selfHosted != null && github != null) {
            val cmp = UpdateVersionComparator.compare(
                aVersionName = github.versionName,
                aVersionCode = github.versionCode,
                bVersionName = selfHosted.versionName,
                bVersionCode = selfHosted.versionCode,
            )
            return when {
                cmp > 0 -> {
                    // GitHub is newer than self-hosted
                    if (!UpdateVersionComparator.isNewer(github.versionName, github.versionCode, currentVersionName, currentVersionCode)) {
                        UpdateCheckResult.UpToDate(currentVersionName)
                    } else {
                        val ghManifest = buildVerifiedGitHubManifest(github)
                        if (ghManifest != null) {
                            UpdateCheckResult.UpdateAvailable(manifest = ghManifest, downloadUrl = ghManifest.url)
                        } else if (UpdateVersionComparator.isNewer(
                                selfHosted.versionName,
                                selfHosted.versionCode,
                                currentVersionName,
                                currentVersionCode,
                            )
                        ) {
                            // GitHub sha256 asset failed -> gracefully fall back to self-hosted if still newer than local
                            buildSelfHostedResult(serverOrigin!!, selfHosted)
                        } else {
                            UpdateCheckResult.Error("GitHub 更新校验文件（.apk.sha256）无效或无法获取")
                        }
                    }
                }

                cmp < 0 -> {
                    // Self-hosted is newer than GitHub
                    if (!UpdateVersionComparator.isNewer(selfHosted.versionName, selfHosted.versionCode, currentVersionName, currentVersionCode)) {
                        UpdateCheckResult.UpToDate(currentVersionName)
                    } else {
                        buildSelfHostedResult(serverOrigin!!, selfHosted)
                    }
                }

                else -> {
                    // Same latest version on both sources -> prefer self-hosted (faster domestic network) with GitHub fallback
                    val effectiveCode = maxOf(selfHosted.versionCode, github.versionCode)
                    if (!UpdateVersionComparator.isNewer(selfHosted.versionName, effectiveCode, currentVersionName, currentVersionCode)) {
                        UpdateCheckResult.UpToDate(currentVersionName)
                    } else {
                        val ghSha = runCatching { fetchGitHubSha256(github) }.getOrNull()
                        val merged = selfHosted.copy(
                            versionCode = effectiveCode,
                            notes = selfHosted.notes.ifBlank { github.notes },
                            publishedAt = selfHosted.publishedAt ?: github.publishedAt,
                            source = UpdateSource.SELF_HOSTED,
                            fallbackUrl = if (ghSha != null) github.apkUrl else null,
                            fallbackSha256 = ghSha,
                            fallbackSize = if (ghSha != null) github.apkSize else null,
                        )
                        buildSelfHostedResult(serverOrigin!!, merged)
                    }
                }
            }
        }

        if (github != null) {
            if (!UpdateVersionComparator.isNewer(github.versionName, github.versionCode, currentVersionName, currentVersionCode)) {
                return UpdateCheckResult.UpToDate(currentVersionName)
            }
            val ghManifest = buildVerifiedGitHubManifest(github)
                ?: return UpdateCheckResult.Error("GitHub 更新校验文件（.apk.sha256）无效或无法获取")
            return UpdateCheckResult.UpdateAvailable(manifest = ghManifest, downloadUrl = ghManifest.url)
        }

        val onlySelf = selfHosted!!
        if (!UpdateVersionComparator.isNewer(onlySelf.versionName, onlySelf.versionCode, currentVersionName, currentVersionCode)) {
            return UpdateCheckResult.UpToDate(currentVersionName)
        }
        return buildSelfHostedResult(serverOrigin!!, onlySelf)
    }

    private fun buildSelfHostedResult(serverOrigin: String, manifest: AppUpdateManifest): UpdateCheckResult.UpdateAvailable =
        UpdateCheckResult.UpdateAvailable(
            manifest = manifest.copy(
                notes = manifest.notes.take(MAX_NOTES_LENGTH),
                source = UpdateSource.SELF_HOSTED,
            ),
            downloadUrl = "$serverOrigin${manifest.url}",
        )

    private suspend fun buildVerifiedGitHubManifest(candidate: GitHubReleaseCandidate): AppUpdateManifest? {
        val sha256 = runCatching { fetchGitHubSha256(candidate) }.getOrNull() ?: return null
        val manifest = AppUpdateManifest(
            versionCode = candidate.versionCode,
            versionName = candidate.versionName,
            notes = candidate.notes,
            size = candidate.apkSize,
            sha256 = sha256,
            publishedAt = candidate.publishedAt,
            url = candidate.apkUrl,
            source = UpdateSource.GITHUB,
        )
        return manifest.takeIf { UpdateFiles.isValidManifest(it, allowInsecureHttpForTest) }
    }

    private suspend fun fetchGitHubSha256(candidate: GitHubReleaseCandidate): String {
        val response = executeGitHubGetWithRedirectWhitelist(
            initialUrl = candidate.sha256Url,
            acceptHeader = "text/plain, application/octet-stream",
        )
        val raw = response.use { res ->
            if (res.code != 200) {
                throw UpdateTransportException("下载校验文件失败（HTTP ${res.code}）")
            }
            val body = res.body ?: throw UpdateTransportException("校验文件响应为空")
            readBoundedUtf8(body, UpdateFiles.MAX_SHA256_FILE_BYTES)
        }
        return UpdateFiles.parseSha256File(raw, expectedFileName = candidate.apkName)
            ?: throw UpdateSecurityException("GitHub 更新校验文件格式非法")
    }

    private suspend fun downloadSelfHostedApk(
        downloadUrl: String,
        expectedSize: Long,
        expectedSha256: String,
        partApk: File,
        finalApk: File,
    ) {
        _installState.value = UpdateInstallState.Downloading(0L, expectedSize)

        val request = Request.Builder()
            .url(downloadUrl)
            .get()
            .build()
        val response = executeCallCancellable(noRedirectClient.newCall(request))

        response.use { res ->
            if (res.code in 300..399) {
                throw UpdateSecurityException("已拒绝更新重定向（HTTP ${res.code}）")
            }
            if (res.code != 200) {
                throw UpdateTransportException("下载更新失败（HTTP ${res.code}）")
            }
            streamAndVerifyApkResponse(
                response = res,
                expectedSize = expectedSize,
                expectedSha256 = expectedSha256,
                partApk = partApk,
                finalApk = finalApk,
            )
        }
    }

    private suspend fun downloadGitHubApk(
        downloadUrl: String,
        expectedSize: Long,
        expectedSha256: String,
        partApk: File,
        finalApk: File,
    ) {
        _installState.value = UpdateInstallState.Downloading(0L, expectedSize)
        val response = executeGitHubGetWithRedirectWhitelist(
            initialUrl = downloadUrl,
            acceptHeader = "application/octet-stream",
        )
        response.use { res ->
            if (res.code != 200) {
                throw UpdateTransportException("从 GitHub 下载更新失败（HTTP ${res.code}）")
            }
            streamAndVerifyApkResponse(
                response = res,
                expectedSize = expectedSize,
                expectedSha256 = expectedSha256,
                partApk = partApk,
                finalApk = finalApk,
            )
        }
    }

    /**
     * Executes a GET request to GitHub Release assets with strict manual redirect handling:
     * - Every hop (including the initial URL) must satisfy [UpdateFiles.isAllowedGitHubDownloadUrl].
     * - Refuses HTTPS -> HTTP downgrade on any redirect hop.
     * - Caps redirects at [MAX_GITHUB_REDIRECTS] (5 hops).
     */
    private suspend fun executeGitHubGetWithRedirectWhitelist(
        initialUrl: String,
        acceptHeader: String,
    ): Response {
        var currentUrl = initialUrl
        if (!UpdateFiles.isAllowedGitHubDownloadUrl(currentUrl, allowInsecureHttpForTest)) {
            throw UpdateSecurityException("已拒绝非法的 GitHub 下载地址")
        }

        for (hop in 0..MAX_GITHUB_REDIRECTS) {
            val request = Request.Builder()
                .url(currentUrl)
                .get()
                .header("Accept", acceptHeader)
                .header("User-Agent", userAgent())
                .build()
            val response = executeCallCancellable(noRedirectClient.newCall(request))
            if (response.code !in REDIRECT_STATUS_CODES) {
                return response
            }

            val location = response.header("Location")?.trim()
            val previousIsHttps = request.url.isHttps
            response.close()

            if (location.isNullOrEmpty()) {
                throw UpdateSecurityException("GitHub 下载重定向缺少 Location 头")
            }
            if (hop == MAX_GITHUB_REDIRECTS) {
                throw UpdateSecurityException("GitHub 下载重定向次数超过上限（最多 $MAX_GITHUB_REDIRECTS 次）")
            }
            val resolved = request.url.resolve(location)
                ?: throw UpdateSecurityException("GitHub 下载重定向地址无效")
            if (previousIsHttps && !resolved.isHttps) {
                throw UpdateSecurityException("已拒绝降级为 HTTP 的更新重定向")
            }
            val resolvedString = resolved.toString()
            if (!UpdateFiles.isAllowedGitHubDownloadUrl(resolvedString, allowInsecureHttpForTest)) {
                throw UpdateSecurityException("已拒绝跳往未知域名的更新重定向：${resolved.host}")
            }
            currentUrl = resolvedString
        }

        throw UpdateSecurityException("GitHub 下载重定向次数超过上限")
    }

    private suspend fun streamAndVerifyApkResponse(
        response: Response,
        expectedSize: Long,
        expectedSha256: String,
        partApk: File,
        finalApk: File,
    ) {
        val body = response.body ?: throw UpdateTransportException("更新安装包响应为空")
        val contentLength = body.contentLength()
        if (contentLength > UpdateFiles.MAX_BYTES || (contentLength > 0L && contentLength != expectedSize)) {
            throw UpdateSecurityException("安装包大小与清单不一致")
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
                    if (received > expectedSize || received > UpdateFiles.MAX_BYTES) {
                        throw UpdateSecurityException("安装包比清单说明的大")
                    }
                    digest.update(buffer, 0, read)
                    out.write(buffer, 0, read)
                    if (received - lastReported >= PROGRESS_STEP_BYTES || received == expectedSize) {
                        lastReported = received
                        _installState.value = UpdateInstallState.Downloading(received, expectedSize)
                    }
                }
                out.flush()
            }
        }

        _installState.value = UpdateInstallState.Verifying
        if (received != expectedSize) {
            throw UpdateTransportException("下载不完整")
        }
        val actualSha = UpdateFiles.hex(digest.digest())
        if (actualSha != expectedSha256) {
            throw UpdateSecurityException("安装包校验失败（SHA-256 不一致）")
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

    private fun readBoundedUtf8(body: okhttp3.ResponseBody, maxBytes: Int): String {
        val length = body.contentLength()
        if (length > maxBytes) {
            throw UpdateSecurityException("响应体超过允许大小上限")
        }
        val out = ByteArrayOutputStream()
        body.byteStream().use { input ->
            val buf = ByteArray(4096)
            var total = 0
            while (true) {
                val read = input.read(buf)
                if (read < 0) break
                total += read
                if (total > maxBytes) {
                    throw UpdateSecurityException("响应体超过允许大小上限")
                }
                out.write(buf, 0, read)
            }
        }
        return out.toString(Charsets.UTF_8.name())
    }

    private fun verifyExistingApk(file: File, expectedSize: Long, expectedSha256: String): Boolean {
        if (expectedSize <= 0L || !UpdateFiles.isSha256(expectedSha256)) return false
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

    private fun userAgent(): String = "dropit-android/$currentVersionName"

    private suspend fun executeCallCancellable(call: Call): Response =
        suspendCancellableCoroutine { cont ->
            cont.invokeOnCancellation { call.cancel() }
            call.enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) {
                    if (cont.isActive) cont.resumeWithException(UpdateTransportException("网络连接失败，请稍后重试", e))
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
        const val DEFAULT_GITHUB_RELEASES_URL =
            "https://api.github.com/repos/lthero-big/dropit/releases?per_page=10"
        const val MAX_GITHUB_REDIRECTS = 5
        private const val MAX_RELEASES_JSON_BYTES = 1024 * 1024
        private const val PROGRESS_STEP_BYTES = 128L * 1024L
        private const val MAX_NOTES_LENGTH = 4000
        private val REDIRECT_STATUS_CODES = setOf(301, 302, 303, 307, 308)
    }
}
