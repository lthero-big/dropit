package dev.dropit.app.data.account

import dev.dropit.app.core.network.AccessTokenInfo
import dev.dropit.app.core.network.ItemDevice
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

// ---------------------------------------------------------------------------
// Share presets (GET/PUT /api/me/share-presets)
// ---------------------------------------------------------------------------

@Serializable
data class SharePresets(
    val hours: List<Int> = emptyList(),
    val days: List<Int> = emptyList(),
    val months: List<Int> = emptyList(),
    val views: List<Int> = emptyList(),
)

// ---------------------------------------------------------------------------
// Managed shares (GET /api/shares, GET /api/shares/:id/link, revoke, delete)
// ---------------------------------------------------------------------------

@Serializable
data class ManagedShare(
    val id: String,
    val itemId: String,
    val expiresAt: Long? = null,
    val maxViews: Int? = null,
    val views: Int = 0,
    val revoked: Int = 0,
    val createdAt: Long = 0L,
    val state: String = "active",
    val copyStatus: String = "unavailable",
    val sourceKind: String? = null,
    val sourceName: String? = null,
    val spaceName: String? = null,
)

@Serializable
data class ManagedSharesPage(
    val shares: List<ManagedShare> = emptyList(),
    val nextCursor: String? = null,
)

@Serializable
data class ManagedShareLink(
    val url: String,
    val directUrl: String? = null,
)

// ---------------------------------------------------------------------------
// Space members & invites + personal invites
// ---------------------------------------------------------------------------

@Serializable
data class SpaceMember(
    val userId: String,
    val email: String,
    val name: String,
    val role: String,
)

@Serializable
internal data class SpaceMembersResponse(
    val members: List<SpaceMember> = emptyList(),
)

@Serializable
data class SpaceInvite(
    val id: String,
    val maxUses: Int = 1,
    val uses: Int = 0,
    val expiresAt: Long = 0L,
    val revoked: Int = 0,
    val createdAt: Long? = null,
    val role: String = "viewer",
    val status: String = "open",
    val token: String? = null,
    val url: String? = null,
)

@Serializable
data class SpaceInvitesResponse(
    val enabled: Boolean = true,
    val limit: Int? = null,
    val active: Int = 0,
    val remaining: Int? = null,
    val invites: List<SpaceInvite> = emptyList(),
)

@Serializable
data class PersonalInvite(
    val id: String,
    val maxUses: Int = 1,
    val uses: Int = 0,
    val expiresAt: Long = 0L,
    val revoked: Int = 0,
    val createdAt: Long? = null,
    val status: String = "open",
)

@Serializable
data class PersonalInvitesResponse(
    val enabled: Boolean = true,
    val adminOnly: Boolean = true,
    val limit: Int? = null,
    val registration: String = "invite",
    val invites: List<PersonalInvite> = emptyList(),
)

@Serializable
data class CreatedInvite(
    val id: String,
    val spaceId: String? = null,
    val maxUses: Int = 1,
    val uses: Int = 0,
    val expiresAt: Long = 0L,
    val revoked: Int = 0,
    val createdBy: String? = null,
    val joinSpace: Int? = null,
    val createdAt: Long? = null,
    val kind: String? = null,
    val token: String,
    val url: String,
)

// ---------------------------------------------------------------------------
// Browser sessions (GET /api/sessions, DELETE /api/sessions/:id, revoke-others)
// ---------------------------------------------------------------------------

@Serializable
data class BrowserSessionInfo(
    val id: String,
    val current: Boolean = false,
    val online: Boolean = false,
    val createdAt: Long? = null,
    val lastSeenAt: Long? = null,
    val expiresAt: Long = 0L,
    val ipSummary: String? = null,
    val browser: String = "",
    val os: String = "",
    val device: ItemDevice? = null,
)

@Serializable
internal data class BrowserSessionsResponse(
    val sessions: List<BrowserSessionInfo> = emptyList(),
)

@Serializable
internal data class RevokeOthersResponse(
    val revoked: Int = 0,
)

// ---------------------------------------------------------------------------
// Access tokens (PAT) & device code confirmation
// ---------------------------------------------------------------------------

@Serializable
internal data class AccessTokensResponse(
    val tokens: List<AccessTokenInfo> = emptyList(),
)

@Serializable
data class CreatedAccessToken(
    val id: String,
    val userId: String,
    val name: String,
    val scopes: List<String> = emptyList(),
    val createdAt: Long = 0L,
    val lastUsedAt: Long? = null,
    val expiresAt: Long? = null,
    val revoked: Int = 0,
    val token: String,
)

@Serializable
data class DeviceCodeLookup(
    val name: String,
    val ipSummary: String = "",
    val scopes: List<String> = emptyList(),
    val expiresAt: Long = 0L,
    val tokenExpiresInDays: Double? = null,
)

// ---------------------------------------------------------------------------
// Password & OAuth identities
// ---------------------------------------------------------------------------

@Serializable
data class ChangePasswordResult(
    val hasPassword: Boolean = true,
    val mustChangePassword: Boolean = false,
    val revokedSessions: Int = 0,
)

@Serializable
data class LinkedIdentityInfo(
    val provider: String,
    val email: String? = null,
    val linkedAt: Long? = null,
)

@Serializable
data class IdentitiesResponse(
    val identities: List<LinkedIdentityInfo> = emptyList(),
    val available: List<String> = emptyList(),
)

// ---------------------------------------------------------------------------
// Admin: Users
// ---------------------------------------------------------------------------

