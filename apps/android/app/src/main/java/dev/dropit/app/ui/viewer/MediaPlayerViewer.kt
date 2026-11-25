package dev.dropit.app.ui.viewer

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.content.pm.ActivityInfo
import androidx.activity.compose.BackHandler
import androidx.annotation.OptIn
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.VolumeOff
import androidx.compose.material.icons.automirrored.rounded.VolumeUp
import androidx.compose.material.icons.rounded.AudioFile
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.Download
import androidx.compose.material.icons.rounded.ErrorOutline
import androidx.compose.material.icons.rounded.Fullscreen
import androidx.compose.material.icons.rounded.FullscreenExit
import androidx.compose.material.icons.rounded.Pause
import androidx.compose.material.icons.rounded.PlayArrow
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Share
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.ui.PlayerView
import dev.dropit.app.core.network.ClipItem
import dev.dropit.app.core.network.ServerUrl
import dev.dropit.app.core.network.TargetScope
import dev.dropit.app.core.repository.MediaRepository
import dev.dropit.app.ui.board.ClipFormatting
import dev.dropit.app.ui.theme.DropitFileTypeColors
import dev.dropit.app.ui.theme.DropitMediaColors
import dev.dropit.app.ui.theme.DropitMonoTypography
import dev.dropit.app.ui.theme.DropitTheme
import kotlinx.coroutines.delay
import java.util.Locale

private val PLAYBACK_SPEEDS = listOf(1f, 1.5f, 2f)

