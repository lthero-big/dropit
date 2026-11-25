package dev.dropit.app.core.network

import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

class DropitApiClientTest {

    private lateinit var server: MockWebServer
    private lateinit var okHttpClient: OkHttpClient
    private var currentToken: String? = "tok_test_12345678901234567890123456789012345"
    private lateinit var baseUrl: String

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        baseUrl = server.url("/").toString().trimEnd('/')
        okHttpClient = OkHttpClient.Builder().build()
    }

    @After
    fun tearDown() {
        server.shutdown()
        okHttpClient.dispatcher.executorService.shutdown()
        okHttpClient.connectionPool.evictAll()
    }

    private fun createClient(allowHttp: Boolean = true): DropitApiClient {
        val creds = object : SessionCredentialsProvider {
            override suspend fun serverOrigin(): String? = baseUrl
            override suspend fun accessToken(): String? = currentToken
            override suspend fun deviceId(): String = "and-0123456789abcdefghij"
            override fun deviceName(): String = "dropit Android · Pixel 9 测试"
        }
        return DropitApiClient(
            okHttpClient = okHttpClient,
            credentialsProvider = creds,
            allowInsecureHttpForTest = allowHttp,
        )
    }

    @Test
    fun getMeAndHeaders_sendsBearerAndEncodedDeviceHeaders() = runTest {
        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setBody(
                    """
                    {
                      "user": {"id":"u1","email":"dev@dropit.dev","name":"Dev","role":"admin","disabled":0,"pending":0,"createdAt":1700000000000},
                      "hasPassword": true,
                      "mustChangePassword": false,
                      "usedBytes": 1024,
                      "reservedBytes": 0,
                      "quotaBytes": 104857600,
                      "maxFileBytes": 52428800,
                      "maxTextBytes": 65536,
                      "retentionMs": 86400000
                    }
                    """.trimIndent(),
                ),
        )

        val client = createClient()
        val me = client.getMe()

        assertEquals("u1", me.user.id)
        assertTrue(me.user.isAdmin)
        assertEquals(1024L, me.usedBytes)

        val recorded = server.takeRequest()
        assertEquals("GET", recorded.method)
        assertEquals("/api/me", recorded.path)
        assertEquals("Bearer $currentToken", recorded.getHeader("Authorization"))
        assertEquals("and-0123456789abcdefghij", recorded.getHeader("X-Dropit-Device"))
        assertEquals("phone", recorded.getHeader("X-Dropit-Device-Kind"))
        val rawDeviceName = recorded.getHeader("X-Dropit-Device-Name")!!
        assertEquals(ServerUrl.encodeURIComponent("dropit Android · Pixel 9 测试"), rawDeviceName)
    }

    @Test
    fun verifyServer_validatesVersionPayloadAndRejectsInvalid() = runTest {
        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setBody("""{"version":"0.4.0","commit":"abcdef1","buildDate":"2026-11-25T00:00:00Z","install":"docker"}"""),
        )
        val client = createClient()
        val verified = client.verifyServer(baseUrl)
        assertEquals("0.4.0", verified.versionInfo.version)
        assertEquals("docker", verified.versionInfo.install)

        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"version":"bad","install":"unknown"}"""))
        try {
            client.verifyServer(baseUrl)
            fail("Expected ApiError for non-dropit version payload")
        } catch (e: ApiError) {
            assertEquals(ApiErrorCode.INVALID_SERVER, e.errorCode)
        }
    }

    @Test
    fun http401_emitsSessionExpiredEventAndMapsUnauthenticated() = runTest {
        server.enqueue(
            MockResponse()
                .setResponseCode(401)
                .setBody("""{"error":{"code":"UNAUTHENTICATED"}}"""),
        )

        val client = createClient()
        val expiredDeferred = async(start = CoroutineStart.UNDISPATCHED) { client.sessionExpiredEvents.first() }

        try {
            client.getSpaces()
            fail("Expected 401 ApiError")
        } catch (e: ApiError) {
            assertEquals(401, e.httpStatus)
            assertEquals(ApiErrorCode.UNAUTHENTICATED, e.errorCode)
            assertTrue(e.isUnauthorized)
        }

        val event = expiredDeferred.await()
        assertEquals("/api/spaces", event.path)
    }

    @Test
    fun http413And429And403_mapErrorCodesAndRetryAfter() = runTest {
        val client = createClient()
        val scope = TargetScope.SpaceScope("sp-1")

        // 413 FILE_TOO_LARGE
        server.enqueue(
            MockResponse()
                .setResponseCode(413)
                .setBody("""{"error":{"code":"FILE_TOO_LARGE"}}"""),
        )
        try {
            client.createTextItem(scope, "huge")
            fail("Expected 413")
        } catch (e: ApiError) {
            assertEquals(413, e.httpStatus)
            assertEquals(ApiErrorCode.FILE_TOO_LARGE, e.errorCode)
            assertEquals("文件太大，超过服务器限制", e.userMessage)
        }

        // 429 RATE_LIMITED with Retry-After
        server.enqueue(
            MockResponse()
                .setResponseCode(429)
                .addHeader("Retry-After", "12")
                .setBody("""{"error":{"code":"RATE_LIMITED"}}"""),
        )
        try {
            client.createTextItem(scope, "fast")
            fail("Expected 429")
        } catch (e: ApiError) {
            assertEquals(429, e.httpStatus)
            assertEquals(ApiErrorCode.RATE_LIMITED, e.errorCode)
            assertEquals(12L, e.retryAfterSeconds)
        }

        // 403 INSUFFICIENT_SCOPE & QUOTA_EXCEEDED & ITEM_LIMIT
        server.enqueue(MockResponse().setResponseCode(403).setBody("""{"error":{"code":"INSUFFICIENT_SCOPE"}}"""))
        try {
            client.createTextItem(scope, "no-write")
            fail("Expected 403")
        } catch (e: ApiError) {
            assertEquals(ApiErrorCode.INSUFFICIENT_SCOPE, e.errorCode)
        }

        server.enqueue(MockResponse().setResponseCode(413).setBody("""{"error":{"code":"QUOTA_EXCEEDED"}}"""))
        try {
            client.createTextItem(scope, "quota")
            fail("Expected QUOTA_EXCEEDED")
        } catch (e: ApiError) {
            assertEquals(ApiErrorCode.QUOTA_EXCEEDED, e.errorCode)
        }

        server.enqueue(MockResponse().setResponseCode(409).setBody("""{"error":{"code":"ITEM_LIMIT"}}"""))
        try {
            client.createTextItem(scope, "limit")
            fail("Expected ITEM_LIMIT")
        } catch (e: ApiError) {
            assertEquals(ApiErrorCode.ITEM_LIMIT, e.errorCode)
        }
    }

    @Test
    fun updateItemLabels_distinguishesAbsentGroupFromExplicitNull() = runTest {
        val client = createClient()
        val scope = TargetScope.SpaceScope("sp-1")
        val itemJson = """{"item":{"id":"i1","spaceId":"sp-1","kind":"text","text":"hi","size":2,"createdAt":1,"updatedAt":2,"expiresAt":3,"pinned":true,"hasThumbnail":false,"tags":["work"],"group":null}}"""

        server.enqueue(MockResponse().setResponseCode(200).setBody(itemJson))
        client.updateItemLabels(scope, "i1", pinned = true)
        val req1 = server.takeRequest()
        assertFalse(req1.body.readUtf8().contains("\"group\""))

        server.enqueue(MockResponse().setResponseCode(200).setBody(itemJson))
        client.updateItemLabels(scope, "i1", group = OptionalField.Present(null))
        val req2 = server.takeRequest()
        val body2 = req2.body.readUtf8()
        assertTrue(body2.contains("\"group\":null"))
    }

    @Test
    fun productionClient_rejectsHttpOrigin() = runTest {
        val prodClient = createClient(allowHttp = false)
        try {
            prodClient.getMe()
            fail("Production client must reject http:// server origin")
        } catch (e: ApiError) {
            assertEquals(ApiErrorCode.INVALID_SERVER, e.errorCode)
            assertEquals("只支持 https:// 地址", e.userMessage)
        }
        assertNull(server.takeRequest(100, java.util.concurrent.TimeUnit.MILLISECONDS))
    }
}
