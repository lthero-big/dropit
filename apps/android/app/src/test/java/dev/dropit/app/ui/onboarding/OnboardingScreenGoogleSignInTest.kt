package dev.dropit.app.ui.onboarding

import android.app.Application
import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.dropit.app.core.auth.AuthRepository
import dev.dropit.app.core.auth.AuthSessionState
import dev.dropit.app.core.auth.DeviceAuthState
import dev.dropit.app.core.auth.DevicePollOutcome
import dev.dropit.app.core.network.AppAuthTokenResponse
import dev.dropit.app.core.network.AppAuthUser
import dev.dropit.app.core.network.AuthProvidersInfo
import dev.dropit.app.core.network.DeviceAuthorizeResponse
import dev.dropit.app.core.network.VerifiedServer
import dev.dropit.app.core.network.VersionInfo
import dev.dropit.app.ui.theme.DropitTheme
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.emptyFlow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(application = Application::class, sdk = [34])
class OnboardingScreenGoogleSignInTest {

    @get:Rule
    val composeRule = createComposeRule()

    @Test
    fun consumingPendingRequestDoesNotCancelSuspendingGooglePickerAndCompletesLogin() {
        val fakeAuth = MinimalFakeAuthRepository(
            providersInfo = AuthProvidersInfo(
                providers = listOf("google"),
                password = true,
                googleClientId = "test-client.apps.googleusercontent.com",
            ),
        )
        val vm = OnboardingViewModel(
            authRepository = fakeAuth,
            initialServerOrigin = "https://dropit.example.com",
            ioDispatcher = Dispatchers.Unconfined,
            pollDelayMillis = {},
        )
        val deferred = CompletableDeferred<GoogleIdTokenFetchResult>()
        val fetcher = SuspendingGoogleIdTokenFetcher(listOf(deferred))

        composeRule.setContent {
            DropitTheme {
                OnboardingScreen(
                    viewModel = vm,
                    googleIdTokenFetcher = fetcher,
                )
            }
        }
        composeRule.waitForIdle()

        composeRule.onNodeWithText("使用 Google 登录").performClick()
        // Wait across recompositions after pendingNativeGoogleRequest flips back to null.
        composeRule.waitForIdle()
        composeRule.mainClock.advanceTimeBy(100L)
        composeRule.waitForIdle()

        assertEquals(1, fetcher.startedCalls)
        assertFalse("Consuming pending request must NOT cancel the suspending Google picker", fetcher.cancelledCalls > 0)
        assertNull(vm.uiState.value.pendingNativeGoogleRequest)
        assertTrue(vm.uiState.value.isNativeGoogleSignInInProgress)

        deferred.complete(GoogleIdTokenFetchResult.Success("ui-verified-id-token"))
        composeRule.waitForIdle()

        assertTrue(fakeAuth.sessionState.value.isSignedIn)
        assertEquals(listOf("ui-verified-id-token"), fakeAuth.receivedIdTokens)
        assertFalse(vm.uiState.value.isNativeGoogleSignInInProgress)
        assertFalse(vm.uiState.value.isBusySigningIn)
        assertNull(vm.uiState.value.activeOAuthProvider)
        assertNull(vm.uiState.value.authError)
    }

