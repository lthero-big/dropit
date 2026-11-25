package dev.dropit.app.screenshots

import android.app.Application
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Shader
import android.graphics.drawable.BitmapDrawable
import android.net.Uri
import androidx.activity.ComponentActivity
import androidx.annotation.OptIn
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Scaffold
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.test.ext.junit.runners.AndroidJUnit4
import coil.ImageLoader
import coil.decode.DataSource as CoilDataSource
import coil.intercept.Interceptor
import coil.request.ImageResult
import coil.request.SuccessResult
import com.github.takahirom.roborazzi.ExperimentalRoborazziApi
import com.github.takahirom.roborazzi.RoborazziOptions
import com.github.takahirom.roborazzi.RoborazziTaskType
import com.github.takahirom.roborazzi.captureScreenRoboImage
import dev.dropit.app.core.auth.ThemeMode
import dev.dropit.app.core.network.ClipItem
import dev.dropit.app.core.network.GroupInfo
import dev.dropit.app.core.network.ItemDevice
import dev.dropit.app.core.network.MeResponse
import dev.dropit.app.core.network.OptionalField
import dev.dropit.app.core.network.RoomInfo
import dev.dropit.app.core.network.ScopeDetails
import dev.dropit.app.core.network.SessionExpiredEvent
import dev.dropit.app.core.network.Space
import dev.dropit.app.core.network.TargetScope
import dev.dropit.app.core.network.User
import dev.dropit.app.core.network.WsEvent
import dev.dropit.app.core.realtime.BoardSnapshotState
import dev.dropit.app.core.realtime.BoardStateReducer
import dev.dropit.app.core.realtime.ConnectionState
import dev.dropit.app.core.repository.BoardRepository
import dev.dropit.app.core.repository.DownloadFileRequest
import dev.dropit.app.core.repository.MediaRepository
import dev.dropit.app.core.repository.PendingShare
import dev.dropit.app.core.repository.PlaceholderItemShareRepository
import dev.dropit.app.core.repository.PlaceholderRoomRepository
import dev.dropit.app.core.repository.SpaceRepository
import dev.dropit.app.core.repository.StagedShareFile
import dev.dropit.app.core.repository.TransferDirection
import dev.dropit.app.core.repository.TransferManager
import dev.dropit.app.core.repository.TransferStatus
import dev.dropit.app.core.repository.TransferTask
import dev.dropit.app.core.repository.UploadFileRequest
import dev.dropit.app.ui.board.BoardRealtimeBridge
import dev.dropit.app.ui.board.BoardScreen
import dev.dropit.app.ui.board.BoardViewModel
import dev.dropit.app.ui.navigation.DropitBottomBar
import dev.dropit.app.ui.navigation.MainTab
import dev.dropit.app.ui.rooms.RoomViewModel
import dev.dropit.app.ui.share.ItemShareViewModel
import dev.dropit.app.ui.share.ShareDestination
import dev.dropit.app.ui.share.ShareTargetSheet
import dev.dropit.app.ui.share.ShareTargetUiState
import dev.dropit.app.ui.theme.DropitFontOverrides
import dev.dropit.app.ui.theme.DropitTheme
import dev.dropit.app.ui.transfers.TransfersScreen
import dev.dropit.app.ui.transfers.TransfersViewModel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

