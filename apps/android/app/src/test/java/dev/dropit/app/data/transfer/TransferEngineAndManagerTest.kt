package dev.dropit.app.data.transfer

import dev.dropit.app.core.network.ClipItem
import dev.dropit.app.core.network.DropitApiClient
import dev.dropit.app.core.network.ServerUrl
import dev.dropit.app.core.network.SessionCredentialsProvider
import dev.dropit.app.core.network.TargetScope
import dev.dropit.app.core.repository.DownloadEnqueueResult
import dev.dropit.app.core.repository.DownloadFileRequest
import dev.dropit.app.core.repository.StagedShareFile
import dev.dropit.app.core.repository.TransferDirection
import dev.dropit.app.core.repository.TransferStatus
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlinx.coroutines.yield
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.mockwebserver.SocketPolicy
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.security.MessageDigest
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class TransferEngineAndManagerTest {

    private lateinit var server: MockWebServer
    private lateinit var okHttpClient: OkHttpClient
    private lateinit var baseUrl: String
    private lateinit var tempRoot: File
    private lateinit var uploadStagingDir: File
    private lateinit var shareStagingDir: File
    private lateinit var downloadTempDir: File
    private lateinit var savedDownloadsDir: File
    private lateinit var shareCacheDir: File
    private lateinit var managerScope: CoroutineScope

    private var token: String? = "tok_transfer_test_1234567890"

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        baseUrl = server.url("/").toString().trimEnd('/')
        okHttpClient = OkHttpClient.Builder().build()
        tempRoot = Files.createTempDirectory("dropit-transfer-test").toFile()
        uploadStagingDir = File(tempRoot, "upload_staging").apply { mkdirs() }
        shareStagingDir = File(tempRoot, "share_staging").apply { mkdirs() }
        downloadTempDir = File(tempRoot, "download_temp").apply { mkdirs() }
        savedDownloadsDir = File(tempRoot, "downloads").apply { mkdirs() }
        shareCacheDir = File(tempRoot, "share_cache").apply { mkdirs() }
        managerScope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
    }

    @After
    fun tearDown() {
        managerScope.cancel()
        server.shutdown()
        okHttpClient.dispatcher.executorService.shutdown()
        okHttpClient.connectionPool.evictAll()
        tempRoot.deleteRecursively()
    }

    private fun createApiClient(): DropitApiClient {
        val creds = object : SessionCredentialsProvider {
            override suspend fun serverOrigin(): String = baseUrl
            override suspend fun accessToken(): String? = token
            override suspend fun deviceId(): String = "and-0123456789abcdefghij"
            override fun deviceName(): String = "dropit Android · Test"
        }
        return DropitApiClient(
            okHttpClient = okHttpClient,
            credentialsProvider = creds,
            allowInsecureHttpForTest = true,
        )
    }

    private fun createDownloadSink(): DownloadSink = object : DownloadSink {
        override fun saveToSystemDownloads(sourceFile: File, fileName: String, mimeType: String): SavedDownloadResult {
            val safeName = DownloadName.sanitize(fileName) ?: "dropit-download"
            val dest = AndroidDownloadSink.uniqueFile(savedDownloadsDir, safeName)
            AndroidDownloadSink.copyFileAtomically(sourceFile, dest)
            return SavedDownloadResult(uriString = "file://${dest.absolutePath}", savedFile = dest)
        }

        override fun saveToShareCache(sourceFile: File, itemId: String, fileName: String): SavedDownloadResult {
            val safeName = DownloadName.sanitize(fileName) ?: "dropit-download"
            val dest = File(File(shareCacheDir, itemId).apply { mkdirs() }, safeName)
            AndroidDownloadSink.copyFileAtomically(sourceFile, dest)
            return SavedDownloadResult(uriString = "content://dev.dropit.app.fileprovider/cache/$itemId/$safeName", savedFile = dest)
        }

        override fun mimeFromExtension(ext: String): String? = DownloadName.defaultMimeForExtension(ext)
        override fun extensionFromMime(mime: String): String? = DownloadName.defaultExtensionForMime(mime)
    }

    private fun createHarness(
        initialScope: TransferScopeKey = TransferScopeKey(baseUrl, "user-1"),
        clockMs: () -> Long = { System.currentTimeMillis() },
        localSavedFileChecker: LocalSavedFileChecker = FileSystemLocalSavedFileChecker,
    ): TestHarness {
        val dao = InMemoryTransferDao()
        val scopeFlow = MutableStateFlow<TransferScopeKey?>(initialScope)
        val scopeProvider = object : TransferScopeProvider {
            override val activeScope: Flow<TransferScopeKey?> = scopeFlow
            override suspend fun currentScope(): TransferScopeKey? = scopeFlow.value
            override suspend fun clearCachedAccount() {
                scopeFlow.value = null
            }
        }
        val scheduler = FakeWorkScheduler()
        val apiClient = createApiClient()
        val engine = TransferEngine(
            apiClient = apiClient,
            dao = dao,
            downloadSink = createDownloadSink(),
            downloadTempDir = downloadTempDir,
            ownedStagingRoots = listOf(uploadStagingDir, shareStagingDir, downloadTempDir),
            chunkConcurrency = 3,
            maxRetries = 1,
            clockMs = clockMs,
            sleepMs = {},
        )
        val manager = DefaultTransferManager(
            dao = dao,
            engine = engine,
            scheduler = scheduler,
            scopeProvider = scopeProvider,
            uploadUriStager = { _, _, _ -> error("not used in staged upload test") },
            uploadStagingDir = uploadStagingDir,
            downloadTempDir = downloadTempDir,
            localSavedFileChecker = localSavedFileChecker,
            coroutineScope = managerScope,
            clockMs = clockMs,
        )
        return TestHarness(dao, scopeFlow, scheduler, engine, manager)
    }

    @Test
    fun chunkedParallelUpload_verifiesChunkSha256GroupHeaderAndCleansStagedFile() = runTest {
        val payload = ByteArray(1024 * 3 + 111) { ((it * 31) and 0xFF).toByte() }
        val chunkSize = 1024
        val receivedChunks = ConcurrentHashMap<Int, ByteArray>()
        val receivedChecksums = ConcurrentHashMap<Int, String>()
        var capturedGroupHeader: String? = null
        var capturedAuthHeader: String? = null

        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.path.orEmpty()
                return when {
                    request.method == "POST" && path == "/api/spaces/sp-1/uploads" -> {
                        capturedAuthHeader = request.getHeader("Authorization")
                        MockResponse()
                            .setResponseCode(201)
                            .setBody("""{"uploadId":"up-100","chunkSize":$chunkSize,"expiresAt":${System.currentTimeMillis() + 60_000},"received":[]}""")
                    }
                    request.method == "PUT" && path.startsWith("/api/spaces/sp-1/uploads/up-100/chunks/") -> {
                        val idx = path.substringAfterLast('/').toInt()
                        val bytes = request.body.readByteArray()
                        receivedChunks[idx] = bytes
                        request.getHeader("X-Chunk-Sha256")?.let { receivedChecksums[idx] = it }
                        MockResponse().setResponseCode(204)
                    }
                    request.method == "POST" && path == "/api/spaces/sp-1/uploads/up-100/complete" -> {
                        capturedGroupHeader = request.getHeader("X-Dropit-Group")
                        MockResponse()
                            .setResponseCode(201)
                            .setBody("""{"item":{"id":"item-1","spaceId":"sp-1","kind":"file","filename":"报告.pdf","mime":"application/pdf","size":${payload.size},"createdAt":1,"updatedAt":1,"expiresAt":999}}""")
                    }
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }

        val stagedFile = File(shareStagingDir, "s1/report.pdf").apply {
            parentFile?.mkdirs()
            writeBytes(payload)
        }
        val harness = createHarness()
        val taskIds = harness.manager.enqueueStagedUploads(
            stagedFiles = listOf(
                StagedShareFile(
                    id = "f1",
                    displayName = "报告.pdf",
                    mimeType = "application/pdf",
                    sizeBytes = payload.size.toLong(),
                    stagedFilePath = stagedFile.absolutePath,
                ),
            ),
            targetScope = TargetScope.SpaceScope("sp-1"),
            groupName = "工作文档",
        )
        assertEquals(1, taskIds.size)
        val taskId = taskIds.first()
        assertEquals(listOf(taskId), harness.scheduler.enqueued)

        val outcome = harness.manager.executeTaskFromWorker(taskId)
        assertEquals(TransferExecutionOutcome.Succeeded, outcome)
        assertEquals("Bearer $token", capturedAuthHeader)
        assertEquals(ServerUrl.encodeURIComponent("工作文档"), capturedGroupHeader)
        assertEquals(4, receivedChunks.size)

        // Reassemble and verify exact bytes and SHA-256 per chunk.
        val reassembled = ByteArray(payload.size)
        var offset = 0
        for (i in 0 until 4) {
            val chunk = receivedChunks[i]!!
            assertEquals(sha256Hex(chunk), receivedChecksums[i])
            System.arraycopy(chunk, 0, reassembled, offset, chunk.size)
            offset += chunk.size
        }
        assertArrayEquals(payload, reassembled)

        val entity = harness.dao.getById(taskId)!!
        assertEquals(TransferStatus.SUCCEEDED, entity.toStatus())
        assertEquals(payload.size.toLong(), entity.transferredBytes)
        assertNull(entity.remoteUploadId)
        assertFalse("Staged file must be cleaned up after upload succeeds", stagedFile.exists())
    }

    @Test
    fun chunkedUpload_supportsRoomScopePath() = runTest {
        val payload = "room-file-content".toByteArray()
        val seenPaths = CopyOnWriteArrayList<String>()

        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.path.orEmpty()
                seenPaths.add("${request.method} $path")
                return when {
                    request.method == "POST" && path == "/api/rooms/rm-secret/uploads" ->
                        MockResponse().setResponseCode(201).setBody("""{"uploadId":"up-room","chunkSize":64,"expiresAt":${System.currentTimeMillis() + 60_000},"received":[]}""")
                    request.method == "PUT" && path == "/api/rooms/rm-secret/uploads/up-room/chunks/0" ->
                        MockResponse().setResponseCode(204)
                    request.method == "POST" && path == "/api/rooms/rm-secret/uploads/up-room/complete" ->
                        MockResponse().setResponseCode(201).setBody("""{"item":{"id":"item-r1","spaceId":"rm-1","kind":"file","filename":"a.txt","mime":"text/plain","size":${payload.size}}}""")
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }

        val stagedFile = File(uploadStagingDir, "room/a.txt").apply {
            parentFile?.mkdirs()
            writeBytes(payload)
        }
        val harness = createHarness()
        val taskId = harness.manager.enqueueStagedUploads(
            stagedFiles = listOf(StagedShareFile("f1", "a.txt", "text/plain", payload.size.toLong(), stagedFile.absolutePath)),
            targetScope = TargetScope.RoomScope("rm-secret"),
        ).first()

        assertEquals(TransferExecutionOutcome.Succeeded, harness.manager.executeTaskFromWorker(taskId))
        assertEquals(
            listOf(
                "POST /api/rooms/rm-secret/uploads",
                "PUT /api/rooms/rm-secret/uploads/up-room/chunks/0",
                "POST /api/rooms/rm-secret/uploads/up-room/complete",
            ),
            seenPaths,
        )
    }

    @Test
    fun resumeUpload_queriesServerReceivedChunksAvoidsDuplicatesAndRetryOnSucceededIsNoop() = runTest {
        val chunkSize = 512
        val payload = ByteArray(chunkSize * 3) { it.toByte() }
        val createCalls = AtomicInteger(0)
        val getCalls = AtomicInteger(0)
        val completeCalls = AtomicInteger(0)
        val putCallsByIndex = ConcurrentHashMap<Int, AtomicInteger>()
        val failChunk2Once = AtomicInteger(2) // initial + 1 retry fails on first run

        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.path.orEmpty()
                return when {
                    request.method == "POST" && path == "/api/spaces/sp-1/uploads" -> {
                        createCalls.incrementAndGet()
                        MockResponse()
                            .setResponseCode(201)
                            .setBody("""{"uploadId":"up-resumable","chunkSize":$chunkSize,"expiresAt":${System.currentTimeMillis() + 60_000},"received":[]}""")
                    }
                    request.method == "GET" && path == "/api/spaces/sp-1/uploads/up-resumable" -> {
                        getCalls.incrementAndGet()
                        MockResponse()
                            .setResponseCode(200)
                            .setBody("""{"size":${payload.size},"chunkSize":$chunkSize,"expiresAt":${System.currentTimeMillis() + 60_000},"received":[0,1]}""")
                    }
                    request.method == "PUT" && path.startsWith("/api/spaces/sp-1/uploads/up-resumable/chunks/") -> {
                        val idx = path.substringAfterLast('/').toInt()
                        putCallsByIndex.computeIfAbsent(idx) { AtomicInteger(0) }.incrementAndGet()
                        if (idx == 2 && failChunk2Once.getAndDecrement() > 0) {
                            MockResponse().setResponseCode(500).setBody("""{"error":{"code":"INTERNAL_ERROR"}}""")
                        } else {
                            MockResponse().setResponseCode(204)
                        }
                    }
                    request.method == "POST" && path == "/api/spaces/sp-1/uploads/up-resumable/complete" -> {
                        completeCalls.incrementAndGet()
                        MockResponse()
                            .setResponseCode(201)
                            .setBody("""{"item":{"id":"item-single","spaceId":"sp-1","kind":"file","filename":"resume.bin","mime":"application/octet-stream","size":${payload.size}}}""")
                    }
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }

        val stagedFile = File(uploadStagingDir, "resume/resume.bin").apply {
            parentFile?.mkdirs()
            writeBytes(payload)
        }
        val harness = createHarness()
        val taskId = harness.manager.enqueueStagedUploads(
            stagedFiles = listOf(StagedShareFile("f1", "resume.bin", "application/octet-stream", payload.size.toLong(), stagedFile.absolutePath)),
            targetScope = TargetScope.SpaceScope("sp-1"),
        ).first()

        // First attempt: chunk 0 & 1 succeed, chunk 2 fails -> FAILED, staged file kept, remoteUploadId persisted.
        val firstOutcome = harness.manager.executeTaskFromWorker(taskId)
        assertTrue(firstOutcome is TransferExecutionOutcome.Failed)
        val failedEntity = harness.dao.getById(taskId)!!
        assertEquals(TransferStatus.FAILED, failedEntity.toStatus())
        assertEquals("up-resumable", failedEntity.remoteUploadId)
        assertTrue("Staged file must remain for retry", stagedFile.exists())

        val chunk0BeforeRetry = putCallsByIndex[0]?.get() ?: 0
        val chunk1BeforeRetry = putCallsByIndex[1]?.get() ?: 0

        // Retry: queries GET /uploads/up-resumable, skips chunks 0 & 1, only uploads chunk 2, completes once!
        harness.manager.retry(taskId)
        val secondOutcome = harness.manager.executeTaskFromWorker(taskId)
        assertEquals(TransferExecutionOutcome.Succeeded, secondOutcome)

        assertEquals("Must not create a second upload session", 1, createCalls.get())
        assertEquals("Must query existing upload session before resuming", 1, getCalls.get())
        assertEquals("Chunk 0 must not be re-uploaded on resume", chunk0BeforeRetry, putCallsByIndex[0]?.get())
        assertEquals("Chunk 1 must not be re-uploaded on resume", chunk1BeforeRetry, putCallsByIndex[1]?.get())
        assertEquals("Complete must only be called once", 1, completeCalls.get())

        // Retrying an already SUCCEEDED task must be a no-op (prevents duplicate item creation).
        val enqueuedBefore = harness.scheduler.enqueued.size
        harness.manager.retry(taskId)
        assertEquals(enqueuedBefore, harness.scheduler.enqueued.size)
        assertEquals(TransferExecutionOutcome.AlreadyCompleted, harness.manager.executeTaskFromWorker(taskId))
        assertEquals(1, createCalls.get())
        assertEquals(1, completeCalls.get())
    }

    @Test
    fun cancelUpload_sendsRemoteDeleteAndDeletesStagedFile() = runTest {
        val deletedIds = CopyOnWriteArrayList<String>()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.path.orEmpty()
                if (request.method == "DELETE" && path.startsWith("/api/spaces/sp-1/uploads/")) {
                    deletedIds.add(path.substringAfterLast('/'))
                    return MockResponse().setResponseCode(204)
                }
                return MockResponse().setResponseCode(404)
            }
        }

        val stagedFile = File(uploadStagingDir, "cancel/big.zip").apply {
            parentFile?.mkdirs()
            writeBytes(ByteArray(256) { 7 })
        }
        val harness = createHarness()
        val entity = TransferTaskEntity(
            id = "task-cancel-1",
            serverOrigin = baseUrl,
            accountId = "user-1",
            targetScopeType = "space",
            targetScopeId = "sp-1",
            direction = TransferDirection.UPLOAD.name,
            fileName = "big.zip",
            mimeType = "application/zip",
            totalBytes = 256L,
            remoteUploadId = "up-to-cancel",
            localStagedPath = stagedFile.absolutePath,
            status = TransferStatus.PAUSED.name,
            createdAt = 1L,
            updatedAt = 1L,
        )
        harness.dao.upsert(entity)

        harness.manager.cancel("task-cancel-1")

        assertEquals(TransferStatus.CANCELLED, harness.dao.getById("task-cancel-1")?.toStatus())
        assertEquals(listOf("up-to-cancel"), deletedIds)
        assertTrue(harness.scheduler.cancelled.contains("task-cancel-1"))
        assertFalse("Staged file must be deleted on cancel", stagedFile.exists())
    }

    @Test
    fun download_supportsRfc5987ChineseNameRangeResumeAndDownloadForShare() = runTest {
        val fullContent = "第一段中文内容-第二段续传内容-END".toByteArray(Charsets.UTF_8)
        val firstPartLen = 12
        val seenRanges = CopyOnWriteArrayList<String>()
        var attempts = 0

        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                assertEquals("Bearer $token", request.getHeader("Authorization"))
                val range = request.getHeader("Range")
                if (range != null) seenRanges.add(range)
                attempts += 1

                if (request.path == "/api/spaces/sp-1/items/it-cn/download") {
                    if (attempts == 1) {
                        // Simulate interrupted response: declares full length and disconnects early.
                        val partial = fullContent.copyOfRange(0, firstPartLen)
                        return MockResponse()
                            .setResponseCode(200)
                            .addHeader("Content-Disposition", "attachment; filename=\"download.txt\"; filename*=UTF-8''%E6%B5%8B%E8%AF%95%E6%96%87%E6%A1%A3.txt")
                            .addHeader("Content-Type", "application/octet-stream")
                            .setBody(Buffer().write(partial))
                            .setHeader("Content-Length", fullContent.size.toString())
                            .setSocketPolicy(SocketPolicy.DISCONNECT_AT_END)
                    }
                    if (range == "bytes=$firstPartLen-") {
                        val remainder = fullContent.copyOfRange(firstPartLen, fullContent.size)
                        return MockResponse()
                            .setResponseCode(206)
                            .addHeader("Content-Disposition", "attachment; filename=\"download.txt\"; filename*=UTF-8''%E6%B5%8B%E8%AF%95%E6%96%87%E6%A1%A3.txt")
                            .addHeader("Content-Type", "application/octet-stream")
                            .addHeader("Content-Range", "bytes $firstPartLen-${fullContent.size - 1}/${fullContent.size}")
                            .setBody(Buffer().write(remainder))
                    }
                    return MockResponse()
                        .setResponseCode(200)
                        .addHeader("Content-Disposition", "attachment; filename*=UTF-8''%E6%B5%8B%E8%AF%95%E6%96%87%E6%A1%A3.txt")
                        .addHeader("Content-Type", "application/octet-stream")
                        .setBody(Buffer().write(fullContent))
                }
                return MockResponse().setResponseCode(404)
            }
        }

        val harness = createHarness()
        val item = ClipItem(
            id = "it-cn",
            spaceId = "sp-1",
            kind = "file",
            filename = "raw.bin",
            mime = "application/octet-stream",
            size = fullContent.size.toLong(),
        )
        val taskId = harness.manager.enqueueDownload(
            DownloadFileRequest(item = item, targetScope = TargetScope.SpaceScope("sp-1")),
        )

        // Attempt 1 writes partial bytes and fails due to incomplete stream.
        val first = harness.manager.executeTaskFromWorker(taskId)
        assertTrue(first is TransferExecutionOutcome.Failed)

        // Retry sends Range: bytes=12-, resumes and saves with decoded Chinese filename!
        harness.manager.retry(taskId)
        val second = harness.manager.executeTaskFromWorker(taskId)
        assertEquals(TransferExecutionOutcome.Succeeded, second)
        assertEquals(listOf("bytes=$firstPartLen-"), seenRanges)

        val entity = harness.dao.getById(taskId)!!
        assertEquals("测试文档.txt", entity.fileName)
        assertEquals("text/plain", entity.mimeType)
        val saved = File(savedDownloadsDir, "测试文档.txt")
        assertTrue(saved.isFile)
        assertArrayEquals(fullContent, saved.readBytes())

        // Direct downloadForShare writes to share cache and returns URI.
        val shareSaved = harness.engine.downloadForShareDirect(
            item = item,
            targetScope = TargetScope.SpaceScope("sp-1"),
            serverOrigin = baseUrl,
        )
        assertNotNull(shareSaved.savedFile)
        assertEquals("测试文档.txt", shareSaved.savedFile?.name)
        assertArrayEquals(fullContent, shareSaved.savedFile?.readBytes())
        assertTrue(shareSaved.uriString.contains("fileprovider"))
    }

    @Test
    fun scopeIsolationAndServerSwitchCleanup_neverLeakAcrossServersOrAccounts() = runTest {
        val harness = createHarness(TransferScopeKey("https://server-a.example", "acct-1"))
        val stagedA1 = File(uploadStagingDir, "a1/file.txt").apply {
            parentFile?.mkdirs()
            writeText("a1")
        }

        harness.dao.upsertAll(
            listOf(
                TransferTaskEntity(
                    id = "t-a1",
                    serverOrigin = "https://server-a.example",
                    accountId = "acct-1",
                    targetScopeType = "space",
                    targetScopeId = "sp-1",
                    direction = TransferDirection.UPLOAD.name,
                    fileName = "a1.txt",
                    mimeType = "text/plain",
                    totalBytes = 2L,
                    localStagedPath = stagedA1.absolutePath,
                    status = TransferStatus.QUEUED.name,
                    createdAt = 10L,
                    updatedAt = 10L,
                ),
                TransferTaskEntity(
                    id = "t-a2",
                    serverOrigin = "https://server-a.example",
                    accountId = "acct-2",
                    targetScopeType = "space",
                    targetScopeId = "sp-2",
                    direction = TransferDirection.UPLOAD.name,
                    fileName = "a2.txt",
                    mimeType = "text/plain",
                    totalBytes = 2L,
                    status = TransferStatus.QUEUED.name,
                    createdAt = 20L,
                    updatedAt = 20L,
                ),
                TransferTaskEntity(
                    id = "t-b1",
                    serverOrigin = "https://server-b.example",
                    accountId = "acct-1",
                    targetScopeType = "space",
                    targetScopeId = "sp-3",
                    direction = TransferDirection.UPLOAD.name,
                    fileName = "b1.txt",
                    mimeType = "text/plain",
                    totalBytes = 2L,
                    status = TransferStatus.QUEUED.name,
                    createdAt = 30L,
                    updatedAt = 30L,
                ),
            ),
        )

        // Scope (server-a, acct-1) only sees t-a1.
        assertEquals(listOf("t-a1"), harness.manager.tasks.first { it.isNotEmpty() }.map { it.id })

        // Switching to (server-a, acct-2) isolates strictly to t-a2.
        harness.scopeFlow.value = TransferScopeKey("https://server-a.example", "acct-2")
        assertEquals(listOf("t-a2"), harness.manager.tasks.first { it.map { t -> t.id } == listOf("t-a2") }.map { it.id })

        // Switching to (server-b, acct-1) isolates strictly to t-b1.
        harness.scopeFlow.value = TransferScopeKey("https://server-b.example", "acct-1")
        assertEquals(listOf("t-b1"), harness.manager.tasks.first { it.map { t -> t.id } == listOf("t-b1") }.map { it.id })

        // Server switch cleanup wipes tasks, cancels all WorkManager jobs, and removes staged files.
        harness.manager.clearAllForScopeSwitch()
        assertTrue(harness.scheduler.cancelledAll)
        assertTrue(harness.dao.listAll().isEmpty())
        assertFalse(stagedA1.exists())
        assertTrue(harness.manager.tasks.value.isEmpty())
    }

    @Test
    fun recoverInterruptedTasks_marksOrphanedRunningAsPausedOrFailedWhenMissingFile() = runTest {
        val harness = createHarness()
        val aliveFile = File(uploadStagingDir, "alive/data.bin").apply {
            parentFile?.mkdirs()
            writeBytes(ByteArray(32))
        }
        val missingFile = File(uploadStagingDir, "missing/gone.bin")

        harness.dao.upsertAll(
            listOf(
                TransferTaskEntity(
                    id = "orphan-alive",
                    serverOrigin = baseUrl,
                    accountId = "user-1",
                    targetScopeType = "space",
                    targetScopeId = "sp-1",
                    direction = TransferDirection.UPLOAD.name,
                    fileName = "data.bin",
                    mimeType = "application/octet-stream",
                    totalBytes = 32L,
                    localStagedPath = aliveFile.absolutePath,
                    status = TransferStatus.RUNNING.name,
                    createdAt = 1L,
                    updatedAt = 1L,
                ),
                TransferTaskEntity(
                    id = "orphan-missing",
                    serverOrigin = baseUrl,
                    accountId = "user-1",
                    targetScopeType = "space",
                    targetScopeId = "sp-1",
                    direction = TransferDirection.UPLOAD.name,
                    fileName = "gone.bin",
                    mimeType = "application/octet-stream",
                    totalBytes = 32L,
                    localStagedPath = missingFile.absolutePath,
                    status = TransferStatus.RUNNING.name,
                    createdAt = 2L,
                    updatedAt = 2L,
                ),
            ),
        )

        harness.manager.recoverInterruptedTasks()

        assertEquals(TransferStatus.PAUSED, harness.dao.getById("orphan-alive")?.toStatus())
        assertEquals(TransferStatus.FAILED, harness.dao.getById("orphan-missing")?.toStatus())
        assertTrue(harness.dao.getById("orphan-missing")?.errorMessage.orEmpty().contains("本地临时文件"))
    }

    @Test
    fun speedTracker_computesBytesPerSecondAndEtaDeterministically() {
        var now = 1_000L
        val tracker = TransferSpeedTracker(windowMs = 3_000L, clockMs = { now })

        val m0 = tracker.record(0L, 10_000L)
        assertEquals(0L, m0.speedBytesPerSec)
        assertNull(m0.etaSeconds)

        now = 2_000L
        val m1 = tracker.record(2_000L, 10_000L)
        assertEquals(2_000L, m1.speedBytesPerSec)
        assertEquals(4L, m1.etaSeconds)

        now = 3_000L
        val m2 = tracker.record(10_000L, 10_000L)
        assertEquals(5_000L, m2.speedBytesPerSec)
        assertEquals(0L, m2.etaSeconds)
    }

    @Test
    fun cancellationDuringUpload_persistsPausedStatusEvenWithCancellationAwareDao() = runTest {
        val chunkPutStarted = CountDownLatch(1)
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.path.orEmpty()
                return when {
                    request.method == "POST" && path == "/api/spaces/sp-1/uploads" ->
                        MockResponse()
                            .setResponseCode(201)
                            .setBody("""{"uploadId":"up-cancel-coro","chunkSize":512,"expiresAt":${System.currentTimeMillis() + 60_000},"received":[]}""")
                    request.method == "PUT" && path.startsWith("/api/spaces/sp-1/uploads/up-cancel-coro/chunks/") -> {
                        chunkPutStarted.countDown()
                        // Hold the chunk response long enough for cancellation to occur mid-flight.
                        MockResponse()
                            .setResponseCode(204)
                            .setHeadersDelay(5, TimeUnit.SECONDS)
                    }
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }

        val backingDao = InMemoryTransferDao()
        val roomLikeDao = CancellationAwareTransferDao(backingDao)
        val engine = TransferEngine(
            apiClient = createApiClient(),
            dao = roomLikeDao,
            downloadSink = createDownloadSink(),
            downloadTempDir = downloadTempDir,
            ownedStagingRoots = listOf(uploadStagingDir, shareStagingDir, downloadTempDir),
            chunkConcurrency = 1,
            maxRetries = 0,
            sleepMs = {},
        )

        val stagedFile = File(uploadStagingDir, "coro/big.bin").apply {
            parentFile?.mkdirs()
            writeBytes(ByteArray(1024) { 3 })
        }
        backingDao.upsert(
            TransferTaskEntity(
                id = "task-coro-cancel",
                serverOrigin = baseUrl,
                accountId = "user-1",
                targetScopeType = "space",
                targetScopeId = "sp-1",
                direction = TransferDirection.UPLOAD.name,
                fileName = "big.bin",
                mimeType = "application/octet-stream",
                totalBytes = 1024L,
                localStagedPath = stagedFile.absolutePath,
                status = TransferStatus.QUEUED.name,
                createdAt = 1L,
                updatedAt = 1L,
            ),
        )

        val job = launch(Dispatchers.IO) {
            engine.executeTask("task-coro-cancel") {}
        }
        assertTrue("Expected chunk PUT to start before cancelling", chunkPutStarted.await(5, TimeUnit.SECONDS))
        job.cancel()
        job.join()

        // NonCancellable cleanup must succeed even though roomLikeDao checks coroutineContext.isActive!
        val updated = backingDao.getById("task-coro-cancel")!!
        assertEquals(TransferStatus.PAUSED, updated.toStatus())
        assertEquals("up-cancel-coro", updated.remoteUploadId)
    }

    @Test
    fun liveInChunkProgressAndConcurrentMetrics_mergeTransferredBytesWithoutLosingUpdates() = runTest {
        val harness = createHarness()
        val taskIds = (1..8).map { "live-task-$it" }
        harness.dao.upsertAll(
            taskIds.mapIndexed { idx, id ->
                TransferTaskEntity(
                    id = id,
                    serverOrigin = baseUrl,
                    accountId = "user-1",
                    targetScopeType = "space",
                    targetScopeId = "sp-1",
                    direction = TransferDirection.UPLOAD.name,
                    fileName = "chunk-$idx.bin",
                    mimeType = "application/octet-stream",
                    totalBytes = 10_000L,
                    transferredBytes = 0L,
                    status = TransferStatus.RUNNING.name,
                    createdAt = idx.toLong(),
                    updatedAt = idx.toLong(),
                )
            },
        )

        // Update 8 tasks concurrently across threads and verify atomic StateFlow.update loses zero entries.
        withContext(Dispatchers.Default) {
            taskIds.mapIndexed { idx, id ->
                async {
                    repeat(50) { step ->
                        val bytes = ((idx + 1) * 100 + step * 10).toLong()
                        harness.manager.updateMetrics(
                            id,
                            TransferRuntimeMetrics(
                                transferredBytes = bytes,
                                speedBytesPerSec = 2_000L + idx,
                                etaSeconds = 5L,
                            ),
                        )
                    }
                }
            }.awaitAll()
        }

        val observed = harness.manager.tasks.first { list ->
            list.size == taskIds.size && list.all { it.transferredBytes > 0L }
        }.associateBy { it.id }

        taskIds.forEachIndexed { idx, id ->
            val task = observed[id]!!
            val expectedBytes = ((idx + 1) * 100 + 49 * 10).toLong()
            assertEquals(expectedBytes, task.transferredBytes)
            assertEquals(2_000L + idx, task.speedBytesPerSec)
            assertEquals(5L, task.etaSeconds)
        }

        // Clamps to totalBytes even if live metric slightly exceeds totalBytes.
        harness.manager.updateMetrics(
            taskIds.first(),
            TransferRuntimeMetrics(transferredBytes = 99_999L, speedBytesPerSec = 5_000L, etaSeconds = 0L),
        )
        val clamped = harness.manager.tasks.first { list ->
            list.first { it.id == taskIds.first() }.transferredBytes == 10_000L
        }.first { it.id == taskIds.first() }
        assertEquals(10_000L, clamped.transferredBytes)
    }

    @Test
    fun savedDownloadIndex_survivesClearCompleted_isolatesScopes_dedupsActive_autoCleansDeleted_andOverwritesOnRedownload() = runTest {
        var now = 1_000L
        val payload = "saved-file-v1-content".toByteArray()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                return if (request.path == "/api/spaces/sp-1/items/item-save/download") {
                    MockResponse()
                        .setResponseCode(200)
                        .addHeader("Content-Disposition", "attachment; filename=\"manual.pdf\"")
                        .addHeader("Content-Type", "application/pdf")
                        .setBody(Buffer().write(payload))
                } else {
                    MockResponse().setResponseCode(404)
                }
            }
        }

        val harness = createHarness(
            initialScope = TransferScopeKey(baseUrl, "user-A"),
            clockMs = { now },
        )
        val item = ClipItem(
            id = "item-save",
            spaceId = "sp-1",
            kind = "file",
            filename = "manual.pdf",
            mime = "application/pdf",
            size = payload.size.toLong(),
        )

        // 1. Enqueue download -> second tap while QUEUED returns AlreadyInProgress without creating duplicate task
        val firstRes = harness.manager.enqueueDownloadOrReuse(
            DownloadFileRequest(item = item, targetScope = TargetScope.SpaceScope("sp-1")),
        )
        assertTrue(firstRes is DownloadEnqueueResult.Started)
        assertEquals(setOf("item-save"), harness.manager.activeDownloadItemIds.first { it.contains("item-save") })

        val dupRes = harness.manager.enqueueDownloadOrReuse(
            DownloadFileRequest(item = item, targetScope = TargetScope.SpaceScope("sp-1")),
        )
        assertEquals(DownloadEnqueueResult.AlreadyInProgress(firstRes.taskId), dupRes)
        assertEquals(1, harness.dao.listAll().size)

        // 2. Execute download -> writes to saved_downloads and clears activeDownloadItemIds
        now = 2_000L
        assertEquals(TransferExecutionOutcome.Succeeded, harness.manager.executeTaskFromWorker(firstRes.taskId))
        val savedMap = harness.manager.savedDownloads.first { it.containsKey("item-save") }
        val firstRecord = savedMap["item-save"]!!
        assertEquals("manual.pdf", firstRecord.fileName)
        assertEquals("application/pdf", firstRecord.mimeType)
        assertEquals(payload.size.toLong(), firstRecord.fileSize)
        assertEquals(2_000L, firstRecord.savedAt)
        assertTrue(harness.manager.activeDownloadItemIds.first { it.isEmpty() }.isEmpty())

        // Share-after-download task must NOT pollute saved_downloads
        val shareTaskId = harness.manager.enqueueDownload(
            DownloadFileRequest(
                item = item.copy(id = "item-share-only"),
                targetScope = TargetScope.SpaceScope("sp-1"),
                shareAfterDownload = true,
            ),
        )
        assertNull(harness.dao.getSavedDownload(baseUrl, "user-A", "item-share-only"))
        assertNotNull(shareTaskId)

        // 3. clearCompleted wipes transfer_tasks history, but saved_downloads remains intact!
        harness.manager.clearCompleted()
        assertTrue(harness.dao.listByScope(baseUrl, "user-A").none { it.status == TransferStatus.SUCCEEDED.name })
        assertNotNull(harness.manager.verifySavedDownload("item-save"))
        assertTrue(harness.manager.savedDownloads.value.containsKey("item-save"))

        // 4. Cross-account and cross-server isolation
        harness.scopeFlow.value = TransferScopeKey(baseUrl, "user-B")
        assertTrue(harness.manager.savedDownloads.first { it.isEmpty() }.isEmpty())
        harness.scopeFlow.value = TransferScopeKey("https://other-server.example", "user-A")
        assertTrue(harness.manager.savedDownloads.value.isEmpty())

        // Switch back to (baseUrl, user-A) -> saved record still visible
        harness.scopeFlow.value = TransferScopeKey(baseUrl, "user-A")
        assertTrue(harness.manager.savedDownloads.first { it.containsKey("item-save") }.containsKey("item-save"))

        // 5. Force redownload creates a new file and overwrites/updates saved_downloads index
        now = 5_000L
        val redownloadRes = harness.manager.enqueueDownloadOrReuse(
            DownloadFileRequest(item = item, targetScope = TargetScope.SpaceScope("sp-1")),
        )
        assertTrue(redownloadRes is DownloadEnqueueResult.Started)
        assertEquals(TransferExecutionOutcome.Succeeded, harness.manager.executeTaskFromWorker(redownloadRes.taskId))
        val updatedRecord = harness.manager.savedDownloads.first { it["item-save"]?.savedAt == 5_000L }["item-save"]!!
        assertTrue("Expected new local URI after redownload", updatedRecord.localUri != firstRecord.localUri)
        assertEquals(5_000L, updatedRecord.savedAt)

        // 6. Deleting local file externally -> verifySavedDownload / verifyAllSavedDownloads cleans stale row
        val savedFile = FileSystemLocalSavedFileChecker.resolveLocalFile(updatedRecord.localUri)!!
        assertTrue(savedFile.delete())
        assertNull(harness.manager.verifySavedDownload("item-save"))
        assertTrue(harness.manager.savedDownloads.first { !it.containsKey("item-save") }.isEmpty())
        assertNull(harness.dao.getSavedDownload(baseUrl, "user-A", "item-save"))
    }

    @Test
    fun verifyAllSavedDownloads_prunesMissingOrSizeMismatchedEntries() = runTest {
        val validFile = File(savedDownloadsDir, "valid.bin").apply { writeBytes(ByteArray(64) { 1 }) }
        val truncatedFile = File(savedDownloadsDir, "truncated.bin").apply { writeBytes(ByteArray(10) { 2 }) }
        val missingFile = File(savedDownloadsDir, "deleted.bin")

        val harness = createHarness(initialScope = TransferScopeKey(baseUrl, "user-1"))
        harness.dao.upsertSavedDownload(
            SavedDownloadEntity(baseUrl, "user-1", "it-valid", "file://${validFile.absolutePath}", "valid.bin", "application/octet-stream", 64L, 100L),
        )
        harness.dao.upsertSavedDownload(
            SavedDownloadEntity(baseUrl, "user-1", "it-trunc", "file://${truncatedFile.absolutePath}", "truncated.bin", "application/octet-stream", 64L, 200L),
        )
        harness.dao.upsertSavedDownload(
            SavedDownloadEntity(baseUrl, "user-1", "it-gone", "file://${missingFile.absolutePath}", "deleted.bin", "application/octet-stream", 64L, 300L),
        )

        harness.manager.verifyAllSavedDownloads()

        val remaining = harness.manager.savedDownloads.first { it.size == 1 }
        assertEquals(setOf("it-valid"), remaining.keys)
    }

    private fun sha256Hex(bytes: ByteArray): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(bytes)
        return digest.joinToString("") { String.format(Locale.ROOT, "%02x", it.toInt() and 0xff) }
    }

    private data class TestHarness(
        val dao: InMemoryTransferDao,
        val scopeFlow: MutableStateFlow<TransferScopeKey?>,
        val scheduler: FakeWorkScheduler,
        val engine: TransferEngine,
        val manager: DefaultTransferManager,
    )

    private class FakeWorkScheduler : TransferWorkScheduler {
        val enqueued = CopyOnWriteArrayList<String>()
        val cancelled = CopyOnWriteArrayList<String>()
        var cancelledAll: Boolean = false

        override fun enqueue(taskId: String) {
            enqueued.add(taskId)
        }

        override fun cancel(taskId: String) {
            cancelled.add(taskId)
        }

        override fun cancelAll() {
            cancelledAll = true
        }

        override suspend fun isWorkActive(taskId: String): Boolean = false
    }
}

