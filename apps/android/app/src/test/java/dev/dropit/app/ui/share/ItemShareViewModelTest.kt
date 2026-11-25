package dev.dropit.app.ui.share

import dev.dropit.app.core.auth.AccountCapabilityState
import dev.dropit.app.core.auth.PendingOAuthLink
import dev.dropit.app.core.network.AccessTokenInfo
import dev.dropit.app.core.network.ApiError
import dev.dropit.app.core.network.ApiErrorCode
import dev.dropit.app.core.network.ClipItem
import dev.dropit.app.core.network.ItemShare
import dev.dropit.app.core.network.OptionalField
import dev.dropit.app.core.network.TargetScope
import dev.dropit.app.core.repository.ItemShareRepository
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
import dev.dropit.app.data.account.LimitAuditPage
import dev.dropit.app.data.account.LimitField
import dev.dropit.app.data.account.ManagedShareLink
import dev.dropit.app.data.account.ManagedSharesPage
import dev.dropit.app.data.account.OAuthSettingsInfo
import dev.dropit.app.data.account.OAuthVerifyResult
import dev.dropit.app.data.account.PersonalInvitesResponse
import dev.dropit.app.data.account.RegistrationPolicyInfo
import dev.dropit.app.data.account.ResetUserPasswordResult
import dev.dropit.app.data.account.SharePresets
import dev.dropit.app.data.account.SiteSettingsInfo
import dev.dropit.app.data.account.SpaceInvite
import dev.dropit.app.data.account.SpaceInvitesResponse
import dev.dropit.app.data.account.SpaceMember
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
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ItemShareViewModelTest {

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
    fun openCreateAndRevokeShare_updatesListAndResolvesAbsoluteUrls() = runTest(testDispatcher) {
        val existingShare = ItemShare(
            id = "sh-old",
            itemId = "item-1",
            expiresAt = 9_999_999_999L,
            maxViews = 5,
            views = 2,
            revoked = 0,
            token = "Ab12Cd",
            url = "/s/Ab12Cd",
        )
        val repo = FakeItemShareRepository(initialShares = listOf(existingShare))
        val vm = ItemShareViewModel(
            itemShareRepository = repo,
            serverOriginProvider = { "https://dropit.lthero.com/" },
            ioDispatcher = testDispatcher,
        )

        val fileItem = ClipItem(
            id = "item-1",
            spaceId = "sp-1",
            kind = "file",
            filename = "演示文档.pdf",
            size = 4096L,
        )
        val scope = TargetScope.SpaceScope("sp-1")
        vm.openForItem(scope, fileItem)
        advanceUntilIdle()

        assertEquals(listOf("sh-old"), vm.uiState.value.shares.map { it.id })
        assertEquals("https://dropit.lthero.com/settings?tab=share-presets", vm.sharePresetsSettingsUrl())

        vm.selectExpiresIn("3d")
        vm.selectMaxViews(5)
        vm.createShare()
        advanceUntilIdle()

        assertEquals("3d" to 5, repo.lastCreateParams)
        val created = vm.uiState.value.latestCreatedShare!!
        assertEquals("https://dropit.lthero.com/s/${created.token}", vm.resolveSharePageUrl(created))
        assertEquals("https://dropit.lthero.com/d/${created.token}", vm.resolveDirectDownloadUrl(created))
        assertEquals(2, vm.uiState.value.shares.size)

        vm.revokeShare(created.id)
        advanceUntilIdle()

        assertEquals(listOf(created.id), repo.revokedIds)
        assertNull(vm.uiState.value.latestCreatedShare)
        assertEquals(1, vm.uiState.value.shares.first { it.id == created.id }.revoked)
    }

    @Test
    fun openForItem_mergesServerCustomSharePresetsLike2dAndUpdatesLiveOnApplyPresets() = runTest(testDispatcher) {
        val shareRepo = FakeItemShareRepository()
        val presetsRepo = FakePresetsOnlyAccountRepository(
            presets = SharePresets(
                hours = listOf(12, 24), // 24h duplicates built-in 1d and must be deduplicated
                days = listOf(2, 14),
                months = listOf(1),
                views = listOf(2, 5, 20), // 5 duplicates built-in 5
            ),
        )
        val vm = ItemShareViewModel(
            itemShareRepository = shareRepo,
            serverOriginProvider = { "https://dropit.lthero.com" },
            accountSettingsRepository = presetsRepo,
            ioDispatcher = testDispatcher,
        )

        val textItem = ClipItem(id = "item-2", spaceId = "sp-1", kind = "text", text = "hello")
        vm.openForItem(TargetScope.SpaceScope("sp-1"), textItem)
        advanceUntilIdle()

        assertEquals(
            listOf(
                ShareExpiryOption("1h", "1 小时"),
                ShareExpiryOption("12h", "12 小时"),
                ShareExpiryOption("1d", "1 天"),
                ShareExpiryOption("2d", "2 天"),
                ShareExpiryOption("3d", "3 天"),
                ShareExpiryOption("7d", "7 天"),
                ShareExpiryOption("14d", "14 天"),
                ShareExpiryOption("1mo", "1 个月"),
                ShareExpiryOption("never", "不过期"),
            ),
            vm.uiState.value.expiryOptions,
        )
        assertEquals(
            listOf(
                ShareViewsOption(1, "仅一次"),
                ShareViewsOption(2, "2 次"),
                ShareViewsOption(5, "5 次"),
                ShareViewsOption(10, "10 次"),
                ShareViewsOption(20, "20 次"),
                ShareViewsOption(null, "不限"),
            ),
            vm.uiState.value.maxViewsOptions,
        )

        // Select custom "2d" + 20 views and create share
        vm.selectExpiresIn("2d")
        vm.selectMaxViews(20)
        vm.createShare()
        advanceUntilIdle()
        assertEquals("2d" to 20, shareRepo.lastCreateParams)

        // Live sync after editing presets in native SharePresetsSubPage
        vm.applyPresets(SharePresets(days = listOf(5), views = listOf(50)))
        assertEquals(
            listOf("1h", "1d", "3d", "5d", "7d", "never"),
            vm.uiState.value.expiryOptions.map { it.value },
        )
        // Previously selected "2d" was removed -> gracefully resets to "1d"
        assertEquals("1d", vm.uiState.value.selectedExpiresIn)
        assertEquals(listOf(1, 5, 10, 50, null), vm.uiState.value.maxViewsOptions.map { it.value })
    }

    @Test
    fun resolveShareState_distinguishesActiveRevokedExpiredExhausted() {
        val now = 1_000_000L
        assertEquals(
            ShareLinkState.ACTIVE,
            ItemShareViewModel.resolveShareState(
                ItemShare(id = "1", itemId = "i", expiresAt = now + 5000L, maxViews = 5, views = 2, revoked = 0),
                nowMs = now,
            ),
        )
        assertEquals(
            ShareLinkState.REVOKED,
            ItemShareViewModel.resolveShareState(
                ItemShare(id = "2", itemId = "i", expiresAt = now + 5000L, maxViews = 5, views = 0, revoked = 1),
                nowMs = now,
            ),
        )
        assertEquals(
            ShareLinkState.EXPIRED,
            ItemShareViewModel.resolveShareState(
                ItemShare(id = "3", itemId = "i", expiresAt = now - 1L, maxViews = 5, views = 0, revoked = 0),
                nowMs = now,
            ),
        )
        assertEquals(
            ShareLinkState.EXHAUSTED,
            ItemShareViewModel.resolveShareState(
                ItemShare(id = "4", itemId = "i", expiresAt = null, maxViews = 1, views = 1, revoked = 0),
                nowMs = now,
            ),
        )
    }

    @Test
    fun unauthorizedError_invokesSessionExpiredCallback() = runTest(testDispatcher) {
        var expiredCount = 0
        val repo = FakeItemShareRepository(
            nextError = ApiError(
                errorCode = ApiErrorCode.UNAUTHENTICATED,
                rawCode = "UNAUTHENTICATED",
                httpStatus = 401,
                userMessage = ApiErrorCode.UNAUTHENTICATED.defaultMessage,
            ),
        )
        val vm = ItemShareViewModel(
            itemShareRepository = repo,
            serverOriginProvider = { "https://dropit.lthero.com" },
            onSessionExpired = { expiredCount++ },
            ioDispatcher = testDispatcher,
        )

        vm.openForItem(TargetScope.SpaceScope("sp-1"), ClipItem(id = "i1", spaceId = "sp-1", kind = "text", text = "hi"))
        advanceUntilIdle()

        assertEquals(1, expiredCount)
    }

    private class FakeItemShareRepository(
        initialShares: List<ItemShare> = emptyList(),
        var nextError: Throwable? = null,
    ) : ItemShareRepository {
        private val shares = initialShares.toMutableList()
        var lastCreateParams: Pair<String, Int?>? = null
        val revokedIds = mutableListOf<String>()
        private var seq = 1

        override suspend fun createShare(
            scope: TargetScope,
            itemId: String,
            expiresIn: String,
            maxViews: Int?,
        ): ItemShare {
            nextError?.let { throw it }
            lastCreateParams = expiresIn to maxViews
            val tok = "Tk000${seq++}"
            val created = ItemShare(
                id = "sh-new-$seq",
                itemId = itemId,
                expiresAt = if (expiresIn == "never") null else 9_999_999_999L,
                maxViews = maxViews,
                views = 0,
                revoked = 0,
                token = tok,
                url = "/s/$tok",
                directUrl = "/d/$tok",
            )
            shares.add(0, created)
            return created
        }

        override suspend fun listShares(scope: TargetScope, itemId: String): List<ItemShare> {
            nextError?.let { throw it }
            return shares.toList()
        }

        override suspend fun revokeShare(scope: TargetScope, shareId: String) {
            nextError?.let { throw it }
            revokedIds.add(shareId)
        }
    }

    private class FakePresetsOnlyAccountRepository(
        var presets: SharePresets,
    ) : AccountSettingsRepository {
        override val accountCapability: StateFlow<AccountCapabilityState> =
            MutableStateFlow(AccountCapabilityState.Ready(hasAdminScope = false))

        override suspend fun getSharePresets(): SharePresets = presets
        override suspend fun saveSharePresets(days: List<Int>, views: List<Int>, hours: List<Int>, months: List<Int>): SharePresets = presets
        override suspend fun listManagedShares(cursor: String?): ManagedSharesPage = ManagedSharesPage()
        override suspend fun getManagedShareLink(shareId: String): ManagedShareLink = ManagedShareLink("")
        override suspend fun revokeManagedShare(shareId: String) = Unit
        override suspend fun deleteManagedShare(shareId: String) = Unit
        override suspend fun listSpaceMembers(spaceId: String): List<SpaceMember> = emptyList()
        override suspend fun updateSpaceMemberRole(spaceId: String, userId: String, role: String): List<SpaceMember> = emptyList()
        override suspend fun removeSpaceMember(spaceId: String, userId: String) = Unit
        override suspend fun leaveSpace(spaceId: String) = Unit
        override suspend fun listSpaceInvites(spaceId: String): SpaceInvitesResponse = SpaceInvitesResponse()
        override suspend fun createSpaceInvite(spaceId: String, role: String, maxUses: Int, expiresInHours: Int): SpaceInvite = throw UnsupportedOperationException()
        override suspend fun revokeSpaceInvite(spaceId: String, inviteId: String) = Unit
        override suspend fun listPersonalInvites(): PersonalInvitesResponse = PersonalInvitesResponse()
        override suspend fun createPersonalInvite(expiresInHours: Int): CreatedInvite = throw UnsupportedOperationException()
        override suspend fun revokePersonalInvite(id: String) = Unit
        override suspend fun listSessions(): List<BrowserSessionInfo> = emptyList()
        override suspend fun revokeSession(id: String) = Unit
        override suspend fun revokeOtherSessions(): Int = 0
        override suspend fun listTokens(): List<AccessTokenInfo> = emptyList()
        override suspend fun createToken(name: String, scopes: List<String>, expiresInDays: Int?): CreatedAccessToken = throw UnsupportedOperationException()
        override suspend fun updateToken(id: String, name: String) = Unit
        override suspend fun revokeToken(id: String, purge: Boolean) = Unit
        override suspend fun lookupDeviceCode(userCode: String, verificationId: String?): DeviceCodeLookup = throw UnsupportedOperationException()
        override suspend fun approveDeviceCode(userCode: String, verificationId: String?) = Unit
        override suspend fun denyDeviceCode(userCode: String, verificationId: String?) = Unit
        override suspend fun changePassword(currentPassword: String?, newPassword: String): ChangePasswordResult = ChangePasswordResult()
        override suspend fun listIdentities(): IdentitiesResponse = IdentitiesResponse()
        override suspend fun unlinkIdentity(provider: String) = Unit
        override suspend fun startAppOAuthLink(provider: String): PendingOAuthLink = throw UnsupportedOperationException()
        override suspend fun listUsers(): List<AdminUser> = emptyList()
        override suspend fun createUser(email: String, name: String?, role: String, quotaBytes: Long?, temporaryPassword: Boolean): AdminUser = throw UnsupportedOperationException()
        override suspend fun updateUser(userId: String, name: OptionalField<String>, role: OptionalField<String>, disabled: OptionalField<Boolean>, quotaBytes: OptionalField<Long?>, inviteLimit: OptionalField<Int?>) = Unit
        override suspend fun resetUserPassword(userId: String): ResetUserPasswordResult = throw UnsupportedOperationException()
        override suspend fun logoutUser(userId: String) = Unit
        override suspend fun listAdminInvites(): List<AdminInvite> = emptyList()
        override suspend fun createAdminInvite(kind: String, spaceId: String?, maxUses: Int, expiresInHours: Int?): CreatedInvite = throw UnsupportedOperationException()
        override suspend fun revokeAdminInvite(inviteId: String) = Unit
        override suspend fun getRegistrationPolicy(): RegistrationPolicyInfo = RegistrationPolicyInfo("invite")
        override suspend fun updateRegistrationPolicy(policy: String): RegistrationPolicyInfo = RegistrationPolicyInfo(policy)
        override suspend fun getLimits(): Map<String, LimitField> = emptyMap()
        override suspend fun updateLimits(patch: Map<String, Long?>): Map<String, LimitField> = emptyMap()
        override suspend fun getLimitsAudit(limit: Int?, cursor: Long?): LimitAuditPage = LimitAuditPage()
        override suspend fun listAdminRooms(): List<AdminRoom> = emptyList()
        override suspend fun unlockRoom(roomId: String) = Unit
        override suspend fun closeRoom(roomId: String) = Unit
        override suspend fun reopenRoom(roomId: String) = Unit
        override suspend fun deleteRoom(roomId: String) = Unit
        override suspend fun getSiteSettings(): SiteSettingsInfo = SiteSettingsInfo()
        override suspend fun updateSiteSettings(origin: String?, confirm: Boolean): SiteSettingsInfo = SiteSettingsInfo()
        override suspend fun getOAuthSettings(): OAuthSettingsInfo = OAuthSettingsInfo()
        override suspend fun updateOAuthProvider(provider: String, clientId: String, clientSecret: String?, enabled: Boolean): OAuthSettingsInfo = OAuthSettingsInfo()
        override suspend fun deleteOAuthProvider(provider: String): OAuthSettingsInfo = OAuthSettingsInfo()
        override suspend fun verifyOAuthProvider(provider: String): OAuthVerifyResult = OAuthVerifyResult(true, "CREDENTIALS_OK")
    }
}
