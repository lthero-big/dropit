package dev.dropit.app.data.media

import android.content.Context
import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.okhttp.OkHttpDataSource
import coil.ImageLoader
import coil.annotation.ExperimentalCoilApi
import coil.disk.DiskCache
import coil.memory.MemoryCache
import dev.dropit.app.core.auth.AuthSessionState
import dev.dropit.app.core.network.ApiError
import dev.dropit.app.core.network.ApiErrorCode
import dev.dropit.app.core.network.DropitApiClient
import dev.dropit.app.core.network.ServerUrl
import dev.dropit.app.core.network.SessionCredentialsProvider
import dev.dropit.app.core.network.TargetScope
import dev.dropit.app.core.repository.MediaRepository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * Concrete implementation of [MediaRepository]:
 * - Authenticated Coil [ImageLoader] with memory + disk cache for `/thumbnail` and `/preview`,
 *   automatically clearing caches on logout or server switch.
 * - Authenticated Media3 [DataSource.Factory] (`OkHttpDataSource.Factory`) supporting HTTP `Range`
 *   for `/media` audio/video streaming.
 * - Encoding-safe, size-capped long text & Markdown preview reader supporting both uploaded text
 *   files (via `Range`-bounded `/download`) and inline text items (via snapshot fallback).
 */