/**
 * In-memory implementation of Room [TransferDao] mirroring SQL scope-isolation semantics
 * for deterministic JVM unit tests.
 */
internal class InMemoryTransferDao : TransferDao {
    private val state = MutableStateFlow<Map<String, TransferTaskEntity>>(emptyMap())

    override fun observeByScope(serverOrigin: String, accountId: String?): Flow<List<TransferTaskEntity>> =
        state.map { map ->
            map.values
                .filter { it.serverOrigin == serverOrigin && it.accountId == accountId }
                .sortedWith(compareByDescending<TransferTaskEntity> { it.createdAt }.thenByDescending { it.id })
        }

    override suspend fun listByScope(serverOrigin: String, accountId: String?): List<TransferTaskEntity> =
        state.value.values
            .filter { it.serverOrigin == serverOrigin && it.accountId == accountId }
            .sortedWith(compareByDescending<TransferTaskEntity> { it.createdAt }.thenByDescending { it.id })

    override suspend fun listAll(): List<TransferTaskEntity> =
        state.value.values.sortedWith(compareByDescending<TransferTaskEntity> { it.createdAt }.thenByDescending { it.id })

    override suspend fun getById(id: String): TransferTaskEntity? = state.value[id]

    override suspend fun listByStatus(status: String): List<TransferTaskEntity> =
        state.value.values.filter { it.status == status }

