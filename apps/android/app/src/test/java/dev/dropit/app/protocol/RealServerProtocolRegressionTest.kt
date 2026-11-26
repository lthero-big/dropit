package dev.dropit.app.protocol

import android.content.Intent
import dev.dropit.app.core.auth.AccountCapabilityState
import dev.dropit.app.core.auth.AuthRepository
import dev.dropit.app.core.auth.DefaultAuthRepository
import dev.dropit.app.core.auth.DevicePollOutcome
import dev.dropit.app.core.auth.InMemorySettingsStore
import dev.dropit.app.core.auth.InMemoryTokenVault
import dev.dropit.app.core.auth.OAuthCallbackParser
import dev.dropit.app.core.auth.OAuthLoginResult
import dev.dropit.app.core.network.ApiError
import dev.dropit.app.core.network.ApiErrorCode
import dev.dropit.app.core.network.DropitApiClient
import dev.dropit.app.core.network.OptionalField
import dev.dropit.app.core.network.ServerUrl
import dev.dropit.app.core.network.SessionCredentialsProvider
import dev.dropit.app.core.network.TargetScope
import dev.dropit.app.core.network.UploadSession
import dev.dropit.app.core.realtime.ConnectionState
import dev.dropit.app.core.realtime.RealtimeClient
import dev.dropit.app.core.repository.DefaultBoardRepository
import dev.dropit.app.core.repository.DefaultSpaceRepository
import dev.dropit.app.core.repository.TransferDirection
import dev.dropit.app.core.repository.TransferStatus
import dev.dropit.app.core.repository.UpdateCheckResult
import dev.dropit.app.core.repository.UpdateInstallState
import dev.dropit.app.data.account.DefaultAccountSettingsRepository
import dev.dropit.app.data.itemshare.DefaultItemShareRepository
import dev.dropit.app.data.media.DefaultMediaRepository
import dev.dropit.app.data.room.DefaultRoomRepository
import dev.dropit.app.data.room.InMemoryRoomKeyStore
import dev.dropit.app.data.transfer.DownloadName
import dev.dropit.app.data.transfer.DownloadSink
import dev.dropit.app.data.transfer.SavedDownloadEntity
import dev.dropit.app.data.transfer.SavedDownloadResult
import dev.dropit.app.data.transfer.TransferDao
import dev.dropit.app.data.transfer.TransferEngine
import dev.dropit.app.data.transfer.TransferExecutionOutcome
import dev.dropit.app.data.transfer.TransferTaskEntity
import dev.dropit.app.data.update.ApkInstaller
import dev.dropit.app.data.update.DefaultAppUpdater
import dev.dropit.app.data.update.UpdateFiles
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.DataOutputStream
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.file.Files
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.TimeUnit
import java.util.zip.CRC32
import java.util.zip.Deflater

/**
 * End-to-end protocol contract regression suite executed against a real local dropit Node server
 * (`apps/server`, never touching production).
 *
 * Activated when `DROPIT_LIVE_SERVER_URL` is set (and mandatory in CI via
 * `DROPIT_REQUIRE_LIVE_SERVER=1`). Verifies every native Kotlin client protocol flow:
 * 1. `/api/version`, device code authorization & polling (`slow_down`, `authorization_pending`,
 *    `access_denied`, `200 access_token`), Bearer auth & 401 revocation (HTTP + WS).
 * 2. `/api/me`, `/api/spaces`, text CRUD/pin/tags/group/retract, groups CRUD.
 * 3. `/api/spaces/:space/ws` & `/api/rooms/:room/ws` authoritative snapshot + incremental events.
 * 4. `/uploads` multi-chunk parallel upload, `GET /uploads/:id` resumable query, `DELETE /uploads/:id`
 *    cancel & quota release, and streaming large-file round-trip SHA-256 verification.
 * 5. `/download` RFC 5987 Chinese filename decoding (`+` preserved) + Range 206 resume, `/thumbnail`
 *    & `/preview` WebP rendering, `/media` Range 206/416 audio streaming, and bounded text preview.
 * 6. `/api/rooms` create/reuse/enter (`401 PIN_REQUIRED` without logout, `403 PIN_INVALID`, `200`),
 *    `PUT /api/rooms/:room/code`, and per-item shares `/items/:id/shares` CRUD + public `/s/` & `/d/`.
 * 7. `/api/app/android/latest` & `/api/app/android/download/<file>.apk` SHA-256 verification.
 */
class RealServerProtocolRegressionTest {

    private val liveServerUrl: String? = System.getenv("DROPIT_LIVE_SERVER_URL")?.trim()?.trimEnd('/')?.takeIf { it.isNotEmpty() }
    private val requireLiveServer: Boolean = System.getenv("DROPIT_REQUIRE_LIVE_SERVER") == "1"
    private val adminEmail: String = System.getenv("DROPIT_LIVE_ADMIN_EMAIL")?.trim()?.takeIf { it.isNotEmpty() }
        ?: "regression@dropit.test"
    private val adminPassword: String = System.getenv("DROPIT_LIVE_ADMIN_PASSWORD")?.takeIf { it.isNotEmpty() }
        ?: "DropitRegressionPass2026!"
    private val expectedUpdateVersion: String = System.getenv("DROPIT_LIVE_EXPECTED_UPDATE_VERSION")?.trim()?.takeIf { it.isNotEmpty() }
        ?: "0.4.3"
    private val expectedUpdateCode: Int = System.getenv("DROPIT_LIVE_EXPECTED_UPDATE_CODE")?.trim()?.toIntOrNull()
        ?: 9
    private val expectedUpdateSha256: String? = System.getenv("DROPIT_LIVE_EXPECTED_UPDATE_SHA256")?.trim()?.lowercase()?.takeIf { it.isNotEmpty() }

    private lateinit var okHttpClient: OkHttpClient
    private lateinit var tempRoot: File
    private lateinit var realtimeScope: CoroutineScope

    @Before
    fun setUp() {
        if (requireLiveServer) {
            assertNotNull("DROPIT_LIVE_SERVER_URL must be set when DROPIT_REQUIRE_LIVE_SERVER=1", liveServerUrl)
        } else {
            assumeTrue("Skipping live dropit server regression test (DROPIT_LIVE_SERVER_URL not set)", liveServerUrl != null)
        }
        okHttpClient = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .build()
        tempRoot = Files.createTempDirectory("dropit-live-protocol-regression").toFile()
        realtimeScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    }

    @After
    fun tearDown() {
        if (::realtimeScope.isInitialized) realtimeScope.cancel()
        if (::okHttpClient.isInitialized) {
            okHttpClient.dispatcher.executorService.shutdown()
            okHttpClient.connectionPool.evictAll()
        }
        if (::tempRoot.isInitialized) tempRoot.deleteRecursively()
    }

