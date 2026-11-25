package dev.dropit.app.ui.board

import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.InsertDriveFile
import androidx.compose.material.icons.automirrored.rounded.OpenInNew
import androidx.compose.material.icons.rounded.AudioFile
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.Code
import androidx.compose.material.icons.rounded.Computer
import androidx.compose.material.icons.rounded.ContentCopy
import androidx.compose.material.icons.rounded.Description
import androidx.compose.material.icons.rounded.Download
import androidx.compose.material.icons.rounded.FolderZip
import androidx.compose.material.icons.rounded.Image
import androidx.compose.material.icons.rounded.LaptopMac
import androidx.compose.material.icons.rounded.MoreHoriz
import androidx.compose.material.icons.rounded.PlayArrow
import androidx.compose.material.icons.rounded.PushPin
import androidx.compose.material.icons.rounded.Share
import androidx.compose.material.icons.rounded.Smartphone
import androidx.compose.material.icons.rounded.TabletMac
import androidx.compose.material.icons.rounded.VideoFile
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil.ImageLoader
import coil.compose.AsyncImage
import coil.request.ImageRequest
import dev.dropit.app.core.network.ClipItem
import dev.dropit.app.core.network.ServerUrl
import dev.dropit.app.core.network.TargetScope
import dev.dropit.app.core.repository.MediaRepository
import dev.dropit.app.ui.theme.DropitElevation
import dev.dropit.app.ui.theme.DropitMonoTypography
import dev.dropit.app.ui.theme.DropitMotion
import dev.dropit.app.ui.theme.DropitTheme
import dev.dropit.app.ui.theme.groupDotColor

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun BoardCard(
    item: ClipItem,
    isCopied: Boolean,
    nowMs: Long,
    onCopyText: (ClipItem) -> Unit,
    onDownloadFile: (ClipItem) -> Unit,
    onShareItem: (ClipItem) -> Unit,
    onOpenUrl: (String) -> Unit,
    onOpenMore: (ClipItem) -> Unit,
    modifier: Modifier = Modifier,
    activeScope: TargetScope? = null,
    mediaRepository: MediaRepository? = null,
    imageLoader: ImageLoader? = null,
    onPreviewImage: ((ClipItem) -> Unit)? = null,
    onPlayMedia: ((ClipItem, Boolean) -> Unit)? = null,
    onOpenTextReader: ((ClipItem) -> Unit)? = null,
) {
    val colors = DropitTheme.colors
    val shapes = DropitTheme.shapes
    val reducedMotion = DropitTheme.reducedMotion
    val visualKind = remember(item.id, item.kind, item.text, item.filename, item.mime, item.hasThumbnail) {
        ClipFormatting.classifyClip(item)
    }

    val borderColor by animateColorAsState(
        targetValue = if (isCopied) colors.ok.copy(alpha = 0.55f) else colors.line1,
        animationSpec = DropitMotion.fastEnter(reducedMotion),
        label = "card-border",
    )

    Surface(
        modifier = modifier.fillMaxWidth(),
        shape = shapes.md,
        color = colors.surface1,
        border = BorderStroke(1.dp, borderColor),
        shadowElevation = DropitElevation.card(colors.isDark),
        tonalElevation = 0.dp,
    ) {
        Column(modifier = Modifier.fillMaxWidth()) {
            // Card Body
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 14.dp, vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                when (visualKind) {
                    ClipVisualKind.SHORT_TEXT -> ShortTextBody(text = item.text.orEmpty())
                    ClipVisualKind.LONG_TEXT -> LongTextBody(
                        text = item.text.orEmpty(),
                        onOpenUrl = onOpenUrl,
                        onOpenReader = onOpenTextReader?.let { cb -> { cb(item) } },
                    )
                    ClipVisualKind.LINK -> LinkBody(
                        text = item.text.orEmpty(),
                        onOpenUrl = onOpenUrl,
                    )
                    ClipVisualKind.CODE -> CodeBody(
                        text = item.text.orEmpty(),
                        onOpenReader = onOpenTextReader?.let { cb -> { cb(item) } },
                    )
                    ClipVisualKind.COLOR -> ColorSwatchBody(text = item.text.orEmpty())
                    ClipVisualKind.IMAGE -> ImageFileBody(
                        item = item,
                        activeScope = activeScope,
                        mediaRepository = mediaRepository,
                        imageLoader = imageLoader,
                        onPreview = onPreviewImage?.let { cb -> { cb(item) } },
                    )
                    ClipVisualKind.VIDEO -> GenericFileBody(
                        item = item,
                        playableMedia = true,
                        onPlay = onPlayMedia?.let { cb -> { cb(item, true) } },
                    )
                    ClipVisualKind.AUDIO -> GenericFileBody(
                        item = item,
                        playableMedia = true,
                        onPlay = onPlayMedia?.let { cb -> { cb(item, false) } },
                    )
                    ClipVisualKind.FILE -> GenericFileBody(
                        item = item,
                        playableMedia = false,
                        onPlay = null,
                    )
                }

                // Metadata Footer (FlowRow supports large system font scaling cleanly)
                CardMetadataFooter(
                    item = item,
                    nowMs = nowMs,
                )
            }

            HorizontalDivider(thickness = 1.dp, color = colors.line1)

            // Touch-first Quick Actions Row (>= 48.dp hit areas)
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 4.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Row(
                    horizontalArrangement = Arrangement.spacedBy(2.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    if (item.isText) {
                        CardActionChip(
                            icon = if (isCopied) Icons.Rounded.Check else Icons.Rounded.ContentCopy,
                            label = if (isCopied) "已复制" else "复制",
                            contentDescription = "复制文本",
                            tint = if (isCopied) colors.ok else colors.fg2,
                            onClick = { onCopyText(item) },
                        )
                    } else {
                        CardActionChip(
                            icon = Icons.Rounded.Download,
                            label = "保存",
                            contentDescription = "保存文件",
                            tint = colors.fg2,
                            onClick = { onDownloadFile(item) },
                        )
                    }

                    CardActionChip(
                        icon = Icons.Rounded.Share,
                        label = "分享",
                        contentDescription = if (item.isText) "分享文本" else "分享文件",
                        tint = colors.fg2,
                        onClick = { onShareItem(item) },
                    )
                }

                CardActionChip(
                    icon = Icons.Rounded.MoreHoriz,
                    label = "更多",
                    contentDescription = "更多操作",
                    tint = colors.fg2,
                    onClick = { onOpenMore(item) },
                )
            }
        }
    }
}

