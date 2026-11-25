# dropit Android 原生客户端全功能对照验收与手测清单

> **文档角色**：RHEA-225（dropit Android 原生重做）Stage 4B（RHEA-260）最终 UI/UX 对照审计报告与真机验收清单。  
> **审计基线**：`feat/rhea-225-android-native`（继承 Stage 1–3 合入基线 `d65ddd3`），逐项对照 `docs/android-native-ux-spec.md` 与 `apps/web/`、`apps/server/src/` 真实实现。  
> **验证边界说明**：本报告严格区分三类状态——**`已自动化验证`**（由 JVM 单元测试与 `assembleDebug` CI 验证）、**`显式浏览器入口`**（受服务端 `browserSession()` / `adminBrowser()` 保护，通过系统浏览器打开，不削弱鉴权边界）、**`已代码核对 · 待真机复核`**（源码与布局边界已核对修复，但手势、系统权限、覆盖安装与真机渲染需真机实测确认）。

---

## 1. Stage 4B 审计发现与已修复边界缺陷汇总

对照 `docs/android-native-ux-spec.md` 与 Stage 3A 真实仓库对接后的边界场景，本次审计共发现并修复 **14 项** UI / 交互 / 契约边界问题，并补充了对应单元测试：

| # | 问题类别 | 发现的具体缺陷 | 修复方案与源码位置 | 对应单测 |
| --- | --- | --- | --- | --- |
| 1 | 服务端契约一致性 | 分组名上限本地校验为 32 字符，而服务端 `apps/server/src/domain.ts:69` 限制为 **24 Unicode 码点**且会折叠空白 | 将 `MAX_GROUP_NAME_LENGTH` 修正为 `24`，按 Unicode 码点计数并折叠空白（`ui/board/ClipFormatting.kt`） | `ClipFormattingTest.validateGroupName_enforcesReservedNamesDuplicatesAndLimit` |
| 2 | 残留占位文案与错误提示 | `BoardViewModel.prepareFileForShare` 失败回退仍含 Stage 2 占位文案 `"传输引擎将在合入后就绪"`；超限提示用 `${maxBytes / 1024} KB` 在 `< 1 KB` 时显示 `0 KB` | 替换为本地化 `ApiError.userMessage` 与通用网络重试提示；改用 `ServerUrl.formatSize(maxBytes)`（`ui/board/BoardViewModel.kt`） | `BoardViewModelTest.prepareFileForShare_failureUsesLocalizedApiErrorWithoutStagePlaceholder`、`sendText_overMaxTextBytes_rejectsLocallyWithFormattedLimit` |
| 3 | 无网络冷启动空态误导 | 离线冷启动（`allItems.isEmpty() && offlineBannerMessage != null`）时内容页展示「剪贴板还是空的」和「发送第一条文本」，且无重试主按钮 | 增加独立离线/网络异常空态（`CloudOff` 图标 + 错误原因 + 主按钮「重新连接」），并在 `activeScope == null` 时隐藏发送引导（`ui/board/BoardScreen.kt`） | `BoardViewModelTest.offlineLoad_showsBannerWithoutCrashAndRecoversOnRetry` |
| 4 | Edge-to-Edge 双重安全区 | `DropitApp.kt` 对 Material 3 `NavigationBar` 额外叠加 `.navigationBarsPadding()`（M3 默认已消费 `NavigationBarDefaults.windowInsets`）；引导页有待发分享条时与 `OnboardingScreen` 叠加双倍 `statusBarsPadding()` | 移除 `NavigationBar` 重复 `navigationBarsPadding()`；向 `OnboardingScreen` 透传 `applyStatusBarsPadding = !rootState.hasPendingShare`（`ui/navigation/DropitApp.kt`、`ui/onboarding/OnboardingScreen.kt`） | 已代码核对 · 待真机复核 |
| 5 | 会话切换残留状态 | 401 重登或切换服务器进入新 `sessionKey` 时，`SettingsViewModel` 保留上一服务器的更新弹窗/提示，`ItemShareViewModel` 未关闭旧弹窗 | `DropitApp.kt` 在 `sessionKey` 变更时重置 `itemShareViewModel.close()` 与 `roomViewModel.clearDialogFeedback()`；`SettingsViewModel.triggerBackgroundUpdateCheck` 在新会话时清空旧提示与弹窗 | `SettingsViewModelTest.sessionSwitch_clearsStaleUpdateStatusAndPromptBeforeCheckingNewSession` |
| 6 | 传输队列失败卡片无法移除 | `TransfersScreen` 仅对 `QUEUED`/`RUNNING`/`PAUSED` 显示取消按钮，`FAILED` 任务无法移除且不被「清理已完成」清理，导致永久失败条目（如暂存文件已清理）无法消除 | 对 `TransferStatus.FAILED` 增加「移除」按钮（调用 `cancelTask` 标记为 `CANCELLED` 后消除底部红点并可随「清理已完成」清空，`ui/transfers/TransfersScreen.kt`） | `TransfersViewModelTest.cancelFailedTask_marksCancelledSoUserCanClearPermanentlyFailedItems` |
| 7 | 系统分享部分失败与离线恢复 | 文本+文件混合分享中若文本成功但文件入队失败，重试被 `submittedShareIds` 静默拦截；离线冷启动分享时无空间加载失败重试按钮；缺少 `maxTextBytes` 字节校验 | 文本已发而文件失败时清空 `editedText` 并解除重入锁，允许仅重试未发文件而不重复发文本；`ShareTargetSheet` 增加离线加载错误重试按钮与 UTF-8 字节计数/超限拦截（`ui/share/ShareTargetViewModel.kt`、`ui/share/ShareTargetSheet.kt`） | `ShareTargetViewModelTest.submitShare_partialFailureWhenTextSucceedsAndFilesFail_retriesOnlyFilesWithoutDuplicateText`、`submitShare_overMaxTextBytes_blocksSubmissionWithoutConsumingShare` |
| 8 | 卡片「更多」菜单与文本文件预览 | 缺少规范 §2.3 要求的「复制下载链接」；Stage 3A 实现的 `MediaRepository.fetchTextContent` 未接入 UI，导致 `.md`/`.txt`/代码文件无法在线文本预览；编辑文本退出时无未保存修改确认 | 在 `ItemMoreActionsSheet` 新增「复制下载链接」；扩展 `TextMarkdownViewer` 与 `BoardCard`/`BoardScreen` 支持安全文本/Markdown/代码文件异步预览；编辑文本 Sheet 增加「放弃未保存的修改？」确认框（`ui/board/BoardSheets.kt`、`ui/board/BoardScreen.kt`、`ui/board/BoardCard.kt`、`ui/viewer/TextMarkdownViewer.kt`） | `ClipFormattingTest.isPreviewableTextFile_detectsTextCodeMarkdownAndExcludesBinaries` |
| 9 | 图片灯箱手势与双失败回退 | 缺少规范 §2.6 的「向下轻滑关闭」手势；当缩略图与高清图均加载失败时，因 `thumbUrl` 非空导致错误提示被隐藏 | 在未放大态支持单指下拉跟随位移与背景渐隐关闭；跟踪 `thumbFailed` 并在加载失败时展示明确提示与「重试加载」按钮（`ui/viewer/ImageLightbox.kt`） | 已代码核对 · 待真机复核 |
| 10 | 临时房间横幅与校验细节 | `ActiveRoomBanner` 缺少一键「复制链接」且顶行 `Row` 在大字体下易挤压；`RoomValidation.validatePin` 未拒绝控制字符；`JoinRoomDialog` 缺少键盘 `ImeAction.Done` | `ActiveRoomBanner` 顶行改用 `FlowRow` 并补齐「复制链接」；`EditRoomCodeDialog` 按钮行改用 `FlowRow`；`RoomValidation.validatePin` 拒绝 ISO 控制字符（`ui/rooms/RoomDialogs.kt`、`ui/rooms/RoomViewModel.kt`） | `RoomViewModelTest.pinValidation_rejectsControlCharactersAndBoundsLength` |
| 11 | 中文文件名截断边界 | `middleEllipsizeFilename` 在紧凑宽度 + 长扩展名（如 `.markdown`）下可能超过 `maxChars`；单行标题容器在大字体下易先触发末尾截断而丢失扩展名 | 收紧 `middleEllipsizeFilename` 的预算分配保证严格 `<= maxChars` 且保留扩展名；卡片/灯箱/播放器/分享列表单行标题根据 `fontScale` 自适应 `maxChars`（`ui/board/ClipFormatting.kt` 等） | `ClipFormattingTest.middleEllipsizeFilename_preservesExtensionForLongChineseNames` |
| 12 | 触控热区 `>= 48.dp` 全量收敛 | 多处辅助交互热区为 `36.dp–44.dp`（分组芯片、新建分组、重命名/删除分组、卡片展开/URL 芯片、`GroupChoicePill`、`ShareOptionChip`、`ShareGroupPill`、`JoinRoomDialog` 填写 PIN、更新「跳过版本」、阅读器「复制代码」） | 全部收敛为 `>= 48.dp` 触控热区（胶囊类外包 `48.dp` 点击盒以保持视觉紧凑） | 已代码核对 · 待真机复核 |
| 13 | 大字体（`1.5x–2.0x`）与小屏防重叠 | `ItemMoreActionsSheet`、`EditLabelsAndGroupSheet`、`UpdateDialog` 内容列未滚动易截断；设置页三段主题选择器、配额行、卡片操作条、分享历史行、播放器错误栏在 `2.0x` 字体下易挤压裁切 | 弹层补充 `verticalScroll`；关键行切换为 `FlowRow`；设置页主题选择在 `fontScale >= 1.5f` 自动转为纵向栈叠；悬浮发送条大字体收紧内边距（多文件 `ui/**`） | 已代码核对 · 待真机复核 |
| 14 | WCAG 对比度与 TalkBack 播报 | 部分信息性提示文字误用低对比度占位色 `fg4`（引导页 HTTPS 说明、菜单副标题、改码警示、隐藏只读空间提示、已编辑标记、历史分享状态胶囊）；部分错误横幅缺少 `LiveRegionMode.Polite` | 信息性文字统一升级为 `fg3`；错误与权限提示横幅补充 `semantics { liveRegion = LiveRegionMode.Polite }`；新增 WCAG 2.1 对比度自动化单测（`ui/theme/PaperThemeTokensTest.kt`） | `PaperThemeTokensTest.wcagContrastRatios_meetAaThresholdInLightAndDarkPaperThemes` |