    @Test
    fun fullEndToEndProtocolRegressionAgainstRealDropitServer() = runBlocking {
        val origin = requireNotNull(liveServerUrl)
        val settingsStore = InMemorySettingsStore()
        val tokenVault = InMemoryTokenVault()
        val deviceId = "and-LiveProtoReg202601"
        val deviceName = "dropit Android · ProtocolTest"
        settingsStore.setDeviceId(deviceId)

        val credentialsProvider = object : SessionCredentialsProvider {
            override suspend fun serverOrigin(): String? = settingsStore.getServerOrigin()
            override suspend fun accessToken(): String? = tokenVault.getToken()
            override suspend fun deviceId(): String = settingsStore.getOrCreateDeviceId()
            override fun deviceName(): String = deviceName
        }

        val apiClient = DropitApiClient(
            okHttpClient = okHttpClient,
            credentialsProvider = credentialsProvider,
            allowInsecureHttpForTest = true,
        )
        val authRepo = DefaultAuthRepository(
            apiClient = apiClient,
            settingsStore = settingsStore,
            tokenVault = tokenVault,
            deviceNameProvider = { deviceName },
        )
        val spaceRepo = DefaultSpaceRepository(apiClient)
        val boardRepo = DefaultBoardRepository(apiClient)
        val roomKeyStore = InMemoryRoomKeyStore()
        val roomRepo = DefaultRoomRepository(apiClient, roomKeyStore, settingsStore)
        val itemShareRepo = DefaultItemShareRepository(apiClient)
        val imageCacheDir = File(tempRoot, "image_cache").apply { mkdirs() }
        val mediaRepo = DefaultMediaRepository(
            context = null,
            baseOkHttpClient = okHttpClient,
            apiClient = apiClient,
            credentialsProvider = credentialsProvider,
            imageCacheDir = imageCacheDir,
        )
        val dao = InMemoryTransferDao()
        val savedDownloadsDir = File(tempRoot, "downloads").apply { mkdirs() }
        val shareCacheDir = File(tempRoot, "share_cache").apply { mkdirs() }
        val downloadTempDir = File(tempRoot, "download_temp").apply { mkdirs() }
        val uploadStagingDir = File(tempRoot, "upload_staging").apply { mkdirs() }
        val downloadSink = LocalTestDownloadSink(savedDownloadsDir, shareCacheDir)
        val transferEngine = TransferEngine(
            apiClient = apiClient,
            dao = dao,
            downloadSink = downloadSink,
            downloadTempDir = downloadTempDir,
            ownedStagingRoots = listOf(uploadStagingDir, downloadTempDir),
            chunkConcurrency = 3,
        )

        // ------------------------------------------------------------------
        // 1. /api/version verification & device code authorization / polling
        // ------------------------------------------------------------------
        val verified = authRepo.verifyAndSaveServer(origin)
        assertEquals(origin, verified.serverOrigin)
        assertTrue(ServerUrl.isDropitVersion(verified.versionInfo))

        val browserCookie = signInBrowserAdmin(origin, adminEmail, adminPassword)

        // Create 4 concurrent device auth requests so a single 5.2s interval wait exercises
        // slow_down, access_denied, authorization_pending, and approved token exchange.
        val slowDownAuth = authRepo.startDeviceAuthorization(origin, AuthRepository.DEFAULT_SCOPES)
        val deniedAuth = authRepo.startDeviceAuthorization(origin, AuthRepository.DEFAULT_SCOPES)
        val pendingAuth = authRepo.startDeviceAuthorization(origin, AuthRepository.DEFAULT_SCOPES)
        val approvedAuth = authRepo.startDeviceAuthorization(origin, AuthRepository.DEFAULT_SCOPES)

        assertTrue(approvedAuth.userCode.contains('-'))
        assertTrue(approvedAuth.verificationUriComplete.startsWith("$origin/device?"))

        // Immediate poll before interval -> real server answers 400 slow_down
        assertEquals(DevicePollOutcome.SlowDown, authRepo.pollDeviceTokenOnce(origin, slowDownAuth.deviceCode))

        // Browser denies deniedAuth -> immediate poll returns access_denied
        decideDeviceAuth(origin, browserCookie, decision = "deny", userCode = deniedAuth.userCode, verificationId = deniedAuth.verificationId)
        assertEquals(DevicePollOutcome.Denied, authRepo.pollDeviceTokenOnce(origin, deniedAuth.deviceCode))

        // Browser approves approvedAuth; leave pendingAuth pending; wait one real 5s poll window
        decideDeviceAuth(origin, browserCookie, decision = "approve", userCode = approvedAuth.userCode, verificationId = approvedAuth.verificationId)
        delay((approvedAuth.interval * 1000L) + 350L)

        assertEquals(DevicePollOutcome.Pending, authRepo.pollDeviceTokenOnce(origin, pendingAuth.deviceCode))

        val tokenOutcome = authRepo.pollDeviceTokenOnce(origin, approvedAuth.deviceCode)
        assertTrue("Expected approved token outcome, got $tokenOutcome", tokenOutcome is DevicePollOutcome.Token)
        val accessToken = (tokenOutcome as DevicePollOutcome.Token).accessToken
        assertTrue(accessToken.length == 43)
        authRepo.completeAuthorization(origin, accessToken)
        assertTrue(authRepo.sessionState.value.isSignedIn)

        // ------------------------------------------------------------------
        // 2. /api/me, /api/spaces, space WebSocket snapshot + incremental events,
        //    text CRUD / edit / pin / tags / groups / retract
        // ------------------------------------------------------------------
        val me = spaceRepo.getMe()
        assertEquals(adminEmail, me.user.email)
        val spaces = spaceRepo.getSpaces()
        val personalSpace = spaceRepo.pickDefaultSpace(spaces, me.user.id)
        assertNotNull("Expected user personal space", personalSpace)
        val spaceScope = TargetScope.SpaceScope(personalSpace!!.id)
        val spaceDetails = spaceRepo.getScopeDetails(spaceScope)
        assertEquals(personalSpace.id, spaceDetails.id)
        assertTrue(spaceDetails.maxFileBytes > 0L)

        val spaceRealtime = RealtimeClient(
            okHttpClient = okHttpClient,
            credentialsProvider = credentialsProvider,
            scope = realtimeScope,
            onUnauthorized = { errOrigin, path -> apiClient.emitSessionExpiredIf401(401, errOrigin, path) },
            allowInsecureHttpForTest = true,
        )
        spaceRealtime.connect(spaceScope)
        withTimeout(10_000L) {
            spaceRealtime.connectionState.first { it == ConnectionState.CONNECTED }
            spaceRealtime.boardState.first { it.hasSnapshot }
        }
        val presenceState = withTimeout(10_000L) {
            spaceRealtime.boardState.first { state -> state.peers.any { it.id == deviceId } }
        }
        assertTrue(presenceState.presenceDevices >= 1)
        assertEquals("phone", presenceState.peers.first { it.id == deviceId }.kind)

        // Group creation -> WS groups event
        val groupsAfterCreate = boardRepo.createGroup(spaceScope, "回归分组")
        assertTrue("回归分组" in groupsAfterCreate)
        withTimeout(10_000L) {
            spaceRealtime.boardState.first { "回归分组" in it.groups }
        }

        // Text item create -> edit -> labels (pin, tags, group clear) -> WS sync
        val createdText = boardRepo.createText(spaceScope, "初始协议回归文本", group = "回归分组")
        assertEquals("text", createdText.kind)
        assertEquals("初始协议回归文本", createdText.text)
        assertEquals("回归分组", createdText.group)
        assertEquals(deviceId, createdText.device?.id)
        withTimeout(10_000L) {
            spaceRealtime.boardState.first { state -> state.items.any { it.id == createdText.id } }
        }

        val editedText = boardRepo.editText(spaceScope, createdText.id, "更新后的协议回归文本\n第二行内容")
        assertEquals("更新后的协议回归文本\n第二行内容", editedText.text)
        val labeledText = boardRepo.updateLabels(
            scope = spaceScope,
            itemId = createdText.id,
            pinned = true,
            tags = listOf("回归", "Kotlin"),
            group = OptionalField.Present(null),
        )
        assertTrue(labeledText.pinned)
        assertEquals(listOf("回归", "Kotlin"), labeledText.tags)
        assertNull(labeledText.group)
        withTimeout(10_000L) {
            spaceRealtime.boardState.first { state ->
                val item = state.items.firstOrNull { it.id == createdText.id }
                item != null && item.pinned && item.tags == listOf("回归", "Kotlin") && item.group == null
            }
        }

        // Inline text preview falls back cleanly to snapshot when /download returns 404
        val inlinePreview = mediaRepo.fetchTextPreview(spaceScope, createdText.id, maxBytes = 64)
        assertTrue(inlinePreview.text.contains("更新后的协议回归文本"))

        // Group rename & delete
        val groupsAfterRename = boardRepo.renameGroup(spaceScope, "回归分组", "回归分组B")
        assertTrue("回归分组B" in groupsAfterRename)
        val groupsAfterDelete = boardRepo.deleteGroup(spaceScope, "回归分组B")
        assertFalse("回归分组B" in groupsAfterDelete)

        // ------------------------------------------------------------------
        // 3. /uploads multi-chunk parallel upload, resumable GET query,
        //    DELETE cancel & quota release, and large streaming round-trip
        // ------------------------------------------------------------------
        // Server runs with UPLOAD_CHUNK_BYTES=65536; 160 KiB = 3 chunks (64K + 64K + 32K)
        val largeBytes = ByteArray(160 * 1024) { idx -> ((idx * 31 + 17) and 0xFF).toByte() }
        val largeFile = File(uploadStagingDir, "large-stream.bin").apply { writeBytes(largeBytes) }
        val expectedLargeSha = sha256Hex(largeBytes)

        // 3a. Open an upload session manually and upload chunk 0, then verify GET /uploads/:id
        // reports received=[0], and hand the session to TransferEngine to resume remaining chunks.
        val createSessionReq = Request.Builder()
            .url("$origin${spaceScope.apiBasePath}/uploads")
            .post(
                """{"filename":"大文件分片+断点续传 (终版).bin","size":${largeBytes.size},"mime":"application/octet-stream"}"""
                    .toRequestBody(JSON_MEDIA_TYPE),
            )
            .apply {
                for ((k, v) in apiClient.currentHeaders(authenticated = true)) header(k, v)
            }
            .build()
        val createdUpload = apiClient.executeJson(createSessionReq, authenticated = true, deserializer = UploadSession.serializer())
        assertTrue(createdUpload.uploadId.isNotBlank())
        assertTrue(createdUpload.chunkSize > 0)
        assertTrue("Expected multi-chunk upload session", largeBytes.size > createdUpload.chunkSize)

        val chunk0 = largeBytes.copyOfRange(0, createdUpload.chunkSize)
        val putChunk0Req = Request.Builder()
            .url("$origin${spaceScope.apiBasePath}/uploads/${createdUpload.uploadId}/chunks/0")
            .put(chunk0.toRequestBody(OCTET_STREAM))
            .header("X-Chunk-Sha256", sha256Hex(chunk0))
            .apply {
                for ((k, v) in apiClient.currentHeaders(authenticated = true)) header(k, v)
            }
            .build()
        apiClient.executeNoContent(putChunk0Req, authenticated = true)

        val querySessionReq = Request.Builder()
            .url("$origin${spaceScope.apiBasePath}/uploads/${createdUpload.uploadId}")
            .get()
            .apply {
                for ((k, v) in apiClient.currentHeaders(authenticated = true)) header(k, v)
            }
            .build()
        val queriedUpload = apiClient.executeJson(querySessionReq, authenticated = true, deserializer = UploadSession.serializer())
        assertEquals(largeBytes.size.toLong(), queriedUpload.size)
        assertEquals(listOf(0), queriedUpload.received)

        // Resume remaining chunks through TransferEngine and complete with X-Dropit-Group
        val nowMs = System.currentTimeMillis()
        val resumeTask = TransferTaskEntity(
            id = "live-upload-resume-${UUID.randomUUID()}",
            serverOrigin = origin,
            accountId = me.user.id,
            targetScopeType = spaceScope.scopeType,
            targetScopeId = spaceScope.scopeId,
            groupName = "传输测试",
            direction = TransferDirection.UPLOAD.name,
            fileName = "大文件分片+断点续传 (终版).bin",
            mimeType = "application/octet-stream",
            totalBytes = largeBytes.size.toLong(),
            remoteUploadId = createdUpload.uploadId,
            chunkSize = createdUpload.chunkSize,
            completedChunks = "0",
            localStagedPath = largeFile.absolutePath,
            status = TransferStatus.QUEUED.name,
            createdAt = nowMs,
            updatedAt = nowMs,
        )
        dao.upsert(resumeTask)
        val uploadOutcome = transferEngine.executeTask(resumeTask.id) { }
        assertEquals(TransferExecutionOutcome.Succeeded, uploadOutcome)

        val largeItem = withTimeout(10_000L) {
            spaceRealtime.boardState.first { state ->
                state.items.any { it.filename == "大文件分片+断点续传 (终版).bin" }
            }.items.first { it.filename == "大文件分片+断点续传 (终版).bin" }
        }
        assertEquals(largeBytes.size.toLong(), largeItem.size)
        assertEquals("传输测试", largeItem.group)

        // 3b. Cancel an active upload session and confirm DELETE /uploads/:id frees reservedBytes
        val cancelCreateReq = Request.Builder()
            .url("$origin${spaceScope.apiBasePath}/uploads")
            .post(
                """{"filename":"待取消上传.bin","size":${largeBytes.size},"mime":"application/octet-stream"}"""
                    .toRequestBody(JSON_MEDIA_TYPE),
            )
            .apply {
                for ((k, v) in apiClient.currentHeaders(authenticated = true)) header(k, v)
            }
            .build()
        val cancelSession = apiClient.executeJson(cancelCreateReq, authenticated = true, deserializer = UploadSession.serializer())
        assertTrue("Reserved bytes should reflect pending upload", spaceRepo.getMe().reservedBytes >= largeBytes.size.toLong())

        val cancelEntity = resumeTask.copy(
            id = "live-upload-cancel-${UUID.randomUUID()}",
            remoteUploadId = cancelSession.uploadId,
            status = TransferStatus.CANCELLED.name,
        )
        transferEngine.cancelRemoteUploadBestEffort(cancelEntity)

        val verifyGoneReq = Request.Builder()
            .url("$origin${spaceScope.apiBasePath}/uploads/${cancelSession.uploadId}")
            .get()
            .apply {
                for ((k, v) in apiClient.currentHeaders(authenticated = true)) header(k, v)
            }
            .build()
        try {
            apiClient.executeJson(verifyGoneReq, authenticated = true, deserializer = UploadSession.serializer())
            fail("Expected 404 after DELETE /uploads/:id")
        } catch (e: ApiError) {
            assertEquals(404, e.httpStatus)
        }
        assertEquals(0L, spaceRepo.getMe().reservedBytes)

        // ------------------------------------------------------------------
        // 4. /download RFC 5987 Chinese filename + Range 206 resume
        // ------------------------------------------------------------------
        val partFile = File(downloadTempDir, "dl_resume_live.part")
        // Pre-seed the first 4096 bytes so TransferEngine issues `Range: bytes=4096-` -> 206 Partial Content
        partFile.writeBytes(largeBytes.copyOfRange(0, 4096))

        val downloadTask = TransferTaskEntity(
            id = "live-download-resume-${UUID.randomUUID()}",
            serverOrigin = origin,
            accountId = me.user.id,
            targetScopeType = spaceScope.scopeType,
            targetScopeId = spaceScope.scopeId,
            direction = TransferDirection.DOWNLOAD.name,
            fileName = "fallback.bin",
            mimeType = "application/octet-stream",
            totalBytes = largeBytes.size.toLong(),
            localStagedPath = partFile.absolutePath,
            remoteItemId = largeItem.id,
            status = TransferStatus.QUEUED.name,
            createdAt = nowMs,
            updatedAt = nowMs,
        )
        dao.upsert(downloadTask)
        val downloadOutcome = transferEngine.executeTask(downloadTask.id) { }
        assertEquals(TransferExecutionOutcome.Succeeded, downloadOutcome)
        val savedDownload = downloadSink.lastSystemDownload
        assertNotNull(savedDownload)
        assertEquals("大文件分片+断点续传 (终版).bin", savedDownload!!.first)
        assertEquals(expectedLargeSha, sha256Hex(savedDownload.second.readBytes()))

        // Direct header verification for RFC 5987 Chinese filename
        val dlUrl = mediaRepo.downloadUrl(spaceScope, largeItem.id)
        mediaRepo.mediaOkHttpClient.newCall(Request.Builder().url(dlUrl).header("Range", "bytes=0-15").build()).execute().use { res ->
            assertEquals(206, res.code)
            assertEquals("bytes 0-15/${largeBytes.size}", res.header("Content-Range"))
            assertEquals(
                "大文件分片+断点续传 (终版).bin",
                DownloadName.fromContentDisposition(res.header("Content-Disposition")),
            )
            assertArrayEquals(largeBytes.copyOfRange(0, 16), res.body!!.bytes())
        }

        // ------------------------------------------------------------------
        // 5. /thumbnail, /preview (real PNG -> WebP), /media Range (real WAV),
        //    and bounded Markdown/text file preview
        // ------------------------------------------------------------------
        val pngBytes = createValidPng(width = 32, height = 32)
        val pngItem = uploadViaTransferEngine(
            transferEngine = transferEngine,
            dao = dao,
            stagingDir = uploadStagingDir,
            origin = origin,
            accountId = me.user.id,
            scope = spaceScope,
            fileName = "截图预览_测试.png",
            mimeType = "image/png",
            bytes = pngBytes,
            realtime = spaceRealtime,
        )
        assertTrue("Uploaded PNG must generate a server thumbnail", pngItem.hasThumbnail)

        val thumbUrl = mediaRepo.thumbnailUrl(spaceScope, pngItem.id)
        mediaRepo.mediaOkHttpClient.newCall(Request.Builder().url(thumbUrl).build()).execute().use { res ->
            assertEquals(200, res.code)
            assertEquals("image/webp", res.header("Content-Type"))
            val body = res.body!!.bytes()
            assertWebpMagic(body)
        }

        val previewUrl = mediaRepo.previewUrl(spaceScope, pngItem.id)
        mediaRepo.mediaOkHttpClient.newCall(Request.Builder().url(previewUrl).build()).execute().use { res ->
            assertEquals(200, res.code)
            assertEquals("image/webp", res.header("Content-Type"))
            val body = res.body!!.bytes()
            assertWebpMagic(body)
        }

        // Real WAV audio upload -> /media returns audio/wav with 206 Range and 416 Unsatisfiable
        val wavBytes = createValidWav(pcmPayloadBytes = 4096)
        val wavItem = uploadViaTransferEngine(
            transferEngine = transferEngine,
            dao = dao,
            stagingDir = uploadStagingDir,
            origin = origin,
            accountId = me.user.id,
            scope = spaceScope,
            fileName = "语音备忘录.wav",
            mimeType = "audio/wav",
            bytes = wavBytes,
            realtime = spaceRealtime,
        )
        val mediaUrl = mediaRepo.mediaUrl(spaceScope, wavItem.id)
        mediaRepo.mediaOkHttpClient.newCall(Request.Builder().url(mediaUrl).header("Range", "bytes=0-255").build()).execute().use { res ->
            assertEquals(206, res.code)
            assertEquals("audio/wav", res.header("Content-Type"))
            assertEquals("bytes", res.header("Accept-Ranges"))
            assertEquals("bytes 0-255/${wavBytes.size}", res.header("Content-Range"))
            assertArrayEquals(wavBytes.copyOfRange(0, 256), res.body!!.bytes())
        }
        mediaRepo.mediaOkHttpClient.newCall(Request.Builder().url(mediaUrl).header("Range", "bytes=${wavBytes.size + 10}-").build()).execute().use { res ->
            assertEquals(416, res.code)
            assertEquals("bytes */${wavBytes.size}", res.header("Content-Range"))
        }

        // Uploaded Markdown file -> bounded UTF-8 text preview truncation
        val markdownBytes = ("# 协议回归文档\n\n" + "中文多字节内容验证段落。".repeat(200)).toByteArray(Charsets.UTF_8)
        val mdItem = uploadViaTransferEngine(
            transferEngine = transferEngine,
            dao = dao,
            stagingDir = uploadStagingDir,
            origin = origin,
            accountId = me.user.id,
            scope = spaceScope,
            fileName = "发布说明.md",
            mimeType = "text/markdown",
            bytes = markdownBytes,
            realtime = spaceRealtime,
        )
        val mdPreview = mediaRepo.fetchTextPreview(spaceScope, mdItem.id, maxBytes = 128)
        assertTrue(mdPreview.truncated)
        assertTrue(mdPreview.text.startsWith("# 协议回归文档"))
        assertFalse("UTF-8 truncation must not emit replacement char", mdPreview.text.contains('\uFFFD'))

        // ------------------------------------------------------------------
        // 6. Temporary rooms: create / reuse / enter (PIN_REQUIRED isolated
        //    from global 401 logout, PIN_INVALID, success) / update code & PIN
        //    / room WebSocket snapshot + incremental item sync
        // ------------------------------------------------------------------
        val uniqueRoomCode = "Rm${UUID.randomUUID().toString().replace("-", "").take(6)}"
        val createdRoom = roomRepo.createOrReuseRoom(code = uniqueRoomCode, pin = "2468")
        assertFalse(createdRoom.reused)
        assertEquals(uniqueRoomCode, createdRoom.code)
        assertTrue(createdRoom.hasPin)
        assertTrue(createdRoom.token.contains('.'))
        assertEquals("$origin/r/$uniqueRoomCode", createdRoom.url)

        // Reuse by deviceKey
        val reusedRoom = roomRepo.createOrReuseRoom()
        assertTrue(reusedRoom.reused)
        assertEquals(createdRoom.token, reusedRoom.token)

        // Enter without PIN -> 401 PIN_REQUIRED MUST NOT emit global sessionExpiredEvents
        val unexpectedLogout = mutableListOf<String>()
        val logoutWatcher = async(start = CoroutineStart.UNDISPATCHED) {
            apiClient.sessionExpiredEvents.collect { unexpectedLogout.add(it.path) }
        }
        try {
            roomRepo.enterRoom(code = uniqueRoomCode, pin = null)
            fail("Expected 401 PIN_REQUIRED")
        } catch (e: ApiError) {
            assertEquals(401, e.httpStatus)
            assertEquals(ApiErrorCode.PIN_REQUIRED, e.errorCode)
        }
        delay(100L)
        assertTrue("401 PIN_REQUIRED must never emit global sessionExpiredEvents", unexpectedLogout.isEmpty())
        logoutWatcher.cancel()

        // Wrong PIN -> 403 PIN_INVALID
        try {
            roomRepo.enterRoom(code = uniqueRoomCode, pin = "0000")
            fail("Expected 403 PIN_INVALID")
        } catch (e: ApiError) {
            assertEquals(403, e.httpStatus)
            assertEquals(ApiErrorCode.PIN_INVALID, e.errorCode)
        }

        // Correct PIN -> 200
        val enteredRoom = roomRepo.enterRoom(code = uniqueRoomCode, pin = "2468")
        assertEquals(createdRoom.token, enteredRoom.token)

        // Update room code (strictly 6 alphanumeric chars) and clear PIN
        val newCode = "AbCd79"
        val updatedRoom = roomRepo.updateRoomCode(
            roomToken = createdRoom.token,
            code = OptionalField.Present(newCode),
            pin = OptionalField.Present(null),
        )
        assertEquals(newCode, updatedRoom.code)
        assertFalse(updatedRoom.hasPin)
        assertEquals("$origin/r/$newCode", updatedRoom.url)

        // Old code now 404; new code enters without PIN
        try {
            roomRepo.enterRoom(code = uniqueRoomCode, pin = null)
            fail("Old room code must no longer resolve")
        } catch (e: ApiError) {
            assertEquals(404, e.httpStatus)
        }
        val enteredAfterChange = roomRepo.enterRoom(code = newCode, pin = null)
        assertEquals(createdRoom.token, enteredAfterChange.token)

        // Room WebSocket snapshot & incremental event sync
        val roomScope = TargetScope.RoomScope(createdRoom.token)
        val roomRealtime = RealtimeClient(
            okHttpClient = okHttpClient,
            credentialsProvider = credentialsProvider,
            scope = realtimeScope,
            allowInsecureHttpForTest = true,
        )
        roomRealtime.connect(roomScope)
        withTimeout(10_000L) {
            roomRealtime.connectionState.first { it == ConnectionState.CONNECTED }
            roomRealtime.boardState.first { it.hasSnapshot }
        }
        val roomItem = boardRepo.createText(roomScope, "临时房间 WS 同步验证")
        withTimeout(10_000L) {
            roomRealtime.boardState.first { state -> state.items.any { it.id == roomItem.id && it.text == "临时房间 WS 同步验证" } }
        }
        roomRealtime.disconnect(clearState = true)

        // ------------------------------------------------------------------
        // 7. Per-item shares CRUD (/items/:id/shares) & public short links
        // ------------------------------------------------------------------
        val textShare = itemShareRepo.createShare(spaceScope, createdText.id, expiresIn = "1d", maxViews = 2)
        assertNotNull(textShare.token)
        assertEquals(6, textShare.token!!.length)
        assertEquals("$origin/s/${textShare.token}", textShare.url)
        assertNull(textShare.directUrl)

        val fileShare = itemShareRepo.createShare(spaceScope, pngItem.id, expiresIn = "1d", maxViews = 2)
        assertNotNull(fileShare.token)
        assertEquals("$origin/s/${fileShare.token}", fileShare.url)
        assertEquals("$origin/d/${fileShare.token}", fileShare.directUrl)

        // Public short link endpoints resolve without authentication
        okHttpClient.newCall(Request.Builder().url("$origin/api/s/${textShare.token}").get().build()).execute().use { res ->
            assertEquals(200, res.code)
            assertTrue(res.body!!.string().contains("更新后的协议回归文本"))
        }
        okHttpClient.newCall(Request.Builder().url(fileShare.directUrl!!).get().build()).execute().use { res ->
            assertEquals(200, res.code)
            assertArrayEquals(pngBytes, res.body!!.bytes())
        }

        val listedShares = itemShareRepo.listShares(spaceScope, pngItem.id)
        assertTrue(listedShares.any { it.id == fileShare.id })

        itemShareRepo.revokeShare(spaceScope, fileShare.id)
        okHttpClient.newCall(Request.Builder().url("$origin/api/s/${fileShare.token}").get().build()).execute().use { res ->
            assertEquals(404, res.code)
        }

        // Retract text item -> WS item.deleted
        boardRepo.retractItem(spaceScope, createdText.id)
        withTimeout(10_000L) {
            spaceRealtime.boardState.first { state -> state.items.none { it.id == createdText.id } }
        }

        // ------------------------------------------------------------------
        // 8. /api/app/android/latest & /api/app/android/download/<file>.apk
        // ------------------------------------------------------------------
        val installer = RecordingApkInstaller()
        val updateCacheDir = File(tempRoot, "update_cache").apply { mkdirs() }
        val updater = DefaultAppUpdater(
            apiClient = apiClient,
            settingsStore = settingsStore,
            cacheDir = updateCacheDir,
            installer = installer,
            currentVersionCode = 6,
            currentVersionName = "0.4.0",
            allowInsecureHttpForTest = true,
            githubReleasesUrl = null,
        )
        val checkResult = updater.checkLatest(force = true)
        assertTrue("Expected UpdateAvailable from real server, got $checkResult", checkResult is UpdateCheckResult.UpdateAvailable)
        val available = checkResult as UpdateCheckResult.UpdateAvailable
        assertEquals(expectedUpdateCode, available.manifest.versionCode)
        assertEquals(expectedUpdateVersion, available.manifest.versionName)
        assertEquals("/api/app/android/download/dropit-android-$expectedUpdateVersion.apk", available.manifest.url)
        if (expectedUpdateSha256 != null) {
            assertEquals(expectedUpdateSha256, available.manifest.sha256)
        }
        assertTrue(UpdateFiles.isValidManifest(available.manifest))
        assertTrue(updater.shouldPromptAutoUpdate(available.manifest))

        val installState = updater.downloadAndInstall(available.manifest)
        assertEquals(UpdateInstallState.ReadyToInstall, installState)
        assertNotNull(installer.launchedApk)
        assertEquals(available.manifest.size, installer.launchedApk!!.length())
        assertEquals(available.manifest.sha256, sha256Hex(installer.launchedApk!!.readBytes()))

        // ------------------------------------------------------------------
        // 9. Bearer token revocation -> real 401 HTTP + WS close (1008)
        // ------------------------------------------------------------------
        // Revoke current Bearer token via real POST /api/auth/logout (triggers events.revalidate() on server)
        apiClient.logout()

        // Active space WS must detect revocation and transition to UNAUTHORIZED (close 1008)
        withTimeout(10_000L) {
            spaceRealtime.connectionState.first { it == ConnectionState.UNAUTHORIZED }
        }

        // Subsequent authenticated HTTP call with the revoked token returns 401 UNAUTHENTICATED
        // and emits global sessionExpiredEvents
        val httpExpiredDeferred = async(start = CoroutineStart.UNDISPATCHED) {
            apiClient.sessionExpiredEvents.first { it.path == "/api/me" }
        }
        try {
            spaceRepo.getMe()
            fail("Expected 401 UNAUTHENTICATED after Bearer token revocation")
        } catch (e: ApiError) {
            assertEquals(401, e.httpStatus)
            assertEquals(ApiErrorCode.UNAUTHENTICATED, e.errorCode)
        }
        val expiredEvent = withTimeout(5_000L) { httpExpiredDeferred.await() }
        assertEquals(origin, expiredEvent.serverOrigin)
        assertEquals("/api/me", expiredEvent.path)

        spaceRealtime.disconnect(clearState = true)
        mediaRepo.cancelSessionObserver()
    }

