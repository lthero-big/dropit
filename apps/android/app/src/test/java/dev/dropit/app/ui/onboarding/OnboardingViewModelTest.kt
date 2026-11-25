package dev.dropit.app.ui.onboarding

import dev.dropit.app.core.auth.AuthRepository
import dev.dropit.app.core.auth.AuthSessionState
import dev.dropit.app.core.auth.DeviceAuthState
import dev.dropit.app.core.auth.DevicePollOutcome
import dev.dropit.app.core.auth.OAuthCallbackBus
import dev.dropit.app.core.auth.OAuthCallbackPayload
import dev.dropit.app.core.auth.OAuthLoginResult
import dev.dropit.app.core.auth.PendingOAuthLogin
import dev.dropit.app.core.network.ApiError
import dev.dropit.app.core.network.ApiErrorCode
import dev.dropit.app.core.network.AppAuthTokenResponse
import dev.dropit.app.core.network.AppAuthUser
import dev.dropit.app.core.network.AuthProvidersInfo
import dev.dropit.app.core.network.DeviceAuthorizeResponse
import dev.dropit.app.core.network.VerifiedServer
import dev.dropit.app.core.network.VersionInfo
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.IOException

@OptIn(ExperimentalCoroutinesApi::class)
class OnboardingViewModelTest {

    private val testDispatcher = StandardTestDispatcher()

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    @Test
    fun submitServerUrl_normalizesBareDomainVerifiesAndLoadsAuthProvidersWithoutAutoStartingDeviceCode() =
        runTest(testDispatcher) {
            val fakeAuth = FakeAuthRepository(
                providersInfo = AuthProvidersInfo(
                    providers = listOf("github", "google"),
                    password = true,
                    registration = "invite",
                ),
            )
            val vm = OnboardingViewModel(
                authRepository = fakeAuth,
                ioDispatcher = testDispatcher,
                pollDelayMillis = {},
                autoStartDeviceAuth = false,
            )

            vm.onServerUrlChanged("dropit.example.com/")
            vm.submitServerUrl()
            advanceUntilIdle()

            val state = vm.uiState.value
            assertEquals(listOf("https://dropit.example.com"), fakeAuth.verifiedUrls)
            assertEquals(OnboardingStep.DEVICE_AUTH, state.step)
            assertEquals("https://dropit.example.com", state.configuredServerOrigin)
            assertNotNull(state.verifiedServer)
            assertEquals(listOf("github", "google"), state.enabledOAuthProviders)
            assertTrue(state.isPasswordEnabled)
            // Device code remains collapsed & idle until user explicitly expands it.
            assertFalse(state.isDeviceCodeExpanded)
            assertEquals(0, fakeAuth.startDeviceAuthCallCount)

            // Expanding device code starts authorization on demand.
            fakeAuth.pollStates = listOf(
                DeviceAuthState.WaitingForApproval(sampleAuth("ABCD-1234", interval = 5), 5),
            )
            vm.toggleDeviceCodeSection()
            advanceUntilIdle()

            assertTrue(vm.uiState.value.isDeviceCodeExpanded)
            assertEquals(1, fakeAuth.startDeviceAuthCallCount)
            assertEquals(
                "ABCD-1234",
                (vm.uiState.value.deviceAuthState as DeviceAuthState.WaitingForApproval).authorization.userCode,
            )
        }