/**
 * Reproducible headless JVM Compose screenshot suite for the native Android client.
 *
 * Uses strictly fictional demo data (`demo@example.com`, sample files/text, temporary room
 * `demo-room`), identical in spirit to `scripts/screenshots.mjs`.
 *
 * Skipped during routine `./gradlew testDebugUnitTest` runs so CI without CJK fonts stays fast
 * and deterministic; activated by `.github/workflows/android-screenshots.yml` or locally via:
 *
 *   DROPIT_RUN_SCREENSHOT_TESTS=1 \
 *   DROPIT_SCREENSHOT_FONT_DIR=/path/to/noto-cjk-sc \
 *   DROPIT_SCREENSHOT_OUT_DIR=../../docs/screenshots \
 *   ./gradlew :app:recordRoborazziDebug --tests "dev.dropit.app.screenshots.AndroidDemoScreenshotsTest"
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(
    application = Application::class,
    sdk = [34],
    qualifiers = "w412dp-h915dp-xhdpi",
)
class AndroidDemoScreenshotsTest {

    @get:Rule
    val composeTestRule = createAndroidComposeRule<ComponentActivity>()

    private lateinit var outputDir: File

    @Before
    fun setUp() {
        assumeTrue(
            "Screenshot generation skipped unless DROPIT_RUN_SCREENSHOT_TESTS=1 or Roborazzi record/verify is active",
            isScreenshotModeEnabled(),
        )

        outputDir = resolveOutputDir().apply { mkdirs() }
        installCjkFontsIfAvailable()
    }

    @After
    fun tearDown() {
        DropitFontOverrides.sans = null
        DropitFontOverrides.mono = null
    }

    @Test
    fun captureBoardLight() {
        renderBoardScreenshot(
            themeMode = ThemeMode.LIGHT,
            fileName = "android-board-light.png",
        )
    }

    @Test
    fun captureBoardDark() {
        renderBoardScreenshot(
            themeMode = ThemeMode.DARK,
            fileName = "android-board-dark.png",
        )
    }

    @Test
    fun captureShareTargetSheet() {
        val fixture = DemoFixtures(composeTestRule.activity)
        val shareState = fixture.createDemoShareTargetUiState()

        composeTestRule.setContent {
            DropitTheme(themeMode = ThemeMode.LIGHT) {
                Box(modifier = Modifier.fillMaxSize()) {
                    DemoMainShell(
                        selectedTab = MainTab.BOARD,
                        activeTransferCount = 2,
                    ) {
                        BoardScreen(
                            viewModel = fixture.boardViewModel,
                            roomViewModel = fixture.roomViewModel,
                            itemShareViewModel = fixture.itemShareViewModel,
                            mediaRepository = fixture.mediaRepository,
                            imageLoader = fixture.imageLoader,
                            onNavigateToTransfers = {},
                            onOpenImageLightbox = { _, _, _ -> },
                            onOpenMediaPlayer = { _, _, _ -> },
                            onOpenTextReader = {},
                        )
                    }

                    ShareTargetSheet(
                        state = shareState,
                        maxTextBytes = 64 * 1024L,
                        isLoadingSpaces = false,
                        spacesLoadError = null,
                        onRetryLoadSpaces = {},
                        onSelectTarget = {},
                        onSelectGroup = {},
                        onTextChanged = {},
                        onRemoveFile = {},
                        onConfirmSend = {},
                        onCancel = {},
                    )
                }
            }
        }

        captureSettledScreen("android-share-sheet.png")
    }

    @Test
    fun captureTransfersQueue() {
        val fixture = DemoFixtures(composeTestRule.activity)

        composeTestRule.setContent {
            DropitTheme(themeMode = ThemeMode.LIGHT) {
                DemoMainShell(
                    selectedTab = MainTab.TRANSFERS,
                    activeTransferCount = 2,
                ) {
                    TransfersScreen(
                        viewModel = fixture.transfersViewModel,
                        spaceNames = fixture.spaceNames,
                    )
                }
            }
        }

        captureSettledScreen("android-transfers.png")
    }

    private fun renderBoardScreenshot(
        themeMode: ThemeMode,
        fileName: String,
    ) {
        val fixture = DemoFixtures(composeTestRule.activity)

        composeTestRule.setContent {
            DropitTheme(themeMode = themeMode) {
                DemoMainShell(
                    selectedTab = MainTab.BOARD,
                    activeTransferCount = 2,
                ) {
                    BoardScreen(
                        viewModel = fixture.boardViewModel,
                        roomViewModel = fixture.roomViewModel,
                        itemShareViewModel = fixture.itemShareViewModel,
                        mediaRepository = fixture.mediaRepository,
                        imageLoader = fixture.imageLoader,
                        onNavigateToTransfers = {},
                        onOpenImageLightbox = { _, _, _ -> },
                        onOpenMediaPlayer = { _, _, _ -> },
                        onOpenTextReader = {},
                    )
                }
            }
        }

        captureSettledScreen(fileName)
    }

    @Composable
    private fun DemoMainShell(
        selectedTab: MainTab,
        activeTransferCount: Int,
        content: @Composable () -> Unit,
    ) {
        val colors = DropitTheme.colors
        Scaffold(
            modifier = Modifier.fillMaxSize(),
            containerColor = colors.bg,
            contentWindowInsets = WindowInsets(0, 0, 0, 0),
            bottomBar = {
                DropitBottomBar(
                    selectedTab = selectedTab,
                    activeTransferCount = activeTransferCount,
                    failedTransferCount = 0,
                    onSelectTab = {},
                )
            },
        ) { innerPadding ->
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(innerPadding),
            ) {
                content()
            }
        }
    }

    @kotlin.OptIn(ExperimentalRoborazziApi::class)
    private fun captureSettledScreen(fileName: String) {
        composeTestRule.waitForIdle()
        composeTestRule.mainClock.advanceTimeBy(1_000L)
        composeTestRule.waitForIdle()

        val targetFile = File(outputDir, fileName)
        captureScreenRoboImage(
            file = targetFile,
            roborazziOptions = RoborazziOptions(taskType = RoborazziTaskType.Record),
        )
        assertTrue("Expected screenshot file to exist and be non-empty: ${targetFile.absolutePath}", targetFile.isFile && targetFile.length() > 1_024L)
    }

    private fun isScreenshotModeEnabled(): Boolean {
        if (System.getenv("DROPIT_RUN_SCREENSHOT_TESTS") == "1") return true
        if (System.getProperty("roborazzi.test.record").equals("true", ignoreCase = true)) return true
        if (System.getProperty("roborazzi.test.verify").equals("true", ignoreCase = true)) return true
        return false
    }

    private fun resolveOutputDir(): File {
        val explicit = System.getenv("DROPIT_SCREENSHOT_OUT_DIR")?.trim().orEmpty()
        if (explicit.isNotEmpty()) {
            return File(explicit).absoluteFile
        }
        return File("build/outputs/dropit-screenshots").absoluteFile
    }

    private fun installCjkFontsIfAvailable() {
        val requireCjk = System.getenv("DROPIT_REQUIRE_CJK_FONT") == "1"
        val fontDir = System.getenv("DROPIT_SCREENSHOT_FONT_DIR")?.trim()?.takeIf { it.isNotEmpty() }?.let(::File)

        val candidates = buildList {
            if (fontDir != null) add(fontDir)
            add(File("/usr/share/fonts/opentype/noto"))
            add(File("/usr/share/fonts/truetype/noto"))
            add(File("/usr/share/fonts/noto-cjk"))
        }

        val regular = findFirstFont(
            candidates,
            listOf(
                "NotoSansCJKsc-Regular.otf",
                "NotoSansSC-Regular.ttf",
                "NotoSansSC-Regular.otf",
                "NotoSansCJK-Regular.ttc",
            ),
        )
        val medium = findFirstFont(
            candidates,
            listOf(
                "NotoSansCJKsc-Medium.otf",
                "NotoSansSC-Medium.ttf",
                "NotoSansSC-Medium.otf",
            ),
        ) ?: regular
        val bold = findFirstFont(
            candidates,
            listOf(
                "NotoSansCJKsc-Bold.otf",
                "NotoSansSC-Bold.ttf",
                "NotoSansSC-Bold.otf",
                "NotoSansCJK-Bold.ttc",
            ),
        ) ?: medium

        if (regular == null || medium == null || bold == null) {
            if (requireCjk) {
                error(
                    "CJK font files not found for screenshot rendering. Set DROPIT_SCREENSHOT_FONT_DIR to a directory containing NotoSansCJKsc-Regular.otf, NotoSansCJKsc-Medium.otf, and NotoSansCJKsc-Bold.otf.",
                )
            }
            return
        }

        val cjkFamily = FontFamily(
            Font(file = regular, weight = FontWeight.Normal),
            Font(file = medium, weight = FontWeight.Medium),
            Font(file = bold, weight = FontWeight.SemiBold),
            Font(file = bold, weight = FontWeight.Bold),
        )
        DropitFontOverrides.sans = cjkFamily
        DropitFontOverrides.mono = cjkFamily
    }

    private fun findFirstFont(dirs: List<File>, names: List<String>): File? {
        for (dir in dirs) {
            if (!dir.isDirectory) continue
            for (name in names) {
                val f = File(dir, name)
                if (f.isFile && f.length() > 0L) return f
            }
        }
        return null
    }
}

/**
 * Self-contained fictional demo fixtures matching `docs/screenshots/README.md` (`demo@example.com`).
 */