    @Test
    fun nativeAuthAccountAndAdminSettingsRegressionAgainstRealDropitServer() = runBlocking {
        val origin = requireNotNull(liveServerUrl)
        val settingsStore = InMemorySettingsStore()
        val tokenVault = InMemoryTokenVault()
        val deviceId = "and-LiveAcctReg202607"
        val deviceName = "dropit Android · AccountReg"
        settingsStore.setDeviceId(deviceId)

        val credentialsProvider = object : SessionCredentialsProvider {
            override suspend fun serverOrigin(): String? = settingsStore.getServerOrigin()
            override suspend fun accessToken(): String? = tokenVault.getToken()
            override suspend fun deviceId(): String = settingsStore.getOrCreateDeviceId()
            override fun deviceName(): String = deviceName
        }

        val apiClient = DropitApiClient(
            okHttpClient = okHttpClient,
            credentialsProvider = credentialsProvider,
            allowInsecureHttpForTest = true,
        )
        val authRepo = DefaultAuthRepository(
            apiClient = apiClient,
            settingsStore = settingsStore,
            tokenVault = tokenVault,
            deviceNameProvider = { deviceName },
        )
        val accountRepo = DefaultAccountSettingsRepository(
            apiClient = apiClient,
            authRepository = authRepo,
        )
        val spaceRepo = DefaultSpaceRepository(apiClient)
        val boardRepo = DefaultBoardRepository(apiClient)
        val itemShareRepo = DefaultItemShareRepository(apiClient)
        val roomRepo = DefaultRoomRepository(apiClient, InMemoryRoomKeyStore(), settingsStore)

        // ------------------------------------------------------------------
        // 1. Auth providers & native admin password login (account + admin scopes)
        // ------------------------------------------------------------------
        authRepo.verifyAndSaveServer(origin)
        val providers = authRepo.getAuthProviders(origin)
        assertTrue(providers.password)

        // Invalid OAuth exchange code fails cleanly with 401 OAUTH_CODE_INVALID
        val pendingOAuth = authRepo.startAppOAuthLogin(origin, "github")
        val invalidCb = OAuthCallbackParser.parse(
            "dropit://auth/callback?code=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&state=${pendingOAuth.state}",
        )!!
        val invalidExchange = authRepo.handleOAuthLoginCallback(invalidCb)
        assertTrue(invalidExchange is OAuthLoginResult.Failed)
        assertEquals(ApiErrorCode.OAUTH_CODE_INVALID, (invalidExchange as OAuthLoginResult.Failed).error.errorCode)

        val adminLogin = authRepo.loginWithPassword(origin, adminEmail, adminPassword)
        assertEquals(adminEmail, adminLogin.user.email)
        assertTrue(adminLogin.user.isAdmin)
        assertFalse(adminLogin.mustChangePassword)
        assertTrue(authRepo.hasAccountScope)
        assertTrue(authRepo.hasAdminScope)
        assertEquals(AccountCapabilityState.Ready(hasAdminScope = true), accountRepo.accountCapability.value)

        val me = spaceRepo.getMe()
        val personalSpace = spaceRepo.pickDefaultSpace(spaceRepo.getSpaces(), me.user.id)!!
        val spaceScope = TargetScope.SpaceScope(personalSpace.id)

        // ------------------------------------------------------------------
        // 2. Legacy read/write PAT -> GET share-presets succeeds, account settings 403 INSUFFICIENT_SCOPE
        // ------------------------------------------------------------------
        val rwPat = accountRepo.createToken(name = "legacy-rw-test", scopes = listOf("read", "write"), expiresInDays = 7)
        assertTrue(rwPat.token.length == 43)

        val legacySettings = InMemorySettingsStore(dev.dropit.app.core.auth.AppSettings(serverOrigin = origin))
        val legacyVault = InMemoryTokenVault(initialToken = rwPat.token)
        val legacyCreds = object : SessionCredentialsProvider {
            override suspend fun serverOrigin(): String? = legacySettings.getServerOrigin()
            override suspend fun accessToken(): String? = legacyVault.getToken()
            override suspend fun deviceId(): String = legacySettings.getOrCreateDeviceId()
            override fun deviceName(): String = "dropit Android · Legacy"
        }
        val legacyApi = DropitApiClient(okHttpClient, credentialsProvider = legacyCreds, allowInsecureHttpForTest = true)
        val legacyAuth = DefaultAuthRepository(legacyApi, legacySettings, legacyVault, { "dropit Android · Legacy" })
        val legacyAccountRepo = DefaultAccountSettingsRepository(legacyApi, legacyAuth)
        legacyAuth.refreshSessionState()
        assertFalse(legacyAuth.hasAccountScope)
        assertTrue(legacyAccountRepo.accountCapability.value is AccountCapabilityState.InsufficientScopeForAccountSettings)

        // GET /api/me/share-presets is allowed on read Bearer
        assertNotNull(legacyAccountRepo.getSharePresets())

        // Account-scoped route rejects read/write token with 403 INSUFFICIENT_SCOPE
        try {
            legacyAccountRepo.listManagedShares()
            fail("Expected 403 INSUFFICIENT_SCOPE for read/write token")
        } catch (e: ApiError) {
            assertEquals(403, e.httpStatus)
            assertEquals(ApiErrorCode.INSUFFICIENT_SCOPE, e.errorCode)
            assertTrue(e.isInsufficientScope)
        }
        assertTrue(legacyAccountRepo.accountCapability.value is AccountCapabilityState.InsufficientScopeForAccountSettings)

        // Clean up the test PAT (rename -> revoke -> purge)
        accountRepo.updateToken(rwPat.id, "legacy-rw-renamed")
        assertTrue(accountRepo.listTokens().any { it.id == rwPat.id && it.name == "legacy-rw-renamed" })
        accountRepo.revokeToken(rwPat.id, purge = false)
        accountRepo.revokeToken(rwPat.id, purge = true)

        // ------------------------------------------------------------------
        // 3. Share presets sync + Managed shares center
        // ------------------------------------------------------------------
        val savedPresets = accountRepo.saveSharePresets(days = listOf(2, 7), views = listOf(5))
        assertEquals(listOf(2, 7), savedPresets.days)
        assertEquals(listOf(5), savedPresets.views)
        assertEquals(savedPresets, accountRepo.getSharePresets())

        val shareItem = boardRepo.createText(spaceScope, "分享管理中心真实回归条目")
        val createdShare = itemShareRepo.createShare(spaceScope, shareItem.id, expiresIn = "2d", maxViews = 5)
        val managedPage = accountRepo.listManagedShares()
        assertTrue(managedPage.shares.any { it.id == createdShare.id && it.state == "active" })
        val shareLink = accountRepo.getManagedShareLink(createdShare.id)
        assertEquals("$origin/s/${createdShare.token}", shareLink.url)
        accountRepo.revokeManagedShare(createdShare.id)
        accountRepo.deleteManagedShare(createdShare.id)
        boardRepo.retractItem(spaceScope, shareItem.id)

        // ------------------------------------------------------------------
        // 4. Browser sessions & Device code confirmation (lookup / approve / deny)
        // ------------------------------------------------------------------
        signInBrowserAdmin(origin, adminEmail, adminPassword)
        val sessions = accountRepo.listSessions()
        assertTrue("Expected at least 1 browser session", sessions.isNotEmpty())
        val revokedCount = accountRepo.revokeOtherSessions()
        assertTrue(revokedCount >= 1)

        val devApprove = authRepo.startDeviceAuthorization(origin, AuthRepository.DEFAULT_SCOPES)
        val lookup = accountRepo.lookupDeviceCode(devApprove.userCode, devApprove.verificationId)
        assertEquals(deviceName, lookup.name)
        accountRepo.approveDeviceCode(devApprove.userCode, devApprove.verificationId)

        val devDeny = authRepo.startDeviceAuthorization(origin, AuthRepository.DEFAULT_SCOPES)
        accountRepo.denyDeviceCode(devDeny.userCode, devDeny.verificationId)

        // ------------------------------------------------------------------
        // 5. Admin users + mustChangePassword + changePassword + Space members/invites
        // ------------------------------------------------------------------
        val memberEmail = "member-${UUID.randomUUID().toString().take(8)}@dropit.test"
        val createdMember = accountRepo.createUser(
            email = memberEmail,
            name = "Reg Member",
            role = "user",
            temporaryPassword = true,
        )
        assertNotNull(createdMember.temporaryPassword)
        assertTrue(accountRepo.listUsers().any { it.id == createdMember.id })

        accountRepo.updateUser(
            userId = createdMember.id,
            name = OptionalField.Present("Reg Member Updated"),
            inviteLimit = OptionalField.Present(3),
        )
        assertEquals("Reg Member Updated", accountRepo.listUsers().first { it.id == createdMember.id }.name)

        // Member signs in with temporary password -> mustChangePassword = true -> changePassword unlocks /api/spaces
        val memberSettings = InMemorySettingsStore()
        val memberVault = InMemoryTokenVault()
        val memberCreds = object : SessionCredentialsProvider {
            override suspend fun serverOrigin(): String? = memberSettings.getServerOrigin()
            override suspend fun accessToken(): String? = memberVault.getToken()
            override suspend fun deviceId(): String = memberSettings.getOrCreateDeviceId()
            override fun deviceName(): String = "dropit Android · Member"
        }
        val memberApi = DropitApiClient(okHttpClient, credentialsProvider = memberCreds, allowInsecureHttpForTest = true)
        val memberAuth = DefaultAuthRepository(memberApi, memberSettings, memberVault, { "dropit Android · Member" })
        val memberAccountRepo = DefaultAccountSettingsRepository(memberApi, memberAuth)
        val memberSpaceRepo = DefaultSpaceRepository(memberApi)

        val tempRes = memberAuth.loginWithPassword(origin, memberEmail, createdMember.temporaryPassword!!)
        assertTrue(tempRes.mustChangePassword)
        assertTrue(memberAuth.sessionState.value.mustChangePassword)
        try {
            memberSpaceRepo.getSpaces()
            fail("Expected 403 PASSWORD_CHANGE_REQUIRED before changing temp password")
        } catch (e: ApiError) {
            assertEquals(403, e.httpStatus)
            assertEquals(ApiErrorCode.PASSWORD_CHANGE_REQUIRED, e.errorCode)
        }
        val pwdChanged = memberAccountRepo.changePassword(createdMember.temporaryPassword!!, "MemberNewPass2026!")
        assertTrue(pwdChanged.hasPassword)
        assertFalse(pwdChanged.mustChangePassword)
        assertFalse(memberAuth.sessionState.value.mustChangePassword)
        assertTrue(memberSpaceRepo.getSpaces().isNotEmpty())
        assertTrue(memberAccountRepo.listIdentities().identities.isEmpty())

        // Space invite -> member accepts -> admin manages role & removes member -> re-accept & leaveSpace
        val spaceInvite = accountRepo.createSpaceInvite(personalSpace.id, role = "viewer", maxUses = 3, expiresInHours = 24)
        assertTrue(accountRepo.listSpaceInvites(personalSpace.id).invites.any { it.id == spaceInvite.id })
        val acceptReq = memberApi.buildApiRequest("/api/invites/${spaceInvite.token}/accept", method = "POST")
        memberApi.executeNoContent(acceptReq, authenticated = true)

        val membersAfterJoin = accountRepo.listSpaceMembers(personalSpace.id)
        assertTrue(membersAfterJoin.any { it.userId == createdMember.id && it.role == "viewer" })
        val membersAfterPromote = accountRepo.updateSpaceMemberRole(personalSpace.id, createdMember.id, "editor")
        assertTrue(membersAfterPromote.any { it.userId == createdMember.id && it.role == "editor" })
        accountRepo.removeSpaceMember(personalSpace.id, createdMember.id)
        assertTrue(accountRepo.listSpaceMembers(personalSpace.id).none { it.userId == createdMember.id })

        val reAcceptReq = memberApi.buildApiRequest("/api/invites/${spaceInvite.token}/accept", method = "POST")
        memberApi.executeNoContent(reAcceptReq, authenticated = true)
        memberAccountRepo.leaveSpace(personalSpace.id)
        assertTrue(accountRepo.listSpaceMembers(personalSpace.id).none { it.userId == createdMember.id })
        accountRepo.revokeSpaceInvite(personalSpace.id, spaceInvite.id)

        // Personal registration invites (admin)
        val personalInvite = accountRepo.createPersonalInvite(expiresInHours = 24)
        assertTrue(accountRepo.listPersonalInvites().invites.any { it.id == personalInvite.id })
        accountRepo.revokePersonalInvite(personalInvite.id)

        // Reset user password & force logout
        val resetRes = accountRepo.resetUserPassword(createdMember.id)
        assertTrue(resetRes.temporaryPassword.isNotBlank())
        accountRepo.logoutUser(createdMember.id)

        // ------------------------------------------------------------------
        // 6. Admin invites, registration policy, limits + audit, rooms, site & OAuth settings
        // ------------------------------------------------------------------
        val regPolicyBefore = accountRepo.getRegistrationPolicy()
        val regUpdated = accountRepo.updateRegistrationPolicy("open")
        assertEquals("open", regUpdated.policy)
        accountRepo.updateRegistrationPolicy(regPolicyBefore.policy)

        val adminInvite = accountRepo.createAdminInvite(kind = "registration", maxUses = 3, expiresInHours = 48)
        assertTrue(accountRepo.listAdminInvites().any { it.id == adminInvite.id })
        accountRepo.revokeAdminInvite(adminInvite.id)

        val limitsBefore = accountRepo.getLimits()
        assertTrue(limitsBefore.containsKey("maxItems"))
        val limitsPatched = accountRepo.updateLimits(mapOf("maxItems" to 777L))
        assertEquals(777L, limitsPatched["maxItems"]?.value)
        assertTrue(limitsPatched["maxItems"]?.overridden == true)
        val auditPage = accountRepo.getLimitsAudit(limit = 10)
        assertTrue(auditPage.entries.any { it.key == "maxItems" && it.newValue == 777L })
        val limitsRestored = accountRepo.updateLimits(mapOf("maxItems" to null))
        assertFalse(limitsRestored["maxItems"]?.overridden == true)

        val adminTestRoom = roomRepo.createOrReuseRoom(code = "Adm${UUID.randomUUID().toString().replace("-", "").take(5)}", pin = "1357")
        val roomId = adminTestRoom.token.substringBefore('.')
        assertTrue(accountRepo.listAdminRooms().any { it.id == roomId })
        accountRepo.closeRoom(roomId)
        accountRepo.reopenRoom(roomId)
        accountRepo.unlockRoom(roomId)
        accountRepo.deleteRoom(roomId)
        assertTrue(accountRepo.listAdminRooms().none { it.id == roomId })

        val siteBefore = accountRepo.getSiteSettings()
        assertEquals(origin, siteBefore.effectiveOrigin)
        try {
            accountRepo.updateSiteSettings("https://custom.dropit.test", confirm = false)
            fail("Expected 409 ORIGIN_CONFIRM_REQUIRED")
        } catch (e: ApiError) {
            assertEquals(409, e.httpStatus)
            assertTrue(e.isOriginConfirmRequired)
        }
        val siteSaved = accountRepo.updateSiteSettings("https://custom.dropit.test", confirm = true)
        assertEquals("https://custom.dropit.test", siteSaved.origin)
        val siteReset = accountRepo.updateSiteSettings(origin = null, confirm = true)
        assertNull(siteReset.adminOrigin)
        assertTrue(siteReset.source == "env" || siteReset.source == "request")

        val oauthBefore = accountRepo.getOAuthSettings()
        assertTrue(oauthBefore.providers.any { it.provider == "github" })
        val oauthUpdated = accountRepo.updateOAuthProvider("github", clientId = "test_client_id", clientSecret = "test_secret_123456", enabled = false)
        assertEquals("test_client_id", oauthUpdated.providers.first { it.provider == "github" }.clientId)
        val oauthDeleted = accountRepo.deleteOAuthProvider("github")
        assertEquals("none", oauthDeleted.providers.first { it.provider == "github" }.source)

        // ------------------------------------------------------------------
        // 7. v0.4.2 Google googleClientId exposure & native ID Token endpoint contract
        // ------------------------------------------------------------------
        val providersBeforeGoogle = authRepo.getAuthProviders(origin)
        assertNull(providersBeforeGoogle.googleClientId)
        try {
            authRepo.loginWithGoogleIdToken(origin, "header.payload.signature")
            fail("Expected 404 PROVIDER_UNAVAILABLE when Google OAuth is not configured")
        } catch (e: ApiError) {
            assertEquals(404, e.httpStatus)
            assertEquals(ApiErrorCode.PROVIDER_UNAVAILABLE, e.errorCode)
        }

        val testGoogleClientId = "regression-google-client.apps.googleusercontent.com"
        accountRepo.updateOAuthProvider(
            provider = "google",
            clientId = testGoogleClientId,
            clientSecret = "test_google_secret_123456",
            enabled = true,
        )
        val providersWithGoogle = authRepo.getAuthProviders(origin)
        assertTrue("google" in providersWithGoogle.providers)
        assertEquals(testGoogleClientId, providersWithGoogle.googleClientId)

        try {
            authRepo.loginWithGoogleIdToken(origin, "not-a-valid-jwt")
            fail("Expected 401 OAUTH_PROVIDER_ERROR for malformed Google ID token")
        } catch (e: ApiError) {
            assertEquals(401, e.httpStatus)
            assertEquals(ApiErrorCode.OAUTH_PROVIDER_ERROR, e.errorCode)
        }

        accountRepo.deleteOAuthProvider("google")
        val providersAfterGoogleDelete = authRepo.getAuthProviders(origin)
        assertNull(providersAfterGoogleDelete.googleClientId)

        // Clean up member and admin tokens
        memberAuth.logout(clearServer = true)
        authRepo.logout(clearServer = true)
    }