@Composable
private fun ShortTextBody(text: String) {
    val colors = DropitTheme.colors
    Text(
        text = text.trim(),
        style = MaterialTheme.typography.headlineSmall,
        color = colors.fg,
    )
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun LongTextBody(
    text: String,
    onOpenUrl: (String) -> Unit,
    onOpenReader: (() -> Unit)? = null,
) {
    val colors = DropitTheme.colors
    val shapes = DropitTheme.shapes
    var expanded by rememberSaveable(text.hashCode()) { mutableStateOf(false) }
    val urls = remember(text) { ClipFormatting.extractUrls(text) }
    val isLong = text.length > 220 || text.count { it == '\n' } >= 5

    Text(
        text = text,
        style = MaterialTheme.typography.bodyLarge,
        color = colors.fg,
        maxLines = if (expanded) Int.MAX_VALUE else 6,
        overflow = TextOverflow.Ellipsis,
    )

    if (urls.isNotEmpty()) {
        FlowRow(
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            urls.take(3).forEach { url ->
                Surface(
                    modifier = Modifier
                        .clickable { onOpenUrl(url) }
                        .defaultMinSize(minHeight = 36.dp),
                    shape = shapes.sm,
                    color = colors.surface0,
                    border = BorderStroke(1.dp, colors.line2),
                    tonalElevation = 0.dp,
                ) {
                    Row(
                        modifier = Modifier.padding(horizontal = 8.dp, vertical = 6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        Icon(
                            imageVector = Icons.AutoMirrored.Rounded.OpenInNew,
                            contentDescription = "打开链接",
                            tint = colors.brand,
                            modifier = Modifier.size(13.dp),
                        )
                        Text(
                            text = url.removePrefix("https://").removePrefix("http://"),
                            style = DropitMonoTypography.meta,
                            color = colors.fg2,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }
        }
    }

    if (isLong || onOpenReader != null) {
        Row(
            horizontalArrangement = Arrangement.spacedBy(16.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (isLong) {
                Text(
                    text = if (expanded) "收起" else "展开预览",
                    style = MaterialTheme.typography.labelMedium,
                    color = colors.fg2,
                    modifier = Modifier
                        .defaultMinSize(minHeight = 36.dp)
                        .clickable { expanded = !expanded }
                        .padding(vertical = 6.dp),
                )
            }
            if (onOpenReader != null) {
                Text(
                    text = "阅读全文 / Markdown",
                    style = MaterialTheme.typography.labelMedium,
                    color = colors.brand,
                    modifier = Modifier
                        .defaultMinSize(minHeight = 36.dp)
                        .clickable(onClick = onOpenReader)
                        .padding(vertical = 6.dp),
                )
            }
        }
    }
}

@Composable
private fun LinkBody(
    text: String,
    onOpenUrl: (String) -> Unit,
) {
    val colors = DropitTheme.colors
    val shapes = DropitTheme.shapes
    val info = remember(text) { ClipFormatting.parseLink(text) }
    if (info == null) {
        ShortTextBody(text = text)
        return
    }

    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .clickable { onOpenUrl(info.rawUrl) },
        shape = shapes.sm,
        color = colors.surface0,
        border = BorderStroke(1.dp, colors.line1),
        tonalElevation = 0.dp,
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Box(
                modifier = Modifier
                    .size(36.dp)
                    .clip(shapes.sm)
                    .background(colors.brandSoft),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = info.initial,
                    style = MaterialTheme.typography.titleMedium,
                    color = colors.brand,
                    fontWeight = FontWeight.Bold,
                )
            }
            Column(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                Text(
                    text = info.host,
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.SemiBold,
                    color = colors.fg,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    text = info.displayPath,
                    style = DropitMonoTypography.url,
                    color = colors.fg3,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            Icon(
                imageVector = Icons.AutoMirrored.Rounded.OpenInNew,
                contentDescription = "在浏览器打开链接",
                tint = colors.fg3,
                modifier = Modifier.size(18.dp),
            )
        }
    }
}

@Composable
private fun CodeBody(
    text: String,
    onOpenReader: (() -> Unit)? = null,
) {
    val colors = DropitTheme.colors
    val shapes = DropitTheme.shapes
    val parsed = remember(text) { ClipFormatting.stripCodeFence(text) }
    val lines = remember(parsed.body) { parsed.body.split('\n') }
    var expanded by rememberSaveable(text.hashCode()) { mutableStateOf(false) }
    val displayLines = if (expanded) lines else lines.take(5)

    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Icon(
                imageVector = Icons.Rounded.Code,
                contentDescription = null,
                tint = colors.fg3,
                modifier = Modifier.size(14.dp),
            )
            Text(
                text = if (parsed.language.isNotBlank()) "代码 · ${parsed.language}" else "代码片段",
                style = MaterialTheme.typography.labelSmall,
                color = colors.fg3,
            )
        }

        Surface(
            modifier = Modifier.fillMaxWidth(),
            shape = shapes.sm,
            color = colors.codeBg,
            border = BorderStroke(1.dp, colors.line1),
            tonalElevation = 0.dp,
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 10.dp, vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                displayLines.forEachIndexed { idx, line ->
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        Text(
                            text = "${idx + 1}",
                            style = DropitMonoTypography.meta,
                            color = colors.fg4,
                            modifier = Modifier.width(20.dp),
                        )
                        Text(
                            text = line.ifEmpty { " " },
                            style = DropitMonoTypography.codeBlock,
                            color = colors.fg,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f),
                        )
                    }
                }
            }
        }

        if (lines.size > 5 || onOpenReader != null) {
            Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                if (lines.size > 5) {
                    Text(
                        text = if (expanded) "收起代码" else "展开全部 ${lines.size} 行",
                        style = MaterialTheme.typography.labelMedium,
                        color = colors.fg2,
                        modifier = Modifier
                            .defaultMinSize(minHeight = 36.dp)
                            .clickable { expanded = !expanded }
                            .padding(vertical = 6.dp),
                    )
                }
                if (onOpenReader != null) {
                    Text(
                        text = "全屏阅读",
                        style = MaterialTheme.typography.labelMedium,
                        color = colors.brand,
                        modifier = Modifier
                            .defaultMinSize(minHeight = 36.dp)
                            .clickable(onClick = onOpenReader)
                            .padding(vertical = 6.dp),
                    )
                }
            }
        }
    }
}

