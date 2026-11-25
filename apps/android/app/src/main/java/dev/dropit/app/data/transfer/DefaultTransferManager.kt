package dev.dropit.app.data.transfer

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import dev.dropit.app.core.auth.AuthRepository
import dev.dropit.app.core.auth.SettingsStore
import dev.dropit.app.core.auth.TokenVault
import dev.dropit.app.core.network.ApiError
import dev.dropit.app.core.network.ClipItem
import dev.dropit.app.core.network.DropitApiClient
import dev.dropit.app.core.network.TargetScope
import dev.dropit.app.core.repository.DownloadFileRequest
import dev.dropit.app.core.repository.StagedShareFile
import dev.dropit.app.core.repository.TransferDirection
import dev.dropit.app.core.repository.TransferManager
import dev.dropit.app.core.repository.TransferStatus
import dev.dropit.app.core.repository.TransferTask
import dev.dropit.app.core.repository.UploadFileRequest
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.InputStream
import java.security.MessageDigest
import java.util.Locale
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

data class TransferScopeKey(
    val serverOrigin: String,
    val accountId: String?,
)

/**
 * Resolves the active `(serverOrigin, accountId)` isolation scope for transfer queues.
 */
interface TransferScopeProvider {
    val activeScope: Flow<TransferScopeKey?>
    suspend fun currentScope(): TransferScopeKey?
    suspend fun clearCachedAccount()
}

/**
 * Copies user-selected content:// URIs into app-private staging files so queued uploads
 * remain readable across backgrounding and process death.
 */
fun interface UploadUriStager {
    suspend fun stage(taskId: String, request: UploadFileRequest, stagingDir: File): StagedUploadInput
}

data class StagedUploadInput(
    val fileName: String,
    val mimeType: String,
    val sizeBytes: Long,
    val stagedFile: File,
)

class AndroidUploadUriStager(
    context: Context,
) : UploadUriStager {
    private val appContext = context.applicationContext

    override suspend fun stage(
        taskId: String,
        request: UploadFileRequest,
        stagingDir: File,
    ): StagedUploadInput = withContext(Dispatchers.IO) {
        val resolver = appContext.contentResolver
        var resolvedName = request.fileName.takeIf { it.isNotBlank() }
        runCatching {
            resolver.query(
                request.uri,
                arrayOf(OpenableColumns.DISPLAY_NAME),
                null,
                null,
                null,
            )?.use { cursor ->
                if (cursor.moveToFirst()) {
                    val idx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    if (idx >= 0 && !cursor.isNull(idx)) {
                        val candidate = cursor.getString(idx)
                        if (!candidate.isNullOrBlank()) resolvedName = candidate
                    }
                }
            }
        }
        val safeName = DownloadName.sanitize(resolvedName ?: request.uri.lastPathSegment) ?: "upload"
        val resolvedMime = request.mimeType.takeIf { it.isNotBlank() && !it.contains('*') }
            ?: resolver.getType(request.uri)?.takeIf { it.isNotBlank() && !it.contains('*') }
            ?: DownloadName.extension(safeName)?.let { DownloadName.defaultMimeForExtension(it) }
            ?: "application/octet-stream"

        val taskDir = File(stagingDir, taskId)
        if (!taskDir.isDirectory && !taskDir.mkdirs()) {
            throw IOException("无法创建上传暂存目录")
        }
        val targetFile = File(taskDir, safeName)
        AndroidDownloadSink.ensureWithinDirectory(stagingDir, targetFile)

        val input: InputStream = resolver.openInputStream(request.uri)
            ?: throw IOException("无法读取所选文件：$safeName")
        val copiedBytes = input.use { stream ->
            FileOutputStream(targetFile).use { out ->
                stream.copyTo(out, bufferSize = 64 * 1024)
            }
        }
        StagedUploadInput(
            fileName = safeName,
            mimeType = DownloadName.baseMime(resolvedMime).ifBlank { "application/octet-stream" },
            sizeBytes = copiedBytes,
            stagedFile = targetFile,
        )
    }
}

/**
 * Default implementation of [TransferScopeProvider] backed by [SettingsStore], [TokenVault],
 * [AuthRepository], and `/api/me` account lookup.
 *
 * Isolates queues strictly by `(serverOrigin, accountId)`. When offline before `/api/me` has
 * succeeded, falls back to a deterministic non-raw SHA-256 token fingerprint (`tok:<hex>`)
 * and migrates rows seamlessly to the real `user.id` once `/api/me` resolves.
 */