private class DemoFixtures(context: Context) {
    private val now = System.currentTimeMillis()
    private val origin = "https://dropit.example.com"
    private val demoUser = User(
        id = "demo-user-1",
        email = "demo@example.com",
        name = "Demo",
        role = "admin",
        createdAt = now - 30L * 86_400_000L,
    )

    val personalSpace = Space(
        id = "sp-demo-personal",
        name = "我的空间",
        ownerId = demoUser.id,
        expiresAt = null,
        role = "owner",
    )
    val collabSpace = Space(
        id = "sp-demo-design",
        name = "设计协作空间",
        ownerId = "demo-user-alice",
        expiresAt = null,
        role = "editor",
        ownerName = "Alice",
    )
    val readOnlySpace = Space(
        id = "sp-demo-readonly",
        name = "团队资料归档",
        ownerId = "demo-user-bob",
        expiresAt = null,
        role = "viewer",
        ownerName = "Bob",
    )
    val demoRoom = RoomInfo(
        token = "demo-room-token",
        code = "demo-room",
        hasPin = false,
        expiresAt = now + 22L * 3_600_000L,
        url = "$origin/r/demo-room",
    )

    val spaceNames: Map<String, String> = mapOf(
        personalSpace.id to personalSpace.name,
        collabSpace.id to collabSpace.name,
        readOnlySpace.id to readOnlySpace.name,
    )

