package dev.dropit.app.data.migration

import dev.dropit.app.core.auth.AesGcmCrypto
import dev.dropit.app.core.auth.AuthRepository
import dev.dropit.app.core.auth.DefaultAuthRepository
import dev.dropit.app.core.auth.InMemorySettingsStore
import dev.dropit.app.core.auth.LegacyCapacitorMigrator
import dev.dropit.app.core.auth.LegacyPrefsReader
import dev.dropit.app.core.auth.MigrationResult
import dev.dropit.app.core.auth.TokenVault
import dev.dropit.app.core.network.ApiError
import dev.dropit.app.core.network.ApiErrorCode
import dev.dropit.app.core.network.ClipItem
import dev.dropit.app.core.network.DropitApiClient
import dev.dropit.app.core.network.SessionCredentialsProvider
import dev.dropit.app.core.network.TargetScope
import dev.dropit.app.core.realtime.RealtimeClient
import dev.dropit.app.core.repository.DefaultBoardRepository
import dev.dropit.app.core.repository.DefaultSpaceRepository
import dev.dropit.app.core.repository.DownloadFileRequest
import dev.dropit.app.core.repository.TransferDirection
import dev.dropit.app.core.repository.TransferStatus
import dev.dropit.app.data.itemshare.DefaultItemShareRepository
import dev.dropit.app.data.media.DefaultMediaRepository
import dev.dropit.app.data.room.DefaultRoomRepository
import dev.dropit.app.data.room.InMemoryRoomKeyStore
import dev.dropit.app.data.room.RoomKeyGenerator
import dev.dropit.app.data.share.DefaultShareInbox
import dev.dropit.app.data.share.ExtractedSharePayload
import dev.dropit.app.data.share.ShareIntentExtractor
import dev.dropit.app.data.transfer.DefaultTransferManager
import dev.dropit.app.data.transfer.DefaultTransferScopeProvider
import dev.dropit.app.data.transfer.DownloadSink
import dev.dropit.app.data.transfer.SavedDownloadEntity
import dev.dropit.app.data.transfer.SavedDownloadResult
import dev.dropit.app.data.transfer.TransferDao
import dev.dropit.app.data.transfer.TransferEngine
import dev.dropit.app.data.transfer.TransferTaskEntity
import dev.dropit.app.data.transfer.TransferWorkScheduler
import dev.dropit.app.data.transfer.UploadUriStager
import dev.dropit.app.di.performServerSwitchReset
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
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
import java.io.File
import java.nio.file.Files
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean
import javax.crypto.KeyGenerator

/**
 * Closed-loop automated verification for Stage 3A requirement #4:
 * - Legacy Capacitor SharedPreferences (`CapacitorStorage` & `dropit_app`) upgrade migration
 * - Idempotency across repeated cold restarts (never losing migrated session/token/deviceId)
 * - Seamless reuse of legacy `read/write/web` Bearer tokens across spaces, rooms, shares & media
 * - Smooth recovery on expired/revoked token (HTTP 401 -> preserve serverOrigin -> re-authorize)
 * - Atomic server switch cleanup: old token, room secret keys, Room transfer queue + staging files,
 *   pending share, cached updates, and Coil image caches are all wiped before signing in to Server B.
 */
class UpgradeMigrationAndIsolationTest {

    private lateinit var serverA: MockWebServer
    private lateinit var serverB: MockWebServer
    private lateinit var okHttpClient: OkHttpClient
    private lateinit var tempRoot: File
    private lateinit var scope: CoroutineScope

    @Before
    fun setUp() {
        serverA = MockWebServer().apply { start() }
        serverB = MockWebServer().apply { start() }
        okHttpClient = OkHttpClient.Builder().build()
        tempRoot = Files.createTempDirectory("dropit-upgrade-isolation-test").toFile()
        scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
    }

    @After
    fun tearDown() {
        scope.cancel()
        serverA.shutdown()
        serverB.shutdown()
        okHttpClient.dispatcher.executorService.shutdown()
        okHttpClient.connectionPool.evictAll()
        tempRoot.deleteRecursively()
    }

