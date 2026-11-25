package dev.dropit.app.core.network

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.longOrNull

/**
 * Tri-state patch wrapper so PATCH requests can distinguish between omitting a field
 * and explicitly setting it to null (e.g. moving an item to ungrouped).
 */
sealed class OptionalField<out T> {
    data object Absent : OptionalField<Nothing>()
    data class Present<T>(val value: T) : OptionalField<T>()
}

/**
 * Identifies either a user/shared space or an active temporary room.
 * Both share identical item/group/upload/ws/share sub-paths on the dropit server.
 */
sealed class TargetScope {
    abstract val apiBasePath: String
    abstract val scopeType: String
    abstract val scopeId: String

    data class SpaceScope(val spaceId: String) : TargetScope() {
        override val apiBasePath: String
            get() = "/api/spaces/${ServerUrl.encodeURIComponent(spaceId)}"
        override val scopeType: String = "space"
        override val scopeId: String get() = spaceId
    }

    data class RoomScope(val roomToken: String) : TargetScope() {
        override val apiBasePath: String
            get() = "/api/rooms/${ServerUrl.encodeURIComponent(roomToken)}"
        override val scopeType: String = "room"
        override val scopeId: String get() = roomToken
    }
}

@Serializable
data class VersionInfo(
    val version: String,
    val commit: String? = null,
    val buildDate: String? = null,
    val install: String,
)

@Serializable
data class VerifiedServer(
    val serverOrigin: String,
    val versionInfo: VersionInfo,
)

@Serializable
data class User(
    val id: String,
    val email: String,
    val name: String,
    val role: String = "user",
    val disabled: Int = 0,
    val pending: Int = 0,
    val createdAt: Long = 0L,
) {
    val isAdmin: Boolean get() = role == "admin"
}

@Serializable
data class MeResponse(
    val user: User,
    val hasPassword: Boolean = false,
    val mustChangePassword: Boolean = false,
    val usedBytes: Long = 0L,
    val reservedBytes: Long = 0L,
    val quotaBytes: Long = 0L,
    val maxFileBytes: Long = 0L,
    val maxTextBytes: Long = 0L,
    val retentionMs: Long = 0L,
)

@Serializable
data class Space(
    val id: String,
    val name: String,
    val ownerId: String? = null,
    val expiresAt: Long? = null,
    val role: String = "owner",
    val ownerName: String? = null,
) {
    val isReadOnly: Boolean get() = role == "viewer"
    val canWrite: Boolean get() = role != "viewer"
    fun isPersonalFor(userId: String): Boolean = ownerId == userId && expiresAt == null
}

@Serializable
data class ScopeDetails(
    val id: String,
    val name: String,
    val expiresAt: Long? = null,
    val code: String? = null,
    val hasPin: Boolean = false,
    val url: String? = null,
    val maxFileBytes: Long = 0L,
    val quotaBytes: Long = 0L,
)

@Serializable
data class ItemDevice(
    val id: String,
    val name: String,
    val kind: String,
)

@Serializable
data class ClipItem(
    val id: String,
    val spaceId: String,
    val userId: String? = null,
    val kind: String,
    val text: String? = null,
    val filename: String? = null,
    val mime: String? = null,
    val size: Long = 0L,
    val createdAt: Long = 0L,
    val updatedAt: Long = 0L,
    val expiresAt: Long = 0L,
    val pinned: Boolean = false,
    val hasThumbnail: Boolean = false,
    val tags: List<String> = emptyList(),
    val group: String? = null,
    val device: ItemDevice? = null,
) {
    val isText: Boolean get() = kind == "text"
    val isFile: Boolean get() = kind == "file"
}

@Serializable
data class GroupInfo(
    val name: String,
    val itemCount: Int = 0,
)

@Serializable
data class UploadSession(
    val uploadId: String = "",
    val size: Long = 0L,
    val chunkSize: Int,
    val expiresAt: Long,
    val received: List<Int> = emptyList(),
)

@Serializable
data class RoomInfo(
    val token: String = "",
    val code: String? = null,
    val hasPin: Boolean = false,
    val expiresAt: Long = 0L,
    val url: String = "",
    val reused: Boolean = false,
)

@Serializable
data class ItemShare(
    val id: String,
    val itemId: String,
    val expiresAt: Long? = null,
    val maxViews: Int? = null,
    val views: Int = 0,
    val revoked: Int = 0,
    val createdAt: Long = 0L,
    val token: String? = null,
    val url: String? = null,
    val directUrl: String? = null,
)

@Serializable
data class AppUpdateManifest(
    val versionCode: Int,
    val versionName: String,
    val notes: String = "",
    val size: Long,
    val sha256: String,
    val publishedAt: String? = null,
    val url: String,
)

sealed class WsEvent {
    data class Snapshot(
        val items: List<ClipItem>,
        val groups: List<String>,
        val serverTime: Long,
        val expiresAt: Long?,
    ) : WsEvent()

