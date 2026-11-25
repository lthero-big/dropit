package dev.dropit.app.ui.rooms

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ExitToApp
import androidx.compose.material.icons.rounded.Casino
import androidx.compose.material.icons.rounded.ContentCopy
import androidx.compose.material.icons.rounded.Edit
import androidx.compose.material.icons.rounded.Link
import androidx.compose.material.icons.rounded.Lock
import androidx.compose.material.icons.rounded.MeetingRoom
import androidx.compose.material.icons.rounded.Share
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
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
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import dev.dropit.app.core.network.RoomInfo
import dev.dropit.app.ui.board.ClipFormatting
import dev.dropit.app.ui.theme.DropitMonoTypography
import dev.dropit.app.ui.theme.DropitTheme

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ActiveRoomBanner(
    room: RoomInfo,
    isOwner: Boolean,
    nowMs: Long,
    onCopyCode: () -> Unit,
    onCopyRoomLink: () -> Unit = {},
    onShareRoomLink: () -> Unit,
    onEditCodeAndPin: () -> Unit,
    onLeaveRoom: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = DropitTheme.colors
    val shapes = DropitTheme.shapes
    val expiry = remember(room.expiresAt, nowMs) {
        ClipFormatting.formatRemainingExpiry(room.expiresAt, nowMs)
    }

    Surface(
        modifier = modifier.fillMaxWidth(),
        color = colors.surface0,
        tonalElevation = 0.dp,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 14.dp, vertical = 10.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            FlowRow(
                modifier = Modifier.fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(6.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Icon(
                        imageVector = Icons.Rounded.MeetingRoom,
                        contentDescription = null,
                        tint = colors.devPad,
                        modifier = Modifier.size(18.dp),
                    )
                    Text(
                        text = "房间码",
                        style = MaterialTheme.typography.labelSmall,
                        color = colors.fg3,
                    )
                    Surface(
                        shape = shapes.sm,
                        color = colors.codeBg,
                        border = BorderStroke(1.dp, colors.line2),
                        tonalElevation = 0.dp,
                    ) {
                        Text(
                            text = room.code ?: room.token.take(6),
                            style = DropitMonoTypography.codeBlock.copy(fontWeight = FontWeight.SemiBold),
                            color = colors.fg,
                            modifier = Modifier.padding(horizontal = 8.dp, vertical = 3.dp),
                        )
                    }
                }
                if (room.hasPin) {
                    Surface(
                        modifier = Modifier.align(Alignment.CenterVertically),
                        shape = shapes.pill,
                        color = colors.warnSoft,
                        tonalElevation = 0.dp,
                    ) {
                        Row(
                            modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(3.dp),
                        ) {
                            Icon(
                                imageVector = Icons.Rounded.Lock,
                                contentDescription = "已设 PIN",
                                tint = colors.warn,
                                modifier = Modifier.size(11.dp),
                            )
                            Text(
                                text = "PIN",
                                style = MaterialTheme.typography.labelSmall,
                                color = colors.warn,
                            )
                        }
                    }
                }
                expiry?.let {
                    Text(
                        text = it.label,
                        style = DropitMonoTypography.meta,
                        color = if (it.isExpiringSoon) colors.brand else colors.fg3,
                        modifier = Modifier.align(Alignment.CenterVertically),
                    )
                }
            }

            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(4.dp),
                verticalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                if (!room.code.isNullOrBlank()) {
                    TextButton(
                        onClick = onCopyCode,
                        modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                        colors = ButtonDefaults.textButtonColors(contentColor = colors.fg2),
                    ) {
                        Icon(
                            imageVector = Icons.Rounded.ContentCopy,
                            contentDescription = null,
                            modifier = Modifier.size(15.dp),
                        )
                        Spacer(modifier = Modifier.width(4.dp))
                        Text("复制房间码", style = MaterialTheme.typography.labelMedium)
                    }
                    TextButton(
                        onClick = onCopyRoomLink,
                        modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                        colors = ButtonDefaults.textButtonColors(contentColor = colors.fg2),
                    ) {
                        Icon(
                            imageVector = Icons.Rounded.Link,
                            contentDescription = null,
                            modifier = Modifier.size(15.dp),
                        )
                        Spacer(modifier = Modifier.width(4.dp))
                        Text("复制链接", style = MaterialTheme.typography.labelMedium)
                    }
                    TextButton(
                        onClick = onShareRoomLink,
                        modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                        colors = ButtonDefaults.textButtonColors(contentColor = colors.fg2),
                    ) {
                        Icon(
                            imageVector = Icons.Rounded.Share,
                            contentDescription = null,
                            modifier = Modifier.size(15.dp),
                        )
                        Spacer(modifier = Modifier.width(4.dp))
                        Text("分享链接", style = MaterialTheme.typography.labelMedium)
                    }
                }
                if (isOwner) {
                    TextButton(
                        onClick = onEditCodeAndPin,
                        modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                        colors = ButtonDefaults.textButtonColors(contentColor = colors.brand),
                    ) {
                        Icon(
                            imageVector = Icons.Rounded.Edit,
                            contentDescription = null,
                            modifier = Modifier.size(15.dp),
                        )
                        Spacer(modifier = Modifier.width(4.dp))
                        Text("修改房间码/PIN", style = MaterialTheme.typography.labelMedium)
                    }
                }
                TextButton(
                    onClick = onLeaveRoom,
                    modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                    colors = ButtonDefaults.textButtonColors(contentColor = colors.fg3),
                ) {
                    Icon(
                        imageVector = Icons.AutoMirrored.Rounded.ExitToApp,
                        contentDescription = null,
                        modifier = Modifier.size(15.dp),
                    )
                    Spacer(modifier = Modifier.width(4.dp))
                    Text("返回空间", style = MaterialTheme.typography.labelMedium)
                }
            }
        }
    }
    HorizontalDivider(thickness = 1.dp, color = colors.line1)
}

