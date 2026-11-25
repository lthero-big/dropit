package dev.dropit.app.core.repository

import dev.dropit.app.core.network.OptionalField
import dev.dropit.app.core.network.RoomInfo
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Decoupling contract for temporary rooms (Stage 3A -> Stage 3B).
 */
interface RoomRepository {
    val activeRoom: StateFlow<RoomInfo?>

    suspend fun createOrReuseRoom(code: String? = null, pin: String? = null): RoomInfo
    suspend fun enterRoom(code: String, pin: String? = null): RoomInfo
    suspend fun updateRoomCode(
        roomToken: String,
        code: OptionalField<String?> = OptionalField.Absent,
        pin: OptionalField<String?> = OptionalField.Absent,
    ): RoomInfo

    suspend fun leaveCurrentRoom()
    suspend fun clearRoomState()
}

class PlaceholderRoomRepository : RoomRepository {
    private val _activeRoom = MutableStateFlow<RoomInfo?>(null)
    override val activeRoom: StateFlow<RoomInfo?> = _activeRoom.asStateFlow()

    override suspend fun createOrReuseRoom(code: String?, pin: String?): RoomInfo =
        throw UnsupportedOperationException("RoomRepository implementation pending Stage 3A")

    override suspend fun enterRoom(code: String, pin: String?): RoomInfo =
        throw UnsupportedOperationException("RoomRepository implementation pending Stage 3A")

    override suspend fun updateRoomCode(
        roomToken: String,
        code: OptionalField<String?>,
        pin: OptionalField<String?>,
    ): RoomInfo = throw UnsupportedOperationException("RoomRepository implementation pending Stage 3A")

    override suspend fun leaveCurrentRoom() {
        _activeRoom.value = null
    }

    override suspend fun clearRoomState() {
        _activeRoom.value = null
    }
}