    private val demoGroups = listOf("工作", "灵感", "旅行")

    private val demoItems: List<ClipItem> = listOf(
        ClipItem(
            id = "demo-item-pinned-wifi",
            spaceId = personalSpace.id,
            userId = demoUser.id,
            kind = "text",
            text = "访客 Wi-Fi：dropit-guest · 密码 sunflower-2026（示例）",
            size = 64L,
            createdAt = now - 2L * 60_000L,
            updatedAt = now - 2L * 60_000L,
            expiresAt = now + 6L * 86_400_000L,
            pinned = true,
            tags = listOf("常用", "Wi-Fi"),
            group = "工作",
            device = ItemDevice(id = "dev-mac", name = "Mac · Chrome", kind = "mac"),
        ),
        ClipItem(
            id = "demo-item-pdf",
            spaceId = personalSpace.id,
            userId = demoUser.id,
            kind = "file",
            filename = "2026产品发布会演示方案.pdf",
            mime = "application/pdf",
            size = 4_823_450L,
            createdAt = now - 8L * 60_000L,
            updatedAt = now - 8L * 60_000L,
            expiresAt = now + 5L * 86_400_000L,
            pinned = false,
            tags = listOf("演示", "定稿"),
            group = "工作",
            device = ItemDevice(id = "dev-mac", name = "Mac · Chrome", kind = "mac"),
        ),
        ClipItem(
            id = "demo-item-image",
            spaceId = personalSpace.id,
            userId = demoUser.id,
            kind = "file",
            filename = "周末海边照片_舟山日落.png",
            mime = "image/png",
            size = 2_202_010L,
            createdAt = now - 24L * 60_000L,
            updatedAt = now - 24L * 60_000L,
            expiresAt = now + 6L * 86_400_000L,
            pinned = false,
            hasThumbnail = true,
            tags = listOf("照片"),
            group = "旅行",
            device = ItemDevice(id = "dev-phone", name = "Pixel · Android", kind = "phone"),
        ),
        ClipItem(
            id = "demo-item-link",
            spaceId = personalSpace.id,
            userId = demoUser.id,
            kind = "text",
            text = "https://lthero-big.github.io/dropit/",
            size = 36L,
            createdAt = now - 52L * 60_000L,
            updatedAt = now - 52L * 60_000L,
            expiresAt = now + 6L * 86_400_000L,
            pinned = false,
            tags = listOf("文档"),
            group = "灵感",
            device = ItemDevice(id = "dev-pad", name = "iPad · Safari", kind = "pad"),
        ),
        ClipItem(
            id = "demo-item-code",
            spaceId = personalSpace.id,
            userId = demoUser.id,
            kind = "text",
            text = "```bash\ndocker compose up -d\ndocker logs dropit 2>&1 | grep \"setup code\"\n```",
            size = 78L,
            createdAt = now - 2L * 3_600_000L,
            updatedAt = now - 2L * 3_600_000L,
            expiresAt = now + 4L * 86_400_000L,
            pinned = false,
            tags = listOf("运维"),
            group = "灵感",
            device = ItemDevice(id = "dev-cli", name = "dropit CLI", kind = "cli"),
        ),
    )

