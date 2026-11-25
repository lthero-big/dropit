package dev.dropit.app.core.realtime

import dev.dropit.app.core.network.ClipItem
import dev.dropit.app.core.network.DropitApiClient
import dev.dropit.app.core.network.ItemDevice
import dev.dropit.app.core.network.ServerUrl
import dev.dropit.app.core.network.SessionCredentialsProvider
import dev.dropit.app.core.network.TargetScope
import dev.dropit.app.core.network.WsEvent
import dev.dropit.app.core.network.WsEventParser
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.atomic.AtomicLong
import kotlin.math.min
import kotlin.math.pow

enum class ConnectionState {
    DISCONNECTED,
    CONNECTING,
    CONNECTED,
    RECONNECTING,
    UNAUTHORIZED,
}

data class BackoffPolicy(
    val initialDelayMs: Long = 1_000L,
    val maxDelayMs: Long = 30_000L,
    val multiplier: Double = 2.0,
) {
    fun delayForAttempt(attempt: Int): Long {
        if (attempt <= 0) return initialDelayMs
        val scaled = initialDelayMs * multiplier.pow(attempt.toDouble())
        return min(maxDelayMs.toDouble(), scaled).toLong().coerceAtLeast(initialDelayMs)
    }
}

data class BoardSnapshotState(
    val scope: TargetScope? = null,
    val items: List<ClipItem> = emptyList(),
    val groups: List<String> = emptyList(),
    val presenceDevices: Int = 0,
    val peers: List<ItemDevice> = emptyList(),
    val serverTime: Long? = null,
    val expiresAt: Long? = null,
    val hasSnapshot: Boolean = false,
)

object BoardStateReducer {
    private val itemComparator = compareByDescending<ClipItem> { it.pinned }
        .thenByDescending { it.createdAt }
        .thenBy { it.id }

    fun reduce(current: BoardSnapshotState, event: WsEvent): BoardSnapshotState = when (event) {
        is WsEvent.Snapshot -> current.copy(
            items = event.items.sortedWith(itemComparator),
            groups = event.groups,
            serverTime = event.serverTime,
            expiresAt = event.expiresAt,
            hasSnapshot = true,
        )
        is WsEvent.ItemCreated -> {
            val nextItems = (current.items.filterNot { it.id == event.item.id } + event.item)
                .sortedWith(itemComparator)
            current.copy(items = nextItems)
        }
        is WsEvent.ItemUpdated -> {
            val nextItems = (current.items.filterNot { it.id == event.item.id } + event.item)
                .sortedWith(itemComparator)
            current.copy(items = nextItems)
        }
        is WsEvent.ItemDeleted -> current.copy(
            items = current.items.filterNot { it.id == event.id },
        )
        is WsEvent.GroupsUpdated -> current.copy(groups = event.groups)
        is WsEvent.Presence -> current.copy(
            presenceDevices = event.devices,
            peers = event.peers,
        )
        is WsEvent.Unknown -> current
    }
}

/**
 * WebSocket realtime synchronization engine for `/api/spaces/:space/ws` and `/api/rooms/:room/ws`.
 *
 * - Authenticates via `Authorization: Bearer <token>` and attaches device identity query params.
 * - Replaces local board state authoritatively on every `snapshot` frame (including reconnects),
 *   then consumes incremental events (`item.created`, `item.updated`, `item.deleted`, `groups`, `presence`).
 * - Reconnects with exponential backoff, supports foreground/background transitions and manual reconnect.
 * - Stops reconnecting on HTTP 401 or WS close code 1008 (authorization expired) and notifies caller.
 */