    override suspend fun upsert(entity: TransferTaskEntity) {
        state.value = state.value + (entity.id to entity)
    }

    override suspend fun upsertAll(entities: List<TransferTaskEntity>) {
        state.value = state.value + entities.associateBy { it.id }
    }

    override suspend fun updateStatus(id: String, status: String, errorMessage: String?, updatedAt: Long) {
        val cur = state.value[id] ?: return
        state.value = state.value + (id to cur.copy(status = status, errorMessage = errorMessage, updatedAt = updatedAt))
    }

    override suspend fun updateUploadSession(
        id: String,
        remoteUploadId: String?,
        chunkSize: Int,
        completedChunks: String,
        transferredBytes: Long,
        updatedAt: Long,
    ) {
        val cur = state.value[id] ?: return
        state.value = state.value + (
            id to cur.copy(
                remoteUploadId = remoteUploadId,
                chunkSize = chunkSize,
                completedChunks = completedChunks,
                transferredBytes = transferredBytes,
                updatedAt = updatedAt,
            )
            )
    }

    override suspend fun updateProgress(
        id: String,
        transferredBytes: Long,
        completedChunks: String,
        updatedAt: Long,
    ) {
        val cur = state.value[id] ?: return
        state.value = state.value + (
            id to cur.copy(
                transferredBytes = transferredBytes,
                completedChunks = completedChunks,
                updatedAt = updatedAt,
            )
            )
    }