    /**
     * Simulates Android's SharedPreferences XML files (`CapacitorStorage` and `dropit_app`)
     * created by legacy dropit Android 0.3.2 (versionCode 5).
     */
    private class SimulatedLegacySharedPreferences(
        val capacitorStorage: MutableMap<String, String?> = mutableMapOf(),
        val dropitAppPrefs: MutableMap<String, String?> = mutableMapOf(),
    ) : LegacyPrefsReader {
        override fun getString(prefsName: String, key: String): String? = when (prefsName) {
            LegacyCapacitorMigrator.CAPACITOR_PREFS -> capacitorStorage[key]
            LegacyCapacitorMigrator.DROPIT_APP_PREFS -> dropitAppPrefs[key]
            else -> null
        }
    }

    /**
     * Encrypted TokenVault backed by real JCE AES-256-GCM (`AesGcmCrypto`) to verify that
     * migrated legacy tokens are stored strictly as ciphertext, never plaintext.
     */
    private class AesEncryptedTestTokenVault : TokenVault {
        private val secretKey = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
        private val mutex = Mutex()
        var persistedCiphertext: String? = null
            private set

        override suspend fun getToken(): String? = mutex.withLock {
            val blob = persistedCiphertext ?: return@withLock null
            runCatching { AesGcmCrypto.decrypt(blob, secretKey) }.getOrNull()
        }

        override suspend fun saveToken(token: String) = mutex.withLock {
            require(token.isNotBlank())
            persistedCiphertext = AesGcmCrypto.encrypt(token, secretKey)
        }

        override suspend fun clearToken() = mutex.withLock {
            persistedCiphertext = null
        }
    }

    private class InMemoryDao : TransferDao {
        private val state = MutableStateFlow<List<TransferTaskEntity>>(emptyList())

        override fun observeByScope(serverOrigin: String, accountId: String?): Flow<List<TransferTaskEntity>> =
            state.map { list ->
                list.filter { it.serverOrigin == serverOrigin && it.accountId == accountId }
                    .sortedWith(compareByDescending<TransferTaskEntity> { it.createdAt }.thenByDescending { it.id })
            }

        override suspend fun listByScope(serverOrigin: String, accountId: String?): List<TransferTaskEntity> =
            state.value.filter { it.serverOrigin == serverOrigin && it.accountId == accountId }
                .sortedWith(compareByDescending<TransferTaskEntity> { it.createdAt }.thenByDescending { it.id })

        override suspend fun listAll(): List<TransferTaskEntity> =
            state.value.sortedWith(compareByDescending<TransferTaskEntity> { it.createdAt }.thenByDescending { it.id })

        override suspend fun listByStatus(status: String): List<TransferTaskEntity> =
            state.value.filter { it.status == status }

        override suspend fun getById(id: String): TransferTaskEntity? = state.value.firstOrNull { it.id == id }

        override suspend fun upsert(entity: TransferTaskEntity) {
            state.value = state.value.filterNot { it.id == entity.id } + entity
        }

        override suspend fun upsertAll(entities: List<TransferTaskEntity>) {
            val ids = entities.mapTo(HashSet()) { it.id }
            state.value = state.value.filterNot { it.id in ids } + entities
        }

        override suspend fun updateStatus(id: String, status: String, errorMessage: String?, updatedAt: Long) {
            state.value = state.value.map {
                if (it.id == id) it.copy(status = status, errorMessage = errorMessage, updatedAt = updatedAt) else it
            }
        }

        override suspend fun updateUploadSession(
            id: String,
            remoteUploadId: String?,
            chunkSize: Int,
            completedChunks: String,
            transferredBytes: Long,
            updatedAt: Long,
        ) {
            state.value = state.value.map {
                if (it.id == id) {
                    it.copy(
                        remoteUploadId = remoteUploadId,
                        chunkSize = chunkSize,
                        completedChunks = completedChunks,
                        transferredBytes = transferredBytes,
                        updatedAt = updatedAt,
                    )
                } else {
                    it
                }
            }
        }

        override suspend fun updateProgress(
            id: String,
            transferredBytes: Long,
            completedChunks: String,
            updatedAt: Long,
        ) {
            state.value = state.value.map {
                if (it.id == id) {
                    it.copy(
                        transferredBytes = transferredBytes,
                        completedChunks = completedChunks,
                        updatedAt = updatedAt,
                    )
                } else {
                    it
                }
            }
        }

        override suspend fun updateFileMetadata(
            id: String,
            fileName: String,
            mimeType: String,
            totalBytes: Long,
            updatedAt: Long,
        ) {
            state.value = state.value.map {
                if (it.id == id) {
                    it.copy(fileName = fileName, mimeType = mimeType, totalBytes = totalBytes, updatedAt = updatedAt)
                } else {
                    it
                }
            }
        }