    private fun signInBrowserAdmin(origin: String, email: String, password: String): String {
        val body = Json.encodeToString(
            JsonObject.serializer(),
            buildJsonObject {
                put("email", JsonPrimitive(email))
                put("password", JsonPrimitive(password))
            },
        )
        val req = Request.Builder()
            .url("$origin/api/auth/password/login")
            .header("Origin", origin)
            .post(body.toRequestBody(JSON_MEDIA_TYPE))
            .build()
        okHttpClient.newCall(req).execute().use { res ->
            assertEquals("Admin password login failed: ${res.body?.string()}", 200, res.code)
            val setCookie = res.headers("Set-Cookie")
                .firstOrNull { it.startsWith("dropit_session=") || it.startsWith("__Host-dropit_session=") }
                ?: error("Missing session Set-Cookie header")
            return setCookie.substringBefore(';')
        }
    }

    private fun decideDeviceAuth(
        origin: String,
        cookie: String,
        decision: String,
        userCode: String,
        verificationId: String?,
    ) {
        val payload = buildJsonObject {
            put("user_code", JsonPrimitive(userCode))
            if (!verificationId.isNullOrBlank()) {
                put("verification_id", JsonPrimitive(verificationId))
            }
        }
        val req = Request.Builder()
            .url("$origin/api/auth/device/$decision")
            .header("Origin", origin)
            .header("Cookie", cookie)
            .post(Json.encodeToString(JsonObject.serializer(), payload).toRequestBody(JSON_MEDIA_TYPE))
            .build()
        okHttpClient.newCall(req).execute().use { res ->
            assertEquals("Device $decision failed: ${res.body?.string()}", 204, res.code)
        }
    }

