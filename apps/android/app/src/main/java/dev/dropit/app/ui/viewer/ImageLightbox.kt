package dev.dropit.app.ui.viewer

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculatePan
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.displayCutoutPadding
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.Download
import androidx.compose.material.icons.rounded.Share
import androidx.compose.material.icons.rounded.ZoomOutMap
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChanged
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import coil.ImageLoader
import coil.compose.AsyncImage
import coil.request.ImageRequest
import dev.dropit.app.core.network.ClipItem
import dev.dropit.app.core.network.ServerUrl
import dev.dropit.app.core.network.TargetScope
import dev.dropit.app.core.repository.MediaRepository
import dev.dropit.app.ui.board.ClipFormatting
import dev.dropit.app.ui.theme.DropitMediaColors
import dev.dropit.app.ui.theme.DropitMonoTypography
import dev.dropit.app.ui.theme.DropitTheme
import kotlin.math.roundToInt

@Composable
fun ImageLightbox(
    images: List<ClipItem>,
    initialIndex: Int,
    scope: TargetScope,
    mediaRepository: MediaRepository,
    imageLoader: ImageLoader,
    onSaveOriginal: (ClipItem) -> Unit,
    onShareImage: (ClipItem) -> Unit,
    onClose: () -> Unit,
    modifier: Modifier = Modifier,
) {
    if (images.isEmpty()) return
    val safeInitialIndex = initialIndex.coerceIn(0, images.lastIndex)
    val pagerState = rememberPagerState(initialPage = safeInitialIndex, pageCount = { images.size })
    var showChrome by remember { mutableStateOf(true) }
    var activeScale by remember { mutableFloatStateOf(1f) }
    var resetSignal by remember { mutableStateOf(0) }

    val currentItem = images[pagerState.currentPage.coerceIn(0, images.lastIndex)]
    val displayName = remember(currentItem.filename) {
        ClipFormatting.middleEllipsizeFilename(currentItem.filename ?: "图片", maxChars = 32)
    }

    LaunchedEffect(pagerState.currentPage) {
        activeScale = 1f
    }

    BackHandler(onBack = onClose)

    Box(
        modifier = modifier
            .fillMaxSize()
            .background(DropitMediaColors.LightboxScrim),
    ) {
        HorizontalPager(
            state = pagerState,
            userScrollEnabled = activeScale <= 1.02f,
            modifier = Modifier.fillMaxSize(),
        ) { page ->
            val pageItem = images[page]
            ZoomableLightboxPage(
                item = pageItem,
                scope = scope,
                mediaRepository = mediaRepository,
                imageLoader = imageLoader,
                resetSignal = if (page == pagerState.currentPage) resetSignal else 0,
                onScaleChanged = { newScale ->
                    if (page == pagerState.currentPage) {
                        activeScale = newScale
                    }
                },
                onSingleTap = { showChrome = !showChrome },
            )
        }

        // Floating Top Bar
        AnimatedVisibility(
            visible = showChrome,
            enter = fadeIn(),
            exit = fadeOut(),
            modifier = Modifier.align(Alignment.TopCenter),
        ) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(Color(0x990E0D0C))
                    .statusBarsPadding()
                    .displayCutoutPadding()
                    .padding(horizontal = 8.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                IconButton(
                    onClick = onClose,
                    modifier = Modifier.size(48.dp),
                ) {
                    Icon(
                        imageVector = Icons.Rounded.Close,
                        contentDescription = "关闭图片灯箱",
                        tint = DropitMediaColors.OverlayPrimary,
                    )
                }

                Column(
                    modifier = Modifier.weight(1f),
                    verticalArrangement = Arrangement.spacedBy(2.dp),
                ) {
                    Text(
                        text = displayName,
                        style = MaterialTheme.typography.bodyMedium,
                        color = DropitMediaColors.OverlayPrimary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    val meta = buildList {
                        if (images.size > 1) add("${pagerState.currentPage + 1} / ${images.size}")
                        if (currentItem.size > 0L) add(ServerUrl.formatSize(currentItem.size))
                        if (activeScale > 1.02f) add("${(activeScale * 100f).roundToInt()}%")
                    }.joinToString(" · ")
                    Text(
                        text = meta,
                        style = DropitMonoTypography.meta,
                        color = DropitMediaColors.OverlaySecondary,
                    )
                }
            }
        }

        // Floating Bottom Bar
        AnimatedVisibility(
            visible = showChrome,
            enter = fadeIn(),
            exit = fadeOut(),
            modifier = Modifier.align(Alignment.BottomCenter),
        ) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(Color(0x990E0D0C))
                    .navigationBarsPadding()
                    .padding(horizontal = 16.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    TextButton(
                        onClick = { onSaveOriginal(currentItem) },
                        modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                        colors = ButtonDefaults.textButtonColors(contentColor = DropitMediaColors.OverlayPrimary),
                    ) {
                        Icon(
                            imageVector = Icons.Rounded.Download,
                            contentDescription = null,
                            modifier = Modifier.size(18.dp),
                        )
                        Spacer(modifier = Modifier.width(6.dp))
                        Text("保存原图")
                    }

                    TextButton(
                        onClick = { onShareImage(currentItem) },
                        modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                        colors = ButtonDefaults.textButtonColors(contentColor = DropitMediaColors.OverlayPrimary),
                    ) {
                        Icon(
                            imageVector = Icons.Rounded.Share,
                            contentDescription = null,
                            modifier = Modifier.size(18.dp),
                        )
                        Spacer(modifier = Modifier.width(6.dp))
                        Text("分享")
                    }
                }

                if (activeScale > 1.02f) {
                    TextButton(
                        onClick = { resetSignal++ },
                        modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                        colors = ButtonDefaults.textButtonColors(contentColor = DropitMediaColors.OverlaySecondary),
                    ) {
                        Icon(
                            imageVector = Icons.Rounded.ZoomOutMap,
                            contentDescription = null,
                            modifier = Modifier.size(16.dp),
                        )
                        Spacer(modifier = Modifier.width(4.dp))
                        Text("还原", style = DropitMonoTypography.meta)
                    }
                }
            }
        }
    }
}