        override suspend fun markSucceeded(
            id: String,
            status: String,
            transferredBytes: Long,
            localResultUri: String?,
            updatedAt: Long,
        ) {
            state.value = state.value.map {
                if (it.id == id) {
                    it.copy(
                        status = status,
                        transferredBytes = transferredBytes,
                        localResultUri = localResultUri,
                        remoteUploadId = null,
                        localStagedPath = null,
                        errorMessage = null,
                        updatedAt = updatedAt,
                    )
                } else {
                    it
                }
            }
        }

        override suspend fun reassignAccountId(
            serverOrigin: String,
            oldAccountId: String,
            newAccountId: String,
            updatedAt: Long,
        ) {
            state.value = state.value.map {
                if (it.serverOrigin == serverOrigin && it.accountId == oldAccountId) {
                    it.copy(accountId = newAccountId, updatedAt = updatedAt)
                } else {
                    it
                }
            }
        }

        override suspend fun deleteCompletedForScope(serverOrigin: String, accountId: String?) {
            state.value = state.value.filterNot {
                it.serverOrigin == serverOrigin && it.accountId == accountId &&
                    (it.status == TransferStatus.SUCCEEDED.name || it.status == TransferStatus.CANCELLED.name)
            }
        }

        override suspend fun deleteByScope(serverOrigin: String, accountId: String?) {
            state.value = state.value.filterNot { it.serverOrigin == serverOrigin && it.accountId == accountId }
        }

        override suspend fun deleteById(id: String) {
            state.value = state.value.filterNot { it.id == id }
        }

        override suspend fun deleteAll() {
            state.value = emptyList()
        }

        private val savedState = MutableStateFlow<Map<Triple<String, String, String>, SavedDownloadEntity>>(emptyMap())

        override suspend fun findActiveDownloadForItem(
            serverOrigin: String,
            accountId: String?,
            remoteItemId: String,
        ): TransferTaskEntity? = state.value.firstOrNull {
            it.serverOrigin == serverOrigin &&
                it.accountId == accountId &&
                it.direction == TransferDirection.DOWNLOAD.name &&
                !it.shareAfterDownload &&
                it.remoteItemId == remoteItemId &&
                (it.status == TransferStatus.QUEUED.name || it.status == TransferStatus.RUNNING.name)
        }

        override fun observeSavedDownloadsByScope(serverOrigin: String, accountId: String): Flow<List<SavedDownloadEntity>> =
            savedState.map { map ->
                map.values.filter { it.serverOrigin == serverOrigin && it.accountId == accountId }
                    .sortedWith(compareByDescending<SavedDownloadEntity> { it.savedAt }.thenBy { it.remoteItemId })
            }

        override suspend fun listSavedDownloadsByScope(serverOrigin: String, accountId: String): List<SavedDownloadEntity> =
            savedState.value.values.filter { it.serverOrigin == serverOrigin && it.accountId == accountId }
                .sortedWith(compareByDescending<SavedDownloadEntity> { it.savedAt }.thenBy { it.remoteItemId })

        override suspend fun listAllSavedDownloads(): List<SavedDownloadEntity> =
            savedState.value.values.sortedWith(compareByDescending<SavedDownloadEntity> { it.savedAt }.thenBy { it.remoteItemId })

        override suspend fun getSavedDownload(serverOrigin: String, accountId: String, remoteItemId: String): SavedDownloadEntity? =
            savedState.value[Triple(serverOrigin, accountId, remoteItemId)]

        override suspend fun upsertSavedDownload(entity: SavedDownloadEntity) {
            savedState.value = savedState.value + (Triple(entity.serverOrigin, entity.accountId, entity.remoteItemId) to entity)
        }

        override suspend fun deleteSavedDownload(serverOrigin: String, accountId: String, remoteItemId: String) {
            savedState.value = savedState.value - Triple(serverOrigin, accountId, remoteItemId)
        }

        override suspend fun deleteSavedDownloadsByScope(serverOrigin: String, accountId: String) {
            savedState.value = savedState.value.filterValues { !(it.serverOrigin == serverOrigin && it.accountId == accountId) }
        }

        override suspend fun deleteAllSavedDownloads() {
            savedState.value = emptyMap()
        }

