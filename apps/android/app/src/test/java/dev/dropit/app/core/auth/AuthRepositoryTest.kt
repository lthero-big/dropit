package dev.dropit.app.core.auth

import dev.dropit.app.core.network.DropitApiClient
import dev.dropit.app.core.network.SessionCredentialsProvider
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class AuthRepositoryTest {

    private lateinit var server: MockWebServer
    private lateinit var okHttpClient: OkHttpClient
    private lateinit var settingsStore: InMemorySettingsStore
    private lateinit var tokenVault: InMemoryTokenVault
    private lateinit var apiClient: DropitApiClient
    private lateinit var authRepository: DefaultAuthRepository
    private lateinit var baseUrl: String

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        baseUrl = server.url("/").toString().trimEnd('/')
        okHttpClient = OkHttpClient.Builder().build()
        settingsStore = InMemorySettingsStore()
        tokenVault = InMemoryTokenVault()

        val creds = object : SessionCredentialsProvider {
            override suspend fun serverOrigin(): String? = settingsStore.getServerOrigin()
            override suspend fun accessToken(): String? = tokenVault.getToken()
            override suspend fun deviceId(): String = settingsStore.getOrCreateDeviceId()
            override fun deviceName(): String = "dropit Android · TestPhone"
        }
        apiClient = DropitApiClient(
            okHttpClient = okHttpClient,
            credentialsProvider = creds,
            allowInsecureHttpForTest = true,
        )
        authRepository = DefaultAuthRepository(
            apiClient = apiClient,
            settingsStore = settingsStore,
            tokenVault = tokenVault,
            deviceNameProvider = { "dropit Android · TestPhone" },
        )
    }

    @After
    fun tearDown() {
        server.shutdown()
        okHttpClient.dispatcher.executorService.shutdown()
        okHttpClient.connectionPool.evictAll()
    }

    @Test
    fun startDeviceAuthorization_defaultsToReadWriteAndFallsBackFromWebScope() = runTest {
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """
                {
                  "device_code":"dev_code_1",
                  "user_code":"ABCD-EFGH",
                  "verification_uri":"$baseUrl/device",
                  "verification_id":"vid-1",
                  "verification_uri_complete":"$baseUrl/device?user_code=ABCD-EFGH",
                  "expires_in":600,
                  "interval":5
                }
                """.trimIndent(),
            ),
        )

        val auth = authRepository.startDeviceAuthorization(baseUrl)
        assertEquals("ABCD-EFGH", auth.userCode)
        val req1 = server.takeRequest()
        assertEquals("/api/auth/device/authorize", req1.path)
        val body1 = req1.body.readUtf8()
        assertTrue(body1.contains("\"read\""))
        assertTrue(body1.contains("\"write\""))
        assertFalse(body1.contains("\"web\""))

        // Extended web scope rejected by older server -> automatic fallback to read+write
        server.enqueue(MockResponse().setResponseCode(400).setBody("""{"error":{"code":"INVALID_INPUT"}}"""))
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """
                {
                  "device_code":"dev_code_2",
                  "user_code":"WXYZ-2345",
                  "verification_uri":"$baseUrl/device",
                  "verification_uri_complete":"$baseUrl/device?user_code=WXYZ-2345",
                  "expires_in":600,
                  "interval":5
                }
                """.trimIndent(),
            ),
        )
        val fallbackAuth = authRepository.startDeviceAuthorization(baseUrl, AuthRepository.EXTENDED_WEB_SCOPES)
        assertEquals("WXYZ-2345", fallbackAuth.userCode)
        assertTrue(server.takeRequest().body.readUtf8().contains("\"web\""))
        assertFalse(server.takeRequest().body.readUtf8().contains("\"web\""))
    }

    @Test
    fun pollDeviceAuthorization_handlesPendingSlowDownAndTokenPersistence() = runTest {
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """
                {
                  "device_code":"dev_poll_1",
                  "user_code":"1111-2222",
                  "verification_uri":"$baseUrl/device",
                  "verification_uri_complete":"$baseUrl/device?user_code=1111-2222",
                  "expires_in":600,
                  "interval":5
                }
                """.trimIndent(),
            ),
        )
        server.enqueue(MockResponse().setResponseCode(400).setBody("""{"error":"authorization_pending"}"""))
        server.enqueue(MockResponse().setResponseCode(400).setBody("""{"error":"slow_down"}"""))
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """
                {
                  "access_token":"tok_approved_secret_value_1234567890",
                  "token_type":"Bearer",
                  "scope":"read write",
                  "expires_in":31536000
                }
                """.trimIndent(),
            ),
        )

        val auth = authRepository.startDeviceAuthorization(baseUrl)
        val observedDelays = mutableListOf<Long>()
        val states = authRepository.pollDeviceAuthorization(
            serverOrigin = baseUrl,
            authorization = auth,
            delayMillis = { observedDelays.add(it) },
        ).toList()

        // Delays: 5s (before pending), 5s (before slow_down), 10s (after +5s slow_down before token)
        assertEquals(listOf(5_000L, 5_000L, 10_000L), observedDelays)
        assertTrue(states[0] is DeviceAuthState.WaitingForApproval)
        assertEquals(5, (states[0] as DeviceAuthState.WaitingForApproval).pollIntervalSeconds)
        assertTrue(states[1] is DeviceAuthState.WaitingForApproval)
        assertEquals(10, (states[1] as DeviceAuthState.WaitingForApproval).pollIntervalSeconds)
        assertTrue(states.last() is DeviceAuthState.Approved)
        assertEquals("read write", (states.last() as DeviceAuthState.Approved).scope)

        assertEquals(baseUrl, settingsStore.getServerOrigin())
        assertEquals("tok_approved_secret_value_1234567890", tokenVault.getToken())
        assertTrue(authRepository.sessionState.value.isSignedIn)
    }

    @Test
    fun pollDeviceAuthorization_handlesDeniedAndExpired() = runTest {
        server.enqueue(MockResponse().setResponseCode(400).setBody("""{"error":"access_denied"}"""))
        val auth = dev.dropit.app.core.network.DeviceAuthorizeResponse(
            deviceCode = "dc-deny",
            userCode = "DENY-0001",
            verificationUri = "$baseUrl/device",
            verificationUriComplete = "$baseUrl/device",
            interval = 2,
        )
        val deniedStates = authRepository.pollDeviceAuthorization(baseUrl, auth, delayMillis = {}).toList()
        assertEquals(DeviceAuthState.Denied, deniedStates.last())
        assertNull(tokenVault.getToken())

        server.enqueue(MockResponse().setResponseCode(400).setBody("""{"error":{"code":"EXPIRED_TOKEN"}}"""))
        val expiredStates = authRepository.pollDeviceAuthorization(baseUrl, auth, delayMillis = {}).toList()
        assertEquals(DeviceAuthState.Expired, expiredStates.last())
        assertNull(tokenVault.getToken())
    }

    @Test
    fun logout_revokesTokenAndOptionallyClearsServer() = runTest {
        settingsStore.setServerOrigin(baseUrl)
        tokenVault.saveToken("tok_active_123456789012345678901234567890")
        authRepository.refreshSessionState()
        assertTrue(authRepository.sessionState.value.isSignedIn)

        server.enqueue(MockResponse().setResponseCode(204))
        authRepository.logout(clearServer = false)

        val req = server.takeRequest()
        assertEquals("POST", req.method)
        assertEquals("/api/auth/logout", req.path)
        assertEquals("Bearer tok_active_123456789012345678901234567890", req.getHeader("Authorization"))
        assertNull(tokenVault.getToken())
        assertEquals(baseUrl, settingsStore.getServerOrigin())
        assertFalse(authRepository.sessionState.value.isSignedIn)

        // Logout with clearServer=true even if server returns 401
        tokenVault.saveToken("tok_revoked_12345678901234567890123456789")
        server.enqueue(MockResponse().setResponseCode(401))
        authRepository.logout(clearServer = true)
        assertNull(tokenVault.getToken())
        assertNull(settingsStore.getServerOrigin())
    }

    @Test
    fun clearLocalSession_neverCallsRemoteLogoutAndOptionallyPreservesServer() = runTest {
        settingsStore.setServerOrigin(baseUrl)
        tokenVault.saveToken("tok_local_only_12345678901234567890123456")
        authRepository.refreshSessionState()
        assertTrue(authRepository.sessionState.value.isSignedIn)

        authRepository.clearLocalSession(clearServer = false)

        assertEquals(0, server.requestCount)
        assertNull(tokenVault.getToken())
        assertEquals(baseUrl, settingsStore.getServerOrigin())
        assertFalse(authRepository.sessionState.value.isSignedIn)
        assertEquals(DeviceAuthState.Idle, authRepository.deviceAuthState.value)

        // Clearing local session with clearServer = true also never calls POST /api/auth/logout
        tokenVault.saveToken("tok_local_only_2_123456789012345678901234")
        authRepository.refreshSessionState()
        authRepository.clearLocalSession(clearServer = true)

        assertEquals(0, server.requestCount)
        assertNull(tokenVault.getToken())
        assertNull(settingsStore.getServerOrigin())
        assertFalse(authRepository.sessionState.value.isSignedIn)
    }
}