    @Test
    fun passwordLogin_validatesInputsSucceedsAndSurfacesInvalidCredentials() = runTest(testDispatcher) {
        val fakeAuth = FakeAuthRepository()
        val vm = OnboardingViewModel(
            authRepository = fakeAuth,
            initialServerOrigin = "https://dropit.example.com",
            ioDispatcher = testDispatcher,
            pollDelayMillis = {},
        )
        advanceUntilIdle()

        // Blank fields rejected locally
        vm.submitPasswordLogin()
        assertEquals("请输入邮箱和密码", vm.uiState.value.authError)

        // Server rejects invalid credentials
        fakeAuth.passwordLoginError = ApiError(
            errorCode = ApiErrorCode.INVALID_CREDENTIALS,
            rawCode = "INVALID_CREDENTIALS",
            httpStatus = 401,
            userMessage = ApiErrorCode.INVALID_CREDENTIALS.defaultMessage,
        )
        vm.onEmailChanged("alice@example.com")
        vm.onPasswordChanged("wrong-pass")
        vm.submitPasswordLogin()
        advanceUntilIdle()
        assertEquals(ApiErrorCode.INVALID_CREDENTIALS.defaultMessage, vm.uiState.value.authError)
        assertFalse(fakeAuth.sessionState.value.isSignedIn)

        // Valid credentials complete login with account scope & mustChangePassword
        fakeAuth.passwordLoginError = null
        fakeAuth.passwordLoginResponse = AppAuthTokenResponse(
            accessToken = "tok-pw-1",
            scope = "read write account",
            user = AppAuthUser(id = "u1", email = "alice@example.com", name = "Alice", role = "user"),
            mustChangePassword = true,
        )
        vm.onPasswordChanged("TempPass123!")
        vm.submitPasswordLogin()
        advanceUntilIdle()

        assertNull(vm.uiState.value.authError)
        assertEquals("", vm.uiState.value.passwordInput)
        assertTrue(fakeAuth.sessionState.value.isSignedIn)
        assertTrue(fakeAuth.sessionState.value.hasAccountScope)
        assertTrue(fakeAuth.sessionState.value.mustChangePassword)
    }

    @Test
    fun oauthLogin_launchesCustomTabAndHandlesDeepLinkCallbackSuccessAndError() = runTest(testDispatcher) {
        val bus = OAuthCallbackBus()
        val fakeAuth = FakeAuthRepository(
            providersInfo = AuthProvidersInfo(providers = listOf("github", "google"), password = true),
        )
        val vm = OnboardingViewModel(
            authRepository = fakeAuth,
            oauthCallbackBus = bus,
            initialServerOrigin = "https://dropit.example.com",
            ioDispatcher = testDispatcher,
            pollDelayMillis = {},
        )
        advanceUntilIdle()

        vm.startOAuthLogin("github")
        advanceUntilIdle()
        assertEquals("github", vm.uiState.value.activeOAuthProvider)
        assertEquals(
            "https://dropit.example.com/api/auth/github?app_redirect=dropit://auth/callback&app_state=state-123456",
            vm.uiState.value.pendingOAuthLaunchUrl,
        )
        vm.consumePendingOAuthLaunchUrl()
        assertNull(vm.uiState.value.pendingOAuthLaunchUrl)

        // Error callback from OAuth provider surfaces localized message
        fakeAuth.oauthLoginCallbackResult = OAuthLoginResult.Failed(
            ApiError.fromOAuthErrorCode("OAUTH_DENIED"),
        )
        bus.onCallbackUri("dropit://auth/callback?error=OAUTH_DENIED&state=state-123456")
        advanceUntilIdle()
        assertEquals(ApiErrorCode.OAUTH_DENIED.defaultMessage, vm.uiState.value.authError)
        assertNull(vm.uiState.value.activeOAuthProvider)

        // Successful OAuth login callback exchanges code & signs in
        vm.startOAuthLogin("google")
        advanceUntilIdle()
        val successResp = AppAuthTokenResponse(
            accessToken = "tok-google-1",
            scope = "read write account admin",
            user = AppAuthUser(id = "u-admin", email = "admin@example.com", name = "Admin", role = "admin"),
            mustChangePassword = false,
        )
        fakeAuth.oauthLoginCallbackResult = OAuthLoginResult.Success(successResp)
        bus.onCallbackUri("dropit://auth/callback?code=one-time-code&state=state-123456")
        advanceUntilIdle()

        assertNull(vm.uiState.value.authError)
        assertNull(vm.uiState.value.activeOAuthProvider)
        assertTrue(fakeAuth.sessionState.value.isSignedIn)
        assertTrue(fakeAuth.sessionState.value.hasAdminScope)
    }

