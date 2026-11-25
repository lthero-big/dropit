package dev.dropit.app.ui.navigation

import android.content.Intent
import android.net.Uri
import androidx.media3.datasource.DataSource
import coil.ImageLoader
import dev.dropit.app.core.auth.AppSettings
import dev.dropit.app.core.auth.AuthRepository
import dev.dropit.app.core.auth.AuthSessionState
import dev.dropit.app.core.auth.DefaultAuthRepository
import dev.dropit.app.core.auth.DeviceAuthState
import dev.dropit.app.core.auth.DevicePollOutcome
import dev.dropit.app.core.auth.InMemorySettingsStore
import dev.dropit.app.core.auth.InMemoryTokenVault
import dev.dropit.app.core.auth.LegacyCapacitorMigrator
import dev.dropit.app.core.auth.LegacyPrefsReader
import dev.dropit.app.core.auth.MigrationResult
import dev.dropit.app.core.auth.SettingsStore
import dev.dropit.app.core.auth.TokenVault
import dev.dropit.app.core.network.ClipItem
import dev.dropit.app.core.network.DeviceAuthorizeResponse
import dev.dropit.app.core.network.DropitApiClient
import dev.dropit.app.core.network.OptionalField
import dev.dropit.app.core.network.RoomInfo
import dev.dropit.app.core.network.SessionCredentialsProvider
import dev.dropit.app.core.network.TargetScope
import dev.dropit.app.core.network.VerifiedServer
import dev.dropit.app.core.network.VersionInfo
import dev.dropit.app.core.realtime.RealtimeClient
import dev.dropit.app.core.repository.AppUpdater
import dev.dropit.app.core.repository.BoardRepository
import dev.dropit.app.core.repository.DefaultBoardRepository
import dev.dropit.app.core.repository.DefaultSpaceRepository
import dev.dropit.app.core.repository.DownloadFileRequest
import dev.dropit.app.core.repository.ItemShareRepository
import dev.dropit.app.core.repository.MediaRepository
import dev.dropit.app.core.repository.PendingShare
import dev.dropit.app.core.repository.PlaceholderAppUpdater
import dev.dropit.app.core.repository.PlaceholderItemShareRepository
import dev.dropit.app.core.repository.RoomRepository
import dev.dropit.app.core.repository.ShareInbox
import dev.dropit.app.core.repository.SpaceRepository
import dev.dropit.app.core.repository.StagedShareFile
import dev.dropit.app.core.repository.TransferManager
import dev.dropit.app.core.repository.TransferTask
import dev.dropit.app.core.repository.UploadFileRequest
import dev.dropit.app.di.AppContainer
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
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
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.concurrent.TimeUnit

@OptIn(ExperimentalCoroutinesApi::class)
class AppViewModelTest {

