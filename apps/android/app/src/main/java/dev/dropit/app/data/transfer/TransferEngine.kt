package dev.dropit.app.data.transfer

import dev.dropit.app.core.network.ApiError
import dev.dropit.app.core.network.ApiErrorCode
import dev.dropit.app.core.network.ClipItem
import dev.dropit.app.core.network.DropitApiClient
import dev.dropit.app.core.network.ItemResponse
import dev.dropit.app.core.network.ServerUrl
import dev.dropit.app.core.network.TargetScope
import dev.dropit.app.core.network.UploadSession
import dev.dropit.app.core.repository.TransferDirection
import dev.dropit.app.core.repository.TransferStatus
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.isActive
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okio.BufferedSink
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.RandomAccessFile
import java.security.MessageDigest
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import kotlin.coroutines.coroutineContext
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlin.math.ceil
import kotlin.math.min

/**
 * Pure coroutine engine for chunked parallel resumable uploads and Range-resumable streaming downloads.
 * All HTTP traffic passes through [DropitApiClient]'s OkHttpClient with Bearer + device headers
 * and 401 session expiration propagation.
 */
class TransferEngine(
    private val apiClient: DropitApiClient,
    private val dao: TransferDao,
    private val downloadSink: DownloadSink,
    private val downloadTempDir: File,
    private val ownedStagingRoots: List<File>,
    private val chunkConcurrency: Int = DEFAULT_CHUNK_CONCURRENCY,
    private val globalChunkSemaphore: Semaphore = Semaphore(DEFAULT_GLOBAL_CHUNK_CONCURRENCY),
    private val maxRetries: Int = DEFAULT_MAX_RETRIES,
    private val clockMs: () -> Long = { System.currentTimeMillis() },
    private val sleepMs: suspend (Long) -> Unit = { delay(it) },
) {
    @Serializable
    private data class CreateUploadBody(
        val filename: String,
        val size: Long,
        val mime: String,
    )

    suspend fun executeTask(
        taskId: String,
        onMetrics: (TransferRuntimeMetrics) -> Unit,
    ): TransferExecutionOutcome {
        val entity = dao.getById(taskId) ?: return TransferExecutionOutcome.NotFound
        val currentStatus = entity.toStatus()
        if (currentStatus == TransferStatus.SUCCEEDED) {
            return TransferExecutionOutcome.AlreadyCompleted
        }
        if (currentStatus == TransferStatus.CANCELLED) {
            return TransferExecutionOutcome.Cancelled
        }
        return when (entity.toDirection()) {
            TransferDirection.UPLOAD -> executeUpload(entity, onMetrics)
            TransferDirection.DOWNLOAD -> executeDownload(entity, onMetrics)
        }
    }

    suspend fun cancelRemoteUploadBestEffort(entity: TransferTaskEntity) {
        val uploadId = entity.remoteUploadId?.takeIf { it.isNotBlank() } ?: return
        val scope = entity.toTargetScope()
        runCatching {
            val url = apiClient.buildUrl(
                path = "${scope.apiBasePath}/uploads/${ServerUrl.encodeURIComponent(uploadId)}",
                serverOriginOverride = entity.serverOrigin,
            )
            val request = buildAuthorizedRequest(url = url, method = "DELETE")
            apiClient.executeNoContent(request, authenticated = true)
        }
    }

    suspend fun downloadForShareDirect(
        item: ClipItem,
        targetScope: TargetScope,
        serverOrigin: String,
    ): SavedDownloadResult = withContext(Dispatchers.IO) {
        if (!downloadTempDir.isDirectory) downloadTempDir.mkdirs()
        val tempFile = File(downloadTempDir, "share_${item.id.replace(Regex("[^A-Za-z0-9._-]"), "_")}_${System.nanoTime()}.part")
        try {
            val meta = streamDownloadToFile(
                serverOrigin = serverOrigin,
                scope = targetScope,
                itemId = item.id,
                fallbackFileName = item.filename ?: "dropit-download",
                fallbackMime = item.mime,
                expectedSizeHint = item.size,
                destPartFile = tempFile,
                onMetaResolved = { _, _, _ -> },
                onProgress = { _, _ -> },
            )
            downloadSink.saveToShareCache(tempFile, item.id, meta.fileName)
        } finally {
            runCatching { tempFile.delete() }
        }
    }

    fun deleteStagedFileIfOwned(path: String?) {
        if (path.isNullOrBlank()) return
        val file = File(path)
        val canonical = runCatching { file.canonicalPath }.getOrNull() ?: return
        val isOwned = ownedStagingRoots.any { root ->
            val rootCanonical = runCatching { root.canonicalPath }.getOrNull() ?: return@any false
            canonical.startsWith("$rootCanonical${File.separator}")
        }
        if (isOwned) {
            runCatching {
                file.delete()
                val parent = file.parentFile
                if (parent != null && parent.isDirectory && parent.list().isNullOrEmpty()) {
                    val parentCanonical = runCatching { parent.canonicalPath }.getOrNull()
                    val isRootItself = ownedStagingRoots.any {
                        runCatching { it.canonicalPath }.getOrNull() == parentCanonical
                    }
                    if (!isRootItself) {
                        parent.delete()
                    }
                }
            }
        }
    }

    private suspend fun executeUpload(
        initialEntity: TransferTaskEntity,
        onMetrics: (TransferRuntimeMetrics) -> Unit,
    ): TransferExecutionOutcome = withContext(Dispatchers.IO) {
        val stagedPath = initialEntity.localStagedPath
        val stagedFile = stagedPath?.let { File(it) }
        if (stagedFile == null || !stagedFile.isFile || !stagedFile.canRead()) {
            val msg = "本地临时文件已清理，请重新选择文件"
            dao.updateStatus(initialEntity.id, TransferStatus.FAILED.name, msg, clockMs())
            return@withContext TransferExecutionOutcome.Failed(msg)
        }
        val actualSize = stagedFile.length()
        if (actualSize <= 0L) {
            val msg = "不能上传空文件"
            dao.updateStatus(initialEntity.id, TransferStatus.FAILED.name, msg, clockMs())
            return@withContext TransferExecutionOutcome.Failed(msg)
        }
        val entity = if (actualSize != initialEntity.totalBytes) {
            dao.updateFileMetadata(
                id = initialEntity.id,
                fileName = initialEntity.fileName,
                mimeType = initialEntity.mimeType,
                totalBytes = actualSize,
                updatedAt = clockMs(),
            )
            initialEntity.copy(totalBytes = actualSize)
        } else {
            initialEntity
        }

        dao.updateStatus(entity.id, TransferStatus.RUNNING.name, null, clockMs())
        val tracker = TransferSpeedTracker(clockMs = clockMs)
        val scope = entity.toTargetScope()

        try {
            val session = openOrResumeUploadSession(entity, scope, actualSize)
            val chunkSize = session.chunkSize.coerceAtLeast(1)
            val totalChunks = ceil(actualSize.toDouble() / chunkSize.toDouble()).toInt().coerceAtLeast(1)
            val completedSet = Collections.synchronizedSet(
                session.received.filter { it in 0 until totalChunks }.toMutableSet(),
            )
            val inFlightBytes = ConcurrentHashMap<Int, Long>()

            fun chunkLength(index: Int): Long {
                val offset = index.toLong() * chunkSize.toLong()
                return min(chunkSize.toLong(), actualSize - offset).coerceAtLeast(0L)
            }

            fun computeTransferredBytes(): Long {
                var total = 0L
                val snapshotCompleted = synchronized(completedSet) { completedSet.toSet() }
                for (idx in snapshotCompleted) {
                    total += chunkLength(idx)
                }
                for ((idx, bytes) in inFlightBytes) {
                    if (idx !in snapshotCompleted) {
                        total += bytes.coerceIn(0L, chunkLength(idx))
                    }
                }
                return total.coerceAtMost(actualSize)
            }

            val lastDbPersistMs = AtomicLong(0L)
            suspend fun reportProgress(forcePersist: Boolean) {
                val transferred = computeTransferredBytes()
                val metrics = tracker.record(transferred, actualSize)
                onMetrics(metrics)
                val now = clockMs()
                if (forcePersist || now - lastDbPersistMs.get() >= PROGRESS_PERSIST_INTERVAL_MS) {
                    lastDbPersistMs.set(now)
                    val encoded = synchronized(completedSet) { CompletedChunksCodec.encode(completedSet) }
                    dao.updateProgress(entity.id, transferred, encoded, now)
                }
            }

            reportProgress(forcePersist = true)

            val missingIndices = (0 until totalChunks).filter { it !in completedSet }
            if (missingIndices.isNotEmpty()) {
                val cursor = AtomicInteger(0)
                val workers = min(chunkConcurrency.coerceAtLeast(1), missingIndices.size)
                coroutineScope {
                    (0 until workers).map {
                        async {
                            while (isActive) {
                                val pos = cursor.getAndIncrement()
                                if (pos >= missingIndices.size) break
                                val index = missingIndices[pos]
                                uploadChunkWithRetry(
                                    entity = entity,
                                    scope = scope,
                                    uploadId = session.uploadId,
                                    file = stagedFile,
                                    totalBytes = actualSize,
                                    chunkSize = chunkSize,
                                    index = index,
                                    onChunkProgress = { loaded ->
                                        inFlightBytes[index] = loaded
                                        val transferred = computeTransferredBytes()
                                        onMetrics(tracker.record(transferred, actualSize))
                                    },
                                )
                                inFlightBytes.remove(index)
                                completedSet.add(index)
                                reportProgress(forcePersist = true)
                            }
                        }
                    }.awaitAll()
                }
            }

            coroutineContext.ensureActive()
            completeUploadWithRetry(entity, scope, session.uploadId)

            dao.markSucceeded(
                id = entity.id,
                status = TransferStatus.SUCCEEDED.name,
                transferredBytes = actualSize,
                localResultUri = null,
                updatedAt = clockMs(),
            )
            deleteStagedFileIfOwned(stagedPath)
            onMetrics(TransferRuntimeMetrics(transferredBytes = actualSize, speedBytesPerSec = 0L, etaSeconds = 0L))
            TransferExecutionOutcome.Succeeded
        } catch (ce: CancellationException) {
            handleCancellation(entity.id)
            throw ce
        } catch (e: ApiError) {
            if (e.httpStatus == 404) {
                dao.updateUploadSession(
                    id = entity.id,
                    remoteUploadId = null,
                    chunkSize = 0,
                    completedChunks = "",
                    transferredBytes = 0L,
                    updatedAt = clockMs(),
                )
            }
            val latest = dao.getById(entity.id)
            if (latest?.toStatus() == TransferStatus.CANCELLED) {
                return@withContext TransferExecutionOutcome.Cancelled
            }
            dao.updateStatus(entity.id, TransferStatus.FAILED.name, e.userMessage, clockMs())
            TransferExecutionOutcome.Failed(e.userMessage)
        } catch (e: Exception) {
            val latest = dao.getById(entity.id)
            if (latest?.toStatus() == TransferStatus.CANCELLED) {
                return@withContext TransferExecutionOutcome.Cancelled
            }
            val msg = e.message?.takeIf { it.isNotBlank() } ?: ApiErrorCode.NETWORK_ERROR.defaultMessage
            dao.updateStatus(entity.id, TransferStatus.FAILED.name, msg, clockMs())
            TransferExecutionOutcome.Failed(msg)
        }
    }

    private suspend fun openOrResumeUploadSession(
        entity: TransferTaskEntity,
        scope: TargetScope,
        totalBytes: Long,
    ): UploadSession {
        val existingId = entity.remoteUploadId?.takeIf { it.isNotBlank() }
        if (existingId != null) {
            try {
                val getUrl = apiClient.buildUrl(
                    path = "${scope.apiBasePath}/uploads/${ServerUrl.encodeURIComponent(existingId)}",
                    serverOriginOverride = entity.serverOrigin,
                )
                val getReq = buildAuthorizedRequest(url = getUrl, method = "GET")
                val remote = apiClient.executeJson(getReq, authenticated = true, deserializer = UploadSession.serializer())
                val now = clockMs()
                val validSize = remote.size == 0L || remote.size == totalBytes
                if (remote.expiresAt > now && remote.chunkSize > 0 && validSize) {
                    val resumed = remote.copy(uploadId = existingId)
                    val encoded = CompletedChunksCodec.encode(resumed.received)
                    val receivedBytes = calculateReceivedBytes(totalBytes, resumed.chunkSize, resumed.received)
                    dao.updateUploadSession(
                        id = entity.id,
                        remoteUploadId = existingId,
                        chunkSize = resumed.chunkSize,
                        completedChunks = encoded,
                        transferredBytes = receivedBytes,
                        updatedAt = now,
                    )
                    return resumed
                }
                // Expired or incompatible remote session: reset and create new.
                dao.updateUploadSession(
                    id = entity.id,
                    remoteUploadId = null,
                    chunkSize = 0,
                    completedChunks = "",
                    transferredBytes = 0L,
                    updatedAt = now,
                )
            } catch (e: ApiError) {
                if (e.httpStatus == 404) {
                    dao.updateUploadSession(
                        id = entity.id,
                        remoteUploadId = null,
                        chunkSize = 0,
                        completedChunks = "",
                        transferredBytes = 0L,
                        updatedAt = clockMs(),
                    )
                } else {
                    throw e
                }
            }
        }

        val createUrl = apiClient.buildUrl(
            path = "${scope.apiBasePath}/uploads",
            serverOriginOverride = entity.serverOrigin,
        )
        val cleanMime = DownloadName.baseMime(entity.mimeType).ifBlank { "application/octet-stream" }
        val payload = apiClient.json.encodeToString(
            CreateUploadBody(
                filename = entity.fileName.ifBlank { "file" },
                size = totalBytes,
                mime = cleanMime,
            ),
        )
        val createReq = buildAuthorizedRequest(
            url = createUrl,
            method = "POST",
            body = payload.toRequestBody(JSON_MEDIA_TYPE),
        )
        val created = apiClient.executeJson(createReq, authenticated = true, deserializer = UploadSession.serializer())
        if (created.uploadId.isBlank() || created.chunkSize <= 0) {
            throw ApiError(
                errorCode = ApiErrorCode.UNKNOWN,
                rawCode = "INVALID_UPLOAD_SESSION",
                httpStatus = 200,
                userMessage = "服务器返回的上传会话无效",
            )
        }
        dao.updateUploadSession(
            id = entity.id,
            remoteUploadId = created.uploadId,
            chunkSize = created.chunkSize,
            completedChunks = CompletedChunksCodec.encode(created.received),
            transferredBytes = calculateReceivedBytes(totalBytes, created.chunkSize, created.received),
            updatedAt = clockMs(),
        )
        return created
    }

    private suspend fun uploadChunkWithRetry(
        entity: TransferTaskEntity,
        scope: TargetScope,
        uploadId: String,
        file: File,
        totalBytes: Long,
        chunkSize: Int,
        index: Int,
        onChunkProgress: (Long) -> Unit,
    ) {
        val offset = index.toLong() * chunkSize.toLong()
        val length = min(chunkSize.toLong(), totalBytes - offset)
        val chunkSha256 = computeFileSliceSha256(file, offset, length)
        val url = apiClient.buildUrl(
            path = "${scope.apiBasePath}/uploads/${ServerUrl.encodeURIComponent(uploadId)}/chunks/$index",
            serverOriginOverride = entity.serverOrigin,
        )

        var attempt = 0
        while (true) {
            coroutineContext.ensureActive()
            val retryDelayMs: Long = try {
                globalChunkSemaphore.withPermit {
                    onChunkProgress(0L)
                    val body = FileSliceRequestBody(
                        file = file,
                        offset = offset,
                        length = length,
                        onBytesWritten = onChunkProgress,
                    )
                    val request = buildAuthorizedRequest(
                        url = url,
                        method = "PUT",
                        body = body,
                        extraHeaders = mapOf("X-Chunk-Sha256" to chunkSha256),
                    )
                    apiClient.executeNoContent(request, authenticated = true)
                    return
                }
            } catch (ce: CancellationException) {
                throw ce
            } catch (e: ApiError) {
                val retryable = isChunkErrorRetryable(e)
                if (!retryable || attempt >= maxRetries) throw e
                attempt += 1
                e.retryAfterSeconds?.let { it * 1_000L } ?: (1_000L shl (attempt - 1))
            }
            sleepMs(retryDelayMs)
        }
    }

    private suspend fun completeUploadWithRetry(
        entity: TransferTaskEntity,
        scope: TargetScope,
        uploadId: String,
    ): ClipItem {
        val url = apiClient.buildUrl(
            path = "${scope.apiBasePath}/uploads/${ServerUrl.encodeURIComponent(uploadId)}/complete",
            serverOriginOverride = entity.serverOrigin,
        )
        val extraHeaders = buildMap {
            val group = entity.groupName?.trim()
            if (!group.isNullOrEmpty()) {
                put("X-Dropit-Group", ServerUrl.encodeURIComponent(group))
            }
        }
        var attempt = 0
        while (true) {
            coroutineContext.ensureActive()
            val retryDelayMs: Long = try {
                val request = buildAuthorizedRequest(
                    url = url,
                    method = "POST",
                    body = EMPTY_BODY,
                    extraHeaders = extraHeaders,
                )
                return apiClient.executeJson(request, authenticated = true, deserializer = ItemResponse.serializer()).item
            } catch (ce: CancellationException) {
                throw ce
            } catch (e: ApiError) {
                val retryable = e.httpStatus == 429 || e.rawCode.equals("UPLOAD_IN_PROGRESS", ignoreCase = true)
                if (!retryable || attempt >= maxRetries) throw e
                attempt += 1
                e.retryAfterSeconds?.let { it * 1_000L } ?: (1_000L shl (attempt - 1))
            }
            sleepMs(retryDelayMs)
        }
    }

    private suspend fun executeDownload(
        entity: TransferTaskEntity,
        onMetrics: (TransferRuntimeMetrics) -> Unit,
    ): TransferExecutionOutcome = withContext(Dispatchers.IO) {
        val itemId = entity.remoteItemId?.takeIf { it.isNotBlank() }
        if (itemId == null) {
            val msg = "缺少下载条目编号"
            dao.updateStatus(entity.id, TransferStatus.FAILED.name, msg, clockMs())
            return@withContext TransferExecutionOutcome.Failed(msg)
        }

        if (!downloadTempDir.isDirectory) downloadTempDir.mkdirs()
        val partFile = entity.localStagedPath?.let { File(it) }
            ?: File(downloadTempDir, "dl_${entity.id}.part")
        if (entity.localStagedPath != partFile.absolutePath) {
            dao.upsert(entity.copy(localStagedPath = partFile.absolutePath, updatedAt = clockMs()))
        }

        dao.updateStatus(entity.id, TransferStatus.RUNNING.name, null, clockMs())
        val tracker = TransferSpeedTracker(clockMs = clockMs)
        val lastDbPersistMs = AtomicLong(0L)

        try {
            var resolvedTotal = entity.totalBytes
            val resolvedMeta = streamDownloadToFile(
                serverOrigin = entity.serverOrigin,
                scope = entity.toTargetScope(),
                itemId = itemId,
                fallbackFileName = entity.fileName,
                fallbackMime = entity.mimeType,
                expectedSizeHint = entity.totalBytes,
                destPartFile = partFile,
                onMetaResolved = { name, mime, total ->
                    resolvedTotal = if (total > 0L) total else resolvedTotal
                    dao.updateFileMetadata(
                        id = entity.id,
                        fileName = name,
                        mimeType = mime,
                        totalBytes = resolvedTotal,
                        updatedAt = clockMs(),
                    )
                },
                onProgress = { transferred, total ->
                    val effectiveTotal = if (total > 0L) total else resolvedTotal
                    val metrics = tracker.record(transferred, effectiveTotal)
                    onMetrics(metrics)
                    val now = clockMs()
                    if (now - lastDbPersistMs.get() >= PROGRESS_PERSIST_INTERVAL_MS ||
                        (effectiveTotal > 0L && transferred >= effectiveTotal)
                    ) {
                        lastDbPersistMs.set(now)
                        dao.updateProgress(entity.id, transferred, "", now)
                    }
                },
            )

            val saved = if (entity.shareAfterDownload) {
                downloadSink.saveToShareCache(partFile, itemId, resolvedMeta.fileName)
            } else {
                downloadSink.saveToSystemDownloads(partFile, resolvedMeta.fileName, resolvedMeta.mimeType)
            }
            val finalBytes = partFile.length()
            runCatching { partFile.delete() }

            dao.markSucceeded(
                id = entity.id,
                status = TransferStatus.SUCCEEDED.name,
                transferredBytes = finalBytes,
                localResultUri = saved.uriString,
                updatedAt = clockMs(),
            )
            onMetrics(TransferRuntimeMetrics(transferredBytes = finalBytes, speedBytesPerSec = 0L, etaSeconds = 0L))
            TransferExecutionOutcome.Succeeded
        } catch (ce: CancellationException) {
            handleCancellation(entity.id)
            throw ce
        } catch (e: ApiError) {
            val latest = dao.getById(entity.id)
            if (latest?.toStatus() == TransferStatus.CANCELLED) {
                runCatching { partFile.delete() }
                return@withContext TransferExecutionOutcome.Cancelled
            }
            dao.updateStatus(entity.id, TransferStatus.FAILED.name, e.userMessage, clockMs())
            TransferExecutionOutcome.Failed(e.userMessage)
        } catch (e: Exception) {
            val latest = dao.getById(entity.id)
            if (latest?.toStatus() == TransferStatus.CANCELLED) {
                runCatching { partFile.delete() }
                return@withContext TransferExecutionOutcome.Cancelled
            }
            val msg = e.message?.takeIf { it.isNotBlank() } ?: ApiErrorCode.NETWORK_ERROR.defaultMessage
            dao.updateStatus(entity.id, TransferStatus.FAILED.name, msg, clockMs())
            TransferExecutionOutcome.Failed(msg)
        }
    }

    private suspend fun streamDownloadToFile(
        serverOrigin: String,
        scope: TargetScope,
        itemId: String,
        fallbackFileName: String,
        fallbackMime: String?,
        expectedSizeHint: Long,
        destPartFile: File,
        onMetaResolved: suspend (name: String, mime: String, totalBytes: Long) -> Unit,
        onProgress: suspend (transferred: Long, totalBytes: Long) -> Unit,
    ): DownloadName.ResolvedDownloadMeta {
        val path = "${scope.apiBasePath}/items/${ServerUrl.encodeURIComponent(itemId)}/download"
        val url = apiClient.buildUrl(path = path, serverOriginOverride = serverOrigin)

        var restartWithoutRange = false
        while (true) {
            coroutineContext.ensureActive()
            val existingOffset = if (!restartWithoutRange && destPartFile.isFile) destPartFile.length() else 0L
            val extraHeaders = if (existingOffset > 0L) {
                mapOf("Range" to "bytes=$existingOffset-")
            } else {
                emptyMap()
            }
            val request = buildAuthorizedRequest(
                url = url,
                method = "GET",
                extraHeaders = extraHeaders,
            )

            val call = apiClient.okHttpClient.newCall(request)
            val response = executeCallCancellable(call)
            response.use { res ->
                if (res.code == 416 && existingOffset > 0L && !restartWithoutRange) {
                    val rangeTotal = parseContentRangeTotal(res.header("Content-Range"))
                    if (rangeTotal != null && existingOffset == rangeTotal) {
                        val meta = DownloadName.resolve(
                            contentDisposition = res.header("Content-Disposition"),
                            fallbackFileName = fallbackFileName,
                            responseMime = res.header("Content-Type"),
                            fallbackMime = fallbackMime,
                            mimeFromExtension = downloadSink::mimeFromExtension,
                            extensionFromMime = downloadSink::extensionFromMime,
                        )
                        onMetaResolved(meta.fileName, meta.mimeType, rangeTotal)
                        onProgress(existingOffset, rangeTotal)
                        return meta
                    }
                    destPartFile.delete()
                    restartWithoutRange = true
                    return@use
                }

                if (res.code !in 200..299) {
                    val errorBody = runCatching { res.body?.string() }.getOrNull()
                    if (res.code == 401) {
                        apiClient.emitSessionExpiredIf401(401, serverOrigin, path)
                    }
                    throw ApiError.fromResponse(res.code, errorBody, res.header("Retry-After"))
                }

                val isPartial = res.code == 206
                val contentRange = res.header("Content-Range")
                val parsedRange = if (isPartial) parseContentRange(contentRange) else null
                val appendMode = isPartial && existingOffset > 0L && parsedRange != null && parsedRange.start == existingOffset
                if (isPartial && existingOffset > 0L && !appendMode) {
                    // Server returned an unexpected Range window; restart cleanly from 0.
                    destPartFile.delete()
                    restartWithoutRange = true
                    return@use
                }

                val contentLength = res.body?.contentLength() ?: -1L
                val expectedTotal = when {
                    appendMode && parsedRange?.total != null -> parsedRange.total
                    appendMode && contentLength >= 0L -> existingOffset + contentLength
                    contentLength >= 0L -> contentLength
                    expectedSizeHint > 0L -> expectedSizeHint
                    else -> -1L
                }

                val meta = DownloadName.resolve(
                    contentDisposition = res.header("Content-Disposition"),
                    fallbackFileName = fallbackFileName,
                    responseMime = res.header("Content-Type"),
                    fallbackMime = fallbackMime,
                    mimeFromExtension = downloadSink::mimeFromExtension,
                    extensionFromMime = downloadSink::extensionFromMime,
                )
                onMetaResolved(meta.fileName, meta.mimeType, expectedTotal.coerceAtLeast(0L))

                val body = res.body ?: throw IOException("下载响应为空")
                var transferred = if (appendMode) existingOffset else 0L
                onProgress(transferred, expectedTotal.coerceAtLeast(0L))

                destPartFile.parentFile?.mkdirs()
                FileOutputStream(destPartFile, appendMode).use { out ->
                    body.byteStream().use { input ->
                        val buffer = ByteArray(64 * 1024)
                        while (true) {
                            coroutineContext.ensureActive()
                            val read = input.read(buffer)
                            if (read < 0) break
                            out.write(buffer, 0, read)
                            transferred += read
                            onProgress(transferred, expectedTotal.coerceAtLeast(0L))
                        }
                    }
                    out.flush()
                }

                if (expectedTotal > 0L && transferred != expectedTotal) {
                    throw IOException("下载不完整（已接收 $transferred / $expectedTotal 字节）")
                }
                return meta
            }
        }
    }

    private suspend fun handleCancellation(taskId: String) {
        val current = runCatching { dao.getById(taskId) }.getOrNull() ?: return
        val status = current.toStatus()
        if (status == TransferStatus.RUNNING || status == TransferStatus.QUEUED) {
            // System preemption / worker stop (not explicit user cancellation): mark PAUSED for resume.
            dao.updateStatus(
                id = taskId,
                status = TransferStatus.PAUSED.name,
                errorMessage = "传输已暂停，可断点续传",
                updatedAt = clockMs(),
            )
        }
    }

    private suspend fun buildAuthorizedRequest(
        url: String,
        method: String,
        body: RequestBody? = null,
        extraHeaders: Map<String, String> = emptyMap(),
    ): Request {
        val builder = Request.Builder().url(url)
        for ((k, v) in apiClient.currentHeaders(authenticated = true)) {
            builder.header(k, v)
        }
        for ((k, v) in extraHeaders) {
            builder.header(k, v)
        }
        builder.method(method, body)
        return builder.build()
    }

    private suspend fun executeCallCancellable(call: Call): Response =
        suspendCancellableCoroutine { cont ->
            cont.invokeOnCancellation { call.cancel() }
            call.enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) {
                    if (cont.isActive) cont.resumeWithException(ApiError.network(e))
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

    private class FileSliceRequestBody(
        private val file: File,
        private val offset: Long,
        private val length: Long,
        private val onBytesWritten: (Long) -> Unit,
    ) : RequestBody() {
        override fun contentType(): MediaType = OCTET_STREAM_MEDIA_TYPE
        override fun contentLength(): Long = length

        override fun writeTo(sink: BufferedSink) {
            RandomAccessFile(file, "r").use { raf ->
                raf.seek(offset)
                val buffer = ByteArray(32 * 1024)
                var remaining = length
                var written = 0L
                while (remaining > 0L) {
                    val toRead = min(buffer.size.toLong(), remaining).toInt()
                    val read = raf.read(buffer, 0, toRead)
                    if (read < 0) throw IOException("读取本地分片失败：文件长度不足")
                    sink.write(buffer, 0, read)
                    remaining -= read
                    written += read
                    onBytesWritten(written)
                }
            }
        }
    }

    private data class ParsedContentRange(val start: Long, val end: Long, val total: Long?)

    companion object {
        const val DEFAULT_CHUNK_CONCURRENCY = 3
        const val DEFAULT_GLOBAL_CHUNK_CONCURRENCY = 6
        const val DEFAULT_MAX_RETRIES = 3
        private const val PROGRESS_PERSIST_INTERVAL_MS = 400L

        private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
        private val OCTET_STREAM_MEDIA_TYPE = "application/octet-stream".toMediaType()
        private val EMPTY_BODY = ByteArray(0).toRequestBody(null)
        private val CONTENT_RANGE_BYTES_REGEX = Regex("^bytes\\s+(\\d+)-(\\d+)/(\\d+|\\*)$", RegexOption.IGNORE_CASE)
        private val CONTENT_RANGE_TOTAL_REGEX = Regex("^bytes\\s+\\*/(\\d+)$", RegexOption.IGNORE_CASE)

        fun isChunkErrorRetryable(error: ApiError): Boolean {
            if (error.httpStatus == 0 || error.httpStatus == 429 || error.httpStatus >= 500) return true
            return error.rawCode.equals("UPLOAD_TIMEOUT", ignoreCase = true)
        }

        fun calculateReceivedBytes(totalBytes: Long, chunkSize: Int, received: Collection<Int>): Long {
            if (totalBytes <= 0L || chunkSize <= 0) return 0L
            val chunkCount = ceil(totalBytes.toDouble() / chunkSize.toDouble()).toInt()
            var bytes = 0L
            for (index in received.distinct()) {
                if (index !in 0 until chunkCount) continue
                val offset = index.toLong() * chunkSize.toLong()
                bytes += min(chunkSize.toLong(), totalBytes - offset).coerceAtLeast(0L)
            }
            return bytes.coerceAtMost(totalBytes)
        }

        fun computeFileSliceSha256(file: File, offset: Long, length: Long): String {
            val digest = MessageDigest.getInstance("SHA-256")
            RandomAccessFile(file, "r").use { raf ->
                raf.seek(offset)
                val buffer = ByteArray(32 * 1024)
                var remaining = length
                while (remaining > 0L) {
                    val toRead = min(buffer.size.toLong(), remaining).toInt()
                    val read = raf.read(buffer, 0, toRead)
                    if (read < 0) throw IOException("校验分片失败：文件长度不足")
                    digest.update(buffer, 0, read)
                    remaining -= read
                }
            }
            val bytes = digest.digest()
            val out = StringBuilder(bytes.size * 2)
            for (b in bytes) {
                out.append(String.format(Locale.ROOT, "%02x", b.toInt() and 0xff))
            }
            return out.toString()
        }

        private fun parseContentRange(header: String?): ParsedContentRange? {
            if (header.isNullOrBlank()) return null
            val match = CONTENT_RANGE_BYTES_REGEX.matchEntire(header.trim()) ?: return null
            val start = match.groupValues[1].toLongOrNull() ?: return null
            val end = match.groupValues[2].toLongOrNull() ?: return null
            val total = match.groupValues[3].toLongOrNull()
            return ParsedContentRange(start = start, end = end, total = total)
        }

        private fun parseContentRangeTotal(header: String?): Long? {
            if (header.isNullOrBlank()) return null
            val match = CONTENT_RANGE_TOTAL_REGEX.matchEntire(header.trim()) ?: return null
            return match.groupValues[1].toLongOrNull()
        }
    }
}

sealed class TransferExecutionOutcome {
    data object Succeeded : TransferExecutionOutcome()
    data object AlreadyCompleted : TransferExecutionOutcome()
    data object Cancelled : TransferExecutionOutcome()
    data object NotFound : TransferExecutionOutcome()
    data class Failed(val message: String) : TransferExecutionOutcome()
}

private object Collections {
    fun <T> synchronizedSet(set: MutableSet<T>): MutableSet<T> =
        java.util.Collections.synchronizedSet(set)
}