    @Test
    fun submitServerUrl_whenSessionStateTriggersSyncEntry_keepsVerifiedServerAndLoadsProviders() =
        runTest(testDispatcher) {
            lateinit var vm: OnboardingViewModel
            val fakeAuth = FakeAuthRepository(
                providersInfo = AuthProvidersInfo(providers = listOf("github"), password = true),
                onServerSaved = { origin ->
                    vm.syncEntry(origin, sessionExpired = false)
                },
            )
            vm = OnboardingViewModel(
                authRepository = fakeAuth,
                ioDispatcher = testDispatcher,
                pollDelayMillis = {},
                autoStartDeviceAuth = false,
            )

            vm.onServerUrlChanged("dropit.example.com")
            vm.submitServerUrl()
            advanceUntilIdle()

            vm.syncEntry("https://dropit.example.com", sessionExpired = false)
            advanceUntilIdle()

            val state = vm.uiState.value
            assertEquals(OnboardingStep.DEVICE_AUTH, state.step)
            assertNotNull(state.verifiedServer)
            assertEquals("0.4.1", state.verifiedServer?.versionInfo?.version)
            assertEquals(listOf("github"), state.enabledOAuthProviders)

            vm.switchServer()
            assertEquals(OnboardingStep.SERVER_CONFIG, vm.uiState.value.step)
            vm.submitServerUrl()
            advanceUntilIdle()
            assertNotNull(vm.uiState.value.verifiedServer)
        }

    @Test
    fun submitServerUrl_rejectsInsecureHttpAndCredentialsLocally() = runTest(testDispatcher) {
        val fakeAuth = FakeAuthRepository()
        val vm = OnboardingViewModel(
            authRepository = fakeAuth,
            ioDispatcher = testDispatcher,
            pollDelayMillis = {},
            autoStartDeviceAuth = false,
        )

        vm.onServerUrlChanged("http://dropit.example.com")
        vm.submitServerUrl()
        advanceUntilIdle()
        assertEquals(OnboardingStep.SERVER_CONFIG, vm.uiState.value.step)
        assertTrue(vm.uiState.value.serverError!!.contains("https://"))
        assertTrue(fakeAuth.verifiedUrls.isEmpty())

        vm.onServerUrlChanged("https://user:pass@dropit.example.com")
        vm.submitServerUrl()
        advanceUntilIdle()
        assertTrue(vm.uiState.value.serverError!!.contains("用户名"))
        assertTrue(fakeAuth.verifiedUrls.isEmpty())

        vm.onServerUrlChanged("   ")
        vm.submitServerUrl()
        advanceUntilIdle()
        assertNotNull(vm.uiState.value.serverError)
        assertTrue(fakeAuth.verifiedUrls.isEmpty())
    }

    @Test
    fun submitServerUrl_networkFailureMarksOfflineAndSupportsRetry() = runTest(testDispatcher) {
        val fakeAuth = FakeAuthRepository(
            verifyError = ApiError.network(IOException("offline")),
        )
        val vm = OnboardingViewModel(
            authRepository = fakeAuth,
            ioDispatcher = testDispatcher,
            pollDelayMillis = {},
            autoStartDeviceAuth = false,
        )

        vm.onServerUrlChanged("dropit.example.com")
        vm.submitServerUrl()
        advanceUntilIdle()

        assertEquals(OnboardingStep.SERVER_CONFIG, vm.uiState.value.step)
        assertTrue(vm.uiState.value.isServerOffline)
        assertNotNull(vm.uiState.value.serverError)

        fakeAuth.verifyError = null
        vm.submitServerUrl()
        advanceUntilIdle()

        assertEquals(OnboardingStep.DEVICE_AUTH, vm.uiState.value.step)
        assertFalse(vm.uiState.value.isServerOffline)
        assertNull(vm.uiState.value.serverError)
    }

    @Test
    fun deviceAuth_stateMachineHandlesSlowDownAndApproval() = runTest(testDispatcher) {
        val auth = sampleAuth("WXYZ-9876", interval = 5)
        val fakeAuth = FakeAuthRepository(
            authResponse = auth,
            pollStates = listOf(
                DeviceAuthState.WaitingForApproval(auth, pollIntervalSeconds = 5),
                DeviceAuthState.WaitingForApproval(auth, pollIntervalSeconds = 10),
                DeviceAuthState.Approved(serverOrigin = "https://dropit.example.com", scope = "read write"),
            ),
        )
        val vm = OnboardingViewModel(
            authRepository = fakeAuth,
            initialServerOrigin = "https://dropit.example.com",
            initialSessionExpired = true,
            ioDispatcher = testDispatcher,
            pollDelayMillis = {},
            autoStartDeviceAuth = true,
        )

        advanceUntilIdle()

        val state = vm.uiState.value
        assertTrue(state.deviceAuthState is DeviceAuthState.Approved)
        assertFalse(state.sessionExpiredNotice)
    }

