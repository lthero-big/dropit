---
title: 后端配置参考
description: 完整的环境变量、运行时覆盖与硬上限参考。
---

:::note
本页译自仓库 [docs/backend-config.md](https://github.com/lthero-big/dropit/blob/main/docs/backend-config.md)（英文原文，被测试引用）。两者不一致时以英文原文为准。
:::

用进程管理器或 Compose 把 `.env` 加载进进程环境；后端自己不读取密钥文件。启动时 `loadConfig()` 校验各项环境默认值，之后已持久化的运行时覆盖优先生效。
后端以单个 Node 22+ 进程运行。所有模式下都可以使用 HTTP；当 `NODE_ENV=production` 且站点地址为 https（通常由可信反向代理终止 TLS）时，Cookie 带 Secure 标志并发送 HSTS。生产模式下站点地址为 http 时只会在日志里给出警告。

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `NODE_ENV` | development（镜像中为 production） | `production` 时，若站点地址为 https，则启用 Secure Cookie 和 HSTS |
| `APP_ORIGIN` | 空 | 浏览器访问的源（origin），不含路径。为空时使用每个请求自身的源。可被 管理后台 → 站点地址（`/api/admin/site`）覆盖 |
| `RESET_APP_ORIGIN` | 未设置 | 设为 `1` 时在启动时清除管理后台设置的站点地址 |
| `PORT` | 8787 | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址（示例配置在本地开发时使用回环地址） |
| `DATA_DIR` | 仓库内 `data/` | 持久化 SQLite 与文件的目录；镜像中设为 `/data` |
| `STATIC_DIR` | `apps/web/dist` | 前端构建产物目录；镜像中设为 `/app/public` |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | 未设置 | 可选，需成对设置。在尚无任何账号时，启动时创建该管理员并跳过 `/setup`（否则日志会打印 `dropit setup code: XXXX-XXXX`）。一旦存在任何账号即被忽略。必须同时设置；邮箱需合法，密码 8–256 个字符，否则启动失败 |
| `ADMIN_EMAILS` | 空 | 可选，逗号分隔的已验证邮箱列表，这些邮箱登录时同样创建为管理员。无论是否设置，用户表为空时第一个登录的人都是管理员 |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | 未设置 | 两者都设置时才启用 GitHub 登录 |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | 未设置 | 两者都设置时才启用 Google 登录 |
| `UPDATE_CHECK` | true | `false`/`0`/`off` 关闭定期检查新版本（不再发出任何外部请求） |
| `UPDATE_CHECK_HOURS` | 12 | 检查间隔（小时），6–168 |
| `UPDATE_IMAGE` / `UPDATE_REPO` / `UPDATE_BRANCH` | `lthero1/dropit` / `lthero-big/dropit` / `main` | 与当前运行版本比较的 Docker Hub 镜像以及 GitHub 仓库/分支 |
| `DROPIT_VERSION` / `DROPIT_COMMIT` / `DROPIT_BUILD_DATE` / `DROPIT_INSTALL` | 构建时设置 | `GET /api/version` 返回的构建信息；Docker 构建参数（build-arg）会变成这些变量 |
| `TRUST_PROXY` | 空 | 逗号分隔的可信代理 CIDR/IP（允许 `loopback`）；切勿无条件信任所有地址 |
| `MAX_FILE_BYTES` | 26214400 | 单个文件 25 MiB |
| `USER_QUOTA_BYTES` | 1073741824 | 默认 1 GiB，统计一个用户的全部上传和文本。管理员可为单个用户设置覆盖值；`null` 表示沿用此默认值 |
| `RETENTION_HOURS` | 168 | 私有/共享条目的保留时长 |
| `ROOM_MAX_FILE_BYTES` | 5242880 | 5 MiB，必须小于 MAX_FILE_BYTES |
| `ROOM_QUOTA_BYTES` | 52428800 | 50 MiB，必须小于 USER_QUOTA_BYTES |
| `ROOM_RETENTION_HOURS` | 24 | 必须 <=24 且 <=RETENTION_HOURS |
| `SESSION_HOURS` | 168 | 服务器会话的绝对有效期 |
| `CLEANUP_INTERVAL_MS` | 60000 | 清理过期内容/删除队列的间隔 |
| `MAX_TEXT_BYTES` | 65536 | 文本的 UTF-8 字节数上限 |
| `MAX_ITEMS` | 1000 | 每个空间的条目数上限；房间上限为 min(100, MAX_ITEMS) |
| `RATE_WINDOW_MS` | 60000 | 固定限流窗口 |
| `RATE_GENERAL` | 240 | 每个 IP、每个账号、每个窗口的请求数 |
| `RATE_AUTH` | 20 | 每个 IP、每个窗口的认证请求数，也是每个 IP、每个房间码可输错房间码/PIN 的次数预算；必须小于 RATE_GENERAL |
| `PIN_LOCK_FAILURES` | 10 | 一个房间码（来自任意 IP）累计输错 PIN 达到该次数后被锁定 |
| `PIN_LOCK_MINUTES` | 15 | 被锁定的房间码对所有 PIN 尝试返回 `429` 的时长（也是统计失败次数的窗口）；最大 10080 |
| `RATE_INVITE` | 10 | 每个 IP、每个账号、每个窗口的邀请请求数；必须小于 RATE_GENERAL |
| `RATE_UPLOAD` | 30 | 每个 IP、每个账号、每个窗口的上传/写入请求数；也是房间访问限额 |
| `RATE_ROOM` | 10 | 每个 IP、每个账号、每个窗口的房间创建/写入请求数；必须小于 RATE_UPLOAD |
| `RATE_TOKEN` | 120 | 每个个人访问令牌（PAT）每个窗口额外的普通请求数；分片 PUT 改用 RATE_CHUNK |
| `UPLOAD_CHUNK_BYTES` | 8388608 | 新上传的分片大小，64 KiB–24 MiB；默认 8 MiB，适配 nginx `client_max_body_size 30m` |
| `UPLOAD_CHUNK_TIMEOUT_MS` | 120000 | 每个 PUT 请求体的截止时间；整个文件没有总截止时间 |
| `UPLOAD_CHUNKS_PER_SESSION` | 3 | 每个上传会话的并发分片写入数 |
| `UPLOAD_CHUNKS_PER_USER` | 6 | 每个已登录账号的并发分片写入数（匿名：按房间计） |
| `UPLOAD_CHUNKS_GLOBAL` | 16 | 本进程内的并发分片写入数 |
| `UPLOAD_SESSIONS_PER_USER` | 8 | 每个账号未完成的上传会话数（匿名：按房间计） |
| `UPLOAD_SESSIONS_GLOBAL` | 128 | 全局未完成的上传会话数 |
| `RATE_CHUNK` | 2000 | 分片 PUT 独立的请求数限额（每 IP/账号/PAT/窗口）；不占用普通请求/写入的限流桶 |

数值类设置都是正整数。房间限额高于私有空间限额、或保留时长超过 24 小时的配置会被拒绝。会话/OAuth/房间/邀请的密钥均为密码学安全的随机值；会话、邀请和房间密钥只以哈希形式存储。

用 `pnpm --filter @dropit/server test` 运行模拟 OAuth、HTTP/SQLite/磁盘集成测试以及真实 WebSocket 测试；`typecheck` 和 `build` 校验服务端 TypeScript。前端的具体调用方式以及事件/重连语义见 [API 契约](../../api/reference/)。

## 运行时覆盖与硬上限

管理员可以通过 `/api/admin/limits` 读取、修改和重置运行时限额；审计历史在 `/api/admin/limits/audit`。两者都接受管理员会话或 PAT，但只读的 Bearer 令牌不能 PATCH。请求体、跨字段规则、分页和生效时间语义见 [API 契约](../../api/reference/#运行时限额策略)。

优先级为 **SQLite 运行时覆盖 > 环境变量默认值**。移除覆盖（设为 `null`）会恢复本次进程启动时加载的环境默认值。修改环境变量仍需重启；已有的覆盖依然优先。API 会按键返回当前值、环境默认值、是否被覆盖以及取值范围。不会暴露任何密钥、路径、OAuth 或代理设置。

迁移 v7 在 `DATA_DIR/dropit.sqlite` 中新增 `runtime_limits` 和只追加的 `limit_audit` 表；审计记录与覆盖修改在同一个事务里提交。进程/容器重启以及重建容器时请挂载同一个持久化数据卷（镜像使用 `/data`，Compose 使用 `dropit-data` 卷）。备份数据库时连同审计记录一起备份。删除数据卷会同时删除覆盖、审计和内容。只运行一个服务进程；覆盖在加载后保存在内存中，这不是多实例同步机制。

所有可修改的值都是正的安全整数，最小值为 1，`uploadChunkBytes` 除外（最小 65536）。下列代码层面的上限同时作用于环境默认值**和**运行时覆盖；它们是固定的安全护栏，并不代表可用磁盘空间。运维者仍需准备足够的磁盘并监控用量。跨字段约束可能使某个单项上限无法达到（房间限额必须严格小于用户限额，敏感限流必须严格小于通用限流）。

| 运行时键 | 环境默认值来源 | 硬上限 |
| --- | --- | --- |
| `maxFileBytes` | `MAX_FILE_BYTES` | 1 GiB（1073741824 字节） |
| `maxTextBytes` | `MAX_TEXT_BYTES` | 1 MiB（1048576 字节） |
| `maxItems` | `MAX_ITEMS` | 100000 |
| `userQuotaBytes` | `USER_QUOTA_BYTES` | 100 GiB（107374182400 字节） |
| `retentionMs` | `RETENTION_HOURS` × 3600000 | 365 天（31536000000 ms） |
| `roomQuotaBytes` | `ROOM_QUOTA_BYTES` | 100 GiB（107374182400 字节） |
| `roomMaxFileBytes` | `ROOM_MAX_FILE_BYTES` | 1 GiB（1073741824 字节） |
| `roomRetentionMs` | `ROOM_RETENTION_HOURS` × 3600000 | 24 小时（86400000 ms） |
| `rateWindowMs` | `RATE_WINDOW_MS` | 1 小时（3600000 ms） |
| `rateGeneral`、`rateAuth`、`rateInvite`、`rateUpload`、`rateRoom` | 对应的 `RATE_*` 变量 | 各 1000000 |
| `sessionMs` | `SESSION_HOURS` × 3600000 | 365 天（31536000000 ms） |
| `uploadChunkBytes` | `UPLOAD_CHUNK_BYTES` | 24 MiB（25165824 字节）；最小 64 KiB |
| `uploadChunkTimeoutMs` | `UPLOAD_CHUNK_TIMEOUT_MS` | 1 小时（3600000 ms） |
| `uploadChunksPerSession` | `UPLOAD_CHUNKS_PER_SESSION` | 16 |
| `uploadChunksPerUser` | `UPLOAD_CHUNKS_PER_USER` | 64 |
| `uploadChunksGlobal` | `UPLOAD_CHUNKS_GLOBAL` | 256 |
| `uploadSessionsPerUser` | `UPLOAD_SESSIONS_PER_USER` | 1000 |
| `uploadSessionsGlobal` | `UPLOAD_SESSIONS_GLOBAL` | 10000 |
| `rateChunk` | `RATE_CHUNK` | 1000000 |

如果环境默认值或合并后的持久化配置违反策略，启动会失败。特别是修改环境默认值可能与已有的关联覆盖冲突：此时先恢复之前有效的环境变量，通过 API 重置或更新这些覆盖，然后再修改环境变量。覆盖永远不会被静默丢弃或截断。

修改无需重启，对新请求立即生效。调小文件大小、条目数或配额不会删除已有内容；已有的单用户配额仍优先于安装默认值。进行中的上传保留开始时的文件大小上限，但提交时必须通过当前的配额/数量检查。保留时长的修改只影响**新的**条目/房间：已有的 `expiresAt` 和清理计划不变。已有房间的过期时间仍约束新加入该房间的条目。会话有效期的修改只影响新的 OAuth 会话，不影响当前会话或 PAT。修改限流阈值会保留当前计数；修改窗口时长会保留正在生效的重置时间，新的时长作用于新建的限流桶。

只在启动时读取的设置包括 `TRUST_PROXY`、`DATA_DIR`、`ADMIN_EMAIL` / `ADMIN_PASSWORD`、`ADMIN_EMAILS`、OAuth 凭据、`RATE_TOKEN`、端口、清理间隔，以及可修改列表之外的所有其他设置。任何外部管理的 `SESSION_SECRET` 同样不在此 API 范围内；后端使用随机生成、存储在服务器上的不透明会话，没有可修改的会话签名密钥。

## 上传会话与清理

迁移 v8 新增 `uploads` 和 `upload_chunks` 表。使用同一个 DATA_DIR 卷时，会话和已接收的分片序号在重启后仍然保留；磁盘上的分片使用不透明的存储键，被引用期间不会被孤儿文件清理删除。现有的单请求上传接口不需要前端做任何修改。客户端可以选择改用[会话协议](../../api/reference/#可续传文件上传)。

创建会话时原子地预留声明的字节数和一个条目名额。预留与普通条目计入同一个用户/房间配额。缩略图在完成时按实际字节数计入，因此恰好占满配额的文件仍可能在完成时失败。`/me` 在 usedBytes 之外单独返回 `reservedBytes`。取消、禁用账号和房间过期都会释放预留并把分片加入删除队列。会话在创建 24 小时后绝对过期（若房间更早过期则以房间为准）；活动不会延长截止时间。维护任务每 CLEANUP_INTERVAL_MS 运行一次，删除过期会话并重试排队中的文件删除。写分片时进程崩溃可能留下无引用的文件，由现有的一小时孤儿文件清理回收。临时拼装最多可能还需要一份文件大小的磁盘空间；预留只是逻辑上的配额记账，不是文件系统容量预留。

八项新的上传/限流设置都在现有的管理后台限额编辑器中提供，持久化、重置和审计行为相同。新的分片大小只对新会话生效。超时和并发的修改对新的 PUT 生效；已有请求保留其截止时间，调低上限不会中止进行中的工作。其他当前的文件/配额/条目限额在完成时重新检查。实际并发受所有适用上限共同约束，这些上限彼此独立。

HTTP 服务器原有的 120 秒整请求超时已移除。每个分片请求体都有自己配置的截止时间。反向代理可能有自己的空闲/请求体超时；保持 nginx 的请求体上限大于分片大小（当前的 30m 可以容纳 24 MiB 的硬上限）。不要把分片大小调到整文件上限。分片 PUT 有独立的限流桶（包括单独的 PAT 桶），因此普通的 RATE_GENERAL/RATE_UPLOAD/RATE_ROOM/RATE_TOKEN 阈值不会限制分片数量。控制类请求仍使用普通限额。并发计数和运行时限额状态都在进程本地；请保持文档所述的单进程模型。
