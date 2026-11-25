package dev.dropit.app.data.account

import dev.dropit.app.core.auth.AccountCapabilityState
import dev.dropit.app.core.auth.DefaultAuthRepository
import dev.dropit.app.core.auth.InMemorySettingsStore
import dev.dropit.app.core.auth.InMemoryTokenVault
import dev.dropit.app.core.network.ApiError
import dev.dropit.app.core.network.ApiErrorCode
import dev.dropit.app.core.network.DropitApiClient
import dev.dropit.app.core.network.OptionalField
import dev.dropit.app.core.network.SessionCredentialsProvider
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

class DefaultAccountSettingsRepositoryTest {

    private lateinit var server: MockWebServer
    private lateinit var okHttpClient: OkHttpClient
    private lateinit var settingsStore: InMemorySettingsStore
    private lateinit var tokenVault: InMemoryTokenVault
    private lateinit var apiClient: DropitApiClient
    private lateinit var authRepository: DefaultAuthRepository
    private lateinit var repository: DefaultAccountSettingsRepository
    private lateinit var baseUrl: String

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        baseUrl = server.url("/").toString().trimEnd('/')
        okHttpClient = OkHttpClient.Builder().build()
        settingsStore = InMemorySettingsStore()
        tokenVault = InMemoryTokenVault()

