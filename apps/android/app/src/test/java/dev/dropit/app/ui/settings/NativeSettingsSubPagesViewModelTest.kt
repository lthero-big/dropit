package dev.dropit.app.ui.settings

import dev.dropit.app.core.auth.AccountCapabilityState
import dev.dropit.app.core.auth.OAuthLinkResult
import dev.dropit.app.core.auth.PendingOAuthLink
import dev.dropit.app.core.network.AccessTokenInfo
import dev.dropit.app.core.network.ApiError
import dev.dropit.app.core.network.ApiErrorCode
import dev.dropit.app.core.network.OptionalField
import dev.dropit.app.core.network.Space
import dev.dropit.app.data.account.AccountSettingsRepository
import dev.dropit.app.data.account.AdminInvite
import dev.dropit.app.data.account.AdminRoom
import dev.dropit.app.data.account.AdminUser
import dev.dropit.app.data.account.BrowserSessionInfo
import dev.dropit.app.data.account.ChangePasswordResult
import dev.dropit.app.data.account.CreatedAccessToken
import dev.dropit.app.data.account.CreatedInvite
import dev.dropit.app.data.account.DeviceCodeLookup
import dev.dropit.app.data.account.IdentitiesResponse
import dev.dropit.app.data.account.LimitAuditEntry
import dev.dropit.app.data.account.LimitAuditPage
import dev.dropit.app.data.account.LimitField
import dev.dropit.app.data.account.LinkedIdentityInfo
import dev.dropit.app.data.account.ManagedShare
import dev.dropit.app.data.account.ManagedShareLink
import dev.dropit.app.data.account.ManagedSharesPage
import dev.dropit.app.data.account.OAuthProviderConfig
import dev.dropit.app.data.account.OAuthSettingsInfo
import dev.dropit.app.data.account.OAuthVerifyResult
import dev.dropit.app.data.account.PersonalInvite
import dev.dropit.app.data.account.PersonalInvitesResponse
import dev.dropit.app.data.account.RegistrationPolicyInfo
import dev.dropit.app.data.account.ResetUserPasswordResult
import dev.dropit.app.data.account.SharePresets
import dev.dropit.app.data.account.SiteSettingsInfo
import dev.dropit.app.data.account.SpaceInvite
import dev.dropit.app.data.account.SpaceInvitesResponse
import dev.dropit.app.data.account.SpaceMember
import dev.dropit.app.ui.share.ShareExpiryUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class NativeSettingsSubPagesViewModelTest {

    private val testDispatcher = StandardTestDispatcher()

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    @Test
    fun sharePresetsViewModel_addsSavesSyncsAndHandlesInsufficientScope() = runTest(testDispatcher) {
        val repo = FakeAccountSettingsRepository()
        val vm = SharePresetsViewModel(repository = repo, ioDispatcher = testDispatcher)

        vm.load()
        advanceUntilIdle()
        assertTrue(vm.uiState.value.isLoaded)

        // Add custom 2 days and 20 views
        vm.onUnitSelected(ShareExpiryUnit.DAYS)
        vm.onDurationInputChanged("2")
        vm.addExpiry()
        assertEquals(listOf(2), vm.uiState.value.presets.days)
        assertTrue(vm.uiState.value.isDirty)

        // Duplicate built-in 1d rejected
        vm.onDurationInputChanged("1")
        vm.addExpiry()
        assertNotNull(vm.uiState.value.errorMessage)

        vm.onViewsInputChanged("20")
        vm.addViews()
        assertEquals(listOf(20), vm.uiState.value.presets.views)

        var synced: SharePresets? = null
        vm.save { synced = it }
        advanceUntilIdle()

        assertEquals(SharePresets(days = listOf(2), views = listOf(20)), synced)
        assertFalse(vm.uiState.value.isDirty)

        // 403 INSUFFICIENT_SCOPE triggers upgrade card
        repo.nextError = insufficientScopeError()
        vm.onViewsInputChanged("30")
        vm.addViews()
        vm.save()
        advanceUntilIdle()
        assertTrue(vm.uiState.value.requiresScopeUpgrade)
    }

    @Test
    fun shareLinksViewModel_paginatesFiltersFetchesLinkRevokesDeletesAndHandles403() = runTest(testDispatcher) {
        val repo = FakeAccountSettingsRepository()
        val vm = ShareLinksViewModel(repository = repo, ioDispatcher = testDispatcher)

        vm.load()
        advanceUntilIdle()
        assertEquals(2, vm.uiState.value.shares.size)
        assertEquals("cursor-2", vm.uiState.value.nextCursor)

        vm.selectFilter(ShareLinksFilter.ACTIVE)
        assertEquals(1, vm.uiState.value.filteredShares.size)

        var resolvedUrl: String? = null
        vm.fetchLink("sh-active") { resolvedUrl = it.url }
        advanceUntilIdle()
        assertEquals("https://dropit.example.com/s/sh-active", resolvedUrl)

        vm.revoke("sh-active")
        advanceUntilIdle()
        assertEquals(0, vm.uiState.value.filteredShares.size)

        vm.selectFilter(ShareLinksFilter.ALL)
        vm.delete("sh-revoked")
        advanceUntilIdle()
        assertEquals(1, vm.uiState.value.shares.size)

        vm.loadMore()
        advanceUntilIdle()
        assertEquals(2, vm.uiState.value.shares.size)
        assertNull(vm.uiState.value.nextCursor)

        repo.nextError = insufficientScopeError()
        vm.load()
        advanceUntilIdle()
        assertTrue(vm.uiState.value.requiresScopeUpgrade)
    }

    @Test
    fun spaceSharingViewModel_managesMembersInvitesAndLeavingSpace() = runTest(testDispatcher) {
        val repo = FakeAccountSettingsRepository()
        val vm = SpaceSharingViewModel(repository = repo, ioDispatcher = testDispatcher)
        val spaces = listOf(
            Space(id = "sp-own", name = "我的空间", ownerId = "u-1", role = "owner"),
            Space(id = "sp-guest", name = "团队空间", ownerId = "u-2", role = "viewer", ownerName = "Bob"),
        )

        vm.load(spaces, currentUserId = "u-1", canManagePersonalInvites = true)
        advanceUntilIdle()
        assertEquals("sp-own", vm.uiState.value.selectedSpace?.id)
        assertEquals(1, vm.uiState.value.members.size)

        // Toggle role viewer -> editor
        vm.toggleMemberRole(vm.uiState.value.members.first())
        advanceUntilIdle()
        assertEquals("editor", vm.uiState.value.members.first().role)

        // Create space invite
        vm.selectInviteRole("editor")
        vm.createSpaceInvite()
        advanceUntilIdle()
        assertEquals("https://dropit.example.com/join/sp-tok", vm.uiState.value.latestSpaceInviteUrl)

        // Switch to guest space and leave
        vm.selectSpace("sp-guest")
        advanceUntilIdle()
        var leftNotified = false
        vm.leaveSelectedSpace { leftNotified = true }
        advanceUntilIdle()
        assertTrue(leftNotified)
        assertEquals(listOf("sp-guest"), repo.leftSpaces)
    }

    @Test
    fun devicesViewModel_listsRevokesSingleAndOthersAndHandles403() = runTest(testDispatcher) {
        val repo = FakeAccountSettingsRepository()
        val vm = DevicesViewModel(repository = repo, ioDispatcher = testDispatcher)

        vm.load()
        advanceUntilIdle()
        assertEquals(2, vm.uiState.value.sessions.size)

        vm.revokeSession("sess-2")
        advanceUntilIdle()
        assertEquals(1, vm.uiState.value.sessions.size)

        vm.revokeOtherSessions()
        advanceUntilIdle()
        assertTrue(vm.uiState.value.feedbackMessage!!.contains("1"))

        repo.nextError = insufficientScopeError()
        vm.load()
        advanceUntilIdle()
        assertTrue(vm.uiState.value.requiresScopeUpgrade)
    }

    @Test
    fun tokensViewModel_createsPatAndApprovesDeviceCode() = runTest(testDispatcher) {
        val repo = FakeAccountSettingsRepository()
        val vm = TokensViewModel(repository = repo, ioDispatcher = testDispatcher)

        vm.load()
        advanceUntilIdle()
        assertEquals(1, vm.uiState.value.tokens.size)

        vm.onNewTokenNameChanged("Mac CLI")
        vm.createToken()
        advanceUntilIdle()
        assertEquals("pat_plaintext_once", vm.uiState.value.createdToken?.token)
        assertEquals(2, vm.uiState.value.tokens.size)

        // Device code lookup & approve
        vm.onUserCodeChanged("abcd-1234")
        vm.lookupDeviceCode()
        advanceUntilIdle()
        assertEquals("Pixel CLI", vm.uiState.value.lookedUpDevice?.name)

        vm.approveDeviceCode()
        advanceUntilIdle()
        assertEquals(listOf("ABCD-1234"), repo.approvedDeviceCodes)
        assertNull(vm.uiState.value.lookedUpDevice)
    }

    @Test
    fun securityViewModel_changesPasswordGuardsLastIdentityAndHandlesOAuthLink() = runTest(testDispatcher) {
        val repo = FakeAccountSettingsRepository()
        val vm = SecurityViewModel(repository = repo, ioDispatcher = testDispatcher)

        // User has NO password and only 1 OAuth identity -> cannot unlink
        vm.load(hasPassword = false)
        advanceUntilIdle()
        assertFalse(vm.uiState.value.canUnlinkAnyIdentity)

        vm.unlinkIdentity("github")
        advanceUntilIdle()
        assertNotNull(vm.uiState.value.errorMessage)
        assertTrue(repo.unlinkedProviders.isEmpty())

        // Setting a password unlocks unlinking
        vm.onNewPasswordChanged("NewSecurePass123")
        vm.onConfirmPasswordChanged("NewSecurePass123")
        vm.submitChangePassword()
        advanceUntilIdle()
        assertTrue(vm.uiState.value.hasPassword)
        assertTrue(vm.uiState.value.canUnlinkAnyIdentity)

        // Start linking Google & receive callback result
        vm.startOAuthLink("google")
        advanceUntilIdle()
        assertEquals("https://dropit.example.com/api/auth/google?ticket=t1", vm.uiState.value.pendingLinkLaunchUrl)
        vm.onOAuthLinkResult(OAuthLinkResult.Linked(provider = "google", alreadyLinked = false))
        advanceUntilIdle()
        assertTrue(vm.uiState.value.feedbackMessage!!.contains("Google"))

        // Now unlinking github succeeds
        vm.unlinkIdentity("github")
        advanceUntilIdle()
        assertEquals(listOf("github"), repo.unlinkedProviders)
    }

    @Test
    fun adminSettingsViewModel_coversUsersPolicyLimitsRoomsAndSite409Confirm() = runTest(testDispatcher) {
        val repo = FakeAccountSettingsRepository()
        val vm = AdminSettingsViewModel(repository = repo, ioDispatcher = testDispatcher)

        // 1. Users
        vm.loadTab(AdminTab.USERS)
        advanceUntilIdle()
        assertEquals(1, vm.uiState.value.users.size)
        vm.resetUserPassword(vm.uiState.value.users.first())
        advanceUntilIdle()
        assertEquals("u1@example.com" to "TempReset999!", vm.uiState.value.oneTimePasswordNotice)

        // 2. Invites & Registration Policy
        vm.selectTab(AdminTab.INVITES)
        advanceUntilIdle()
        assertEquals("invite", vm.uiState.value.registrationPolicy?.policy)
        vm.updateRegistrationPolicy("closed")
        advanceUntilIdle()
        assertEquals("closed", vm.uiState.value.registrationPolicy?.policy)

        // 3. Runtime Limits & Audit + Catalog validation
        vm.selectTab(AdminTab.LIMITS)
        advanceUntilIdle()
        assertNotNull(vm.uiState.value.limits["maxFileBytes"])
        assertEquals(
            "房间单文件必须小于单文件上限",
            RuntimeLimitsCatalog.localLimitError("roomMaxFileBytes", 500L * 1024 * 1024, vm.uiState.value.limits),
        )
        vm.updateLimit("maxFileBytes", 200L * 1024 * 1024)
        advanceUntilIdle()
        assertEquals(200L * 1024 * 1024, vm.uiState.value.limits["maxFileBytes"]?.value)

        // 4. Temporary Rooms
        vm.selectTab(AdminTab.ROOMS)
        advanceUntilIdle()
        assertEquals(1, vm.uiState.value.adminRooms.size)
        vm.closeRoom("rm-1")
        advanceUntilIdle()
        assertTrue(vm.uiState.value.adminRooms.first().closed)

        // 5. Site origin 409 ORIGIN_CONFIRM_REQUIRED two-step confirmation + OAuth verify
        vm.selectTab(AdminTab.SITE_OAUTH)
        advanceUntilIdle()
        vm.updateSiteOrigin("https://new.dropit.test", confirm = false)
        advanceUntilIdle()
        assertEquals("https://new.dropit.test", vm.uiState.value.pendingOriginConfirm?.targetOrigin)

        vm.updateSiteOrigin("https://new.dropit.test", confirm = true)
        advanceUntilIdle()
        assertNull(vm.uiState.value.pendingOriginConfirm)
        assertEquals("https://new.dropit.test", vm.uiState.value.siteSettings?.effectiveOrigin)

        vm.verifyOAuthProvider("github")
        advanceUntilIdle()
        assertTrue(vm.uiState.value.lastOAuthVerifyResult?.second?.ok == true)
    }

    private fun insufficientScopeError() = ApiError(
        errorCode = ApiErrorCode.INSUFFICIENT_SCOPE,
        rawCode = "INSUFFICIENT_SCOPE",
        httpStatus = 403,
        userMessage = ApiErrorCode.INSUFFICIENT_SCOPE.defaultMessage,
    )

    private class FakeAccountSettingsRepository : AccountSettingsRepository {
        override val accountCapability: StateFlow<AccountCapabilityState> =
            MutableStateFlow(AccountCapabilityState.Ready(hasAdminScope = true))

        var nextError: ApiError? = null

        private var presets = SharePresets()
        private var shares = mutableListOf(
            ManagedShare(id = "sh-active", itemId = "i1", state = "active", copyStatus = "available", sourceName = "a.pdf"),
            ManagedShare(id = "sh-revoked", itemId = "i2", state = "revoked", revoked = 1, copyStatus = "unavailable", sourceName = "b.txt"),
        )
        private var members = mutableListOf(
            SpaceMember(userId = "u-guest", email = "guest@example.com", name = "Guest", role = "viewer"),
        )
        val leftSpaces = mutableListOf<String>()
        private var sessions = mutableListOf(
            BrowserSessionInfo(id = "sess-1", current = true, online = true, browser = "Chrome", os = "macOS"),
            BrowserSessionInfo(id = "sess-2", current = false, online = false, browser = "Safari", os = "iOS"),
        )
        private var tokens = mutableListOf(
            AccessTokenInfo(id = "tok-1", userId = "u-1", name = "Existing", scopes = listOf("read", "write")),
        )
        val approvedDeviceCodes = mutableListOf<String>()
        private var identities = mutableListOf(
            LinkedIdentityInfo(provider = "github", email = "u@github.test", linkedAt = 1000L),
        )
        val unlinkedProviders = mutableListOf<String>()
        private var users = mutableListOf(
            AdminUser(id = "u-1", email = "u1@example.com", name = "User One", role = "admin", quotaBytes = 1024L * 1024 * 1024),
        )
        private var regPolicy = RegistrationPolicyInfo(policy = "invite")
        private var limits = mutableMapOf(
            "maxFileBytes" to LimitField(value = 100L * 1024 * 1024, defaultValue = 100L * 1024 * 1024, min = 1024L, max = 1024L * 1024 * 1024),
            "roomMaxFileBytes" to LimitField(value = 20L * 1024 * 1024, defaultValue = 20L * 1024 * 1024, min = 1024L, max = 1024L * 1024 * 1024),
        )
        private var rooms = mutableListOf(
            AdminRoom(id = "rm-1", code = "123456", closed = false, lockedFor = 30),
        )
        private var siteSettings = SiteSettingsInfo(effectiveOrigin = "https://dropit.example.com", source = "env")
        private var oauthSettings = OAuthSettingsInfo(
            origin = "https://dropit.example.com",
            providers = listOf(OAuthProviderConfig(provider = "github", label = "GitHub", source = "database", enabled = true, active = true, clientId = "cid", secretSet = true)),
        )

        private fun checkError() {
            nextError?.let {
                nextError = null
                throw it
            }
        }

        override suspend fun getSharePresets(): SharePresets {
            checkError()
            return presets
        }

        override suspend fun saveSharePresets(days: List<Int>, views: List<Int>, hours: List<Int>, months: List<Int>): SharePresets {
            checkError()
            presets = SharePresets(hours = hours, days = days, months = months, views = views)
            return presets
        }

        override suspend fun listManagedShares(cursor: String?): ManagedSharesPage {
            checkError()
            return if (cursor == null) {
                ManagedSharesPage(shares = shares.toList(), nextCursor = "cursor-2")
            } else {
                ManagedSharesPage(
                    shares = listOf(ManagedShare(id = "sh-page2", itemId = "i3", state = "expired")),
                    nextCursor = null,
                )
            }
        }

        override suspend fun getManagedShareLink(shareId: String): ManagedShareLink {
            checkError()
            return ManagedShareLink(url = "https://dropit.example.com/s/$shareId")
        }

        override suspend fun revokeManagedShare(shareId: String) {
            checkError()
            shares = shares.map { if (it.id == shareId) it.copy(revoked = 1, state = "revoked") else it }.toMutableList()
        }

        override suspend fun deleteManagedShare(shareId: String) {
            checkError()
            shares.removeAll { it.id == shareId }
        }

        override suspend fun listSpaceMembers(spaceId: String): List<SpaceMember> {
            checkError()
            return members.toList()
        }

        override suspend fun updateSpaceMemberRole(spaceId: String, userId: String, role: String): List<SpaceMember> {
            checkError()
            members = members.map { if (it.userId == userId) it.copy(role = role) else it }.toMutableList()
            return members.toList()
        }

        override suspend fun removeSpaceMember(spaceId: String, userId: String) {
            checkError()
            members.removeAll { it.userId == userId }
        }

        override suspend fun leaveSpace(spaceId: String) {
            checkError()
            leftSpaces.add(spaceId)
        }

        override suspend fun listSpaceInvites(spaceId: String): SpaceInvitesResponse = SpaceInvitesResponse()

        override suspend fun createSpaceInvite(spaceId: String, role: String, maxUses: Int, expiresInHours: Int): SpaceInvite =
            SpaceInvite(id = "inv-1", role = role, maxUses = maxUses, url = "https://dropit.example.com/join/sp-tok")

        override suspend fun revokeSpaceInvite(spaceId: String, inviteId: String) = Unit

        override suspend fun listPersonalInvites(): PersonalInvitesResponse =
            PersonalInvitesResponse(invites = listOf(PersonalInvite(id = "pinv-1", status = "open")))

        override suspend fun createPersonalInvite(expiresInHours: Int): CreatedInvite =
            CreatedInvite(id = "pinv-2", token = "p-tok", url = "https://dropit.example.com/invite/p-tok")

        override suspend fun revokePersonalInvite(id: String) = Unit

        override suspend fun listSessions(): List<BrowserSessionInfo> {
            checkError()
            return sessions.toList()
        }

        override suspend fun revokeSession(id: String) {
            checkError()
            sessions.removeAll { it.id == id }
        }

        override suspend fun revokeOtherSessions(): Int {
            checkError()
            return 1
        }

        override suspend fun listTokens(): List<AccessTokenInfo> {
            checkError()
            return tokens.toList()
        }

        override suspend fun createToken(name: String, scopes: List<String>, expiresInDays: Int?): CreatedAccessToken {
            checkError()
            val created = CreatedAccessToken(id = "tok-2", userId = "u-1", name = name, scopes = scopes, token = "pat_plaintext_once")
            tokens.add(AccessTokenInfo(id = created.id, userId = created.userId, name = created.name, scopes = created.scopes))
            return created
        }

        override suspend fun updateToken(id: String, name: String) = Unit
        override suspend fun revokeToken(id: String, purge: Boolean) = Unit

        override suspend fun lookupDeviceCode(userCode: String, verificationId: String?): DeviceCodeLookup =
            DeviceCodeLookup(name = "Pixel CLI", ipSummary = "127.0.0.1", scopes = listOf("read", "write"))

        override suspend fun approveDeviceCode(userCode: String, verificationId: String?) {
            approvedDeviceCodes.add(userCode)
        }

        override suspend fun denyDeviceCode(userCode: String, verificationId: String?) = Unit

        override suspend fun changePassword(currentPassword: String?, newPassword: String): ChangePasswordResult {
            checkError()
            return ChangePasswordResult(hasPassword = true, mustChangePassword = false, revokedSessions = 1)
        }

        override suspend fun listIdentities(): IdentitiesResponse {
            checkError()
            return IdentitiesResponse(identities = identities.toList(), available = listOf("github", "google"))
        }

        override suspend fun unlinkIdentity(provider: String) {
            checkError()
            unlinkedProviders.add(provider)
            identities.removeAll { it.provider == provider }
        }

        override suspend fun startAppOAuthLink(provider: String): PendingOAuthLink =
            PendingOAuthLink(
                provider = provider,
                state = "st-12345678",
                ticket = "t1",
                path = "/api/auth/$provider?ticket=t1",
                launchUrl = "https://dropit.example.com/api/auth/$provider?ticket=t1",
            )

        override suspend fun listUsers(): List<AdminUser> = users.toList()
        override suspend fun createUser(email: String, name: String?, role: String, quotaBytes: Long?, temporaryPassword: Boolean): AdminUser =
            AdminUser(id = "u-new", email = email, name = name ?: email, role = role, temporaryPassword = if (temporaryPassword) "Temp1234!" else null)

        override suspend fun updateUser(userId: String, name: OptionalField<String>, role: OptionalField<String>, disabled: OptionalField<Boolean>, quotaBytes: OptionalField<Long?>, inviteLimit: OptionalField<Int?>) = Unit

        override suspend fun resetUserPassword(userId: String): ResetUserPasswordResult =
            ResetUserPasswordResult(temporaryPassword = "TempReset999!", mustChangePassword = true)

        override suspend fun logoutUser(userId: String) = Unit
        override suspend fun listAdminInvites(): List<AdminInvite> = emptyList()
        override suspend fun createAdminInvite(kind: String, spaceId: String?, maxUses: Int, expiresInHours: Int?): CreatedInvite =
            CreatedInvite(id = "ainv-1", token = "a-tok", url = "https://dropit.example.com/invite/a-tok")

        override suspend fun revokeAdminInvite(inviteId: String) = Unit
        override suspend fun getRegistrationPolicy(): RegistrationPolicyInfo = regPolicy
        override suspend fun updateRegistrationPolicy(policy: String): RegistrationPolicyInfo {
            regPolicy = regPolicy.copy(policy = policy)
            return regPolicy
        }

        override suspend fun getLimits(): Map<String, LimitField> = limits.toMap()
        override suspend fun updateLimits(patch: Map<String, Long?>): Map<String, LimitField> {
            patch.forEach { (k, v) ->
                val cur = limits[k] ?: return@forEach
                limits[k] = if (v == null) cur.copy(value = cur.defaultValue, overridden = false) else cur.copy(value = v, overridden = true)
            }
            return limits.toMap()
        }

        override suspend fun getLimitsAudit(limit: Int?, cursor: Long?): LimitAuditPage =
            LimitAuditPage(entries = listOf(LimitAuditEntry(1L, "u-1", "u1@example.com", 1000L, "maxFileBytes", 100L, 200L)))

        override suspend fun listAdminRooms(): List<AdminRoom> = rooms.toList()
        override suspend fun unlockRoom(roomId: String) = Unit
        override suspend fun closeRoom(roomId: String) {
            rooms = rooms.map { if (it.id == roomId) it.copy(closed = true) else it }.toMutableList()
        }

        override suspend fun reopenRoom(roomId: String) = Unit
        override suspend fun deleteRoom(roomId: String) {
            rooms.removeAll { it.id == roomId }
        }

        override suspend fun getSiteSettings(): SiteSettingsInfo = siteSettings
        override suspend fun updateSiteSettings(origin: String?, confirm: Boolean): SiteSettingsInfo {
            if (!confirm && origin != null && origin != siteSettings.effectiveOrigin) {
                throw ApiError(
                    errorCode = ApiErrorCode.ORIGIN_CONFIRM_REQUIRED,
                    rawCode = "ORIGIN_CONFIRM_REQUIRED",
                    httpStatus = 409,
                    userMessage = ApiErrorCode.ORIGIN_CONFIRM_REQUIRED.defaultMessage,
                    details = mapOf("origin" to origin),
                )
            }
            siteSettings = siteSettings.copy(effectiveOrigin = origin ?: "https://dropit.example.com", adminOrigin = origin)
            return siteSettings
        }

        override suspend fun getOAuthSettings(): OAuthSettingsInfo = oauthSettings
        override suspend fun updateOAuthProvider(provider: String, clientId: String, clientSecret: String?, enabled: Boolean): OAuthSettingsInfo = oauthSettings
        override suspend fun deleteOAuthProvider(provider: String): OAuthSettingsInfo = oauthSettings
        override suspend fun verifyOAuthProvider(provider: String): OAuthVerifyResult =
            OAuthVerifyResult(ok = true, code = "CREDENTIALS_OK", providers = oauthSettings.providers)
    }
}