        override suspend fun reassignSavedDownloadsAccountId(serverOrigin: String, oldAccountId: String, newAccountId: String) {
            val next = LinkedHashMap<Triple<String, String, String>, SavedDownloadEntity>()
            savedState.value.values.forEach { entity ->
                val updated = if (entity.serverOrigin == serverOrigin && entity.accountId == oldAccountId) {
                    entity.copy(accountId = newAccountId)
                } else {
                    entity
                }
                next[Triple(updated.serverOrigin, updated.accountId, updated.remoteItemId)] = updated
            }
            savedState.value = next
        }
    }

    @Test
    fun upgradeFromLegacyCapacitor_migratesIdempotentlyAndReusesReadWriteWebToken() = runTest {
        val legacyToken = "LegacyRWWebToken_0123456789abcdefghijklmnoP"
        val legacyDeviceId = "and-LegacyCapDevice12345"
        val legacyOrigin = "https://dropit.lthero.com"

        val legacyPrefs = SimulatedLegacySharedPreferences(
            capacitorStorage = mutableMapOf(
                LegacyCapacitorMigrator.KEY_SERVER to "$legacyOrigin/",
                LegacyCapacitorMigrator.KEY_TOKEN to legacyToken,
                LegacyCapacitorMigrator.KEY_DEVICE_ID to legacyDeviceId,
                LegacyCapacitorMigrator.KEY_SKIP_UPDATE to "5",
            ),
            dropitAppPrefs = mutableMapOf(
                LegacyCapacitorMigrator.KEY_ORIGIN to legacyOrigin,
            ),
        )

        val settingsStore = InMemorySettingsStore()
        val tokenVault = AesEncryptedTestTokenVault()

        // Cold launch #1: migrates CapacitorStorage into new stores with encrypted token
        val migrator1 = LegacyCapacitorMigrator(legacyPrefs, settingsStore, tokenVault)
        val firstResult = migrator1.migrateIfNeeded()
        assertTrue(firstResult is MigrationResult.Migrated)
        val migrated = firstResult as MigrationResult.Migrated
        assertEquals(legacyOrigin, migrated.serverOrigin)
        assertTrue(migrated.tokenMigrated)
        assertTrue(migrated.deviceIdMigrated)
        assertEquals(5, migrated.skipUpdateVersionCode)

        // Verify token is stored encrypted, never plaintext
        assertNotNull(tokenVault.persistedCiphertext)
        assertFalse(tokenVault.persistedCiphertext!!.contains(legacyToken))
        assertEquals(legacyToken, tokenVault.getToken())

        // Cold launch #2 & #3: even if legacy SharedPreferences disappear later, state is preserved
        legacyPrefs.capacitorStorage.clear()
        legacyPrefs.dropitAppPrefs.clear()
        val migrator2 = LegacyCapacitorMigrator(legacyPrefs, settingsStore, tokenVault)
        assertEquals(MigrationResult.AlreadyMigrated, migrator2.migrateIfNeeded())
        assertEquals(MigrationResult.AlreadyMigrated, migrator2.migrateIfNeeded())
        assertEquals(legacyOrigin, settingsStore.getServerOrigin())
        assertEquals(legacyToken, tokenVault.getToken())
        assertEquals(legacyDeviceId, settingsStore.current().deviceId)
        assertEquals(5, settingsStore.current().skipUpdateVersionCode)

        // Also verify fallback to dropit_app["origin"] when CapacitorStorage["server"] is absent
        val fallbackPrefs = SimulatedLegacySharedPreferences(
            capacitorStorage = mutableMapOf(
                LegacyCapacitorMigrator.KEY_TOKEN to legacyToken,
            ),
            dropitAppPrefs = mutableMapOf(
                LegacyCapacitorMigrator.KEY_ORIGIN to "https://fallback.lthero.com/",
            ),
        )
        val fallbackSettings = InMemorySettingsStore()
        val fallbackVault = AesEncryptedTestTokenVault()
        val fallbackResult = LegacyCapacitorMigrator(fallbackPrefs, fallbackSettings, fallbackVault).migrateIfNeeded()
        assertTrue(fallbackResult is MigrationResult.Migrated)
        assertEquals("https://fallback.lthero.com", fallbackSettings.getServerOrigin())
        assertEquals(legacyToken, fallbackVault.getToken())
    }

