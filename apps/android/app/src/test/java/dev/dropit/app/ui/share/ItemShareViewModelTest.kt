package dev.dropit.app.ui.share

import dev.dropit.app.core.network.ApiError
import dev.dropit.app.core.network.ApiErrorCode
import dev.dropit.app.core.network.ClipItem
import dev.dropit.app.core.network.ItemShare
import dev.dropit.app.core.network.TargetScope
import dev.dropit.app.core.repository.ItemShareRepository
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
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

        // Create a new share with 3d expiry and max 5 views
        vm.selectExpiresIn("3d")
        vm.selectMaxViews(5)
        vm.createShare()
        advanceUntilIdle()

        assertEquals("3d" to 5, repo.lastCreateParams)
        val created = vm.uiState.value.latestCreatedShare!!
        assertEquals("https://dropit.lthero.com/s/${created.token}", vm.resolveSharePageUrl(created))
        assertEquals("https://dropit.lthero.com/d/${created.token}", vm.resolveDirectDownloadUrl(created))
        assertEquals(2, vm.uiState.value.shares.size)

        // Revoke the newly created share
        vm.revokeShare(created.id)
        advanceUntilIdle()

        assertEquals(listOf(created.id), repo.revokedIds)
        assertNull(vm.uiState.value.latestCreatedShare)
        assertEquals(1, vm.uiState.value.shares.first { it.id == created.id }.revoked)
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
}