---

## 2. 全功能对照验收矩阵（对照 `docs/android-native-ux-spec.md` §3.1 & §4.2）

> 路径前缀缩写：`SRC = apps/android/app/src/main/java/dev/dropit/app`，`TEST = apps/android/app/src/test/java/dev/dropit/app`。

### A. 纸感设计与主题 Token

| 验收项 | 源码位置 | 自动化单测覆盖 | 状态 | 备注 |
| --- | --- | --- | --- | --- |
| Light / Dark `DropitExtendedColors` 十六进制 Token 逐项对齐 Web `index.css` | `SRC/ui/theme/Color.kt` | `TEST/ui/theme/PaperThemeTokensTest.kt`（`lightColors_matchUxSpecExactly`、`darkColors_matchUxSpecAndNeverUsePureBlack`） | **已自动化验证** | 全部 25 个语义色值与设备色精确断言 |
| Dark 模式无纯黑 `#000000`、无刺眼纯白描边、M3 `surfaceTint = Transparent` 无紫色染色 | `SRC/ui/theme/Color.kt`、`SRC/ui/theme/Theme.kt` | `TEST/ui/theme/PaperThemeTokensTest.kt` | **已自动化验证** | 全量 `Surface` / `ModalBottomSheet` / `AlertDialog` 显式 `tonalElevation = 0.dp` |
| WCAG 2.1 文本对比度（深浅主题） | `SRC/ui/theme/Color.kt` | `TEST/ui/theme/PaperThemeTokensTest.kt`（`wcagContrastRatios_meetAaThresholdInLightAndDarkPaperThemes`） | **已自动化验证** | 实测：Light `fg/surface1=17.18:1`、`fg2=9.37:1`、`fg3=4.44:1`（与 Web `#7D776D` 精确一致）、`brandFg/brand=5.67:1`；Dark `fg=14.32:1`、`fg2=9.61:1`、`fg3=5.31:1`、`brandFg/brand=5.27:1` |
| 圆角体系（`3/5/7/10/14.dp` / `CircleShape`）与纸感描边/阴影层级 | `SRC/ui/theme/Shape.kt` | `SRC/ui/theme/Shape.kt` 代码核对 | **已代码核对 · 待真机复核** | 卡片基准 `7.dp` + `1.dp line1` 描边，Dark 下 `card elevation = 0.dp` |
| 动效时长（`120/200/320ms`）与系统「移除动画」降级（`snap()`） | `SRC/ui/theme/Motion.kt`、`SRC/ui/theme/Theme.kt` | `TEST/ui/theme/PaperThemeTokensTest.kt` | **已自动化验证** + 真机复核减弱动效 | 监听 `Settings.Global.ANIMATOR_DURATION_SCALE == 0f` |
| 设置页三段主题切换（跟随系统 / 浅色纸感 / 深色纸感）实时生效与持久化 | `SRC/ui/settings/SettingsScreen.kt`、`SRC/ui/navigation/AppViewModel.kt`、`SRC/core/auth/SettingsStore.kt` | `TEST/core/auth/TokenVaultAndSettingsTest.kt` | **已自动化验证** + 真机复核重启保留 | `fontScale >= 1.5f` 时自动纵向排布防裁切 |