    override suspend fun updateFileMetadata(
        id: String,
        fileName: String,
        mimeType: String,
        totalBytes: Long,
        updatedAt: Long,
    ) {
        val cur = state.value[id] ?: return
        state.value = state.value + (
            id to cur.copy(
                fileName = fileName,
                mimeType = mimeType,
                totalBytes = totalBytes,
                updatedAt = updatedAt,
            )
            )
    }

    override suspend fun markSucceeded(
        id: String,
        status: String,
        transferredBytes: Long,
        localResultUri: String?,
        updatedAt: Long,
    ) {
        val cur = state.value[id] ?: return
        state.value = state.value + (
            id to cur.copy(
                status = status,
                transferredBytes = transferredBytes,
                localResultUri = localResultUri,
                remoteUploadId = null,
                localStagedPath = null,
                errorMessage = null,
                updatedAt = updatedAt,
            )
            )
    }

    override suspend fun reassignAccountId(
        serverOrigin: String,
        oldAccountId: String,
        newAccountId: String,
        updatedAt: Long,
    ) {
        state.value = state.value.mapValues { (_, entity) ->
            if (entity.serverOrigin == serverOrigin && entity.accountId == oldAccountId) {
                entity.copy(accountId = newAccountId, updatedAt = updatedAt)
            } else {
                entity
            }
        }
    }

