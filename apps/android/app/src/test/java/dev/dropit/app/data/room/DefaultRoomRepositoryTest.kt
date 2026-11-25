package dev.dropit.app.data.room

import dev.dropit.app.core.auth.AppSettings
import dev.dropit.app.core.auth.InMemorySettingsStore
import dev.dropit.app.core.network.ApiError
import dev.dropit.app.core.network.ApiErrorCode
import dev.dropit.app.core.network.DropitApiClient
import dev.dropit.app.core.network.OptionalField
import dev.dropit.app.core.network.SessionCredentialsProvider
import dev.dropit.app.core.network.SessionExpiredEvent
import dev.dropit.app.core.network.TargetScope
import dev.dropit.app.core.repository.DefaultBoardRepository
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

class DefaultRoomRepositoryTest {

    private lateinit var server: MockWebServer
    private lateinit var okHttpClient: OkHttpClient
    private lateinit var baseUrl: String
    private lateinit var settingsStore: InMemorySettingsStore
    private lateinit var roomKeyStore: InMemoryRoomKeyStore
    private lateinit var apiClient: DropitApiClient
    private lateinit var repository: DefaultRoomRepository

    private var bearerToken: String? = "tok_room_test_01234567890123456789012345678901"

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        baseUrl = server.url("/").toString().trimEnd('/')
        okHttpClient = OkHttpClient.Builder().build()
        settingsStore = InMemorySettingsStore(
            AppSettings(
                serverOrigin = baseUrl,
                deviceId = "and-RoomTestDevice123456",
            ),
        )
        roomKeyStore = InMemoryRoomKeyStore()
        val creds = object : SessionCredentialsProvider {
            override suspend fun serverOrigin(): String? = settingsStore.getServerOrigin()
            override suspend fun accessToken(): String? = bearerToken
            override suspend fun deviceId(): String = settingsStore.getOrCreateDeviceId()
            override fun deviceName(): String = "dropit Android · RoomTest"
        }
        apiClient = DropitApiClient(
            okHttpClient = okHttpClient,
            credentialsProvider = creds,
            allowInsecureHttpForTest = true,
        )
        repository = DefaultRoomRepository(
            apiClient = apiClient,
            roomKeyStore = roomKeyStore,
            settingsStore = settingsStore,
        )
    }

    @After
    fun tearDown() {
        server.shutdown()
        okHttpClient.dispatcher.executorService.shutdown()
        okHttpClient.connectionPool.evictAll()
    }

    @Test
    fun createOrReuseRoom_persistsServerScopedDeviceKeyAndSupportsCustomCodeAndPin() = runTest {
        server.enqueue(
            MockResponse()
                .setResponseCode(201)
                .setBody(
                    """{"token":"space-1.proof123","code":"team-alpha","hasPin":true,"expiresAt":1800000000000,"url":"/r/team-alpha","reused":false}""",
                ),
        )
        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setBody(
                    """{"token":"space-1.proof123","code":"team-alpha","hasPin":true,"expiresAt":1800000000000,"url":"$baseUrl/r/team-alpha","reused":true}""",
                ),
        )

        val created = repository.createOrReuseRoom(code = " team-alpha ", pin = "8848")
        assertEquals("space-1.proof123", created.token)
        assertEquals("team-alpha", created.code)
        assertTrue(created.hasPin)
        assertFalse(created.reused)
        assertEquals("$baseUrl/r/team-alpha", created.url)
        assertEquals(created, repository.activeRoom.value)
        assertTrue(repository.isOwnedRoom("space-1.proof123"))

        val req1 = server.takeRequest()
        assertEquals("POST", req1.method)
        assertEquals("/api/rooms", req1.path)
        assertEquals("Bearer $bearerToken", req1.getHeader("Authorization"))
        val body1 = Json.parseToJsonElement(req1.body.readUtf8()).jsonObject
        val key1 = body1["deviceKey"]!!.jsonPrimitive.content
        assertTrue(RoomKeyGenerator.isValidDeviceKey(key1))
        assertEquals("team-alpha", body1["code"]!!.jsonPrimitive.content)
        assertEquals("8848", body1["pin"]!!.jsonPrimitive.content)

        // Second call reuses the exact same server-scoped secret deviceKey
        val reused = repository.createOrReuseRoom()
        assertTrue(reused.reused)
        val req2 = server.takeRequest()
        val body2 = Json.parseToJsonElement(req2.body.readUtf8()).jsonObject
        assertEquals(key1, body2["deviceKey"]!!.jsonPrimitive.content)
        assertFalse(body2.containsKey("code"))
        assertFalse(body2.containsKey("pin"))
    }

    @Test
    fun deviceKeys_areIsolatedPerServerOrigin() = runTest {
        val keyA = roomKeyStore.getOrCreateDeviceKey("https://server-a.dropit.dev")
        val keyB = roomKeyStore.getOrCreateDeviceKey("https://server-b.dropit.dev")
        assertTrue(RoomKeyGenerator.isValidDeviceKey(keyA))
        assertTrue(RoomKeyGenerator.isValidDeviceKey(keyB))
        assertNotEquals(keyA, keyB)
        assertEquals(keyA, roomKeyStore.getDeviceKey("https://SERVER-A.dropit.dev/"))
    }

    @Test
    fun enterRoom_handlesPinRequiredWithoutTriggeringGlobal401Logout() = runTest {
        server.enqueue(
            MockResponse()
                .setResponseCode(401)
                .setBody("""{"error":{"code":"PIN_REQUIRED"}}"""),
        )
        server.enqueue(
            MockResponse()
                .setResponseCode(403)
                .setBody("""{"error":{"code":"PIN_INVALID"}}"""),
        )
        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setBody(
                    """{"token":"space-2.proof999","code":"Rm4kQ2","hasPin":true,"expiresAt":1800000000000,"url":"/r/Rm4kQ2"}""",
                ),
        )

        val expiredCollector = async(start = CoroutineStart.UNDISPATCHED) {
            withTimeoutOrNull(150L) { apiClient.sessionExpiredEvents.first() }
        }

        // 1. Missing PIN -> 401 PIN_REQUIRED must NOT emit sessionExpiredEvents
        try {
            repository.enterRoom(code = "Rm4kQ2")
            fail("Expected PIN_REQUIRED ApiError")
        } catch (e: ApiError) {
            assertEquals(ApiErrorCode.PIN_REQUIRED, e.errorCode)
            assertEquals(401, e.httpStatus)
            assertTrue(e.userMessage.contains("PIN"))
        }

        // 2. Wrong PIN -> 403 PIN_INVALID
        try {
            repository.enterRoom(code = "Rm4kQ2", pin = "0000")
            fail("Expected PIN_INVALID ApiError")
        } catch (e: ApiError) {
            assertEquals(ApiErrorCode.PIN_INVALID, e.errorCode)
            assertEquals(403, e.httpStatus)
        }

        // 3. Correct PIN -> enters room and sets activeRoom
        val entered = repository.enterRoom(code = "Rm4kQ2", pin = "2468")
        assertEquals("space-2.proof999", entered.token)
        assertEquals("Rm4kQ2", entered.code)
        assertEquals("$baseUrl/r/Rm4kQ2", entered.url)
        assertEquals(entered, repository.activeRoom.value)
        assertEquals("space-2.proof999", roomKeyStore.getRememberedRoomToken(baseUrl, "Rm4kQ2"))

        val sessionExpired: SessionExpiredEvent? = expiredCollector.await()
        assertNull("PIN_REQUIRED must never emit global sessionExpiredEvents", sessionExpired)
    }

    @Test
    fun enterRoom_emitsSessionExpiredWhenServerReturns401Unauthenticated() = runTest {
        server.enqueue(
            MockResponse()
                .setResponseCode(401)
                .setBody("""{"error":{"code":"UNAUTHENTICATED"}}"""),
        )

        val expiredEvent = async(start = CoroutineStart.UNDISPATCHED) { apiClient.sessionExpiredEvents.first() }

        try {
            repository.enterRoom(code = "Rm4kQ2")
            fail("Expected UNAUTHENTICATED ApiError")
        } catch (e: ApiError) {
            assertEquals(ApiErrorCode.UNAUTHENTICATED, e.errorCode)
            assertEquals(401, e.httpStatus)
        }

        val emitted = expiredEvent.await()
        assertEquals(baseUrl, emitted.serverOrigin)
        assertEquals("/api/rooms/enter", emitted.path)
    }

    @Test
    fun enterRoom_mapsExpiredClosedAndLockedErrorCodesClearly() = runTest {
        // 404 NOT_FOUND (expired or closed)
        server.enqueue(
            MockResponse()
                .setResponseCode(404)
                .setBody("""{"error":{"code":"NOT_FOUND"}}"""),
        )
        try {
            repository.enterRoom(code = "dead99")
            fail("Expected NOT_FOUND")
        } catch (e: ApiError) {
            assertEquals(ApiErrorCode.NOT_FOUND, e.errorCode)
            assertTrue(e.userMessage.contains("过期") || e.userMessage.contains("关闭"))
        }

        // 429 RATE_LIMITED with Retry-After (PIN lockout)
        server.enqueue(
            MockResponse()
                .setResponseCode(429)
                .addHeader("Retry-After", "45")
                .setBody("""{"error":{"code":"RATE_LIMITED"}}"""),
        )
        try {
            repository.enterRoom(code = "locked1", pin = "1234")
            fail("Expected RATE_LIMITED")
        } catch (e: ApiError) {
            assertEquals(ApiErrorCode.RATE_LIMITED, e.errorCode)
            assertEquals(45L, e.retryAfterSeconds)
            assertTrue(e.userMessage.contains("45"))
            assertTrue(e.userMessage.contains("锁定"))
        }

        // Blank code rejected client-side
        try {
            repository.enterRoom(code = "   ")
            fail("Expected INVALID_CODE")
        } catch (e: ApiError) {
            assertEquals(ApiErrorCode.INVALID_CODE, e.errorCode)
        }
    }

    @Test
    fun updateRoomCode_supportsCustomRandomCodeAndPinRemovalWhilePreservingTokenAndExpiry() = runTest {
        // Seed active room via createOrReuseRoom
        server.enqueue(
            MockResponse()
                .setResponseCode(201)
                .setBody(
                    """{"token":"space-own.proof001","code":"AbC123","hasPin":true,"expiresAt":1900000000000,"url":"/r/AbC123","reused":false}""",
                ),
        )
        val created = repository.createOrReuseRoom(code = "AbC123", pin = "9999")
        val savedKey = roomKeyStore.getDeviceKey(baseUrl)!!
        server.takeRequest()

        // 1. Update code to custom 6-char code and remove PIN (pin = Present(null))
        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setBody("""{"code":"XyZ789","hasPin":false,"url":"/r/XyZ789"}"""),
        )
        val updated = repository.updateRoomCode(
            roomToken = created.token,
            code = OptionalField.Present("XyZ789"),
            pin = OptionalField.Present(null),
        )
        assertEquals("space-own.proof001", updated.token)
        assertEquals("XyZ789", updated.code)
        assertFalse(updated.hasPin)
        assertEquals(1900000000000L, updated.expiresAt)
        assertEquals("$baseUrl/r/XyZ789", updated.url)
        assertEquals(updated, repository.activeRoom.value)
        assertNull(roomKeyStore.getRememberedRoomToken(baseUrl, "AbC123"))
        assertEquals("space-own.proof001", roomKeyStore.getRememberedRoomToken(baseUrl, "XyZ789"))

        val putReq1 = server.takeRequest()
        assertEquals("PUT", putReq1.method)
        assertEquals("/api/rooms/space-own.proof001/code", putReq1.path)
        val putBody1 = Json.parseToJsonElement(putReq1.body.readUtf8()).jsonObject
        assertEquals(savedKey, putBody1["deviceKey"]!!.jsonPrimitive.content)
        assertEquals("XyZ789", putBody1["code"]!!.jsonPrimitive.content)
        assertEquals(JsonNull, putBody1["pin"])

        // 2. Request a fresh random code (code = Present(null)), keep PIN absent
        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setBody("""{"code":"k7Rm2x","hasPin":false,"url":"$baseUrl/r/k7Rm2x"}"""),
        )
        val randomized = repository.updateRoomCode(
            roomToken = created.token,
            code = OptionalField.Present(null),
            pin = OptionalField.Absent,
        )
        assertEquals("k7Rm2x", randomized.code)
        val putReq2 = server.takeRequest()
        val putBody2 = Json.parseToJsonElement(putReq2.body.readUtf8()).jsonObject
        assertEquals(JsonNull, putBody2["code"])
        assertFalse(putBody2.containsKey("pin"))

        // 3. Non-owner 403 FORBIDDEN & 409 CODE_TAKEN mapping
        server.enqueue(
            MockResponse()
                .setResponseCode(403)
                .setBody("""{"error":{"code":"FORBIDDEN"}}"""),
        )
        try {
            repository.updateRoomCode(created.token, code = OptionalField.Present("QwEr12"))
            fail("Expected FORBIDDEN")
        } catch (e: ApiError) {
            assertEquals(ApiErrorCode.FORBIDDEN, e.errorCode)
            assertTrue(e.userMessage.contains("创建设备"))
        }

        server.enqueue(
            MockResponse()
                .setResponseCode(409)
                .setBody("""{"error":{"code":"CODE_TAKEN"}}"""),
        )
        try {
            repository.updateRoomCode(created.token, code = OptionalField.Present("Taken1"))
            fail("Expected CODE_TAKEN")
        } catch (e: ApiError) {
            assertEquals(ApiErrorCode.CODE_TAKEN, e.errorCode)
            assertTrue(e.userMessage.contains("占用"))
        }
    }

    @Test
    fun roomScope_seamlesslyWorksWithBoardOperationsAndClearRoomStateWipesSecrets() = runTest {
        server.enqueue(
            MockResponse()
                .setResponseCode(201)
                .setBody(
                    """{"token":"rm-42.secproof","code":"Rm42ab","hasPin":false,"expiresAt":1900000000000,"url":"/r/Rm42ab","reused":false}""",
                ),
        )
        repository.createOrReuseRoom()
        server.takeRequest()

        val roomScope = repository.activeRoomScope()
        assertNotNull(roomScope)
        assertEquals(TargetScope.RoomScope("rm-42.secproof"), roomScope)

        // Seamless board operations over /api/rooms/:room/*
        val boardRepo = DefaultBoardRepository(apiClient)
        server.enqueue(
            MockResponse()
                .setResponseCode(201)
                .setBody(
                    """{"item":{"id":"it-1","spaceId":"rm-42","kind":"text","text":"hello room","size":10,"createdAt":100,"updatedAt":100,"expiresAt":200}}""",
                ),
        )
        val item = boardRepo.createText(roomScope!!, "hello room")
        assertEquals("hello room", item.text)
        val textReq = server.takeRequest()
        assertEquals("/api/rooms/rm-42.secproof/items/text", textReq.path)

        // leaveCurrentRoom clears activeRoom but retains persisted deviceKey
        repository.leaveCurrentRoom()
        assertNull(repository.activeRoom.value)
        assertNotNull(roomKeyStore.getDeviceKey(baseUrl))

        // clearRoomState wipes activeRoom AND all persisted secret room keys
        repository.clearRoomState()
        assertNull(repository.activeRoom.value)
        assertNull(roomKeyStore.getDeviceKey(baseUrl))
        assertTrue(roomKeyStore.allOrigins().isEmpty())
    }
}
