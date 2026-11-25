package dev.dropit.app.data.media

import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.okhttp.OkHttpDataSource
import dev.dropit.app.core.auth.AuthSessionState
import dev.dropit.app.core.network.ApiError
import dev.dropit.app.core.network.ApiErrorCode
import dev.dropit.app.core.network.DropitApiClient
import dev.dropit.app.core.network.SessionCredentialsProvider
import dev.dropit.app.core.network.TargetScope
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.io.File
import java.nio.charset.Charset
import java.nio.file.Files
import java.util.concurrent.atomic.AtomicInteger

class DefaultMediaRepositoryTest {

    private lateinit var server: MockWebServer
    private lateinit var otherServer: MockWebServer
    private lateinit var okHttpClient: OkHttpClient
    private lateinit var baseUrl: String
    private lateinit var otherBaseUrl: String
    private lateinit var tempCacheDir: File
    private lateinit var observerScope: CoroutineScope
    private lateinit var sessionFlow: MutableStateFlow<AuthSessionState>
    private lateinit var apiClient: DropitApiClient
    private lateinit var mediaRepository: DefaultMediaRepository

    private var activeOrigin: String? = null
    private var activeToken: String? = "tok_media_test_0123456789012345678901234567890"
    private val cacheClearCount = AtomicInteger(0)

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        baseUrl = server.url("/").toString().trimEnd('/')
        activeOrigin = baseUrl

        otherServer = MockWebServer()
        otherServer.start()
        otherBaseUrl = otherServer.url("/").toString().trimEnd('/')

        okHttpClient = OkHttpClient.Builder().build()
        tempCacheDir = Files.createTempDirectory("dropit-media-cache-test").toFile()
        observerScope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        sessionFlow = MutableStateFlow(AuthSessionState(serverOrigin = baseUrl, isSignedIn = true))

