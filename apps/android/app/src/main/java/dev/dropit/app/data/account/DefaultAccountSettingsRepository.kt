package dev.dropit.app.data.account

import dev.dropit.app.core.auth.AccountCapabilityState
import dev.dropit.app.core.auth.AuthRepository
import dev.dropit.app.core.auth.PendingOAuthLink
import dev.dropit.app.core.network.AccessTokenInfo
import dev.dropit.app.core.network.ApiError
import dev.dropit.app.core.network.ApiErrorCode
import dev.dropit.app.core.network.DropitApiClient
import dev.dropit.app.core.network.OptionalField
import dev.dropit.app.core.network.ServerUrl
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

class DefaultAccountSettingsRepository(
    private val apiClient: DropitApiClient,
    private val authRepository: AuthRepository,
) : AccountSettingsRepository {

    override val accountCapability: StateFlow<AccountCapabilityState>
        get() = authRepository.accountCapability

    // -----------------------------------------------------------------------
    // 1. Share presets
    // -----------------------------------------------------------------------

    override suspend fun getSharePresets(): SharePresets {
        val request = apiClient.buildApiRequest(path = "/api/me/share-presets", method = "GET")
        return apiClient.executeJson(request, authenticated = true, deserializer = SharePresets.serializer())
    }

    override suspend fun saveSharePresets(
        days: List<Int>,
        views: List<Int>,
        hours: List<Int>,
        months: List<Int>,
    ): SharePresets = guardAccountScope {
        val payload = buildJsonObject {
            put("hours", JsonArray(hours.map { JsonPrimitive(it) }))
            put("days", JsonArray(days.map { JsonPrimitive(it) }))
            put("months", JsonArray(months.map { JsonPrimitive(it) }))
            put("views", JsonArray(views.map { JsonPrimitive(it) }))
        }
        val request = apiClient.buildApiRequest(
            path = "/api/me/share-presets",
            method = "PUT",
            jsonBody = encodeObject(payload),
        )
        apiClient.executeJson(request, authenticated = true, deserializer = SharePresets.serializer())
    }

    // -----------------------------------------------------------------------
    // 2. Managed shares center
    // -----------------------------------------------------------------------

    override suspend fun listManagedShares(cursor: String?): ManagedSharesPage = guardAccountScope {
        val cleanCursor = cursor?.trim()?.takeIf { it.isNotEmpty() }
        val path = if (cleanCursor != null) {
            "/api/shares?cursor=${ServerUrl.encodeURIComponent(cleanCursor)}"
        } else {
            "/api/shares"
        }
        val request = apiClient.buildApiRequest(path = path, method = "GET")
        apiClient.executeJson(request, authenticated = true, deserializer = ManagedSharesPage.serializer())
    }

    override suspend fun getManagedShareLink(shareId: String): ManagedShareLink = guardAccountScope {
        val cleanId = requireNonBlank(shareId, "分享 ID 不能为空")
        val path = "/api/shares/${ServerUrl.encodeURIComponent(cleanId)}/link"
        val request = apiClient.buildApiRequest(path = path, method = "GET")
        val origin = apiClient.originOf(request.url)
        val link = apiClient.executeJson(request, authenticated = true, deserializer = ManagedShareLink.serializer())
        link.copy(
            url = resolveAbsoluteUrl(origin, link.url) ?: link.url,
            directUrl = link.directUrl?.let { resolveAbsoluteUrl(origin, it) ?: it },
        )
    }

    override suspend fun revokeManagedShare(shareId: String) = guardAccountScope {
        val cleanId = requireNonBlank(shareId, "分享 ID 不能为空")
        val path = "/api/shares/${ServerUrl.encodeURIComponent(cleanId)}/revoke"
        val request = apiClient.buildApiRequest(path = path, method = "POST")
        apiClient.executeNoContent(request, authenticated = true)
    }

    override suspend fun deleteManagedShare(shareId: String) = guardAccountScope {
        val cleanId = requireNonBlank(shareId, "分享 ID 不能为空")
        val path = "/api/shares/${ServerUrl.encodeURIComponent(cleanId)}"
        val request = apiClient.buildApiRequest(path = path, method = "DELETE")
        apiClient.executeNoContent(request, authenticated = true)
    }

    // -----------------------------------------------------------------------
    // 3. Space members & invites + personal invites
    // -----------------------------------------------------------------------

    override suspend fun listSpaceMembers(spaceId: String): List<SpaceMember> {
        val cleanSpaceId = requireNonBlank(spaceId, "空间 ID 不能为空")
        val path = "/api/spaces/${ServerUrl.encodeURIComponent(cleanSpaceId)}/members"
        val request = apiClient.buildApiRequest(path = path, method = "GET")
        return apiClient.executeJson(request, authenticated = true, deserializer = SpaceMembersResponse.serializer()).members
    }

    override suspend fun updateSpaceMemberRole(
        spaceId: String,
        userId: String,
        role: String,
    ): List<SpaceMember> {
        val cleanSpaceId = requireNonBlank(spaceId, "空间 ID 不能为空")
        val cleanUserId = requireNonBlank(userId, "成员 ID 不能为空")
        val cleanRole = requireNonBlank(role, "成员角色不能为空")
        val path = "/api/spaces/${ServerUrl.encodeURIComponent(cleanSpaceId)}/members/${ServerUrl.encodeURIComponent(cleanUserId)}"
        val payload = buildJsonObject {
            put("role", JsonPrimitive(cleanRole))
        }
        val request = apiClient.buildApiRequest(path = path, method = "PATCH", jsonBody = encodeObject(payload))
        return apiClient.executeJson(request, authenticated = true, deserializer = SpaceMembersResponse.serializer()).members
    }

    override suspend fun removeSpaceMember(spaceId: String, userId: String) {
        val cleanSpaceId = requireNonBlank(spaceId, "空间 ID 不能为空")
        val cleanUserId = requireNonBlank(userId, "成员 ID 不能为空")
        val path = "/api/spaces/${ServerUrl.encodeURIComponent(cleanSpaceId)}/members/${ServerUrl.encodeURIComponent(cleanUserId)}"
        val request = apiClient.buildApiRequest(path = path, method = "DELETE")
        apiClient.executeNoContent(request, authenticated = true)
    }

    override suspend fun leaveSpace(spaceId: String) {
        val cleanSpaceId = requireNonBlank(spaceId, "空间 ID 不能为空")
        val path = "/api/spaces/${ServerUrl.encodeURIComponent(cleanSpaceId)}/membership"
        val request = apiClient.buildApiRequest(path = path, method = "DELETE")
        apiClient.executeNoContent(request, authenticated = true)
    }

    override suspend fun listSpaceInvites(spaceId: String): SpaceInvitesResponse {
        val cleanSpaceId = requireNonBlank(spaceId, "空间 ID 不能为空")
        val path = "/api/spaces/${ServerUrl.encodeURIComponent(cleanSpaceId)}/invites"
        val request = apiClient.buildApiRequest(path = path, method = "GET")
        return apiClient.executeJson(request, authenticated = true, deserializer = SpaceInvitesResponse.serializer())
    }

    override suspend fun createSpaceInvite(
        spaceId: String,
        role: String,
        maxUses: Int,
        expiresInHours: Int,
    ): SpaceInvite {
        val cleanSpaceId = requireNonBlank(spaceId, "空间 ID 不能为空")
        val path = "/api/spaces/${ServerUrl.encodeURIComponent(cleanSpaceId)}/invites"
        val payload = buildJsonObject {
            put("role", JsonPrimitive(role))
            put("maxUses", JsonPrimitive(maxUses))
            put("expiresInHours", JsonPrimitive(expiresInHours))
        }
        val request = apiClient.buildApiRequest(path = path, method = "POST", jsonBody = encodeObject(payload))
        val origin = apiClient.originOf(request.url)
        val created = apiClient.executeJson(request, authenticated = true, deserializer = SpaceInvite.serializer())
        return created.copy(url = created.url?.let { resolveAbsoluteUrl(origin, it) ?: it })
    }

    override suspend fun revokeSpaceInvite(spaceId: String, inviteId: String) {
        val cleanSpaceId = requireNonBlank(spaceId, "空间 ID 不能为空")
        val cleanInviteId = requireNonBlank(inviteId, "邀请 ID 不能为空")
        val path = "/api/spaces/${ServerUrl.encodeURIComponent(cleanSpaceId)}/invites/${ServerUrl.encodeURIComponent(cleanInviteId)}"
        val request = apiClient.buildApiRequest(path = path, method = "DELETE")
        apiClient.executeNoContent(request, authenticated = true)
    }

    override suspend fun listPersonalInvites(): PersonalInvitesResponse = guardAdminScope {
        val request = apiClient.buildApiRequest(path = "/api/me/invites", method = "GET")
        apiClient.executeJson(request, authenticated = true, deserializer = PersonalInvitesResponse.serializer())
    }

    override suspend fun createPersonalInvite(expiresInHours: Int): CreatedInvite = guardAdminScope {
        val payload = buildJsonObject {
            put("expiresInHours", JsonPrimitive(expiresInHours))
        }
        val request = apiClient.buildApiRequest(
            path = "/api/me/invites",
            method = "POST",
            jsonBody = encodeObject(payload),
        )
        val origin = apiClient.originOf(request.url)
        val created = apiClient.executeJson(request, authenticated = true, deserializer = CreatedInvite.serializer())
        created.copy(url = resolveAbsoluteUrl(origin, created.url) ?: created.url)
    }

    override suspend fun revokePersonalInvite(id: String) = guardAdminScope {
        val cleanId = requireNonBlank(id, "邀请 ID 不能为空")
        val path = "/api/me/invites/${ServerUrl.encodeURIComponent(cleanId)}"
        val request = apiClient.buildApiRequest(path = path, method = "DELETE")
        apiClient.executeNoContent(request, authenticated = true)
    }

    // -----------------------------------------------------------------------
    // 4. Browser sessions (devices)
    // -----------------------------------------------------------------------

    override suspend fun listSessions(): List<BrowserSessionInfo> = guardAccountScope {
        val request = apiClient.buildApiRequest(path = "/api/sessions", method = "GET")
        apiClient.executeJson(request, authenticated = true, deserializer = BrowserSessionsResponse.serializer()).sessions
    }

    override suspend fun revokeSession(id: String) = guardAccountScope {
        val cleanId = requireNonBlank(id, "会话 ID 不能为空")
        val path = "/api/sessions/${ServerUrl.encodeURIComponent(cleanId)}"
        val request = apiClient.buildApiRequest(path = path, method = "DELETE")
        apiClient.executeNoContent(request, authenticated = true)
    }

    override suspend fun revokeOtherSessions(): Int = guardAccountScope {
        val request = apiClient.buildApiRequest(path = "/api/sessions/revoke-others", method = "POST")
        apiClient.executeJson(request, authenticated = true, deserializer = RevokeOthersResponse.serializer()).revoked
    }

    // -----------------------------------------------------------------------
    // 5. Personal access tokens & device code confirmation
    // -----------------------------------------------------------------------

    override suspend fun listTokens(): List<AccessTokenInfo> {
        val request = apiClient.buildApiRequest(path = "/api/tokens", method = "GET")
        return apiClient.executeJson(request, authenticated = true, deserializer = AccessTokensResponse.serializer()).tokens
    }

    override suspend fun createToken(
        name: String,
        scopes: List<String>,
        expiresInDays: Int?,
    ): CreatedAccessToken = guardAccountScope {
        val cleanName = requireNonBlank(name, "令牌名称不能为空")
        val payload = buildJsonObject {
            put("name", JsonPrimitive(cleanName))
            put("scopes", JsonArray(scopes.map { JsonPrimitive(it) }))
            // Explicit null tells the server "never expires" instead of defaulting to 90 days.
            put("expiresInDays", expiresInDays?.let { JsonPrimitive(it) } ?: JsonNull)
        }
        val request = apiClient.buildApiRequest(
            path = "/api/tokens",
            method = "POST",
            jsonBody = encodeObject(payload),
        )
        apiClient.executeJson(request, authenticated = true, deserializer = CreatedAccessToken.serializer())
    }

    override suspend fun updateToken(id: String, name: String) = guardAccountScope {
        val cleanId = requireNonBlank(id, "令牌 ID 不能为空")
        val cleanName = requireNonBlank(name, "令牌名称不能为空")
        val path = "/api/tokens/${ServerUrl.encodeURIComponent(cleanId)}"
        val payload = buildJsonObject {
            put("name", JsonPrimitive(cleanName))
        }
        val request = apiClient.buildApiRequest(path = path, method = "PATCH", jsonBody = encodeObject(payload))
        apiClient.executeNoContent(request, authenticated = true)
    }

    override suspend fun revokeToken(id: String, purge: Boolean) {
        val cleanId = requireNonBlank(id, "令牌 ID 不能为空")
        val basePath = "/api/tokens/${ServerUrl.encodeURIComponent(cleanId)}"
        val path = if (purge) "$basePath?purge=1" else basePath
        if (purge) {
            guardAccountScope {
                val request = apiClient.buildApiRequest(path = path, method = "DELETE")
                apiClient.executeNoContent(request, authenticated = true)
            }
        } else {
            val request = apiClient.buildApiRequest(path = path, method = "DELETE")
            apiClient.executeNoContent(request, authenticated = true)
        }
    }

    override suspend fun lookupDeviceCode(
        userCode: String,
        verificationId: String?,
    ): DeviceCodeLookup = guardAccountScope {
        val cleanCode = requireNonBlank(userCode, "设备确认码不能为空")
        val query = buildString {
            append("user_code=")
            append(ServerUrl.encodeURIComponent(cleanCode))
            verificationId?.trim()?.takeIf { it.isNotEmpty() }?.let {
                append("&verification_id=")
                append(ServerUrl.encodeURIComponent(it))
            }
        }
        val request = apiClient.buildApiRequest(path = "/api/auth/device?$query", method = "GET")
        apiClient.executeJson(request, authenticated = true, deserializer = DeviceCodeLookup.serializer())
    }

    override suspend fun approveDeviceCode(userCode: String, verificationId: String?) =
        decideDeviceCode("approve", userCode, verificationId)

    override suspend fun denyDeviceCode(userCode: String, verificationId: String?) =
        decideDeviceCode("deny", userCode, verificationId)

    private suspend fun decideDeviceCode(decision: String, userCode: String, verificationId: String?) =
        guardAccountScope {
            val cleanCode = requireNonBlank(userCode, "设备确认码不能为空")
            val payload = buildJsonObject {
                put("user_code", JsonPrimitive(cleanCode))
                verificationId?.trim()?.takeIf { it.isNotEmpty() }?.let {
                    put("verification_id", JsonPrimitive(it))
                }
            }
            val request = apiClient.buildApiRequest(
                path = "/api/auth/device/$decision",
                method = "POST",
                jsonBody = encodeObject(payload),
            )
            apiClient.executeNoContent(request, authenticated = true)
        }

    // -----------------------------------------------------------------------
    // 6. Password & OAuth identities
    // -----------------------------------------------------------------------

    override suspend fun changePassword(
        currentPassword: String?,
        newPassword: String,
    ): ChangePasswordResult = guardAccountScope {
        if (newPassword.isEmpty()) {
            throw invalidInput("新密码不能为空")
        }
        val payload = buildJsonObject {
            if (!currentPassword.isNullOrEmpty()) {
                put("currentPassword", JsonPrimitive(currentPassword))
            }
            put("newPassword", JsonPrimitive(newPassword))
        }
        val request = apiClient.buildApiRequest(
            path = "/api/me/password",
            method = "PUT",
            jsonBody = encodeObject(payload),
        )
        val result = apiClient.executeJson(request, authenticated = true, deserializer = ChangePasswordResult.serializer())
        if (!result.mustChangePassword) {
            authRepository.markPasswordChanged()
        }
        result
    }

    override suspend fun listIdentities(): IdentitiesResponse = guardAccountScope {
        val request = apiClient.buildApiRequest(path = "/api/me/identities", method = "GET")
        apiClient.executeJson(request, authenticated = true, deserializer = IdentitiesResponse.serializer())
    }

    override suspend fun unlinkIdentity(provider: String) = guardAccountScope {
        val cleanProvider = requireNonBlank(provider, "登录方式不能为空").lowercase()
        val path = "/api/me/identities/${ServerUrl.encodeURIComponent(cleanProvider)}"
        val request = apiClient.buildApiRequest(path = path, method = "DELETE")
        apiClient.executeNoContent(request, authenticated = true)
    }

    override suspend fun startAppOAuthLink(provider: String): PendingOAuthLink =
        authRepository.startAppOAuthLink(provider)

    // -----------------------------------------------------------------------
    // 7. Admin: users
    // -----------------------------------------------------------------------

    override suspend fun listUsers(): List<AdminUser> = guardAdminScope {
        val request = apiClient.buildApiRequest(path = "/api/admin/users", method = "GET")
        apiClient.executeJson(request, authenticated = true, deserializer = AdminUsersResponse.serializer()).users
    }

    override suspend fun createUser(
        email: String,
        name: String?,
        role: String,
        quotaBytes: Long?,
        temporaryPassword: Boolean,
    ): AdminUser = guardAdminScope {
        val cleanEmail = requireNonBlank(email, "邮箱不能为空")
        val payload = buildJsonObject {
            put("email", JsonPrimitive(cleanEmail))
            name?.trim()?.takeIf { it.isNotEmpty() }?.let { put("name", JsonPrimitive(it)) }
            put("role", JsonPrimitive(role))
            if (quotaBytes != null) put("quotaBytes", JsonPrimitive(quotaBytes))
            if (temporaryPassword) put("temporaryPassword", JsonPrimitive(true))
        }
        val request = apiClient.buildApiRequest(
            path = "/api/admin/users",
            method = "POST",
            jsonBody = encodeObject(payload),
        )
        apiClient.executeJson(request, authenticated = true, deserializer = AdminUser.serializer())
    }

    override suspend fun updateUser(
        userId: String,
        name: OptionalField<String>,
        role: OptionalField<String>,
        disabled: OptionalField<Boolean>,
        quotaBytes: OptionalField<Long?>,
        inviteLimit: OptionalField<Int?>,
    ) = guardAdminScope {
        val cleanUserId = requireNonBlank(userId, "用户 ID 不能为空")
        val payload = buildJsonObject {
            if (name is OptionalField.Present) put("name", JsonPrimitive(name.value))
            if (role is OptionalField.Present) put("role", JsonPrimitive(role.value))
            if (disabled is OptionalField.Present) put("disabled", JsonPrimitive(disabled.value))
            if (quotaBytes is OptionalField.Present) {
                put("quotaBytes", quotaBytes.value?.let { JsonPrimitive(it) } ?: JsonNull)
            }
            if (inviteLimit is OptionalField.Present) {
                put("inviteLimit", inviteLimit.value?.let { JsonPrimitive(it) } ?: JsonNull)
            }
        }
        if (payload.isEmpty()) {
            throw invalidInput("未提供需要更新的字段")
        }
        val path = "/api/admin/users/${ServerUrl.encodeURIComponent(cleanUserId)}"
        val request = apiClient.buildApiRequest(path = path, method = "PATCH", jsonBody = encodeObject(payload))
        apiClient.executeNoContent(request, authenticated = true)
    }

    override suspend fun resetUserPassword(userId: String): ResetUserPasswordResult = guardAdminScope {
        val cleanUserId = requireNonBlank(userId, "用户 ID 不能为空")
        val path = "/api/admin/users/${ServerUrl.encodeURIComponent(cleanUserId)}/password"
        val request = apiClient.buildApiRequest(path = path, method = "POST")
        apiClient.executeJson(request, authenticated = true, deserializer = ResetUserPasswordResult.serializer())
    }

    override suspend fun logoutUser(userId: String) = guardAdminScope {
        val cleanUserId = requireNonBlank(userId, "用户 ID 不能为空")
        val path = "/api/admin/users/${ServerUrl.encodeURIComponent(cleanUserId)}/logout"
        val request = apiClient.buildApiRequest(path = path, method = "POST")
        apiClient.executeNoContent(request, authenticated = true)
    }

    // -----------------------------------------------------------------------
    // 8. Admin: invites & registration policy
    // -----------------------------------------------------------------------

    override suspend fun listAdminInvites(): List<AdminInvite> = guardAdminScope {
        val request = apiClient.buildApiRequest(path = "/api/admin/invites", method = "GET")
        apiClient.executeJson(request, authenticated = true, deserializer = AdminInvitesResponse.serializer()).invites
    }

    override suspend fun createAdminInvite(
        kind: String,
        spaceId: String?,
        maxUses: Int,
        expiresInHours: Int?,
    ): CreatedInvite = guardAdminScope {
        val payload = buildJsonObject {
            put("kind", JsonPrimitive(kind))
            if (kind == "space") {
                val cleanSpaceId = requireNonBlank(spaceId.orEmpty(), "空间 ID 不能为空")
                put("spaceId", JsonPrimitive(cleanSpaceId))
            }
            put("maxUses", JsonPrimitive(maxUses))
            if (expiresInHours != null) {
                put("expiresInHours", JsonPrimitive(expiresInHours))
            }
        }
        val request = apiClient.buildApiRequest(
            path = "/api/admin/invites",
            method = "POST",
            jsonBody = encodeObject(payload),
        )
        val origin = apiClient.originOf(request.url)
        val created = apiClient.executeJson(request, authenticated = true, deserializer = CreatedInvite.serializer())
        created.copy(url = resolveAbsoluteUrl(origin, created.url) ?: created.url)
    }

    override suspend fun revokeAdminInvite(inviteId: String) = guardAdminScope {
        val cleanId = requireNonBlank(inviteId, "邀请 ID 不能为空")
        val path = "/api/admin/invites/${ServerUrl.encodeURIComponent(cleanId)}"
        val request = apiClient.buildApiRequest(path = path, method = "DELETE")
        apiClient.executeNoContent(request, authenticated = true)
    }

    override suspend fun getRegistrationPolicy(): RegistrationPolicyInfo = guardAdminScope {
        val request = apiClient.buildApiRequest(path = "/api/admin/registration", method = "GET")
        apiClient.executeJson(request, authenticated = true, deserializer = RegistrationPolicyInfo.serializer())
    }

    override suspend fun updateRegistrationPolicy(policy: String): RegistrationPolicyInfo = guardAdminScope {
        val cleanPolicy = requireNonBlank(policy, "注册策略不能为空")
        val payload = buildJsonObject {
            put("policy", JsonPrimitive(cleanPolicy))
        }
        val request = apiClient.buildApiRequest(
            path = "/api/admin/registration",
            method = "PUT",
            jsonBody = encodeObject(payload),
        )
        apiClient.executeJson(request, authenticated = true, deserializer = RegistrationPolicyInfo.serializer())
    }

    // -----------------------------------------------------------------------
    // 9. Admin: runtime limits & audit
    // -----------------------------------------------------------------------

    override suspend fun getLimits(): Map<String, LimitField> = guardAdminScope {
        val request = apiClient.buildApiRequest(path = "/api/admin/limits", method = "GET")
        apiClient.executeJson(request, authenticated = true, deserializer = LIMITS_MAP_SERIALIZER)
    }

    override suspend fun updateLimits(patch: Map<String, Long?>): Map<String, LimitField> = guardAdminScope {
        if (patch.isEmpty()) {
            throw invalidInput("未提供需要更新的限制项")
        }
        val payload = buildJsonObject {
            for ((k, v) in patch) {
                put(k, v?.let { JsonPrimitive(it) } ?: JsonNull)
            }
        }
        val request = apiClient.buildApiRequest(
            path = "/api/admin/limits",
            method = "PATCH",
            jsonBody = encodeObject(payload),
        )
        apiClient.executeJson(request, authenticated = true, deserializer = LIMITS_MAP_SERIALIZER)
    }

    override suspend fun getLimitsAudit(limit: Int?, cursor: Long?): LimitAuditPage = guardAdminScope {
        val params = buildList {
            if (limit != null) add("limit=$limit")
            if (cursor != null) add("cursor=$cursor")
        }
        val path = if (params.isEmpty()) "/api/admin/limits/audit" else "/api/admin/limits/audit?${params.joinToString("&")}"
        val request = apiClient.buildApiRequest(path = path, method = "GET")
        apiClient.executeJson(request, authenticated = true, deserializer = LimitAuditPage.serializer())
    }

    // -----------------------------------------------------------------------
    // 10. Admin: temporary rooms
    // -----------------------------------------------------------------------

    override suspend fun listAdminRooms(): List<AdminRoom> = guardAdminScope {
        val request = apiClient.buildApiRequest(path = "/api/admin/rooms", method = "GET")
        apiClient.executeJson(request, authenticated = true, deserializer = AdminRoomsResponse.serializer()).rooms
    }

    override suspend fun unlockRoom(roomId: String) = guardAdminScope {
        val cleanId = requireNonBlank(roomId, "房间 ID 不能为空")
        val path = "/api/admin/rooms/${ServerUrl.encodeURIComponent(cleanId)}/unlock"
        val request = apiClient.buildApiRequest(path = path, method = "POST")
        apiClient.executeNoContent(request, authenticated = true)
    }

    override suspend fun closeRoom(roomId: String) = guardAdminScope {
        val cleanId = requireNonBlank(roomId, "房间 ID 不能为空")
        val path = "/api/admin/rooms/${ServerUrl.encodeURIComponent(cleanId)}/close"
        val request = apiClient.buildApiRequest(path = path, method = "POST")
        apiClient.executeNoContent(request, authenticated = true)
    }

    override suspend fun reopenRoom(roomId: String) = guardAdminScope {
        val cleanId = requireNonBlank(roomId, "房间 ID 不能为空")
        val path = "/api/admin/rooms/${ServerUrl.encodeURIComponent(cleanId)}/reopen"
        val request = apiClient.buildApiRequest(path = path, method = "POST")
        apiClient.executeNoContent(request, authenticated = true)
    }

    override suspend fun deleteRoom(roomId: String) = guardAdminScope {
        val cleanId = requireNonBlank(roomId, "房间 ID 不能为空")
        val path = "/api/admin/rooms/${ServerUrl.encodeURIComponent(cleanId)}"
        val request = apiClient.buildApiRequest(path = path, method = "DELETE")
        apiClient.executeNoContent(request, authenticated = true)
    }

    // -----------------------------------------------------------------------
    // 11. Admin: site origin & OAuth configuration
    // -----------------------------------------------------------------------

    override suspend fun getSiteSettings(): SiteSettingsInfo = guardAdminScope {
        val request = apiClient.buildApiRequest(path = "/api/admin/site", method = "GET")
        apiClient.executeJson(request, authenticated = true, deserializer = SiteSettingsInfo.serializer())
    }

    override suspend fun updateSiteSettings(origin: String?, confirm: Boolean): SiteSettingsInfo = guardAdminScope {
        val cleaned = origin?.trim()?.takeIf { it.isNotEmpty() }
        val payload = buildJsonObject {
            // Explicit null clears admin override and falls back to APP_ORIGIN / request origin.
            put("origin", cleaned?.let { JsonPrimitive(it) } ?: JsonNull)
            put("confirm", JsonPrimitive(confirm))
        }
        val request = apiClient.buildApiRequest(
            path = "/api/admin/site",
            method = "PUT",
            jsonBody = encodeObject(payload),
        )
        apiClient.executeJson(request, authenticated = true, deserializer = SiteSettingsInfo.serializer())
    }

    override suspend fun getOAuthSettings(): OAuthSettingsInfo = guardAdminScope {
        val request = apiClient.buildApiRequest(path = "/api/admin/oauth", method = "GET")
        apiClient.executeJson(request, authenticated = true, deserializer = OAuthSettingsInfo.serializer())
    }

    override suspend fun updateOAuthProvider(
        provider: String,
        clientId: String,
        clientSecret: String?,
        enabled: Boolean,
    ): OAuthSettingsInfo = guardAdminScope {
        val cleanProvider = requireNonBlank(provider, "OAuth 提供方不能为空").lowercase()
        val cleanClientId = requireNonBlank(clientId, "Client ID 不能为空")
        val payload = buildJsonObject {
            put("clientId", JsonPrimitive(cleanClientId))
            clientSecret?.trim()?.takeIf { it.isNotEmpty() }?.let {
                put("clientSecret", JsonPrimitive(it))
            }
            put("enabled", JsonPrimitive(enabled))
        }
        val path = "/api/admin/oauth/${ServerUrl.encodeURIComponent(cleanProvider)}"
        val request = apiClient.buildApiRequest(path = path, method = "PUT", jsonBody = encodeObject(payload))
        apiClient.executeJson(request, authenticated = true, deserializer = OAuthSettingsInfo.serializer())
    }

    override suspend fun deleteOAuthProvider(provider: String): OAuthSettingsInfo = guardAdminScope {
        val cleanProvider = requireNonBlank(provider, "OAuth 提供方不能为空").lowercase()
        val path = "/api/admin/oauth/${ServerUrl.encodeURIComponent(cleanProvider)}"
        val request = apiClient.buildApiRequest(path = path, method = "DELETE")
        apiClient.executeJson(request, authenticated = true, deserializer = OAuthSettingsInfo.serializer())
    }

    override suspend fun verifyOAuthProvider(provider: String): OAuthVerifyResult = guardAdminScope {
        val cleanProvider = requireNonBlank(provider, "OAuth 提供方不能为空").lowercase()
        val path = "/api/admin/oauth/${ServerUrl.encodeURIComponent(cleanProvider)}/verify"
        val request = apiClient.buildApiRequest(path = path, method = "POST")
        apiClient.executeJson(request, authenticated = true, deserializer = OAuthVerifyResult.serializer())
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    private suspend inline fun <T> guardAccountScope(block: () -> T): T = try {
        block()
    } catch (e: ApiError) {
        if (e.isInsufficientScope) {
            authRepository.reportInsufficientScope(AuthRepository.SCOPE_ACCOUNT)
        }
        throw e
    }

    private suspend inline fun <T> guardAdminScope(block: () -> T): T = try {
        block()
    } catch (e: ApiError) {
        if (e.isInsufficientScope) {
            authRepository.reportInsufficientScope(AuthRepository.SCOPE_ADMIN)
        }
        throw e
    }

    private fun encodeObject(obj: JsonObject): String =
        apiClient.json.encodeToString(JsonObject.serializer(), obj)

    private fun requireNonBlank(value: String, message: String): String {
        val trimmed = value.trim()
        if (trimmed.isEmpty()) throw invalidInput(message)
        return trimmed
    }

    private fun invalidInput(message: String): ApiError = ApiError(
        errorCode = ApiErrorCode.INVALID_INPUT,
        rawCode = "INVALID_INPUT",
        httpStatus = 400,
        userMessage = message,
    )

    private fun resolveAbsoluteUrl(origin: String, raw: String?): String? {
        val trimmed = raw?.trim().orEmpty()
        val cleanOrigin = origin.trimEnd('/')
        return when {
            trimmed.startsWith("https://", ignoreCase = true) ||
                trimmed.startsWith("http://", ignoreCase = true) -> trimmed
            trimmed.startsWith("/") && cleanOrigin.isNotEmpty() -> "$cleanOrigin$trimmed"
            trimmed.isNotEmpty() && cleanOrigin.isNotEmpty() -> "$cleanOrigin/$trimmed"
            else -> null
        }
    }

    companion object {
        private val LIMITS_MAP_SERIALIZER = MapSerializer(String.serializer(), LimitField.serializer())
    }
}