@Composable
fun CreateRoomDialog(
    state: RoomUiState,
    onCreate: (customCode: String?, pin: String?) -> Unit,
    onDismiss: () -> Unit,
) {
    val colors = DropitTheme.colors
    val shapes = DropitTheme.shapes
    var customCode by remember { mutableStateOf("") }
    var pin by remember { mutableStateOf("") }
    val codeError = remember(customCode) { RoomValidation.validateCreateCode(customCode) }
    val pinError = remember(pin) { RoomValidation.validatePin(pin, required = false) }

    AlertDialog(
        onDismissRequest = { if (!state.isSubmitting) onDismiss() },
        shape = shapes.lg,
        containerColor = colors.surface1,
        titleContentColor = colors.fg,
        textContentColor = colors.fg2,
        tonalElevation = 0.dp,
        title = {
            Text("创建临时房间", style = MaterialTheme.typography.titleMedium)
        },
        text = {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .imePadding()
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Text(
                    text = "留空则自动生成高熵随机 6 位房间码；若本设备已有未过期的临时房间将直接复进。",
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.fg3,
                )

                OutlinedTextField(
                    value = customCode,
                    onValueChange = { customCode = it.filter { ch -> ch.isLetterOrDigit() || ch == '-' || ch == '_' }.take(32) },
                    enabled = !state.isSubmitting,
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                    label = { Text("自定义房间码（可选）") },
                    placeholder = { Text("3–32 位字母/数字/-/_", color = colors.fg4) },
                    isError = codeError != null,
                    keyboardOptions = KeyboardOptions(
                        capitalization = KeyboardCapitalization.None,
                        autoCorrectEnabled = false,
                        keyboardType = KeyboardType.Ascii,
                    ),
                    shape = shapes.md,
                    textStyle = DropitMonoTypography.codeBlock.copy(color = colors.fg),
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedContainerColor = colors.surface0,
                        unfocusedContainerColor = colors.surface0,
                        focusedBorderColor = colors.line3,
                        unfocusedBorderColor = colors.line2,
                        errorBorderColor = colors.destructive,
                        cursorColor = colors.brand,
                    ),
                )
                codeError?.let {
                    Text(text = it, style = MaterialTheme.typography.labelSmall, color = colors.destructive)
                }

                OutlinedTextField(
                    value = pin,
                    onValueChange = { pin = it.take(RoomValidation.PIN_MAX_LENGTH) },
                    enabled = !state.isSubmitting,
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                    label = { Text("房间 PIN（可选，4–32 位）") },
                    placeholder = { Text("设置后他人加入需输入 PIN", color = colors.fg4) },
                    visualTransformation = PasswordVisualTransformation(),
                    isError = pinError != null,
                    shape = shapes.md,
                    textStyle = MaterialTheme.typography.bodyMedium.copy(color = colors.fg),
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedContainerColor = colors.surface0,
                        unfocusedContainerColor = colors.surface0,
                        focusedBorderColor = colors.line3,
                        unfocusedBorderColor = colors.line2,
                        errorBorderColor = colors.destructive,
                        cursorColor = colors.brand,
                    ),
                )
                pinError?.let {
                    Text(text = it, style = MaterialTheme.typography.labelSmall, color = colors.destructive)
                }

                state.errorMessage?.let { err ->
                    Text(text = err, style = MaterialTheme.typography.bodySmall, color = colors.destructive)
                }
            }
        },
        confirmButton = {
            TextButton(
                onClick = { onCreate(customCode.ifBlank { null }, pin.ifBlank { null }) },
                enabled = !state.isSubmitting && codeError == null && pinError == null,
                modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                colors = ButtonDefaults.textButtonColors(contentColor = colors.brand),
            ) {
                if (state.isSubmitting) {
                    CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp, color = colors.brand)
                } else {
                    Text("创建并进入", fontWeight = FontWeight.SemiBold)
                }
            }
        },
        dismissButton = {
            TextButton(
                onClick = onDismiss,
                enabled = !state.isSubmitting,
                modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                colors = ButtonDefaults.textButtonColors(contentColor = colors.fg2),
            ) {
                Text("取消")
            }
        },
    )
}