class DefaultMediaRepository(
    private val context: Context?,
    baseOkHttpClient: OkHttpClient,
    private val apiClient: DropitApiClient,
    private val credentialsProvider: SessionCredentialsProvider,
    private val imageCacheDir: File,
    private val diskCacheMaxBytes: Long = DEFAULT_DISK_CACHE_BYTES,
    sessionStateFlow: Flow<AuthSessionState>? = null,
    coroutineScope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
    private val onCachesCleared: (() -> Unit)? = null,
) : MediaRepository {

    internal val mediaOkHttpClient: OkHttpClient = baseOkHttpClient.newBuilder()
        .addInterceptor(
            AuthenticatedMediaInterceptor(
                credentialsProvider = credentialsProvider,
                onUnauthorized = { origin, path ->
                    apiClient.emitSessionExpiredIf401(401, origin, path)
                },
            ),
        )
        .addNetworkInterceptor(
            CrossOriginAuthStripInterceptor(
                serverOriginProvider = { credentialsProvider.serverOrigin() },
            ),
        )
        .build()

    private val loaderLock = Any()
    @Volatile
    private var cachedImageLoader: ImageLoader? = null

    private var sessionObserverJob: Job? = null

    init {
        if (sessionStateFlow != null) {
            sessionObserverJob = coroutineScope.launch {
                var previous: AuthSessionState? = null
                sessionStateFlow.collect { next ->
                    val prev = previous
                    previous = next
                    if (prev != null) {
                        val loggedOut = prev.isSignedIn && !next.isSignedIn
                        val serverChanged = !prev.serverOrigin.isNullOrBlank() &&
                            prev.serverOrigin != next.serverOrigin
                        if (loggedOut || serverChanged) {
                            clearCaches()
                        }
                    }
                }
            }
        }
    }

    override suspend fun thumbnailUrl(scope: TargetScope, itemId: String): String =
        buildItemUrl(scope, itemId, "thumbnail")

    override suspend fun previewUrl(scope: TargetScope, itemId: String): String =
        buildItemUrl(scope, itemId, "preview")

    override suspend fun mediaUrl(scope: TargetScope, itemId: String): String =
        buildItemUrl(scope, itemId, "media")

    override suspend fun downloadUrl(scope: TargetScope, itemId: String): String =
        buildItemUrl(scope, itemId, "download")

    override fun createImageLoader(): ImageLoader {
        cachedImageLoader?.let { return it }
        synchronized(loaderLock) {
            cachedImageLoader?.let { return it }
            val appContext = requireNotNull(context?.applicationContext) {
                "Android Context is required to build Coil ImageLoader"
            }
            val loader = ImageLoader.Builder(appContext)
                .okHttpClient(mediaOkHttpClient)
                // dropit /api/* sends Cache-Control: no-store; we cache privately inside app cacheDir
                // and wipe memory + disk caches on logout / server switch via clearCaches().
                .respectCacheHeaders(false)
                .memoryCache {
                    MemoryCache.Builder(appContext)
                        .maxSizePercent(MEMORY_CACHE_PERCENT)
                        .build()
                }
                .diskCache {
                    if (!imageCacheDir.isDirectory) {
                        imageCacheDir.mkdirs()
                    }
                    DiskCache.Builder()
                        .directory(imageCacheDir)
                        .maxSizeBytes(diskCacheMaxBytes)
                        .build()
                }
                .build()
            cachedImageLoader = loader
            return loader
        }
    }

    @OptIn(UnstableApi::class)
    override fun createMediaDataSourceFactory(): DataSource.Factory =
        OkHttpDataSource.Factory(mediaOkHttpClient)

    override suspend fun fetchTextContent(
        scope: TargetScope,
        itemId: String,
        maxBytes: Int,
    ): String = fetchTextPreview(scope, itemId, maxBytes).text

    /**
     * Reads text or Markdown preview content with strict [maxBytes] protection, UTF-8/BOM/charset
     * decoding, and truncation metadata.
     */
    suspend fun fetchTextPreview(
        scope: TargetScope,
        itemId: String,
        maxBytes: Int = DEFAULT_TEXT_MAX_BYTES,
    ): DecodedTextPreview {
        val cleanId = itemId.trim()
        if (cleanId.isEmpty()) {
            throw ApiError(
                errorCode = ApiErrorCode.INVALID_INPUT,
                rawCode = "INVALID_INPUT",
                httpStatus = 400,
                userMessage = "条目 ID 不能为空",
            )
        }
        val clampedMax = maxBytes.coerceIn(1, HARD_MAX_TEXT_BYTES)
        val path = "${scope.apiBasePath}/items/${ServerUrl.encodeURIComponent(cleanId)}/download"
        val url = apiClient.buildUrl(path)
        val origin = extractOriginFromUrl(url)

        val request = Request.Builder()
            .url(url)
            .get()
            .header("Accept", "text/plain, text/markdown, */*")
            // Request maxBytes + 1 bytes (inclusive range 0..clampedMax) so we can detect truncation
            // accurately without pulling oversized files over the network.
            .header("Range", "bytes=0-$clampedMax")
            .build()

        val outcome = executeBoundedRead(request, maxReadBytes = clampedMax + 1)

        if (outcome.statusCode == 416) {
            return DecodedTextPreview(
                text = "",
                charsetName = Charsets.UTF_8.name(),
                truncated = false,
                totalBytes = 0L,
            )
        }

        if (outcome.statusCode == 404) {
            // Inline `kind = "text"` items have no fileKey so `/download` answers 404.
            // Fall back to the scope snapshot and return the bounded text item if present.
            val fallbackItem = runCatching { apiClient.getSnapshot(scope) }
                .getOrNull()
                ?.items
                ?.firstOrNull { it.id == cleanId && it.isText }
            if (fallbackItem != null) {
                return TextPreviewDecoder.truncateUtf8(fallbackItem.text.orEmpty(), clampedMax)
            }
        }

        if (outcome.statusCode !in 200..299) {
            throw ApiError.fromResponse(
                httpStatus = outcome.statusCode,
                rawBody = outcome.bytes.toString(Charsets.UTF_8),
                retryAfterHeader = outcome.retryAfterHeader,
            )
        }

        val totalBytes = TextPreviewDecoder.parseContentRangeTotal(outcome.contentRangeHeader)
            ?: outcome.contentLengthHeader?.takeIf { outcome.statusCode == 200 }
        val wasTruncated = outcome.reachedReadCap ||
            (totalBytes != null && totalBytes > clampedMax.toLong())

        return TextPreviewDecoder.decode(
            rawBytes = outcome.bytes,
            contentType = outcome.contentTypeHeader,
            maxBytes = clampedMax,
            wasTruncated = wasTruncated,
            totalBytes = totalBytes,
        )
    }

    @kotlin.OptIn(ExperimentalCoilApi::class)
    override suspend fun clearCaches() {
        val loader = synchronized(loaderLock) { cachedImageLoader }
        if (loader != null) {
            runCatching { loader.memoryCache?.clear() }
            withContext(Dispatchers.IO) {
                runCatching { loader.diskCache?.clear() }
            }
        } else {
            withContext(Dispatchers.IO) {
                runCatching {
                    if (imageCacheDir.isDirectory) {
                        imageCacheDir.listFiles()?.forEach { child ->
                            child.deleteRecursively()
                        }
                    }
                }
            }
        }
        onCachesCleared?.invoke()
    }

    internal fun cancelSessionObserver() {
        sessionObserverJob?.cancel()
        sessionObserverJob = null
    }

    private suspend fun buildItemUrl(scope: TargetScope, itemId: String, suffix: String): String {
        val cleanId = itemId.trim()
        require(cleanId.isNotEmpty()) { "Item ID must not be blank" }
        return apiClient.buildUrl(
            "${scope.apiBasePath}/items/${ServerUrl.encodeURIComponent(cleanId)}/$suffix",
        )
    }

    private data class BoundedHttpRead(
        val statusCode: Int,
        val bytes: ByteArray,
        val reachedReadCap: Boolean,
        val contentTypeHeader: String?,
        val contentRangeHeader: String?,
        val contentLengthHeader: Long?,
        val retryAfterHeader: String?,
    )

    private suspend fun executeBoundedRead(
        request: Request,
        maxReadBytes: Int,
    ): BoundedHttpRead = withContext(Dispatchers.IO) {
        val call = mediaOkHttpClient.newCall(request)
        try {
            suspendCancellableCoroutine { cont ->
                cont.invokeOnCancellation { call.cancel() }
                call.enqueue(object : Callback {
                    override fun onFailure(call: Call, e: IOException) {
                        if (cont.isActive) cont.resumeWithException(ApiError.network(e))
                    }

                    override fun onResponse(call: Call, response: Response) {
                        response.use { res ->
                            val status = res.code
                            val cap = if (status in 200..299) maxReadBytes else ERROR_BODY_MAX_BYTES
                            val bodyStream = res.body?.byteStream()
                            val out = ByteArrayOutputStream()
                            var reachedCap = false
                            if (bodyStream != null) {
                                val buffer = ByteArray(8 * 1024)
                                var remaining = cap
                                while (remaining > 0) {
                                    val toRead = minOf(buffer.size, remaining)
                                    val read = bodyStream.read(buffer, 0, toRead)
                                    if (read <= 0) break
                                    out.write(buffer, 0, read)
                                    remaining -= read
                                }
                                if (remaining == 0 && status in 200..299) {
                                    // Check if more data exists or if we already read maxBytes + 1 bytes.
                                    reachedCap = out.size() >= maxReadBytes
                                }
                            }
                            val result = BoundedHttpRead(
                                statusCode = status,
                                bytes = out.toByteArray(),
                                reachedReadCap = reachedCap,
                                contentTypeHeader = res.header("Content-Type"),
                                contentRangeHeader = res.header("Content-Range"),
                                contentLengthHeader = res.header("Content-Length")?.toLongOrNull(),
                                retryAfterHeader = res.header("Retry-After"),
                            )
                            if (cont.isActive) cont.resume(result)
                        }
                    }
                })
            }
        } catch (e: ApiError) {
            throw e
        } catch (e: IOException) {
            throw ApiError.network(e)
        }
    }

    private fun extractOriginFromUrl(url: String): String {
        val schemeIdx = url.indexOf("://")
        if (schemeIdx < 0) return url.trimEnd('/')
        val pathIdx = url.indexOf('/', startIndex = schemeIdx + 3)
        return if (pathIdx < 0) url else url.substring(0, pathIdx)
    }

    companion object {
        const val IMAGE_CACHE_DIR_NAME = "dropit_image_cache"
        const val DEFAULT_DISK_CACHE_BYTES: Long = 64L * 1024L * 1024L
        const val DEFAULT_TEXT_MAX_BYTES: Int = 512 * 1024
        const val HARD_MAX_TEXT_BYTES: Int = 4 * 1024 * 1024
        private const val MEMORY_CACHE_PERCENT = 0.20
        private const val ERROR_BODY_MAX_BYTES = 16 * 1024
    }
}