### B. 本地优先冷启动、登录、迁移与 401 恢复

| 验收项 | 源码位置 | 自动化单测覆盖 | 状态 | 备注 |
| --- | --- | --- | --- | --- |
| 无网络/飞行模式冷启动立即展示本地界面、无白屏阻塞、提供离线横幅与重试空态 | `SRC/MainActivity.kt`、`SRC/ui/navigation/DropitApp.kt`、`SRC/ui/board/BoardScreen.kt`、`SRC/ui/board/BoardViewModel.kt` | `TEST/ui/board/BoardViewModelTest.kt`（`offlineLoad_showsBannerWithoutCrashAndRecoversOnRetry`） | **已自动化验证** + 真机复核飞行模式 | 首帧仅读本地 DataStore/Keystore，无同步网络请求 |
| 应用更新检查后台异步执行、单会话去重、慢网/断网不阻塞首页 | `SRC/ui/navigation/DropitApp.kt`、`SRC/ui/settings/SettingsViewModel.kt`、`SRC/data/update/DefaultAppUpdater.kt` | `TEST/ui/settings/SettingsViewModelTest.kt`、`TEST/data/update/DefaultAppUpdaterTest.kt` | **已自动化验证** | 后台检查网络异常静默忽略，手动检查给出明确状态 |
| 首次配置页自动补全 `https://`、拒绝 `http://` 与带账号密码 URL、校验 `/api/version` | `SRC/core/network/ServerUrl.kt`、`SRC/ui/onboarding/OnboardingViewModel.kt`、`SRC/ui/onboarding/OnboardingScreen.kt` | `TEST/core/network/ServerUrlTest.kt`、`TEST/ui/onboarding/OnboardingViewModelTest.kt` | **已自动化验证** | 校验 `semver` 与 `install` 枚举 |
| 设备码登录：大号等宽 `user_code`、Custom Tabs 批准、`pending`/`slow_down`/`denied`/`expired` 状态机 | `SRC/core/auth/AuthRepository.kt`、`SRC/ui/onboarding/OnboardingViewModel.kt`、`SRC/ui/onboarding/OnboardingScreen.kt` | `TEST/core/auth/AuthRepositoryTest.kt`、`TEST/ui/onboarding/OnboardingViewModelTest.kt` | **已自动化验证** + 真机复核 Custom Tabs 跳转 | 兼容 `read write` 与旧版 `read write web` token |
| 旧版 Capacitor `SharedPreferences`（`CapacitorStorage`、`dropit_app`）加密幂等迁移 | `SRC/core/auth/LegacyCapacitorMigrator.kt`、`SRC/core/auth/TokenVault.kt`、`SRC/di/AppContainer.kt` | `TEST/core/auth/LegacyCapacitorMigratorTest.kt`、`TEST/data/migration/UpgradeMigrationAndIsolationTest.kt` | **已自动化验证** + 真机覆盖升级复核 | Android Keystore AES-256-GCM 加密存储，重启幂等 |
| 401 令牌撤销全局恢复：停止 WS 与轮询、保留 `serverOrigin`、去重登出、清晰提示并支持同服重登 | `SRC/ui/navigation/AppViewModel.kt`、`SRC/ui/board/BoardViewModel.kt`、`SRC/ui/onboarding/OnboardingViewModel.kt`、`SRC/ui/onboarding/OnboardingScreen.kt` | `TEST/ui/navigation/AppViewModelTest.kt`、`TEST/ui/board/BoardViewModelTest.kt`、`TEST/ui/onboarding/OnboardingViewModelTest.kt` | **已自动化验证** | 同服重登递增 `sessionGeneration`，二次 401 依然可靠捕获 |

