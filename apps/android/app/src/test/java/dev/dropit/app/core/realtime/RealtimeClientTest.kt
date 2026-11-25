package dev.dropit.app.core.realtime

import dev.dropit.app.core.network.ClipItem
import dev.dropit.app.core.network.ItemDevice
import dev.dropit.app.core.network.SessionCredentialsProvider
import dev.dropit.app.core.network.TargetScope
import dev.dropit.app.core.network.WsEvent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger

class RealtimeClientTest {

    private lateinit var server: MockWebServer
    private lateinit var okHttpClient: OkHttpClient
    private lateinit var clientScope: CoroutineScope
    private lateinit var baseUrl: String

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        baseUrl = server.url("/").toString().trimEnd('/')
        okHttpClient = OkHttpClient.Builder().build()
        clientScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    }

    @After
    fun tearDown() {
        clientScope.cancel()
        server.shutdown()
        okHttpClient.dispatcher.executorService.shutdown()
        okHttpClient.connectionPool.evictAll()
    }

    @Test
    fun backoffPolicy_growsExponentiallyAndCapsAtMax() {
        val policy = BackoffPolicy(initialDelayMs = 1_000L, maxDelayMs = 10_000L, multiplier = 2.0)
        assertEquals(1_000L, policy.delayForAttempt(0))
        assertEquals(2_000L, policy.delayForAttempt(1))
        assertEquals(4_000L, policy.delayForAttempt(2))
        assertEquals(8_000L, policy.delayForAttempt(3))
        assertEquals(10_000L, policy.delayForAttempt(4))
        assertEquals(10_000L, policy.delayForAttempt(10))
    }

    @Test
    fun boardStateReducer_replacesAuthoritativelyOnSnapshotAndAppliesDeltas() {
        val oldItem = ClipItem(id = "old", spaceId = "sp-1", kind = "text", text = "stale", createdAt = 10)
        val initial = BoardSnapshotState(
            scope = TargetScope.SpaceScope("sp-1"),
            items = listOf(oldItem),
            groups = listOf("旧分组"),
            hasSnapshot = true,
        )

        val itemA = ClipItem(id = "a", spaceId = "sp-1", kind = "text", text = "A", createdAt = 100)
        val itemB = ClipItem(id = "b", spaceId = "sp-1", kind = "text", text = "B", createdAt = 50, pinned = true)

        // Snapshot must replace oldItem completely and sort pinned first
        val afterSnap = BoardStateReducer.reduce(
            initial,
            WsEvent.Snapshot(items = listOf(itemA, itemB), groups = listOf("工作"), serverTime = 200, expiresAt = null),
        )
        assertEquals(listOf("b", "a"), afterSnap.items.map { it.id })
        assertEquals(listOf("工作"), afterSnap.groups)

        // Incremental item.created
        val itemC = ClipItem(id = "c", spaceId = "sp-1", kind = "text", text = "C", createdAt = 150)
        val afterCreate = BoardStateReducer.reduce(afterSnap, WsEvent.ItemCreated(itemC))
        assertEquals(listOf("b", "c", "a"), afterCreate.items.map { it.id })

        // Incremental item.updated (pin itemA)
        val afterUpdate = BoardStateReducer.reduce(afterCreate, WsEvent.ItemUpdated(itemA.copy(pinned = true, text = "A2")))
        assertEquals(listOf("a", "b", "c"), afterUpdate.items.map { it.id })
        assertEquals("A2", afterUpdate.items.first().text)

        // Incremental item.deleted
        val afterDelete = BoardStateReducer.reduce(afterUpdate, WsEvent.ItemDeleted("b"))
        assertEquals(listOf("a", "c"), afterDelete.items.map { it.id })

        // Groups & presence
        val afterGroups = BoardStateReducer.reduce(afterDelete, WsEvent.GroupsUpdated(listOf("工作", "临时")))
        assertEquals(listOf("工作", "临时"), afterGroups.groups)

        val peer = ItemDevice(id = "and-123456", name = "Pixel", kind = "phone")
        val afterPresence = BoardStateReducer.reduce(afterGroups, WsEvent.Presence(devices = 2, peers = listOf(peer)))
        assertEquals(2, afterPresence.presenceDevices)
        assertEquals(listOf(peer), afterPresence.peers)
    }

    @Test
    fun realtimeClient_connectsReplacesSnapshotOnReconnectAndUsesExponentialBackoff() = runBlocking {
        val observedDelays = CopyOnWriteArrayList<Long>()
        val creds = object : SessionCredentialsProvider {
            override suspend fun serverOrigin(): String = baseUrl
            override suspend fun accessToken(): String = "tok_ws_secret_1234567890"
            override suspend fun deviceId(): String = "and-WsDevice1234567890"
            override fun deviceName(): String = "dropit Android · Pixel"
        }

        // Connection 1: send snapshot with item1, then drop connection
        server.enqueue(
            MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    webSocket.send("""{"type":"snapshot","items":[{"id":"i1","spaceId":"sp-1","kind":"text","text":"first","createdAt":10,"updatedAt":10,"expiresAt":999,"pinned":false,"hasThumbnail":false,"tags":[]}],"groups":["G1"],"serverTime":10,"expiresAt":null}""")
                    webSocket.send("""{"type":"item.created","item":{"id":"i2","spaceId":"sp-1","kind":"text","text":"second","createdAt":20,"updatedAt":20,"expiresAt":999,"pinned":false,"hasThumbnail":false,"tags":[]}}""")
                    webSocket.close(1001, "Server restart")
                }
            }),
        )
        // Connection 2: transient 503 failure -> triggers backoff attempt 1
        server.enqueue(MockResponse().setResponseCode(503))
        // Connection 3: reconnect succeeds and sends authoritative replacement snapshot (only i3, i1/i2 removed!)
        server.enqueue(
            MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    webSocket.send("""{"type":"snapshot","items":[{"id":"i3","spaceId":"sp-1","kind":"text","text":"fresh","createdAt":30,"updatedAt":30,"expiresAt":999,"pinned":false,"hasThumbnail":false,"tags":[]}],"groups":["G2"],"serverTime":30,"expiresAt":null}""")
                }
            }),
        )

        val client = RealtimeClient(
            okHttpClient = okHttpClient,
            credentialsProvider = creds,
            backoffPolicy = BackoffPolicy(initialDelayMs = 1_000L, maxDelayMs = 30_000L, multiplier = 2.0),
            scope = clientScope,
            allowInsecureHttpForTest = true,
            delayFn = { ms -> observedDelays.add(ms) },
        )

        client.connect(TargetScope.SpaceScope("sp-1"))

        val finalBoard = withTimeout(5_000) {
            client.boardState.first { state -> state.items.map { it.id } == listOf("i3") }
        }
        assertEquals(listOf("G2"), finalBoard.groups)
        assertEquals(ConnectionState.CONNECTED, client.connectionState.value)

        // Verify exponential backoff delays: 1000ms after first drop, then 2000ms after 503
        assertEquals(listOf(1_000L, 2_000L), observedDelays.toList())

        val req1 = server.takeRequest()
        assertEquals("Bearer tok_ws_secret_1234567890", req1.getHeader("Authorization"))
        assertTrue(req1.path!!.startsWith("/api/spaces/sp-1/ws?"))
        assertTrue(req1.path!!.contains("device=and-WsDevice1234567890"))
        assertTrue(req1.path!!.contains("kind=phone"))

        client.disconnect(clearState = true)
        assertEquals(ConnectionState.DISCONNECTED, client.connectionState.value)
    }

    @Test
    fun realtimeClient_stopsReconnectingOn401AndNotifiesUnauthorized() = runBlocking {
        val unauthorizedCalls = AtomicInteger(0)
        val creds = object : SessionCredentialsProvider {
            override suspend fun serverOrigin(): String = baseUrl
            override suspend fun accessToken(): String = "tok_revoked"
            override suspend fun deviceId(): String = "and-WsDevice1234567890"
            override fun deviceName(): String = "dropit Android · Pixel"
        }

        server.enqueue(MockResponse().setResponseCode(401).setBody("""{"error":{"code":"UNAUTHENTICATED"}}"""))

        val client = RealtimeClient(
            okHttpClient = okHttpClient,
            credentialsProvider = creds,
            scope = clientScope,
            onUnauthorized = { _, _ -> unauthorizedCalls.incrementAndGet() },
            allowInsecureHttpForTest = true,
            delayFn = {},
        )

        client.connect(TargetScope.SpaceScope("sp-1"))
        val state = withTimeout(5_000) {
            client.connectionState.first { it == ConnectionState.UNAUTHORIZED }
        }
        assertEquals(ConnectionState.UNAUTHORIZED, state)
        assertEquals(1, unauthorizedCalls.get())
        client.disconnect()
    }
}