@Serializable
data class AdminUser(
    val id: String,
    val email: String,
    val name: String,
    val role: String = "user",
    val disabled: Int = 0,
    val pending: Int = 0,
    val createdAt: Long = 0L,
    val usedBytes: Long = 0L,
    val quotaBytes: Long = 0L,
    val quotaOverride: Long? = null,
    val inviteLimit: Int? = null,
    val inviteLimitEffective: Int? = null,
    val spaceInvitesEnabled: Boolean = true,
    val activeSpaceInvites: Int = 0,
    val hasPassword: Boolean = false,
    val mustChangePassword: Boolean = false,
    val providers: List<String> = emptyList(),
    val temporaryPassword: String? = null,
) {
    val isAdmin: Boolean get() = role == "admin"
    val isDisabled: Boolean get() = disabled != 0
    val isPending: Boolean get() = pending != 0
}

@Serializable
internal data class AdminUsersResponse(
    val users: List<AdminUser> = emptyList(),
)

@Serializable
data class ResetUserPasswordResult(
    val temporaryPassword: String,
    val mustChangePassword: Boolean = true,
)

// ---------------------------------------------------------------------------
// Admin: Invites & Registration policy
// ---------------------------------------------------------------------------

@Serializable
data class AdminInvite(
    val id: String,
    val spaceId: String = "",
    val maxUses: Int = 1,
    val uses: Int = 0,
    val expiresAt: Long = 0L,
    val revoked: Int = 0,
    val createdBy: String = "",
    val joinSpace: Int? = null,
    val createdAt: Long? = null,
    val role: String? = null,
    val createdByEmail: String? = null,
    val kind: String? = null,
    val creatorAdmin: Boolean = false,
    val status: String = "open",
)

@Serializable
internal data class AdminInvitesResponse(
    val invites: List<AdminInvite> = emptyList(),
)

@Serializable
data class RegistrationPolicyInfo(
    val policy: String,
    @SerialName("default") val defaultPolicy: String = "invite",
    val updatedAt: Long? = null,
    val updatedBy: String? = null,
)

// ---------------------------------------------------------------------------
// Admin: Runtime limits & audit
// ---------------------------------------------------------------------------

@Serializable
data class LimitField(
    val value: Long,
    @SerialName("default") val defaultValue: Long,
    val overridden: Boolean = false,
    val min: Long = 0L,
    val max: Long = Long.MAX_VALUE,
)

@Serializable
data class LimitAuditEntry(
    val id: Long,
    val actorId: String,
    val actorEmail: String,
    val createdAt: Long,
    val key: String,
    val oldValue: Long,
    val newValue: Long,
    val oldOverride: Long? = null,
    val newOverride: Long? = null,
)

@Serializable
data class LimitAuditPage(
    val entries: List<LimitAuditEntry> = emptyList(),
    val nextCursor: Long? = null,
)

// ---------------------------------------------------------------------------
// Admin: Temporary rooms
// ---------------------------------------------------------------------------

@Serializable
data class AdminRoom(
    val id: String,
    val code: String? = null,
    val owner: String? = null,
    val anonymous: Boolean = true,
    val createdAt: Long = 0L,
    val createdAtEstimated: Boolean = false,
    val lastActiveAt: Long? = null,
    val expiresAt: Long = 0L,
    val itemCount: Int = 0,
    val bytes: Long = 0L,
    val hasPin: Boolean = false,
    val closed: Boolean = false,
    val closedAt: Long? = null,
    val lockedFor: Int? = null,
)

@Serializable
internal data class AdminRoomsResponse(
    val rooms: List<AdminRoom> = emptyList(),
)

// ---------------------------------------------------------------------------
// Admin: Site settings & OAuth configuration
// ---------------------------------------------------------------------------

@Serializable
data class SiteOAuthCallback(
    val provider: String,
    val label: String,
    val url: String,
)

@Serializable
data class SiteSettingsInfo(
    val origin: String? = null,
    val source: String = "request",
    val adminOrigin: String? = null,
    val envOrigin: String? = null,
    val requestOrigin: String? = null,
    val effectiveOrigin: String = "",
    val production: Boolean = false,
    val secureCookies: Boolean = false,
    val trustProxy: Boolean = false,
    val updatedAt: Long? = null,
    val updatedBy: String? = null,
    val callbacks: List<SiteOAuthCallback> = emptyList(),
)

@Serializable
data class OAuthCheckInfo(
    val at: Long,
    val ok: Boolean,
    val code: String? = null,
)

@Serializable
data class OAuthProviderConfig(
    val provider: String,
    val label: String = "",
    val consoleUrl: String = "",
    val docsUrl: String = "",
    val callbackUrl: String = "",
    val homepageUrl: String = "",
    val source: String = "none",
    val enabled: Boolean = false,
    val active: Boolean = false,
    val clientId: String = "",
    val secretSet: Boolean = false,
    val secretHint: String? = null,
    val envConfigured: Boolean = false,
    val updatedAt: Long? = null,
    val check: OAuthCheckInfo? = null,
)

@Serializable
data class OAuthSettingsInfo(
    val origin: String = "",
    val providers: List<OAuthProviderConfig> = emptyList(),
)

@Serializable
data class OAuthVerifyResult(
    val ok: Boolean,
    val code: String,
    val checkedAt: Long = 0L,
    val source: String = "none",
    val origin: String = "",
    val providers: List<OAuthProviderConfig> = emptyList(),
)