class DefaultTransferScopeProvider(
    private val settingsStore: SettingsStore,
    private val tokenVault: TokenVault,
    private val authRepository: AuthRepository,
    private val apiClient: DropitApiClient,
    private val dao: TransferDao,
    private val clockMs: () -> Long = { System.currentTimeMillis() },
) : TransferScopeProvider {
    private val mutex = Mutex()
    private val resolvedAccountByFingerprint = ConcurrentHashMap<String, String>()
    private val scopeRevision = MutableStateFlow(0L)

    override val activeScope: Flow<TransferScopeKey?> = combine(
        settingsStore.settings.map { it.serverOrigin }.distinctUntilChanged(),
        authRepository.sessionState,
        scopeRevision,
    ) { origin, session, _ ->
        val effectiveOrigin = origin?.takeIf { it.isNotBlank() } ?: session.serverOrigin?.takeIf { it.isNotBlank() }
        if (effectiveOrigin == null) {
            null
        } else {
            resolveScopeForOrigin(effectiveOrigin, allowNetwork = false)
        }
    }.distinctUntilChanged()

    override suspend fun currentScope(): TransferScopeKey? {
        val origin = settingsStore.getServerOrigin()?.takeIf { it.isNotBlank() }
            ?: authRepository.sessionState.value.serverOrigin?.takeIf { it.isNotBlank() }
            ?: return null
        val resolved = resolveScopeForOrigin(origin, allowNetwork = true)
        scopeRevision.update { it + 1L }
        return resolved
    }

    override suspend fun clearCachedAccount() {
        mutex.withLock {
            resolvedAccountByFingerprint.clear()
            scopeRevision.update { it + 1L }
        }
    }

    private suspend fun resolveScopeForOrigin(origin: String, allowNetwork: Boolean): TransferScopeKey {
        val token = tokenVault.getToken()?.takeIf { it.isNotBlank() }
            ?: return TransferScopeKey(serverOrigin = origin, accountId = null)
        val fingerprint = "$origin|${tokenFingerprint(token)}"
        resolvedAccountByFingerprint[fingerprint]?.let { cachedUserId ->
            return TransferScopeKey(serverOrigin = origin, accountId = cachedUserId)
        }
        val fallbackId = "tok:${tokenFingerprint(token)}"
        if (!allowNetwork) {
            return TransferScopeKey(serverOrigin = origin, accountId = fallbackId)
        }
        return mutex.withLock {
            resolvedAccountByFingerprint[fingerprint]?.let { cachedUserId ->
                return@withLock TransferScopeKey(serverOrigin = origin, accountId = cachedUserId)
            }
            val userId = runCatching { apiClient.getMe().user.id }.getOrNull()?.takeIf { it.isNotBlank() }
            if (userId != null) {
                resolvedAccountByFingerprint[fingerprint] = userId
                runCatching {
                    dao.reassignAccountId(
                        serverOrigin = origin,
                        oldAccountId = fallbackId,
                        newAccountId = userId,
                        updatedAt = clockMs(),
                    )
                }
                TransferScopeKey(serverOrigin = origin, accountId = userId)
            } else {
                TransferScopeKey(serverOrigin = origin, accountId = fallbackId)
            }
        }
    }

    companion object {
        fun tokenFingerprint(token: String): String {
            val digest = MessageDigest.getInstance("SHA-256").digest(token.toByteArray(Charsets.UTF_8))
            val out = StringBuilder(16)
            for (i in 0 until 8) {
                out.append(String.format(Locale.ROOT, "%02x", digest[i].toInt() and 0xff))
            }
            return out.toString()
        }
    }
}

/**
 * Concrete Room + WorkManager implementation of [TransferManager].
 */