    @Test
    fun legacyTokenReuse_revoked401SmoothRelogin_andAtomicServerSwitchIsolation() = runTest {
        val originA = serverA.url("/").toString().trimEnd('/')
        val originB = serverB.url("/").toString().trimEnd('/')
        val legacyTokenA = "LegacyRWWebTokenA_0123456789abcdefghijklmNO"
        val refreshedTokenA = "FreshTokenA_0123456789abcdefghijklmnopqrstU"
        val tokenB = "AccountBToken_0123456789abcdefghijklmnopqrS"

        val revokedA = AtomicBoolean(false)
        val logoutCalledOnA = AtomicBoolean(false)
        val serverARoomKeys = CopyOnWriteArrayList<String>()
        val serverBRoomKeys = CopyOnWriteArrayList<String>()
        val serverBSeenAuthHeaders = CopyOnWriteArrayList<String?>()
        val serverAAuthHeadersAfterSwitch = CopyOnWriteArrayList<String?>()
        val switchedToB = AtomicBoolean(false)

        serverA.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val auth = request.getHeader("Authorization")
                if (switchedToB.get()) {
                    serverAAuthHeadersAfterSwitch.add(auth)
                }
                if (request.path == "/api/auth/device/authorize") {
                    return MockResponse().setResponseCode(200).setBody(
                        """{"device_code":"dev-a-2","user_code":"ABCD-1234","verification_uri":"$originA/device","verification_uri_complete":"$originA/device?code=ABCD-1234","expires_in":600,"interval":1}""",
                    )
                }
                if (request.path == "/api/auth/device/token") {
                    return MockResponse().setResponseCode(200).setBody(
                        """{"access_token":"$refreshedTokenA","token_type":"Bearer","scope":"read write"}""",
                    )
                }
                if (request.path == "/api/auth/logout") {
                    logoutCalledOnA.set(true)
                    return MockResponse().setResponseCode(204)
                }

                val validAuth = if (revokedA.get()) "Bearer $refreshedTokenA" else "Bearer $legacyTokenA"
                if (auth != validAuth) {
                    return MockResponse().setResponseCode(401).setBody("""{"error":{"code":"UNAUTHENTICATED"}}""")
                }

                return when {
                    request.path == "/api/me" -> MockResponse().setResponseCode(200).setBody(
                        """{"user":{"id":"user-A","email":"a@dropit.dev","name":"Alice","role":"user","disabled":0,"pending":0,"createdAt":1}}""",
                    )
                    request.path == "/api/spaces" -> MockResponse().setResponseCode(200).setBody(
                        """{"spaces":[{"id":"sp-A","name":"Alice Space","ownerId":"user-A","role":"owner"}]}""",
                    )
                    request.path == "/api/rooms" && request.method == "POST" -> {
                        val body = request.body.readUtf8()
                        Regex(""""deviceKey"\s*:\s*"([^"]+)"""").find(body)?.groupValues?.get(1)?.let {
                            serverARoomKeys.add(it)
                        }
                        MockResponse().setResponseCode(201).setBody(
                            """{"token":"room-A.proof","code":"RmA123","hasPin":false,"expiresAt":1900000000000,"url":"/r/RmA123","reused":false}""",
                        )
                    }
                    request.path == "/api/spaces/sp-A/items/it-1/shares" && request.method == "POST" ->
                        MockResponse().setResponseCode(201).setBody(
                            """{"id":"sh-A","itemId":"it-1","expiresAt":1900000000000,"maxViews":1,"views":0,"revoked":0,"createdAt":1,"token":"ShA123","url":"/s/ShA123"}""",
                        )
                    request.path == "/api/spaces/sp-A/items/it-1/thumbnail" ->
                        MockResponse().setResponseCode(200).setBody("webp-thumb-A")
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }

        serverB.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                serverBSeenAuthHeaders.add(request.getHeader("Authorization"))
                if (request.getHeader("Authorization") != "Bearer $tokenB") {
                    return MockResponse().setResponseCode(401).setBody("""{"error":{"code":"UNAUTHENTICATED"}}""")
                }
                return when {
                    request.path == "/api/me" -> MockResponse().setResponseCode(200).setBody(
                        """{"user":{"id":"user-B","email":"b@dropit.dev","name":"Bob","role":"user","disabled":0,"pending":0,"createdAt":1}}""",
                    )
                    request.path == "/api/rooms" && request.method == "POST" -> {
                        val body = request.body.readUtf8()
                        Regex(""""deviceKey"\s*:\s*"([^"]+)"""").find(body)?.groupValues?.get(1)?.let {
                            serverBRoomKeys.add(it)
                        }
                        MockResponse().setResponseCode(201).setBody(
                            """{"token":"room-B.proof","code":"RmB456","hasPin":false,"expiresAt":1900000000000,"url":"/r/RmB456","reused":false}""",
                        )
                    }
                    request.path == "/api/spaces/sp-B/items/it-b/thumbnail" ->
                        MockResponse().setResponseCode(200).setBody("webp-thumb-B")
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }

        val settingsStore = InMemorySettingsStore()
        val tokenVault = AesEncryptedTestTokenVault()
        // Populate migrated state pointing to MockWebServer A (with legacy read/write/web token)
        settingsStore.setServerOrigin(originA)
        settingsStore.setDeviceId("and-MigratedDevice123456")
        settingsStore.setSkipUpdateVersionCode(5)
        settingsStore.markLegacyMigrated()
        tokenVault.saveToken(legacyTokenA)

        val creds = object : SessionCredentialsProvider {
            override suspend fun serverOrigin(): String? = settingsStore.getServerOrigin()
            override suspend fun accessToken(): String? = tokenVault.getToken()
            override suspend fun deviceId(): String = settingsStore.getOrCreateDeviceId()
            override fun deviceName(): String = "dropit Android · UpgradeTest"
        }
        val apiClient = DropitApiClient(
            okHttpClient = okHttpClient,
            credentialsProvider = creds,
            allowInsecureHttpForTest = true,
        )
        val authRepo = DefaultAuthRepository(
            apiClient = apiClient,
            settingsStore = settingsStore,
            tokenVault = tokenVault,
            deviceNameProvider = { "dropit Android · UpgradeTest" },
        )
        authRepo.refreshSessionState()
        assertTrue(authRepo.sessionState.value.isSignedIn)

        val realtimeClient = RealtimeClient(
            okHttpClient = okHttpClient,
            credentialsProvider = creds,
            allowInsecureHttpForTest = true,
        )
        val spaceRepo = DefaultSpaceRepository(apiClient)
        val roomKeyStore = InMemoryRoomKeyStore()
        val roomRepo = DefaultRoomRepository(apiClient, roomKeyStore, settingsStore)
        val itemShareRepo = DefaultItemShareRepository(apiClient)

        val imageCacheDir = File(tempRoot, "image_cache").apply { mkdirs() }
        val uploadStagingDir = File(tempRoot, "upload_staging").apply { mkdirs() }
        val shareStagingDir = File(tempRoot, "share_staging").apply { mkdirs() }
        val downloadTempDir = File(tempRoot, "download_temp").apply { mkdirs() }
        val updateCacheDir = File(tempRoot, "update_cache").apply { mkdirs() }

        val cacheClearedSignals = Channel<Unit>(Channel.UNLIMITED)
        val mediaRepo = DefaultMediaRepository(
            context = null,
            baseOkHttpClient = okHttpClient,
            apiClient = apiClient,
            credentialsProvider = creds,
            imageCacheDir = imageCacheDir,
            sessionStateFlow = authRepo.sessionState,
            coroutineScope = scope,
            onCachesCleared = { cacheClearedSignals.trySend(Unit) },
        )

        val dao = InMemoryDao()
        val scopeProvider = DefaultTransferScopeProvider(
            settingsStore = settingsStore,
            tokenVault = tokenVault,
            authRepository = authRepo,
            apiClient = apiClient,
            dao = dao,
        )
        val dummySink = object : DownloadSink {
            override fun saveToSystemDownloads(sourceFile: File, fileName: String, mimeType: String) =
                SavedDownloadResult("file://${sourceFile.absolutePath}")
            override fun saveToShareCache(sourceFile: File, itemId: String, fileName: String) =
                SavedDownloadResult("file://${sourceFile.absolutePath}")
            override fun mimeFromExtension(ext: String): String? = null
            override fun extensionFromMime(mime: String): String? = null
        }
        val transferEngine = TransferEngine(
            apiClient = apiClient,
            dao = dao,
            downloadSink = dummySink,
            downloadTempDir = downloadTempDir,
            ownedStagingRoots = listOf(uploadStagingDir, shareStagingDir, downloadTempDir),
        )
        val schedulerCancelledAll = AtomicBoolean(false)
        val scheduler = object : TransferWorkScheduler {
            override fun enqueue(taskId: String) = Unit
            override fun cancel(taskId: String) = Unit
            override fun cancelAll() {
                schedulerCancelledAll.set(true)
            }
            override suspend fun isWorkActive(taskId: String) = false
        }
        val transferManager = DefaultTransferManager(
            dao = dao,
            engine = transferEngine,
            scheduler = scheduler,
            scopeProvider = scopeProvider,
            uploadUriStager = UploadUriStager { _, _, _ -> error("unused") },
            uploadStagingDir = uploadStagingDir,
            downloadTempDir = downloadTempDir,
            coroutineScope = scope,
        )
        val shareInbox = DefaultShareInbox(
            stagingRootDir = shareStagingDir,
            extractor = ShareIntentExtractor { ExtractedSharePayload(text = "draft share") },
        )
        assertTrue(shareInbox.stagePayload(ExtractedSharePayload(text = "draft share")))
        assertNotNull(shareInbox.pendingShare.value)

        // 1. Legacy read/write/web token works smoothly across /api/me, spaces, rooms, item shares & media
        val meA = spaceRepo.getMe()
        assertEquals("user-A", meA.user.id)
        val spacesA = spaceRepo.getSpaces()
        assertEquals("sp-A", spacesA.single().id)
        val roomA = roomRepo.createOrReuseRoom()
        assertEquals("RmA123", roomA.code)
        val shareA = itemShareRepo.createShare(TargetScope.SpaceScope("sp-A"), "it-1", expiresIn = "1d", maxViews = 1)
        assertEquals("$originA/s/ShA123", shareA.url)
        val thumbUrlA = mediaRepo.thumbnailUrl(TargetScope.SpaceScope("sp-A"), "it-1")
        mediaRepo.mediaOkHttpClient.newCall(Request.Builder().url(thumbUrlA).build()).execute().use { res ->
            assertEquals(200, res.code)
            assertEquals("webp-thumb-A", res.body?.string())
        }
        // Simulate cached thumbnail & pending transfer + staged files + cached APK on Server A
        File(imageCacheDir, "thumb_a.webp").writeText("cached-thumb-a")
        File(uploadStagingDir, "task-a.bin").writeText("staged-upload-a")
        File(updateCacheDir, "dropit-update.apk").writeText("apk-bytes")
        transferManager.enqueueDownload(
            DownloadFileRequest(
                targetScope = TargetScope.SpaceScope("sp-A"),
                item = ClipItem(id = "it-1", spaceId = "sp-A", kind = "file", filename = "report.pdf", size = 128),
            ),
        )
        dao.upsertSavedDownload(
            SavedDownloadEntity(
                serverOrigin = originA,
                accountId = "user-A",
                remoteItemId = "it-1",
                localUri = "content://downloads/a-1",
                fileName = "report.pdf",
                mimeType = "application/pdf",
                fileSize = 128L,
                savedAt = 100L,
            ),
        )
        assertEquals(1, dao.listAll().size)
        assertEquals(1, dao.listAllSavedDownloads().size)

        // 2. Revoke legacy token -> 401 emits sessionExpiredEvents -> smooth same-server re-auth preserves serverOrigin
        revokedA.set(true)
        val expiredEvent = async(start = CoroutineStart.UNDISPATCHED) { apiClient.sessionExpiredEvents.first() }
        try {
            spaceRepo.getMe()
            fail("Expected 401 UNAUTHENTICATED after legacy token revocation")
        } catch (e: ApiError) {
            assertEquals(ApiErrorCode.UNAUTHENTICATED, e.errorCode)
            assertEquals(401, e.httpStatus)
        }
        assertEquals(originA, expiredEvent.await().serverOrigin)

        // Smooth re-login flow: logout(clearServer = false) keeps serverOrigin, wipes old token & image cache
        authRepo.logout(clearServer = false)
        withContext(Dispatchers.Default) { withTimeout(5_000L) { cacheClearedSignals.receive() } }
        assertEquals(originA, settingsStore.getServerOrigin())
        assertNull(tokenVault.getToken())
        assertFalse(authRepo.sessionState.value.isSignedIn)
        assertTrue("Logout must automatically wipe image caches", imageCacheDir.listFiles().isNullOrEmpty())

        // Re-authorize on the SAME server without re-entering server URL
        val deviceAuth = authRepo.startDeviceAuthorization(originA, AuthRepository.DEFAULT_SCOPES)
        val pollOutcome = authRepo.pollDeviceTokenOnce(originA, deviceAuth.deviceCode)
        assertTrue(pollOutcome is dev.dropit.app.core.auth.DevicePollOutcome.Token)
        authRepo.completeAuthorization(originA, (pollOutcome as dev.dropit.app.core.auth.DevicePollOutcome.Token).accessToken)
        assertTrue(authRepo.sessionState.value.isSignedIn)
        assertEquals("user-A", spaceRepo.getMe().user.id)

        // Re-populate Server A image cache & room state before server switch
        File(imageCacheDir, "thumb_a_again.webp").writeText("cached-thumb-a-2")
        roomRepo.createOrReuseRoom()
        assertNotNull(roomRepo.activeRoom.value)
        assertNotNull(roomKeyStore.getDeviceKey(originA))

        // 3. Atomic server switch reset (exact production sequence from AppContainer.kt)
        performServerSwitchReset(
            realtimeClient = realtimeClient,
            roomRepository = roomRepo,
            transferManager = transferManager,
            shareInbox = shareInbox,
            resetAppUpdater = { updateCacheDir.listFiles()?.forEach { it.deleteRecursively() } },
            mediaRepository = mediaRepo,
            authRepository = authRepo,
        )

        // Assert EVERY Server A artifact is atomically cleared
        assertTrue(logoutCalledOnA.get())
        assertNull(tokenVault.getToken())
        assertNull(settingsStore.getServerOrigin())
        assertNull(settingsStore.current().skipUpdateVersionCode)
        assertTrue("legacyMigrated flag must remain true after server switch", settingsStore.isLegacyMigrated())
        assertEquals("and-MigratedDevice123456", settingsStore.current().deviceId)
        assertNull(roomRepo.activeRoom.value)
        assertNull(roomKeyStore.getDeviceKey(originA))
        assertTrue(roomKeyStore.allOrigins().isEmpty())
        assertTrue(schedulerCancelledAll.get())
        assertTrue(dao.listAll().isEmpty())
        assertTrue(dao.listAllSavedDownloads().isEmpty())
        assertFalse(File(uploadStagingDir, "task-a.bin").exists())
        assertNull(shareInbox.pendingShare.value)
        assertTrue(imageCacheDir.listFiles().isNullOrEmpty())
        assertTrue(updateCacheDir.listFiles().isNullOrEmpty())

        // 4. Sign in to Server B with Account B -> completely isolated token, room key & media auth
        switchedToB.set(true)
        authRepo.completeAuthorization(originB, tokenB)
        assertEquals("user-B", spaceRepo.getMe().user.id)
        val roomB = roomRepo.createOrReuseRoom()
        assertEquals("RmB456", roomB.code)
        assertTrue(serverARoomKeys.isNotEmpty())
        assertTrue(serverBRoomKeys.isNotEmpty())
        assertTrue(RoomKeyGenerator.isValidDeviceKey(serverBRoomKeys.first()))
        assertNotEquals(
            "Server B must mint a fresh secret room key distinct from Server A",
            serverARoomKeys.first(),
            serverBRoomKeys.first(),
        )

        // Media requests to Server B carry Account B's token; requests to old Server A do NOT carry Account B's token
        val thumbUrlB = mediaRepo.thumbnailUrl(TargetScope.SpaceScope("sp-B"), "it-b")
        mediaRepo.mediaOkHttpClient.newCall(Request.Builder().url(thumbUrlB).build()).execute().use { res ->
            assertEquals(200, res.code)
            assertEquals("webp-thumb-B", res.body?.string())
        }
        assertTrue(serverBSeenAuthHeaders.all { it == "Bearer $tokenB" })

        val staleServerAReq = Request.Builder().url("$originA/api/spaces/sp-A/items/it-1/thumbnail").build()
        mediaRepo.mediaOkHttpClient.newCall(staleServerAReq).execute().use { res ->
            assertEquals(401, res.code)
        }
        assertEquals(listOf<String?>(null), serverAAuthHeadersAfterSwitch.toList())

        mediaRepo.cancelSessionObserver()
    }
}
