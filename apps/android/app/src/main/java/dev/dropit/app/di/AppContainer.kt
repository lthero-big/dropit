package dev.dropit.app.di

import android.content.Context
import android.os.Build
import dev.dropit.app.core.auth.AndroidKeystoreTokenVault
import dev.dropit.app.core.auth.AndroidLegacyPrefsReader
import dev.dropit.app.core.auth.AuthRepository
import dev.dropit.app.core.auth.DataStoreSettingsStore
import dev.dropit.app.core.auth.DefaultAuthRepository
import dev.dropit.app.core.auth.LegacyCapacitorMigrator
import dev.dropit.app.core.auth.MigrationResult
import dev.dropit.app.core.auth.OAuthCallbackBus
import dev.dropit.app.core.auth.SettingsStore
import dev.dropit.app.core.auth.TokenVault
import dev.dropit.app.core.network.DropitApiClient
import dev.dropit.app.core.network.ServerUrl
import dev.dropit.app.core.network.SessionCredentialsProvider
import dev.dropit.app.core.realtime.RealtimeClient
import dev.dropit.app.core.repository.AppUpdater
import dev.dropit.app.core.repository.BoardRepository
import dev.dropit.app.core.repository.DefaultBoardRepository
import dev.dropit.app.core.repository.DefaultSpaceRepository
import dev.dropit.app.core.repository.ItemShareRepository
import dev.dropit.app.core.repository.MediaRepository
import dev.dropit.app.core.repository.RoomRepository
import dev.dropit.app.core.repository.ShareInbox
import dev.dropit.app.core.repository.SpaceRepository
import dev.dropit.app.core.repository.TransferManager
import dev.dropit.app.data.account.AccountSettingsRepository
import dev.dropit.app.data.account.DefaultAccountSettingsRepository
import dev.dropit.app.data.itemshare.DefaultItemShareRepository
import dev.dropit.app.data.media.DefaultMediaRepository
import dev.dropit.app.data.room.AndroidKeystoreRoomKeyStore
import dev.dropit.app.data.room.DefaultRoomRepository
import dev.dropit.app.data.room.RoomKeyStore
import dev.dropit.app.data.share.AndroidShareIntentExtractor
import dev.dropit.app.data.share.DefaultShareInbox
import dev.dropit.app.data.transfer.AndroidDownloadSink
import dev.dropit.app.data.transfer.AndroidTransferWorkScheduler
import dev.dropit.app.data.transfer.AndroidUploadUriStager
import dev.dropit.app.data.transfer.DefaultTransferManager
import dev.dropit.app.data.transfer.DefaultTransferScopeProvider
import dev.dropit.app.data.transfer.TransferDatabase
import dev.dropit.app.data.transfer.TransferEngine
import dev.dropit.app.data.update.AndroidApkInstaller
import dev.dropit.app.data.update.DefaultAppUpdater
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * Unified dependency container consumed by UI (Stage 2B/3B) and wired with concrete engines
 * by Stage 2A (`TransferManager`, `ShareInbox`, `AppUpdater`) and Stage 3A (`RoomRepository`,
 * `ItemShareRepository`, `MediaRepository`).
 */
interface AppContainer {
    val okHttpClient: OkHttpClient
    val json: Json
    val settingsStore: SettingsStore
    val tokenVault: TokenVault
    val legacyMigrator: LegacyCapacitorMigrator
    val apiClient: DropitApiClient
    val authRepository: AuthRepository
    val realtimeClient: RealtimeClient
    val spaceRepository: SpaceRepository
    val boardRepository: BoardRepository

    // Stage 2A engines
    val transferManager: TransferManager
    val shareInbox: ShareInbox
    val appUpdater: AppUpdater

    // Stage 3A data repositories
    val roomRepository: RoomRepository
    val itemShareRepository: ItemShareRepository
    val mediaRepository: MediaRepository

    // Stage 7 OAuth deep-link callback bus & full account/admin settings repository
    val oauthCallbackBus: OAuthCallbackBus
        get() = FALLBACK_OAUTH_CALLBACK_BUS
    val accountSettingsRepository: AccountSettingsRepository
        get() = DefaultAccountSettingsRepository(apiClient = apiClient, authRepository = authRepository)

