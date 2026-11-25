# dropit Android 原生客户端发布、覆盖升级与回滚指南

本文档面向 dropit 维护者与自托管部署管理员，说明如何构建、校验签名、发布纯 Kotlin + Jetpack Compose 原生 Android 客户端（`0.4.0 / versionCode 6` 及后续版本），如何验证从旧版 Capacitor 壳（`0.3.2 / versionCode 5`）无损覆盖升级，以及发生异常时的回滚方案。

---

## 1. 发布基线与构建标识

原生 Android 工程位于 `apps/android/`，与旧版 Capacitor 工程（`mobile/android/`）保持完全一致的应用包名、签名证书与 `FileProvider` 授权，以确保系统允许直接覆盖安装并保留本地存储。

| 配置项 | 旧版 Capacitor（`mobile/android/`） | 新版原生 Kotlin（`apps/android/`） | 源码位置 |
| --- | --- | --- | --- |
| `applicationId` / `namespace` | `dev.dropit.app` | `dev.dropit.app` | `apps/android/app/build.gradle.kts` |
| `minSdk` / `compileSdk` / `targetSdk` | `23` / `35` / `35` | `23` / `35` / `35` | `apps/android/app/build.gradle.kts` |
| `versionCode` | `5` | `6`（严格递增） | `apps/android/app/build.gradle.kts` |
| `versionName` | `0.3.2` | `0.4.0` | `apps/android/app/build.gradle.kts` |
| 构建元数据注入 | `mobile/www/build-info.js` | `BuildConfig.BUILD_COMMIT` / `BUILD_DATE` | `DROPIT_BUILD_COMMIT` / `DROPIT_BUILD_DATE` |
| 固定签名配置 | `DROPIT_KEYSTORE`（PKCS12，alias `dropit`） | `DROPIT_KEYSTORE`（PKCS12，alias `dropit`） | `signingConfigs.create("dropit")` |
| `FileProvider` Authority | `${applicationId}.fileprovider` | `${applicationId}.fileprovider` | `apps/android/app/src/main/AndroidManifest.xml` |
| 产物命名 | `dropit-android-<version>-<short>.apk` | `dropit-android-<version>-<short>.apk` + `.sha256` | `.github/workflows/android-native.yml` |

> **关键约束**：`apps/android/app/src/main/res/xml/file_paths.xml` 保留 `<cache-path name="my_cache_images" path="." />` 与 `<external-path name="my_images" path="." />`，确保应用内更新（`cacheDir/updates/dropit-update.apk`）和文件分享缓存（`cacheDir/shared_downloads/...`）通过 `dev.dropit.app.fileprovider` 正常授予临时读权限。

---

## 2. CI 发布流水线切换与签名校验

### 2.1 GitHub Actions 工作流分工

自 `0.4.0 (code 6)` 起，默认 Android 构建与发布流水线正式切换至原生工作流：

- **默认构建与发布：`.github/workflows/android-native.yml`（`Android Native APK`）**
  - 触发条件：`workflow_dispatch`、`push` 到 `main`（改动 `apps/android/**`、工作流本身或 `scripts/publish-android-apk.mjs`）以及对应路径的 `pull_request`。
  - 自动化验证步骤：
    1. 在 GitHub Actions Runner 本地构建并启动真实 `@dropit/server` 实例（`127.0.0.1:18787`，独立临时 `DATA_DIR`，不碰任何线上环境），通过 `scripts/publish-android-apk.mjs` 预发布测试更新包（`code 7 / 0.4.1`）。
    2. 携带 `DROPIT_REQUIRE_LIVE_SERVER=1` 执行 `./gradlew testDebugUnitTest assembleDebug --no-daemon`，运行全量单元测试与真实服务端端到端协议回归套件（`RealServerProtocolRegressionTest`、`ProtocolContractRegressionTest` 等）。
    3. 解码仓库 Secret `ANDROID_KEYSTORE_B64` / `ANDROID_KEYSTORE_PASSWORD` 写入临时 PKCS12 密钥库 `DROPIT_KEYSTORE` 并签名 APK（若为无 Secret 的 Fork PR，自动回退默认 debug 密钥，并在 Summary 明确标注 `default-debug-keystore`）。
    4. 按规范输出 `dropit-android-<version>-<short>.apk` 与 `dropit-android-<version>-<short>.apk.sha256`，运行 `apksigner verify --print-certs` 校验签名并在 Job Summary 输出 APK SHA-256 与签名证书 SHA-256 指纹。
    5. 使用真实构建出的 APK 对 `scripts/publish-android-apk.mjs` 执行兼容性烟雾校验（核对生成的 `latest.json` 中 `versionCode`、`versionName`、`size`、`sha256`、`file` 完全一致）。
    6. 上传 artifact `dropit-android-apk`（保留 30 天）。
