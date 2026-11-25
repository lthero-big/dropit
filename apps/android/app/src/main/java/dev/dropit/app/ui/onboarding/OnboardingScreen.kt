package dev.dropit.app.ui.onboarding

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.displayCutoutPadding
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.automirrored.rounded.OpenInNew
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.CloudOff
import androidx.compose.material.icons.rounded.ContentCopy
import androidx.compose.material.icons.rounded.Dns
import androidx.compose.material.icons.rounded.ErrorOutline
import androidx.compose.material.icons.rounded.Key
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.WarningAmber
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.dropit.app.BuildConfig
import dev.dropit.app.core.auth.DeviceAuthState
import dev.dropit.app.core.network.ApiErrorCode
import dev.dropit.app.core.network.ServerUrl
import dev.dropit.app.ui.theme.DropitElevation
import dev.dropit.app.ui.theme.DropitMonoTypography
import dev.dropit.app.ui.theme.DropitMotion
import dev.dropit.app.ui.theme.DropitTheme

@Composable
fun OnboardingScreen(
    viewModel: OnboardingViewModel,
    modifier: Modifier = Modifier,
) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    val colors = DropitTheme.colors
    val reducedMotion = DropitTheme.reducedMotion
    val versionLabel = remember {
        ServerUrl.versionLabel(
            version = BuildConfig.VERSION_NAME,
            commit = BuildConfig.BUILD_COMMIT,
            date = BuildConfig.BUILD_DATE,
        )
    }

    // Back from DeviceAuth returns to ServerConfig instead of exiting abruptly.
    BackHandler(enabled = state.step == OnboardingStep.DEVICE_AUTH) {
        viewModel.switchServer()
    }

    Box(
        modifier = modifier
            .fillMaxSize()
            .background(colors.bg)
            .statusBarsPadding()
            .displayCutoutPadding()
            .navigationBarsPadding()
            .imePadding(),
    ) {
        AnimatedContent(
            targetState = state.step,
            transitionSpec = {
                fadeIn(DropitMotion.baseEnter(reducedMotion)) togetherWith
                    fadeOut(DropitMotion.fastExit(reducedMotion))
            },
            label = "onboarding-step",
        ) { step ->
            when (step) {
                OnboardingStep.SERVER_CONFIG -> ServerConfigContent(
                    state = state,
                    versionLabel = versionLabel,
                    onUrlChanged = viewModel::onServerUrlChanged,
                    onSubmit = viewModel::submitServerUrl,
                )

                OnboardingStep.DEVICE_AUTH -> DeviceAuthContent(
                    state = state,
                    versionLabel = versionLabel,
                    onSwitchServer = viewModel::switchServer,
                    onRetry = { viewModel.startDeviceAuth() },
                    onBrowserOpened = viewModel::onBrowserApprovalLaunched,
                )
            }
        }
    }
}

