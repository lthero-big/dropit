package dev.dropit.app.ui.settings

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.widget.Toast
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.CheckCircleOutline
import androidx.compose.material.icons.rounded.Download
import androidx.compose.material.icons.rounded.ErrorOutline
import androidx.compose.material.icons.rounded.Security
import androidx.compose.material.icons.rounded.SystemUpdate
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import dev.dropit.app.BuildConfig
import dev.dropit.app.core.network.AppUpdateManifest
import dev.dropit.app.core.network.ServerUrl
import dev.dropit.app.core.repository.UpdateInstallState
import dev.dropit.app.ui.theme.DropitMonoTypography
import dev.dropit.app.ui.theme.DropitTheme
import kotlin.math.roundToInt

@Composable
fun AppUpdateDialog(
    manifest: AppUpdateManifest,
    isAutoPrompt: Boolean,
    installState: UpdateInstallState,
    onDownloadAndInstall: () -> Unit,
    onSkipVersion: () -> Unit,
    onDismiss: () -> Unit,
) {
    val colors = DropitTheme.colors
    val shapes = DropitTheme.shapes
    val context = LocalContext.current
    val isBusy = installState is UpdateInstallState.Downloading || installState is UpdateInstallState.Verifying

    AlertDialog(
        onDismissRequest = { if (!isBusy) onDismiss() },
        shape = shapes.lg,
        containerColor = colors.surface1,
        titleContentColor = colors.fg,
        textContentColor = colors.fg2,
        tonalElevation = 0.dp,
        icon = {
            Icon(
                imageVector = Icons.Rounded.SystemUpdate,
                contentDescription = null,
                tint = colors.brand,
            )
        },
        title = {
            Text(
                text = "发现新版本 ${manifest.versionName}",
                style = MaterialTheme.typography.titleMedium,
            )
        },
        text = {
            Column(
                modifier = Modifier.fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Text(
                    text = "当前 ${BuildConfig.VERSION_NAME} · 安装包 ${ServerUrl.formatSize(manifest.size)}",
                    style = DropitMonoTypography.meta,
                    color = colors.fg3,
                )

                // Release notes
                Surface(
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(min = 48.dp, max = 168.dp),
                    shape = shapes.md,
                    color = colors.surface0,
                    border = BorderStroke(1.dp, colors.line1),
                    tonalElevation = 0.dp,
                ) {
                    Text(
                        text = manifest.notes.trim().ifBlank { "包含体验优化与问题修复。" },
                        style = MaterialTheme.typography.bodySmall,
                        color = colors.fg2,
                        modifier = Modifier
                            .verticalScroll(rememberScrollState())
                            .padding(12.dp),
                    )
                }

                // Dynamic download / verification / permission / failure status
                when (installState) {
                    UpdateInstallState.Idle -> Unit

                    is UpdateInstallState.Downloading -> {
                        val pct = (installState.progress * 100f).roundToInt().coerceIn(0, 100)
                        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            LinearProgressIndicator(
                                progress = { installState.progress },
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .height(4.dp)
                                    .clip(shapes.xs),
                                color = colors.brand,
                                trackColor = colors.surface2,
                            )
                            Text(
                                text = "正在下载 $pct% · ${ServerUrl.formatSize(installState.receivedBytes)} / ${ServerUrl.formatSize(installState.totalBytes)}",
                                style = DropitMonoTypography.meta,
                                color = colors.fg2,
                            )
                        }
                    }

                    UpdateInstallState.Verifying -> {
                        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            LinearProgressIndicator(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .height(4.dp)
                                    .clip(shapes.xs),
                                color = colors.brand,
                                trackColor = colors.surface2,
                            )
                            Text(
                                text = "正在校验安装包 SHA-256 完整性…",
                                style = DropitMonoTypography.meta,
                                color = colors.fg2,
                            )
                        }
                    }

                    UpdateInstallState.NeedsInstallPermission -> {
                        Surface(
                            modifier = Modifier.fillMaxWidth(),
                            shape = shapes.md,
                            color = colors.warnSoft,
                            border = BorderStroke(1.dp, colors.warn.copy(alpha = 0.4f)),
                            tonalElevation = 0.dp,
                        ) {
                            Column(
                                modifier = Modifier.padding(12.dp),
                                verticalArrangement = Arrangement.spacedBy(8.dp),
                            ) {
                                Row(
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                                ) {
                                    Icon(
                                        imageVector = Icons.Rounded.Security,
                                        contentDescription = null,
                                        tint = colors.warn,
                                        modifier = Modifier.size(18.dp),
                                    )
                                    Text(
                                        text = "需要「安装未知应用」权限",
                                        style = MaterialTheme.typography.labelMedium,
                                        color = colors.warn,
                                        fontWeight = FontWeight.SemiBold,
                                    )
                                }
                                Text(
                                    text = "请在打开的系统设置中允许 dropit「安装未知应用」，授权后返回本页面再点一次「继续安装」（安装包已校验缓存，无需重复下载）。",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = colors.fg,
                                )
                                OutlinedButton(
                                    onClick = { openUnknownAppSourcesSettings(context) },
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .defaultMinSize(minHeight = 48.dp),
                                    shape = shapes.md,
                                    border = BorderStroke(1.dp, colors.warn),
                                    colors = ButtonDefaults.outlinedButtonColors(contentColor = colors.warn),
                                ) {
                                    Text("前往系统设置授权", fontWeight = FontWeight.SemiBold)
                                }
                            }
                        }
                    }

                    UpdateInstallState.ReadyToInstall -> {
                        Surface(
                            modifier = Modifier.fillMaxWidth(),
                            shape = shapes.md,
                            color = colors.okSoft,
                            tonalElevation = 0.dp,
                        ) {
                            Row(
                                modifier = Modifier.padding(12.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(8.dp),
                            ) {
                                Icon(
                                    imageVector = Icons.Rounded.CheckCircleOutline,
                                    contentDescription = null,
                                    tint = colors.ok,
                                    modifier = Modifier.size(18.dp),
                                )
                                Text(
                                    text = "安装包 SHA-256 校验通过，已调起系统安装界面。",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = colors.ok,
                                )
                            }
                        }
                    }

                    is UpdateInstallState.Failed -> {
                        Surface(
                            modifier = Modifier.fillMaxWidth(),
                            shape = shapes.md,
                            color = colors.brandSoft,
                            border = BorderStroke(1.dp, colors.destructive.copy(alpha = 0.4f)),
                            tonalElevation = 0.dp,
                        ) {
                            Row(
                                modifier = Modifier.padding(12.dp),
                                verticalAlignment = Alignment.Top,
                                horizontalArrangement = Arrangement.spacedBy(8.dp),
                            ) {
                                Icon(
                                    imageVector = Icons.Rounded.ErrorOutline,
                                    contentDescription = null,
                                    tint = colors.destructive,
                                    modifier = Modifier.size(18.dp),
                                )
                                Text(
                                    text = installState.message,
                                    style = MaterialTheme.typography.bodySmall,
                                    color = colors.destructive,
                                )
                            }
                        }
                    }
                }

                // Skip version action (only shown for automatic cold-start prompt per spec §2.8)
                if (isAutoPrompt && !isBusy) {
                    TextButton(
                        onClick = onSkipVersion,
                        modifier = Modifier
                            .fillMaxWidth()
                            .defaultMinSize(minHeight = 44.dp),
                        colors = ButtonDefaults.textButtonColors(contentColor = colors.fg3),
                    ) {
                        Text("跳过这个版本", style = MaterialTheme.typography.labelMedium)
                    }
                }
            }
        },
        confirmButton = {
            val primaryLabel = when (installState) {
                UpdateInstallState.NeedsInstallPermission -> "我已授权，继续安装"
                UpdateInstallState.ReadyToInstall -> "重新调起安装"
                is UpdateInstallState.Failed -> "重试下载"
                is UpdateInstallState.Downloading -> "下载中…"
                UpdateInstallState.Verifying -> "校验中…"
                UpdateInstallState.Idle -> "下载并安装"
            }
            Button(
                onClick = onDownloadAndInstall,
                enabled = !isBusy,
                modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                shape = shapes.md,
                colors = ButtonDefaults.buttonColors(
                    containerColor = colors.brand,
                    contentColor = colors.brandFg,
                ),
            ) {
                if (!isBusy) {
                    Icon(
                        imageVector = Icons.Rounded.Download,
                        contentDescription = null,
                        modifier = Modifier.size(16.dp),
                    )
                    Spacer(modifier = Modifier.width(5.dp))
                }
                Text(primaryLabel, fontWeight = FontWeight.SemiBold)
            }
        },
        dismissButton = {
            TextButton(
                onClick = onDismiss,
                enabled = !isBusy,
                modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                colors = ButtonDefaults.textButtonColors(contentColor = colors.fg2),
            ) {
                Text("稍后")
            }
        },
    )
}

private fun openUnknownAppSourcesSettings(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val intent = Intent(
        Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
        Uri.parse("package:${context.packageName}"),
    ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    runCatching {
        context.startActivity(intent)
    }.onFailure {
        Toast.makeText(context, "请手动前往系统设置开启「安装未知应用」权限", Toast.LENGTH_LONG).show()
    }
}