- **旧版回滚专用：`.github/workflows/android.yml`（`Android Legacy APK (Capacitor Rollback)`）**
  - 仅用于 `mobile/**` 维护或紧急回滚构建旧版 Capacitor APK，产物名为 `dropit-android-legacy-debug-apk`，与原生 `dropit-android-apk` 严格隔离，不会在修改 `apps/android/**` 时重复触发。

### 2.2 本地 / 发布前签名与完整性核对

下载 GitHub Actions 产物 `dropit-android-apk`（包含 `.apk` 与 `.apk.sha256`）后，在发布到服务端前执行以下校验：

```bash
# 1. 校验 APK 文件 SHA-256 与 CI 输出完全一致
sha256sum -c dropit-android-0.4.0-<short>.apk.sha256

# 2. 使用 Android SDK build-tools 核对签名证书指纹（应与旧版 0.3.2 签名指纹完全相同）
apksigner verify --verbose --print-certs dropit-android-0.4.0-<short>.apk

# 3. 核对 APK 的 applicationId、versionCode 与 versionName
aapt2 dump badging dropit-android-0.4.0-<short>.apk | grep -E "package:|sdkVersion:|targetSdkVersion:"
```

预期输出要点：
- `package: name='dev.dropit.app' versionCode='6' versionName='0.4.0'`
- `Signer #1 certificate SHA-256 digest` 与已安装的 `0.3.2 (code 5)` APK 完全一致（如不一致，Android 系统会拒绝覆盖安装并提示“应用未安装 / 签名冲突”）。
- 也可通过 `adb` 对比手机上已装旧版签名指纹：
  ```bash
  adb shell dumpsys package dev.dropit.app | grep -E "versionCode=|versionName=|signatures:"
  ```

---

## 3. 从 Capacitor 0.3.2 (code 5) 覆盖升级到原生 0.4.0 (code 6) 真机验证步骤

原生客户端通过 `LegacyCapacitorMigrator`（`apps/android/app/src/main/java/dev/dropit/app/core/auth/LegacyCapacitorMigrator.kt`）在首次冷启动时幂等迁入旧版数据，并将设备令牌使用 Android Keystore AES-256-GCM 加密转存至 `TokenVault`（`dropit_token_vault`），非敏感配置转存至 DataStore（`dropit_settings`）。

### 3.1 升级前准备（保留旧版基线状态）

1. 在测试手机上确认当前安装的是同一签名密钥构建的 `dropit 0.3.2 (versionCode 5)`。
2. 确认旧版已连接到测试/目标 HTTPS dropit 服务器并已登录（已存在 `CapacitorStorage` 中的 `server`、`token`、`deviceId` 及可选 `skipUpdate`，以及 `dropit_app` 中的 `origin`）。
3. 记下当前登录账号、服务器地址，以及旧版设备列表中显示的设备 ID（`and-...`）。
4. （可选）先在旧版里检查「设置」或发一条测试文本，确认旧版令牌当前有效。

### 3.2 执行覆盖安装

以下任选一种方式安装，**切勿先卸载旧版**：

- **方式 A（应用内自动更新）**：在服务端通过第 4 节命令发布 `0.4.0 (code 6)` 后，在旧版 `0.3.2` 中触发「检查更新」→ 下载校验 SHA-256 → 系统安装器点击「更新」。
- **方式 B（ADB / 手动安装）**：
  ```bash
  adb install -r dropit-android-0.4.0-<short>.apk
  ```
  验证系统返回 `Success`（无 `INSTALL_FAILED_UPDATE_INCOMPATIBLE` 签名冲突或 `INSTALL_FAILED_VERSION_DOWNGRADE` 降级错误）。