    suspend fun initialize(): MigrationResult
    suspend fun resetForServerSwitch()

    companion object {
        private val FALLBACK_OAUTH_CALLBACK_BUS = OAuthCallbackBus()
    }
}

class DefaultAppContainer(context: Context) : AppContainer {
    private val appContext = context.applicationContext

    override val json: Json = DropitApiClient.defaultJson()

    override val okHttpClient: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(60, TimeUnit.SECONDS)
        .pingInterval(25, TimeUnit.SECONDS)
        .build()

    override val settingsStore: SettingsStore = DataStoreSettingsStore(appContext)

    override val tokenVault: TokenVault = AndroidKeystoreTokenVault(appContext)

    override val legacyMigrator: LegacyCapacitorMigrator = LegacyCapacitorMigrator(
        legacyPrefs = AndroidLegacyPrefsReader(appContext),
        settingsStore = settingsStore,
        tokenVault = tokenVault,
    )

    private val deviceNameProvider: () -> String = {
        ServerUrl.deviceName(Build.MODEL)
    }

    private val credentialsProvider = object : SessionCredentialsProvider {
        override suspend fun serverOrigin(): String? = settingsStore.getServerOrigin()
        override suspend fun accessToken(): String? = tokenVault.getToken()
        override suspend fun deviceId(): String = settingsStore.getOrCreateDeviceId()
        override fun deviceName(): String = deviceNameProvider()
    }

    override val apiClient: DropitApiClient = DropitApiClient(
        okHttpClient = okHttpClient,
        json = json,
        credentialsProvider = credentialsProvider,
    )

    override val authRepository: AuthRepository = DefaultAuthRepository(
        apiClient = apiClient,
        settingsStore = settingsStore,
        tokenVault = tokenVault,
        deviceNameProvider = deviceNameProvider,
        json = json,
    )

    override val realtimeClient: RealtimeClient = RealtimeClient(
        okHttpClient = okHttpClient,
        credentialsProvider = credentialsProvider,
        json = json,
        onUnauthorized = { origin, path ->
            apiClient.emitSessionExpiredIf401(401, origin, path)
        },
    )

    override val spaceRepository: SpaceRepository = DefaultSpaceRepository(apiClient)

    override val boardRepository: BoardRepository = DefaultBoardRepository(apiClient)

    // Stage 2A concrete engines: Room + WorkManager transfer queue, persistent share staging, self-hosted APK updater
    private val transferDatabase: TransferDatabase by lazy { TransferDatabase.create(appContext) }
    private val uploadStagingDir: File = File(appContext.filesDir, "transfer_staging")
    private val shareStagingDir: File = File(appContext.filesDir, DefaultShareInbox.STAGING_DIR_NAME)
    private val downloadTempDir: File = File(appContext.cacheDir, "download_parts")

    private val transferScopeProvider: DefaultTransferScopeProvider by lazy {
        DefaultTransferScopeProvider(
            settingsStore = settingsStore,
            tokenVault = tokenVault,
            authRepository = authRepository,
            apiClient = apiClient,
            dao = transferDatabase.transferDao(),
        )
    }

    private val transferEngine: TransferEngine by lazy {
        TransferEngine(
            apiClient = apiClient,
            dao = transferDatabase.transferDao(),
            downloadSink = AndroidDownloadSink(appContext),
            downloadTempDir = downloadTempDir,
            ownedStagingRoots = listOf(uploadStagingDir, shareStagingDir, downloadTempDir),
        )
    }

    private val defaultTransferManager: DefaultTransferManager by lazy {
        DefaultTransferManager(
            dao = transferDatabase.transferDao(),
            engine = transferEngine,
            scheduler = AndroidTransferWorkScheduler(appContext),
            scopeProvider = transferScopeProvider,
            uploadUriStager = AndroidUploadUriStager(appContext),
            uploadStagingDir = uploadStagingDir,
            downloadTempDir = downloadTempDir,
        )
    }