@Composable
private fun ServerConfigContent(
    state: OnboardingUiState,
    versionLabel: String,
    onUrlChanged: (String) -> Unit,
    onSubmit: () -> Unit,
) {
    val colors = DropitTheme.colors
    val shapes = DropitTheme.shapes

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 20.dp, vertical = 24.dp),
        verticalArrangement = Arrangement.SpaceBetween,
    ) {
        Column(modifier = Modifier.fillMaxWidth()) {
            Spacer(modifier = Modifier.height(16.dp))

            // Brand masthead
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Surface(
                    shape = shapes.md,
                    color = colors.brand,
                    tonalElevation = 0.dp,
                ) {
                    Box(
                        modifier = Modifier.size(36.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            text = "d",
                            style = MaterialTheme.typography.titleLarge,
                            color = colors.brandFg,
                            fontWeight = FontWeight.Bold,
                        )
                    }
                }
                Column {
                    Text(
                        text = "dropit",
                        style = MaterialTheme.typography.titleLarge,
                        color = colors.fg,
                    )
                    Text(
                        text = "跨设备纸感云剪贴板",
                        style = MaterialTheme.typography.bodySmall,
                        color = colors.fg3,
                    )
                }
            }

            Spacer(modifier = Modifier.height(28.dp))

            Surface(
                modifier = Modifier.fillMaxWidth(),
                shape = shapes.lg,
                color = colors.surface1,
                border = BorderStroke(1.dp, colors.line1),
                shadowElevation = DropitElevation.card(colors.isDark),
                tonalElevation = 0.dp,
            ) {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(20.dp),
                    verticalArrangement = Arrangement.spacedBy(14.dp),
                ) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Icon(
                            imageVector = Icons.Rounded.Dns,
                            contentDescription = null,
                            tint = colors.brand,
                            modifier = Modifier.size(20.dp),
                        )
                        Text(
                            text = "连接 dropit 服务器",
                            style = MaterialTheme.typography.titleMedium,
                            color = colors.fg,
                        )
                    }

                    Text(
                        text = "输入你部署的服务器域名或 HTTPS 地址，无需输入协议时将自动补全 https://。",
                        style = MaterialTheme.typography.bodySmall,
                        color = colors.fg3,
                    )

                    OutlinedTextField(
                        value = state.serverUrlInput,
                        onValueChange = onUrlChanged,
                        modifier = Modifier.fillMaxWidth(),
                        enabled = !state.isVerifyingServer,
                        singleLine = true,
                        label = { Text("服务器地址") },
                        placeholder = {
                            Text(
                                text = "dropit.example.com",
                                color = colors.fg4,
                            )
                        },
                        isError = state.serverError != null && !state.isServerOffline,
                        shape = shapes.md,
                        textStyle = MaterialTheme.typography.bodyLarge.copy(color = colors.fg),
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedContainerColor = colors.surface0,
                            unfocusedContainerColor = colors.surface0,
                            focusedBorderColor = colors.line3,
                            unfocusedBorderColor = colors.line2,
                            errorBorderColor = colors.destructive,
                            focusedLabelColor = colors.fg2,
                            unfocusedLabelColor = colors.fg3,
                            cursorColor = colors.brand,
                        ),
                        keyboardOptions = KeyboardOptions(
                            keyboardType = KeyboardType.Uri,
                            capitalization = KeyboardCapitalization.None,
                            autoCorrectEnabled = false,
                            imeAction = ImeAction.Done,
                        ),
                        keyboardActions = KeyboardActions(
                            onDone = {
                                if (!state.isVerifyingServer) onSubmit()
                            },
                        ),
                    )

                    if (state.serverError != null) {
                        StatusNoticeBanner(
                            message = state.serverError,
                            isOffline = state.isServerOffline,
                            onRetry = if (state.isServerOffline) onSubmit else null,
                        )
                    }

                    Button(
                        onClick = onSubmit,
                        enabled = !state.isVerifyingServer,
                        modifier = Modifier
                            .fillMaxWidth()
                            .defaultMinSize(minHeight = 48.dp),
                        shape = shapes.md,
                        colors = ButtonDefaults.buttonColors(
                            containerColor = colors.brand,
                            contentColor = colors.brandFg,
                            disabledContainerColor = colors.brand.copy(alpha = 0.45f),
                            disabledContentColor = colors.brandFg,
                        ),
                    ) {
                        if (state.isVerifyingServer) {
                            CircularProgressIndicator(
                                modifier = Modifier.size(18.dp),
                                strokeWidth = 2.dp,
                                color = colors.brandFg,
                            )
                            Spacer(modifier = Modifier.width(10.dp))
                            Text(
                                text = "正在校验服务器…",
                                style = MaterialTheme.typography.bodyMedium,
                                fontWeight = FontWeight.Medium,
                            )
                        } else {
                            Text(
                                text = "连接服务器",
                                style = MaterialTheme.typography.bodyMedium,
                                fontWeight = FontWeight.Medium,
                            )
                        }
                    }

                    Text(
                        text = "仅允许受加密保护的 https:// 服务器；连接前会校验 /api/version 确认服务器版本。",
                        style = MaterialTheme.typography.labelSmall,
                        color = colors.fg4,
                    )
                }
            }
        }

        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(top = 24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(
                text = versionLabel,
                style = DropitMonoTypography.meta,
                color = colors.fg3,
                textAlign = TextAlign.Center,
            )
        }
    }
}