    override suspend fun deleteCompletedForScope(serverOrigin: String, accountId: String?) {
        state.value = state.value.filterValues { entity ->
            !(entity.serverOrigin == serverOrigin &&
                entity.accountId == accountId &&
                (entity.status == TransferStatus.SUCCEEDED.name || entity.status == TransferStatus.CANCELLED.name))
        }
    }

    override suspend fun deleteByScope(serverOrigin: String, accountId: String?) {
        state.value = state.value.filterValues { entity ->
            !(entity.serverOrigin == serverOrigin && entity.accountId == accountId)
        }
    }

    override suspend fun deleteById(id: String) {
        state.value = state.value - id
    }

    override suspend fun deleteAll() {
        state.value = emptyMap()
    }

    private val savedState = MutableStateFlow<Map<Triple<String, String, String>, SavedDownloadEntity>>(emptyMap())

    override suspend fun findActiveDownloadForItem(
        serverOrigin: String,
        accountId: String?,
        remoteItemId: String,
    ): TransferTaskEntity? = state.value.values
        .filter {
            it.serverOrigin == serverOrigin &&
                it.accountId == accountId &&
                it.direction == TransferDirection.DOWNLOAD.name &&
                !it.shareAfterDownload &&
                it.remoteItemId == remoteItemId &&
                (it.status == TransferStatus.QUEUED.name || it.status == TransferStatus.RUNNING.name)
        }
        .sortedWith(compareByDescending<TransferTaskEntity> { it.createdAt }.thenByDescending { it.id })
        .firstOrNull()