### C. 内容看板、权限隔离与核心收发

| 验收项 | 源码位置 | 自动化单测覆盖 | 状态 | 备注 |
| --- | --- | --- | --- | --- |
| 空间切换器（本人私有空间 / 受邀只读 / 受邀可编辑）与角色标识一致性 | `SRC/ui/board/BoardScreen.kt`、`SRC/ui/board/BoardSheets.kt`（`SpaceSwitcherSheet`） | `TEST/ui/board/BoardViewModelTest.kt`、`TEST/core/repository/BoardAndSpaceRepositoryTest.kt` | **已自动化验证** | 明确区分 `我的` / `受邀 · 只读` / `受邀 · 可编辑` |
| 受邀只读空间（`role == "viewer"`）权限降级：只读徽标与横幅、隐藏全部写入口且 ViewModel 拦截写调用 | `SRC/ui/board/BoardScreen.kt`、`SRC/ui/board/BoardSheets.kt`、`SRC/ui/board/BoardViewModel.kt` | `TEST/ui/board/BoardViewModelTest.kt`（`readOnlySpace_blocksAllWriteOperationsAndAllowsDownloads`） | **已自动化验证** | 保留复制、保存、预览、分享只读能力 |
| 6 类内容卡片形态（短纯文本、长文本/Markdown、链接、代码、色值、图片、音视频/通用文件）与代码复制去围栏 | `SRC/ui/board/BoardCard.kt`、`SRC/ui/board/ClipFormatting.kt` | `TEST/ui/board/ClipFormattingTest.kt` | **已自动化验证** | 临期 `< 20 分钟` 以 `brand` 高亮 |
| 原生「更多」`ModalBottomSheet`（编辑文本含未保存确认、置顶、分组/标签、单项分享、预览、复制下载链接、撤回二次确认） | `SRC/ui/board/BoardSheets.kt`、`SRC/ui/board/BoardScreen.kt` | `TEST/ui/board/BoardViewModelTest.kt` | **已自动化验证** + 真机复核弹层交互 | 只读空间自动隐藏所有写操作项 |
| 发送文本（UTF-8 字节计数 + 超限拦截 + IME 避让）与前台一键「从剪贴板发送」 | `SRC/ui/board/BoardScreen.kt`、`SRC/ui/board/BoardSheets.kt`、`SRC/ui/board/BoardViewModel.kt` | `TEST/ui/board/BoardViewModelTest.kt` | **已自动化验证** + 真机复核 Android 10+ 剪贴板读取 | 仅用户前台主动点击触发 `ClipboardManager` 读取，绝不后台静默轮询 |
| 搜索（文本/文件名/分组/标签）与分组筛选/CRUD（24 分组上限、24 码点长度、保留名拦截） | `SRC/ui/board/BoardScreen.kt`、`SRC/ui/board/BoardViewModel.kt`、`SRC/ui/board/ClipFormatting.kt` | `TEST/ui/board/BoardViewModelTest.kt`、`TEST/ui/board/ClipFormattingTest.kt` | **已自动化验证** | 与 `apps/server/src/domain.ts:58-70` 规则完全一致 |
| WebSocket 实时同步、前后台切换重连与权威快照全量替换 | `SRC/core/realtime/RealtimeClient.kt`、`SRC/MainActivity.kt`、`SRC/ui/board/BoardViewModel.kt` | `TEST/core/realtime/RealtimeClientTest.kt`、`TEST/ui/board/BoardViewModelTest.kt` | **已自动化验证** + 真机弱网复核 | 连接状态胶囊可点按手动重连 |