@Composable
private fun ColorSwatchBody(text: String) {
    val colors = DropitTheme.colors
    val shapes = DropitTheme.shapes
    val raw = text.trim()
    val argb = remember(raw) { ClipFormatting.parseColorToArgb(raw) }
    val swatchColor = argb?.let { Color(it) } ?: colors.surface2
    val fgOnSwatch = if (argb != null) {
        if (ClipFormatting.shouldUseLightForeground(argb)) Color.White else Color(0xFF1D1B18)
    } else {
        colors.fg
    }

    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = shapes.sm,
        color = swatchColor,
        border = BorderStroke(1.dp, colors.line2),
        tonalElevation = 0.dp,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 14.dp, vertical = 14.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Text(
                text = raw,
                style = DropitMonoTypography.codeBlock.copy(
                    fontWeight = FontWeight.SemiBold,
                    fontSize = MaterialTheme.typography.titleMedium.fontSize,
                ),
                color = fgOnSwatch,
            )
            if (argb != null) {
                Text(
                    text = ClipFormatting.formatRgbLabel(argb),
                    style = DropitMonoTypography.meta,
                    color = fgOnSwatch.copy(alpha = 0.82f),
                )
            }
        }
    }
}

@Composable
private fun ImageFileBody(
    item: ClipItem,
    activeScope: TargetScope?,
    mediaRepository: MediaRepository?,
    imageLoader: ImageLoader?,
    onPreview: (() -> Unit)?,
) {
    val colors = DropitTheme.colors
    val shapes = DropitTheme.shapes
    val context = LocalContext.current
    val filename = item.filename?.takeIf { it.isNotBlank() } ?: "未命名图片"
    val displayName = remember(filename) { ClipFormatting.middleEllipsizeFilename(filename) }
    val badge = remember(filename, item.mime) { ClipFormatting.resolveFileTypeBadge(filename, item.mime) }

    var thumbnailUrl by remember(item.id, activeScope) { mutableStateOf<String?>(null) }
    LaunchedEffect(item.id, activeScope, mediaRepository) {
        if (activeScope != null && mediaRepository != null) {
            thumbnailUrl = runCatching {
                if (item.hasThumbnail) {
                    mediaRepository.thumbnailUrl(activeScope, item.id)
                } else {
                    mediaRepository.previewUrl(activeScope, item.id)
                }
            }.getOrNull()
        }
    }

    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        // Sunken paper thumbnail slot with authenticated Coil image + lightbox click
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(168.dp)
                .clip(shapes.sm)
                .background(colors.surfaceSunken)
                .border(1.dp, colors.line1, shapes.sm)
                .then(
                    if (onPreview != null) {
                        Modifier
                            .clickable(onClick = onPreview)
                            .semantics { contentDescription = "预览图片 $filename" }
                    } else {
                        Modifier
                    },
                ),
            contentAlignment = Alignment.Center,
        ) {
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Box(
                    modifier = Modifier
                        .size(44.dp)
                        .clip(shapes.md)
                        .background(badge.tint.copy(alpha = 0.14f)),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        imageVector = Icons.Rounded.Image,
                        contentDescription = null,
                        tint = badge.tint,
                        modifier = Modifier.size(24.dp),
                    )
                }
                Text(
                    text = "${badge.ext} · ${ServerUrl.formatSize(item.size)}",
                    style = DropitMonoTypography.meta,
                    color = colors.fg3,
                )
            }

            if (!thumbnailUrl.isNullOrBlank() && imageLoader != null) {
                AsyncImage(
                    model = ImageRequest.Builder(context)
                        .data(thumbnailUrl)
                        .crossfade(true)
                        .build(),
                    contentDescription = "图片缩略图 $filename",
                    imageLoader = imageLoader,
                    contentScale = ContentScale.Crop,
                    modifier = Modifier.fillMaxWidth().height(168.dp),
                )
            }
        }

        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text(
                text = displayName,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.Medium,
                color = colors.fg,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            Spacer(modifier = Modifier.width(8.dp))
            Text(
                text = ServerUrl.formatSize(item.size),
                style = DropitMonoTypography.meta,
                color = colors.fg3,
            )
        }
    }
}