@Composable
private fun DeviceAuthContent(
    state: OnboardingUiState,
    versionLabel: String,
    onSwitchServer: () -> Unit,
    onRetry: () -> Unit,
    onBrowserOpened: () -> Unit,
) {
    val colors = DropitTheme.colors
    val shapes = DropitTheme.shapes
    val context = LocalContext.current
    val fontScale = LocalDensity.current.fontScale
    var copiedCode by remember { mutableStateOf(false) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 20.dp, vertical = 16.dp),
        verticalArrangement = Arrangement.SpaceBetween,
    ) {
        Column(modifier = Modifier.fillMaxWidth()) {
            // Top bar with switch server entry
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                TextButton(
                    onClick = onSwitchServer,
                    modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                    colors = ButtonDefaults.textButtonColors(contentColor = colors.fg2),
                ) {
                    Icon(
                        imageVector = Icons.AutoMirrored.Rounded.ArrowBack,
                        contentDescription = "更换服务器",
                        modifier = Modifier.size(18.dp),
                    )
                    Spacer(modifier = Modifier.width(6.dp))
                    Text(
                        text = "更换服务器",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }

                state.configuredServerOrigin?.let { origin ->
                    Surface(
                        shape = shapes.pill,
                        color = colors.surface0,
                        border = BorderStroke(1.dp, colors.line1),
                        tonalElevation = 0.dp,
                    ) {
                        Text(
                            text = origin.removePrefix("https://"),
                            style = DropitMonoTypography.meta,
                            color = colors.fg2,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.padding(horizontal = 10.dp, vertical = 5.dp),
                        )
                    }
                }
            }

            Spacer(modifier = Modifier.height(12.dp))

            if (state.sessionExpiredNotice) {
                Surface(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(bottom = 14.dp)
                        .semantics { liveRegion = LiveRegionMode.Polite },
                    shape = shapes.md,
                    color = colors.warnSoft,
                    border = BorderStroke(1.dp, colors.warn.copy(alpha = 0.35f)),
                    tonalElevation = 0.dp,
                ) {
                    Row(
                        modifier = Modifier.padding(14.dp),
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                        verticalAlignment = Alignment.Top,
                    ) {
                        Icon(
                            imageVector = Icons.Rounded.WarningAmber,
                            contentDescription = null,
                            tint = colors.warn,
                            modifier = Modifier.size(20.dp),
                        )
                        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            Text(
                                text = "登录已失效，请重新授权",
                                style = MaterialTheme.typography.bodyMedium,
                                fontWeight = FontWeight.SemiBold,
                                color = colors.fg,
                            )
                            Text(
                                text = "当前设备的登录令牌已失效或被撤销，已保留当前服务器地址，请在浏览器中重新确认授权。",
                                style = MaterialTheme.typography.bodySmall,
                                color = colors.fg2,
                            )
                        }
                    }
                }
            }

            // Main paper card
            Surface(
                modifier = Modifier.fillMaxWidth(),
                shape = shapes.lg,
                color = colors.surface1,
                border = BorderStroke(1.dp, colors.line1),
                shadowElevation = DropitElevation.card(colors.isDark),
                tonalElevation = 0.dp,
            ) {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(20.dp),
                    verticalArrangement = Arrangement.spacedBy(16.dp),
                ) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Icon(
                            imageVector = Icons.Rounded.Key,
                            contentDescription = null,
                            tint = colors.brand,
                            modifier = Modifier.size(20.dp),
                        )
                        Text(
                            text = "设备码授权登录",
                            style = MaterialTheme.typography.titleMedium,
                            color = colors.fg,
                        )
                    }

                    state.verifiedServer?.let { verified ->
                        Text(
                            text = "已校验服务端 ${verified.versionInfo.version}（${verified.versionInfo.install}）",
                            style = DropitMonoTypography.meta,
                            color = colors.ok,
                        )
                    }

                    when (val auth = state.deviceAuthState) {
                        DeviceAuthState.Idle,
                        DeviceAuthState.RequestingCode,
                        -> {
                            Column(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(vertical = 24.dp),
                                horizontalAlignment = Alignment.CenterHorizontally,
                                verticalArrangement = Arrangement.spacedBy(12.dp),
                            ) {
                                CircularProgressIndicator(
                                    color = colors.brand,
                                    strokeWidth = 2.5.dp,
                                    modifier = Modifier.size(28.dp),
                                )
                                Text(
                                    text = "正在向服务器申请设备授权码…",
                                    style = MaterialTheme.typography.bodyMedium,
                                    color = colors.fg2,
                                )
                            }
                        }

                        is DeviceAuthState.WaitingForApproval -> {
                            Text(
                                text = "点击下方按钮在浏览器中核对并批准设备码，批准后本页会自动完成登录。",
                                style = MaterialTheme.typography.bodySmall,
                                color = colors.fg3,
                            )

                            // Prominent monospace user_code container
                            Surface(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clickable {
                                        copyTextToClipboard(context, "dropit 设备码", auth.authorization.userCode)
                                        copiedCode = true
                                        Toast.makeText(context, "已复制设备码", Toast.LENGTH_SHORT).show()
                                    }
                                    .semantics {
                                        contentDescription = "设备授权码 ${auth.authorization.userCode}，点击复制"
                                    },
                                shape = shapes.md,
                                color = colors.codeBg,
                                border = BorderStroke(
                                    1.dp,
                                    if (copiedCode) colors.ok.copy(alpha = 0.55f) else colors.line2,
                                ),
                                tonalElevation = 0.dp,
                            ) {
                                Column(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .padding(horizontal = 16.dp, vertical = 18.dp),
                                    horizontalAlignment = Alignment.CenterHorizontally,
                                    verticalArrangement = Arrangement.spacedBy(6.dp),
                                ) {
                                    Text(
                                        text = auth.authorization.userCode,
                                        style = if (fontScale >= 1.3f) {
                                            DropitMonoTypography.deviceCodeCompact
                                        } else {
                                            DropitMonoTypography.deviceCode
                                        },
                                        color = colors.fg,
                                        textAlign = TextAlign.Center,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                    Row(
                                        verticalAlignment = Alignment.CenterVertically,
                                        horizontalArrangement = Arrangement.spacedBy(4.dp),
                                    ) {
                                        Icon(
                                            imageVector = Icons.Rounded.ContentCopy,
                                            contentDescription = null,
                                            tint = if (copiedCode) colors.ok else colors.fg3,
                                            modifier = Modifier.size(14.dp),
                                        )
                                        Text(
                                            text = if (copiedCode) "已复制授权码" else "点击复制授权码",
                                            style = MaterialTheme.typography.labelSmall,
                                            color = if (copiedCode) colors.ok else colors.fg3,
                                        )
                                    }
                                }
                            }

                            Button(
                                onClick = {
                                    openVerificationUrl(context, auth.authorization.verificationUriComplete)
                                    onBrowserOpened()
                                },
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .defaultMinSize(minHeight = 48.dp),
                                shape = shapes.md,
                                colors = ButtonDefaults.buttonColors(
                                    containerColor = colors.brand,
                                    contentColor = colors.brandFg,
                                ),
                            ) {
                                Icon(
                                    imageVector = Icons.AutoMirrored.Rounded.OpenInNew,
                                    contentDescription = null,
                                    modifier = Modifier.size(18.dp),
                                )
                                Spacer(modifier = Modifier.width(8.dp))
                                Text(
                                    text = if (state.browserOpened) "再次打开浏览器批准" else "在浏览器中批准",
                                    style = MaterialTheme.typography.bodyMedium,
                                    fontWeight = FontWeight.Medium,
                                )
                            }

                            // Polling status indicator
                            Surface(
                                modifier = Modifier.fillMaxWidth(),
                                shape = shapes.sm,
                                color = colors.surface0,
                                border = BorderStroke(1.dp, colors.line1),
                                tonalElevation = 0.dp,
                            ) {
                                Row(
                                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                                ) {
                                    CircularProgressIndicator(
                                        modifier = Modifier.size(16.dp),
                                        strokeWidth = 2.dp,
                                        color = colors.brand,
                                    )
                                    Text(
                                        text = if (state.isSlowedDown) {
                                            "等待批准中 · 已放缓轮询（每 ${auth.pollIntervalSeconds} 秒）"
                                        } else {
                                            "等待浏览器批准中 · 每 ${auth.pollIntervalSeconds} 秒自动检查"
                                        },
                                        style = MaterialTheme.typography.labelMedium,
                                        color = colors.fg2,
                                    )
                                }
                            }
                        }

                        is DeviceAuthState.Approved -> {
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(vertical = 16.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(10.dp),
                            ) {
                                Icon(
                                    imageVector = Icons.Rounded.CheckCircle,
                                    contentDescription = null,
                                    tint = colors.ok,
                                    modifier = Modifier.size(22.dp),
                                )
                                Text(
                                    text = "授权成功，正在进入云剪贴板…",
                                    style = MaterialTheme.typography.bodyMedium,
                                    color = colors.ok,
                                    fontWeight = FontWeight.Medium,
                                )
                            }
                        }

                        DeviceAuthState.Expired -> {
                            StatusNoticeBanner(
                                message = "授权码已过期，请重新获取新的设备码。",
                                isOffline = false,
                                onRetry = null,
                            )
                            Button(
                                onClick = onRetry,
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .defaultMinSize(minHeight = 48.dp),
                                shape = shapes.md,
                                colors = ButtonDefaults.buttonColors(
                                    containerColor = colors.brand,
                                    contentColor = colors.brandFg,
                                ),
                            ) {
                                Icon(
                                    imageVector = Icons.Rounded.Refresh,
                                    contentDescription = null,
                                    modifier = Modifier.size(18.dp),
                                )
                                Spacer(modifier = Modifier.width(8.dp))
                                Text("重新获取授权码")
                            }
                        }

                        DeviceAuthState.Denied -> {
                            StatusNoticeBanner(
                                message = "本次授权请求已被拒绝。如为误操作，可重新发起设备授权。",
                                isOffline = false,
                                onRetry = null,
                            )
                            Button(
                                onClick = onRetry,
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .defaultMinSize(minHeight = 48.dp),
                                shape = shapes.md,
                                colors = ButtonDefaults.buttonColors(
                                    containerColor = colors.brand,
                                    contentColor = colors.brandFg,
                                ),
                            ) {
                                Icon(
                                    imageVector = Icons.Rounded.Refresh,
                                    contentDescription = null,
                                    modifier = Modifier.size(18.dp),
                                )
                                Spacer(modifier = Modifier.width(8.dp))
                                Text("重新发起授权")
                            }
                        }

                        is DeviceAuthState.Failed -> {
                            val offline = auth.error.errorCode == ApiErrorCode.NETWORK_ERROR
                            StatusNoticeBanner(
                                message = if (offline) {
                                    "当前处于离线状态或网络中断，无法获取授权状态。"
                                } else {
                                    auth.error.userMessage
                                },
                                isOffline = offline,
                                onRetry = null,
                            )
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.spacedBy(10.dp),
                            ) {
                                Button(
                                    onClick = onRetry,
                                    modifier = Modifier
                                        .weight(1f)
                                        .defaultMinSize(minHeight = 48.dp),
                                    shape = shapes.md,
                                    colors = ButtonDefaults.buttonColors(
                                        containerColor = colors.brand,
                                        contentColor = colors.brandFg,
                                    ),
                                ) {
                                    Icon(
                                        imageVector = Icons.Rounded.Refresh,
                                        contentDescription = null,
                                        modifier = Modifier.size(18.dp),
                                    )
                                    Spacer(modifier = Modifier.width(6.dp))
                                    Text("重试")
                                }
                                OutlinedButton(
                                    onClick = onSwitchServer,
                                    modifier = Modifier
                                        .weight(1f)
                                        .defaultMinSize(minHeight = 48.dp),
                                    shape = shapes.md,
                                    border = BorderStroke(1.dp, colors.line2),
                                    colors = ButtonDefaults.outlinedButtonColors(contentColor = colors.fg2),
                                ) {
                                    Text("更换服务器")
                                }
                            }
                        }
                    }
                }
            }
        }

        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(top = 24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(
                text = versionLabel,
                style = DropitMonoTypography.meta,
                color = colors.fg3,
                textAlign = TextAlign.Center,
            )
        }
    }
}

