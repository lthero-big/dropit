package dev.dropit.app.ui.settings

/**
 * Native secondary settings destinations replacing legacy external-browser links (v0.4.1).
 */
enum class SettingsSubPage(
    val title: String,
    val subtitle: String,
    val adminOnly: Boolean = false,
) {
    SHARE_PRESETS(
        title = "分享选项预设",
        subtitle = "增删自定义有效期与访问次数，保存即同步 PC / Web",
    ),
    SHARE_LINKS(
        title = "分享管理中心",
        subtitle = "分页浏览历史分享、筛选状态、二次复制短链与撤销/删除",
    ),
    SPACE_SHARING(
        title = "空间成员与邀请",
        subtitle = "管理受邀成员权限（只读/可编辑）、退出空间与邀请链接",
    ),
    DEVICES(
        title = "登录设备",
        subtitle = "查看在线/离线会话，单个下线或一键踢出其他设备",
    ),
    TOKENS_AND_DEVICE_CODE(
        title = "访问令牌与设备码",
        subtitle = "创建与吊销 PAT 令牌，输入 8 位码批准/拒绝设备登录",
    ),
    SECURITY_AND_OAUTH(
        title = "修改密码与登录方式",
        subtitle = "原生修改账户密码、管理 GitHub / Google 绑定与解绑",
    ),
    ADMIN(
        title = "管理员设置",
        subtitle = "用户、注册策略与邀请码、运行时限额与审计、临时房间、站点与 OAuth",
        adminOnly = true,
    ),
}

/**
 * Visibility rules for the native settings menu.
 * Admin settings require BOTH live `user.role == "admin"` AND token `admin` scope.
 */
object NativeSettingsMenu {
    fun entriesForUser(isAdmin: Boolean, hasAdminScope: Boolean): List<SettingsSubPage> {
        val showAdmin = isAdmin && hasAdminScope
        return if (showAdmin) {
            SettingsSubPage.entries
        } else {
            SettingsSubPage.entries.filterNot { it.adminOnly }
        }
    }
}
