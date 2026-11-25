package dev.dropit.app.ui.onboarding

import dev.dropit.app.core.auth.AuthRepository
import dev.dropit.app.core.auth.AuthSessionState
import dev.dropit.app.core.auth.DeviceAuthState
import dev.dropit.app.core.auth.DevicePollOutcome
import dev.dropit.app.core.network.ApiError
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
    fun submitServerUrl_normalizesBareDomainVerifiesAndStartsDeviceAuth() = runTest(testDispatcher) {
        val fakeAuth = FakeAuthRepository(
            pollStates = listOf(
                DeviceAuthState.WaitingForApproval(sampleAuth("ABCD-1234", interval = 5), 5),
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
        assertEquals(1, fakeAuth.startDeviceAuthCallCount)
        assertEquals(OnboardingStep.DEVICE_AUTH, state.step)
        assertEquals("https://dropit.example.com", state.configuredServerOrigin)
        assertNotNull(state.verifiedServer)
        assertTrue(state.deviceAuthState is DeviceAuthState.WaitingForApproval)
        assertEquals(
            "ABCD-1234",
            (state.deviceAuthState as DeviceAuthState.WaitingForApproval).authorization.userCode,
        )
    }

    @Test
    fun submitServerUrl_whenSessionStateTriggersSyncEntry_startsDeviceAuthOnceAndKeepsVerifiedServer() =
        runTest(testDispatcher) {
            lateinit var vm: OnboardingViewModel
            val fakeAuth = FakeAuthRepository(
                pollStates = listOf(
                    DeviceAuthState.WaitingForApproval(sampleAuth("ONCE-2026", interval = 5), 5),
                ),
                onServerSaved = { origin ->
                    // Simulate AppViewModel -> DropitApp LaunchedEffect firing syncEntry mid-verification
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

            // Simulate another LaunchedEffect syncEntry after submitServerUrl completes
            vm.syncEntry("https://dropit.example.com", sessionExpired = false)
            advanceUntilIdle()

            val state = vm.uiState.value
            assertEquals(1, fakeAuth.startDeviceAuthCallCount)
            assertEquals(OnboardingStep.DEVICE_AUTH, state.step)
            assertNotNull(state.verifiedServer)
            assertEquals("0.4.0", state.verifiedServer?.versionInfo?.version)

            // Switching server back to SERVER_CONFIG and submitting again starts a fresh authorization once
            vm.switchServer()
            assertEquals(OnboardingStep.SERVER_CONFIG, vm.uiState.value.step)
            vm.submitServerUrl()
            advanceUntilIdle()
            assertEquals(2, fakeAuth.startDeviceAuthCallCount)
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

        // Retry after network comes back
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

        // Retry yields Denied
        fakeAuth.pollStates = listOf(DeviceAuthState.Denied)
        vm.startDeviceAuth()
        advanceUntilIdle()
        assertEquals(DeviceAuthState.Denied, vm.uiState.value.deviceAuthState)

        // Switch server returns to SERVER_CONFIG and resets device auth state
        vm.switchServer()
        assertEquals(OnboardingStep.SERVER_CONFIG, vm.uiState.value.step)
        assertEquals(DeviceAuthState.Idle, vm.uiState.value.deviceAuthState)
        assertEquals("https://dropit.example.com", vm.uiState.value.serverUrlInput)
    }

    @Test
    fun syncEntry_after401PreservesServerOriginAndShowsExpiredNotice() = runTest(testDispatcher) {
        val fakeAuth = FakeAuthRepository(
            pollStates = listOf(DeviceAuthState.WaitingForApproval(sampleAuth("REAU-4010", 5), 5)),
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
        assertTrue(state.deviceAuthState is DeviceAuthState.WaitingForApproval)
        assertEquals(1, fakeAuth.startDeviceAuthCallCount)

        // Repeated identical syncEntry does not re-request device code
        vm.syncEntry(serverOrigin = "https://dropit.lthero.com", sessionExpired = true)
        advanceUntilIdle()
        assertEquals(1, fakeAuth.startDeviceAuthCallCount)
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

        override suspend fun refreshSessionState(): AuthSessionState = _sessionState.value

        override suspend fun verifyAndSaveServer(rawUrl: String): VerifiedServer {
            verifyError?.let { throw it }
            verifiedUrls.add(rawUrl)
            _sessionState.value = _sessionState.value.copy(serverOrigin = rawUrl)
            onServerSaved(rawUrl)
            return VerifiedServer(
                serverOrigin = rawUrl,
                versionInfo = VersionInfo(version = "0.4.0", commit = "8843e66", install = "docker"),
            )
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