    private val demoTransfers: List<TransferTask> = listOf(
        TransferTask(
            id = "tx-upload-running",
            serverOrigin = origin,
            accountId = demoUser.id,
            targetScope = TargetScope.SpaceScope(personalSpace.id),
            groupName = "工作",
            direction = TransferDirection.UPLOAD,
            fileName = "产品演示录屏_1080p.mp4",
            mimeType = "video/mp4",
            totalBytes = 65_536_000L,
            transferredBytes = 44_564_480L,
            speedBytesPerSec = 8_808_038L,
            etaSeconds = 3L,
            status = TransferStatus.RUNNING,
            createdAt = now - 20_000L,
            updatedAt = now,
        ),
        TransferTask(
            id = "tx-download-running",
            serverOrigin = origin,
            accountId = demoUser.id,
            targetScope = TargetScope.SpaceScope(collabSpace.id),
            groupName = "灵感",
            direction = TransferDirection.DOWNLOAD,
            fileName = "设计规范与组件库_v4.zip",
            mimeType = "application/zip",
            totalBytes = 47_185_920L,
            transferredBytes = 19_818_086L,
            speedBytesPerSec = 11_744_051L,
            etaSeconds = 2L,
            status = TransferStatus.RUNNING,
            createdAt = now - 12_000L,
            updatedAt = now,
        ),
        TransferTask(
            id = "tx-upload-paused",
            serverOrigin = origin,
            accountId = demoUser.id,
            targetScope = TargetScope.RoomScope(demoRoom.token),
            groupName = null,
            direction = TransferDirection.UPLOAD,
            fileName = "会议现场素材归档包.tar.zst",
            mimeType = "application/zstd",
            totalBytes = 128_974_848L,
            transferredBytes = 45_141_197L,
            speedBytesPerSec = 0L,
            etaSeconds = null,
            status = TransferStatus.PAUSED,
            createdAt = now - 120_000L,
            updatedAt = now - 40_000L,
        ),
        TransferTask(
            id = "tx-download-done",
            serverOrigin = origin,
            accountId = demoUser.id,
            targetScope = TargetScope.SpaceScope(personalSpace.id),
            groupName = "工作",
            direction = TransferDirection.DOWNLOAD,
            fileName = "2026产品发布会演示方案.pdf",
            mimeType = "application/pdf",
            totalBytes = 4_823_450L,
            transferredBytes = 4_823_450L,
            status = TransferStatus.SUCCEEDED,
            localResultUri = "content://dev.dropit.app.fileprovider/downloads/demo.pdf",
            createdAt = now - 300_000L,
            updatedAt = now - 290_000L,
        ),
        TransferTask(
            id = "tx-upload-done",
            serverOrigin = origin,
            accountId = demoUser.id,
            targetScope = TargetScope.SpaceScope(personalSpace.id),
            groupName = "旅行",
            direction = TransferDirection.UPLOAD,
            fileName = "周末海边照片_舟山日落.png",
            mimeType = "image/png",
            totalBytes = 2_202_010L,
            transferredBytes = 2_202_010L,
            status = TransferStatus.SUCCEEDED,
            createdAt = now - 600_000L,
            updatedAt = now - 595_000L,
        ),
    )

    private val spaceRepository = DemoSpaceRepository(
        me = MeResponse(
            user = demoUser,
            usedBytes = 18_432_000L,
            quotaBytes = 2_147_483_648L,
            maxFileBytes = 524_288_000L,
            maxTextBytes = 64 * 1024L,
            retentionMs = 7L * 86_400_000L,
        ),
        spaces = listOf(personalSpace, collabSpace, readOnlySpace),
    )

    private val boardRepository = DemoBoardRepository(
        snapshot = WsEvent.Snapshot(
            items = demoItems,
            groups = demoGroups,
            serverTime = now,
            expiresAt = null,
        ),
    )