    private suspend fun uploadViaTransferEngine(
        transferEngine: TransferEngine,
        dao: InMemoryTransferDao,
        stagingDir: File,
        origin: String,
        accountId: String,
        scope: TargetScope,
        fileName: String,
        mimeType: String,
        bytes: ByteArray,
        realtime: RealtimeClient,
    ) = run {
        val staged = File(stagingDir, "${UUID.randomUUID()}.dat").apply { writeBytes(bytes) }
        val nowMs = System.currentTimeMillis()
        val task = TransferTaskEntity(
            id = "live-upload-${UUID.randomUUID()}",
            serverOrigin = origin,
            accountId = accountId,
            targetScopeType = scope.scopeType,
            targetScopeId = scope.scopeId,
            direction = TransferDirection.UPLOAD.name,
            fileName = fileName,
            mimeType = mimeType,
            totalBytes = bytes.size.toLong(),
            localStagedPath = staged.absolutePath,
            status = TransferStatus.QUEUED.name,
            createdAt = nowMs,
            updatedAt = nowMs,
        )
        dao.upsert(task)
        assertEquals(TransferExecutionOutcome.Succeeded, transferEngine.executeTask(task.id) { })
        withTimeout(10_000L) {
            realtime.boardState.first { state -> state.items.any { it.filename == fileName } }
                .items.first { it.filename == fileName }
        }
    }