@Composable
private fun ZoomableLightboxPage(
    item: ClipItem,
    scope: TargetScope,
    mediaRepository: MediaRepository,
    imageLoader: ImageLoader,
    resetSignal: Int,
    onScaleChanged: (Float) -> Unit,
    onSingleTap: () -> Unit,
) {
    val context = LocalContext.current
    var thumbUrl by remember(item.id, scope) { mutableStateOf<String?>(null) }
    var previewUrl by remember(item.id, scope) { mutableStateOf<String?>(null) }
    var isPreviewLoaded by remember(item.id, scope) { mutableStateOf(false) }
    var previewFailed by remember(item.id, scope) { mutableStateOf(false) }

    var scale by remember(item.id) { mutableFloatStateOf(1f) }
    var offset by remember(item.id) { mutableStateOf(Offset.Zero) }
    var containerSize by remember { mutableStateOf(IntSize.Zero) }

    LaunchedEffect(item.id, scope) {
        thumbUrl = runCatching { mediaRepository.thumbnailUrl(scope, item.id) }.getOrNull()
        previewUrl = runCatching { mediaRepository.previewUrl(scope, item.id) }.getOrNull()
    }

    LaunchedEffect(resetSignal) {
        if (resetSignal > 0) {
            scale = 1f
            offset = Offset.Zero
            onScaleChanged(1f)
        }
    }

    fun clampOffset(candidate: Offset, currentScale: Float): Offset {
        if (currentScale <= 1.01f || containerSize == IntSize.Zero) return Offset.Zero
        val maxX = ((containerSize.width * (currentScale - 1f)) / 2f).coerceAtLeast(0f)
        val maxY = ((containerSize.height * (currentScale - 1f)) / 2f).coerceAtLeast(0f)
        return Offset(
            x = candidate.x.coerceIn(-maxX, maxX),
            y = candidate.y.coerceIn(-maxY, maxY),
        )
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .onSizeChanged { containerSize = it }
            .pointerInput(item.id) {
                detectTapGestures(
                    onTap = { onSingleTap() },
                    onDoubleTap = {
                        if (scale > 1.05f) {
                            scale = 1f
                            offset = Offset.Zero
                        } else {
                            scale = 2.2f
                            offset = Offset.Zero
                        }
                        onScaleChanged(scale)
                    },
                )
            }
            .pointerInput(item.id) {
                awaitEachGesture {
                    awaitFirstDown(requireUnconsumed = false)
                    do {
                        val event = awaitPointerEvent()
                        val pointerCount = event.changes.count { it.pressed }
                        val zoomChange = event.calculateZoom()
                        val panChange = event.calculatePan()

                        if (pointerCount > 1 || scale > 1.02f) {
                            val nextScale = (scale * zoomChange).coerceIn(1f, 4f)
                            val nextOffset = if (nextScale > 1.02f) {
                                clampOffset(offset + panChange, nextScale)
                            } else {
                                Offset.Zero
                            }
                            scale = nextScale
                            offset = nextOffset
                            onScaleChanged(nextScale)
                            event.changes.forEach { change ->
                                if (change.positionChanged()) {
                                    change.consume()
                                }
                            }
                        }
                    } while (event.changes.any { it.pressed })
                }
            },
        contentAlignment = Alignment.Center,
    ) {
        val transformModifier = Modifier
            .fillMaxSize()
            .graphicsLayer {
                scaleX = scale
                scaleY = scale
                translationX = offset.x
                translationY = offset.y
            }

        // Progressive layer 1: immediate cached thumbnail
        if (!thumbUrl.isNullOrBlank() && !isPreviewLoaded) {
            AsyncImage(
                model = ImageRequest.Builder(context)
                    .data(thumbUrl)
                    .crossfade(false)
                    .build(),
                contentDescription = item.filename ?: "图片预览",
                imageLoader = imageLoader,
                contentScale = ContentScale.Fit,
                modifier = transformModifier,
            )
        }

        // Progressive layer 2: full authenticated preview
        if (!previewUrl.isNullOrBlank()) {
            AsyncImage(
                model = ImageRequest.Builder(context)
                    .data(previewUrl)
                    .crossfade(true)
                    .build(),
                contentDescription = item.filename ?: "图片原图预览",
                imageLoader = imageLoader,
                contentScale = ContentScale.Fit,
                onSuccess = {
                    isPreviewLoaded = true
                    previewFailed = false
                },
                onError = {
                    previewFailed = true
                },
                modifier = transformModifier,
            )
        }

        if (!isPreviewLoaded && !previewFailed) {
            CircularProgressIndicator(
                modifier = Modifier.size(28.dp),
                strokeWidth = 2.5.dp,
                color = DropitMediaColors.OverlayPrimary,
            )
        }

        if (previewFailed && thumbUrl.isNullOrBlank()) {
            Surface(
                shape = DropitTheme.shapes.md,
                color = Color(0xCC1D1C1A),
                tonalElevation = 0.dp,
            ) {
                Text(
                    text = "图片加载失败，请点击下方「保存原图」后查看",
                    style = MaterialTheme.typography.bodySmall,
                    color = DropitMediaColors.OverlayPrimary,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
                )
            }
        }
    }
}