    private val realtimeBridge = DemoRealtimeBridge(presenceDevices = 3)
    private val transferManager = DemoTransferManager(demoTransfers)

    val mediaRepository: MediaRepository = DemoMediaRepository(context)
    val imageLoader: ImageLoader = mediaRepository.createImageLoader()

    val boardViewModel = BoardViewModel(
        spaceRepository = spaceRepository,
        boardRepository = boardRepository,
        realtimeBridge = realtimeBridge,
        transferManager = transferManager,
        sessionExpiredEvents = MutableSharedFlow<SessionExpiredEvent>(),
        ioDispatcher = Dispatchers.Unconfined,
        autoLoad = true,
    )

    val roomViewModel = RoomViewModel(
        roomRepository = PlaceholderRoomRepository(),
        serverOriginProvider = { origin },
        ioDispatcher = Dispatchers.Unconfined,
    )

    val itemShareViewModel = ItemShareViewModel(
        itemShareRepository = PlaceholderItemShareRepository(),
        serverOriginProvider = { origin },
        ioDispatcher = Dispatchers.Unconfined,
    )

    val transfersViewModel = TransfersViewModel(
        transferManager = transferManager,
        ioDispatcher = Dispatchers.Unconfined,
    )

    fun createDemoShareTargetUiState(): ShareTargetUiState {
        val personalDest = ShareDestination.SpaceDestination(personalSpace, isPersonal = true)
        val collabDest = ShareDestination.SpaceDestination(collabSpace, isPersonal = false)
        val roomDest = ShareDestination.RoomDestination(demoRoom)
        val stagedFiles = listOf(
            StagedShareFile(
                id = "staged-1",
                displayName = "项目季度总结报告_2026Q4.pdf",
                mimeType = "application/pdf",
                sizeBytes = 3_565_158L,
                stagedFilePath = "/cache/share/report.pdf",
            ),
            StagedShareFile(
                id = "staged-2",
                displayName = "界面设计走查截图.png",
                mimeType = "image/png",
                sizeBytes = 1_887_436L,
                stagedFilePath = "/cache/share/review.png",
            ),
        )
        val sharedText = "周会同步：v0.4.0 原生客户端安装包与演示稿，请查收。"
        return ShareTargetUiState(
            pendingShare = PendingShare(
                id = "demo-share-1",
                text = sharedText,
                files = stagedFiles,
                receivedAt = now,
            ),
            editedText = sharedText,
            files = stagedFiles,
            availableTargets = listOf(personalDest, collabDest, roomDest),
            excludedReadOnlyCount = 1,
            selectedTarget = personalDest,
            availableGroups = demoGroups,
            isLoadingGroups = false,
            selectedGroup = "工作",
            isSubmitting = false,
            errorMessage = null,
        )
    }
}

private class DemoSpaceRepository(
    private val me: MeResponse,
    private val spaces: List<Space>,
) : SpaceRepository {
    override suspend fun getMe(): MeResponse = me
    override suspend fun getSpaces(): List<Space> = spaces
    override suspend fun getScopeDetails(scope: TargetScope): ScopeDetails =
        ScopeDetails(id = scope.scopeId, name = "我的空间")

    override fun pickDefaultSpace(spaces: List<Space>, userId: String): Space? =
        spaces.firstOrNull { it.isPersonalFor(userId) } ?: spaces.firstOrNull()
}