class RealtimeClient(
    private val okHttpClient: OkHttpClient,
    private val credentialsProvider: SessionCredentialsProvider,
    private val json: Json = DropitApiClient.defaultJson(),
    private val backoffPolicy: BackoffPolicy = BackoffPolicy(),
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
    private val onUnauthorized: (serverOrigin: String, path: String) -> Unit = { _, _ -> },
    private val allowInsecureHttpForTest: Boolean = false,
    private val delayFn: suspend (Long) -> Unit = { delay(it) },
) {
    private val _connectionState = MutableStateFlow(ConnectionState.DISCONNECTED)
    val connectionState: StateFlow<ConnectionState> = _connectionState.asStateFlow()

    private val _boardState = MutableStateFlow(BoardSnapshotState())
    val boardState: StateFlow<BoardSnapshotState> = _boardState.asStateFlow()

    private val _events = MutableSharedFlow<WsEvent>(extraBufferCapacity = 64)
    val events: SharedFlow<WsEvent> = _events.asSharedFlow()

    private val lock = Any()
    private val generationCounter = AtomicLong(0L)
    private var activeScope: TargetScope? = null
    private var currentSocket: WebSocket? = null
    private var reconnectJob: Job? = null
    private var connectJob: Job? = null
    private var reconnectAttempt: Int = 0
    private var inBackground: Boolean = false

    fun connect(targetScope: TargetScope) {
        val gen: Long
        synchronized(lock) {
            val scopeChanged = activeScope != targetScope
            activeScope = targetScope
            inBackground = false
            reconnectAttempt = 0
            gen = generationCounter.incrementAndGet()
            cancelSocketsLocked()
            if (scopeChanged) {
                _boardState.value = BoardSnapshotState(scope = targetScope)
            }
            _connectionState.value = ConnectionState.CONNECTING
        }
        launchConnect(targetScope, gen)
    }

    fun disconnect(clearState: Boolean = false) {
        synchronized(lock) {
            generationCounter.incrementAndGet()
            activeScope = null
            reconnectAttempt = 0
            inBackground = false
            cancelSocketsLocked()
            _connectionState.value = ConnectionState.DISCONNECTED
            if (clearState) {
                _boardState.value = BoardSnapshotState()
            }
        }
    }

    fun reconnectNow() {
        val target: TargetScope
        val gen: Long
        synchronized(lock) {
            target = activeScope ?: return
            inBackground = false
            reconnectAttempt = 0
            gen = generationCounter.incrementAndGet()
            cancelSocketsLocked()
            _connectionState.value = ConnectionState.CONNECTING
        }
        launchConnect(target, gen)
    }

    fun onAppBackground() {
        synchronized(lock) {
            if (activeScope == null) return
            inBackground = true
            generationCounter.incrementAndGet()
            cancelSocketsLocked()
            _connectionState.value = ConnectionState.DISCONNECTED
        }
    }

    fun onAppForeground() {
        val target: TargetScope
        val gen: Long
        synchronized(lock) {
            inBackground = false
            target = activeScope ?: return
            if (_connectionState.value == ConnectionState.CONNECTED || _connectionState.value == ConnectionState.CONNECTING) {
                return
            }
            reconnectAttempt = 0
            gen = generationCounter.incrementAndGet()
            cancelSocketsLocked()
            _connectionState.value = ConnectionState.CONNECTING
        }
        launchConnect(target, gen)
    }

    fun applyLocalSnapshot(targetScope: TargetScope, snapshot: WsEvent.Snapshot) {
        _boardState.update { current ->
            val base = if (current.scope == targetScope) current else BoardSnapshotState(scope = targetScope)
            BoardStateReducer.reduce(base, snapshot)
        }
    }

    private fun cancelSocketsLocked() {
        connectJob?.cancel()
        connectJob = null
        reconnectJob?.cancel()
        reconnectJob = null
        currentSocket?.close(1000, "Client closing")
        currentSocket = null
    }

    private fun launchConnect(targetScope: TargetScope, expectedGen: Long) {
        val job = scope.launch {
            val origin = credentialsProvider.serverOrigin()
            if (origin.isNullOrBlank()) {
                synchronized(lock) {
                    if (generationCounter.get() == expectedGen) {
                        _connectionState.value = ConnectionState.DISCONNECTED
                    }
                }
                return@launch
            }
            val token = credentialsProvider.accessToken()
            if (targetScope is TargetScope.SpaceScope && token.isNullOrBlank()) {
                synchronized(lock) {
                    if (generationCounter.get() == expectedGen) {
                        _connectionState.value = ConnectionState.UNAUTHORIZED
                    }
                }
                return@launch
            }

            val deviceId = credentialsProvider.deviceId()
            val deviceName = credentialsProvider.deviceName()
            val wsUrl = buildWebSocketUrl(origin, targetScope, deviceId, deviceName)
            val requestBuilder = Request.Builder().url(wsUrl)
            if (!token.isNullOrBlank()) {
                requestBuilder.header("Authorization", "Bearer $token")
            }

            val request = requestBuilder.build()
            val listener = createListener(expectedGen, targetScope, origin)
            synchronized(lock) {
                if (generationCounter.get() != expectedGen) return@launch
                currentSocket = okHttpClient.newWebSocket(request, listener)
            }
        }
        synchronized(lock) {
            if (generationCounter.get() == expectedGen) {
                connectJob = job
            } else {
                job.cancel()
            }
        }
    }

    internal fun buildWebSocketUrl(
        serverOrigin: String,
        targetScope: TargetScope,
        deviceId: String,
        deviceName: String,
    ): String {
        val cleanOrigin = if (allowInsecureHttpForTest && serverOrigin.startsWith("http://")) {
            serverOrigin.trimEnd('/')
        } else {
            ServerUrl.normalizeServerUrl(serverOrigin)
        }
        val wsOrigin = when {
            cleanOrigin.startsWith("https://") -> "wss://" + cleanOrigin.removePrefix("https://")
            cleanOrigin.startsWith("http://") -> "ws://" + cleanOrigin.removePrefix("http://")
            else -> cleanOrigin
        }
        val params = buildList {
            if (ServerUrl.isValidDeviceId(deviceId)) {
                add("device=${ServerUrl.encodeURIComponent(deviceId)}")
            }
            if (deviceName.isNotBlank()) {
                add("name=${ServerUrl.encodeURIComponent(ServerUrl.truncateCodePoints(deviceName, 40))}")
            }
            add("kind=phone")
        }.joinToString("&")
        return "$wsOrigin${targetScope.apiBasePath}/ws?$params"
    }

    private fun createListener(
        expectedGen: Long,
        targetScope: TargetScope,
        origin: String,
    ): WebSocketListener = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            synchronized(lock) {
                if (generationCounter.get() != expectedGen) {
                    webSocket.close(1000, "Stale socket")
                    return
                }
                reconnectAttempt = 0
                _connectionState.value = ConnectionState.CONNECTED
            }
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            if (generationCounter.get() != expectedGen) return
            val event = WsEventParser.parse(text, json)
            _boardState.update { current ->
                val base = if (current.scope == targetScope) current else BoardSnapshotState(scope = targetScope)
                BoardStateReducer.reduce(base, event)
            }
            _events.tryEmit(event)
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(code, reason)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            handleDisconnect(expectedGen, targetScope, origin, closeCode = code, httpStatus = null)
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            handleDisconnect(expectedGen, targetScope, origin, closeCode = null, httpStatus = response?.code)
        }
    }

    private fun handleDisconnect(
        expectedGen: Long,
        targetScope: TargetScope,
        origin: String,
        closeCode: Int?,
        httpStatus: Int?,
    ) {
        val isAuthFailure = httpStatus == 401 || closeCode == 1008
        if (isAuthFailure) {
            val shouldNotify: Boolean
            synchronized(lock) {
                if (generationCounter.get() != expectedGen) return
                currentSocket = null
                reconnectJob?.cancel()
                reconnectJob = null
                _connectionState.value = ConnectionState.UNAUTHORIZED
                shouldNotify = targetScope is TargetScope.SpaceScope
            }
            if (shouldNotify) {
                onUnauthorized(origin, "${targetScope.apiBasePath}/ws")
            }
            return
        }

        val delayMs: Long
        synchronized(lock) {
            if (generationCounter.get() != expectedGen || inBackground || activeScope != targetScope) return
            currentSocket = null
            delayMs = backoffPolicy.delayForAttempt(reconnectAttempt)
            reconnectAttempt += 1
            _connectionState.value = ConnectionState.RECONNECTING
            reconnectJob?.cancel()
            reconnectJob = scope.launch {
                delayFn(delayMs)
                val shouldRetry = synchronized(lock) {
                    generationCounter.get() == expectedGen && !inBackground && activeScope == targetScope
                }
                if (shouldRetry) {
                    launchConnect(targetScope, expectedGen)
                }
            }
        }
    }
}