### D. 文件传输、系统分享与中文文件名

| 验收项 | 源码位置 | 自动化单测覆盖 | 状态 | 备注 |
| --- | --- | --- | --- | --- |
| 传输页统一队列（进度条、百分比、速度、ETA、取消、重试/继续、失败移除、清理已完成、下载后打开/分享） | `SRC/ui/transfers/TransfersScreen.kt`、`SRC/ui/transfers/TransfersViewModel.kt` | `TEST/ui/transfers/TransfersViewModelTest.kt` | **已自动化验证** | 底部导航栏同步活跃数字角标与失败 `!` 角标 |
| 大文件分片并行上传、断点续传（重试先查 `GET .../uploads/:id`）与取消释放服务端会话 | `SRC/data/transfer/TransferEngine.kt`、`SRC/data/transfer/DefaultTransferManager.kt`、`SRC/data/transfer/TransferWorker.kt` | `TEST/data/transfer/TransferEngineAndManagerTest.kt` | **已自动化验证** + 真机大文件复核 | WorkManager 后台执行，防重入重复创建条目 |
| 杀进程/进程重建恢复后展示 Room 真实持久化状态（已中断可续传 / 暂存文件失效提示） | `SRC/di/AppContainer.kt`、`SRC/data/transfer/DefaultTransferManager.kt`、`SRC/ui/transfers/TransfersViewModel.kt` | `TEST/data/transfer/TransferEngineAndManagerTest.kt`、`TEST/ui/transfers/TransfersViewModelTest.kt` | **已自动化验证** + 真机划后台复核 | 不静默丢失、不误报成功 |
| 系统分享接收（文本/单图/多文件）：过滤 `FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY`、私有目录暂存、原生确认面板、自动排除只读空间、防连点重发与部分失败无重复重试 | `SRC/MainActivity.kt`、`SRC/data/share/DefaultShareInbox.kt`、`SRC/ui/navigation/AppViewModel.kt`（`ShareIntentGuard`）、`SRC/ui/share/ShareTargetViewModel.kt`、`SRC/ui/share/ShareTargetSheet.kt` | `TEST/data/share/DefaultShareInboxTest.kt`、`TEST/ui/share/ShareTargetViewModelTest.kt` | **已自动化验证** + 真机微信/相册分享复核 | 未登录时暂存 `PendingShare`，登录完成后自动弹出确认面板 |
| 中文文件名（含空格、`+`、特殊符号）全链路一致：卡片/传输队列/分享面板/预览顶栏中间省略保留扩展名 + RFC 5987 下载保存 | `SRC/data/transfer/DownloadName.kt`、`SRC/ui/board/ClipFormatting.kt`、`SRC/ui/board/BoardCard.kt`、`SRC/ui/transfers/TransfersScreen.kt`、`SRC/ui/viewer/ImageLightbox.kt`、`SRC/ui/viewer/MediaPlayerViewer.kt` | `TEST/data/transfer/DownloadNameTest.kt`、`TEST/ui/board/ClipFormattingTest.kt` | **已自动化验证** + 真机下载目录复核 | 大字体下自动收紧单行截断长度，避免扩展名被裁切 |
| 退出登录 / 切换服务器按 `(serverOrigin, accountId)` 原子清理令牌、房间密钥、Room 队列、暂存文件与图片缓存 | `SRC/di/AppContainer.kt`（`performServerSwitchReset`）、`SRC/ui/navigation/AppViewModel.kt` | `TEST/data/migration/UpgradeMigrationAndIsolationTest.kt`、`TEST/data/transfer/DefaultTransferScopeProviderTest.kt` | **已自动化验证** | 登出前弹出二次确认 Dialog |