    private val defaultShareInbox: DefaultShareInbox by lazy {
        DefaultShareInbox(
            stagingRootDir = shareStagingDir,
            extractor = AndroidShareIntentExtractor(appContext),
            json = json,
        )
    }

    private val defaultAppUpdater: DefaultAppUpdater by lazy {
        DefaultAppUpdater(
            apiClient = apiClient,
            settingsStore = settingsStore,
            cacheDir = appContext.cacheDir,
            installer = AndroidApkInstaller(appContext),
        )
    }

    override val transferManager: TransferManager get() = defaultTransferManager
    override val shareInbox: ShareInbox get() = defaultShareInbox
    override val appUpdater: AppUpdater get() = defaultAppUpdater

    // Stage 3A concrete repositories: temporary rooms, per-item share links, authenticated media/preview
    private val roomKeyStore: RoomKeyStore by lazy {
        AndroidKeystoreRoomKeyStore(
            context = appContext,
            json = json,
        )
    }

    private val imageCacheDir: File = File(appContext.cacheDir, DefaultMediaRepository.IMAGE_CACHE_DIR_NAME)

    private val defaultRoomRepository: DefaultRoomRepository by lazy {
        DefaultRoomRepository(
            apiClient = apiClient,
            roomKeyStore = roomKeyStore,
            settingsStore = settingsStore,
        )
    }

    private val defaultItemShareRepository: DefaultItemShareRepository by lazy {
        DefaultItemShareRepository(apiClient = apiClient)
    }

    private val defaultMediaRepository: DefaultMediaRepository by lazy {
        DefaultMediaRepository(
            context = appContext,
            baseOkHttpClient = okHttpClient,
            apiClient = apiClient,
            credentialsProvider = credentialsProvider,
            imageCacheDir = imageCacheDir,
            sessionStateFlow = authRepository.sessionState,
        )
    }

    override val roomRepository: RoomRepository get() = defaultRoomRepository
    override val itemShareRepository: ItemShareRepository get() = defaultItemShareRepository
    override val mediaRepository: MediaRepository get() = defaultMediaRepository

    override val oauthCallbackBus: OAuthCallbackBus = OAuthCallbackBus()

    private val defaultAccountSettingsRepository: DefaultAccountSettingsRepository by lazy {
        DefaultAccountSettingsRepository(
            apiClient = apiClient,
            authRepository = authRepository,
        )
    }

    override val accountSettingsRepository: AccountSettingsRepository get() = defaultAccountSettingsRepository

    override suspend fun initialize(): MigrationResult {
        val result = legacyMigrator.migrateIfNeeded()
        settingsStore.getOrCreateDeviceId()
        authRepository.refreshSessionState()
        defaultTransferManager.recoverInterruptedTasks()
        return result
    }

    override suspend fun resetForServerSwitch() {
        oauthCallbackBus.clearPendingCallback()
        performServerSwitchReset(
            realtimeClient = realtimeClient,
            roomRepository = roomRepository,
            transferManager = transferManager,
            shareInbox = shareInbox,
            resetAppUpdater = {
                defaultAppUpdater.resetInstallState()
                defaultAppUpdater.clearCachedUpdates()
            },
            mediaRepository = mediaRepository,
            authRepository = authRepository,
        )
    }
}

/**
 * Atomic cleanup sequence executed when switching servers.
 * Order matters: best-effort remote upload cancellations and `/api/auth/logout` happen
 * before clearing local credentials, while room keys, transfer DB/staging, pending shares,
 * cached updates, and media caches are all wiped before returning.
 */
internal suspend fun performServerSwitchReset(
    realtimeClient: RealtimeClient,
    roomRepository: RoomRepository,
    transferManager: TransferManager,
    shareInbox: ShareInbox,
    resetAppUpdater: suspend () -> Unit,
    mediaRepository: MediaRepository,
    authRepository: AuthRepository,
) {
    realtimeClient.disconnect(clearState = true)
    roomRepository.clearRoomState()
    transferManager.clearAllForScopeSwitch()
    shareInbox.discardPendingShare()
    resetAppUpdater()
    mediaRepository.clearCaches()
    authRepository.logout(clearServer = true)
}