### 3.3 覆盖升级后逐项核对清单

1. **首次冷启动零重登与数据保留**：
   - 打开应用，首帧直接进入原生剪贴板主界面，**无需重新输入服务器地址，也无需重新走设备码授权**。
   - 打开「设置」页：
     - 核对版本标签显示 `版本 0.4.0 · <short> · <YYYY-MM-DD>`。
     - 核对服务器地址与旧版完全一致（自动去掉尾部多余 `/`）。
     - 核对账号与主空间列表正常加载，旧版 `read/write/web` 作用域令牌直接复用成功。
   - 在剪贴板发送一条文本，核对卡片元信息与 Web 端在线设备列表保留原 `deviceId`（未生成新设备重复项）。
2. **重复冷启动幂等性（不丢登录态）**：
   - 上划彻底杀死进程（或执行 `adb shell am force-stop dev.dropit.app`），重新冷启动至少 2 次。
   - 确认每次均直接进入主界面，服务器地址、加密令牌与 `deviceId` 均完整保留，不会重复触发迁移覆盖或清空状态。
3. **旧版 WebView 残留与安全边界核对**：
   - 升级后不再加载旧版 Capacitor WebView 壳，也不会在冷启动时阻塞请求 `/api/app-session/ticket`。
   - 原生端不再依赖旧版 `CapacitorStorage` 明文存储；若需进一步清理升级前残留的旧版 WebView 缓存目录，可在验证升级稳定后按需在系统应用信息中仅清理**缓存（Clear Cache）**（**切勿点“清除存储空间/数据”**，否则会一并清除新迁移的 DataStore 与 Keystore 密文）。
   - 若旧版令牌已被服务端吊销：升级启动后收到 `401 UNAUTHENTICATED` 应保留当前服务器地址，弹出清晰重登引导并一键重新发起设备码授权。
   - 在「设置 → 切换服务器」中验证切换服务器时，会原子清理旧服务器令牌、临时房间密钥、传输队列、待确认分享、更新缓存与图片缓存。

---

## 4. 服务端自托管发布命令示例

服务端通过 `/api/app/android/latest` 与 `/api/app/android/download/<file>.apk` 向客户端分发更新（详见 `apps/server/src/app-release.ts` 与 `scripts/publish-android-apk.mjs`）。脚本会原子写入 `latest.json`（含 `versionCode`、`versionName`、`notes`、`file`、`sha256`、`size`、`publishedAt`）并自动清理同目录下的旧版 `.apk`。

> **注意**：`scripts/publish-android-apk.mjs` 只接受单个发布目录；生产环境部署与发布由总任务负责人执行，发布前请先按运维规范备份数据卷。

### 4.1 源码 / 宿主机直接部署

```bash
# 假设 DATA_DIR 为 /var/lib/dropit/data（默认不传 --dir 时读取 $DATA_DIR/app/android）
node scripts/publish-android-apk.mjs \
  /path/to/dropit-android-0.4.0-<short>.apk \
  --code 6 \
  --name 0.4.0 \
  --notes $'全新 Kotlin + Jetpack Compose 原生客户端\n- 本地优先冷启动，原生支持覆盖升级保留登录态\n- 并行分片断点续传、系统分享目标、媒体预览与临时房间' \
  --dir "$DATA_DIR/app/android"
```

### 4.2 Docker 容器部署（卷挂载 `/data`）

先在宿主机临时目录执行发布脚本生成标准化文件与 `latest.json`，再复制到运行中容器的数据卷：

