package dev.dropit.app.data.transfer

import dev.dropit.app.core.auth.AppSettings
import dev.dropit.app.core.auth.DefaultAuthRepository
import dev.dropit.app.core.auth.InMemorySettingsStore
import dev.dropit.app.core.auth.InMemoryTokenVault
import dev.dropit.app.core.network.DropitApiClient
import dev.dropit.app.core.network.SessionCredentialsProvider
import dev.dropit.app.core.repository.TransferDirection
import dev.dropit.app.core.repository.TransferStatus
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.nio.file.Files

/**
 * Tests the real [DefaultTransferScopeProvider] implementation for:
 * - Same-server logout (`clearServer = false`) immediately hiding previous account's tasks
 * - Same-server account switch isolating tasks strictly per account token/userId
 * - Offline `tok:<fp>` fallback seamlessly migrating rows via `reassignAccountId` once `/api/me` resolves
 */
class DefaultTransferScopeProviderTest {

    private lateinit var server: MockWebServer
    private lateinit var okHttpClient: OkHttpClient
    private lateinit var baseUrl: String
    private lateinit var tempRoot: File
    private lateinit var managerScope: CoroutineScope

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        baseUrl = server.url("/").toString().trimEnd('/')
        okHttpClient = OkHttpClient.Builder().build()
        tempRoot = Files.createTempDirectory("dropit-scope-provider-test").toFile()
        managerScope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
    }

    @After
    fun tearDown() {
        managerScope.cancel()
        server.shutdown()
        okHttpClient.dispatcher.executorService.shutdown()
        okHttpClient.connectionPool.evictAll()
        tempRoot.deleteRecursively()
    }

    private fun createApiClient(
        settingsStore: InMemorySettingsStore,
        tokenVault: InMemoryTokenVault,
    ): DropitApiClient {
        val creds = object : SessionCredentialsProvider {
            override suspend fun serverOrigin(): String? = settingsStore.getServerOrigin()
            override suspend fun accessToken(): String? = tokenVault.getToken()
            override suspend fun deviceId(): String = settingsStore.getOrCreateDeviceId()
            override fun deviceName(): String = "dropit Android · ScopeTest"
        }
        return DropitApiClient(
            okHttpClient = okHttpClient,
            credentialsProvider = creds,
            allowInsecureHttpForTest = true,
        )
    }

    private fun meJson(userId: String): String =
        """{"user":{"id":"$userId","email":"$userId@dropit.dev","name":"$userId","role":"user","disabled":0,"pending":0,"createdAt":1}}"""

    @Test
    fun sameServerLogoutAndAccountSwitch_neverLeakPreviousAccountQueue() = runTest {
        val tokenA = "tok_account_a_11111111111111111111"
        val tokenB = "tok_account_b_22222222222222222222"

        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                return when {
                    request.path == "/api/me" && request.getHeader("Authorization") == "Bearer $tokenA" ->
                        MockResponse().setResponseCode(200).setBody(meJson("user-A"))
                    request.path == "/api/me" && request.getHeader("Authorization") == "Bearer $tokenB" ->
                        MockResponse().setResponseCode(200).setBody(meJson("user-B"))
                    request.path == "/api/auth/logout" ->
                        MockResponse().setResponseCode(204)
                    else -> MockResponse().setResponseCode(401)
                }
            }
        }

        val settingsStore = InMemorySettingsStore(AppSettings(serverOrigin = baseUrl))
        val tokenVault = InMemoryTokenVault(tokenA)
        val apiClient = createApiClient(settingsStore, tokenVault)
        val authRepo = DefaultAuthRepository(
            apiClient = apiClient,
            settingsStore = settingsStore,
            tokenVault = tokenVault,
            deviceNameProvider = { "dropit Android · Test" },
        )
        authRepo.refreshSessionState()

        val dao = InMemoryTransferDao()
        val scopeProvider = DefaultTransferScopeProvider(
            settingsStore = settingsStore,
            tokenVault = tokenVault,
            authRepository = authRepo,
            apiClient = apiClient,
            dao = dao,
        )

        val uploadStaging = File(tempRoot, "up").apply { mkdirs() }
        val downloadTemp = File(tempRoot, "dl").apply { mkdirs() }
        val dummySink = object : DownloadSink {
            override fun saveToSystemDownloads(sourceFile: File, fileName: String, mimeType: String) =
                SavedDownloadResult("file://${sourceFile.absolutePath}")
            override fun saveToShareCache(sourceFile: File, itemId: String, fileName: String) =
                SavedDownloadResult("file://${sourceFile.absolutePath}")
            override fun mimeFromExtension(ext: String): String? = null
            override fun extensionFromMime(mime: String): String? = null
        }
        val engine = TransferEngine(
            apiClient = apiClient,
            dao = dao,
            downloadSink = dummySink,
            downloadTempDir = downloadTemp,
            ownedStagingRoots = listOf(uploadStaging, downloadTemp),
        )
        val scheduler = object : TransferWorkScheduler {
            override fun enqueue(taskId: String) = Unit
            override fun cancel(taskId: String) = Unit
            override fun cancelAll() = Unit
            override suspend fun isWorkActive(taskId: String) = false
        }
        val manager = DefaultTransferManager(
            dao = dao,
            engine = engine,
            scheduler = scheduler,
            scopeProvider = scopeProvider,
            uploadUriStager = { _, _, _ -> error("unused") },
            uploadStagingDir = uploadStaging,
            downloadTempDir = downloadTemp,
            coroutineScope = managerScope,
        )

        // 1. Account A resolves user-A and has task-A.
        val scopeA = scopeProvider.currentScope()
        assertEquals(TransferScopeKey(baseUrl, "user-A"), scopeA)
        dao.upsert(
            TransferTaskEntity(
                id = "task-A",
                serverOrigin = baseUrl,
                accountId = "user-A",
                targetScopeType = "space",
                targetScopeId = "sp-A",
                direction = TransferDirection.UPLOAD.name,
                fileName = "secret-a.pdf",
                mimeType = "application/pdf",
                totalBytes = 100L,
                status = TransferStatus.QUEUED.name,
                createdAt = 1L,
                updatedAt = 1L,
            ),
        )
        assertEquals(listOf("task-A"), manager.tasks.first { it.isNotEmpty() }.map { it.id })

        // 2. Logout on the SAME server (clearServer = false) -> activeScope must drop user-A immediately!
        authRepo.logout(clearServer = false)
        assertEquals(baseUrl, settingsStore.getServerOrigin())
        val loggedOutScope = scopeProvider.activeScope.first { it?.accountId == null }
        assertEquals(baseUrl, loggedOutScope?.serverOrigin)
        assertNull(loggedOutScope?.accountId)
        assertTrue(manager.tasks.first { it.isEmpty() }.isEmpty())

        // 3. Sign in as Account B on the SAME server -> activeScope must NOT leak task-A!
        authRepo.completeAuthorization(baseUrl, tokenB)
        val scopeB = scopeProvider.currentScope()
        assertEquals(TransferScopeKey(baseUrl, "user-B"), scopeB)
        assertEquals(TransferScopeKey(baseUrl, "user-B"), scopeProvider.activeScope.first { it?.accountId == "user-B" })

        dao.upsert(
            TransferTaskEntity(
                id = "task-B",
                serverOrigin = baseUrl,
                accountId = "user-B",
                targetScopeType = "space",
                targetScopeId = "sp-B",
                direction = TransferDirection.UPLOAD.name,
                fileName = "only-b.pdf",
                mimeType = "application/pdf",
                totalBytes = 200L,
                status = TransferStatus.QUEUED.name,
                createdAt = 2L,
                updatedAt = 2L,
            ),
        )
        assertEquals(listOf("task-B"), manager.tasks.first { it.map { t -> t.id } == listOf("task-B") }.map { it.id })
    }

    @Test
    fun offlineTokenFingerprintScope_migratesRowsAtomicallyWhenGetMeSucceeds() = runTest {
        val token = "tok_offline_user_999999999999999"
        val expectedFallbackId = "tok:${DefaultTransferScopeProvider.tokenFingerprint(token)}"
        var online = false

        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                return if (online && request.path == "/api/me") {
                    MockResponse().setResponseCode(200).setBody(meJson("user-real-42"))
                } else {
                    MockResponse().setResponseCode(503)
                }
            }
        }

        val settingsStore = InMemorySettingsStore(AppSettings(serverOrigin = baseUrl))
        val tokenVault = InMemoryTokenVault(token)
        val apiClient = createApiClient(settingsStore, tokenVault)
        val authRepo = DefaultAuthRepository(
            apiClient = apiClient,
            settingsStore = settingsStore,
            tokenVault = tokenVault,
            deviceNameProvider = { "dropit Android · OfflineTest" },
        )
        authRepo.refreshSessionState()

        val dao = InMemoryTransferDao()
        val scopeProvider = DefaultTransferScopeProvider(
            settingsStore = settingsStore,
            tokenVault = tokenVault,
            authRepository = authRepo,
            apiClient = apiClient,
            dao = dao,
        )

        // While offline, scope uses deterministic non-raw token fingerprint.
        val offlineScope = scopeProvider.currentScope()
        assertEquals(TransferScopeKey(baseUrl, expectedFallbackId), offlineScope)
        dao.upsert(
            TransferTaskEntity(
                id = "offline-task-1",
                serverOrigin = baseUrl,
                accountId = expectedFallbackId,
                targetScopeType = "space",
                targetScopeId = "sp-1",
                direction = TransferDirection.UPLOAD.name,
                fileName = "queued-offline.bin",
                mimeType = "application/octet-stream",
                totalBytes = 512L,
                status = TransferStatus.QUEUED.name,
                createdAt = 1L,
                updatedAt = 1L,
            ),
        )

        // Once online, /api/me resolves user-real-42 and reassigns existing offline rows cleanly.
        online = true
        val onlineScope = scopeProvider.currentScope()
        assertEquals(TransferScopeKey(baseUrl, "user-real-42"), onlineScope)
        assertEquals(
            TransferScopeKey(baseUrl, "user-real-42"),
            scopeProvider.activeScope.first { it?.accountId == "user-real-42" },
        )

        val migrated = dao.getById("offline-task-1")
        assertEquals("user-real-42", migrated?.accountId)
        assertEquals(listOf("offline-task-1"), dao.listByScope(baseUrl, "user-real-42").map { it.id })
        assertTrue(dao.listByScope(baseUrl, expectedFallbackId).isEmpty())
    }
}
