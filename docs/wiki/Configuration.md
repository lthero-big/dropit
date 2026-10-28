# 配置

所有配置都来自进程环境变量（开发模式额外读取仓库根目录 `.env`）。启动时 `loadConfig()` 校验全部取值，任何不合法的值或跨字段冲突都会让进程拒绝启动。完整参考表见仓库 [docs/backend-config.md](https://github.com/lthero-big/dropit/blob/main/docs/backend-config.md)。

## 基础

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `NODE_ENV` | `development`；镜像 `production` | `production` 且站点地址为 https 时启用 Secure Cookie 与 HSTS；站点地址为 http 时只警告，不拒绝启动 |
| `APP_ORIGIN` | 空 | 浏览器访问的 origin（协议 + 域名或 IP + 端口，无路径）。为空时按每个请求自己的地址处理。可在「管理 → 站点地址」修改，页面设置优先 |
| `RESET_APP_ORIGIN` | 未设置 | 设为 `1` 时启动会清除页面保存的站点地址（改错地址、进不去后台时用，用完删掉） |
| `PORT` | `8787` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `DATA_DIR` | 仓库 `data/`；镜像 `/data` | SQLite 与文件目录 |
| `STATIC_DIR` | `apps/web/dist`；镜像 `/app/public` | 前端构建产物 |
| `TRUST_PROXY` | 空 | 受信任反代 IP/CIDR，逗号分隔，可用 `loopback` |

## 站点地址（APP_ORIGIN）

生效顺序：**「管理 → 站点地址」页面设置 > 环境变量 `APP_ORIGIN` > 按请求地址自动处理**。

- 设置了站点地址时：写请求和 WebSocket 的 `Origin` 必须与它完全一致；OAuth 回调、邀请 / 分享链接、`/device` 链接都用它生成。
- 未设置时：`Origin` 必须与请求自身的地址一致（协议取连接本身，只有 `TRUST_PROXY` 里的反代发来的 `X-Forwarded-Proto` / `X-Forwarded-Host` 才被采用；主机取 `Host` 头），链接也按请求地址生成。适合快速试用和局域网。
- 页面上保存的地址立即生效，不用重启；保存一个与当前访问地址不同的值需要二次确认，防止把自己锁在外面。真锁住了就用 `RESET_APP_ORIGIN=1` 启动一次。
- 地址不一致时，登录页和错误提示会直接写出「当前访问地址」和「APP_ORIGIN」，并说明改成什么。
- 启动日志会打印 `dropit APP_ORIGIN: ...`（以及来源）；`NODE_ENV=production` 但站点地址是 http、或页面设置覆盖了环境变量时，会打印 `dropit warning: ...`，后台也会显示同样的提示。

## 更新检查

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `UPDATE_CHECK` | `true` | `false` / `0` / `off` 关闭；关闭后不访问外网 |
| `UPDATE_CHECK_HOURS` | `12` | 检查间隔，6–168 小时 |
| `UPDATE_IMAGE` | `lthero1/dropit` | Docker 部署时检查的 Docker Hub 镜像 |
| `UPDATE_REPO` | `lthero-big/dropit` | 源码部署比较提交、读取 Releases 的 GitHub 仓库 |
| `UPDATE_BRANCH` | `main` | 源码部署比较的上游分支 |
| `DROPIT_VERSION` / `DROPIT_COMMIT` / `DROPIT_BUILD_DATE` | 构建时写入 | 覆盖 `/api/version` 的版本信息，一般由 Docker build-arg 或 `pnpm build` 自动设置 |
| `DROPIT_INSTALL` | 镜像 `docker`；compose 构建 `docker-build`；其他 `source` | 决定后台显示哪条升级命令 |

## 登录

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | 未设置 | 成对设置才开放 GitHub 登录 |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | 未设置 | 成对设置才开放 Google 登录 |
| `ADMIN_EMAILS` | 空 | 可选，逗号分隔的已验证邮箱，注册时即为管理员 |
| `SESSION_HOURS` | 168 | 会话绝对有效期 |

## 内容限额

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `MAX_FILE_BYTES` | 26214400（25 MiB） | 单文件上限 |
| `MAX_TEXT_BYTES` | 65536 | 单条文本 UTF-8 字节数 |
| `MAX_ITEMS` | 1000 | 每个空间条目数；房间为 min(100, MAX_ITEMS) |
| `USER_QUOTA_BYTES` | 1073741824（1 GiB） | 每用户默认配额，管理员可单独覆盖 |
| `RETENTION_HOURS` | 168 | 空间条目保留时长 |
| `ROOM_MAX_FILE_BYTES` | 5242880（5 MiB） | 房间单文件上限，须小于 `MAX_FILE_BYTES` |
| `ROOM_QUOTA_BYTES` | 52428800（50 MiB） | 房间总量，须小于 `USER_QUOTA_BYTES` |
| `ROOM_RETENTION_HOURS` | 24 | ≤ 24 且 ≤ `RETENTION_HOURS` |
| `CLEANUP_INTERVAL_MS` | 60000 | 清理任务间隔 |

## 限流

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `RATE_WINDOW_MS` | 60000 | 固定窗口长度 |
| `RATE_GENERAL` | 240 | 每 IP / 账号 / 窗口的普通请求 |
| `RATE_AUTH` | 20 | 认证请求，须小于 `RATE_GENERAL` |
| `RATE_INVITE` | 10 | 邀请请求，须小于 `RATE_GENERAL` |
| `RATE_UPLOAD` | 30 | 上传 / 写请求，也是房间访问限制 |
| `RATE_ROOM` | 10 | 房间创建 / 写请求，须小于 `RATE_UPLOAD` |
| `RATE_TOKEN` | 120 | 每个个人访问令牌额外的普通请求额度 |
| `RATE_CHUNK` | 2000 | 分片 PUT 独立额度 |

## 分片上传

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `UPLOAD_CHUNK_BYTES` | 8388608（8 MiB） | 分片大小，64 KiB–24 MiB |
| `UPLOAD_CHUNK_TIMEOUT_MS` | 120000 | 单个分片请求体超时 |
| `UPLOAD_CHUNKS_PER_SESSION` | 3 | 每个上传会话并发分片 |
| `UPLOAD_CHUNKS_PER_USER` | 6 | 每账号并发分片（匿名按房间） |
| `UPLOAD_CHUNKS_GLOBAL` | 16 | 进程内并发分片 |
| `UPLOAD_SESSIONS_PER_USER` | 8 | 每账号未完成会话（匿名按房间） |
| `UPLOAD_SESSIONS_GLOBAL` | 128 | 全局未完成会话 |

## 运行时覆盖

管理员可以在后台（或 `PATCH /api/admin/limits`）修改上面「内容限额 / 限流 / 分片上传 / 会话」中的 23 项限额：

- 优先级：**SQLite 运行时覆盖 > 环境变量默认值**；把某项设为 `null` 即恢复环境默认。
- 修改对新请求立即生效，无需重启；每次修改都写入 `/api/admin/limits/audit` 审计记录。
- 保留期修改只影响新条目和新房间；调低配额不会删除已有内容。
- 硬上限（如单文件 1 GiB、配额 100 GiB、保留期 365 天、房间保留 24 小时）对环境变量和覆盖同样生效。
- `TRUST_PROXY`、`DATA_DIR`、`ADMIN_EMAILS`、`RATE_TOKEN`、端口和清理间隔只在启动时读取；站点地址（`APP_ORIGIN`）可以在「管理 → 站点地址」修改并立即生效。
