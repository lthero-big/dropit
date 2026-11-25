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
import androidx.compose.animation.AnimatedVisibility
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
import androidx.compose.material.icons.rounded.ExpandLess
import androidx.compose.material.icons.rounded.ExpandMore
import androidx.compose.material.icons.rounded.Language
import androidx.compose.material.icons.rounded.Login
import androidx.compose.material.icons.rounded.QrCode2
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Visibility
import androidx.compose.material.icons.rounded.VisibilityOff
import androidx.compose.material.icons.rounded.WarningAmber
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
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
import androidx.compose.ui.focus.FocusDirection
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.dropit.app.BuildConfig
import dev.dropit.app.core.auth.DeviceAuthState
import dev.dropit.app.core.network.ApiErrorCode
import dev.dropit.app.core.network.ServerUrl
import dev.dropit.app.ui.theme.DropitBrandLockup
import dev.dropit.app.ui.theme.DropitBrandMark
import dev.dropit.app.ui.theme.DropitElevation
import dev.dropit.app.ui.theme.DropitMonoTypography
import dev.dropit.app.ui.theme.DropitMotion
import dev.dropit.app.ui.theme.DropitTheme

@Composable
fun OnboardingScreen(
    viewModel: OnboardingViewModel,
    modifier: Modifier = Modifier,
    applyStatusBarsPadding: Boolean = true,
) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    val colors = DropitTheme.colors
    val reducedMotion = DropitTheme.reducedMotion
    val context = LocalContext.current
    val versionLabel = remember {
        ServerUrl.versionLabel(
            version = BuildConfig.VERSION_NAME,
            commit = BuildConfig.BUILD_COMMIT,
            date = BuildConfig.BUILD_DATE,
        )
    }

    LaunchedEffect(state.pendingOAuthLaunchUrl) {
        val url = state.pendingOAuthLaunchUrl ?: return@LaunchedEffect
        viewModel.consumePendingOAuthLaunchUrl()
        openCustomTabUrl(context, url)
    }

    // Back from sign-in screen returns to ServerConfig instead of exiting abruptly.
    BackHandler(enabled = state.step == OnboardingStep.DEVICE_AUTH) {
        viewModel.switchServer()
    }

    Box(
        modifier = modifier
            .fillMaxSize()
            .background(colors.bg)
            .then(if (applyStatusBarsPadding) Modifier.statusBarsPadding() else Modifier)
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

                OnboardingStep.DEVICE_AUTH -> NativeSignInContent(
                    state = state,
                    versionLabel = versionLabel,
                    onSwitchServer = viewModel::switchServer,
                    onReloadProviders = { viewModel.loadProviders(force = true) },
                    onStartOAuth = viewModel::startOAuthLogin,
                    onCancelOAuth = viewModel::cancelOAuthLogin,
                    onEmailChanged = viewModel::onEmailChanged,
                    onPasswordChanged = viewModel::onPasswordChanged,
                    onSubmitPasswordLogin = viewModel::submitPasswordLogin,
                    onToggleDeviceCode = viewModel::toggleDeviceCodeSection,
                    onRetryDeviceAuth = { viewModel.startDeviceAuth() },
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

            DropitBrandLockup(
                markSize = 40.dp,
                subtitle = "跨设备纸感云剪贴板",
            )

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
                        colors = paperFieldColors(),
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
                        color = colors.fg3,
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
private fun NativeSignInContent(
    state: OnboardingUiState,
    versionLabel: String,
    onSwitchServer: () -> Unit,
    onReloadProviders: () -> Unit,
    onStartOAuth: (String) -> Unit,
    onCancelOAuth: () -> Unit,
    onEmailChanged: (String) -> Unit,
    onPasswordChanged: (String) -> Unit,
    onSubmitPasswordLogin: () -> Unit,
    onToggleDeviceCode: () -> Unit,
    onRetryDeviceAuth: () -> Unit,
    onBrowserOpened: () -> Unit,
) {
    val colors = DropitTheme.colors
    val shapes = DropitTheme.shapes
    val focusManager = LocalFocusManager.current
    var passwordVisible by remember { mutableStateOf(false) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 20.dp, vertical = 16.dp),
        verticalArrangement = Arrangement.SpaceBetween,
    ) {
        Column(
            modifier = Modifier.fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            // Top bar with switch server entry
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
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
                        maxLines = 1,
                        softWrap = false,
                    )
                }

                Spacer(modifier = Modifier.weight(1f))

                state.configuredServerOrigin?.let { origin ->
                    Surface(
                        modifier = Modifier.weight(1f, fill = false),
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

            if (state.sessionExpiredNotice) {
                Surface(
                    modifier = Modifier
                        .fillMaxWidth()
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
                                text = "登录已失效，请重新登录",
                                style = MaterialTheme.typography.bodyMedium,
                                fontWeight = FontWeight.SemiBold,
                                color = colors.fg,
                            )
                            Text(
                                text = "当前设备的登录令牌已失效或被撤销，已保留当前服务器地址，请使用密码或第三方账号重新登录。",
                                style = MaterialTheme.typography.bodySmall,
                                color = colors.fg2,
                            )
                        }
                    }
                }
            }

            // Main Native Login Paper Card
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
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        DropitBrandMark(size = 28.dp)
                        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            Text(
                                text = "登录 dropit",
                                style = MaterialTheme.typography.titleMedium,
                                color = colors.fg,
                            )
                            state.verifiedServer?.let { verified ->
                                Text(
                                    text = "服务端 ${verified.versionInfo.version}（${verified.versionInfo.install}）",
                                    style = DropitMonoTypography.meta,
                                    color = colors.ok,
                                )
                            }
                        }
                    }

                    if (state.isLoadingProviders && state.providersInfo == null) {
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(10.dp),
                        ) {
                            CircularProgressIndicator(
                                modifier = Modifier.size(16.dp),
                                strokeWidth = 2.dp,
                                color = colors.brand,
                            )
                            Text(
                                text = "正在读取服务器支持的登录方式…",
                                style = MaterialTheme.typography.bodySmall,
                                color = colors.fg3,
                            )
                        }
                    } else if (state.providersError != null) {
                        StatusNoticeBanner(
                            message = "无法读取第三方登录配置：${state.providersError}",
                            isOffline = true,
                            onRetry = onReloadProviders,
                        )
                    }

                    if (state.providersInfo?.setupRequired == true) {
                        Surface(
                            modifier = Modifier.fillMaxWidth(),
                            shape = shapes.md,
                            color = colors.warnSoft,
                            border = BorderStroke(1.dp, colors.warn.copy(alpha = 0.35f)),
                            tonalElevation = 0.dp,
                        ) {
                            Text(
                                text = "该服务器尚未完成首次管理员初始化，请先在浏览器打开服务器地址完成 /setup 设置。",
                                style = MaterialTheme.typography.bodySmall,
                                color = colors.fg,
                                modifier = Modifier.padding(12.dp),
                            )
                        }
                    }

                    // 1. Dynamic OAuth Providers (GitHub / Google)
                    if (state.enabledOAuthProviders.isNotEmpty()) {
                        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                            state.enabledOAuthProviders.forEach { provider ->
                                val label = when (provider) {
                                    "github" -> "使用 GitHub 登录"
                                    "google" -> "使用 Google 登录"
                                    else -> "使用 ${provider.replaceFirstChar { it.uppercase() }} 登录"
                                }
                                val isActiveThis = state.activeOAuthProvider == provider
                                OutlinedButton(
                                    onClick = { onStartOAuth(provider) },
                                    enabled = !state.isBusySigningIn,
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .defaultMinSize(minHeight = 48.dp),
                                    shape = shapes.md,
                                    border = BorderStroke(
                                        1.dp,
                                        if (isActiveThis) colors.brand else colors.line2,
                                    ),
                                    colors = ButtonDefaults.outlinedButtonColors(
                                        containerColor = if (isActiveThis) colors.brandSoft else colors.surface0,
                                        contentColor = colors.fg,
                                    ),
                                ) {
                                    if (isActiveThis && state.isExchangingOAuthCode) {
                                        CircularProgressIndicator(
                                            modifier = Modifier.size(16.dp),
                                            strokeWidth = 2.dp,
                                            color = colors.brand,
                                        )
                                        Spacer(modifier = Modifier.width(8.dp))
                                        Text("正在完成登录…", fontWeight = FontWeight.Medium)
                                    } else {
                                        Icon(
                                            imageVector = if (provider == "github") Icons.Rounded.Login else Icons.Rounded.Language,
                                            contentDescription = null,
                                            tint = if (provider == "github") colors.fg else colors.brand,
                                            modifier = Modifier.size(18.dp),
                                        )
                                        Spacer(modifier = Modifier.width(8.dp))
                                        Text(
                                            text = label,
                                            style = MaterialTheme.typography.bodyMedium,
                                            fontWeight = FontWeight.Medium,
                                        )
                                    }
                                }
                            }
                        }
                    }

                    // Active OAuth waiting notice
                    if (state.activeOAuthProvider != null && !state.isExchangingOAuthCode) {
                        val providerName = when (state.activeOAuthProvider) {
                            "github" -> "GitHub"
                            "google" -> "Google"
                            else -> state.activeOAuthProvider
                        }
                        Surface(
                            modifier = Modifier.fillMaxWidth(),
                            shape = shapes.md,
                            color = colors.surface0,
                            border = BorderStroke(1.dp, colors.line2),
                            tonalElevation = 0.dp,
                        ) {
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(horizontal = 12.dp, vertical = 10.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(10.dp),
                            ) {
                                CircularProgressIndicator(
                                    modifier = Modifier.size(16.dp),
                                    strokeWidth = 2.dp,
                                    color = colors.brand,
                                )
                                Text(
                                    text = "正在等待 $providerName 浏览器授权回跳…",
                                    style = MaterialTheme.typography.labelMedium,
                                    color = colors.fg2,
                                    modifier = Modifier.weight(1f),
                                )
                                TextButton(
                                    onClick = onCancelOAuth,
                                    modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                                    colors = ButtonDefaults.textButtonColors(contentColor = colors.fg3),
                                ) {
                                    Text("取消")
                                }
                            }
                        }
                    }

                    // Divider between OAuth and Password
                    if (state.enabledOAuthProviders.isNotEmpty() && state.isPasswordEnabled) {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(10.dp),
                        ) {
                            HorizontalDivider(modifier = Modifier.weight(1f), thickness = 1.dp, color = colors.line1)
                            Text(
                                text = "或使用邮箱密码登录",
                                style = MaterialTheme.typography.labelSmall,
                                color = colors.fg3,
                            )
                            HorizontalDivider(modifier = Modifier.weight(1f), thickness = 1.dp, color = colors.line1)
                        }
                    }

                    // 2. Email + Password Form
                    if (state.isPasswordEnabled) {
                        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                            OutlinedTextField(
                                value = state.emailInput,
                                onValueChange = onEmailChanged,
                                modifier = Modifier.fillMaxWidth(),
                                enabled = !state.isBusySigningIn,
                                singleLine = true,
                                label = { Text("邮箱") },
                                placeholder = { Text("you@example.com", color = colors.fg4) },
                                shape = shapes.md,
                                textStyle = MaterialTheme.typography.bodyLarge.copy(color = colors.fg),
                                colors = paperFieldColors(),
                                keyboardOptions = KeyboardOptions(
                                    keyboardType = KeyboardType.Email,
                                    capitalization = KeyboardCapitalization.None,
                                    autoCorrectEnabled = false,
                                    imeAction = ImeAction.Next,
                                ),
                                keyboardActions = KeyboardActions(
                                    onNext = { focusManager.moveFocus(FocusDirection.Down) },
                                ),
                            )

                            OutlinedTextField(
                                value = state.passwordInput,
                                onValueChange = onPasswordChanged,
                                modifier = Modifier.fillMaxWidth(),
                                enabled = !state.isBusySigningIn,
                                singleLine = true,
                                label = { Text("密码") },
                                placeholder = { Text("输入账户密码", color = colors.fg4) },
                                visualTransformation = if (passwordVisible) {
                                    VisualTransformation.None
                                } else {
                                    PasswordVisualTransformation()
                                },
                                trailingIcon = {
                                    IconButton(
                                        onClick = { passwordVisible = !passwordVisible },
                                        modifier = Modifier.defaultMinSize(minWidth = 48.dp, minHeight = 48.dp),
                                    ) {
                                        Icon(
                                            imageVector = if (passwordVisible) {
                                                Icons.Rounded.VisibilityOff
                                            } else {
                                                Icons.Rounded.Visibility
                                            },
                                            contentDescription = if (passwordVisible) "隐藏密码" else "显示密码",
                                            tint = colors.fg3,
                                        )
                                    }
                                },
                                shape = shapes.md,
                                textStyle = MaterialTheme.typography.bodyLarge.copy(color = colors.fg),
                                colors = paperFieldColors(),
                                keyboardOptions = KeyboardOptions(
                                    keyboardType = KeyboardType.Password,
                                    capitalization = KeyboardCapitalization.None,
                                    autoCorrectEnabled = false,
                                    imeAction = ImeAction.Done,
                                ),
                                keyboardActions = KeyboardActions(
                                    onDone = {
                                        focusManager.clearFocus()
                                        onSubmitPasswordLogin()
                                    },
                                ),
                            )

                            if (state.authError != null) {
                                StatusNoticeBanner(
                                    message = state.authError,
                                    isOffline = state.isAuthOffline,
                                    onRetry = null,
                                )
                            }

                            Button(
                                onClick = {
                                    focusManager.clearFocus()
                                    onSubmitPasswordLogin()
                                },
                                enabled = !state.isBusySigningIn,
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
                                if (state.isPasswordLoginInProgress) {
                                    CircularProgressIndicator(
                                        modifier = Modifier.size(18.dp),
                                        strokeWidth = 2.dp,
                                        color = colors.brandFg,
                                    )
                                    Spacer(modifier = Modifier.width(8.dp))
                                    Text("正在登录…", fontWeight = FontWeight.Medium)
                                } else {
                                    Text("登录", fontWeight = FontWeight.Medium)
                                }
                            }
                        }
                    } else if (state.authError != null) {
                        StatusNoticeBanner(
                            message = state.authError,
                            isOffline = state.isAuthOffline,
                            onRetry = null,
                        )
                    }
                }
            }

            // 3. Secondary collapsible Device Code login card
            Surface(
                modifier = Modifier.fillMaxWidth(),
                shape = shapes.lg,
                color = colors.surface1,
                border = BorderStroke(1.dp, colors.line1),
                tonalElevation = 0.dp,
            ) {
                Column(modifier = Modifier.fillMaxWidth()) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .defaultMinSize(minHeight = 52.dp)
                            .clickable(onClick = onToggleDeviceCode)
                            .padding(horizontal = 16.dp, vertical = 12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        Icon(
                            imageVector = Icons.Rounded.QrCode2,
                            contentDescription = null,
                            tint = colors.fg2,
                            modifier = Modifier.size(20.dp),
                        )
                        Column(
                            modifier = Modifier.weight(1f),
                            verticalArrangement = Arrangement.spacedBy(2.dp),
                        ) {
                            Text(
                                text = "使用设备码登录",
                                style = MaterialTheme.typography.bodyMedium,
                                fontWeight = FontWeight.Medium,
                                color = colors.fg,
                            )
                            Text(
                                text = "适合在另一台已登录设备或浏览器代为批准（仅剪贴板同步权限）",
                                style = MaterialTheme.typography.labelSmall,
                                color = colors.fg3,
                            )
                        }
                        Icon(
                            imageVector = if (state.isDeviceCodeExpanded) {
                                Icons.Rounded.ExpandLess
                            } else {
                                Icons.Rounded.ExpandMore
                            },
                            contentDescription = if (state.isDeviceCodeExpanded) "收起设备码登录" else "展开设备码登录",
                            tint = colors.fg3,
                            modifier = Modifier.size(20.dp),
                        )
                    }

                    AnimatedVisibility(visible = state.isDeviceCodeExpanded) {
                        Column(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(start = 16.dp, end = 16.dp, bottom = 16.dp),
                            verticalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            HorizontalDivider(thickness = 1.dp, color = colors.line1)
                            DeviceCodeFallbackContent(
                                state = state,
                                onRetry = onRetryDeviceAuth,
                                onSwitchServer = onSwitchServer,
                                onBrowserOpened = onBrowserOpened,
                            )
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
private fun DeviceCodeFallbackContent(
    state: OnboardingUiState,
    onRetry: () -> Unit,
    onSwitchServer: () -> Unit,
    onBrowserOpened: () -> Unit,
) {
    val colors = DropitTheme.colors
    val shapes = DropitTheme.shapes
    val context = LocalContext.current
    val fontScale = LocalDensity.current.fontScale
    val currentUserCode = (state.deviceAuthState as? DeviceAuthState.WaitingForApproval)?.authorization?.userCode
    var copiedCode by remember(currentUserCode) { mutableStateOf(false) }

    when (val auth = state.deviceAuthState) {
        DeviceAuthState.Idle,
        DeviceAuthState.RequestingCode,
        -> {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(vertical = 16.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                CircularProgressIndicator(
                    color = colors.brand,
                    strokeWidth = 2.5.dp,
                    modifier = Modifier.size(24.dp),
                )
                Text(
                    text = "正在向服务器申请设备授权码…",
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.fg2,
                )
            }
        }

        is DeviceAuthState.WaitingForApproval -> {
            Text(
                text = "点击下方按钮在浏览器中核对并批准设备码，批准后会自动完成登录。",
                style = MaterialTheme.typography.bodySmall,
                color = colors.fg3,
            )

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
                        .padding(horizontal = 16.dp, vertical = 16.dp),
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

            OutlinedButton(
                onClick = {
                    openCustomTabUrl(context, auth.authorization.verificationUriComplete)
                    onBrowserOpened()
                },
                modifier = Modifier
                    .fillMaxWidth()
                    .defaultMinSize(minHeight = 48.dp),
                shape = shapes.md,
                border = BorderStroke(1.dp, colors.line2),
                colors = ButtonDefaults.outlinedButtonColors(contentColor = colors.fg),
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
                            "等待批准中 · 每 ${auth.pollIntervalSeconds} 秒自动检查"
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
                    .padding(vertical = 12.dp),
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
            OutlinedButton(
                onClick = onRetry,
                modifier = Modifier
                    .fillMaxWidth()
                    .defaultMinSize(minHeight = 48.dp),
                shape = shapes.md,
                border = BorderStroke(1.dp, colors.line2),
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
            OutlinedButton(
                onClick = onRetry,
                modifier = Modifier
                    .fillMaxWidth()
                    .defaultMinSize(minHeight = 48.dp),
                shape = shapes.md,
                border = BorderStroke(1.dp, colors.line2),
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
                OutlinedButton(
                    onClick = onRetry,
                    modifier = Modifier
                        .weight(1f)
                        .defaultMinSize(minHeight = 48.dp),
                    shape = shapes.md,
                    border = BorderStroke(1.dp, colors.line2),
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

@Composable
private fun paperFieldColors() = OutlinedTextFieldDefaults.colors(
    focusedContainerColor = DropitTheme.colors.surface0,
    unfocusedContainerColor = DropitTheme.colors.surface0,
    focusedBorderColor = DropitTheme.colors.line3,
    unfocusedBorderColor = DropitTheme.colors.line2,
    errorBorderColor = DropitTheme.colors.destructive,
    focusedLabelColor = DropitTheme.colors.fg2,
    unfocusedLabelColor = DropitTheme.colors.fg3,
    cursorColor = DropitTheme.colors.brand,
)

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
                    Text("重试", fontWeight = FontWeight.SemiBold)
                }
            }
        }
    }
}

private fun copyTextToClipboard(context: Context, label: String, text: String) {
    val manager = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return
    manager.setPrimaryClip(ClipData.newPlainText(label, text))
}

private fun openCustomTabUrl(context: Context, rawUrl: String) {
    val uri = runCatching { Uri.parse(rawUrl) }.getOrNull() ?: return
    val opened = runCatching {
        CustomTabsIntent.Builder()
            .setShowTitle(true)
            .build()
            .launchUrl(context, uri)
    }.isSuccess
    if (!opened) {
        runCatching {
            context.startActivity(Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }.onFailure {
            Toast.makeText(context, "未找到可用的浏览器", Toast.LENGTH_SHORT).show()
        }
    }
}
