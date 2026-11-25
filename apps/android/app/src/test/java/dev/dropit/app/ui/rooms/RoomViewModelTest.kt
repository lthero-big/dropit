package dev.dropit.app.ui.rooms

import dev.dropit.app.core.network.ApiError
import dev.dropit.app.core.network.ApiErrorCode
import dev.dropit.app.core.network.OptionalField
import dev.dropit.app.core.network.RoomInfo
import dev.dropit.app.core.repository.RoomRepository
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
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
class RoomViewModelTest {

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
    fun createAndUpdateRoomCodeAndPin_validatesAndPersistsChanges() = runTest(testDispatcher) {
        val repo = FakeRoomRepository()
        val vm = RoomViewModel(
            roomRepository = repo,
            serverOriginProvider = { "https://dropit.lthero.com/" },
            ioDispatcher = testDispatcher,
        )

        // Invalid custom code blocked client-side
        vm.createOrReuseRoom(customCode = "a!")
        assertNotNull(vm.uiState.value.errorMessage)
        assertNull(vm.uiState.value.activeRoom)

        // Valid creation sets owner = true
        var entered: RoomInfo? = null
        vm.createOrReuseRoom(customCode = "team_room", pin = "1234") { entered = it }
        advanceUntilIdle()

        assertNotNull(entered)
        assertTrue(vm.uiState.value.isOwner)
        assertEquals("team_room", vm.uiState.value.activeRoom?.code)
        assertTrue(vm.uiState.value.activeRoom?.hasPin == true)
        assertEquals("https://dropit.lthero.com/r/team_room", vm.shareUrlFor(entered!!))

        // Invalid 5-char change code rejected
        vm.updateCustomCode("Ab12C")
        assertTrue(vm.uiState.value.errorMessage!!.contains("还差 1 位"))

        // Valid 6-char change code succeeds
        vm.updateCustomCode("k7Rm2x")
        advanceUntilIdle()
        assertEquals("k7Rm2x", vm.uiState.value.activeRoom?.code)

        // Randomize code passes OptionalField.Present(null)
        vm.randomizeCode()
        advanceUntilIdle()
        assertEquals(OptionalField.Present(null), repo.lastCodeUpdate)
        assertEquals("Rnd999", vm.uiState.value.activeRoom?.code)

        // Remove PIN passes OptionalField.Present(null)
        vm.removePin()
        advanceUntilIdle()
        assertEquals(OptionalField.Present(null), repo.lastPinUpdate)
        assertFalse(vm.uiState.value.activeRoom?.hasPin == true)

        // Leave room clears activeRoom
        vm.leaveRoom()
        advanceUntilIdle()
        assertNull(vm.uiState.value.activeRoom)
        assertFalse(vm.uiState.value.isOwner)
    }