        val creds = object : SessionCredentialsProvider {
            override suspend fun serverOrigin(): String? = activeOrigin
            override suspend fun accessToken(): String? = activeToken
            override suspend fun deviceId(): String = "and-MediaTestDevice12345"
            override fun deviceName(): String = "dropit Android · MediaTest"
        }
        apiClient = DropitApiClient(
            okHttpClient = okHttpClient,
            credentialsProvider = creds,
            allowInsecureHttpForTest = true,
        )
        mediaRepository = DefaultMediaRepository(
            context = null,
            baseOkHttpClient = okHttpClient,
            apiClient = apiClient,
            credentialsProvider = creds,
            imageCacheDir = tempCacheDir,
            sessionStateFlow = sessionFlow,
            coroutineScope = observerScope,
            onCachesCleared = { cacheClearCount.incrementAndGet() },
        )
    }

    @After
    fun tearDown() {
        mediaRepository.cancelSessionObserver()
        observerScope.cancel()
        server.shutdown()
        otherServer.shutdown()
        okHttpClient.dispatcher.executorService.shutdown()
        okHttpClient.connectionPool.evictAll()
        tempCacheDir.deleteRecursively()
    }

    @Test
    fun urlBuilders_supportBothSpaceAndRoomScopesWithEncoding() = runTest {
        val space = TargetScope.SpaceScope("sp/1")
        assertEquals("$baseUrl/api/spaces/sp%2F1/items/it%201/thumbnail", mediaRepository.thumbnailUrl(space, "it 1"))
        assertEquals("$baseUrl/api/spaces/sp%2F1/items/it%201/preview", mediaRepository.previewUrl(space, "it 1"))
        assertEquals("$baseUrl/api/spaces/sp%2F1/items/it%201/media", mediaRepository.mediaUrl(space, "it 1"))
        assertEquals("$baseUrl/api/spaces/sp%2F1/items/it%201/download", mediaRepository.downloadUrl(space, "it 1"))

        val room = TargetScope.RoomScope("rm-1.proof")
        assertEquals("$baseUrl/api/rooms/rm-1.proof/items/vid-1/media", mediaRepository.mediaUrl(room, "vid-1"))
    }

    @OptIn(UnstableApi::class)
    @Test
    fun mediaClient_attachesBearerAndDeviceHeadersPreservesRangeAndNeverLeaksCrossOrigin() = runTest {
        // 1. Authenticated Range request to configured server (/media)
        server.enqueue(
            MockResponse()
                .setResponseCode(206)
                .addHeader("Content-Type", "video/mp4")
                .addHeader("Accept-Ranges", "bytes")
                .addHeader("Content-Range", "bytes 4-9/20")
                .setBody("456789"),
        )
        val mediaUrl = mediaRepository.mediaUrl(TargetScope.SpaceScope("sp-1"), "video-1")
        val mediaReq = Request.Builder()
            .url(mediaUrl)
            .header("Range", "bytes=4-9")
            .build()
        mediaRepository.mediaOkHttpClient.newCall(mediaReq).execute().use { res ->
            assertEquals(206, res.code)
            assertEquals("456789", res.body?.string())
        }
        val recordedMedia = server.takeRequest()
        assertEquals("Bearer $activeToken", recordedMedia.getHeader("Authorization"))
        assertEquals("bytes=4-9", recordedMedia.getHeader("Range"))
        assertEquals("and-MediaTestDevice12345", recordedMedia.getHeader("X-Dropit-Device"))
        assertEquals("phone", recordedMedia.getHeader("X-Dropit-Device-Kind"))
        assertFalse(recordedMedia.getHeader("X-Dropit-Device-Name").isNullOrBlank())

        // 2. Verify Media3 DataSource.Factory returns OkHttpDataSource.Factory
        val factory = mediaRepository.createMediaDataSourceFactory()
        assertTrue(factory is OkHttpDataSource.Factory)

        // 3. Cross-origin request MUST NOT receive Bearer token or device headers
        otherServer.enqueue(MockResponse().setResponseCode(200).setBody("external"))
        val externalReq = Request.Builder().url("$otherBaseUrl/image.webp").build()
        mediaRepository.mediaOkHttpClient.newCall(externalReq).execute().use { res ->
            assertEquals(200, res.code)
        }
        val recordedExternal = otherServer.takeRequest()
        assertNull("Bearer token must NEVER leak to third-party origin", recordedExternal.getHeader("Authorization"))
        assertNull(recordedExternal.getHeader("X-Dropit-Device"))

        // 4. Redirect from configured server to external server strips Authorization on network hop
        server.enqueue(
            MockResponse()
                .setResponseCode(302)
                .addHeader("Location", "$otherBaseUrl/redirected-target"),
        )
        otherServer.enqueue(MockResponse().setResponseCode(200).setBody("ok"))
        val redirectReq = Request.Builder().url("$baseUrl/api/spaces/sp-1/items/img-1/preview").build()
        mediaRepository.mediaOkHttpClient.newCall(redirectReq).execute().use { res ->
            assertEquals(200, res.code)
        }
        server.takeRequest()
        val recordedRedirectTarget = otherServer.takeRequest()
        assertNull(recordedRedirectTarget.getHeader("Authorization"))
    }

    @Test
    fun mediaClient_emitsSessionExpiredOnceOn401() = runTest {
        server.enqueue(
            MockResponse()
                .setResponseCode(401)
                .setBody("""{"error":{"code":"UNAUTHENTICATED"}}"""),
        )
        val expiredDeferred = async { apiClient.sessionExpiredEvents.first() }

        val previewUrl = mediaRepository.previewUrl(TargetScope.SpaceScope("sp-1"), "img-1")
        mediaRepository.mediaOkHttpClient.newCall(Request.Builder().url(previewUrl).build()).execute().use { res ->
            assertEquals(401, res.code)
        }

        val event = expiredDeferred.await()
        assertEquals(baseUrl, event.serverOrigin)
        assertEquals("/api/spaces/sp-1/items/img-1/preview", event.path)
    }

    @Test
    fun fetchTextContent_handlesUtf8BomCharsetTruncationAtMultiByteBoundaryAndTextFallback() = runTest {
        // 1. UTF-8 BOM + Chinese Markdown truncated mid-character at maxBytes = 10
        val utf8Bom = byteArrayOf(0xEF.toByte(), 0xBB.toByte(), 0xBF.toByte())
        val chineseMarkdown = "# 你好世界测试文本".toByteArray(Charsets.UTF_8)
        val fullBytes = utf8Bom + chineseMarkdown
        server.enqueue(
            MockResponse()
                .setResponseCode(206)
                .addHeader("Content-Type", "text/markdown; charset=utf-8")
                .addHeader("Content-Range", "bytes 0-10/${fullBytes.size}")
                .setBody(Buffer().write(fullBytes, 0, 11)),
        )

        val preview = mediaRepository.fetchTextPreview(
            scope = TargetScope.SpaceScope("sp-1"),
            itemId = "md-1",
            maxBytes = 10,
        )
        assertTrue(preview.truncated)
        assertEquals(fullBytes.size.toLong(), preview.totalBytes)
        // Must not contain UTF-8 replacement character at truncated multi-byte boundary
        assertFalse("Truncated UTF-8 should never emit U+FFFD", preview.text.contains('\uFFFD'))
        assertTrue(preview.text.startsWith("# 你"))

        val req1 = server.takeRequest()
        assertEquals("bytes=0-10", req1.getHeader("Range"))
        assertEquals("Bearer $activeToken", req1.getHeader("Authorization"))

        // 2. Explicit GB18030 charset decoding
        val gbBytes = "中文预览内容".toByteArray(Charset.forName("GB18030"))
        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .addHeader("Content-Type", "text/plain; charset=GB18030")
                .setBody(Buffer().write(gbBytes)),
        )
        val gbText = mediaRepository.fetchTextContent(TargetScope.SpaceScope("sp-1"), "gb-1", maxBytes = 4096)
        assertEquals("中文预览内容", gbText)
        server.takeRequest()

        // 3. Empty file (416 Range Not Satisfiable) returns empty string cleanly
        server.enqueue(
            MockResponse()
                .setResponseCode(416)
                .addHeader("Content-Range", "bytes */0"),
        )
        val emptyText = mediaRepository.fetchTextContent(TargetScope.SpaceScope("sp-1"), "empty-1")
        assertEquals("", emptyText)
        server.takeRequest()

        // 4. Inline kind="text" item (404 on /download -> falls back to snapshot item.text with maxBytes cap)
        server.enqueue(
            MockResponse()
                .setResponseCode(404)
                .setBody("""{"error":{"code":"NOT_FOUND"}}"""),
        )
        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setBody(
                    """{"type":"snapshot","items":[{"id":"txt-99","spaceId":"sp-1","kind":"text","text":"Dropit 原生 Markdown 预览","size":30,"createdAt":1,"updatedAt":1,"expiresAt":2}],"groups":[],"serverTime":1}""",
                ),
        )
        val inlineText = mediaRepository.fetchTextContent(TargetScope.SpaceScope("sp-1"), "txt-99", maxBytes = 1024)
        assertEquals("Dropit 原生 Markdown 预览", inlineText)
        server.takeRequest()
        server.takeRequest()

        // 5. Missing item returns 404 ApiError
        server.enqueue(MockResponse().setResponseCode(404).setBody("""{"error":{"code":"NOT_FOUND"}}"""))
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"type":"snapshot","items":[],"groups":[],"serverTime":1}"""))
        try {
            mediaRepository.fetchTextContent(TargetScope.SpaceScope("sp-1"), "missing-id")
            fail("Expected 404 NOT_FOUND")
        } catch (e: ApiError) {
            assertEquals(ApiErrorCode.NOT_FOUND, e.errorCode)
        }
    }

    @Test
    fun caches_areAutomaticallyClearedOnLogoutAndServerSwitch() = runTest {
        val cachedFile1 = File(tempCacheDir, "thumb_1.webp").apply { writeText("webp-bytes") }
        assertTrue(cachedFile1.isFile)
        assertEquals(0, cacheClearCount.get())

        // Logout on same server triggers automatic cache clear
        sessionFlow.value = AuthSessionState(serverOrigin = baseUrl, isSignedIn = false)
        assertEquals(1, cacheClearCount.get())
        assertTrue(tempCacheDir.listFiles().isNullOrEmpty())

        // Sign back in and write another cache file, then switch servers -> clears again
        sessionFlow.value = AuthSessionState(serverOrigin = baseUrl, isSignedIn = true)
        val cachedFile2 = File(tempCacheDir, "preview_2.webp").apply { writeText("webp-bytes-2") }
        assertTrue(cachedFile2.isFile)

        sessionFlow.value = AuthSessionState(serverOrigin = otherBaseUrl, isSignedIn = true)
        assertEquals(2, cacheClearCount.get())
        assertTrue(tempCacheDir.listFiles().isNullOrEmpty())
    }
}
