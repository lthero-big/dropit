package dev.dropit.app.core.repository

import dev.dropit.app.core.network.ClipItem
import dev.dropit.app.core.network.DropitApiClient
import dev.dropit.app.core.network.GroupInfo
import dev.dropit.app.core.network.SessionCredentialsProvider
import dev.dropit.app.core.network.Space
import dev.dropit.app.core.network.TargetScope
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class BoardAndSpaceRepositoryTest {

    private lateinit var server: MockWebServer
    private lateinit var okHttpClient: OkHttpClient
    private lateinit var spaceRepository: DefaultSpaceRepository
    private lateinit var boardRepository: DefaultBoardRepository

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        val baseUrl = server.url("/").toString().trimEnd('/')
        okHttpClient = OkHttpClient.Builder().build()
        val apiClient = DropitApiClient(
            okHttpClient = okHttpClient,
            credentialsProvider = object : SessionCredentialsProvider {
                override suspend fun serverOrigin(): String = baseUrl
                override suspend fun accessToken(): String = "tok_repo_test_1234567890"
                override suspend fun deviceId(): String = "and-RepoDevice12345678"
                override fun deviceName(): String = "dropit Android · Test"
            },
            allowInsecureHttpForTest = true,
        )
        spaceRepository = DefaultSpaceRepository(apiClient)
        boardRepository = DefaultBoardRepository(apiClient)
    }

    @After
    fun tearDown() {
        server.shutdown()
        okHttpClient.dispatcher.executorService.shutdown()
        okHttpClient.connectionPool.evictAll()
    }

    @Test
    fun pickDefaultSpace_prefersPersonalPermanentSpace() {
        val invited = Space(id = "s-invited", name = "Shared", ownerId = "other", expiresAt = null, role = "viewer")
        val temp = Space(id = "s-temp", name = "Temp", ownerId = "me", expiresAt = 999999L, role = "owner")
        val personal = Space(id = "s-personal", name = "Personal", ownerId = "me", expiresAt = null, role = "owner")

        assertEquals(personal, spaceRepository.pickDefaultSpace(listOf(invited, temp, personal), "me"))
        assertEquals(invited, spaceRepository.pickDefaultSpace(listOf(invited), "me"))
        assertTrue(invited.isReadOnly)
        assertTrue(personal.canWrite)
    }

    @Test
    fun boardRepository_crudItemsAndGroupsInSpaceAndRoom() = runTest {
        val spaceScope = TargetScope.SpaceScope("sp-1")
        val roomScope = TargetScope.RoomScope("room-uuid.proof123")

        // Create text in room
        server.enqueue(
            MockResponse().setResponseCode(201).setBody(
                """{"item":{"id":"i-room","spaceId":"room-uuid","kind":"text","text":"hello room","size":10,"createdAt":1,"updatedAt":1,"expiresAt":2,"pinned":false,"hasThumbnail":false,"tags":[],"group":"工作"}}""",
            ),
        )
        val created = boardRepository.createText(roomScope, "hello room", group = "工作")
        assertEquals("i-room", created.id)
        val createReq = server.takeRequest()
        assertEquals("POST", createReq.method)
        assertEquals("/api/rooms/room-uuid.proof123/items/text", createReq.path)

        // Edit text + retract
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """{"item":{"id":"i-1","spaceId":"sp-1","kind":"text","text":"edited","size":6,"createdAt":1,"updatedAt":2,"expiresAt":3,"pinned":false,"hasThumbnail":false,"tags":[]}}""",
            ),
        )
        val edited = boardRepository.editText(spaceScope, "i-1", "edited")
        assertEquals("edited", edited.text)
        assertEquals("/api/spaces/sp-1/items/i-1", server.takeRequest().path)

        server.enqueue(MockResponse().setResponseCode(204))
        boardRepository.retractItem(spaceScope, "i-1")
        val delReq = server.takeRequest()
        assertEquals("DELETE", delReq.method)
        assertEquals("/api/spaces/sp-1/items/i-1", delReq.path)

        // Groups CRUD
        server.enqueue(MockResponse().setResponseCode(201).setBody("""{"groups":["工作"]}"""))
        assertEquals(listOf("工作"), boardRepository.createGroup(spaceScope, "工作"))
        server.takeRequest()

        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"groups":["项目"]}"""))
        assertEquals(listOf("项目"), boardRepository.renameGroup(spaceScope, "工作", "项目"))
        val renameReq = server.takeRequest()
        assertEquals("PATCH", renameReq.method)
        assertTrue(renameReq.path!!.startsWith("/api/spaces/sp-1/groups/"))

        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"groups":[]}"""))
        assertEquals(emptyList<String>(), boardRepository.deleteGroup(spaceScope, "项目"))
        server.takeRequest()

        val infos = boardRepository.buildGroupInfos(
            groups = listOf("项目", "待办"),
            items = listOf(
                ClipItem(id = "1", spaceId = "sp-1", kind = "text", group = "项目"),
                ClipItem(id = "2", spaceId = "sp-1", kind = "text", group = "项目"),
            ),
        )
        assertEquals(listOf(GroupInfo("项目", 2), GroupInfo("待办", 0)), infos)
    }
}