@Composable
fun JoinRoomDialog(
    state: RoomUiState,
    onJoin: (code: String, pin: String?) -> Unit,
    onDismiss: () -> Unit,
) {
    val colors = DropitTheme.colors
    val shapes = DropitTheme.shapes
    var code by remember { mutableStateOf("") }
    var pin by remember { mutableStateOf("") }
    var showPinInput by remember { mutableStateOf(false) }
    val effectiveShowPin = showPinInput || state.requiresPinForJoin

    AlertDialog(
        onDismissRequest = { if (!state.isSubmitting) onDismiss() },
        shape = shapes.lg,
        containerColor = colors.surface1,
        titleContentColor = colors.fg,
        textContentColor = colors.fg2,
        tonalElevation = 0.dp,
        title = {
            Text("加入临时房间", style = MaterialTheme.typography.titleMedium)
        },
        text = {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .imePadding()
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Text(
                    text = "房间码区分大小写，请按房主提供的字符原样输入。",
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.fg3,
                )

                OutlinedTextField(
                    value = code,
                    onValueChange = { code = it.trim().take(32) },
                    enabled = !state.isSubmitting,
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                    label = { Text("房间码") },
                    placeholder = { Text("例如 k7Rm2x", color = colors.fg4) },
                    keyboardOptions = KeyboardOptions(
                        capitalization = KeyboardCapitalization.None,
                        autoCorrectEnabled = false,
                        keyboardType = KeyboardType.Ascii,
                        imeAction = if (effectiveShowPin) ImeAction.Next else ImeAction.Done,
                    ),
                    keyboardActions = KeyboardActions(
                        onDone = {
                            if (!state.isSubmitting && code.isNotBlank() && (!state.requiresPinForJoin || pin.isNotEmpty())) {
                                onJoin(code, pin.ifBlank { null })
                            }
                        },
                    ),
                    shape = shapes.md,
                    textStyle = DropitMonoTypography.codeBlock.copy(color = colors.fg),
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedContainerColor = colors.surface0,
                        unfocusedContainerColor = colors.surface0,
                        focusedBorderColor = colors.line3,
                        unfocusedBorderColor = colors.line2,
                        cursorColor = colors.brand,
                    ),
                )

                if (effectiveShowPin) {
                    OutlinedTextField(
                        value = pin,
                        onValueChange = { pin = it.take(RoomValidation.PIN_MAX_LENGTH) },
                        enabled = !state.isSubmitting,
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true,
                        label = { Text("房间 PIN") },
                        placeholder = { Text("输入 4–32 位 PIN", color = colors.fg4) },
                        visualTransformation = PasswordVisualTransformation(),
                        keyboardOptions = KeyboardOptions(
                            imeAction = ImeAction.Done,
                        ),
                        keyboardActions = KeyboardActions(
                            onDone = {
                                if (!state.isSubmitting && code.isNotBlank() && (!state.requiresPinForJoin || pin.isNotEmpty())) {
                                    onJoin(code, pin.ifBlank { null })
                                }
                            },
                        ),
                        shape = shapes.md,
                        textStyle = MaterialTheme.typography.bodyMedium.copy(color = colors.fg),
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedContainerColor = colors.surface0,
                            unfocusedContainerColor = colors.surface0,
                            focusedBorderColor = colors.line3,
                            unfocusedBorderColor = colors.line2,
                            cursorColor = colors.brand,
                        ),
                    )
                } else {
                    TextButton(
                        onClick = { showPinInput = true },
                        modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                        colors = ButtonDefaults.textButtonColors(contentColor = colors.fg3),
                    ) {
                        Icon(
                            imageVector = Icons.Rounded.Lock,
                            contentDescription = null,
                            modifier = Modifier.size(14.dp),
                        )
                        Spacer(modifier = Modifier.width(4.dp))
                        Text("填写可选 PIN", style = MaterialTheme.typography.labelSmall)
                    }
                }

                state.errorMessage?.let { err ->
                    Surface(
                        modifier = Modifier
                            .fillMaxWidth()
                            .semantics { liveRegion = LiveRegionMode.Polite },
                        shape = shapes.sm,
                        color = colors.brandSoft,
                        tonalElevation = 0.dp,
                    ) {
                        Text(
                            text = err,
                            style = MaterialTheme.typography.bodySmall,
                            color = colors.destructive,
                            modifier = Modifier.padding(10.dp),
                        )
                    }
                }
            }
        },
        confirmButton = {
            TextButton(
                onClick = { onJoin(code, pin.ifBlank { null }) },
                enabled = !state.isSubmitting && code.isNotBlank() && (!state.requiresPinForJoin || pin.isNotEmpty()),
                modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                colors = ButtonDefaults.textButtonColors(contentColor = colors.brand),
            ) {
                if (state.isSubmitting) {
                    CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp, color = colors.brand)
                } else {
                    Text("进入房间", fontWeight = FontWeight.SemiBold)
                }
            }
        },
        dismissButton = {
            TextButton(
                onClick = onDismiss,
                enabled = !state.isSubmitting,
                modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                colors = ButtonDefaults.textButtonColors(contentColor = colors.fg2),
            ) {
                Text("取消")
            }
        },
    )
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun EditRoomCodeDialog(
    room: RoomInfo,
    state: RoomUiState,
    onSaveCode: (String) -> Unit,
    onRandomizeCode: () -> Unit,
    onSavePin: (String) -> Unit,
    onRemovePin: () -> Unit,
    onDismiss: () -> Unit,
) {
    val colors = DropitTheme.colors
    val shapes = DropitTheme.shapes
    var draftCode by remember(room.code) {
        val current = room.code.orEmpty()
        mutableStateOf(if (RoomValidation.CHANGE_CODE_REGEX.matches(current)) current else "")
    }
    var draftPin by remember(room.hasPin) { mutableStateOf("") }
    val codeError = remember(draftCode) {
        if (draftCode.isEmpty()) null else RoomValidation.validateChangeCode(draftCode)
    }
    val pinError = remember(draftPin) {
        if (draftPin.isEmpty()) null else RoomValidation.validatePin(draftPin, required = false)
    }

    AlertDialog(
        onDismissRequest = { if (!state.isSubmitting) onDismiss() },
        shape = shapes.lg,
        containerColor = colors.surface1,
        titleContentColor = colors.fg,
        textContentColor = colors.fg2,
        tonalElevation = 0.dp,
        title = {
            Text("修改房间码与 PIN", style = MaterialTheme.typography.titleMedium)
        },
        text = {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .imePadding()
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Text("当前房间码", style = MaterialTheme.typography.labelMedium, color = colors.fg3)
                    Text(
                        text = room.code ?: "未设置",
                        style = DropitMonoTypography.codeBlock.copy(fontWeight = FontWeight.SemiBold),
                        color = colors.fg,
                    )
                    if (room.hasPin) {
                        Text("已设 PIN", style = MaterialTheme.typography.labelSmall, color = colors.warn)
                    }
                }

                // Change code section
                OutlinedTextField(
                    value = draftCode,
                    onValueChange = { draftCode = it.filter { ch -> ch.isLetterOrDigit() }.take(6) },
                    enabled = !state.isSubmitting,
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                    label = { Text("新房间码（6 位字母或数字）") },
                    placeholder = { Text("例如 k7Rm2x", color = colors.fg4) },
                    isError = codeError != null,
                    keyboardOptions = KeyboardOptions(
                        capitalization = KeyboardCapitalization.None,
                        autoCorrectEnabled = false,
                        keyboardType = KeyboardType.Ascii,
                    ),
                    shape = shapes.md,
                    textStyle = DropitMonoTypography.codeBlock.copy(color = colors.fg),
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedContainerColor = colors.surface0,
                        unfocusedContainerColor = colors.surface0,
                        focusedBorderColor = colors.line3,
                        unfocusedBorderColor = colors.line2,
                        errorBorderColor = colors.destructive,
                        cursorColor = colors.brand,
                    ),
                )
                codeError?.let {
                    Text(text = it, style = MaterialTheme.typography.labelSmall, color = colors.destructive)
                }

                FlowRow(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Button(
                        onClick = { onSaveCode(draftCode) },
                        enabled = !state.isSubmitting && draftCode.length == 6 && codeError == null && draftCode != room.code,
                        modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                        shape = shapes.md,
                        colors = ButtonDefaults.buttonColors(
                            containerColor = colors.brand,
                            contentColor = colors.brandFg,
                        ),
                    ) {
                        Text("保存房间码")
                    }
                    OutlinedButton(
                        onClick = onRandomizeCode,
                        enabled = !state.isSubmitting,
                        modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                        shape = shapes.md,
                        border = BorderStroke(1.dp, colors.line2),
                        colors = ButtonDefaults.outlinedButtonColors(contentColor = colors.fg),
                    ) {
                        Icon(
                            imageVector = Icons.Rounded.Casino,
                            contentDescription = null,
                            modifier = Modifier.size(16.dp),
                        )
                        Spacer(modifier = Modifier.width(4.dp))
                        Text("随机生成")
                    }
                }

                HorizontalDivider(thickness = 1.dp, color = colors.line1)

                // Change PIN section
                OutlinedTextField(
                    value = draftPin,
                    onValueChange = { draftPin = it.take(RoomValidation.PIN_MAX_LENGTH) },
                    enabled = !state.isSubmitting,
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                    label = { Text(if (room.hasPin) "新 PIN（4–32 位）" else "设置 PIN（4–32 位）") },
                    visualTransformation = PasswordVisualTransformation(),
                    isError = pinError != null,
                    shape = shapes.md,
                    textStyle = MaterialTheme.typography.bodyMedium.copy(color = colors.fg),
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedContainerColor = colors.surface0,
                        unfocusedContainerColor = colors.surface0,
                        focusedBorderColor = colors.line3,
                        unfocusedBorderColor = colors.line2,
                        errorBorderColor = colors.destructive,
                        cursorColor = colors.brand,
                    ),
                )
                pinError?.let {
                    Text(text = it, style = MaterialTheme.typography.labelSmall, color = colors.destructive)
                }

                FlowRow(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Button(
                        onClick = { onSavePin(draftPin) },
                        enabled = !state.isSubmitting && draftPin.length >= RoomValidation.PIN_MIN_LENGTH && pinError == null,
                        modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                        shape = shapes.md,
                        colors = ButtonDefaults.buttonColors(
                            containerColor = colors.fg,
                            contentColor = colors.bg,
                        ),
                    ) {
                        Text(if (room.hasPin) "更新 PIN" else "设置 PIN")
                    }
                    if (room.hasPin) {
                        OutlinedButton(
                            onClick = onRemovePin,
                            enabled = !state.isSubmitting,
                            modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                            shape = shapes.md,
                            border = BorderStroke(1.dp, colors.destructive.copy(alpha = 0.45f)),
                            colors = ButtonDefaults.outlinedButtonColors(contentColor = colors.destructive),
                        ) {
                            Text("移除 PIN")
                        }
                    }
                }

                state.successMessage?.let { msg ->
                    Text(
                        text = msg,
                        style = MaterialTheme.typography.labelSmall,
                        color = colors.ok,
                        modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                    )
                }
                state.errorMessage?.let { err ->
                    Text(
                        text = err,
                        style = MaterialTheme.typography.labelSmall,
                        color = colors.destructive,
                        modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                    )
                }

                Text(
                    text = "修改房间码后，旧房间码与旧链接立即失效。",
                    style = MaterialTheme.typography.labelSmall,
                    color = colors.fg3,
                )
            }
        },
        confirmButton = {
            TextButton(
                onClick = onDismiss,
                enabled = !state.isSubmitting,
                modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                colors = ButtonDefaults.textButtonColors(contentColor = colors.fg),
            ) {
                Text("完成")
            }
        },
    )
}