    private val testDispatcher = StandardTestDispatcher()
    private lateinit var okHttpClient: OkHttpClient
    private lateinit var server: MockWebServer
    private lateinit var baseUrl: String

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        okHttpClient = OkHttpClient.Builder().build()
        server = MockWebServer().apply { start() }
        baseUrl = server.url("/").toString().trimEnd('/')
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
        server.shutdown()
        okHttpClient.dispatcher.executorService.shutdown()
        okHttpClient.connectionPool.evictAll()
    }

    @Test
    fun sessionExpired401_deduplicatesLocalClearPreservesServerNeverRevokesAndIncrementsGenerationOnReLogin() =
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

            // Passive 401 must call clearLocalSession(clearServer = false) EXACTLY ONCE and NEVER call logout()
            assertEquals(listOf(false), container.fakeAuthRepository.clearLocalSessionCalls)
            assertTrue(container.fakeAuthRepository.logoutClearServerCalls.isEmpty())
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

            // Subsequent 401 on the new session must also only clear locally without remote logout
            container.apiClient.emitSessionExpiredIf401(401, "https://dropit.lthero.com", "/api/spaces")
            advanceUntilIdle()

            assertEquals(listOf(false, false), container.fakeAuthRepository.clearLocalSessionCalls)
            assertTrue(container.fakeAuthRepository.logoutClearServerCalls.isEmpty())
            assertEquals(
                AppRoute.Onboarding(serverOrigin = "https://dropit.lthero.com", sessionExpired = true),
                vm.uiState.value.route,
            )
        }

    @Test
    fun markSessionExpired_withRealAuthRepository_neverCallsPostLogoutAndPreservesServerOrigin() =
        runTest(testDispatcher) {
            val container = TestAppContainer(
                okHttpClient = okHttpClient,
                initialServerOrigin = baseUrl,
                initialToken = "tok_passive_401_must_not_revoke_1234567890",
                useRealAuthRepository = true,
            )
            val vm = AppViewModel(
                container = container,
                ioDispatcher = testDispatcher,
                autoInitialize = true,
            )
            advanceUntilIdle()
            assertTrue(vm.uiState.value.route is AppRoute.Main)

            container.apiClient.emitSessionExpiredIf401(401, baseUrl, "/api/spaces/sp-1/items/it-1")
            vm.markSessionExpired()
            advanceUntilIdle()

            assertEquals(0, server.requestCount)
            assertNull(container.tokenVault.getToken())
            assertEquals(baseUrl, container.settingsStore.getServerOrigin())
            assertEquals(
                AppRoute.Onboarding(serverOrigin = baseUrl, sessionExpired = true),
                vm.uiState.value.route,
            )
        }

    @Test
    fun switchAccount_revokesRemoteTokenClearsAccountStateAndPreservesServerOrigin() =
        runTest(testDispatcher) {
            server.enqueue(MockResponse().setResponseCode(204))
            val container = TestAppContainer(
                okHttpClient = okHttpClient,
                initialServerOrigin = baseUrl,
                initialToken = "tok_account_a_12345678901234567890123456",
                useRealAuthRepository = true,
            )
            val vm = AppViewModel(
                container = container,
                ioDispatcher = testDispatcher,
                autoInitialize = true,
            )
            advanceUntilIdle()
            assertEquals(
                AppRoute.Main(serverOrigin = baseUrl, sessionGeneration = 1L),
                vm.uiState.value.route,
            )

            vm.switchAccount()
            advanceUntilIdle()

            // Active switchAccount MUST revoke remote token via POST /api/auth/logout
            val logoutReq = server.takeRequest(5, TimeUnit.SECONDS)
            assertNotNull("Expected POST /api/auth/logout request", logoutReq)
            assertEquals("POST", logoutReq!!.method)
            assertEquals("/api/auth/logout", logoutReq.path)
            assertEquals("Bearer tok_account_a_12345678901234567890123456", logoutReq.getHeader("Authorization"))

            withContext(Dispatchers.Default) {
                withTimeout(5_000L) {
                    while (vm.uiState.value.isLoggingOut) {
                        testDispatcher.scheduler.advanceUntilIdle()
                        delay(10)
                    }
                }
            }
            advanceUntilIdle()
            assertEquals(1, server.requestCount)

            // Must clear account-scoped caches/queues/rooms/pending share
            assertEquals(1, container.recordingRoomRepository.clearRoomStateCount)
            assertEquals(1, container.recordingTransferManager.clearAllCount)
            assertEquals(1, container.recordingShareInbox.discardPendingShareCount)
            assertEquals(1, container.recordingMediaRepository.clearCachesCount)
            assertEquals(0, container.resetForServerSwitchCount)

            // Token cleared locally, serverOrigin preserved, routed directly to Onboarding without expired warning
            assertNull(container.tokenVault.getToken())
            assertEquals(baseUrl, container.settingsStore.getServerOrigin())
            assertFalse(vm.uiState.value.isLoggingOut)
            assertEquals(
                AppRoute.Onboarding(serverOrigin = baseUrl, sessionExpired = false),
                vm.uiState.value.route,
            )

            // Signing in as Account B on the same server increments sessionGeneration cleanly
            container.authRepository.completeAuthorization(baseUrl, "tok_account_b_12345678901234567890123456")
            advanceUntilIdle()
            assertEquals(
                AppRoute.Main(serverOrigin = baseUrl, sessionGeneration = 2L),
                vm.uiState.value.route,
            )
        }

    @Test
    fun logoutAndSwitchServer_revokesRemoteTokenAndClearsServerOrigin() =
        runTest(testDispatcher) {
            server.enqueue(MockResponse().setResponseCode(204))
            val container = TestAppContainer(
                okHttpClient = okHttpClient,
                initialServerOrigin = baseUrl,
                initialToken = "tok_switch_server_1234567890123456789012",
                useRealAuthRepository = true,
            )
            val vm = AppViewModel(
                container = container,
                ioDispatcher = testDispatcher,
                autoInitialize = true,
            )
            advanceUntilIdle()
            assertTrue(vm.uiState.value.route is AppRoute.Main)

            vm.logoutAndSwitchServer()
            advanceUntilIdle()

            val logoutReq = server.takeRequest(5, TimeUnit.SECONDS)
            assertNotNull("Expected POST /api/auth/logout request", logoutReq)
            assertEquals("POST", logoutReq!!.method)
            assertEquals("/api/auth/logout", logoutReq.path)

            withContext(Dispatchers.Default) {
                withTimeout(5_000L) {
                    while (vm.uiState.value.isLoggingOut) {
                        testDispatcher.scheduler.advanceUntilIdle()
                        delay(10)
                    }
                }
            }
            advanceUntilIdle()

            assertEquals(1, container.resetForServerSwitchCount)
            assertEquals(1, server.requestCount)
            assertNull(container.tokenVault.getToken())
            assertNull(container.settingsStore.getServerOrigin())
            assertFalse(vm.uiState.value.isLoggingOut)
            assertEquals(
                AppRoute.Onboarding(serverOrigin = null, sessionExpired = false),
                vm.uiState.value.route,
            )
        }

    private class TestAppContainer(
        override val okHttpClient: OkHttpClient,
        initialServerOrigin: String?,
        initialToken: String?,
        useRealAuthRepository: Boolean = false,
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
            allowInsecureHttpForTest = true,
        )

        val fakeAuthRepository = RecordingAuthRepository(settingsStore, tokenVault)
        override val authRepository: AuthRepository = if (useRealAuthRepository) {
            DefaultAuthRepository(
                apiClient = apiClient,
                settingsStore = settingsStore,
                tokenVault = tokenVault,
                deviceNameProvider = { "dropit Android · Test" },
                json = json,
            )
        } else {
            fakeAuthRepository
        }

        override val realtimeClient: RealtimeClient = RealtimeClient(
            okHttpClient = okHttpClient,
            credentialsProvider = creds,
            json = json,
            allowInsecureHttpForTest = true,
        )
        override val spaceRepository: SpaceRepository = DefaultSpaceRepository(apiClient)
        override val boardRepository: BoardRepository = DefaultBoardRepository(apiClient)
        val recordingTransferManager = RecordingTransferManager()
        override val transferManager: TransferManager = recordingTransferManager
        val recordingShareInbox = RecordingShareInbox()
        override val shareInbox: ShareInbox = recordingShareInbox
        override val appUpdater: AppUpdater = PlaceholderAppUpdater()
        val recordingRoomRepository = RecordingRoomRepository()
        override val roomRepository: RoomRepository = recordingRoomRepository
        override val itemShareRepository: ItemShareRepository = PlaceholderItemShareRepository()
        val recordingMediaRepository = RecordingMediaRepository()
        override val mediaRepository: MediaRepository = recordingMediaRepository

        var resetForServerSwitchCount: Int = 0
            private set

        override suspend fun initialize(): MigrationResult {
            authRepository.refreshSessionState()
            return MigrationResult.NothingToMigrate
        }

        override suspend fun resetForServerSwitch() {
            resetForServerSwitchCount += 1
            realtimeClient.disconnect(clearState = true)
            roomRepository.clearRoomState()
            transferManager.clearAllForScopeSwitch()
            shareInbox.discardPendingShare()
            mediaRepository.clearCaches()
            authRepository.logout(clearServer = true)
        }
    }

    private class RecordingRoomRepository : RoomRepository {
        private val _activeRoom = MutableStateFlow<RoomInfo?>(null)
        override val activeRoom: StateFlow<RoomInfo?> = _activeRoom.asStateFlow()
        var clearRoomStateCount = 0

        override suspend fun createOrReuseRoom(code: String?, pin: String?): RoomInfo =
            throw UnsupportedOperationException()

        override suspend fun enterRoom(code: String, pin: String?): RoomInfo =
            throw UnsupportedOperationException()

        override suspend fun updateRoomCode(
            roomToken: String,
            code: OptionalField<String?>,
            pin: OptionalField<String?>,
        ): RoomInfo = throw UnsupportedOperationException()

        override suspend fun leaveCurrentRoom() {
            _activeRoom.value = null
        }

        override suspend fun clearRoomState() {
            clearRoomStateCount += 1
            _activeRoom.value = null
        }
    }

    private class RecordingTransferManager : TransferManager {
        private val _tasks = MutableStateFlow<List<TransferTask>>(emptyList())
        override val tasks: StateFlow<List<TransferTask>> = _tasks.asStateFlow()
        private val _activeCount = MutableStateFlow(0)
        override val activeCount: StateFlow<Int> = _activeCount.asStateFlow()
        var clearAllCount = 0

        override suspend fun enqueueUploads(requests: List<UploadFileRequest>): List<String> = emptyList()

        override suspend fun enqueueStagedUploads(
            stagedFiles: List<StagedShareFile>,
            targetScope: TargetScope,
            groupName: String?,
        ): List<String> = emptyList()

        override suspend fun enqueueDownload(request: DownloadFileRequest): String = ""
        override suspend fun downloadForShare(item: ClipItem, targetScope: TargetScope): Result<Uri> =
            Result.failure(UnsupportedOperationException())

        override suspend fun cancel(taskId: String) = Unit
        override suspend fun retry(taskId: String) = Unit
        override suspend fun clearCompleted() = Unit
        override suspend fun clearAllForScopeSwitch() {
            clearAllCount += 1
        }
    }

    private class RecordingShareInbox : ShareInbox {
        private val _pendingShare = MutableStateFlow<PendingShare?>(null)
        override val pendingShare: StateFlow<PendingShare?> = _pendingShare.asStateFlow()
        var discardPendingShareCount = 0

        override suspend fun captureIntent(intent: Intent?): Boolean = false
        override suspend fun consumePendingShare(): PendingShare? = null
        override suspend fun discardPendingShare() {
            discardPendingShareCount += 1
            _pendingShare.value = null
        }
    }

    private class RecordingMediaRepository : MediaRepository {
        var clearCachesCount = 0

        override suspend fun thumbnailUrl(scope: TargetScope, itemId: String): String = ""
        override suspend fun previewUrl(scope: TargetScope, itemId: String): String = ""
        override suspend fun mediaUrl(scope: TargetScope, itemId: String): String = ""
        override suspend fun downloadUrl(scope: TargetScope, itemId: String): String = ""
        override fun createImageLoader(): ImageLoader = throw UnsupportedOperationException()
        override fun createMediaDataSourceFactory(): DataSource.Factory = throw UnsupportedOperationException()
        override suspend fun fetchTextContent(scope: TargetScope, itemId: String, maxBytes: Int): String = ""
        override suspend fun clearCaches() {
            clearCachesCount += 1
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

        val clearLocalSessionCalls = mutableListOf<Boolean>()
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

        override suspend fun clearLocalSession(clearServer: Boolean) {
            clearLocalSessionCalls.add(clearServer)
            tokenVault.clearToken()
            if (clearServer) {
                settingsStore.clearServerConfig()
            }
            _deviceAuthState.value = DeviceAuthState.Idle
            refreshSessionState()
        }

        override suspend fun logout(clearServer: Boolean) {
            logoutClearServerCalls.add(clearServer)
            tokenVault.clearToken()
            if (clearServer) {
                settingsStore.clearServerConfig()
            }
            _deviceAuthState.value = DeviceAuthState.Idle
            refreshSessionState()
        }

        override fun resetDeviceAuthState() {
            _deviceAuthState.value = DeviceAuthState.Idle
        }
    }
}