@kotlin.OptIn(ExperimentalLayoutApi::class)
@OptIn(UnstableApi::class)
@Composable
fun MediaPlayerViewer(
    item: ClipItem,
    isVideo: Boolean,
    scope: TargetScope,
    mediaRepository: MediaRepository,
    onDownloadFallback: (ClipItem) -> Unit,
    onShareMedia: (ClipItem) -> Unit,
    onClose: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val activity = remember(context) { context.findActivity() }
    val fontScale = LocalDensity.current.fontScale
    val colors = DropitTheme.colors
    val shapes = DropitTheme.shapes

    var mediaUrl by remember(item.id, scope) { mutableStateOf<String?>(null) }
    var isPlaying by remember(item.id) { mutableStateOf(false) }
    var isBuffering by remember(item.id) { mutableStateOf(true) }
    var errorMessage by remember(item.id) { mutableStateOf<String?>(null) }
    var positionMs by remember(item.id) { mutableLongStateOf(0L) }
    var durationMs by remember(item.id) { mutableLongStateOf(0L) }
    var bufferedPercent by remember(item.id) { mutableStateOf(0) }
    var isMuted by remember(item.id) { mutableStateOf(false) }
    var speedIndex by remember(item.id) { mutableStateOf(0) }
    var isFullscreen by remember(item.id) { mutableStateOf(false) }
    var isScrubbing by remember(item.id) { mutableStateOf(false) }
    var scrubPosition by remember(item.id) { mutableFloatStateOf(0f) }

    val maxTitleChars = if (fontScale >= 1.3f) 18 else 26
    val displayName = remember(item.filename, maxTitleChars) {
        ClipFormatting.middleEllipsizeFilename(item.filename ?: if (isVideo) "视频" else "音频", maxChars = maxTitleChars)
    }

    val exoPlayer = remember(item.id, scope) {
        val dataSourceFactory = mediaRepository.createMediaDataSourceFactory()
        ExoPlayer.Builder(context.applicationContext)
            .setMediaSourceFactory(DefaultMediaSourceFactory(dataSourceFactory))
            .build()
    }

    // Load authenticated /media URL
    LaunchedEffect(item.id, scope) {
        val resolved = runCatching { mediaRepository.mediaUrl(scope, item.id) }.getOrNull()
        if (resolved.isNullOrBlank()) {
            isBuffering = false
            errorMessage = "无法解析媒体播放地址"
        } else {
            mediaUrl = resolved
            errorMessage = null
            exoPlayer.setMediaItem(MediaItem.fromUri(resolved))
            exoPlayer.prepare()
            exoPlayer.playWhenReady = true
        }
    }

    // Listen to ExoPlayer events & ensure cleanup
    DisposableEffect(exoPlayer) {
        val listener = object : Player.Listener {
            override fun onIsPlayingChanged(playing: Boolean) {
                isPlaying = playing
            }

            override fun onPlaybackStateChanged(playbackState: Int) {
                isBuffering = playbackState == Player.STATE_BUFFERING
                if (playbackState == Player.STATE_READY) {
                    durationMs = exoPlayer.duration.coerceAtLeast(0L)
                    errorMessage = null
                }
            }

            override fun onPlayerError(error: PlaybackException) {
                isBuffering = false
                errorMessage = "播放失败（${error.errorCodeName}）：可点击重试或下载后用系统播放器打开"
            }
        }
        exoPlayer.addListener(listener)
        onDispose {
            exoPlayer.removeListener(listener)
            exoPlayer.release()
        }
    }

    // Poll playback position & buffered progress smoothly
    LaunchedEffect(exoPlayer) {
        while (true) {
            if (!isScrubbing) {
                positionMs = exoPlayer.currentPosition.coerceAtLeast(0L)
                val dur = exoPlayer.duration
                if (dur > 0L) durationMs = dur
                bufferedPercent = exoPlayer.bufferedPercentage.coerceIn(0, 100)
            }
            delay(250L)
        }
    }

    // Manage landscape fullscreen & immersive system bars
    DisposableEffect(activity, isFullscreen) {
        if (activity != null) {
            val controller = WindowCompat.getInsetsController(activity.window, activity.window.decorView)
            if (isFullscreen) {
                activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                controller.systemBarsBehavior =
                    WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                controller.hide(WindowInsetsCompat.Type.systemBars())
            } else {
                activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
                controller.show(WindowInsetsCompat.Type.systemBars())
            }
        }
        onDispose {
            if (activity != null) {
                activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
                WindowCompat.getInsetsController(activity.window, activity.window.decorView)
                    .show(WindowInsetsCompat.Type.systemBars())
            }
        }
    }

    // Back stack priority §2.2: exit landscape fullscreen first, then close viewer.
    BackHandler(enabled = true) {
        if (isFullscreen) {
            isFullscreen = false
        } else {
            onClose()
        }
    }

    Box(
        modifier = modifier
            .fillMaxSize()
            .background(DropitMediaColors.LightboxScrim),
    ) {
        // Video Surface or Audio Stage
        if (isVideo) {
            AndroidView(
                factory = { ctx ->
                    PlayerView(ctx).apply {
                        useController = false
                        player = exoPlayer
                    }
                },
                update = { view ->
                    if (view.player !== exoPlayer) {
                        view.player = exoPlayer
                    }
                },
                modifier = Modifier.fillMaxSize(),
            )
        } else {
            Column(
                modifier = Modifier
                    .align(Alignment.Center)
                    .padding(horizontal = 28.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Surface(
                    modifier = Modifier.size(96.dp),
                    shape = shapes.lg,
                    color = DropitFileTypeColors.Audio.copy(alpha = 0.2f),
                    border = BorderStroke(1.dp, DropitFileTypeColors.Audio.copy(alpha = 0.45f)),
                    tonalElevation = 0.dp,
                ) {
                    Box(contentAlignment = Alignment.Center) {
                        Icon(
                            imageVector = Icons.Rounded.AudioFile,
                            contentDescription = "音频播放",
                            tint = DropitFileTypeColors.Audio,
                            modifier = Modifier.size(48.dp),
                        )
                    }
                }
                Text(
                    text = displayName,
                    style = MaterialTheme.typography.titleMedium,
                    color = DropitMediaColors.OverlayPrimary,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
                if (item.size > 0L) {
                    Text(
                        text = ServerUrl.formatSize(item.size),
                        style = DropitMonoTypography.meta,
                        color = DropitMediaColors.OverlaySecondary,
                    )
                }
            }
        }

        // Buffering spinner
        if (isBuffering && errorMessage == null) {
            CircularProgressIndicator(
                modifier = Modifier
                    .align(Alignment.Center)
                    .size(34.dp),
                strokeWidth = 3.dp,
                color = DropitMediaColors.OverlayPrimary,
            )
        }

        // Playback Error Overlay
        errorMessage?.let { err ->
            Surface(
                modifier = Modifier
                    .align(Alignment.Center)
                    .padding(horizontal = 24.dp)
                    .semantics { liveRegion = LiveRegionMode.Polite },
                shape = shapes.lg,
                color = Color(0xE61D1C1A),
                border = BorderStroke(1.dp, colors.destructive.copy(alpha = 0.5f)),
                tonalElevation = 0.dp,
            ) {
                Column(
                    modifier = Modifier.padding(18.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    Icon(
                        imageVector = Icons.Rounded.ErrorOutline,
                        contentDescription = null,
                        tint = colors.destructive,
                        modifier = Modifier.size(28.dp),
                    )
                    Text(
                        text = err,
                        style = MaterialTheme.typography.bodySmall,
                        color = DropitMediaColors.OverlayPrimary,
                    )
                    FlowRow(
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        TextButton(
                            onClick = {
                                errorMessage = null
                                isBuffering = true
                                mediaUrl?.let { url ->
                                    exoPlayer.setMediaItem(MediaItem.fromUri(url))
                                }
                                exoPlayer.prepare()
                                exoPlayer.playWhenReady = true
                            },
                            modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                            colors = ButtonDefaults.textButtonColors(contentColor = colors.brand),
                        ) {
                            Icon(
                                imageVector = Icons.Rounded.Refresh,
                                contentDescription = null,
                                modifier = Modifier.size(16.dp),
                            )
                            Spacer(modifier = Modifier.width(4.dp))
                            Text("重试", fontWeight = FontWeight.SemiBold)
                        }
                        TextButton(
                            onClick = { onDownloadFallback(item) },
                            modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                            colors = ButtonDefaults.textButtonColors(contentColor = DropitMediaColors.OverlayPrimary),
                        ) {
                            Icon(
                                imageVector = Icons.Rounded.Download,
                                contentDescription = null,
                                modifier = Modifier.size(16.dp),
                            )
                            Spacer(modifier = Modifier.width(4.dp))
                            Text("下载文件")
                        }
                    }
                }
            }
        }

        // Top Bar
        Row(
            modifier = Modifier
                .align(Alignment.TopCenter)
                .fillMaxWidth()
                .background(Color(0x990E0D0C))
                .then(if (isFullscreen) Modifier else Modifier.statusBarsPadding().displayCutoutPadding())
                .padding(horizontal = 8.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            IconButton(
                onClick = {
                    if (isFullscreen) {
                        isFullscreen = false
                    } else {
                        onClose()
                    }
                },
                modifier = Modifier.size(48.dp),
            ) {
                Icon(
                    imageVector = Icons.Rounded.Close,
                    contentDescription = if (isFullscreen) "退出全屏" else "关闭播放器",
                    tint = DropitMediaColors.OverlayPrimary,
                )
            }
            Text(
                text = displayName,
                style = MaterialTheme.typography.bodyMedium,
                color = DropitMediaColors.OverlayPrimary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            IconButton(
                onClick = { onDownloadFallback(item) },
                modifier = Modifier.size(48.dp),
            ) {
                Icon(
                    imageVector = Icons.Rounded.Download,
                    contentDescription = "保存媒体文件",
                    tint = DropitMediaColors.OverlayPrimary,
                )
            }
            IconButton(
                onClick = { onShareMedia(item) },
                modifier = Modifier.size(48.dp),
            ) {
                Icon(
                    imageVector = Icons.Rounded.Share,
                    contentDescription = "分享媒体文件",
                    tint = DropitMediaColors.OverlayPrimary,
                )
            }
        }

        // Bottom Controls Bar
        Column(
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .fillMaxWidth()
                .background(Color(0xB30E0D0C))
                .then(if (isFullscreen) Modifier else Modifier.navigationBarsPadding())
                .padding(horizontal = 14.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            val sliderValue = if (isScrubbing) {
                scrubPosition
            } else if (durationMs > 0L) {
                (positionMs.toFloat() / durationMs.toFloat()).coerceIn(0f, 1f)
            } else {
                0f
            }

            Slider(
                value = sliderValue,
                onValueChange = { fraction ->
                    isScrubbing = true
                    scrubPosition = fraction
                },
                onValueChangeFinished = {
                    if (durationMs > 0L) {
                        val targetMs = (scrubPosition * durationMs).toLong().coerceIn(0L, durationMs)
                        exoPlayer.seekTo(targetMs)
                        positionMs = targetMs
                    }
                    isScrubbing = false
                },
                enabled = durationMs > 0L,
                colors = SliderDefaults.colors(
                    thumbColor = colors.brand,
                    activeTrackColor = colors.brand,
                    inactiveTrackColor = Color(0x4DFFFFFF),
                ),
            )

            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    IconButton(
                        onClick = {
                            if (exoPlayer.isPlaying) {
                                exoPlayer.pause()
                            } else {
                                if (exoPlayer.playbackState == Player.STATE_ENDED) {
                                    exoPlayer.seekTo(0L)
                                }
                                exoPlayer.play()
                            }
                        },
                        modifier = Modifier.size(48.dp),
                    ) {
                        Icon(
                            imageVector = if (isPlaying) Icons.Rounded.Pause else Icons.Rounded.PlayArrow,
                            contentDescription = if (isPlaying) "暂停" else "播放",
                            tint = DropitMediaColors.OverlayPrimary,
                            modifier = Modifier.size(28.dp),
                        )
                    }

                    val displayedPosMs = if (isScrubbing && durationMs > 0L) {
                        (scrubPosition * durationMs).toLong()
                    } else {
                        positionMs
                    }
                    val timeLabel = if (isBuffering && bufferedPercent in 1..99) {
                        "${formatMediaTime(displayedPosMs)} / ${formatMediaTime(durationMs)} · 缓冲 $bufferedPercent%"
                    } else {
                        "${formatMediaTime(displayedPosMs)} / ${formatMediaTime(durationMs)}"
                    }
                    Text(
                        text = timeLabel,
                        style = DropitMonoTypography.meta,
                        color = DropitMediaColors.OverlayPrimary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }

                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(2.dp),
                ) {
                    // Playback speed toggle (1x / 1.5x / 2x)
                    TextButton(
                        onClick = {
                            speedIndex = (speedIndex + 1) % PLAYBACK_SPEEDS.size
                            exoPlayer.setPlaybackSpeed(PLAYBACK_SPEEDS[speedIndex])
                        },
                        modifier = Modifier.defaultMinSize(minWidth = 48.dp, minHeight = 48.dp),
                        colors = ButtonDefaults.textButtonColors(contentColor = DropitMediaColors.OverlayPrimary),
                    ) {
                        val speed = PLAYBACK_SPEEDS[speedIndex]
                        val label = if (speed == 1f) "1x" else if (speed == 2f) "2x" else "1.5x"
                        Text(text = label, style = DropitMonoTypography.meta)
                    }

                    // Mute toggle
                    IconButton(
                        onClick = {
                            isMuted = !isMuted
                            exoPlayer.volume = if (isMuted) 0f else 1f
                        },
                        modifier = Modifier.size(48.dp),
                    ) {
                        Icon(
                            imageVector = if (isMuted) {
                                Icons.AutoMirrored.Rounded.VolumeOff
                            } else {
                                Icons.AutoMirrored.Rounded.VolumeUp
                            },
                            contentDescription = if (isMuted) "取消静音" else "静音",
                            tint = DropitMediaColors.OverlayPrimary,
                        )
                    }

                    // Fullscreen landscape toggle (for video)
                    if (isVideo) {
                        IconButton(
                            onClick = { isFullscreen = !isFullscreen },
                            modifier = Modifier.size(48.dp),
                        ) {
                            Icon(
                                imageVector = if (isFullscreen) {
                                    Icons.Rounded.FullscreenExit
                                } else {
                                    Icons.Rounded.Fullscreen
                                },
                                contentDescription = if (isFullscreen) "退出全屏" else "全屏播放",
                                tint = DropitMediaColors.OverlayPrimary,
                            )
                        }
                    }
                }
            }
        }
    }
}

internal fun formatMediaTime(ms: Long): String {
    val totalSeconds = (ms / 1000L).coerceAtLeast(0L)
    val hours = totalSeconds / 3600L
    val minutes = (totalSeconds % 3600L) / 60L
    val seconds = totalSeconds % 60L
    return if (hours > 0L) {
        String.format(Locale.US, "%d:%02d:%02d", hours, minutes, seconds)
    } else {
        String.format(Locale.US, "%02d:%02d", minutes, seconds)
    }
}

private tailrec fun Context.findActivity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.findActivity()
    else -> null
}