    @Test
    fun compositionDisposalMidFlightResetsBusyStateAndAllowsImmediateRetryWithSameClientId() {
        val fakeAuth = MinimalFakeAuthRepository(
            providersInfo = AuthProvidersInfo(
                providers = listOf("google"),
                password = true,
                googleClientId = "test-client.apps.googleusercontent.com",
            ),
        )
        val vm = OnboardingViewModel(
            authRepository = fakeAuth,
            initialServerOrigin = "https://dropit.example.com",
            ioDispatcher = Dispatchers.Unconfined,
            pollDelayMillis = {},
        )
        val firstAttempt = CompletableDeferred<GoogleIdTokenFetchResult>()
        val secondAttempt = CompletableDeferred<GoogleIdTokenFetchResult>()
        val fetcher = SuspendingGoogleIdTokenFetcher(listOf(firstAttempt, secondAttempt))
        var showScreen by mutableStateOf(true)

        composeRule.setContent {
            DropitTheme {
                if (showScreen) {
                    OnboardingScreen(
                        viewModel = vm,
                        googleIdTokenFetcher = fetcher,
                    )
                }
            }
        }
        composeRule.waitForIdle()

        // Start first native Google sign-in attempt
        composeRule.onNodeWithText("使用 Google 登录").performClick()
        composeRule.waitForIdle()
        assertEquals(1, fetcher.startedCalls)
        assertTrue(vm.uiState.value.isNativeGoogleSignInInProgress)

        // Simulate leaving the screen / Activity disposal while Credential Manager picker is open
        showScreen = false
        composeRule.waitForIdle()

        assertEquals(1, fetcher.cancelledCalls)
        assertFalse(
            "Mid-flight cancellation must reset isNativeGoogleSignInInProgress so UI is never stuck",
            vm.uiState.value.isNativeGoogleSignInInProgress,
        )
        assertFalse(vm.uiState.value.isBusySigningIn)
        assertNull(vm.uiState.value.activeOAuthProvider)

        // Re-enter screen and retry with the exact same googleClientId
        showScreen = true
        composeRule.waitForIdle()
        composeRule.onNodeWithText("使用 Google 登录").performClick()
        composeRule.waitForIdle()

        assertEquals(2, fetcher.startedCalls)
        assertTrue(vm.uiState.value.isNativeGoogleSignInInProgress)

        secondAttempt.complete(GoogleIdTokenFetchResult.Success("ui-retry-id-token"))
        composeRule.waitForIdle()

        assertTrue(fakeAuth.sessionState.value.isSignedIn)
        assertEquals(listOf("ui-retry-id-token"), fakeAuth.receivedIdTokens)
        assertFalse(vm.uiState.value.isNativeGoogleSignInInProgress)
    }

    private class SuspendingGoogleIdTokenFetcher(
        private val results: List<CompletableDeferred<GoogleIdTokenFetchResult>>,
    ) : GoogleIdTokenFetcher {
        var startedCalls = 0
        var cancelledCalls = 0

        override suspend fun fetchIdToken(context: Context, serverClientId: String): GoogleIdTokenFetchResult {
            val idx = startedCalls
            startedCalls += 1
            return try {
                results[idx].await()
            } catch (ce: CancellationException) {
                cancelledCalls += 1
                throw ce
            }
        }
    }

    private class MinimalFakeAuthRepository(
        private val providersInfo: AuthProvidersInfo,
    ) : AuthRepository {
        private val _sessionState = MutableStateFlow(AuthSessionState())
        override val sessionState: StateFlow<AuthSessionState> = _sessionState.asStateFlow()

        private val _deviceAuthState = MutableStateFlow<DeviceAuthState>(DeviceAuthState.Idle)
        override val deviceAuthState: StateFlow<DeviceAuthState> = _deviceAuthState.asStateFlow()

        val receivedIdTokens = mutableListOf<String>()

        override suspend fun refreshSessionState(): AuthSessionState = _sessionState.value

        override suspend fun verifyAndSaveServer(rawUrl: String): VerifiedServer = VerifiedServer(
            serverOrigin = rawUrl,
            versionInfo = VersionInfo(version = "0.4.2", commit = "1f87137", install = "docker"),
        )

        override suspend fun getAuthProviders(serverOrigin: String?): AuthProvidersInfo = providersInfo

        override suspend fun loginWithGoogleIdToken(
            serverOrigin: String,
            idToken: String,
            invite: String?,
        ): AppAuthTokenResponse {
            receivedIdTokens.add(idToken)
            val response = AppAuthTokenResponse(
                accessToken = "tok-ui-google",
                scope = "read write account",
                user = AppAuthUser(id = "u1", email = "u@example.com", name = "User", role = "user"),
            )
            _sessionState.value = AuthSessionState(
                serverOrigin = serverOrigin,
                isSignedIn = true,
                tokenScopes = response.parsedScopes,
            )
            return response
        }

        override suspend fun startDeviceAuthorization(serverOrigin: String, scopes: List<String>): DeviceAuthorizeResponse =
            error("unused")

        override suspend fun pollDeviceTokenOnce(serverOrigin: String, deviceCode: String): DevicePollOutcome =
            DevicePollOutcome.Pending

        override fun pollDeviceAuthorization(
            serverOrigin: String,
            authorization: DeviceAuthorizeResponse,
            delayMillis: suspend (Long) -> Unit,
        ): Flow<DeviceAuthState> = emptyFlow()

        override suspend fun completeAuthorization(serverOrigin: String, token: String) {
            _sessionState.value = AuthSessionState(serverOrigin = serverOrigin, isSignedIn = true)
        }

        override suspend fun clearLocalSession(clearServer: Boolean) {
            _sessionState.value = AuthSessionState(isSignedIn = false)
        }

        override suspend fun logout(clearServer: Boolean) {
            clearLocalSession(clearServer)
        }

        override fun resetDeviceAuthState() = Unit
    }
}
