package dev.dropit.app.data.itemshare

import dev.dropit.app.core.network.ApiError
import dev.dropit.app.core.network.ApiErrorCode
import dev.dropit.app.core.network.DropitApiClient
import dev.dropit.app.core.network.SessionCredentialsProvider
import dev.dropit.app.core.network.TargetScope
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
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

class DefaultItemShareRepositoryTest {

    private lateinit var server: MockWebServer
    private lateinit var okHttpClient: OkHttpClient
    private lateinit var baseUrl: String
    private lateinit var apiClient: DropitApiClient
    private lateinit var repository: DefaultItemShareRepository

    private val bearerToken = "tok_share_test_0123456789012345678901234567890"

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        baseUrl = server.url("/").toString().trimEnd('/')
        okHttpClient = OkHttpClient.Builder().build()
        val creds = object : SessionCredentialsProvider {
            override suspend fun serverOrigin(): String = baseUrl
            override suspend fun accessToken(): String = bearerToken
            override suspend fun deviceId(): String = "and-ShareTestDevice12345"
            override fun deviceName(): String = "dropit Android · ShareTest"
        }
        apiClient = DropitApiClient(
            okHttpClient = okHttpClient,
            credentialsProvider = creds,
            allowInsecureHttpForTest = true,
        )
        repository = DefaultItemShareRepository(apiClient)
    }

    @After
    fun tearDown() {
        server.shutdown()
        okHttpClient.dispatcher.executorService.shutdown()
        okHttpClient.connectionPool.evictAll()
    }

    @Test
    fun createShare_inSpaceScope_resolvesAbsoluteShortAndDirectUrls() = runTest {
        server.enqueue(
            MockResponse()
                .setResponseCode(201)
                .setBody(
                    """{
                      "id":"sh-1",
                      "itemId":"item-file-1",
                      "expiresAt":1800000000000,
                      "maxViews":5,
                      "views":0,
                      "revoked":0,
                      "createdAt":1700000000000,
                      "token":"Ab3Cd9",
                      "url":"/s/Ab3Cd9",
                      "directUrl":"/d/Ab3Cd9"
                    }""",
                ),
        )

        val share = repository.createShare(
            scope = TargetScope.SpaceScope("sp-1"),
            itemId = "item-file-1",
            expiresIn = "7d",
            maxViews = 5,
        )

        assertEquals("sh-1", share.id)
        assertEquals("Ab3Cd9", share.token)
        assertEquals("$baseUrl/s/Ab3Cd9", share.url)
        assertEquals("$baseUrl/d/Ab3Cd9", share.directUrl)
        assertEquals(5, share.maxViews)

        val req = server.takeRequest()
        assertEquals("POST", req.method)
        assertEquals("/api/spaces/sp-1/items/item-file-1/shares", req.path)
        assertEquals("Bearer $bearerToken", req.getHeader("Authorization"))
        val body = Json.parseToJsonElement(req.body.readUtf8()).jsonObject
        assertEquals("7d", body["expiresIn"]!!.jsonPrimitive.content)
        assertEquals(5, body["maxViews"]!!.jsonPrimitive.int)
    }

    @Test
    fun createShare_inRoomScope_omitsNullMaxViewsAndSynthesizesUrlFromTokenWhenUrlMissing() = runTest {
        server.enqueue(
            MockResponse()
                .setResponseCode(201)
                .setBody(
                    """{
                      "id":"sh-room-1",
                      "itemId":"item-txt-1",
                      "expiresAt":null,
                      "maxViews":null,
                      "views":0,
                      "revoked":0,
                      "createdAt":1700000000000,
                      "token":"Xy9Za2"
                    }""",
                ),
        )

        val share = repository.createShare(
            scope = TargetScope.RoomScope("rm-1.proof"),
            itemId = "item-txt-1",
            expiresIn = "never",
            maxViews = null,
        )

        assertEquals("$baseUrl/s/Xy9Za2", share.url)
        assertNull(share.directUrl)

        val req = server.takeRequest()
        assertEquals("POST", req.method)
        assertEquals("/api/rooms/rm-1.proof/items/item-txt-1/shares", req.path)
        val body = Json.parseToJsonElement(req.body.readUtf8()).jsonObject
        assertEquals("never", body["expiresIn"]!!.jsonPrimitive.content)
        assertFalse(body.containsKey("maxViews"))
    }

    @Test
    fun listAndRevokeShares_onlyUseScopedBearerRoutesNeverBrowserSessionRoutes() = runTest {
        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setBody(
                    """{"shares":[
                      {"id":"sh-1","itemId":"it-1","expiresAt":1800000000000,"maxViews":3,"views":1,"revoked":0,"createdAt":1700000000000},
                      {"id":"sh-2","itemId":"it-1","expiresAt":null,"maxViews":null,"views":4,"revoked":1,"createdAt":1690000000000}
                    ]}""",
                ),
        )
        server.enqueue(MockResponse().setResponseCode(204))

        val scope = TargetScope.SpaceScope("sp-main")
        val shares = repository.listShares(scope, "it-1")
        assertEquals(2, shares.size)
        assertEquals("sh-1", shares[0].id)
        assertEquals(1, shares[0].views)
        assertEquals(1, shares[1].revoked)

        repository.revokeShare(scope, "sh-1")

        val listReq = server.takeRequest()
        assertEquals("GET", listReq.method)
        assertEquals("/api/spaces/sp-main/items/it-1/shares", listReq.path)
        assertEquals("Bearer $bearerToken", listReq.getHeader("Authorization"))

        val deleteReq = server.takeRequest()
        assertEquals("DELETE", deleteReq.method)
        assertEquals("/api/spaces/sp-main/shares/sh-1", deleteReq.path)
        assertEquals("Bearer $bearerToken", deleteReq.getHeader("Authorization"))
        assertFalse(deleteReq.path!!.startsWith("/api/shares"))
    }

    @Test
    fun invalidInputsAndServerErrors_areHandledCleanly() = runTest {
        try {
            repository.createShare(TargetScope.SpaceScope("sp-1"), itemId = "  ", expiresIn = "1d")
            fail("Expected INVALID_INPUT for blank itemId")
        } catch (e: ApiError) {
            assertEquals(ApiErrorCode.INVALID_INPUT, e.errorCode)
        }

        try {
            repository.createShare(TargetScope.SpaceScope("sp-1"), itemId = "it-1", expiresIn = "1d", maxViews = 0)
            fail("Expected INVALID_INPUT for maxViews=0")
        } catch (e: ApiError) {
            assertEquals(ApiErrorCode.INVALID_INPUT, e.errorCode)
        }

        server.enqueue(
            MockResponse()
                .setResponseCode(403)
                .setBody("""{"error":{"code":"READ_ONLY"}}"""),
        )
        try {
            repository.createShare(TargetScope.SpaceScope("sp-ro"), itemId = "it-1", expiresIn = "1d")
            fail("Expected READ_ONLY error")
        } catch (e: ApiError) {
            assertEquals(ApiErrorCode.READ_ONLY, e.errorCode)
            assertTrue(e.httpStatus == 403)
        }
    }
}
