package dev.dropit.app.data.account

import dev.dropit.app.core.auth.AccountCapabilityState
import dev.dropit.app.core.auth.PendingOAuthLink
import dev.dropit.app.core.network.AccessTokenInfo
import dev.dropit.app.core.network.OptionalField
import kotlinx.coroutines.flow.StateFlow

/**
 * Full-featured account & admin settings repository for native Android Settings screens (Stage 8).
 *
 * - Account-scoped writes/reads require `account` scope; legacy device-code tokens receive
 *   `403 INSUFFICIENT_SCOPE` and transition [accountCapability] to
 *   [AccountCapabilityState.InsufficientScopeForAccountSettings].
 * - Admin routes require both `admin` scope and live database `role == "admin"`.
 */
interface AccountSettingsRepository {
    val accountCapability: StateFlow<AccountCapabilityState>

    // 1. Share presets (GET allows read Bearer; PUT requires account scope)
    suspend fun getSharePresets(): SharePresets
    suspend fun saveSharePresets(
        days: List<Int>,
        views: List<Int>,
        hours: List<Int> = emptyList(),
        months: List<Int> = emptyList(),
    ): SharePresets

    // 2. Managed shares center
    suspend fun listManagedShares(cursor: String? = null): ManagedSharesPage
    suspend fun getManagedShareLink(shareId: String): ManagedShareLink
    suspend fun revokeManagedShare(shareId: String)
    suspend fun deleteManagedShare(shareId: String)

    // 3. Space members & invites + personal invites
    suspend fun listSpaceMembers(spaceId: String): List<SpaceMember>
    suspend fun updateSpaceMemberRole(spaceId: String, userId: String, role: String): List<SpaceMember>
    suspend fun removeSpaceMember(spaceId: String, userId: String)
    suspend fun leaveSpace(spaceId: String)
    suspend fun listSpaceInvites(spaceId: String): SpaceInvitesResponse
    suspend fun createSpaceInvite(
        spaceId: String,
        role: String = "viewer",
        maxUses: Int = 1,
        expiresInHours: Int = 168,
    ): SpaceInvite

    suspend fun revokeSpaceInvite(spaceId: String, inviteId: String)
    suspend fun listPersonalInvites(): PersonalInvitesResponse
    suspend fun createPersonalInvite(expiresInHours: Int = 168): CreatedInvite
    suspend fun revokePersonalInvite(id: String)

    // 4. Browser sessions (devices)
    suspend fun listSessions(): List<BrowserSessionInfo>
    suspend fun revokeSession(id: String)
    suspend fun revokeOtherSessions(): Int

    // 5. Personal access tokens (PAT) & device code confirmation
    suspend fun listTokens(): List<AccessTokenInfo>
    suspend fun createToken(
        name: String,
        scopes: List<String> = listOf("read", "write"),
        expiresInDays: Int? = 90,
    ): CreatedAccessToken

    suspend fun updateToken(id: String, name: String)
    suspend fun revokeToken(id: String, purge: Boolean = false)
    suspend fun lookupDeviceCode(userCode: String, verificationId: String? = null): DeviceCodeLookup
    suspend fun approveDeviceCode(userCode: String, verificationId: String? = null)
    suspend fun denyDeviceCode(userCode: String, verificationId: String? = null)

    // 6. Password & OAuth identity linking
    suspend fun changePassword(currentPassword: String?, newPassword: String): ChangePasswordResult
    suspend fun listIdentities(): IdentitiesResponse
    suspend fun unlinkIdentity(provider: String)
    suspend fun startAppOAuthLink(provider: String): PendingOAuthLink

    // 7. Admin: users
    suspend fun listUsers(): List<AdminUser>
    suspend fun createUser(
        email: String,
        name: String? = null,
        role: String = "user",
        quotaBytes: Long? = null,
        temporaryPassword: Boolean = false,
    ): AdminUser

    suspend fun updateUser(
        userId: String,
        name: OptionalField<String> = OptionalField.Absent,
        role: OptionalField<String> = OptionalField.Absent,
        disabled: OptionalField<Boolean> = OptionalField.Absent,
        quotaBytes: OptionalField<Long?> = OptionalField.Absent,
        inviteLimit: OptionalField<Int?> = OptionalField.Absent,
    )

    suspend fun resetUserPassword(userId: String): ResetUserPasswordResult
    suspend fun logoutUser(userId: String)

    // 8. Admin: invites & registration policy
    suspend fun listAdminInvites(): List<AdminInvite>
    suspend fun createAdminInvite(
        kind: String = "registration",
        spaceId: String? = null,
        maxUses: Int = 1,
        expiresInHours: Int? = null,
    ): CreatedInvite

    suspend fun revokeAdminInvite(inviteId: String)
    suspend fun getRegistrationPolicy(): RegistrationPolicyInfo
    suspend fun updateRegistrationPolicy(policy: String): RegistrationPolicyInfo

    // 9. Admin: runtime limits & audit
    suspend fun getLimits(): Map<String, LimitField>
    suspend fun updateLimits(patch: Map<String, Long?>): Map<String, LimitField>
    suspend fun getLimitsAudit(limit: Int? = null, cursor: Long? = null): LimitAuditPage

    // 10. Admin: temporary rooms
    suspend fun listAdminRooms(): List<AdminRoom>
    suspend fun unlockRoom(roomId: String)
    suspend fun closeRoom(roomId: String)
    suspend fun reopenRoom(roomId: String)
    suspend fun deleteRoom(roomId: String)

    // 11. Admin: site origin & OAuth configuration
    suspend fun getSiteSettings(): SiteSettingsInfo
    suspend fun updateSiteSettings(origin: String?, confirm: Boolean = false): SiteSettingsInfo
    suspend fun getOAuthSettings(): OAuthSettingsInfo
    suspend fun updateOAuthProvider(
        provider: String,
        clientId: String,
        clientSecret: String? = null,
        enabled: Boolean = true,
    ): OAuthSettingsInfo

    suspend fun deleteOAuthProvider(provider: String): OAuthSettingsInfo
    suspend fun verifyOAuthProvider(provider: String): OAuthVerifyResult
}