    override fun observeSavedDownloadsByScope(serverOrigin: String, accountId: String): Flow<List<SavedDownloadEntity>> =
        savedState.map { map ->
            map.values
                .filter { it.serverOrigin == serverOrigin && it.accountId == accountId }
                .sortedWith(compareByDescending<SavedDownloadEntity> { it.savedAt }.thenBy { it.remoteItemId })
        }

    override suspend fun listSavedDownloadsByScope(serverOrigin: String, accountId: String): List<SavedDownloadEntity> =
        savedState.value.values
            .filter { it.serverOrigin == serverOrigin && it.accountId == accountId }
            .sortedWith(compareByDescending<SavedDownloadEntity> { it.savedAt }.thenBy { it.remoteItemId })

    override suspend fun listAllSavedDownloads(): List<SavedDownloadEntity> =
        savedState.value.values
            .sortedWith(compareByDescending<SavedDownloadEntity> { it.savedAt }.thenBy { it.remoteItemId })

    override suspend fun getSavedDownload(serverOrigin: String, accountId: String, remoteItemId: String): SavedDownloadEntity? =
        savedState.value[Triple(serverOrigin, accountId, remoteItemId)]

    override suspend fun upsertSavedDownload(entity: SavedDownloadEntity) {
        savedState.value = savedState.value + (Triple(entity.serverOrigin, entity.accountId, entity.remoteItemId) to entity)
    }