    @Test
    fun deviceAuth_handlesExpiredAndDeniedAndAllowsRestart() = runTest(testDispatcher) {
        val fakeAuth = FakeAuthRepository(
            pollStates = listOf(DeviceAuthState.Expired),
        )
        val vm = OnboardingViewModel(
            authRepository = fakeAuth,
            initialServerOrigin = "https://dropit.example.com",
            ioDispatcher = testDispatcher,
            pollDelayMillis = {},
            autoStartDeviceAuth = true,
        )

        advanceUntilIdle()
        assertEquals(DeviceAuthState.Expired, vm.uiState.value.deviceAuthState)

        fakeAuth.pollStates = listOf(DeviceAuthState.Denied)
        vm.startDeviceAuth()
        advanceUntilIdle()
        assertEquals(DeviceAuthState.Denied, vm.uiState.value.deviceAuthState)

        vm.switchServer()
        assertEquals(OnboardingStep.SERVER_CONFIG, vm.uiState.value.step)
        assertEquals(DeviceAuthState.Idle, vm.uiState.value.deviceAuthState)
        assertEquals("https://dropit.example.com", vm.uiState.value.serverUrlInput)
    }

    @Test
    fun syncEntry_after401PreservesServerOriginAndShowsExpiredNotice() = runTest(testDispatcher) {
        val fakeAuth = FakeAuthRepository(
            providersInfo = AuthProvidersInfo(providers = listOf("github"), password = true),
        )
        val vm = OnboardingViewModel(
            authRepository = fakeAuth,
            ioDispatcher = testDispatcher,
            pollDelayMillis = {},
            autoStartDeviceAuth = false,
        )

        vm.syncEntry(serverOrigin = "https://dropit.lthero.com", sessionExpired = true)
        advanceUntilIdle()

        val state = vm.uiState.value
        assertEquals(OnboardingStep.DEVICE_AUTH, state.step)
        assertEquals("https://dropit.lthero.com", state.configuredServerOrigin)
        assertTrue(state.sessionExpiredNotice)
        assertEquals(listOf("github"), state.enabledOAuthProviders)
        assertEquals(1, fakeAuth.providersCallCount)

        // Repeated identical syncEntry does not re-fetch providers unnecessarily
        vm.syncEntry(serverOrigin = "https://dropit.lthero.com", sessionExpired = true)
        advanceUntilIdle()
        assertEquals(1, fakeAuth.providersCallCount)
    }

    private fun sampleAuth(code: String, interval: Int = 5) = DeviceAuthorizeResponse(
        deviceCode = "dev-$code",
        userCode = code,
        verificationUri = "https://dropit.example.com/settings?tab=device-code",
        verificationUriComplete = "https://dropit.example.com/settings?tab=device-code&code=$code",
        expiresIn = 600,
        interval = interval,
    )

