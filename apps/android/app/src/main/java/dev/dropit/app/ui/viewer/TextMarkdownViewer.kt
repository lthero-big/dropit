package dev.dropit.app.ui.viewer

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.displayCutoutPadding
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.ContentCopy
import androidx.compose.material.icons.rounded.Download
import androidx.compose.material.icons.rounded.DownloadDone
import androidx.compose.material.icons.rounded.Downloading
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Share
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.dropit.app.core.network.ClipItem
import dev.dropit.app.core.network.TargetScope
import dev.dropit.app.core.repository.MediaRepository
import dev.dropit.app.ui.board.ClipFormatting
import dev.dropit.app.ui.board.FileSaveState
import dev.dropit.app.ui.theme.DropitMono
import dev.dropit.app.ui.theme.DropitMonoTypography
import dev.dropit.app.ui.theme.DropitTheme
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext

@Composable
fun TextMarkdownViewer(
    item: ClipItem,
    nowMs: Long,
    onCopyText: (String) -> Unit,
    onShareText: (String) -> Unit,
    onOpenUrl: (String) -> Unit,
    onClose: () -> Unit,
    modifier: Modifier = Modifier,
    scope: TargetScope? = null,
    mediaRepository: MediaRepository? = null,
    fileSaveState: FileSaveState = FileSaveState.NOT_SAVED,
    onDownloadFallback: (() -> Unit)? = null,
) {
    val colors = DropitTheme.colors
    val shapes = DropitTheme.shapes
    val fontScale = LocalDensity.current.fontScale

    var remoteText by remember(item.id, scope) { mutableStateOf<String?>(null) }
    var isLoadingRemote by remember(item.id, scope) { mutableStateOf(item.isFile && scope != null && mediaRepository != null) }
    var remoteError by remember(item.id, scope) { mutableStateOf<String?>(null) }
    var reloadTick by remember(item.id, scope) { mutableStateOf(0) }

    LaunchedEffect(item.id, scope, mediaRepository, reloadTick) {
        if (item.isFile && scope != null && mediaRepository != null) {
            isLoadingRemote = true
            remoteError = null
            runCatching {
                withContext(Dispatchers.IO) {
                    mediaRepository.fetchTextContent(scope, item.id)
                }
            }.onSuccess { content ->
                remoteText = content
                isLoadingRemote = false
            }.onFailure { err ->
                remoteError = err.message?.takeIf { it.isNotBlank() } ?: "无法加载文件文本预览"
                isLoadingRemote = false
            }
        }
    }

    val fullText = if (item.isFile) remoteText.orEmpty() else item.text.orEmpty()
    val copyPayload = if (item.isFile) fullText else ClipFormatting.copyPayloadForItem(item)
    val blocks = remember(item.id, fullText) { MarkdownParser.parseBlocks(fullText) }
    val lineCount = remember(fullText) { if (fullText.isEmpty()) 0 else fullText.count { it == '\n' } + 1 }
    val charCount = remember(fullText) { fullText.length }
    val relativeTime = remember(item.createdAt, nowMs) { ClipFormatting.formatRelativeTime(item.createdAt, nowMs) }
    var copiedAll by remember(item.id) { mutableStateOf(false) }

    val maxTitleChars = if (fontScale >= 1.3f) 16 else 24
    val readerTitle = remember(item.isFile, item.filename, maxTitleChars) {
        if (item.isFile) {
            ClipFormatting.middleEllipsizeFilename(item.filename ?: "文本文件", maxTitleChars)
        } else {
            "全文阅读"
        }
    }

    LaunchedEffect(copiedAll) {
        if (copiedAll) {
            delay(1_600L)
            copiedAll = false
        }
    }

    BackHandler(onBack = onClose)

    Column(
        modifier = modifier
            .fillMaxSize()
            .background(colors.bg),
    ) {
        // Top Bar
        Surface(
            modifier = Modifier.fillMaxWidth(),
            color = colors.surface0,
            tonalElevation = 0.dp,
        ) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .statusBarsPadding()
                    .displayCutoutPadding()
                    .padding(horizontal = 6.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                IconButton(
                    onClick = onClose,
                    modifier = Modifier.size(48.dp),
                ) {
                    Icon(
                        imageVector = Icons.AutoMirrored.Rounded.ArrowBack,
                        contentDescription = "关闭全文阅读器",
                        tint = colors.fg,
                    )
                }

                Column(
                    modifier = Modifier.weight(1f),
                    verticalArrangement = Arrangement.spacedBy(2.dp),
                ) {
                    Text(
                        text = readerTitle,
                        style = MaterialTheme.typography.titleMedium,
                        color = colors.fg,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    val meta = buildList {
                        item.device?.name?.takeIf { it.isNotBlank() }?.let { add(it) }
                        if (relativeTime.isNotEmpty()) add(relativeTime)
                        if (!isLoadingRemote && remoteError == null) {
                            add("$lineCount 行 · $charCount 字")
                        }
                    }.joinToString(" · ")
                    if (meta.isNotEmpty()) {
                        Text(
                            text = meta,
                            style = DropitMonoTypography.meta,
                            color = colors.fg3,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }

                if (item.isFile && onDownloadFallback != null) {
                    val saveIcon = when (fileSaveState) {
                        FileSaveState.NOT_SAVED -> Icons.Rounded.Download
                        FileSaveState.SAVING -> Icons.Rounded.Downloading
                        FileSaveState.SAVED -> Icons.Rounded.DownloadDone
                    }
                    val saveDesc = when (fileSaveState) {
                        FileSaveState.NOT_SAVED -> "保存文件"
                        FileSaveState.SAVING -> "正在保存文件"
                        FileSaveState.SAVED -> "已保存到本地，点击打开或重新下载"
                    }
                    val saveTint = when (fileSaveState) {
                        FileSaveState.NOT_SAVED -> colors.fg2
                        FileSaveState.SAVING -> colors.brand
                        FileSaveState.SAVED -> colors.ok
                    }
                    IconButton(
                        onClick = onDownloadFallback,
                        modifier = Modifier.size(48.dp),
                    ) {
                        Icon(
                            imageVector = saveIcon,
                            contentDescription = saveDesc,
                            tint = saveTint,
                        )
                    }
                }

                IconButton(
                    onClick = { onShareText(copyPayload) },
                    enabled = !isLoadingRemote && remoteError == null && copyPayload.isNotEmpty(),
                    modifier = Modifier.size(48.dp),
                ) {
                    Icon(
                        imageVector = Icons.Rounded.Share,
                        contentDescription = "分享全文",
                        tint = colors.fg2,
                    )
                }

                TextButton(
                    onClick = {
                        onCopyText(copyPayload)
                        copiedAll = true
                    },
                    enabled = !isLoadingRemote && remoteError == null && copyPayload.isNotEmpty(),
                    modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                    colors = ButtonDefaults.textButtonColors(
                        contentColor = if (copiedAll) colors.ok else colors.brand,
                    ),
                ) {
                    Icon(
                        imageVector = if (copiedAll) Icons.Rounded.Check else Icons.Rounded.ContentCopy,
                        contentDescription = null,
                        modifier = Modifier.size(16.dp),
                    )
                    Spacer(modifier = Modifier.width(4.dp))
                    Text(
                        text = if (copiedAll) "已复制" else "复制",
                        style = MaterialTheme.typography.labelMedium,
                        fontWeight = FontWeight.SemiBold,
                        maxLines = 1,
                        softWrap = false,
                    )
                }
            }
        }
        HorizontalDivider(thickness = 1.dp, color = colors.line1)

        if (isLoadingRemote) {
            Box(
                modifier = Modifier
                    .weight(1f)
                    .fillMaxWidth(),
                contentAlignment = Alignment.Center,
            ) {
                Column(
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    CircularProgressIndicator(
                        color = colors.brand,
                        strokeWidth = 2.5.dp,
                        modifier = Modifier.size(28.dp),
                    )
                    Text(
                        text = "正在加载文本预览…",
                        style = MaterialTheme.typography.bodySmall,
                        color = colors.fg3,
                    )
                }
            }
        } else if (remoteError != null) {
            Box(
                modifier = Modifier
                    .weight(1f)
                    .fillMaxWidth()
                    .padding(24.dp),
                contentAlignment = Alignment.Center,
            ) {
                Column(
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    Text(
                        text = remoteError.orEmpty(),
                        style = MaterialTheme.typography.bodyMedium,
                        color = colors.destructive,
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        TextButton(
                            onClick = { reloadTick++ },
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
                        if (onDownloadFallback != null) {
                            val fallbackIcon = when (fileSaveState) {
                                FileSaveState.NOT_SAVED -> Icons.Rounded.Download
                                FileSaveState.SAVING -> Icons.Rounded.Downloading
                                FileSaveState.SAVED -> Icons.Rounded.DownloadDone
                            }
                            val fallbackTint = when (fileSaveState) {
                                FileSaveState.NOT_SAVED -> colors.fg2
                                FileSaveState.SAVING -> colors.brand
                                FileSaveState.SAVED -> colors.ok
                            }
                            val fallbackLabel = when (fileSaveState) {
                                FileSaveState.NOT_SAVED -> "下载文件"
                                FileSaveState.SAVING -> "保存中"
                                FileSaveState.SAVED -> "已保存"
                            }
                            TextButton(
                                onClick = onDownloadFallback,
                                modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                                colors = ButtonDefaults.textButtonColors(contentColor = fallbackTint),
                            ) {
                                Icon(
                                    imageVector = fallbackIcon,
                                    contentDescription = null,
                                    modifier = Modifier.size(16.dp),
                                )
                                Spacer(modifier = Modifier.width(4.dp))
                                Text(fallbackLabel)
                            }
                        }
                    }
                }
            }
        } else {
            // Selectable Markdown / Long Text Body
            SelectionContainer(
                modifier = Modifier
                    .weight(1f)
                    .fillMaxWidth(),
            ) {
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .verticalScroll(rememberScrollState())
                    .navigationBarsPadding()
                    .padding(horizontal = 18.dp, vertical = 16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                if (blocks.isEmpty()) {
                    Text(
                        text = fullText,
                        style = MaterialTheme.typography.bodyLarge,
                        color = colors.fg,
                    )
                } else {
                    blocks.forEach { block ->
                        when (block) {
                            is MarkdownBlock.Heading -> {
                                val style = when (block.level) {
                                    1 -> MaterialTheme.typography.titleLarge
                                    2 -> MaterialTheme.typography.titleMedium
                                    else -> MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.SemiBold)
                                }
                                Text(
                                    text = buildInlineAnnotatedString(
                                        text = block.text,
                                        linkColor = colors.brand,
                                        codeBg = colors.codeBg,
                                        codeFg = colors.fg,
                                        onOpenUrl = onOpenUrl,
                                    ),
                                    style = style,
                                    color = colors.fg,
                                )
                            }

                            is MarkdownBlock.Paragraph -> {
                                Text(
                                    text = buildInlineAnnotatedString(
                                        text = block.text,
                                        linkColor = colors.brand,
                                        codeBg = colors.codeBg,
                                        codeFg = colors.fg,
                                        onOpenUrl = onOpenUrl,
                                    ),
                                    style = MaterialTheme.typography.bodyLarge,
                                    color = colors.fg,
                                )
                            }

                            is MarkdownBlock.BlockQuote -> {
                                Row(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .height(IntrinsicSize.Min),
                                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                                ) {
                                    Box(
                                        modifier = Modifier
                                            .width(3.dp)
                                            .fillMaxHeight()
                                            .background(colors.line3),
                                    )
                                    Text(
                                        text = buildInlineAnnotatedString(
                                            text = block.text,
                                            linkColor = colors.brand,
                                            codeBg = colors.codeBg,
                                            codeFg = colors.fg2,
                                            onOpenUrl = onOpenUrl,
                                        ),
                                        style = MaterialTheme.typography.bodyMedium,
                                        color = colors.fg2,
                                        modifier = Modifier.weight(1f),
                                    )
                                }
                            }

                            is MarkdownBlock.BulletItem -> {
                                Row(
                                    modifier = Modifier.fillMaxWidth(),
                                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                                ) {
                                    Text(
                                        text = "•",
                                        style = MaterialTheme.typography.bodyLarge,
                                        color = colors.brand,
                                    )
                                    Text(
                                        text = buildInlineAnnotatedString(
                                            text = block.text,
                                            linkColor = colors.brand,
                                            codeBg = colors.codeBg,
                                            codeFg = colors.fg,
                                            onOpenUrl = onOpenUrl,
                                        ),
                                        style = MaterialTheme.typography.bodyLarge,
                                        color = colors.fg,
                                        modifier = Modifier.weight(1f),
                                    )
                                }
                            }

                            is MarkdownBlock.OrderedItem -> {
                                Row(
                                    modifier = Modifier.fillMaxWidth(),
                                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                                ) {
                                    Text(
                                        text = block.number,
                                        style = DropitMonoTypography.codeBlock,
                                        color = colors.fg3,
                                    )
                                    Text(
                                        text = buildInlineAnnotatedString(
                                            text = block.text,
                                            linkColor = colors.brand,
                                            codeBg = colors.codeBg,
                                            codeFg = colors.fg,
                                            onOpenUrl = onOpenUrl,
                                        ),
                                        style = MaterialTheme.typography.bodyLarge,
                                        color = colors.fg,
                                        modifier = Modifier.weight(1f),
                                    )
                                }
                            }

                            is MarkdownBlock.CodeBlock -> {
                                Surface(
                                    modifier = Modifier.fillMaxWidth(),
                                    shape = shapes.sm,
                                    color = colors.codeBg,
                                    border = BorderStroke(1.dp, colors.line1),
                                    tonalElevation = 0.dp,
                                ) {
                                    Column(modifier = Modifier.fillMaxWidth()) {
                                        Row(
                                            modifier = Modifier
                                                .fillMaxWidth()
                                                .padding(start = 12.dp, end = 4.dp, top = 2.dp, bottom = 2.dp),
                                            verticalAlignment = Alignment.CenterVertically,
                                            horizontalArrangement = Arrangement.SpaceBetween,
                                        ) {
                                            Text(
                                                text = block.language.ifBlank { "code" },
                                                style = DropitMonoTypography.meta,
                                                color = colors.fg3,
                                            )
                                            TextButton(
                                                onClick = { onCopyText(block.code) },
                                                modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                                                colors = ButtonDefaults.textButtonColors(contentColor = colors.fg2),
                                            ) {
                                                Text("复制代码", style = MaterialTheme.typography.labelSmall)
                                            }
                                        }
                                        HorizontalDivider(thickness = 1.dp, color = colors.line1)
                                        Box(
                                            modifier = Modifier
                                                .fillMaxWidth()
                                                .horizontalScroll(rememberScrollState())
                                                .padding(12.dp),
                                        ) {
                                            Text(
                                                text = block.code,
                                                style = DropitMonoTypography.codeBlock,
                                                color = colors.fg,
                                            )
                                        }
                                    }
                                }
                            }

                            MarkdownBlock.Divider -> {
                                HorizontalDivider(thickness = 1.dp, color = colors.line2)
                            }
                        }
                    }
                }
            }
        }
        }
    }
}

private fun buildInlineAnnotatedString(
    text: String,
    linkColor: Color,
    codeBg: Color,
    codeFg: Color,
    onOpenUrl: (String) -> Unit,
): AnnotatedString = buildAnnotatedString {
    val spans = MarkdownParser.parseInline(text)
    spans.forEach { span ->
        when (span) {
            is InlineSpan.Plain -> append(span.text)
            is InlineSpan.Bold -> {
                pushStyle(SpanStyle(fontWeight = FontWeight.SemiBold))
                append(span.text)
                pop()
            }
            is InlineSpan.Italic -> {
                pushStyle(SpanStyle(fontStyle = FontStyle.Italic))
                append(span.text)
                pop()
            }
            is InlineSpan.Code -> {
                pushStyle(
                    SpanStyle(
                        fontFamily = DropitMono,
                        background = codeBg,
                        color = codeFg,
                    ),
                )
                append(" ${span.text} ")
                pop()
            }
            is InlineSpan.Link -> {
                pushLink(
                    LinkAnnotation.Url(
                        url = span.url,
                        styles = TextLinkStyles(
                            style = SpanStyle(
                                color = linkColor,
                                textDecoration = TextDecoration.Underline,
                            ),
                        ),
                        linkInteractionListener = {
                            onOpenUrl(span.url)
                        },
                    ),
                )
                append(span.label)
                pop()
            }
        }
    }
}