```bash
# 1. 在临时目录生成 dropit-android-0.4.0.apk 与 latest.json
TMP_PUB="$(mktemp -d)"
node scripts/publish-android-apk.mjs \
  /path/to/dropit-android-0.4.0-<short>.apk \
  --code 6 \
  --name 0.4.0 \
  --notes $'全新 Kotlin + Jetpack Compose 原生客户端\n- 原生覆盖升级保留服务器与登录态\n- 分片断点续传、系统分享、多媒体预览与临时房间' \
  --dir "$TMP_PUB"

# 2. 核对生成的 latest.json
cat "$TMP_PUB/latest.json"

# 3. 写入容器数据卷并清理旧版 APK（容器名为 dropit）
docker exec dropit mkdir -p /data/app/android
docker exec dropit sh -c 'rm -f /data/app/android/*.apk'
docker cp "$TMP_PUB/." dropit:/data/app/android/
rm -rf "$TMP_PUB"

# 4. 线上只读验证接口返回
curl -fsS https://<your-dropit-domain>/api/app/android/latest
```

预期 `/api/app/android/latest` 返回 HTTP 200，`Cache-Control: no-store`，且 JSON 中：
- `"versionCode": 6`
- `"versionName": "0.4.0"`
- `"url": "/api/app/android/download/dropit-android-0.4.0.apk"`
- `"sha256"` 与 CI 产物 `.sha256` 完全一致。

---

## 5. 异常回滚策略

若发布 `0.4.0 (code 6)` 后在真机发现阻断性问题，按影响范围分层处理：

### 5.1 立即停止新设备自动升级（无需发版，秒级生效）

1. **撤下服务端更新清单**（尚未升级的 `0.3.2` 设备检查更新将收到 `404 NO_RELEASE`，停止弹窗提示）：
   - 宿主机部署：`rm -f "$DATA_DIR/app/android/latest.json" "$DATA_DIR/app/android/dropit-android-0.4.0.apk"`
   - Docker 部署：`docker exec dropit rm -f /data/app/android/latest.json /data/app/android/dropit-android-0.4.0.apk`
2. 验证 `GET /api/app/android/latest` 返回 `404 {"error":{"code":"NO_RELEASE"}}`。

### 5.2 已升级到 0.4.0 (code 6) 设备的两种回滚路径

Android 系统禁止直接将低 `versionCode`（5）覆盖安装到高 `versionCode`（6）之上（会触发 `INSTALL_FAILED_VERSION_DOWNGRADE`）。根据严重程度二选一：

- **方案 A（推荐，快速热修向前发布 `0.4.1 / versionCode 7`）**：
  - 在 `apps/android/` 修复缺陷并将 `versionCode` 递增为 `7`、`versionName` 设为 `"0.4.1"`，经 `.github/workflows/android-native.yml` 构建签名后，用第 4 节命令重新发布。
  - 已升级到 `0.4.0` 的设备通过内置更新检查即可无损覆盖升级至 `0.4.1`，不丢任何数据。
- **方案 B（紧急回退到 Capacitor 壳）**：
  - **路径 B1（需覆盖回退，免卸载）**：如必须让已装 `code 6` 的设备直接退回 Capacitor 壳，可在独立回滚分支临时将 `mobile/android/app/build.gradle` 的 `versionCode` 升至 `7`、`versionName` 设为 `"0.3.3-rollback"`，手动触发 `.github/workflows/android.yml`（`Android Legacy APK (Capacitor Rollback)`）使用同一 `ANDROID_KEYSTORE_B64` 签名产出安装包并发布。注意：`LegacyCapacitorMigrator` 迁移时**从未删除**旧版 `CapacitorStorage` 与 `dropit_app` 中的原始键值，因此回退后原旧版配置通常仍可读；若为全新安装过 `0.4.0` 的设备则只需重新走一次设备码登录。
  - **路径 B2（单机彻底回退到旧 `0.3.2 / code 5`）**：在测试机卸载 `0.4.0` 后重新安装存档的 `dropit-android-0.3.2-*.apk`，输入服务器地址并重新通过设备码登录（服务端所有云端数据均不受客户端卸载影响）。

### 5.3 CI / 仓库层面的代码回滚

- 原生客户端完全独立于 `apps/android/`，旧版 Capacitor 源码完整保留在 `mobile/`，且服务端接口零破坏性变更。
- 若需暂停原生版本发布，只需撤下服务端 `latest.json`（5.1）并暂停使用 `android-native.yml` 产物即可，无需回滚服务端容器或数据库。
