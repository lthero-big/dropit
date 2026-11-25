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
import dev.dropit.app.core.repository.PlaceholderAppUpdater
import dev.dropit.app.core.repository.PlaceholderItemShareRepository
import dev.dropit.app.core.repository.PlaceholderMediaRepository
import dev.dropit.app.core.repository.PlaceholderRoomRepository
import dev.dropit.app.core.repository.PlaceholderShareInbox
import dev.dropit.app.core.repository.PlaceholderTransferManager
import dev.dropit.app.core.repository.RoomRepository
import dev.dropit.app.core.repository.ShareInbox
import dev.dropit.app.core.repository.SpaceRepository
import dev.dropit.app.core.repository.TransferManager
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
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

    suspend fun initialize(): MigrationResult
    suspend fun resetForServerSwitch()
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

    // Default placeholders replaced in Stage 2A
    override val transferManager: TransferManager = PlaceholderTransferManager()
    override val shareInbox: ShareInbox = PlaceholderShareInbox()
    override val appUpdater: AppUpdater = PlaceholderAppUpdater()

    // Default placeholders replaced in Stage 3A
    override val roomRepository: RoomRepository = PlaceholderRoomRepository()
    override val itemShareRepository: ItemShareRepository = PlaceholderItemShareRepository()
    override val mediaRepository: MediaRepository = PlaceholderMediaRepository(
        context = appContext,
        okHttpClient = okHttpClient,
        serverOriginProvider = { settingsStore.getServerOrigin() },
    )

    override suspend fun initialize(): MigrationResult {
        val result = legacyMigrator.migrateIfNeeded()
        settingsStore.getOrCreateDeviceId()
        authRepository.refreshSessionState()
        return result
    }

    override suspend fun resetForServerSwitch() {
        realtimeClient.disconnect(clearState = true)
        roomRepository.clearRoomState()
        transferManager.clearAllForScopeSwitch()
        shareInbox.discardPendingShare()
        mediaRepository.clearCaches()
        authRepository.logout(clearServer = true)
    }
}