    override suspend fun deleteSavedDownload(serverOrigin: String, accountId: String, remoteItemId: String) {
        savedState.value = savedState.value - Triple(serverOrigin, accountId, remoteItemId)
    }

    override suspend fun deleteSavedDownloadsByScope(serverOrigin: String, accountId: String) {
        savedState.value = savedState.value.filterValues {
            !(it.serverOrigin == serverOrigin && it.accountId == accountId)
        }
    }

    override suspend fun deleteAllSavedDownloads() {
        savedState.value = emptyMap()
    }

    override suspend fun reassignSavedDownloadsAccountId(
        serverOrigin: String,
        oldAccountId: String,
        newAccountId: String,
    ) {
        val next = LinkedHashMap<Triple<String, String, String>, SavedDownloadEntity>()
        savedState.value.values.forEach { entity ->
            val updated = if (entity.serverOrigin == serverOrigin && entity.accountId == oldAccountId) {
                entity.copy(accountId = newAccountId)
            } else {
                entity
            }
            next[Triple(updated.serverOrigin, updated.accountId, updated.remoteItemId)] = updated
        }
        savedState.value = next
    }
}

/**
 * Wraps [TransferDao] with `withContext(Dispatchers.IO) { yield(); ... }` to match real Room's
 * `CoroutinesRoom.execute` behavior that immediately throws [CancellationException] if invoked
 * from a cancelled coroutine without `NonCancellable`.
 */
internal class CancellationAwareTransferDao(
    private val delegate: TransferDao,
) : TransferDao by delegate {
    override suspend fun getById(id: String): TransferTaskEntity? = withContext(Dispatchers.IO) {
        yield()
        delegate.getById(id)
    }

    override suspend fun updateStatus(id: String, status: String, errorMessage: String?, updatedAt: Long) =
        withContext(Dispatchers.IO) {
            yield()
            delegate.updateStatus(id, status, errorMessage, updatedAt)
        }
}