        val creds = object : SessionCredentialsProvider {
            override suspend fun serverOrigin(): String? = settingsStore.getServerOrigin()
            override suspend fun accessToken(): String? = tokenVault.getToken()
            override suspend fun deviceId(): String = settingsStore.getOrCreateDeviceId()
            override fun deviceName(): String = "dropit Android · Test"
        }
        apiClient = DropitApiClient(
            okHttpClient = okHttpClient,
            credentialsProvider = creds,
            allowInsecureHttpForTest = true,
        )
        authRepository = DefaultAuthRepository(
            apiClient = apiClient,
            settingsStore = settingsStore,
            tokenVault = tokenVault,
            deviceNameProvider = { "dropit Android · Test" },
        )
        repository = DefaultAccountSettingsRepository(
            apiClient = apiClient,
            authRepository = authRepository,
        )
    }

    @After
    fun tearDown() {
        server.shutdown()
        okHttpClient.dispatcher.executorService.shutdown()
        okHttpClient.connectionPool.evictAll()
    }

    private suspend fun signInAdminToken() {
        authRepository.completeAuthorizationWithMetadata(
            serverOrigin = baseUrl,
            token = "tok_admin_123456789012345678901234567890123",
            scopes = setOf("read", "write", "account", "admin"),
            mustChangePassword = false,
        )
    }

    @Test
    fun sharePresets_readsAndSavesPcCustomOptions() = runTest {
        signInAdminToken()
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"hours":[6],"days":[2,14],"months":[1],"views":[3,20]}"""))
        val loaded = repository.getSharePresets()
        assertEquals(listOf(6), loaded.hours)
        assertEquals(listOf(2, 14), loaded.days)
        assertEquals(listOf(1), loaded.months)
        assertEquals(listOf(3, 20), loaded.views)
        assertEquals("/api/me/share-presets", server.takeRequest().path)

        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"hours":[],"days":[2,7],"months":[],"views":[5]}"""))
        val saved = repository.saveSharePresets(days = listOf(2, 7), views = listOf(5))
        assertEquals(listOf(2, 7), saved.days)
        assertEquals(listOf(5), saved.views)
        val putReq = server.takeRequest()
        assertEquals("PUT", putReq.method)
        assertEquals("/api/me/share-presets", putReq.path)
        val body = Json.parseToJsonElement(putReq.body.readUtf8()) as JsonObject
        assertEquals(listOf(2, 7), body["days"]!!.jsonArray.map { it.jsonPrimitive.int })
        assertEquals(listOf(5), body["views"]!!.jsonArray.map { it.jsonPrimitive.int })
    }

    @Test
    fun managedShares_listsPaginatesResolvesLinkRevokesAndDeletes() = runTest {
        signInAdminToken()
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """
                {
                  "shares": [{
                    "id":"sh-1","itemId":"it-1","expiresAt":1700000000000,"maxViews":5,"views":1,"revoked":0,
                    "createdAt":1699000000000,"state":"active","copyStatus":"available",
                    "sourceKind":"file","sourceName":"report.pdf","spaceName":"Private space"
                  }],
                  "nextCursor":"1699000000000:sh-1"
                }
                """.trimIndent(),
            ),
        )
        val page = repository.listManagedShares(cursor = "1699999999000:sh-0")
        assertEquals(1, page.shares.size)
        assertEquals("report.pdf", page.shares.first().sourceName)
        assertEquals("1699000000000:sh-1", page.nextCursor)
        assertEquals("/api/shares?cursor=1699999999000%3Ash-0", server.takeRequest().path)

        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"url":"/s/Ab12Cd","directUrl":"/d/Ab12Cd"}"""))
        val link = repository.getManagedShareLink("sh-1")
        assertEquals("$baseUrl/s/Ab12Cd", link.url)
        assertEquals("$baseUrl/d/Ab12Cd", link.directUrl)
        assertEquals("/api/shares/sh-1/link", server.takeRequest().path)

        server.enqueue(MockResponse().setResponseCode(204))
        repository.revokeManagedShare("sh-1")
        val revokeReq = server.takeRequest()
        assertEquals("POST", revokeReq.method)
        assertEquals("/api/shares/sh-1/revoke", revokeReq.path)

        server.enqueue(MockResponse().setResponseCode(204))
        repository.deleteManagedShare("sh-1")
        val delReq = server.takeRequest()
        assertEquals("DELETE", delReq.method)
        assertEquals("/api/shares/sh-1", delReq.path)
    }

    @Test
    fun spaceMembersAndInvites_coversAllCrudAndPersonalInvites() = runTest {
        signInAdminToken()

        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"members":[{"userId":"u1","email":"a@b.c","name":"A","role":"owner"}]}"""))
        assertEquals(1, repository.listSpaceMembers("sp-1").size)
        assertEquals("/api/spaces/sp-1/members", server.takeRequest().path)

        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"members":[{"userId":"u2","email":"b@b.c","name":"B","role":"editor"}]}"""))
        val updated = repository.updateSpaceMemberRole("sp-1", "u2", "editor")
        assertEquals("editor", updated.first().role)
        val patchReq = server.takeRequest()
        assertEquals("PATCH", patchReq.method)
        assertEquals("/api/spaces/sp-1/members/u2", patchReq.path)

        server.enqueue(MockResponse().setResponseCode(204))
        repository.removeSpaceMember("sp-1", "u2")
        assertEquals("/api/spaces/sp-1/members/u2", server.takeRequest().path)

        server.enqueue(MockResponse().setResponseCode(204))
        repository.leaveSpace("sp-2")
        val leaveReq = server.takeRequest()
        assertEquals("DELETE", leaveReq.method)
        assertEquals("/api/spaces/sp-2/membership", leaveReq.path)

        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"enabled":true,"limit":5,"active":1,"remaining":4,"invites":[{"id":"inv-1","maxUses":1,"uses":0,"expiresAt":1700000000000,"revoked":0,"role":"viewer","status":"open"}]}"""))
        val spaceInvites = repository.listSpaceInvites("sp-1")
        assertEquals(4, spaceInvites.remaining)
        assertEquals("/api/spaces/sp-1/invites", server.takeRequest().path)

        server.enqueue(MockResponse().setResponseCode(201).setBody("""{"id":"inv-2","maxUses":2,"uses":0,"expiresAt":1700000000000,"revoked":0,"role":"editor","status":"active","token":"tok123","url":"/invite/tok123"}"""))
        val createdSpaceInvite = repository.createSpaceInvite("sp-1", role = "editor", maxUses = 2, expiresInHours = 48)
        assertEquals("$baseUrl/invite/tok123", createdSpaceInvite.url)
        val createSpaceInvReq = server.takeRequest()
        assertEquals("POST", createSpaceInvReq.method)
        assertEquals("/api/spaces/sp-1/invites", createSpaceInvReq.path)

        server.enqueue(MockResponse().setResponseCode(204))
        repository.revokeSpaceInvite("sp-1", "inv-2")
        assertEquals("/api/spaces/sp-1/invites/inv-2", server.takeRequest().path)

        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"enabled":true,"adminOnly":true,"limit":null,"registration":"invite","invites":[]}"""))
        assertEquals("invite", repository.listPersonalInvites().registration)
        assertEquals("/api/me/invites", server.takeRequest().path)

        server.enqueue(MockResponse().setResponseCode(201).setBody("""{"id":"pinv-1","maxUses":1,"uses":0,"expiresAt":1700000000000,"revoked":0,"kind":"registration","token":"ptok","url":"/invite/ptok"}"""))
        val pInv = repository.createPersonalInvite(expiresInHours = 72)
        assertEquals("$baseUrl/invite/ptok", pInv.url)
        assertEquals("/api/me/invites", server.takeRequest().path)

        server.enqueue(MockResponse().setResponseCode(204))
        repository.revokePersonalInvite("pinv-1")
        assertEquals("/api/me/invites/pinv-1", server.takeRequest().path)
    }

    @Test
    fun sessionsTokensDeviceCodePasswordAndIdentities_workEndToEnd() = runTest {
        authRepository.completeAuthorizationWithMetadata(
            serverOrigin = baseUrl,
            token = "tok_admin_123456789012345678901234567890123",
            scopes = setOf("read", "write", "account", "admin"),
            mustChangePassword = true,
        )

        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"sessions":[{"id":"s1","current":false,"online":true,"expiresAt":1700000000000,"browser":"Chrome","os":"macOS"}]}"""))
        assertEquals("Chrome", repository.listSessions().first().browser)
        assertEquals("/api/sessions", server.takeRequest().path)

        server.enqueue(MockResponse().setResponseCode(204))
        repository.revokeSession("s1")
        assertEquals("/api/sessions/s1", server.takeRequest().path)

        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"revoked":3}"""))
        assertEquals(3, repository.revokeOtherSessions())
        assertEquals("/api/sessions/revoke-others", server.takeRequest().path)

        // Tokens: explicit null expiresInDays
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"tokens":[{"id":"t1","userId":"u1","name":"CLI","scopes":["read","write"]}]}"""))
        assertEquals(1, repository.listTokens().size)
        assertEquals("/api/tokens", server.takeRequest().path)

        server.enqueue(MockResponse().setResponseCode(201).setBody("""{"id":"t2","userId":"u1","name":"NeverExpire","scopes":["read"],"token":"raw_pat_123"}"""))
        val createdTok = repository.createToken(name = "NeverExpire", scopes = listOf("read"), expiresInDays = null)
        assertEquals("raw_pat_123", createdTok.token)
        val createTokReq = server.takeRequest()
        val createTokBody = Json.parseToJsonElement(createTokReq.body.readUtf8()) as JsonObject
        assertEquals(JsonNull, createTokBody["expiresInDays"])

        server.enqueue(MockResponse().setResponseCode(204))
        repository.updateToken("t2", "Renamed")
        assertEquals("/api/tokens/t2", server.takeRequest().path)

        server.enqueue(MockResponse().setResponseCode(204))
        repository.revokeToken("t2", purge = true)
        assertEquals("/api/tokens/t2?purge=1", server.takeRequest().path)

        // Device code lookup / approve / deny
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"name":"CLI","ipSummary":"127.0.0.0/24","scopes":["read","write"],"expiresAt":1700000000000,"tokenExpiresInDays":365}"""))
        val lookup = repository.lookupDeviceCode("ABCD-EFGH", "vid-9")
        assertEquals("CLI", lookup.name)
        assertEquals("/api/auth/device?user_code=ABCD-EFGH&verification_id=vid-9", server.takeRequest().path)

        server.enqueue(MockResponse().setResponseCode(204))
        repository.approveDeviceCode("ABCD-EFGH", "vid-9")
        assertEquals("/api/auth/device/approve", server.takeRequest().path)

        server.enqueue(MockResponse().setResponseCode(204))
        repository.denyDeviceCode("WXYZ-1234")
        assertEquals("/api/auth/device/deny", server.takeRequest().path)

        // Change password clears mustChangePassword on AuthRepository
        assertTrue(authRepository.sessionState.value.mustChangePassword)
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"hasPassword":true,"mustChangePassword":false,"revokedSessions":2}"""))
        val pwdRes = repository.changePassword("old-pass-123", "new-pass-456")
        assertEquals(2, pwdRes.revokedSessions)
        assertFalse(authRepository.sessionState.value.mustChangePassword)
        assertEquals("/api/me/password", server.takeRequest().path)

        // Identities
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"identities":[{"provider":"github","email":"a@b.c","linkedAt":1700000000000}],"available":["github","google"]}"""))
        val ids = repository.listIdentities()
        assertEquals(listOf("github", "google"), ids.available)
        assertEquals("/api/me/identities", server.takeRequest().path)

        server.enqueue(MockResponse().setResponseCode(204))
        repository.unlinkIdentity("github")
        assertEquals("/api/me/identities/github", server.takeRequest().path)
    }

    @Test
    fun adminEndpoints_usersInvitesLimitsRoomsSiteAndOAuth() = runTest {
        signInAdminToken()

        // Users
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"users":[{"id":"u1","email":"a@b.c","name":"A","role":"admin","quotaBytes":107374182400}]}"""))
        assertEquals(107374182400L, repository.listUsers().first().quotaBytes)
        assertEquals("/api/admin/users", server.takeRequest().path)

        server.enqueue(MockResponse().setResponseCode(201).setBody("""{"id":"u2","email":"new@b.c","name":"New","role":"user","temporaryPassword":"abcd-efgh-ijkl"}"""))
        val newUser = repository.createUser("new@b.c", name = "New", temporaryPassword = true)
        assertEquals("abcd-efgh-ijkl", newUser.temporaryPassword)
        assertEquals("/api/admin/users", server.takeRequest().path)

        server.enqueue(MockResponse().setResponseCode(204))
        repository.updateUser(
            userId = "u2",
            disabled = OptionalField.Present(true),
            quotaBytes = OptionalField.Present(null),
        )
        val patchUserReq = server.takeRequest()
        val patchUserJson = Json.parseToJsonElement(patchUserReq.body.readUtf8()) as JsonObject
        assertEquals(true, patchUserJson["disabled"]?.jsonPrimitive?.boolean)
        assertEquals(JsonNull, patchUserJson["quotaBytes"])
        assertNull(patchUserJson["role"])

        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"temporaryPassword":"temp-pass-0000","mustChangePassword":true}"""))
        assertEquals("temp-pass-0000", repository.resetUserPassword("u2").temporaryPassword)
        assertEquals("/api/admin/users/u2/password", server.takeRequest().path)

        server.enqueue(MockResponse().setResponseCode(204))
        repository.logoutUser("u2")
        assertEquals("/api/admin/users/u2/logout", server.takeRequest().path)

        // Admin invites & registration
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"invites":[{"id":"ai1","spaceId":"sp1","kind":"registration","creatorAdmin":true,"status":"open"}]}"""))
        assertEquals("registration", repository.listAdminInvites().first().kind)
        assertEquals("/api/admin/invites", server.takeRequest().path)

        server.enqueue(MockResponse().setResponseCode(201).setBody("""{"id":"ai2","kind":"registration","token":"t9","url":"/invite/t9"}"""))
        assertEquals("$baseUrl/invite/t9", repository.createAdminInvite(kind = "registration", maxUses = 5, expiresInHours = 48).url)
        assertEquals("/api/admin/invites", server.takeRequest().path)

        server.enqueue(MockResponse().setResponseCode(204))
        repository.revokeAdminInvite("ai2")
        assertEquals("/api/admin/invites/ai2", server.takeRequest().path)

        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"policy":"invite","default":"invite"}"""))
        assertEquals("invite", repository.getRegistrationPolicy().policy)
        assertEquals("/api/admin/registration", server.takeRequest().path)

        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"policy":"open","default":"invite"}"""))
        assertEquals("open", repository.updateRegistrationPolicy("open").policy)
        assertEquals("/api/admin/registration", server.takeRequest().path)

        // Limits (Long > Int.MAX_VALUE) & Audit
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """{"userQuotaBytes":{"value":107374182400,"default":536870912,"overridden":true,"min":1,"max":107374182400}}""",
            ),
        )
        val limits = repository.getLimits()
        assertEquals(107374182400L, limits["userQuotaBytes"]?.max)
        assertEquals("/api/admin/limits", server.takeRequest().path)

        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """{"maxItems":{"value":500,"default":200,"overridden":true,"min":1,"max":100000}}""",
            ),
        )
        val patchedLimits = repository.updateLimits(mapOf("maxItems" to 500L, "userQuotaBytes" to null))
        assertEquals(500L, patchedLimits["maxItems"]?.value)
        val patchLimitsJson = Json.parseToJsonElement(server.takeRequest().body.readUtf8()) as JsonObject
        assertEquals(500L, patchLimitsJson["maxItems"]?.jsonPrimitive?.long)
        assertEquals(JsonNull, patchLimitsJson["userQuotaBytes"])

        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """{"entries":[{"id":42,"actorId":"u1","actorEmail":"a@b.c","createdAt":1700000000000,"key":"maxItems","oldValue":200,"newValue":500,"oldOverride":null,"newOverride":500}],"nextCursor":42}""",
            ),
        )
        val audit = repository.getLimitsAudit(limit = 20, cursor = 100)
        assertEquals(42L, audit.nextCursor)
        assertEquals("/api/admin/limits/audit?limit=20&cursor=100", server.takeRequest().path)

        // Admin rooms
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"rooms":[{"id":"r1","code":"AbCd12","anonymous":true,"itemCount":3,"bytes":128,"hasPin":true,"closed":false}]}"""))
        assertEquals("AbCd12", repository.listAdminRooms().first().code)
        assertEquals("/api/admin/rooms", server.takeRequest().path)

        server.enqueue(MockResponse().setResponseCode(204))
        repository.unlockRoom("r1")
        assertEquals("/api/admin/rooms/r1/unlock", server.takeRequest().path)

        server.enqueue(MockResponse().setResponseCode(204))
        repository.closeRoom("r1")
        assertEquals("/api/admin/rooms/r1/close", server.takeRequest().path)

        server.enqueue(MockResponse().setResponseCode(204))
        repository.reopenRoom("r1")
        assertEquals("/api/admin/rooms/r1/reopen", server.takeRequest().path)

        server.enqueue(MockResponse().setResponseCode(204))
        repository.deleteRoom("r1")
        assertEquals("/api/admin/rooms/r1", server.takeRequest().path)

        // Site & OAuth
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"origin":"https://dropit.test","source":"admin","effectiveOrigin":"https://dropit.test","callbacks":[{"provider":"github","label":"GitHub","url":"https://dropit.test/api/auth/github/callback"}]}"""))
        assertEquals("https://dropit.test", repository.getSiteSettings().origin)
        assertEquals("/api/admin/site", server.takeRequest().path)

        server.enqueue(MockResponse().setResponseCode(409).setBody("""{"error":{"code":"ORIGIN_CONFIRM_REQUIRED","origin":"https://new.test","current":"https://dropit.test"}}"""))
        try {
            repository.updateSiteSettings("https://new.test", confirm = false)
            fail("Expected 409 ORIGIN_CONFIRM_REQUIRED")
        } catch (e: ApiError) {
            assertTrue(e.isOriginConfirmRequired)
            assertEquals("https://new.test", e.details["origin"])
        }
        server.takeRequest()

        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"origin":null,"source":"request","effectiveOrigin":"https://dropit.test","callbacks":[]}"""))
        val resetSite = repository.updateSiteSettings(origin = null, confirm = true)
        assertNull(resetSite.origin)
        val resetSiteJson = Json.parseToJsonElement(server.takeRequest().body.readUtf8()) as JsonObject
        assertEquals(JsonNull, resetSiteJson["origin"])
        assertEquals(true, resetSiteJson["confirm"]?.jsonPrimitive?.boolean)

        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"origin":"https://dropit.test","providers":[{"provider":"github","label":"GitHub","enabled":true,"active":true,"clientId":"cid","secretSet":true}]}"""))
        assertEquals("cid", repository.getOAuthSettings().providers.first().clientId)
        assertEquals("/api/admin/oauth", server.takeRequest().path)

        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"origin":"https://dropit.test","providers":[{"provider":"github","enabled":true,"clientId":"cid2","secretSet":true}]}"""))
        assertEquals("cid2", repository.updateOAuthProvider("github", "cid2", "sec", enabled = true).providers.first().clientId)
        assertEquals("/api/admin/oauth/github", server.takeRequest().path)

        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"ok":true,"code":"CREDENTIALS_OK","checkedAt":1700000000000,"source":"database","origin":"https://dropit.test","providers":[]}"""))
        val verified = repository.verifyOAuthProvider("github")
        assertTrue(verified.ok)
        assertEquals("CREDENTIALS_OK", verified.code)
        assertEquals("/api/admin/oauth/github/verify", server.takeRequest().path)

        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"origin":"https://dropit.test","providers":[]}"""))
        assertNotNull(repository.deleteOAuthProvider("github"))
        assertEquals("/api/admin/oauth/github", server.takeRequest().path)
    }

    @Test
    fun insufficientScope403_updatesCapabilityStateForAccountSettings() = runTest {
        // Suppose client thought it had account scope, but server returns 403 INSUFFICIENT_SCOPE
        authRepository.completeAuthorizationWithMetadata(
            serverOrigin = baseUrl,
            token = "tok_stale_123456789012345678901234567890123",
            scopes = setOf("read", "write", "account"),
        )
        assertEquals(AccountCapabilityState.Ready(hasAdminScope = false), repository.accountCapability.value)

        server.enqueue(MockResponse().setResponseCode(403).setBody("""{"error":{"code":"INSUFFICIENT_SCOPE"}}"""))
        try {
            repository.listManagedShares()
            fail("Expected 403 INSUFFICIENT_SCOPE")
        } catch (e: ApiError) {
            assertTrue(e.isInsufficientScope)
            assertEquals(ApiErrorCode.INSUFFICIENT_SCOPE, e.errorCode)
        }

        assertFalse(authRepository.hasAccountScope)
        assertTrue(repository.accountCapability.value is AccountCapabilityState.InsufficientScopeForAccountSettings)
    }
}