    private fun assertWebpMagic(bytes: ByteArray) {
        assertTrue("Expected WebP payload >= 12 bytes, got ${bytes.size}", bytes.size >= 12)
        assertEquals("RIFF", String(bytes, 0, 4, Charsets.US_ASCII))
        assertEquals("WEBP", String(bytes, 8, 4, Charsets.US_ASCII))
    }

    private fun sha256Hex(bytes: ByteArray): String =
        UpdateFiles.hex(MessageDigest.getInstance("SHA-256").digest(bytes))

    /**
     * Builds a deterministic, valid RGBA PNG without requiring AWT/Android Bitmap classes.
     */
    private fun createValidPng(width: Int, height: Int): ByteArray {
        val rawScanlines = ByteArrayOutputStream()
        for (y in 0 until height) {
            rawScanlines.write(0) // filter type 0 (None)
            for (x in 0 until width) {
                rawScanlines.write((x * 8) and 0xFF)
                rawScanlines.write((y * 8) and 0xFF)
                rawScanlines.write(180)
                rawScanlines.write(255)
            }
        }
        val compressed = ByteArrayOutputStream()
        val deflater = Deflater()
        deflater.setInput(rawScanlines.toByteArray())
        deflater.finish()
        val buf = ByteArray(1024)
        while (!deflater.finished()) {
            val n = deflater.deflate(buf)
            compressed.write(buf, 0, n)
        }
        deflater.end()

        val out = ByteArrayOutputStream()
        out.write(byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A))
        val ihdr = ByteArrayOutputStream().apply {
            DataOutputStream(this).apply {
                writeInt(width)
                writeInt(height)
                writeByte(8) // bit depth
                writeByte(6) // color type RGBA
                writeByte(0) // compression
                writeByte(0) // filter
                writeByte(0) // interlace
            }
        }.toByteArray()
        writePngChunk(out, "IHDR", ihdr)
        writePngChunk(out, "IDAT", compressed.toByteArray())
        writePngChunk(out, "IEND", ByteArray(0))
        return out.toByteArray()
    }

    private fun writePngChunk(out: ByteArrayOutputStream, type: String, data: ByteArray) {
        val typeBytes = type.toByteArray(Charsets.US_ASCII)
        val dos = DataOutputStream(out)
        dos.writeInt(data.size)
        out.write(typeBytes)
        out.write(data)
        val crc = CRC32()
        crc.update(typeBytes)
        crc.update(data)
        dos.writeInt(crc.value.toInt())
    }

    /**
     * Builds a valid PCM WAV audio file recognized by server `sniffMedia` (`RIFF....WAVE`).
     */
    private fun createValidWav(pcmPayloadBytes: Int): ByteArray {
        val total = 44 + pcmPayloadBytes
        val buf = ByteBuffer.allocate(total).order(ByteOrder.LITTLE_ENDIAN)
        buf.put("RIFF".toByteArray(Charsets.US_ASCII))
        buf.putInt(36 + pcmPayloadBytes)
        buf.put("WAVE".toByteArray(Charsets.US_ASCII))
        buf.put("fmt ".toByteArray(Charsets.US_ASCII))
        buf.putInt(16) // PCM fmt chunk size
        buf.putShort(1) // PCM format
        buf.putShort(1) // mono
        buf.putInt(8000) // sample rate
        buf.putInt(8000) // byte rate
        buf.putShort(1) // block align
        buf.putShort(8) // bits per sample
        buf.put("data".toByteArray(Charsets.US_ASCII))
        buf.putInt(pcmPayloadBytes)
        for (i in 0 until pcmPayloadBytes) {
            buf.put(((i * 7 + 128) and 0xFF).toByte())
        }
        return buf.array()
    }

    private class RecordingApkInstaller : ApkInstaller {
        var launchedApk: File? = null
        override fun canRequestPackageInstalls(): Boolean = true
        override fun buildInstallIntent(apkFile: File): Intent = Intent()
        override fun launchInstaller(apkFile: File) {
            launchedApk = apkFile
        }
        override fun openUnknownAppSourcesSettings() = Unit
    }

    private class LocalTestDownloadSink(
        private val downloadsDir: File,
        private val shareCacheDir: File,
    ) : DownloadSink {
        var lastSystemDownload: Pair<String, File>? = null

        override fun saveToSystemDownloads(sourceFile: File, fileName: String, mimeType: String): SavedDownloadResult {
            val dest = File(downloadsDir, fileName)
            sourceFile.copyTo(dest, overwrite = true)
            lastSystemDownload = fileName to dest
            return SavedDownloadResult(uriString = dest.toURI().toString(), savedFile = dest)
        }

        override fun saveToShareCache(sourceFile: File, itemId: String, fileName: String): SavedDownloadResult {
            val dir = File(shareCacheDir, itemId).apply { mkdirs() }
            val dest = File(dir, fileName)
            sourceFile.copyTo(dest, overwrite = true)
            return SavedDownloadResult(uriString = dest.toURI().toString(), savedFile = dest)
        }

        override fun mimeFromExtension(ext: String): String? = DownloadName.defaultMimeForExtension(ext)
        override fun extensionFromMime(mime: String): String? = DownloadName.defaultExtensionForMime(mime)
    }

    private class InMemoryTransferDao : TransferDao {
        private val state = MutableStateFlow<List<TransferTaskEntity>>(emptyList())

        override fun observeByScope(serverOrigin: String, accountId: String?): Flow<List<TransferTaskEntity>> =
            state.map { list -> list.filter { it.serverOrigin == serverOrigin && it.accountId == accountId } }

        override suspend fun listByScope(serverOrigin: String, accountId: String?): List<TransferTaskEntity> =
            state.value.filter { it.serverOrigin == serverOrigin && it.accountId == accountId }

        override suspend fun listAll(): List<TransferTaskEntity> = state.value
        override suspend fun getById(id: String): TransferTaskEntity? = state.value.firstOrNull { it.id == id }
        override suspend fun listByStatus(status: String): List<TransferTaskEntity> = state.value.filter { it.status == status }

        override suspend fun upsert(entity: TransferTaskEntity) {
            state.value = state.value.filterNot { it.id == entity.id } + entity
        }

        override suspend fun upsertAll(entities: List<TransferTaskEntity>) {
            val ids = entities.mapTo(HashSet()) { it.id }
            state.value = state.value.filterNot { it.id in ids } + entities
        }

        override suspend fun updateStatus(id: String, status: String, errorMessage: String?, updatedAt: Long) {
            state.value = state.value.map {
                if (it.id == id) it.copy(status = status, errorMessage = errorMessage, updatedAt = updatedAt) else it
            }
        }

        override suspend fun updateUploadSession(
            id: String,
            remoteUploadId: String?,
            chunkSize: Int,
            completedChunks: String,
            transferredBytes: Long,
            updatedAt: Long,
        ) {
            state.value = state.value.map {
                if (it.id == id) {
                    it.copy(
                        remoteUploadId = remoteUploadId,
                        chunkSize = chunkSize,
                        completedChunks = completedChunks,
                        transferredBytes = transferredBytes,
                        updatedAt = updatedAt,
                    )
                } else {
                    it
                }
            }
        }

        override suspend fun updateProgress(id: String, transferredBytes: Long, completedChunks: String, updatedAt: Long) {
            state.value = state.value.map {
                if (it.id == id) it.copy(transferredBytes = transferredBytes, completedChunks = completedChunks, updatedAt = updatedAt) else it
            }
        }

        override suspend fun updateFileMetadata(id: String, fileName: String, mimeType: String, totalBytes: Long, updatedAt: Long) {
            state.value = state.value.map {
                if (it.id == id) it.copy(fileName = fileName, mimeType = mimeType, totalBytes = totalBytes, updatedAt = updatedAt) else it
            }
        }

        override suspend fun markSucceeded(id: String, status: String, transferredBytes: Long, localResultUri: String?, updatedAt: Long) {
            state.value = state.value.map {
                if (it.id == id) {
                    it.copy(
                        status = status,
                        transferredBytes = transferredBytes,
                        localResultUri = localResultUri,
                        remoteUploadId = null,
                        localStagedPath = null,
                        errorMessage = null,
                        updatedAt = updatedAt,
                    )
                } else {
                    it
                }
            }
        }

        override suspend fun reassignAccountId(serverOrigin: String, oldAccountId: String, newAccountId: String, updatedAt: Long) {
            state.value = state.value.map {
                if (it.serverOrigin == serverOrigin && it.accountId == oldAccountId) it.copy(accountId = newAccountId, updatedAt = updatedAt) else it
            }
        }

        override suspend fun deleteCompletedForScope(serverOrigin: String, accountId: String?) {
            state.value = state.value.filterNot {
                it.serverOrigin == serverOrigin && it.accountId == accountId &&
                    (it.status == TransferStatus.SUCCEEDED.name || it.status == TransferStatus.CANCELLED.name)
            }
        }

        override suspend fun deleteByScope(serverOrigin: String, accountId: String?) {
            state.value = state.value.filterNot { it.serverOrigin == serverOrigin && it.accountId == accountId }
        }

        override suspend fun deleteById(id: String) {
            state.value = state.value.filterNot { it.id == id }
        }

        override suspend fun deleteAll() {
            state.value = emptyList()
        }

        private val savedState = MutableStateFlow<Map<Triple<String, String, String>, SavedDownloadEntity>>(emptyMap())

        override suspend fun findActiveDownloadForItem(
            serverOrigin: String,
            accountId: String?,
            remoteItemId: String,
        ): TransferTaskEntity? = state.value.firstOrNull {
            it.serverOrigin == serverOrigin &&
                it.accountId == accountId &&
                it.direction == TransferDirection.DOWNLOAD.name &&
                !it.shareAfterDownload &&
                it.remoteItemId == remoteItemId &&
                (it.status == TransferStatus.QUEUED.name || it.status == TransferStatus.RUNNING.name)
        }

        override fun observeSavedDownloadsByScope(serverOrigin: String, accountId: String): Flow<List<SavedDownloadEntity>> =
            savedState.map { map ->
                map.values.filter { it.serverOrigin == serverOrigin && it.accountId == accountId }
                    .sortedWith(compareByDescending<SavedDownloadEntity> { it.savedAt }.thenBy { it.remoteItemId })
            }

        override suspend fun listSavedDownloadsByScope(serverOrigin: String, accountId: String): List<SavedDownloadEntity> =
            savedState.value.values.filter { it.serverOrigin == serverOrigin && it.accountId == accountId }
                .sortedWith(compareByDescending<SavedDownloadEntity> { it.savedAt }.thenBy { it.remoteItemId })

        override suspend fun listAllSavedDownloads(): List<SavedDownloadEntity> =
            savedState.value.values.sortedWith(compareByDescending<SavedDownloadEntity> { it.savedAt }.thenBy { it.remoteItemId })

        override suspend fun getSavedDownload(serverOrigin: String, accountId: String, remoteItemId: String): SavedDownloadEntity? =
            savedState.value[Triple(serverOrigin, accountId, remoteItemId)]

        override suspend fun upsertSavedDownload(entity: SavedDownloadEntity) {
            savedState.value = savedState.value + (Triple(entity.serverOrigin, entity.accountId, entity.remoteItemId) to entity)
        }

        override suspend fun deleteSavedDownload(serverOrigin: String, accountId: String, remoteItemId: String) {
            savedState.value = savedState.value - Triple(serverOrigin, accountId, remoteItemId)
        }

        override suspend fun deleteSavedDownloadsByScope(serverOrigin: String, accountId: String) {
            savedState.value = savedState.value.filterValues { !(it.serverOrigin == serverOrigin && it.accountId == accountId) }
        }

        override suspend fun deleteAllSavedDownloads() {
            savedState.value = emptyMap()
        }

        override suspend fun reassignSavedDownloadsAccountId(serverOrigin: String, oldAccountId: String, newAccountId: String) {
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

    companion object {
        private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
        private val OCTET_STREAM = "application/octet-stream".toMediaType()
    }
}