private class DemoBoardRepository(
    private val snapshot: WsEvent.Snapshot,
) : BoardRepository {
    override suspend fun fetchSnapshot(scope: TargetScope): WsEvent.Snapshot = snapshot
    override suspend fun createText(scope: TargetScope, text: String, group: String?): ClipItem =
        snapshot.items.first()

    override suspend fun editText(scope: TargetScope, itemId: String, text: String): ClipItem =
        snapshot.items.first()

    override suspend fun setPinned(scope: TargetScope, itemId: String, pinned: Boolean): ClipItem =
        snapshot.items.first()

    override suspend fun setTags(scope: TargetScope, itemId: String, tags: List<String>): ClipItem =
        snapshot.items.first()

    override suspend fun setGroup(scope: TargetScope, itemId: String, group: String?): ClipItem =
        snapshot.items.first()

    override suspend fun updateLabels(
        scope: TargetScope,
        itemId: String,
        pinned: Boolean?,
        tags: List<String>?,
        group: OptionalField<String?>,
    ): ClipItem = snapshot.items.first()

    override suspend fun retractItem(scope: TargetScope, itemId: String) = Unit
    override suspend fun getGroups(scope: TargetScope): List<String> = snapshot.groups
    override suspend fun createGroup(scope: TargetScope, name: String): List<String> = snapshot.groups
    override suspend fun renameGroup(scope: TargetScope, oldName: String, newName: String): List<String> = snapshot.groups
    override suspend fun deleteGroup(scope: TargetScope, name: String): List<String> = snapshot.groups
    override fun buildGroupInfos(groups: List<String>, items: List<ClipItem>): List<GroupInfo> {
        val counts = items.groupingBy { it.group }.eachCount()
        return groups.map { GroupInfo(it, counts[it] ?: 0) }
    }
}

private class DemoRealtimeBridge(
    private val presenceDevices: Int,
) : BoardRealtimeBridge {
    private val _connectionState = MutableStateFlow(ConnectionState.CONNECTED)
    override val connectionState: StateFlow<ConnectionState> = _connectionState.asStateFlow()

    private val _boardState = MutableStateFlow(BoardSnapshotState(presenceDevices = presenceDevices))
    override val boardState: StateFlow<BoardSnapshotState> = _boardState.asStateFlow()

    override fun connect(targetScope: TargetScope) {
        _connectionState.value = ConnectionState.CONNECTED
        _boardState.value = _boardState.value.copy(scope = targetScope, presenceDevices = presenceDevices)
    }

    override fun disconnect(clearState: Boolean) {
        _connectionState.value = ConnectionState.DISCONNECTED
    }

    override fun reconnectNow() {
        _connectionState.value = ConnectionState.CONNECTED
    }

    override fun onAppBackground() = Unit
    override fun onAppForeground() = Unit

    override fun applyLocalSnapshot(targetScope: TargetScope, snapshot: WsEvent.Snapshot) {
        val reduced = BoardStateReducer.reduce(
            BoardSnapshotState(scope = targetScope, presenceDevices = presenceDevices),
            snapshot,
        )
        _boardState.value = reduced.copy(presenceDevices = presenceDevices)
    }
}

private class DemoTransferManager(
    initialTasks: List<TransferTask>,
) : TransferManager {
    private val _tasks = MutableStateFlow(initialTasks)
    override val tasks: StateFlow<List<TransferTask>> = _tasks.asStateFlow()

    private val _activeCount = MutableStateFlow(initialTasks.count { it.isActive })
    override val activeCount: StateFlow<Int> = _activeCount.asStateFlow()

    override suspend fun enqueueUploads(requests: List<UploadFileRequest>): List<String> = emptyList()
    override suspend fun enqueueStagedUploads(
        stagedFiles: List<StagedShareFile>,
        targetScope: TargetScope,
        groupName: String?,
    ): List<String> = emptyList()

    override suspend fun enqueueDownload(request: DownloadFileRequest): String = ""
    override suspend fun downloadForShare(item: ClipItem, targetScope: TargetScope): Result<Uri> =
        Result.failure(UnsupportedOperationException("demo"))

    override suspend fun cancel(taskId: String) = Unit
    override suspend fun retry(taskId: String) = Unit
    override suspend fun clearCompleted() = Unit
    override suspend fun clearAllForScopeSwitch() = Unit
}

/**
 * Generates an offline vector-painted coastal sunset preview bitmap for the demo image card
 * and serves it synchronously from Coil's memory cache so zero network calls occur in CI.
 */