    private class FakeAuthRepository(
        var verifyError: Throwable? = null,
        var providersInfo: AuthProvidersInfo = AuthProvidersInfo(providers = emptyList(), password = true),
        var passwordLoginError: Throwable? = null,
        var passwordLoginResponse: AppAuthTokenResponse = AppAuthTokenResponse(
            accessToken = "tok-default",
            scope = "read write account",
            user = AppAuthUser(id = "u1", email = "u@example.com", name = "User", role = "user"),
        ),
        var oauthLoginCallbackResult: OAuthLoginResult = OAuthLoginResult.Failed(
            ApiError.fromOAuthErrorCode("OAUTH_STATE_INVALID"),
        ),
        var authResponse: DeviceAuthorizeResponse = DeviceAuthorizeResponse(
            deviceCode = "dev-code-1",
            userCode = "ABCD-1234",
            verificationUri = "https://dropit.example.com/device",
            verificationUriComplete = "https://dropit.example.com/device?code=ABCD-1234",
            expiresIn = 600,
            interval = 5,
        ),
        var pollStates: List<DeviceAuthState> = emptyList(),
        private val onServerSaved: (String) -> Unit = {},
    ) : AuthRepository {
        private val _sessionState = MutableStateFlow(AuthSessionState())
        override val sessionState: StateFlow<AuthSessionState> = _sessionState.asStateFlow()

        private val _deviceAuthState = MutableStateFlow<DeviceAuthState>(DeviceAuthState.Idle)
        override val deviceAuthState: StateFlow<DeviceAuthState> = _deviceAuthState.asStateFlow()

        val verifiedUrls = mutableListOf<String>()
        var startDeviceAuthCallCount = 0
        var providersCallCount = 0

        override suspend fun refreshSessionState(): AuthSessionState = _sessionState.value

        override suspend fun verifyAndSaveServer(rawUrl: String): VerifiedServer {
            verifyError?.let { throw it }
            verifiedUrls.add(rawUrl)
            _sessionState.value = _sessionState.value.copy(serverOrigin = rawUrl)
            onServerSaved(rawUrl)
            return VerifiedServer(
                serverOrigin = rawUrl,
                versionInfo = VersionInfo(version = "0.4.1", commit = "392832b", install = "docker"),
            )
        }

        override suspend fun getAuthProviders(serverOrigin: String?): AuthProvidersInfo {
            providersCallCount++
            return providersInfo
        }

        override suspend fun loginWithPassword(
            serverOrigin: String,
            email: String,
            password: String,
            invite: String?,
        ): AppAuthTokenResponse {
            passwordLoginError?.let { throw it }
            _sessionState.value = AuthSessionState(
                serverOrigin = serverOrigin,
                isSignedIn = true,
                tokenScopes = passwordLoginResponse.parsedScopes,
                mustChangePassword = passwordLoginResponse.mustChangePassword,
            )
            return passwordLoginResponse
        }

        override suspend fun startAppOAuthLogin(
            serverOrigin: String,
            provider: String,
            invite: String?,
        ): PendingOAuthLogin = PendingOAuthLogin(
            provider = provider,
            serverOrigin = serverOrigin,
            state = "state-123456",
            launchUrl = "$serverOrigin/api/auth/$provider?app_redirect=dropit://auth/callback&app_state=state-123456",
        )

        override suspend fun handleOAuthLoginCallback(payload: OAuthCallbackPayload): OAuthLoginResult {
            val res = oauthLoginCallbackResult
            if (res is OAuthLoginResult.Success) {
                _sessionState.value = AuthSessionState(
                    serverOrigin = _sessionState.value.serverOrigin ?: "https://dropit.example.com",
                    isSignedIn = true,
                    tokenScopes = res.response.parsedScopes,
                    mustChangePassword = res.response.mustChangePassword,
                )
            }
            return res
        }

        override suspend fun startDeviceAuthorization(
            serverOrigin: String,
            scopes: List<String>,
        ): DeviceAuthorizeResponse {
            startDeviceAuthCallCount++
            return authResponse
        }

        override suspend fun pollDeviceTokenOnce(serverOrigin: String, deviceCode: String): DevicePollOutcome =
            DevicePollOutcome.Pending

        override fun pollDeviceAuthorization(
            serverOrigin: String,
            authorization: DeviceAuthorizeResponse,
            delayMillis: suspend (Long) -> Unit,
        ): Flow<DeviceAuthState> = flow {
            for (state in pollStates) {
                delayMillis(1000L)
                _deviceAuthState.value = state
                emit(state)
            }
        }

        override suspend fun completeAuthorization(serverOrigin: String, token: String) {
            _sessionState.value = AuthSessionState(serverOrigin = serverOrigin, isSignedIn = true)
        }

        override suspend fun clearLocalSession(clearServer: Boolean) {
            _sessionState.value = AuthSessionState(
                serverOrigin = if (clearServer) null else _sessionState.value.serverOrigin,
                isSignedIn = false,
            )
            _deviceAuthState.value = DeviceAuthState.Idle
        }

        override suspend fun logout(clearServer: Boolean) {
            clearLocalSession(clearServer)
        }

        override fun resetDeviceAuthState() {
            _deviceAuthState.value = DeviceAuthState.Idle
        }
    }
}