    data class ItemCreated(val item: ClipItem) : WsEvent()
    data class ItemUpdated(val item: ClipItem) : WsEvent()
    data class ItemDeleted(val id: String) : WsEvent()
    data class GroupsUpdated(val groups: List<String>) : WsEvent()
    data class Presence(
        val devices: Int,
        val peers: List<ItemDevice> = emptyList(),
        val others: Int = 0,
    ) : WsEvent()

    data class Unknown(val type: String, val raw: String) : WsEvent()
}

object WsEventParser {
    private val defaultJson = Json { ignoreUnknownKeys = true; isLenient = true }

    fun parse(raw: String, json: Json = defaultJson): WsEvent {
        val obj = runCatching { json.parseToJsonElement(raw) as? JsonObject }.getOrNull()
            ?: return WsEvent.Unknown("invalid", raw)
        val type = (obj["type"] as? JsonPrimitive)?.contentOrNull.orEmpty()
        return try {
            when (type) {
                "snapshot" -> {
                    val items = obj["items"]?.let { json.decodeFromJsonElement<List<ClipItem>>(it) }.orEmpty()
                    val groups = obj["groups"]?.let { json.decodeFromJsonElement<List<String>>(it) }.orEmpty()
                    val serverTime = (obj["serverTime"] as? JsonPrimitive)?.longOrNull ?: 0L
                    val expiresAt = (obj["expiresAt"] as? JsonPrimitive)?.longOrNull
                    WsEvent.Snapshot(items = items, groups = groups, serverTime = serverTime, expiresAt = expiresAt)
                }
                "item.created" -> {
                    val itemElem = obj["item"] ?: return WsEvent.Unknown(type, raw)
                    WsEvent.ItemCreated(json.decodeFromJsonElement(itemElem))
                }
                "item.updated" -> {
                    val itemElem = obj["item"] ?: return WsEvent.Unknown(type, raw)
                    WsEvent.ItemUpdated(json.decodeFromJsonElement(itemElem))
                }
                "item.deleted" -> {
                    val id = (obj["id"] as? JsonPrimitive)?.contentOrNull ?: return WsEvent.Unknown(type, raw)
                    WsEvent.ItemDeleted(id)
                }
                "groups" -> {
                    val groups = obj["groups"]?.let { json.decodeFromJsonElement<List<String>>(it) }.orEmpty()
                    WsEvent.GroupsUpdated(groups)
                }
                "presence" -> {
                    val devices = (obj["devices"] as? JsonPrimitive)?.intOrNull ?: 0
                    val peersElem = obj["peers"]
                    val peers = if (peersElem is JsonArray) {
                        json.decodeFromJsonElement<List<ItemDevice>>(peersElem)
                    } else {
                        emptyList()
                    }
                    val others = (obj["others"] as? JsonPrimitive)?.intOrNull ?: 0
                    WsEvent.Presence(devices = devices, peers = peers, others = others)
                }
                else -> WsEvent.Unknown(type, raw)
            }
        } catch (_: Exception) {
            WsEvent.Unknown(type, raw)
        }
    }
}

// Internal / wire DTOs

@Serializable
internal data class SpacesResponse(val spaces: List<Space> = emptyList())

@Serializable
internal data class ItemResponse(val item: ClipItem)

@Serializable
internal data class GroupsResponse(val groups: List<String> = emptyList())

@Serializable
internal data class SharesResponse(val shares: List<ItemShare> = emptyList())

@Serializable
internal data class CreateTextRequest(
    val text: String,
    val group: String? = null,
)

@Serializable
internal data class EditTextRequest(
    val text: String,
)

@Serializable
internal data class GroupNameRequest(
    val name: String,
)

@Serializable
data class DeviceAuthorizeRequest(
    val name: String,
    val scopes: List<String>,
    val expiresInDays: Int? = 365,
)

@Serializable
data class DeviceAuthorizeResponse(
    @SerialName("device_code") val deviceCode: String,
    @SerialName("user_code") val userCode: String,
    @SerialName("verification_uri") val verificationUri: String,
    @SerialName("verification_id") val verificationId: String? = null,
    @SerialName("verification_uri_complete") val verificationUriComplete: String,
    @SerialName("expires_in") val expiresIn: Int = 600,
    val interval: Int = 5,
)

@Serializable
data class DeviceTokenRequest(
    @SerialName("device_code") val deviceCode: String,
)

@Serializable
data class AccessTokenInfo(
    val id: String,
    val userId: String,
    val name: String,
    val scopes: List<String> = emptyList(),
    val createdAt: Long = 0L,
    val lastUsedAt: Long? = null,
    val expiresAt: Long? = null,
    val revoked: Int = 0,
)

@Serializable
data class DeviceTokenResponse(
    @SerialName("access_token") val accessToken: String,
    @SerialName("token_type") val tokenType: String = "Bearer",
    val scope: String = "",
    @SerialName("expires_in") val expiresIn: Long? = null,
    val token: AccessTokenInfo? = null,
)

data class RawHttpResponse(
    val statusCode: Int,
    val body: String,
    val retryAfterHeader: String? = null,
)