@Composable
private fun StatusNoticeBanner(
    message: String,
    isOffline: Boolean,
    onRetry: (() -> Unit)?,
) {
    val colors = DropitTheme.colors
    val shapes = DropitTheme.shapes
    val containerColor = if (isOffline) colors.warnSoft else colors.brandSoft
    val tint = if (isOffline) colors.warn else colors.destructive

    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .semantics { liveRegion = LiveRegionMode.Polite },
        shape = shapes.md,
        color = containerColor,
        border = BorderStroke(1.dp, tint.copy(alpha = 0.35f)),
        tonalElevation = 0.dp,
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Icon(
                imageVector = if (isOffline) Icons.Rounded.CloudOff else Icons.Rounded.ErrorOutline,
                contentDescription = null,
                tint = tint,
                modifier = Modifier.size(18.dp),
            )
            Text(
                text = message,
                style = MaterialTheme.typography.bodySmall,
                color = colors.fg,
                modifier = Modifier.weight(1f),
            )
            if (onRetry != null) {
                TextButton(
                    onClick = onRetry,
                    modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                    colors = ButtonDefaults.textButtonColors(contentColor = tint),
                ) {
                    Text(
                        text = "重试",
                        style = MaterialTheme.typography.labelMedium,
                        fontWeight = FontWeight.SemiBold,
                    )
                }
            }
        }
    }
}

private fun openVerificationUrl(context: Context, url: String) {
    val uri = runCatching { Uri.parse(url) }.getOrNull() ?: return
    val launchedCustomTab = runCatching {
        val customTabs = CustomTabsIntent.Builder()
            .setShowTitle(true)
            .build()
        customTabs.launchUrl(context, uri)
    }.isSuccess
    if (!launchedCustomTab) {
        runCatching {
            val intent = Intent(Intent.ACTION_VIEW, uri).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(intent)
        }.onFailure {
            Toast.makeText(context, "未找到可用的浏览器打开授权页", Toast.LENGTH_SHORT).show()
        }
    }
}

private fun copyTextToClipboard(context: Context, label: String, text: String) {
    val manager = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return
    manager.setPrimaryClip(ClipData.newPlainText(label, text))
}