### E. 多媒体查看器、临时房间、单项分享与更新

| 验收项 | 源码位置 | 自动化单测覆盖 | 状态 | 备注 |
| --- | --- | --- | --- | --- |
| 图片灯箱：鉴权 Coil 渐进加载（`/thumbnail` → `/preview`）、双指缩放 `1x–4x`、双击 `2.2x`、平移、多图左右翻页、单指下拉关闭、失败重试与保存原图/分享 | `SRC/ui/viewer/ImageLightbox.kt`、`SRC/data/media/DefaultMediaRepository.kt` | `TEST/data/media/DefaultMediaRepositoryTest.kt` | **已代码核对 · 待真机复核** | 深炭黑沉浸底色 `0xF00E0D0C`，双失败时可点击重试 |
| 音视频在线播放：Media3/ExoPlayer 鉴权 `OkHttpDataSource` 支持 HTTP `Range`、拖动/缓冲提示、倍速 `1x/1.5x/2x`、静音、横屏全屏切换与失败回退下载 | `SRC/ui/viewer/MediaPlayerViewer.kt`、`SRC/data/media/DefaultMediaRepository.kt` | `TEST/data/media/DefaultMediaRepositoryTest.kt`、`TEST/ui/viewer/MarkdownParserTest.kt`（`formatMediaTime`） | **已代码核对 · 待真机复核** | 按系统返回键优先退出横屏全屏，再关闭播放器 |
| 长文本 / Markdown 与文本文件阅读器：`SelectionContainer` 局部选词、代码块横向滚动与复制、URL 可点击跳转、支持远程文本/Markdown/代码文件异步加载 | `SRC/ui/viewer/TextMarkdownViewer.kt`、`SRC/ui/viewer/MarkdownParser.kt` | `TEST/ui/viewer/MarkdownParserTest.kt`、`TEST/data/media/DefaultMediaRepositoryTest.kt` | **已自动化验证** + 真机排版复核 | 超过上限文件由 Stage 3A `Range` 保护截断，避免 OOM |
| 临时房间：创建/复进（Keystore 加密 `deviceKey`）、房间码+PIN 加入（`401 PIN_REQUIRED` 不触发登出、`403/404/429` 映射）、房主修改 6 位码与 PIN、复制房间码/复制链接/分享链接 | `SRC/data/room/DefaultRoomRepository.kt`、`SRC/ui/rooms/RoomViewModel.kt`、`SRC/ui/rooms/RoomDialogs.kt` | `TEST/data/room/DefaultRoomRepositoryTest.kt`、`TEST/ui/rooms/RoomViewModelTest.kt` | **已自动化验证** + 真机联调复核 | 临时房间可写态与受邀只读空间互不干扰，离开自动恢复原空间 |
| 单项分享 BottomSheet：有效期/次数创建、复制与分享 `/s/:token` 与 `/d/:token` 短链、分享历史列表状态胶囊与单条撤销 | `SRC/data/itemshare/DefaultItemShareRepository.kt`、`SRC/ui/share/ItemShareViewModel.kt`、`SRC/ui/share/ItemShareSheet.kt` | `TEST/data/itemshare/DefaultItemShareRepositoryTest.kt`、`TEST/ui/share/ItemShareViewModelTest.kt` | **已自动化验证** | 明确标注自定义预设跳转系统浏览器 |
| 应用更新弹窗：版本/体积/说明、同源 HTTPS + 禁重定向 + 200 MB 上限 + SHA-256 校验、「跳过这个版本」（仅自动弹窗）、`REQUEST_INSTALL_PACKAGES` 权限引导 | `SRC/data/update/DefaultAppUpdater.kt`、`SRC/data/update/UpdateFiles.kt`、`SRC/ui/settings/SettingsViewModel.kt`、`SRC/ui/settings/UpdateDialog.kt` | `TEST/data/update/DefaultAppUpdaterTest.kt`、`TEST/data/update/UpdateFilesTest.kt`、`TEST/ui/settings/SettingsViewModelTest.kt` | **已自动化验证** + 真机安装流程复核 | 授权返回后复用已校验缓存 APK，不重复下载 |

### F. 鉴权边界、安全区、键盘避让、返回键与无障碍