private class DemoMediaRepository(
    private val context: Context,
) : MediaRepository {
    private val sampleBitmap: Bitmap by lazy { createCoastalDemoBitmap() }

    override suspend fun thumbnailUrl(scope: TargetScope, itemId: String): String =
        "https://dropit.example.com/demo-thumb/$itemId.png"

    override suspend fun previewUrl(scope: TargetScope, itemId: String): String =
        "https://dropit.example.com/demo-preview/$itemId.png"

    override suspend fun mediaUrl(scope: TargetScope, itemId: String): String =
        "https://dropit.example.com/demo-media/$itemId.mp4"

    override suspend fun downloadUrl(scope: TargetScope, itemId: String): String =
        "https://dropit.example.com/demo-download/$itemId"

    override fun createImageLoader(): ImageLoader {
        val interceptor = Interceptor { chain ->
            val drawable = BitmapDrawable(context.resources, sampleBitmap)
            SuccessResult(
                drawable = drawable,
                request = chain.request,
                dataSource = CoilDataSource.MEMORY_CACHE,
            )
        }
        return ImageLoader.Builder(context)
            .allowHardware(false)
            .components {
                add(interceptor)
            }
            .build()
    }

    @OptIn(UnstableApi::class)
    override fun createMediaDataSourceFactory(): DataSource.Factory =
        OkHttpDataSource.Factory(OkHttpClient())

    override suspend fun fetchTextContent(scope: TargetScope, itemId: String, maxBytes: Int): String = ""
    override suspend fun clearCaches() = Unit

    private fun createCoastalDemoBitmap(): Bitmap {
        val width = 840
        val height = 420
        val bmp = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bmp)

        // Warm sky-to-horizon sunset gradient harmonizing with Paper UI palette
        val skyPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            shader = LinearGradient(
                0f, 0f, width.toFloat(), height * 0.68f,
                intArrayOf(0xFF1D4E73.toInt(), 0xFF3E849D.toInt(), 0xFFE5A46C.toInt(), 0xFFF3CFA0.toInt()),
                floatArrayOf(0f, 0.42f, 0.78f, 1f),
                Shader.TileMode.CLAMP,
            )
        }
        canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), skyPaint)

        // Soft glowing sun near horizon
        val sunHaloPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = 0x44FFF4DC
        }
        canvas.drawCircle(width * 0.72f, height * 0.46f, 88f, sunHaloPaint)
        val sunPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = 0xFFFFF6E4.toInt()
        }
        canvas.drawCircle(width * 0.72f, height * 0.46f, 44f, sunPaint)

        // Distant coastal headland silhouette
        val mountainPath = Path().apply {
            moveTo(0f, height * 0.62f)
            lineTo(width * 0.18f, height * 0.48f)
            lineTo(width * 0.36f, height * 0.56f)
            lineTo(width * 0.52f, height * 0.50f)
            lineTo(width * 0.70f, height * 0.62f)
            lineTo(0f, height * 0.62f)
            close()
        }
        val mountainPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = 0xFF28465E.toInt()
        }
        canvas.drawPath(mountainPath, mountainPaint)

        // Calm ocean plane
        val seaPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            shader = LinearGradient(
                0f, height * 0.62f, 0f, height.toFloat(),
                intArrayOf(0xFF22577A.toInt(), 0xFF183D57.toInt()),
                null,
                Shader.TileMode.CLAMP,
            )
        }
        canvas.drawRect(0f, height * 0.62f, width.toFloat(), height.toFloat(), seaPaint)

        // Sun reflection ripples on water
        val ripplePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = 0x88F8DFB4.toInt()
            strokeCap = Paint.Cap.ROUND
            strokeWidth = 6f
        }
        val ripples = listOf(
            Triple(0.72f, 0.68f, 96f),
            Triple(0.71f, 0.74f, 130f),
            Triple(0.73f, 0.80f, 82f),
            Triple(0.70f, 0.86f, 110f),
            Triple(0.72f, 0.92f, 64f),
        )
        ripples.forEach { (cxRatio, yRatio, halfLen) ->
            val cx = width * cxRatio
            val y = height * yRatio
            canvas.drawLine(cx - halfLen * 0.5f, y, cx + halfLen * 0.5f, y, ripplePaint)
        }

        // Foreground curved shore wave highlight
        val wavePath = Path().apply {
            moveTo(0f, height * 0.86f)
            quadTo(width * 0.28f, height * 0.76f, width * 0.56f, height * 0.88f)
            quadTo(width * 0.80f, height * 0.96f, width.toFloat(), height * 0.84f)
            lineTo(width.toFloat(), height.toFloat())
            lineTo(0f, height.toFloat())
            close()
        }
        val wavePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = 0xFF123045.toInt()
        }
        canvas.drawPath(wavePath, wavePaint)

        return bmp
    }
}
