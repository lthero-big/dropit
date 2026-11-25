package dev.dropit.app.core.auth

import android.content.Intent
import dev.dropit.app.core.network.ApiError
import dev.dropit.app.core.network.ApiErrorCode
import dev.dropit.app.core.network.DropitApiClient
import dev.dropit.app.core.network.SessionCredentialsProvider
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

class NativeAuthAndOAuthTest {

    private lateinit var server: MockWebServer
    private lateinit var okHttpClient: OkHttpClient
    private lateinit var settingsStore: InMemorySettingsStore
    private lateinit var tokenVault: InMemoryTokenVault
    private lateinit var apiClient: DropitApiClient
    private lateinit var authRepository: DefaultAuthRepository
    private lateinit var baseUrl: String
    private var nextState: String = "fixedAppState_1234567890"

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
            override fun deviceName(): String = "dropit Android · Pixel9"
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
            deviceNameProvider = { "dropit Android · Pixel9" },
            stateGenerator = { nextState },
        )
    }

    @After
    fun tearDown() {
        server.shutdown()
        okHttpClient.dispatcher.executorService.shutdown()
        okHttpClient.connectionPool.evictAll()
    }

    @Test
    fun getAuthProviders_parsesEnabledProvidersAndPasswordFlag() = runTest {
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """{"providers":["github","google"],"password":true,"registration":"invite","setupRequired":false}""",
            ),
        )
        val info = authRepository.getAuthProviders(baseUrl)
        assertEquals(listOf("github", "google"), info.providers)
        assertTrue(info.password)
        assertEquals("invite", info.registration)
        assertFalse(info.setupRequired)
        val req = server.takeRequest()
        assertEquals("GET", req.method)
        assertEquals("/api/auth/providers", req.path)
        assertNull(req.getHeader("Authorization"))
    }

    @Test
    fun loginWithPassword_persistsTokenScopesAndMustChangePassword() = runTest {
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """
                {
                  "access_token": "tok_pwd_admin_12345678901234567890123456789",
                  "token_type": "Bearer",
                  "scope": "read write account admin",
                  "expires_in": 31536000,
                  "user": { "id": "u1", "email": "admin@example.com", "name": "Admin", "role": "admin" },
                  "mustChangePassword": true
                }
                """.trimIndent(),
            ),
        )

        val res = authRepository.loginWithPassword(baseUrl, "admin@example.com", "TempPass123!")
        assertEquals("u1", res.user.id)
        assertTrue(res.user.isAdmin)
        assertTrue(res.mustChangePassword)
        assertEquals(setOf("read", "write", "account", "admin"), res.parsedScopes)

        val req = server.takeRequest()
        assertEquals("POST", req.method)
        assertEquals("/api/auth/app/password/login", req.path)
        val sent = Json.parseToJsonElement(req.body.readUtf8()) as JsonObject
        assertEquals("admin@example.com", sent["email"]?.jsonPrimitive?.content)
        assertEquals("TempPass123!", sent["password"]?.jsonPrimitive?.content)
        assertEquals("dropit Android · Pixel9", sent["deviceName"]?.jsonPrimitive?.content)

        assertEquals("tok_pwd_admin_12345678901234567890123456789", tokenVault.getToken())
        assertEquals(baseUrl, settingsStore.getServerOrigin())
        assertTrue(authRepository.sessionState.value.isSignedIn)
        assertTrue(authRepository.hasAccountScope)
        assertTrue(authRepository.hasAdminScope)
        assertTrue(authRepository.sessionState.value.mustChangePassword)
        assertEquals(AccountCapabilityState.Ready(hasAdminScope = true), authRepository.accountCapability.value)

        // Marking password changed clears mustChangePassword flag
        authRepository.markPasswordChanged()
        assertFalse(authRepository.sessionState.value.mustChangePassword)
    }

    @Test
    fun loginWithPassword_mapsAuthErrorsWithoutMutatingSession() = runTest {
        server.enqueue(MockResponse().setResponseCode(401).setBody("""{"error":{"code":"INVALID_CREDENTIALS"}}"""))
        try {
            authRepository.loginWithPassword(baseUrl, "u@example.com", "wrong")
            fail("Expected INVALID_CREDENTIALS")
        } catch (e: ApiError) {
            assertEquals(401, e.httpStatus)
            assertEquals(ApiErrorCode.INVALID_CREDENTIALS, e.errorCode)
        }
        assertFalse(authRepository.sessionState.value.isSignedIn)
        assertNull(tokenVault.getToken())

        server.enqueue(MockResponse().setResponseCode(403).setBody("""{"error":{"code":"USER_DISABLED"}}"""))
        try {
            authRepository.loginWithPassword(baseUrl, "u@example.com", "pass1234")
            fail("Expected USER_DISABLED")
        } catch (e: ApiError) {
            assertEquals(403, e.httpStatus)
            assertEquals(ApiErrorCode.USER_DISABLED, e.errorCode)
        }
    }

    @Test
    fun oauthLoginFlow_buildsLaunchUrlValidatesStateAndExchangesCode() = runTest {
        nextState = "oauthState_valid_001"
        val pending = authRepository.startAppOAuthLogin(baseUrl, "github", invite = "inv-123")
        assertEquals("github", pending.provider)
        assertEquals("oauthState_valid_001", pending.state)
        assertTrue(pending.launchUrl.startsWith("$baseUrl/api/auth/github?"))
        assertTrue(pending.launchUrl.contains("app_redirect=dropit%3A%2F%2Fauth%2Fcallback"))
        assertTrue(pending.launchUrl.contains("app_state=oauthState_valid_001"))
        assertTrue(pending.launchUrl.contains("device_name="))
        assertTrue(pending.launchUrl.contains("invite=inv-123"))

        // Mismatched state is rejected without consuming valid state
        val mismatchPayload = OAuthCallbackParser.parse("dropit://auth/callback?code=code_abc&state=wrong_state")!!
        val mismatchResult = authRepository.handleOAuthLoginCallback(mismatchPayload)
        assertTrue(mismatchResult is OAuthLoginResult.Failed)
        assertEquals(ApiErrorCode.OAUTH_STATE_INVALID, (mismatchResult as OAuthLoginResult.Failed).error.errorCode)

        // Matching state exchanges code via POST /api/auth/app/oauth/exchange
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """
                {
                  "access_token": "tok_oauth_user_1234567890123456789012345678",
                  "token_type": "Bearer",
                  "scope": "read write account",
                  "expires_in": 31536000,
                  "user": { "id": "u2", "email": "gh@example.com", "name": "GH User", "role": "user" },
                  "mustChangePassword": false
                }
                """.trimIndent(),
            ),
        )
        val validPayload = OAuthCallbackParser.parse(
            "dropit://auth/callback?code=exchange_code_43chars_abcdefghijklmnopqrstu&state=oauthState_valid_001",
        )!!
        val result = authRepository.handleOAuthLoginCallback(validPayload)
        assertTrue("Expected success, got $result", result is OAuthLoginResult.Success)
        val success = result as OAuthLoginResult.Success
        assertEquals("gh@example.com", success.response.user.email)
        assertTrue(authRepository.hasAccountScope)
        assertFalse(authRepository.hasAdminScope)
        assertEquals(AccountCapabilityState.Ready(hasAdminScope = false), authRepository.accountCapability.value)

        val exchangeReq = server.takeRequest()
        assertEquals("POST", exchangeReq.method)
        assertEquals("/api/auth/app/oauth/exchange", exchangeReq.path)
        val body = Json.parseToJsonElement(exchangeReq.body.readUtf8()) as JsonObject
        assertEquals("exchange_code_43chars_abcdefghijklmnopqrstu", body["code"]?.jsonPrimitive?.content)
        assertEquals("dropit Android · Pixel9", body["deviceName"]?.jsonPrimitive?.content)
    }

    @Test
    fun oauthLoginCallback_handlesProviderError() = runTest {
        nextState = "oauthState_err_002"
        authRepository.startAppOAuthLogin(baseUrl, "google")

        val errPayload = OAuthCallbackParser.parse("dropit://auth/callback?error=OAUTH_DENIED&state=oauthState_err_002")!!
        val result = authRepository.handleOAuthLoginCallback(errPayload)
        assertTrue(result is OAuthLoginResult.Failed)
        assertEquals(ApiErrorCode.OAUTH_DENIED, (result as OAuthLoginResult.Failed).error.errorCode)
        assertFalse(authRepository.sessionState.value.isSignedIn)
    }

    @Test
    fun oauthLinkFlow_sendsAppStateAndEmitsLinkedEvent() = runTest {
        authRepository.completeAuthorizationWithMetadata(
            serverOrigin = baseUrl,
            token = "tok_account_1234567890123456789012345678901",
            scopes = setOf("read", "write", "account"),
        )
        nextState = "linkState_valid_003"
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """
                {
                  "ticket": "ticket_43chars_1234567890123456789012345678",
                  "state": "linkState_valid_003",
                  "path": "/api/auth/google?link_ticket=ticket_43chars_1234567890123456789012345678&app_redirect=dropit%3A%2F%2Fauth%2Fcallback&app_state=linkState_valid_003",
                  "url": "$baseUrl/api/auth/google?link_ticket=ticket_43chars_1234567890123456789012345678&app_redirect=dropit%3A%2F%2Fauth%2Fcallback&app_state=linkState_valid_003",
                  "expires_in": 60
                }
                """.trimIndent(),
            ),
        )

        val pendingLink = authRepository.startAppOAuthLink("google")
        assertEquals("google", pendingLink.provider)
        assertEquals("linkState_valid_003", pendingLink.state)
        assertTrue(pendingLink.launchUrl.startsWith("$baseUrl/api/auth/google?"))

        val linkReq = server.takeRequest()
        assertEquals("POST", linkReq.method)
        assertEquals("/api/me/identities/google/app-link", linkReq.path)
        val sentBody = Json.parseToJsonElement(linkReq.body.readUtf8()) as JsonObject
        // Contract: request field must be appState (or app_state), never state
        assertEquals("linkState_valid_003", sentBody["appState"]?.jsonPrimitive?.content)
        assertNull(sentBody["state"])

        val eventDeferred = async(start = CoroutineStart.UNDISPATCHED) {
            authRepository.oauthLinkEvents.first()
        }
        val callbackPayload = OAuthCallbackParser.parse(
            "dropit://auth/callback?linked=google&already=1&state=linkState_valid_003",
        )!!
        val outcome = authRepository.handleOAuthLinkCallback(callbackPayload)
        assertEquals(OAuthLinkResult.Linked(provider = "google", alreadyLinked = true), outcome)
        assertEquals(outcome, eventDeferred.await())
    }

    @Test
    fun legacyDeviceToken_exposesInsufficientScopeCapabilityUntilReauth() = runTest {
        authRepository.completeAuthorizationWithMetadata(
            serverOrigin = baseUrl,
            token = "tok_legacy_rw_12345678901234567890123456789",
            scopes = setOf("read", "write"),
        )
        assertTrue(authRepository.sessionState.value.isSignedIn)
        assertFalse(authRepository.hasAccountScope)
        assertFalse(authRepository.hasAdminScope)
        assertTrue(authRepository.accountCapability.value is AccountCapabilityState.InsufficientScopeForAccountSettings)

        // Even if scopes were previously unknown (migrated from 0.4.0), capability is InsufficientScopeForAccountSettings
        authRepository.completeAuthorization(baseUrl, "tok_migrated_123456789012345678901234567890")
        assertFalse(authRepository.hasAccountScope)
        assertTrue(authRepository.accountCapability.value is AccountCapabilityState.InsufficientScopeForAccountSettings)
    }

    @Test
    fun oauthCallbackParserAndBus_handlesValidInvalidAndHistoryFlags() = runTest {
        assertNull(OAuthCallbackParser.parse("https://dropit.example.com/auth/callback?code=1&state=s"))
        assertNull(OAuthCallbackParser.parse("dropit://other/callback?code=1&state=s"))
        assertNull(OAuthCallbackParser.parse("dropit://auth/callback?code=only_code_no_state"))
        assertNull(OAuthCallbackParser.parse("dropit://auth/callback?state=only_state"))

        assertTrue(OAuthCallbackGuard.shouldCapture(Intent.ACTION_VIEW, "dropit://auth/callback?code=a&state=b", 0))
        assertFalse(
            OAuthCallbackGuard.shouldCapture(
                Intent.ACTION_VIEW,
                "dropit://auth/callback?code=a&state=b",
                Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY,
            ),
        )
        assertFalse(OAuthCallbackGuard.shouldCapture(Intent.ACTION_SEND, "dropit://auth/callback?code=a&state=b", 0))

        val bus = OAuthCallbackBus()
        val liveEvent = async(start = CoroutineStart.UNDISPATCHED) { bus.events.first() }
        assertTrue(bus.onCallbackUri("dropit://auth/callback?code=abc123&state=st123456"))
        val expected = OAuthCallbackPayload.LoginCode(code = "abc123", state = "st123456")
        assertEquals(expected, liveEvent.await())
        assertEquals(expected, bus.pendingCallback.value)
        assertEquals(expected, bus.consumePendingCallback())
        assertNull(bus.pendingCallback.value)
        assertNotNull(DefaultAuthRepository.generateAppState())
    }
}