@Composable
private fun GenericFileBody(
    item: ClipItem,
    playableMedia: Boolean = false,
    onPlay: (() -> Unit)? = null,
) {
    val colors = DropitTheme.colors
    val shapes = DropitTheme.shapes
    val filename = item.filename?.takeIf { it.isNotBlank() } ?: "未命名文件"
    val displayName = remember(filename) { ClipFormatting.middleEllipsizeFilename(filename) }
    val badge = remember(filename, item.mime) { ClipFormatting.resolveFileTypeBadge(filename, item.mime) }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .then(
                if (playableMedia && onPlay != null) {
                    Modifier
                        .clip(shapes.sm)
                        .clickable(onClick = onPlay)
                        .semantics { contentDescription = "在线播放 $filename" }
                        .padding(vertical = 2.dp)
                } else {
                    Modifier
                },
            ),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Box(
            modifier = Modifier
                .size(46.dp)
                .clip(shapes.md)
                .background(badge.tint.copy(alpha = 0.14f)),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                imageVector = if (playableMedia) Icons.Rounded.PlayArrow else fileCategoryIcon(badge.category),
                contentDescription = badge.label,
                tint = badge.tint,
                modifier = Modifier.size(if (playableMedia) 28.dp else 24.dp),
            )
        }

        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Text(
                text = displayName,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.Medium,
                color = colors.fg,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Surface(
                    shape = shapes.xs,
                    color = badge.tint,
                    tonalElevation = 0.dp,
                ) {
                    Text(
                        text = badge.ext,
                        style = DropitMonoTypography.meta,
                        color = Color.White,
                        modifier = Modifier.padding(horizontal = 5.dp, vertical = 1.dp),
                    )
                }
                Text(
                    text = if (playableMedia) {
                        "${badge.label} · ${ServerUrl.formatSize(item.size)} · 点按播放"
                    } else {
                        "${badge.label} · ${ServerUrl.formatSize(item.size)}"
                    },
                    style = DropitMonoTypography.meta,
                    color = colors.fg3,
                )
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun CardMetadataFooter(
    item: ClipItem,
    nowMs: Long,
) {
    val colors = DropitTheme.colors
    val shapes = DropitTheme.shapes
    val relativeTime = remember(item.createdAt, nowMs) {
        ClipFormatting.formatRelativeTime(item.createdAt, nowMs)
    }
    val expiry = remember(item.expiresAt, nowMs) {
        ClipFormatting.formatRemainingExpiry(item.expiresAt, nowMs)
    }
    val isEdited = item.updatedAt > item.createdAt && item.createdAt > 0L

    FlowRow(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        if (item.pinned) {
            Row(
                modifier = Modifier.align(Alignment.CenterVertically),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(3.dp),
            ) {
                Icon(
                    imageVector = Icons.Rounded.PushPin,
                    contentDescription = "已置顶",
                    tint = colors.brand,
                    modifier = Modifier.size(13.dp),
                )
                Text(
                    text = "置顶",
                    style = MaterialTheme.typography.labelSmall,
                    color = colors.brand,
                )
            }
        }

        // Device indicator with semantic device color
        item.device?.let { device ->
            val devColor = colors.deviceColor(device.kind)
            Row(
                modifier = Modifier.align(Alignment.CenterVertically),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                Icon(
                    imageVector = deviceIcon(device.kind),
                    contentDescription = null,
                    tint = devColor,
                    modifier = Modifier.size(13.dp),
                )
                Text(
                    text = device.name,
                    style = MaterialTheme.typography.labelSmall,
                    color = colors.fg2,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }

        if (relativeTime.isNotEmpty()) {
            Text(
                text = relativeTime,
                style = MaterialTheme.typography.labelSmall,
                color = colors.fg3,
                modifier = Modifier.align(Alignment.CenterVertically),
            )
        }

        if (isEdited) {
            Text(
                text = "已编辑",
                style = MaterialTheme.typography.labelSmall,
                color = colors.fg4,
                modifier = Modifier.align(Alignment.CenterVertically),
            )
        }

        // Group capsule
        item.group?.takeIf { it.isNotBlank() }?.let { groupName ->
            val dotColor = groupDotColor(groupName, colors.isDark, colors.fg4)
            Surface(
                modifier = Modifier.align(Alignment.CenterVertically),
                shape = shapes.pill,
                color = colors.surface0,
                border = BorderStroke(1.dp, colors.line2),
                tonalElevation = 0.dp,
            ) {
                Row(
                    modifier = Modifier.padding(horizontal = 7.dp, vertical = 2.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    Box(
                        modifier = Modifier
                            .size(6.dp)
                            .clip(CircleShape)
                            .background(dotColor),
                    )
                    Text(
                        text = groupName,
                        style = MaterialTheme.typography.labelSmall,
                        color = colors.fg2,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }

        // Tags
        item.tags.take(3).forEach { tag ->
            Surface(
                modifier = Modifier.align(Alignment.CenterVertically),
                shape = shapes.pill,
                color = colors.surface2,
                tonalElevation = 0.dp,
            ) {
                Text(
                    text = "#$tag",
                    style = MaterialTheme.typography.labelSmall,
                    color = colors.fg3,
                    modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
                )
            }
        }

        if (expiry != null) {
            Text(
                text = expiry.label,
                style = DropitMonoTypography.meta,
                color = if (expiry.isExpiringSoon) colors.brand else colors.fg3,
                modifier = Modifier.align(Alignment.CenterVertically),
            )
        }
    }
}

@Composable
private fun CardActionChip(
    icon: ImageVector,
    label: String,
    contentDescription: String,
    tint: Color,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .defaultMinSize(minWidth = 48.dp, minHeight = 48.dp)
            .clip(DropitTheme.shapes.sm)
            .clickable(onClick = onClick)
            .padding(horizontal = 10.dp)
            .semantics { this.contentDescription = contentDescription },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        Icon(
            imageVector = icon,
            contentDescription = null,
            tint = tint,
            modifier = Modifier.size(17.dp),
        )
        Text(
            text = label,
            style = MaterialTheme.typography.labelMedium,
            color = tint,
            maxLines = 1,
            softWrap = false,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

private fun deviceIcon(kind: String?): ImageVector = when (kind?.lowercase()) {
    "mac" -> Icons.Rounded.LaptopMac
    "phone" -> Icons.Rounded.Smartphone
    "pad" -> Icons.Rounded.TabletMac
    else -> Icons.Rounded.Computer
}

private fun fileCategoryIcon(category: FileTypeCategory): ImageVector = when (category) {
    FileTypeCategory.PDF,
    FileTypeCategory.DOC,
    -> Icons.Rounded.Description
    FileTypeCategory.ARCHIVE -> Icons.Rounded.FolderZip
    FileTypeCategory.AUDIO -> Icons.Rounded.AudioFile
    FileTypeCategory.VIDEO -> Icons.Rounded.VideoFile
    FileTypeCategory.IMAGE,
    FileTypeCategory.DESIGN,
    -> Icons.Rounded.Image
    FileTypeCategory.CODE -> Icons.Rounded.Code
    FileTypeCategory.FILE -> Icons.AutoMirrored.Rounded.InsertDriveFile
}