| 验收项 | 源码位置 | 自动化单测覆盖 | 状态 | 备注 |
| --- | --- | --- | --- | --- |
| 设置页 `browserSession()` / `adminBrowser()` 高级入口清单完整、标注安全原因、无死链、非管理员隐藏管理入口 | `SRC/ui/settings/SettingsViewModel.kt`、`SRC/ui/settings/SettingsScreen.kt` | `TEST/ui/settings/SettingsViewModelTest.kt`（`browserManagementLinks_matchSpecPathsAndGateAdminEntryByRole`） | **显式浏览器入口**（已自动化校验路径与角色显隐） | 详细路径核对见 §3 |
| Edge-to-Edge 状态栏/刘海/底部手势条安全区与深浅系统栏图标反色 | `SRC/MainActivity.kt`、`SRC/ui/navigation/DropitApp.kt`、`SRC/ui/board/BoardScreen.kt`、`SRC/ui/transfers/TransfersScreen.kt`、`SRC/ui/settings/SettingsScreen.kt` | 已代码核对（修复双 `navigationBarsPadding` 与引导页双 `statusBarsPadding`） | **已代码核对 · 待真机复核** | 需在全面屏手势导航与三键导航机型复核 |
| IME 软键盘避让（`adjustResize` + `imePadding()` + 可滚动容器） | `apps/android/app/src/main/AndroidManifest.xml`、`SRC/ui/onboarding/OnboardingScreen.kt`、`SRC/ui/board/BoardSheets.kt`、`SRC/ui/share/ShareTargetSheet.kt`、`SRC/ui/rooms/RoomDialogs.kt` | 已代码核对 | **已代码核对 · 待真机复核** | 发送/编辑/分享/房间弹窗均带 `imePadding() + verticalScroll` |
| 全局系统返回键退栈优先级（全屏视频 → 查看器 → 弹层/Dialog → 搜索 → 临时房间 → 非首页 Tab → 退出） | `SRC/ui/viewer/MediaPlayerViewer.kt`、`SRC/ui/viewer/ImageLightbox.kt`、`SRC/ui/viewer/TextMarkdownViewer.kt`、`SRC/ui/board/BoardScreen.kt`、`SRC/ui/navigation/DropitApp.kt` | 已代码核对 | **已代码核对 · 待真机复核** | 严格遵循 `docs/android-native-ux-spec.md` §2.2 优先级 |
| 触控热区 `>= 48.dp`、大字体 `1.5x–2.0x` 不重叠、纯图标 `contentDescription`、`LiveRegion` 播报 | `SRC/ui/**` 全量交互组件 | 已代码核对（本次审计修复全部 `< 48.dp` 热区与溢出风险） | **已代码核对 · 待真机复核** | 需在系统字号调至最大（`1.5x–2.0x`）下快速滑览复核 |

---

## 3. `browserSession()` / `adminBrowser()` 浏览器入口无死链核验

逐条核对 `apps/android/app/src/main/java/dev/dropit/app/ui/settings/SettingsViewModel.kt`（`SettingsBrowserLinks`）与 Web 端 `apps/web/src/pages/settings-page.tsx:32-33,266-290` 及 `apps/web/src/pages/admin-page.tsx:30-31`：

| 设置页入口文案 | 目标相对路径 | Web 路由真实性核验 | 可见角色 | 鉴权边界说明 |
| --- | --- | --- | --- | --- |
| 分享管理中心 | `/settings?tab=share-links` | `settings-page.tsx:33,286` (`<ShareLinks />`) ✅ | 全部用户 | 需 `browserSession()`，经系统浏览器/Custom Tabs 打开 |
| 分享选项预设 | `/settings?tab=share-presets` | `settings-page.tsx:33,287` (`<SharePresets />`) ✅ | 全部用户 | 需 `browserSession()`（原生单项分享弹窗底部亦直达此页） |
| 登录设备 | `/settings?tab=devices` | `settings-page.tsx:33,281` (`<DeviceSessions />`) ✅ | 全部用户 | 需 `browserSession()` |
| 登录方式与 OAuth 绑定 | `/settings?tab=login-methods` | `settings-page.tsx:33,266` (`<LoginMethods />`) ✅ | 全部用户 | 需 `browserSession()` |
| 修改密码 | `/settings?tab=password` | `settings-page.tsx:33,267` (`<PasswordForm />`) ✅ | 全部用户 | 需 `browserSession()` |
| 空间成员与邀请 | `/settings?tab=space-sharing` | `settings-page.tsx:33,285` (`<SpaceSharing />`) ✅ | 全部用户 | 统一归属系统浏览器设置页管理成员与邀请 |
| 访问令牌与设备码确认 | `/settings?tab=tokens` | `settings-page.tsx:33,289`（同页侧栏切 `device-code`）✅ | 全部用户 | 需 `browserSession()` |
| 管理员设置 | `/admin` | `admin-page.tsx:120` (`AdminPage`) ✅ | **仅 `role == "admin"`** | 需 `adminBrowser()`；普通用户完全隐藏 |

- **显著安全提示文案**（`SettingsBrowserLinks.SECURITY_NOTICE`）：`为保护账户安全，此页在系统浏览器打开（需完整浏览器会话验证）`，每条入口右侧配外链图标 `OpenInNew` 与无障碍说明 `"<标题>，在系统浏览器打开"`，绝不误导为已全量原生。
- **服务端边界**：未修改 `apps/server/**`，未削弱任何 `browserSession()` / `adminBrowser()` 校验。

---

## 4. 面向 Lthero 的 10 分钟真机覆盖升级与体验手测清单