@OptIn(ExperimentalCoroutinesApi::class)
class DefaultTransferManager(
    private val dao: TransferDao,
    private val engine: TransferEngine,
    private val scheduler: TransferWorkScheduler,
    private val scopeProvider: TransferScopeProvider,
    private val uploadUriStager: UploadUriStager,
    private val uploadStagingDir: File,
    private val downloadTempDir: File,
    private val coroutineScope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
    private val clockMs: () -> Long = { System.currentTimeMillis() },
) : TransferManager {

    private val runtimeMetrics = MutableStateFlow<Map<String, TransferRuntimeMetrics>>(emptyMap())
    private val runningJobs = ConcurrentHashMap<String, Job>()
    private val taskLock = Mutex()

    override val tasks: StateFlow<List<TransferTask>> = scopeProvider.activeScope
        .flatMapLatest { scope ->
            if (scope == null) {
                flowOf(emptyList())
            } else {
                dao.observeByScope(scope.serverOrigin, scope.accountId)
            }
        }
        .combine(runtimeMetrics) { entities, metricsMap ->
            entities.map { entity ->
                val metrics = metricsMap[entity.id]
                entity.toDomain(
                    speedBytesPerSec = metrics?.speedBytesPerSec ?: 0L,
                    etaSeconds = metrics?.etaSeconds,
                    liveTransferredBytes = metrics?.transferredBytes,
                )
            }
        }
        .stateIn(
            scope = coroutineScope,
            started = SharingStarted.Eagerly,
            initialValue = emptyList(),
        )

    override val activeCount: StateFlow<Int> = tasks
        .map { list -> list.count { it.isActive } }
        .stateIn(
            scope = coroutineScope,
            started = SharingStarted.Eagerly,
            initialValue = 0,
        )

    override suspend fun enqueueUploads(requests: List<UploadFileRequest>): List<String> {
        if (requests.isEmpty()) return emptyList()
        val scope = scopeProvider.currentScope() ?: throw ApiError.notConfigured()
        if (!uploadStagingDir.isDirectory) uploadStagingDir.mkdirs()

        val createdIds = ArrayList<String>(requests.size)
        for (request in requests) {
            val taskId = UUID.randomUUID().toString()
            val now = clockMs()
            val staged = try {
                uploadUriStager.stage(taskId, request, uploadStagingDir)
            } catch (e: Exception) {
                val fallbackName = DownloadName.sanitize(request.fileName) ?: "upload"
                val failedEntity = TransferTaskEntity(
                    id = taskId,
                    serverOrigin = scope.serverOrigin,
                    accountId = scope.accountId,
                    targetScopeType = request.targetScope.scopeType,
                    targetScopeId = request.targetScope.scopeId,
                    groupName = request.groupName?.takeIf { it.isNotBlank() },
                    direction = TransferDirection.UPLOAD.name,
                    fileName = fallbackName,
                    mimeType = DownloadName.baseMime(request.mimeType).ifBlank { "application/octet-stream" },
                    totalBytes = request.sizeBytes.coerceAtLeast(0L),
                    status = TransferStatus.FAILED.name,
                    errorMessage = e.message ?: "读取文件失败",
                    createdAt = now,
                    updatedAt = now,
                )
                dao.upsert(failedEntity)
                createdIds.add(taskId)
                continue
            }

            val entity = TransferTaskEntity(
                id = taskId,
                serverOrigin = scope.serverOrigin,
                accountId = scope.accountId,
                targetScopeType = request.targetScope.scopeType,
                targetScopeId = request.targetScope.scopeId,
                groupName = request.groupName?.takeIf { it.isNotBlank() },
                direction = TransferDirection.UPLOAD.name,
                fileName = staged.fileName,
                mimeType = staged.mimeType,
                totalBytes = staged.sizeBytes,
                localStagedPath = staged.stagedFile.absolutePath,
                status = TransferStatus.QUEUED.name,
                createdAt = now,
                updatedAt = now,
            )
            dao.upsert(entity)
            scheduler.enqueue(taskId)
            createdIds.add(taskId)
        }
        return createdIds
    }

    override suspend fun enqueueStagedUploads(
        stagedFiles: List<StagedShareFile>,
        targetScope: TargetScope,
        groupName: String?,
    ): List<String> {
        if (stagedFiles.isEmpty()) return emptyList()
        val scope = scopeProvider.currentScope() ?: throw ApiError.notConfigured()
        val createdIds = ArrayList<String>(stagedFiles.size)

        for (staged in stagedFiles) {
            val taskId = UUID.randomUUID().toString()
            val now = clockMs()
            val file = File(staged.stagedFilePath)
            val safeName = DownloadName.sanitize(staged.displayName) ?: "shared"
            val cleanMime = DownloadName.baseMime(staged.mimeType).ifBlank { "application/octet-stream" }
            val actualSize = if (file.isFile) file.length() else staged.sizeBytes.coerceAtLeast(0L)
            val fileExists = file.isFile && file.canRead()

            val entity = TransferTaskEntity(
                id = taskId,
                serverOrigin = scope.serverOrigin,
                accountId = scope.accountId,
                targetScopeType = targetScope.scopeType,
                targetScopeId = targetScope.scopeId,
                groupName = groupName?.takeIf { it.isNotBlank() },
                direction = TransferDirection.UPLOAD.name,
                fileName = safeName,
                mimeType = cleanMime,
                totalBytes = actualSize,
                localStagedPath = staged.stagedFilePath,
                status = if (fileExists) TransferStatus.QUEUED.name else TransferStatus.FAILED.name,
                errorMessage = if (fileExists) null else "本地临时文件已清理，请重新选择文件",
                createdAt = now,
                updatedAt = now,
            )
            dao.upsert(entity)
            if (fileExists) {
                scheduler.enqueue(taskId)
            }
            createdIds.add(taskId)
        }
        return createdIds
    }

    override suspend fun enqueueDownload(request: DownloadFileRequest): String {
        val scope = scopeProvider.currentScope() ?: throw ApiError.notConfigured()
        val taskId = UUID.randomUUID().toString()
        val now = clockMs()
        val fileName = DownloadName.sanitize(request.item.filename) ?: "dropit-download"
        val mime = DownloadName.baseMime(request.item.mime).ifBlank { "application/octet-stream" }

        val entity = TransferTaskEntity(
            id = taskId,
            serverOrigin = scope.serverOrigin,
            accountId = scope.accountId,
            targetScopeType = request.targetScope.scopeType,
            targetScopeId = request.targetScope.scopeId,
            direction = TransferDirection.DOWNLOAD.name,
            fileName = fileName,
            mimeType = mime,
            totalBytes = request.item.size.coerceAtLeast(0L),
            remoteItemId = request.item.id,
            shareAfterDownload = request.shareAfterDownload,
            status = TransferStatus.QUEUED.name,
            createdAt = now,
            updatedAt = now,
        )
        dao.upsert(entity)
        scheduler.enqueue(taskId)
        return taskId
    }

    override suspend fun downloadForShare(item: ClipItem, targetScope: TargetScope): Result<Uri> {
        val scope = scopeProvider.currentScope()
            ?: return Result.failure(ApiError.notConfigured())
        return runCatching {
            val saved = engine.downloadForShareDirect(
                item = item,
                targetScope = targetScope,
                serverOrigin = scope.serverOrigin,
            )
            saved.contentUri ?: Uri.parse(saved.uriString)
        }
    }

    override suspend fun cancel(taskId: String) {
        val entity = dao.getById(taskId) ?: return
        val status = entity.toStatus()
        if (status == TransferStatus.SUCCEEDED) return

        dao.updateStatus(taskId, TransferStatus.CANCELLED.name, null, clockMs())
        clearMetrics(taskId)
        runningJobs.remove(taskId)?.cancel()
        scheduler.cancel(taskId)

        if (entity.toDirection() == TransferDirection.UPLOAD) {
            engine.cancelRemoteUploadBestEffort(entity)
        }
        engine.deleteStagedFileIfOwned(entity.localStagedPath)
    }

    override suspend fun retry(taskId: String) {
        val entity = dao.getById(taskId) ?: return
        val status = entity.toStatus()
        // Never re-run succeeded or already active tasks (prevents duplicate remote items).
        if (status == TransferStatus.SUCCEEDED ||
            status == TransferStatus.RUNNING ||
            status == TransferStatus.QUEUED
        ) {
            return
        }
        if (entity.toDirection() == TransferDirection.UPLOAD) {
            val staged = entity.localStagedPath?.let { File(it) }
            if (staged == null || !staged.isFile || !staged.canRead()) {
                dao.updateStatus(
                    id = taskId,
                    status = TransferStatus.FAILED.name,
                    errorMessage = "本地临时文件已清理，请重新选择文件",
                    updatedAt = clockMs(),
                )
                return
            }
        }
        dao.updateStatus(
            id = taskId,
            status = TransferStatus.QUEUED.name,
            errorMessage = null,
            updatedAt = clockMs(),
        )
        scheduler.enqueue(taskId)
    }

    override suspend fun clearCompleted() {
        val scope = scopeProvider.currentScope() ?: return
        dao.deleteCompletedForScope(scope.serverOrigin, scope.accountId)
    }

    override suspend fun clearAllForScopeSwitch() {
        // Cancel all active work and local jobs first.
        scheduler.cancelAll()
        val activeJobs = runningJobs.values.toList()
        runningJobs.clear()
        activeJobs.forEach { it.cancel() }
        runtimeMetrics.value = emptyMap()

        // Best-effort release remote upload sessions and delete local staged files.
        val allTasks = runCatching { dao.listAll() }.getOrDefault(emptyList())
        for (entity in allTasks) {
            if (entity.toDirection() == TransferDirection.UPLOAD && !entity.remoteUploadId.isNullOrBlank()) {
                engine.cancelRemoteUploadBestEffort(entity)
            }
            engine.deleteStagedFileIfOwned(entity.localStagedPath)
        }

        // Clear persisted transfer queue and staging directories.
        dao.deleteAll()
        runCatching { uploadStagingDir.deleteRecursively() }
        runCatching { downloadTempDir.deleteRecursively() }
        scopeProvider.clearCachedAccount()
    }

    /**
     * Reconciles tasks left in RUNNING state after process death so the UI accurately reflects
     * resumable or missing-file states rather than stale spinning progress bars.
     */
    suspend fun recoverInterruptedTasks() {
        val running = runCatching { dao.listByStatus(TransferStatus.RUNNING.name) }.getOrDefault(emptyList())
        for (entity in running) {
            if (runningJobs.containsKey(entity.id) || scheduler.isWorkActive(entity.id)) {
                continue
            }
            if (entity.toDirection() == TransferDirection.UPLOAD) {
                val staged = entity.localStagedPath?.let { File(it) }
                if (staged == null || !staged.isFile || !staged.canRead()) {
                    dao.updateStatus(
                        id = entity.id,
                        status = TransferStatus.FAILED.name,
                        errorMessage = "本地临时文件已清理，请重新选择文件",
                        updatedAt = clockMs(),
                    )
                    continue
                }
            }
            dao.updateStatus(
                id = entity.id,
                status = TransferStatus.PAUSED.name,
                errorMessage = "传输已中断，点击重试续传",
                updatedAt = clockMs(),
            )
        }
    }

    internal suspend fun getTaskEntity(taskId: String): TransferTaskEntity? = dao.getById(taskId)

    internal suspend fun executeTaskFromWorker(
        taskId: String,
        onProgress: (TransferTaskEntity, TransferRuntimeMetrics) -> Unit = { _, _ -> },
    ): TransferExecutionOutcome {
        val currentJob = kotlinx.coroutines.currentCoroutineContext()[Job]
        if (currentJob != null) {
            val previous = taskLock.withLock {
                val existing = runningJobs[taskId]
                if (existing != null && existing.isActive) {
                    existing
                } else {
                    runningJobs[taskId] = currentJob
                    null
                }
            }
            if (previous != null) {
                return TransferExecutionOutcome.AlreadyCompleted
            }
        }
        val initialEntity = dao.getById(taskId)
        return try {
            engine.executeTask(taskId) { metrics ->
                updateMetrics(taskId, metrics)
                val snapshot = tasks.value.firstOrNull { it.id == taskId }
                val baseEntity = if (snapshot != null) {
                    TransferTaskEntity(
                        id = snapshot.id,
                        serverOrigin = snapshot.serverOrigin,
                        accountId = snapshot.accountId,
                        targetScopeType = snapshot.targetScope.scopeType,
                        targetScopeId = snapshot.targetScope.scopeId,
                        groupName = snapshot.groupName,
                        direction = snapshot.direction.name,
                        fileName = snapshot.fileName,
                        mimeType = snapshot.mimeType,
                        totalBytes = snapshot.totalBytes,
                        transferredBytes = metrics.transferredBytes,
                        status = snapshot.status.name,
                        createdAt = snapshot.createdAt,
                        updatedAt = snapshot.updatedAt,
                    )
                } else {
                    initialEntity?.copy(transferredBytes = metrics.transferredBytes)
                }
                if (baseEntity != null) {
                    onProgress(baseEntity, metrics)
                }
            }
        } finally {
            runningJobs.remove(taskId)
            clearMetrics(taskId)
        }
    }

    internal fun updateMetrics(taskId: String, metrics: TransferRuntimeMetrics) {
        runtimeMetrics.update { current -> current + (taskId to metrics) }
    }

    internal fun clearMetrics(taskId: String) {
        runtimeMetrics.update { current ->
            if (current.containsKey(taskId)) current - taskId else current
        }
    }
}
