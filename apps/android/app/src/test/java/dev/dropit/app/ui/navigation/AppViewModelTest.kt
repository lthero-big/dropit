package dev.dropit.app.ui.navigation

import dev.dropit.app.core.auth.AppSettings
import dev.dropit.app.core.auth.AuthRepository
import dev.dropit.app.core.auth.AuthSessionState
import dev.dropit.app.core.auth.DeviceAuthState
import dev.dropit.app.core.auth.DevicePollOutcome
import dev.dropit.app.core.auth.InMemorySettingsStore
import dev.dropit.app.core.auth.InMemoryTokenVault
import dev.dropit.app.core.auth.LegacyCapacitorMigrator
import dev.dropit.app.core.auth.LegacyPrefsReader
import dev.dropit.app.core.auth.MigrationResult
import dev.dropit.app.core.auth.SettingsStore
import dev.dropit.app.core.auth.TokenVault
import dev.dropit.app.core.network.DeviceAuthorizeResponse
import dev.dropit.app.core.network.DropitApiClient
import dev.dropit.app.core.network.SessionCredentialsProvider
import dev.dropit.app.core.network.VerifiedServer
import dev.dropit.app.core.network.VersionInfo
import dev.dropit.app.core.realtime.RealtimeClient
import dev.dropit.app.core.repository.AppUpdater
import dev.dropit.app.core.repository.BoardRepository
import dev.dropit.app.core.repository.DefaultBoardRepository
import dev.dropit.app.core.repository.DefaultSpaceRepository
import dev.dropit.app.core.repository.ItemShareRepository
import dev.dropit.app.core.repository.MediaRepository
import dev.dropit.app.core.repository.PlaceholderAppUpdater
import dev.dropit.app.core.repository.PlaceholderItemShareRepository
import dev.dropit.app.core.repository.PlaceholderRoomRepository
import dev.dropit.app.core.repository.PlaceholderShareInbox
import dev.dropit.app.core.repository.PlaceholderTransferManager
import dev.dropit.app.core.repository.RoomRepository
import dev.dropit.app.core.repository.ShareInbox
import dev.dropit.app.core.repository.SpaceRepository
import dev.dropit.app.core.repository.TransferManager
import dev.dropit.app.di.AppContainer
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class AppViewModelTest {

    private val testDispatcher = StandardTestDispatcher()
    private lateinit var okHttpClient: OkHttpClient

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        okHttpClient = OkHttpClient.Builder().build()
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
        okHttpClient.dispatcher.executorService.shutdown()
        okHttpClient.connectionPool.evictAll()
    }

    @Test
    fun sessionExpired401_deduplicatesLogoutPreservesServerAndIncrementsGenerationOnReLogin() =
        runTest(testDispatcher) {
            val container = TestAppContainer(
                okHttpClient = okHttpClient,
                initialServerOrigin = "https://dropit.lthero.com",
                initialToken = "tok-initial-1",
            )
            val vm = AppViewModel(
                container = container,
                ioDispatcher = testDispatcher,
                autoInitialize = true,
            )
            advanceUntilIdle()

            // Initial authenticated session -> generation 1
            val route1 = vm.uiState.value.route
            assertTrue(route1 is AppRoute.Main)
            assertEquals("https://dropit.lthero.com", (route1 as AppRoute.Main).serverOrigin)
            assertEquals(1L, route1.sessionGeneration)

            // Fire concurrent 401 signals (apiClient event + direct markSessionExpired callback)
            container.apiClient.emitSessionExpiredIf401(401, "https://dropit.lthero.com", "/api/me")
            vm.markSessionExpired()
            advanceUntilIdle()

            // Logout(clearServer = false) must run EXACTLY ONCE and preserve serverOrigin
            assertEquals(listOf(false), container.fakeAuthRepository.logoutClearServerCalls)
            val onboardingRoute = vm.uiState.value.route
            assertEquals(
                AppRoute.Onboarding(serverOrigin = "https://dropit.lthero.com", sessionExpired = true),
                onboardingRoute,
            )

            // Re-login to the SAME server -> generation increments to 2
            container.fakeAuthRepository.completeAuthorization("https://dropit.lthero.com", "tok-fresh-2")
            advanceUntilIdle()

            val route2 = vm.uiState.value.route
            assertTrue(route2 is AppRoute.Main)
            assertEquals("https://dropit.lthero.com", (route2 as AppRoute.Main).serverOrigin)
            assertEquals(2L, route2.sessionGeneration)

            // Subsequent 401 on the new session must be handled cleanly again
            container.apiClient.emitSessionExpiredIf401(401, "https://dropit.lthero.com", "/api/spaces")
            advanceUntilIdle()

            assertEquals(listOf(false, false), container.fakeAuthRepository.logoutClearServerCalls)
            assertEquals(
                AppRoute.Onboarding(serverOrigin = "https://dropit.lthero.com", sessionExpired = true),
                vm.uiState.value.route,
            )
        }

    private class TestAppContainer(
        override val okHttpClient: OkHttpClient,
        initialServerOrigin: String?,
        initialToken: String?,
    ) : AppContainer {
        override val json: Json = DropitApiClient.defaultJson()
        override val settingsStore: SettingsStore = InMemorySettingsStore(
            AppSettings(serverOrigin = initialServerOrigin),
        )
        override val tokenVault: TokenVault = InMemoryTokenVault(initialToken = initialToken)
        override val legacyMigrator: LegacyCapacitorMigrator = LegacyCapacitorMigrator(
            legacyPrefs = object : LegacyPrefsReader {
                override fun getString(prefsName: String, key: String): String? = null
            },
            settingsStore = settingsStore,
            tokenVault = tokenVault,
        )

        private val creds = object : SessionCredentialsProvider {
            override suspend fun serverOrigin(): String? = settingsStore.getServerOrigin()
            override suspend fun accessToken(): String? = tokenVault.getToken()
            override suspend fun deviceId(): String = settingsStore.getOrCreateDeviceId()
            override fun deviceName(): String = "dropit Android · Test"
        }

        override val apiClient: DropitApiClient = DropitApiClient(
            okHttpClient = okHttpClient,
            json = json,
            credentialsProvider = creds,
        )

        val fakeAuthRepository = RecordingAuthRepository(settingsStore, tokenVault)
        override val authRepository: AuthRepository = fakeAuthRepository

        override val realtimeClient: RealtimeClient = RealtimeClient(
            okHttpClient = okHttpClient,
            credentialsProvider = creds,
            json = json,
        )
        override val spaceRepository: SpaceRepository = DefaultSpaceRepository(apiClient)
        override val boardRepository: BoardRepository = DefaultBoardRepository(apiClient)
        override val transferManager: TransferManager = PlaceholderTransferManager()
        override val shareInbox: ShareInbox = PlaceholderShareInbox()
        override val appUpdater: AppUpdater = PlaceholderAppUpdater()
        override val roomRepository: RoomRepository = PlaceholderRoomRepository()
        override val itemShareRepository: ItemShareRepository = PlaceholderItemShareRepository()
        override val mediaRepository: MediaRepository
            get() = throw UnsupportedOperationException("Not used in AppViewModelTest")

        override suspend fun initialize(): MigrationResult {
            authRepository.refreshSessionState()
            return MigrationResult.NothingToMigrate
        }

        override suspend fun resetForServerSwitch() {
            realtimeClient.disconnect(clearState = true)
            authRepository.logout(clearServer = true)
        }
    }

    private class RecordingAuthRepository(
        private val settingsStore: SettingsStore,
        private val tokenVault: TokenVault,
    ) : AuthRepository {
        private val _sessionState = MutableStateFlow(AuthSessionState())
        override val sessionState: StateFlow<AuthSessionState> = _sessionState.asStateFlow()

        private val _deviceAuthState = MutableStateFlow<DeviceAuthState>(DeviceAuthState.Idle)
        override val deviceAuthState: StateFlow<DeviceAuthState> = _deviceAuthState.asStateFlow()

        val logoutClearServerCalls = mutableListOf<Boolean>()

        override suspend fun refreshSessionState(): AuthSessionState {
            val origin = settingsStore.getServerOrigin()
            val signedIn = !origin.isNullOrBlank() && tokenVault.hasToken()
            val state = AuthSessionState(serverOrigin = origin, isSignedIn = signedIn)
            _sessionState.value = state
            return state
        }

        override suspend fun verifyAndSaveServer(rawUrl: String): VerifiedServer {
            settingsStore.setServerOrigin(rawUrl)
            refreshSessionState()
            return VerifiedServer(rawUrl, VersionInfo("0.4.0", "dev", null, "docker"))
        }

        override suspend fun startDeviceAuthorization(
            serverOrigin: String,
            scopes: List<String>,
        ): DeviceAuthorizeResponse = throw UnsupportedOperationException()

        override suspend fun pollDeviceTokenOnce(serverOrigin: String, deviceCode: String): DevicePollOutcome =
            DevicePollOutcome.Pending

        override fun pollDeviceAuthorization(
            serverOrigin: String,
            authorization: DeviceAuthorizeResponse,
            delayMillis: suspend (Long) -> Unit,
        ): Flow<DeviceAuthState> = emptyFlow()

        override suspend fun completeAuthorization(serverOrigin: String, token: String) {
            settingsStore.setServerOrigin(serverOrigin)
            tokenVault.saveToken(token)
            refreshSessionState()
        }

        override suspend fun logout(clearServer: Boolean) {
            logoutClearServerCalls.add(clearServer)
            tokenVault.clearToken()
            if (clearServer) {
                settingsStore.clearServerConfig()
            }
            refreshSessionState()
        }

        override fun resetDeviceAuthState() {
            _deviceAuthState.value = DeviceAuthState.Idle
        }
    }
}
