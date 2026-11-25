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
import androidx.compose.material.icons.rounded.Share
import androidx.compose.material3.ButtonDefaults
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
import dev.dropit.app.ui.board.ClipFormatting
import dev.dropit.app.ui.theme.DropitMono
import dev.dropit.app.ui.theme.DropitMonoTypography
import dev.dropit.app.ui.theme.DropitTheme
import kotlinx.coroutines.delay

@Composable
fun TextMarkdownViewer(
    item: ClipItem,
    nowMs: Long,
    onCopyText: (String) -> Unit,
    onShareText: (String) -> Unit,
    onOpenUrl: (String) -> Unit,
    onClose: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = DropitTheme.colors
    val shapes = DropitTheme.shapes
    val fullText = item.text.orEmpty()
    val blocks = remember(item.id, fullText) { MarkdownParser.parseBlocks(fullText) }
    val lineCount = remember(fullText) { if (fullText.isEmpty()) 0 else fullText.count { it == '\n' } + 1 }
    val charCount = remember(fullText) { fullText.length }
    val relativeTime = remember(item.createdAt, nowMs) { ClipFormatting.formatRelativeTime(item.createdAt, nowMs) }
    var copiedAll by remember(item.id) { mutableStateOf(false) }

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
                        text = "全文阅读",
                        style = MaterialTheme.typography.titleMedium,
                        color = colors.fg,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    val meta = buildList {
                        item.device?.name?.takeIf { it.isNotBlank() }?.let { add(it) }
                        if (relativeTime.isNotEmpty()) add(relativeTime)
                        add("$lineCount 行 · $charCount 字")
                    }.joinToString(" · ")
                    Text(
                        text = meta,
                        style = DropitMonoTypography.meta,
                        color = colors.fg3,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }

                IconButton(
                    onClick = { onShareText(ClipFormatting.copyPayloadForItem(item)) },
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
                        onCopyText(ClipFormatting.copyPayloadForItem(item))
                        copiedAll = true
                    },
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
                        text = if (copiedAll) "已复制" else "复制全文",
                        style = MaterialTheme.typography.labelMedium,
                        fontWeight = FontWeight.SemiBold,
                    )
                }
            }
        }
        HorizontalDivider(thickness = 1.dp, color = colors.line1)

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
                                                modifier = Modifier.defaultMinSize(minHeight = 40.dp),
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