> **前置准备**：一部已安装旧版 dropit Android（`0.3.2 / versionCode 5`）且已登录线上或测试服务器的 Android 手机；准备 1 张照片、1 个 `> 20 MB` 的视频或压缩包（建议使用含中文与空格的文件名，如 `2026 年度评审 + 演示.mp4`）、1 个 `.md` 或 `.txt` 文件；以及一个受邀只读空间账号（可选）。

### 阶段 1 · 覆盖升级与冷启动（约 2 分钟）
1. **旧版覆盖安装**：不卸载旧版 `0.3.2`，直接安装由 CI 产出的同签名原生 APK（`0.4.0-native / code 6`），确认系统提示「更新」而非签名冲突。
2. **迁移与免重登**：首次打开新版，确认**无需重新输入服务器地址、无需重新设备码授权**，直接进入纸感主看板并加载数据；彻底杀进程重启两次，确认登录态与主题设置持续保留。
3. **飞行模式冷启动**：开启飞行模式 → 划掉后台 → 冷启动 App，确认首帧秒开原生界面（无白屏、无 5 秒更新卡顿）、顶部展示暖琥珀离线条与居中「重新连接」按钮；关闭飞行模式后点击「重新连接」或等待自动恢复，确认列表与 WS 状态胶囊切回绿点。

### 阶段 2 · 常用收发、权限边界与键盘/返回键（约 2.5 分钟）
4. **文本与剪贴板收发**：点击底部悬浮条「发文本」，确认输入框和发送按钮贴合软键盘上方不被遮挡；输入文本发送并验证另一台设备实时收到；点击「剪贴板」验证前台一键发送；在卡片上测试「复制」（绿勾反馈）、长按「更多」→ 编辑文本（修改后点返回确认弹出「放弃未保存的修改？」）→ 置顶 → 修改分组与标签 → 撤回（确认弹出二次确认 Dialog）。
5. **只读空间隔离**（若有受邀只读空间）：切至受邀只读空间，确认顶部显示 `只读` 胶囊与只读横幅、底部发送条与「新建分组」完全隐藏、卡片「更多」菜单仅保留复制/保存/预览/复制下载链接。
6. **大字体与主题切换**：进入「设置」切换「浅色纸感 / 深色纸感 / 跟随系统」，核对深色下无纯黑底色与状态栏图标反色清晰；点开任意「账户与高级管理」外链确认直达对应 Web 设置页且无 404；将系统字号临时调大至最大，快速浏览内容页、传输页与设置页确认无重叠裁切。

### 阶段 3 · 系统分享与大文件断点续传（约 3 分钟）
7. **微信 / 相册 / 浏览器系统分享**：
   - 从浏览器分享一段链接或文本到 dropit → 确认弹出原生「发送到 dropit」确认面板（默认本人私有空间、自动隐藏只读空间）→ 连续快点「确认发送」仅发送 1 条。
   - 从系统相册多选 2–3 张图片/文件分享到 dropit → 在面板中移除其中 1 个文件并选择目标分组 → 确认发送后自动切至「传输」页看到实时进度；从多任务最近列表重新切回 dropit，确认不会重复弹出分享面板。
8. **大文件断点续传与中文名下载**：
   - 在内容页点「发文件」选择 `> 20 MB` 中文名文件，在「传输」页观察进度条、速度与剩余时间；上传中途切换飞行模式或划掉 App 后重新打开，确认「传输」页展示真实中断/失败状态而非丢失或误报完成；恢复网络后点击「继续传输 / 重试」完成续传，并测试对失败项点「移除」→「清理已完成」。
   - 在内容页对含中文和 `+` 符号的文件点「保存」，确认系统「下载」目录中文件名完整无乱码；再点卡片「分享」转发给微信/其他 App。

### 阶段 4 · 多媒体预览、临时房间、单项分享与更新（约 2.5 分钟）
9. **图片 / 音视频 / 文本文件预览**：
   - 点击图片进入全屏灯箱：测试双指缩放、双击放大、左右滑动切换多图、单指下拉关闭、保存原图。
   - 点击视频/音频进入播放器：测试进度条拖动（Range）、倍速切换、横屏全屏；**按系统返回键**确认第 1 下先退回竖屏、第 2 下关闭播放器。
   - 点击 `.md` / `.txt` 文件或长文本进入全文阅读器：测试长按局部选词、代码块复制与点击链接跳转浏览器。
10. **临时房间、单项分享与更新**：
    - 顶栏空间胶囊 → 进入「我的临时房间」→ 测试「复制房间码」「复制链接」「修改房间码/PIN」，并用另一台设备或「输入房间码」验证 PIN 校验与错误提示；按系统返回键确认从临时房间退回我的空间。
    - 任意条目「更多」→「分享链接」→ 创建只读短链，复制 `/s/` 与 `/d/` 链接验证可访问，再点「撤销」确认立即失效。
    - 「设置」→「检查更新」：核对版本号格式与结果提示（若测试服已发布更高 `versionCode` 的 APK，一并复核下载进度、SHA-256 校验与「安装未知应用」权限引导）。