    @Test
    fun joinRoom_handlesPinRequiredPinInvalidRateLimitAndSuccessWithoutTriggering401Logout() = runTest(testDispatcher) {
        var sessionExpiredTriggered = 0
        val repo = FakeRoomRepository()
        val vm = RoomViewModel(
            roomRepository = repo,
            serverOriginProvider = { "https://dropit.lthero.com" },
            onSessionExpired = { sessionExpiredTriggered++ },
            ioDispatcher = testDispatcher,
        )

        // 1. Server returns 401 PIN_REQUIRED -> must reveal PIN field and NOT trigger session logout!
        repo.enterError = ApiError(
            errorCode = ApiErrorCode.PIN_REQUIRED,
            rawCode = "PIN_REQUIRED",
            httpStatus = 401,
            userMessage = ApiErrorCode.PIN_REQUIRED.defaultMessage,
        )
        vm.enterRoom("k7Rm2x", null)
        advanceUntilIdle()

        assertEquals(0, sessionExpiredTriggered)
        assertTrue(vm.uiState.value.requiresPinForJoin)
        assertTrue(vm.uiState.value.errorMessage!!.contains("PIN"))

        // 2. Wrong PIN -> 403 PIN_INVALID
        repo.enterError = ApiError(
            errorCode = ApiErrorCode.PIN_INVALID,
            rawCode = "PIN_INVALID",
            httpStatus = 403,
            userMessage = ApiErrorCode.PIN_INVALID.defaultMessage,
        )
        vm.enterRoom("k7Rm2x", "0000")
        advanceUntilIdle()

        assertTrue(vm.uiState.value.requiresPinForJoin)
        assertTrue(vm.uiState.value.errorMessage!!.contains("不正确"))

        // 3. Too many attempts -> 429 RATE_LIMITED with retry-after
        repo.enterError = ApiError(
            errorCode = ApiErrorCode.RATE_LIMITED,
            rawCode = "RATE_LIMITED",
            httpStatus = 429,
            userMessage = ApiErrorCode.RATE_LIMITED.defaultMessage,
            retryAfterSeconds = 45L,
        )
        vm.enterRoom("k7Rm2x", "0000")
        advanceUntilIdle()

        assertEquals(45L, vm.uiState.value.rateLimitRetryAfterSeconds)
        assertTrue(vm.uiState.value.errorMessage!!.contains("45"))

        // 4. Correct PIN -> enters room as guest (isOwner = false)
        repo.enterError = null
        var joinedRoom: RoomInfo? = null
        vm.enterRoom("k7Rm2x", "9876") { joinedRoom = it }
        advanceUntilIdle()

        assertNotNull(joinedRoom)
        assertFalse(vm.uiState.value.isOwner)
        assertFalse(vm.uiState.value.requiresPinForJoin)
        assertEquals("k7Rm2x", vm.uiState.value.activeRoom?.code)
        assertEquals(0, sessionExpiredTriggered)
    }

    private class FakeRoomRepository : RoomRepository {
        private val _activeRoom = MutableStateFlow<RoomInfo?>(null)
        override val activeRoom: StateFlow<RoomInfo?> = _activeRoom.asStateFlow()

        var enterError: Throwable? = null
        var lastCodeUpdate: OptionalField<String?> = OptionalField.Absent
        var lastPinUpdate: OptionalField<String?> = OptionalField.Absent

        override suspend fun createOrReuseRoom(code: String?, pin: String?): RoomInfo {
            val resolvedCode = code ?: "Ab34Xy"
            val room = RoomInfo(
                token = "tok-owner-1",
                code = resolvedCode,
                hasPin = !pin.isNullOrEmpty(),
                expiresAt = 9_999_999_999L,
                url = "/r/$resolvedCode",
                reused = false,
            )
            _activeRoom.value = room
            return room
        }

        override suspend fun enterRoom(code: String, pin: String?): RoomInfo {
            enterError?.let { throw it }
            val room = RoomInfo(
                token = "tok-guest-1",
                code = code,
                hasPin = !pin.isNullOrEmpty(),
                expiresAt = 9_999_999_999L,
                url = "/r/$code",
            )
            _activeRoom.value = room
            return room
        }

        override suspend fun updateRoomCode(
            roomToken: String,
            code: OptionalField<String?>,
            pin: OptionalField<String?>,
        ): RoomInfo {
            lastCodeUpdate = code
            lastPinUpdate = pin
            val current = _activeRoom.value ?: RoomInfo(token = roomToken)
            val nextCode = when (code) {
                OptionalField.Absent -> current.code
                is OptionalField.Present -> code.value ?: "Rnd999"
            }
            val nextHasPin = when (pin) {
                OptionalField.Absent -> current.hasPin
                is OptionalField.Present -> !pin.value.isNullOrEmpty()
            }
            val updated = current.copy(code = nextCode, hasPin = nextHasPin, url = "/r/$nextCode")
            _activeRoom.value = updated
            return updated
        }

        override suspend fun leaveCurrentRoom() {
            _activeRoom.value = null
        }

        override suspend fun clearRoomState() {
            _activeRoom.value = null
        }
    }
}
