package dev.dropit.app.ui.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Visibility
import androidx.compose.material.icons.rounded.VisibilityOff
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.DialogProperties
import dev.dropit.app.core.network.ApiError
import dev.dropit.app.data.account.AccountSettingsRepository
import dev.dropit.app.ui.theme.DropitTheme
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Blocking native forced password change dialog shown whenever the server reports
 * `mustChangePassword == true` (e.g. after logging in with an admin-issued temporary password).
 */
@Composable
fun ForcePasswordChangeDialog(
    accountSettingsRepository: AccountSettingsRepository,
    onPasswordChanged: () -> Unit,
    onSwitchAccount: () -> Unit,
) {
    val colors = DropitTheme.colors
    val shapes = DropitTheme.shapes
    val scope = rememberCoroutineScope()

    var currentPassword by remember { mutableStateOf("") }
    var newPassword by remember { mutableStateOf("") }
    var confirmPassword by remember { mutableStateOf("") }
    var showPasswords by remember { mutableStateOf(false) }
    var isSubmitting by remember { mutableStateOf(false) }
    var errorMessage by remember { mutableStateOf<String?>(null) }

    val fieldColors = OutlinedTextFieldDefaults.colors(
        focusedContainerColor = colors.surface0,
        unfocusedContainerColor = colors.surface0,
        focusedBorderColor = colors.line3,
        unfocusedBorderColor = colors.line2,
        focusedLabelColor = colors.fg2,
        unfocusedLabelColor = colors.fg3,
        cursorColor = colors.brand,
    )

    val visualTransformation = if (showPasswords) {
        VisualTransformation.None
    } else {
        PasswordVisualTransformation()
    }

    AlertDialog(
        onDismissRequest = { /* Blocking until password is changed or account switched */ },
        properties = DialogProperties(
            dismissOnBackPress = false,
            dismissOnClickOutside = false,
        ),
        shape = shapes.lg,
        containerColor = colors.surface1,
        titleContentColor = colors.fg,
        textContentColor = colors.fg2,
        tonalElevation = 0.dp,
        title = {
            Text(
                text = "请先修改临时密码",
                style = MaterialTheme.typography.titleMedium,
            )
        },
        text = {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Text(
                    text = "你的账号当前使用临时密码登录。请设置至少 8 位的新密码后再继续使用。",
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.fg2,
                )

                OutlinedTextField(
                    value = currentPassword,
                    onValueChange = {
                        currentPassword = it
                        errorMessage = null
                    },
                    modifier = Modifier.fillMaxWidth(),
                    enabled = !isSubmitting,
                    singleLine = true,
                    label = { Text("当前临时密码") },
                    visualTransformation = visualTransformation,
                    trailingIcon = {
                        IconButton(
                            onClick = { showPasswords = !showPasswords },
                            modifier = Modifier.defaultMinSize(minWidth = 48.dp, minHeight = 48.dp),
                        ) {
                            Icon(
                                imageVector = if (showPasswords) Icons.Rounded.VisibilityOff else Icons.Rounded.Visibility,
                                contentDescription = if (showPasswords) "隐藏密码" else "显示密码",
                                tint = colors.fg3,
                            )
                        }
                    },
                    shape = shapes.md,
                    colors = fieldColors,
                    keyboardOptions = KeyboardOptions(
                        keyboardType = KeyboardType.Password,
                        imeAction = ImeAction.Next,
                    ),
                )

                OutlinedTextField(
                    value = newPassword,
                    onValueChange = {
                        newPassword = it
                        errorMessage = null
                    },
                    modifier = Modifier.fillMaxWidth(),
                    enabled = !isSubmitting,
                    singleLine = true,
                    label = { Text("新密码（至少 8 位）") },
                    visualTransformation = visualTransformation,
                    shape = shapes.md,
                    colors = fieldColors,
                    keyboardOptions = KeyboardOptions(
                        keyboardType = KeyboardType.Password,
                        imeAction = ImeAction.Next,
                    ),
                )

                OutlinedTextField(
                    value = confirmPassword,
                    onValueChange = {
                        confirmPassword = it
                        errorMessage = null
                    },
                    modifier = Modifier.fillMaxWidth(),
                    enabled = !isSubmitting,
                    singleLine = true,
                    label = { Text("确认新密码") },
                    visualTransformation = visualTransformation,
                    shape = shapes.md,
                    colors = fieldColors,
                    keyboardOptions = KeyboardOptions(
                        keyboardType = KeyboardType.Password,
                        imeAction = ImeAction.Done,
                    ),
                )

                errorMessage?.let { err ->
                    Text(
                        text = err,
                        style = MaterialTheme.typography.bodySmall,
                        color = colors.destructive,
                        modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                    )
                }
            }
        },
        confirmButton = {
            Button(
                onClick = {
                    when {
                        currentPassword.isEmpty() -> errorMessage = "请输入当前临时密码"
                        newPassword.length < 8 -> errorMessage = "新密码至少需要 8 位"
                        newPassword != confirmPassword -> errorMessage = "两次输入的新密码不一致"
                        else -> {
                            isSubmitting = true
                            errorMessage = null
                            scope.launch {
                                try {
                                    withContext(Dispatchers.IO) {
                                        accountSettingsRepository.changePassword(
                                            currentPassword = currentPassword,
                                            newPassword = newPassword,
                                        )
                                    }
                                    isSubmitting = false
                                    onPasswordChanged()
                                } catch (e: ApiError) {
                                    isSubmitting = false
                                    errorMessage = e.userMessage
                                } catch (e: Exception) {
                                    isSubmitting = false
                                    errorMessage = e.message?.takeIf { it.isNotBlank() } ?: "修改密码失败，请重试"
                                }
                            }
                        }
                    }
                },
                enabled = !isSubmitting,
                modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                shape = shapes.md,
                colors = ButtonDefaults.buttonColors(
                    containerColor = colors.brand,
                    contentColor = colors.brandFg,
                ),
            ) {
                if (isSubmitting) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(16.dp),
                        strokeWidth = 2.dp,
                        color = colors.brandFg,
                    )
                } else {
                    Text("确认修改", fontWeight = FontWeight.SemiBold)
                }
            }
        },
        dismissButton = {
            TextButton(
                onClick = onSwitchAccount,
                enabled = !isSubmitting,
                modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                colors = ButtonDefaults.textButtonColors(contentColor = colors.fg2),
            ) {
                Text("切换账号")
            }
        },
    )
}
