---
title: API 契约
description: HTTP API 与 WebSocket 的权威契约。
---

:::note
本页译自仓库 [docs/api.md](https://github.com/lthero-big/dropit/blob/main/docs/api.md)（英文原文，被测试引用）。两者不一致时以英文原文为准。
:::

同源 HTTP API，挂在 `/api` 下；除下载、缩略图、图片/媒体预览、OAuth 重定向和空的 `204` 响应外，所有响应都是 JSON。时间均为 Unix 毫秒；大小均为字节。浏览器使用服务器会话 Cookie（`credentials: 'same-origin'`）；CLI 客户端在 `Authorization: Bearer <token>` 中使用个人访问令牌（PAT）。没有 CORS 允许源，也没有公开的模拟登录。密码按账号可选（scrypt，见“密码登录与首次运行”）。

使用 Cookie 的请求和匿名的 POST/PUT/PATCH/DELETE 请求必须带 `Origin: <APP_ORIGIN>`（房间和登出同样如此）。有效的 Bearer 令牌可跳过 Origin 检查，包括 WebSocket 升级。只要带了 Authorization 头就按 Bearer 认证：格式错误、过期或已撤销的凭据即使同时带有有效 Cookie 也返回 401。Cookie 永远不会给 Bearer 请求增加权限。不接受放在 URL 里的令牌。唯一免认证的机器接口是下文的两个设备接口。JSON 请求必须带 `Content-Type: application/json`。对已知的需认证空间授权失败，与访问不存在的空间一样，都返回 `404 NOT_FOUND`。会话缺失/过期/被撤销返回 `401 UNAUTHENTICATED`。

## 认证与邀请

| 方法 | 路径 | 响应 / 请求 |
| --- | --- | --- |
| GET | `/auth/providers` | `{providers: ['github','google'], password: true, registration: 'invite', setupRequired: false}`；只列出已配置的 OAuth 提供方 |
| GET | `/auth/:provider?invite=:token` | 让浏览器跳转到这里；302 到 OAuth 提供方，并设置绑定本次流程的 Cookie。可选的邀请仍有效时会绑定到本次流程。一旦存在任何用户，无效邀请会重定向到 `{APP_ORIGIN}/login?error=INVITE_INVALID`，不启动流程。用户表为空时，无效邀请被忽略，流程照常启动，保证第一个人仍能注册。未知的提供方名称仍返回 JSON `404`。发起认证的限流仍返回 JSON `429` 并带 `Retry-After`。 |
| GET | `/auth/:provider/callback` | 仅用于 OAuth 回调；需要 state、浏览器 Cookie 和 PKCE；设置会话并重定向到 `{APP_ORIGIN}/`。浏览器可见的失败会重定向到 `{APP_ORIGIN}/login?error=CODE`，CODE 为 `OAUTH_STATE_INVALID`、`OAUTH_DENIED`、`OAUTH_PROVIDER_ERROR`、`INVITE_INVALID`、`INVITATION_REQUIRED`、`REGISTRATION_CLOSED`、`USER_DISABLED`、`VERIFIED_EMAIL_REQUIRED`、`RATE_LIMITED`、`INTERNAL_ERROR` 之一。提供方的错误文本不会被拷贝进 URL。 |
| POST | `/auth/logout` | 204；立即撤销本会话、关闭其 socket 并清除 Cookie |
| GET | `/me` | `{user, hasPassword, mustChangePassword, usedBytes, reservedBytes, quotaBytes, maxFileBytes, maxTextBytes, retentionMs}` |
| GET | `/invites/:token` | `{personal, spaceName \| null, inviterName?, expiresAt, remainingUses}`；`personal: true` 表示用户创建的邀请，只开放注册（不加入任何空间）。无效/已撤销/已用完/已过期：404 |

`User = {id, email, name, role: 'admin'|'user', disabled: 0|1, pending: 0|1, createdAt}`。
在绑定第一个已验证的 OAuth 身份或第一次密码登录之前，`pending` 为 1。邀请页面**不会**创建账号，也不消耗使用次数，只是把令牌带到 OAuth 发起地址。只有成功验证的 OAuth 身份才能原子地消耗一次使用次数、创建账号和私有空间并加入被邀请的空间。已是成员的人再次使用同一个仍有效的邀请不会额外消耗次数。已有用户无需邀请即可登录。已用完/已过期的令牌永远不会被接受，即使该用户以前通过它加入过。OAuth state 只能使用一次，有效期 10 分钟。发起新流程会替换浏览器之前的流程 Cookie。

## 密码登录与首次运行（RHEA-190 认证第 2 步）

| 方法 | 路径 | 响应 / 请求 |
| --- | --- | --- |
| GET | `/setup` | `{required, providers}`；只有在尚无任何账号时 `required` 才为 true |
| POST | `/setup` | `{code, email, password, name?}` → 201 `{user, mustChangePassword:false}` 并设置会话 Cookie。创建第一个**管理员**。`code` 是服务启动时日志里打印的一次性 `dropit setup code: XXXX-XXXX`（忽略大小写、短横线和空格）。码错误 `403 SETUP_CODE_INVALID`；已完成初始化 `409 SETUP_DONE`；每个窗口按 IP（`RATE_AUTH`）和全局（`5 × RATE_AUTH`）限流 |
| POST | `/auth/password/login` | `{email, password, invite?}` → `{user, mustChangePassword}` 并设置会话 Cookie。邮箱不存在和密码错误都返回 `401 INVALID_CREDENTIALS`（总会计算哈希）。只有密码正确时才会返回 `USER_DISABLED`。按 IP 和按邮箱限流（`RATE_AUTH`）。有效的 `invite` 会加入对应空间；预先创建的（pending）账号会变为激活状态 |
| POST | `/auth/password/register` | `{email, password, name?, invite?}` → 201 `{user}` 并建立会话。受注册策略约束：`closed` → `403 REGISTRATION_CLOSED`；`invite`（默认）需要有效邀请（`403 INVITATION_REQUIRED` / `INVITE_INVALID`）；`open` 允许任何人。注册的总是普通用户（不会是管理员；因邮箱未经验证，`ADMIN_EMAILS` 不适用）。邮箱已被任何账号使用 `409 EMAIL_IN_USE`。完成 `/setup` 之前 `409 SETUP_REQUIRED` |
| PUT | `/me/password` | 仅限浏览器会话。`{currentPassword?, newPassword}` → `{hasPassword:true, mustChangePassword:false, revokedSessions}`。账号已有密码时必须提供 `currentPassword`（`400 CURRENT_PASSWORD_INVALID`、`PASSWORD_UNCHANGED`）；仅 OAuth 的账号可以不提供而直接添加密码。该账号的其他会话会被撤销 |
| POST | `/admin/users/:id/password` | 管理员浏览器会话。→ `{temporaryPassword, mustChangePassword:true}`。只显示一次。撤销该用户的所有会话；下次登录必须修改密码 |
| GET / PUT | `/admin/registration` | `{policy:'closed'|'invite'|'open', default:'invite', userInvites:{enabled, defaultLimit}, updatedAt, updatedBy}`；PUT `{policy?, userInvites?: {enabled?: boolean, defaultLimit?: 0–1000}}`（至少一项）。`userInvites` 控制普通用户能否创建个人邀请（默认开启，每人 5 个）。 |

`GET /auth/providers` 还会返回 `password: true`、`registration`（注册策略）和 `setupRequired`。`GET /me` 增加 `hasPassword` 和 `mustChangePassword`；`GET /admin/users` 为每个用户增加 `hasPassword`、`mustChangePassword` 和 `providers`。`POST /admin/users` 接受 `temporaryPassword: true`，此时会一次性返回生成的 `temporaryPassword`。

密码为 8–256 个字符，经 NFKC 规范化，以 `scrypt$N$r$p$salt$hash` 形式存储（N=16384、r=8、p=1、16 字节随机盐、64 字节密钥），并用 `timingSafeEqual` 比较。在 `mustChangePassword` 为真期间，**浏览器**会话访问除 `/me`、`/me/password`、`/auth/logout`、`/auth/providers`、`/site`、`/version` 和 `/setup` 之外的接口都会得到 `403 PASSWORD_CHANGE_REQUIRED`；个人访问令牌不受影响（如果密码泄露，请在 设置 → 访问令牌 中撤销它们）。密码账号可以在 设置 → 登录方式 中绑定 GitHub / Google；设置了密码后，最后一个 OAuth 身份也可以解绑。

离线恢复：`docker exec dropit dropit-admin reset-password <email>` 设置一个临时密码（只打印一次），强制修改并让该账号登出；`dropit-admin list-users` 列出所有账号。

## 个人访问令牌

PAT 包含 256 位随机数，编码为 43 个 base64url 字符。只存储 SHA-256 摘要。原始令牌只在创建/领取的响应中出现一次；列表、重命名和撤销的响应都不会包含原始令牌或其摘要。响应带 `Cache-Control: no-store`。切勿记录凭据或把凭据放进 URL。

| 方法 | 路径 | 请求体 / 响应 |
| --- | --- | --- |
| POST | `/tokens` | **仅限浏览器会话 + Origin。** `{name, scopes?: ['read','write'], expiresInDays?: 90}` → 201，`Token & {token}`。名称：非空，最多 80 个字符。范围：`read`、`write` 的非空、不重复子集。有效期：1–3650 天的整数，或 `null` 表示永不过期。 |
| GET | `/tokens` | 自己的 `{tokens: Token[]}`；浏览器会话或带 `read` 的 Bearer。包括已撤销/已过期令牌的元数据。 |
| PATCH | `/tokens/:id` | **仅限浏览器会话 + Origin。** `{name}` → 204；仅限所有者。 |
| DELETE | `/tokens/:id` | 204；仅限所有者；浏览器 + Origin，或带 `write` 的 Bearer。 |
| GET | `/admin/tokens?userId=` | 仅限管理员；`{tokens: Token[]}`，可按用户筛选。 |
| DELETE | `/admin/tokens/:id` | 仅限管理员；204；撤销任意用户的令牌。 |

`Token = {id,userId,name,scopes:('read'|'write')[],createdAt,lastUsedAt:number|null,
expiresAt:number|null,revoked:0|1}`。认证 HTTP 请求或 WS 升级时会记录最近使用时间。GET/HEAD/OPTIONS（包括 WS）需要 `read`；修改类请求需要 `write`（`403 INSUFFICIENT_SCOPE`）。两个范围相互独立；默认同时授予两者。PAT 不能创建 PAT、不能重命名令牌，也不能批准/拒绝设备（`403 BROWSER_SESSION_REQUIRED`），即使同时带有浏览器 Cookie 也不行。所有现有的成员关系、条目归属、配额、IP/账号限额和管理员角色检查同样适用于 PAT。此外每个令牌还有一个单独的 `RATE_TOKEN` 限流桶。撤销/禁用会立即拒绝后续请求，并以 1008 关闭已建立的 socket。禁用账号会永久撤销该用户现有的 PAT；重新启用账号也不会恢复它们。令牌过期在请求时和 socket 重新校验时（每秒一次以及每次广播前）检查。Cookie 登出/会话撤销不会撤销 PAT。Bearer 方式调用 `POST /auth/logout` 会撤销当前 PAT 而不影响浏览器 Cookie；该调用需要 `write`（只读的 CLI 可以丢弃本地令牌，再到浏览器里撤销它）。

## 设备授权（CLI 登录）

使用 JSON。设备端应用不需要客户端密钥。这里不会创建新用户；批准的人必须已有一个有效的、基于 OAuth 的会话。

| 方法 | 路径 | 请求体 / 响应 |
| --- | --- | --- |
| POST | `/auth/device/authorize` | `{name, scopes?, expiresInDays?}`（校验规则和默认值与创建 PAT 相同）→ 200，`{device_code,user_code,verification_uri,verification_uri_complete,verification_id,expires_in:600,interval:5}`。 |
| POST | `/auth/device/token` | `{device_code}` → 批准后 200，`{access_token,token_type:'Bearer',scope:'read write',expires_in:number|null,token:Token}`。`scope` 反映实际申请的范围；有效期从领取时开始计算。 |
| GET | `/auth/device?user_code=ABCD-EFGH&verification_id=...` | **仅限浏览器会话。** 返回待处理请求的 `{name,ipSummary,scopes,expiresAt,tokenExpiresInDays:number|null}`。不暴露设备密钥或完整 IP。 |
| POST | `/auth/device/approve` | **仅限浏览器会话 + Origin。** `{user_code,verification_id?}` → 204；为当前用户批准。 |
| POST | `/auth/device/deny` | **仅限浏览器会话 + Origin。** 请求体相同 → 204；永久拒绝。 |

只有 authorize 和 token 两个接口在**没有会话 Cookie 时**可以不带 Origin。如果带了 Origin，除非使用 PAT 认证，否则必须与 APP_ORIGIN 一致。只带 Cookie 的请求仍遵循通常的 Origin 规则。这两个接口都不设置 Cookie。应用/校验/限流错误使用下文的普通错误结构。

`verification_uri` 为 `{APP_ORIGIN}/device`。完整 URI 只携带短的用户码和公开的 `verification_id`；绝不能携带 `device_code`。`/device` 的浏览器确认界面（也嵌在 `/settings` 中）会在请用户允许之前显示申请的设备名、IP 摘要、范围和有效期。登录过程中要保留这两个查询参数。设备码为 256 位随机数，只由 CLI 持有。用户码为 8 个随机的大写字母/数字，不含 I/L/O/0/1，显示时带一个短横线。输入不区分大小写，可包含空格/短横线。两种码都只以 SHA-256 摘要存储。请求 10 分钟后过期。仅批准不会创建 PAT：成功领取时才原子地创建 PAT 并消耗设备码。丢失的领取响应无法重放；请重新发起设备登录，并在设置中撤销那个未用到的令牌。

轮询协议错误为 HTTP 400，`error` 为**字符串**，例如 `{"error":"authorization_pending"}`。**首次轮询之前以及每两次轮询之间**至少等待 `interval` 秒。轮询过早返回 `{"error":"slow_down","interval":10}`，且每次过早轮询都会让本流程的间隔增加 5 秒。之后每次轮询都使用返回的间隔。待处理返回 `authorization_pending`；被拒绝返回 `access_denied`；过期、未知和已消耗的码返回 `expired_token`。成功、被拒绝或过期时停止轮询。HTTP 429 使用 `Retry-After`。

创建按 IP 受 RATE_AUTH 限制，轮询按 IP 受 RATE_GENERAL 限制，浏览器确认/决定每个账号和 IP 每个窗口限 5 次。完整链接中公开的 verification_id 把输错尝试绑定到一个流程：输错 5 次后该流程永久失效（CLI 收到 `access_denied`）。手动输入码时可以不带 verification_id；未知的码统一返回 404，由于无法确定流程，只受账号/IP 限额约束。已过期、已决定、已锁定和未知的确认请求统一返回 404。

当用户表为空时，第一个认证成功的身份成为管理员。无论 `ADMIN_EMAILS` 是否设置、该地址是否在列表中都是如此。缺失、过期或未知的邀请不会阻止这次注册。空表检查和插入在同一个 `BEGIN IMMEDIATE` 事务中执行，因此两个并发的首次登录只会产生一个管理员，另一个登录得到 `INVITATION_REQUIRED`。`ADMIN_EMAILS` 是可选且叠加的：之后新出现的、提供方验证过的邮箱与之匹配的身份也会创建为管理员。其他所有新身份都需要邀请。各提供方身份保持独立；不会按邮箱静默关联 GitHub 和 Google 账号。不存储提供方的 access/refresh 令牌。

## 管理

这里的所有路径都需要已启用的管理员，否则返回 401/403。

| 方法 | 路径 | 请求体 / 响应 |
| --- | --- | --- |
| GET | `/admin/users` | `{users: [User & {usedBytes, quotaBytes, quotaOverride}]}`。`quotaBytes` 是实际生效的配额。`quotaOverride` 是存储的覆盖值，使用安装默认值时为 `null`。 |
| POST | `/admin/users` | `{email, name?: string, role?: 'admin' or 'user', quotaBytes?: number}` → 201，`User & {usedBytes, quotaBytes, quotaOverride}`。预先创建一个 pending 账号及其私有空间。没有密码，也没有邀请令牌。之后第一个**已验证**邮箱（不区分大小写）匹配的 OAuth 登录会绑定该身份、清除 `pending`，不会再创建第二个用户或空间。同一邮箱但不同提供方主体不会被关联，仍需要邀请或管理员引导。邮箱不能已属于任何用户（`409 EMAIL_IN_USE`）。匹配 `ADMIN_EMAILS` 的存为 `admin`。省略 `quotaBytes` 时使用安装默认值（`quotaOverride: null`）；设置时取 1 字节到 100 GiB。 |
| PATCH | `/admin/users/:id` | `{disabled?: boolean, role?: 'admin'\|'user', name?: string, quotaBytes?: number\|null, inviteLimit?: number\|null}` 至少一项 → 204。`quotaBytes: null` 清除覆盖。`inviteLimit`（整数 0–1000）是该用户的个人邀请上限；`null` 回退到站点默认值。禁用会立即撤销其所有会话/socket。重新启用后需要重新登录。角色和配额在现有会话的下一个请求生效。最后一个已启用的管理员不能被禁用或降级（`409 LAST_ADMIN`）。邮箱不能修改。 |
| POST | `/admin/users/:id/logout` | 204。删除该用户的所有会话并关闭其 socket。账号保持启用，可以重新登录。未知 id：`404`。 |
| GET | `/admin/limits` | 为下文 23 项运行时限额各返回 `{key: {value, default, overridden, min, max}}`。`default` 是进程启动时由环境变量得出的值；`overridden` 表示存在 SQLite 覆盖（即使与默认值相同）。 |
| PATCH | `/admin/limits` | 部分更新 `{key: positiveInteger \| null}` → 200，返回与 GET 相同的描述映射。`null` 移除该覆盖。需要管理员，并且是带浏览器 Origin 的会话或带 `write` 范围的 Bearer。整个候选配置一起校验，所有覆盖/审计记录原子提交。空对象、未知/只读键、类型错误、超出范围或违反跨字段策略 → `400 INVALID_LIMITS`；不会部分写入。 |
| GET | `/admin/limits/audit?limit=50&cursor=123` | `{entries: LimitAudit[], nextCursor: number \| null}`；最新的在前。`limit`：整数 1–100（默认 50）；可选 `cursor`：正整数，即上一页 `nextCursor` 给出的审计 id（不含该条）。分页参数无效 → `400 INVALID_INPUT`。只读的管理员 Bearer 可以读取限额和审计。 |
| GET | `/site` | 公开。`{origin: string \| null, source: 'admin' \| 'env' \| 'request', requestOrigin}`：已固定的站点地址（APP_ORIGIN，若有）以及本次请求自身的源；登录页用它解释不一致的情况。 |
| GET | `/admin/site` | 管理员浏览器会话。站点地址视图：`origin`、`source`、`adminOrigin`、`envOrigin`、`requestOrigin`、`effectiveOrigin`、`production`、`secureCookies`、`trustProxy`、`updatedAt`、`updatedBy`、`callbacks: [{provider, label, url}]`。 |
| PUT | `/admin/site` | `{origin: string \| null, confirm?: boolean}`；`null`/`""` 清除管理员设置的值（回退到环境变量 `APP_ORIGIN`，再回退到请求的源）。需要管理员浏览器会话 + Origin。不是纯 origin → `400 INVALID_ORIGIN`；与调用者的 Origin 不同且未带 `confirm: true` → `409 ORIGIN_CONFIRM_REQUIRED {origin, current}`。立即生效。`ORIGIN_REJECTED` 错误在 `code` 旁边带有 `{expected, received, source}`。 |
| GET | `/admin/invites` | `{invites: [Invite]}`（不含密钥令牌）；所有邀请（包括个人邀请），带 `status`（`open`/`used`/`expired`/`revoked`）、`createdByEmail`、`joinSpace` |
| POST | `/admin/invites` | `{spaceId, maxUses?: 1, expiresInHours?: 24}` → 201，`Invite & {token,url}`。使用次数：1–100；有效期：1–720 小时。管理员必须属于目标空间。 |
| DELETE | `/admin/invites/:id` | 204；立即撤销 |

`Invite = {id, spaceId, maxUses, uses, expiresAt, revoked: 0|1, createdBy, joinSpace: 0|1, createdAt}`。
`joinSpace: 0` 是**个人邀请**：只能使用一次，只开放注册（新账号获得自己的私有空间，不加入邀请人的空间）。只有在创建了新账号时才会被消耗，已使用的邀请不能再撤销（`409 INVITE_USED`）。`registration: 'closed'` 同样会阻止个人邀请。

### 个人邀请（任何已登录用户）

| 方法 | 路径 | 响应 / 请求 |
| --- | --- | --- |
| GET | `/me/invites` | `{enabled, limit, used, remaining, registration, invites: [{id, status, expiresAt, createdAt, ...}]}`；只含自己的邀请。`limit` = 单用户覆盖值或站点默认值（管理员不受限制） |
| POST | `/me/invites` | `{expiresInHours?: 168}`（1–720）→ 201 `{id, token, url, expiresAt}`。令牌只显示一次。管理员关闭该功能时 `403 INVITES_DISABLED`；达到上限时 `409 INVITE_LIMIT_REACHED`。浏览器会话 + Origin，或带 `write` 的 Bearer |
| DELETE | `/me/invites/:id` | 204；撤销一个未使用的邀请（释放一个名额）。只能操作自己的邀请，否则 `404`；已使用时 `409 INVITE_USED` |

邀请在已被使用，或既未撤销也未过期时，计入上限。邀请令牌只在创建时返回；请安全地分享返回的 URL。只存储其 SHA-256 摘要。已过期/已撤销的邀请记录可能被维护任务删除。没有任意加入成员的接口。

### 运行时限额策略

可修改的键为 `maxFileBytes`、`maxTextBytes`、`maxItems`、`userQuotaBytes`、`retentionMs`、`roomQuotaBytes`、`roomMaxFileBytes`、`roomRetentionMs`、`rateWindowMs`、`rateGeneral`、`rateAuth`、`rateInvite`、`rateUpload`、`rateRoom`、`sessionMs`、`uploadChunkBytes`、`uploadChunkTimeoutMs`、`rateChunk`、`uploadChunksPerSession`、`uploadChunksPerUser`、`uploadChunksGlobal`、`uploadSessionsPerUser` 和 `uploadSessionsGlobal`。所有时长使用毫秒，大小使用字节。硬上限见[后端配置](../../config/backend-config/#运行时覆盖与硬上限)。`min`/`max` 描述每个键的绝对范围；完整的生效配置还必须满足：

- `roomMaxFileBytes < maxFileBytes`，`roomQuotaBytes < userQuotaBytes`。
- `roomRetentionMs <= retentionMs` 且 `roomRetentionMs <= 86400000`（24 小时）。
- `rateAuth`、`rateInvite`、`rateUpload` 均 `< rateGeneral`；`rateRoom < rateUpload`。

关联的修改可以放在一次 PATCH 里发送，例如 `{"maxFileBytes":10485760,"roomMaxFileBytes":2097152}`。重置同样会对照其他生效值校验；必要时把关联的键一起重置。`{"maxFileBytes":null,"roomMaxFileBytes":null}` 恢复它们的环境默认值。密钥、源、代理配置、路径、OAuth 凭据、`rateToken` 以及其他所有启动设置都不能通过此 API 修改或读取。

`LimitAudit = {id, actorId, actorEmail, createdAt, key, oldValue, newValue,
oldOverride: number|null, newOverride: number|null}`。`actorEmail` 在修改时记录；id 单调递增，`createdAt` 为 Unix 毫秒。每个被修改的覆盖产生一行，包括重置以及显式设为与默认值相同的值。重复设置相同的覆盖或重置未设置的键不做任何事，也不产生记录。失败的修改不产生记录。翻页期间有新的修改到来时，审计分页保持稳定。

修改成功后立即作用于后续请求，包括 `/me`、空间/房间元数据、校验、配额和限流。已在进行的上传保留开始时的文件大小上限；配额/条目数检查仍使用提交时的生效配置。调低配额/数量/文件大小不会删除已有内容，也不阻止下载。显式的单用户配额仍优先于 `userQuotaBytes`。

保留时长在创建时确定：`retentionMs` 影响新条目，`roomRetentionMs` 影响新房间。已有条目/房间的 `expiresAt` 时间戳保持不变，编辑、置顶和分享也不会改变它。房间里的条目同样受所在房间已有过期时间约束。不会追溯延长或删除任何内容。`sessionMs` 只影响新签发的 OAuth 会话/Cookie，从不影响已有会话、PAT、设备流程或分享链接。

限流阈值立即作用于现有的实时计数。修改窗口时长时，每个活动中的限流桶保留其计数和原来的重置时间；新建的桶使用新的时长。PATCH 不会清空计数，即使是无操作或重置。限流计数按进程统计，进程重启后清零。

## 空间、临时房间与条目

`GET /spaces` → `{spaces: [{id,name,ownerId,expiresAt:null}]}`。包括用户自动创建的私有空间和通过邀请加入的空间。

`POST /rooms`（无需账号；请求体可选 `{deviceKey?, code?, pin?}`）→ 201，`{token, expiresAt, url, reused, code, hasPin}`。**一个房间只有一个房间码，它的链接就是 `/r/<房间码>`**（房间码*就是*链接；改房间码就会改链接）。房间码要么是随机的——从去掉易混字符（没有 `0 O 1 l I`）的字母表中取 **6 个字符**，区分大小写——要么是自定义的 `code`（`A–Z a–z 0–9 _ -`，3–32 个字符，区分大小写）。可选的 `pin`（4–32 个字符，以 scrypt 哈希存储）对随机码和自定义码都适用。房间码已被占用返回 `409 CODE_TAKEN`；取值无效返回 `400 INVALID_CODE` / `INVALID_PIN`。没有房间列表、搜索或枚举接口。已登录用户访问房间时仍使用**房间**配额，而不是用户配额。

房间码**不是** API 凭据。`token` 是*访问令牌*（`<id>.<proof>`）：请保存好，下文的房间路由接受的就是它。其他人通过 `POST /rooms/enter` 把房间码换成自己的访问令牌，该接口会检查 PIN（若已设置）并受限流约束——因此打开 `/r/<房间码>` 和输入房间码都需要 PIN。房间所有者以及之前已进入的人保留各自的访问令牌，所以所有者设置或修改 PIN 或房间码时，他们**不会被再次要求输入 PIN**。

| 方法 | 路径 | 请求体 / 响应 |
| --- | --- | --- |
| POST | `/rooms/enter` | `{code, pin?}` → `{token, expiresAt, code, hasPin, url}`。未知/已过期的房间码 `404 NOT_FOUND`，`401 PIN_REQUIRED`，`403 PIN_INVALID`，输错太多次后 `429 RATE_LIMITED` 并带 `Retry-After` |
| GET | `/rooms/:room` | 用访问令牌获取 `{id, name, expiresAt, code, hasPin, url}` |
| PUT | `/rooms/:room/code` | 仅限房间所有者（设备密钥），`{deviceKey, code?, pin?}`（至少一项）→ `{code, hasPin, url}`。`code: "<自定义>"` 设置自定义房间码，`code: null` 或 `""` 重新随机生成；`pin: "<pin>"` 设置/替换 PIN，`pin: null` 或 `""` 移除 PIN；省略的字段保持不变。非所有者 `403`，`409 CODE_TAKEN` |

输错的房间码和 PIN 按客户端 IP 和按房间码，以 `RATE_AUTH` 为预算计数。

**按房间的 PIN 锁定：** 在此之上，每个设置了 PIN 的房间会累计统计来自任意 IP 的错误 PIN。在 `PIN_LOCK_MINUTES`（默认 15）内输错 `PIN_LOCK_FAILURES`（默认 10）次后，房间对每一次 PIN 尝试（即使正确）都返回 `429 RATE_LIMITED` 并带 `Retry-After`，直到锁定结束；之后计数重新开始。输入正确的 PIN 会重置计数，所有者修改房间码或 PIN（`PUT /rooms/:room/code`）也会重置。已经持有访问令牌的人不受影响。计数保存在内存中，重启后清零。
**旧的长链接已移除：** 旧的房间链接（`/rooms/<43 个字符的令牌>`，以及上一步的 6 字符链接）已彻底移除，没有重定向，也没有兼容代码。`/rooms/<token>` 返回 `404`（网页显示“房间不存在”），`/api/rooms/<旧令牌>` 返回 `404 NOT_FOUND`。Schema 16 会迁移已有数据库：先把数据库文件复制为（同目录下的）`<file>.pre-v<旧版本>-<时间>.bak`，删除旧的链接数据（`roomHash` 列），为每个没有房间码的有效房间、以及每个使用上一步 5 字符随机码的房间生成新的 6 字符随机码，并保留自定义房间码和 PIN。分享链接 `/s/<token>` 不变（6 个字符，旧的长分享链接仍然有效）。

在下表中，把 `base` 替换为 `/spaces/:spaceId` 或 `/rooms/:room`，其中 `:room` 是从 `POST /rooms` / `POST /rooms/enter` 获得的访问令牌。这里不接受房间码。空间路由需要成员身份；房间路由需要未过期的能力凭据。

| 方法 | 路径 | 请求体 / 响应 |
| --- | --- | --- |
| GET | `base` | `{id,name,expiresAt,maxFileBytes,quotaBytes}` |
| GET | `base/items` | `{type:'snapshot', items:Item[], groups:string[], serverTime,expiresAt}`；当前未过期的条目，最新的在前 |
| POST | `base/items/text` | `{text:string, group?:string\|null}` → 201 `{item:Item}`；非空 UTF-8，最多 `MAX_TEXT_BYTES`。未知的 `group` 名称会被即时创建（见分组）。 |
| PATCH | `base/items/:id` | `{text:string}` → 200 `{item:Item}`。仅限文本。空白与大小规则同创建。`createdAt` 和 `expiresAt` 不变；`updatedAt` 变为编辑时间。配额按 `newSize - oldSize` 计算，缩小总是允许。空间：仅限作者（其他任何人包括空间所有者都是 `403`）。房间：任何当前能力凭据持有者。文件返回 `400 INVALID_INPUT`。未知 id 或属于其他空间返回 `404`。 |
| PATCH | `base/items/:id/labels` | `{pinned?: boolean, tags?: string[], group?: string\|null}` → 200 `{item:Item}`。至少一项。`group: null`（或 `''`）把条目移出分组。发送 `tags` 时替换整个标签列表；省略则保持不变。不改变 `createdAt`、`updatedAt`、文本或配额。空间：条目作者或空间所有者。房间：任何当前能力凭据持有者。标签在去掉首尾空白和开头的 `#` 后为 1–24 个字符，不含空白或逗号，最多 8 个不重复标签。 |
| POST | `base/items/file` | **原始二进制请求体**，原始类型放在 `Content-Type`，文件名放在 `X-File-Name: encodeURIComponent(name)`，可选 `X-Dropit-Group: encodeURIComponent(group)` → 201 `{item:Item}` |
| GET | `base/items/:id/download` | 原始字节，`application/octet-stream`，`Content-Disposition: attachment`，`nosniff`。`Accept-Ranges: bytes`；支持单段 `Range` 续传（206/416）。 |
| GET | `base/items/:id/thumbnail` | 经过净化、重新编码的 `image/webp`，最大 320×320；没有缩略图则 404 |
| GET | `base/items/:id/preview` | 经过净化的 `image/webp`，最长边 2048px，保持宽高比，不放大；仅限之前已通过校验的位图上传。`Content-Disposition: inline`，`nosniff`，`Cache-Control: private, max-age=N`（最多 60 秒，且不超过条目过期时间）。非成员/未知条目/非图片返回 404。 |
| GET | `base/items/:id/media` | 通过魔数白名单校验后内联返回视频或音频。`Content-Type` 是嗅探出的类型，从不使用上传时的请求头。`Accept-Ranges: bytes`；单段 `Range` 返回 `206` 或 `416`。SVG、HTML、图片和未知字节返回 `404`。`Content-Disposition: inline`，`nosniff`。 |
| DELETE | `base/items/:id` | 204；撤回条目及其存储的文件/缩略图。在空间中仅限发送者或空间所有者；在房间中所有能力凭据持有者都可以撤回。 |
| POST | `base/items/:id/shares` | `{expiresIn:'1h'\|'1d'\|'7d'\|'never', maxViews?: number\|null}` → 201 `{id,itemId,expiresAt,maxViews,views,revoked,createdAt,token,url}`。`maxViews` 为 null 或省略表示不限次数；否则 1–100（`1` 为一次性）。权限与撤回相同：条目作者或空间所有者；房间中任何当前能力凭据持有者。 |
| GET | `base/items/:id/shares` | `{shares:[Share]}`。不含令牌。权限与创建相同。 |
| DELETE | `base/shares/:shareId` | 204；立即撤销。权限与创建相同。 |
| GET | `base/groups` | `{groups:string[]}`，按创建顺序 |
| POST | `base/groups` | `{name}` → 201 `{groups}`。`409 GROUP_EXISTS`、`409 GROUP_LIMIT`（最多 24 个）、`400 INVALID_GROUP` |
| PATCH | `base/groups/:name` | `{name}` → 200 `{groups}`；分组内的条目随之移动。`404 GROUP_NOT_FOUND` |
| DELETE | `base/groups/:name` | 200 `{groups}`；其中的条目变为未分组（不会删除任何内容） |

### 分组与设备标识（RHEA-190 第 5 步）

分组是每个空间/房间内的具名桶（去掉首尾空白后 1–24 个字符，不含控制字符，不能是 `全部` 或 `未分组`；最多 24 个）。每次变更都会以 `groups` WebSocket 消息广播。权限与读写条目相同。

任何创建条目的请求（`items/text`、`items/file`、`uploads/:id/complete`）都可以携带发送设备的信息，让其他设备显示内容来自哪里：

| 请求头 | 取值 |
| --- | --- |
| `X-Dropit-Device` | 稳定的客户端 id，`[A-Za-z0-9_-]{6,64}` |
| `X-Dropit-Device-Name` | `encodeURIComponent(name)`，最多 40 个字符（例如 `Mac · Chrome`） |
| `X-Dropit-Device-Kind` | `mac` \| `phone` \| `pad` \| `pc` \| `cli`（其他值回退为 `pc`） |
| `X-Dropit-Group` | 二进制上传使用的 `encodeURIComponent(group)`（文本使用请求体字段） |

以上都是可选的；格式错误的值会被忽略而不是拒绝，因此旧客户端的行为与之前完全一样（`item.device` 和 `item.group` 为 `null`）。

`Share = {id,itemId,expiresAt:number|null,maxViews:number|null,views,revoked:0|1,createdAt}`。
原始令牌只在创建时返回（`url` 为 `{APP_ORIGIN}/s/{token}`）。只存储其 SHA-256。未知、过期、已撤销、次数用尽和格式错误的令牌都返回 `404 NOT_FOUND`。没有令牌的列表、搜索或枚举接口。

## 可续传文件上传

使用与条目相同的 `base`：`/api` 下的 `/spaces/:spaceId` 或 `/rooms/:roomToken`。Cookie/Origin 和 Bearer 范围规则与现有的文件接口一致（PUT 需要 `write`，GET 需要 `read`）。空间中的上传会话属于创建它的用户，即使在共享空间里也是如此；其他成员或空间所有者都不能读取、写入、完成或取消它。当前房间能力凭据的每个持有者都可以续传/取消房间中的上传。无效、过期、已完成、已取消、属于其他用户或 base 不对的上传 id 都返回同样的 `404 NOT_FOUND`。没有会话列表接口。

| 方法 | 路径 | 请求体 / 响应 |
| --- | --- | --- |
| POST | `base/uploads` | JSON `{filename,size,mime}` → 201 `{uploadId,chunkSize,expiresAt,received:[]}`。size 为正的安全整数；文件名 1–4096 个字符，MIME 1–200 个字符。声明的大小超过当前成员/房间的文件上限时拒绝。 |
| PUT | `base/uploads/:id/chunks/:index` | 原始字节 → 204。从 0 开始的整数序号（无符号、无前导零）。大小必须恰好为 `chunkSize` 字节，最后一个分片则恰好为剩余的声明字节数。顺序任意；在限额内允许并行请求。可选的 `X-Chunk-SHA256` 为 64 个十六进制字符（不区分大小写）。 |
| GET | `base/uploads/:id` | `{size,chunkSize,expiresAt,received:[index,…]}`。只含已提交的序号并排好序；中断/重启后查询它，只发送缺失的分片。 |
| POST | `base/uploads/:id/complete` | 无请求体 → 在所有分片、拼装长度以及媒体/配额校验通过后返回 201 `{item:Item}`。恰好创建一个普通条目并广播 `item.created`。 |
| DELETE | `base/uploads/:id` | 204；中止进行中的工作，释放预留并删除临时分片。之后的请求返回 404。 |

默认分片大小为 **8 MiB**；每个上传在创建时固定其分片大小。最后一个分片可以更小。对已有序号重试相同的字节会成功且不会另存一份。对已有序号发送不同的字节返回 `409 CHUNK_CONFLICT` 并保留第一份。校验和无效（`400 INVALID_CHECKSUM`）、SHA 不匹配（`400 CHECKSUM_MISMATCH`）、分片过短（`400 CHUNK_SIZE_MISMATCH`）、分片过大（`413 FILE_TOO_LARGE`）、数据流中断以及 `400 UPLOAD_TIMEOUT` 都会保留会话供重试；失败的分片永远不会出现在 `received` 中。校验和检查先于重复处理。分片并发超限返回 `429 CHUNK_BUSY` 并带 `Retry-After`。

创建时在一个 SQLite immediate 事务中预留声明的字节数**和一个条目名额**。待上传的字节计入创建者的总配额（或房间配额）；普通的文本/文件创建以及文本变长时也会把这些预留算进去。预留不是条目，永远不会出现在面板快照中。`GET /me` 在已存储的 `usedBytes` 之外单独返回 `reservedBytes`；可用字节为 `quotaBytes - usedBytes - reservedBytes`。会话在创建 24 小时后绝对过期，且不晚于房间过期时间，活动不会延长。过期的预留立即停止计入；维护任务会把它们的文件排队删除。禁用账号和显式取消同样会丢弃未完成的会话，包括正在写入的会话。重启后数据卷上的会话和已接收分片都会保留。

完成时按序号顺序流式读取分片，不会把整个文件缓存在内存里。它使用与普通上传相同的文件名清理、位图解码像素上限（16 Mi 像素）、缩略图生成和原子配额检查。在会话协议中，即使 MIME 声称是 octet-stream，魔数也会触发位图校验。缩略图字节在提交时在声明大小之外另行计入；预留会原子地转换为实际存储。完成时适用当前的配额/条目/文件限额。新的会话协议以 415 拒绝 SVG（包括伪装成 PNG 的 SVG）以及损坏/过大的位图。其他未知字节仍然只能下载；内联音频/视频仍需单独通过魔数白名单。旧接口保留 SVG/HTML 仅下载的兼容行为。

在所有分片到达之前调用 complete 会返回 `400 UPLOAD_INCOMPLETE` 并**丢弃该会话**，拼装大小、解码器、配额和文件限额失败时同样如此：不会留下条目。遇到这些失败后请新建会话。并发的 complete/分片操作返回 `409 UPLOAD_IN_PROGRESS`，但不会丢弃会话；请等这些请求结束后再完成。成功完成会消耗该 id；如果响应丢失，请查询普通条目快照。成功后重试返回 404，避免产生重复条目。

每个 PUT 都有自己的 `uploadChunkTimeoutMs` 截止时间（默认 120 秒）。整个文件没有总截止时间；旧的流式上传也不再有 120 秒的整请求截止时间。PUT 使用独立的 `rateChunk` IP/账号/PAT 限流桶（默认每窗口 2000）；它们**不**占用通用、普通上传、房间访问、房间写入或普通 PAT 请求的限流桶。因此一个 100 分片的上传不会触及 `rateUpload`/`rateToken`。会话的创建/完成仍使用普通写入限额；会话的 GET/DELETE 使用通用（以及房间访问）限额。

运行时限额还约束每个上传/账号/全局的同时分片数（默认 3/6/16），以及每个账号/全局的未完成会话数（8/128）。已登录用户在房间中与其在空间中共用账号限流桶；匿名持有者共用房间限流桶。IP 分片限流以及全局并发/会话上限同样适用。调低上限会保留已有工作，并拒绝新工作，直到低于新阈值。见[配置列表](../../config/backend-config/#运行时覆盖与硬上限)。

## 公开分享链接

不使用会话 Cookie。只有 `GET`。按 IP 和按令牌限流。链接的寿命永远不会超过对应条目：条目保留期到期、房间过期和撤回都会让链接变成 `404`。`expiresIn:'never'` 表示链接本身没有额外的截止时间。

| 方法 | 路径 | 响应 |
| --- | --- | --- |
| GET | `/s/:token` | `{item,linkExpiresAt,views,maxViews,access}`。消耗一次查看次数。`item` 为 `{kind,text,filename,mime,size,hasThumbnail,createdAt,expiresAt,pinned,tags}`，不含任何 id。`access` 在 10 分钟内授权访问文件、缩略图、图片预览和媒体，不再额外消耗查看次数。 |
| GET | `/s/:token/file?access=` | 原始字节，`application/octet-stream`，attachment，`nosniff`；单段 Range（206/416）。有效且未过期的 `access` 不再消耗查看次数。不带 `access` 时，本次请求消耗一次查看次数，并在 `X-Share-Access` 中返回新的票据、在 `Content-Location` 中返回可续传的 URL。本次下载之后的所有分段请求都复用该票据。 |
| GET | `/s/:token/thumbnail?access=` | 经过净化的 `image/webp`，否则 404。查看次数规则与文件路由相同。 |
| GET | `/s/:token/preview?access=` | 与成员/房间预览路由相同的、经过净化的 2048px WebP；inline，nosniff，`Cache-Control: no-store`。查看次数计算与缩略图相同：有效的 `access` 不额外消耗次数；没有有效 access 时消耗一次。已过期/已撤销/次数用尽的链接返回 404（已有的未过期票据仍可读取次数用尽的链接）。 |
| GET | `/s/:token/media?access=` | 与成员媒体路由相同的嗅探内联媒体与 `Range` 行为。查看次数规则与文件路由相同。 |

一次性链接第二次读取元数据时返回 `404`。刷新页面算作再查看一次。使用同一个未过期的 access 票据重复请求分段不会额外消耗次数，包括 416 重试。每个不带票据的新请求都算一次新的查看。票据十分钟后过期，并在链接被撤销/条目被删除/过期时立即失效。仍保持每个分享只有一个票据的策略：新的元数据读取/直接打开会替换其票据。

下载支持 `Range: bytes=START-END`、`bytes=START-` 和 `bytes=-SUFFIX`。可满足的范围返回 206 并带 Content-Range/Content-Length；越界/反向的范围返回 416 并带 `Content-Range: bytes */SIZE`。格式错误/不支持的单位以及多段范围会被忽略（返回完整的 200）。授权检查在范围处理之前进行。HEAD 返回对应的响应头但不含响应体。下载接口在 206/416 上也保留 attachment + nosniff。

`WS base/ws` 是只读的：空间需要带精确 Origin 的会话 Cookie，或带 `read` 的 Bearer 令牌。匿名房间仍需要精确的 Origin；对房间的 Bearer 请求同样会检查范围、过期、禁用和撤销。

```ts
interface Item {
  id: string;
  spaceId: string;
  userId: string | null; // 上传者；房间条目为 null
  kind: 'text' | 'file';
  text: string | null;
  filename: string | null; // 净化后的显示/下载文件名
  mime: string | null; // 不可信的原始 MIME；切勿据此内联任意数据
  size: number; // 原始 UTF-8 文本/文件字节数
  hasThumbnail: boolean;
  createdAt: number;
  updatedAt: number; // 在文本被原地编辑之前等于 createdAt
  expiresAt: number;
  pinned: boolean; // 置顶条目排在未置顶条目之前；各组内按 createdAt 的顺序不变
  tags: string[]; // 0–8 个标签，每个 1–24 个字符，不含空白
  group: string | null; // 分组（与演示版一致），未分组时为 null
  device: {id: string; name: string; kind: 'mac' | 'phone' | 'pad' | 'pc' | 'cli'} | null; // 发送设备（若有上报）
}
```

上传截图/文件的示例（可以用 XHR 获取进度）：

```ts
await fetch(`/api/spaces/${spaceId}/items/file`, {
  method: 'POST', credentials: 'same-origin',
  headers: {'Content-Type': file.type || 'application/octet-stream',
    'X-File-Name': encodeURIComponent(file.name)},
  body: file,
});
```

声称是 JPEG/PNG/WebP/GIF/AVIF 的图片会以 16 Mi 像素为上限解码，并重新编码生成缩略图；格式错误或过大的位图返回 415。`/preview` 以同样的解码像素上限重新校验原图，重新编码为最长边 2048px 的 WebP，保持宽高比并应用 EXIF 方向，不放大小图。缩略图和预览都会去除 EXIF 及其他元数据；GIF 只取第一帧。没有通过校验的位图缩略图的文件返回 `404 NOT_FOUND`；损坏/过大的图片数据返回 `415 INVALID_IMAGE`，不含解码器细节。现有的成员/房间和分享限流同样覆盖预览。每个服务实例在成员、房间和分享路由上最多同时生成两个预览；更多请求返回 `429 PREVIEW_BUSY` 并带 `Retry-After: 1`。
SVG 和 HTML 只接受为**仅下载**，永远不会内联预览，即使客户端发送 `video/*` 或媒体文件名也一样。视频和音频预览只有在存储的字节匹配白名单（MP4、QuickTime、WebM、Ogg、WAV、MP3、FLAC）后才通过 `/media` 提供，响应类型由这些字节决定。剪贴板文本默认是纯文本。Markdown 开关可以把固定的子集（标题、列表、引用、代码、强调、`http`/`https` 链接）渲染为 React 元素。它不解析原始 HTML、图片或其他 URL 协议。不要根据文本或原始文件 MIME 去获取任意 URL。

用户配额统计该用户在所有空间上传的全部原始文本/文件字节**加上缩略图字节**。大图预览按需生成，服务器从不存储或缓存，**不计入用户或房间配额**。撤回、过期或清理时没有需要删除的预览缓存/键；存储中只保留原件和缩略图。`Item` 结构不变。上限为该用户设置的 `quotaOverride`，否则为生效的 `userQuotaBytes` 运行时限额（环境默认值 `USER_QUOTA_BYTES`，也作为 `GET /me` 的 `quotaBytes` 返回）。调低配额不会删除已有条目；之后超出上限的上传和使文本变长的编辑会以 `QUOTA_EXCEEDED` 失败，直到用量降到新上限以下。缩小文本条目总是允许。房间配额统计该房间内的所有条目，不受单用户覆盖影响。限额在流式接收之后原子检查，因此并发上传不会透支配额；失败的上传会被删除。每个空间的条目数上限为 `MAX_ITEMS`（临时房间为 min(100, MAX_ITEMS)）。列表/快照是完整的，受此数量约束；MVP 中没有分页。

## WebSocket 协议与重连

根据页面协议选择 `ws:`/`wss:`：

```ts
const url = new URL(`/api/spaces/${spaceId}/ws`, location.href);
url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
const socket = new WebSocket(url); // 浏览器会自动带上同源 Cookie
```

可选地加上 `?device=<id>&name=<编码后的名称>&kind=<kind>`（规则与 `X-Dropit-Device*` 请求头相同），这样该 socket 会以名称出现在 `presence.peers` 中。

Node CLI 客户端可以使用 `ws` 的 `new WebSocket(url, {headers: {Authorization: 'Bearer ' +
token}})`；有效的 PAT 可以不带 Origin。切勿把 PAT 作为查询参数或 WebSocket 子协议发送。浏览器原生 WebSocket 仍使用 Cookie 和现有的 Origin 要求。

服务器 → 客户端的 JSON 消息：

```ts
type Message =
  | {type: 'snapshot'; items: Item[]; groups?: string[]; serverTime: number; expiresAt: number | null}
  | {type: 'groups'; groups: string[]}
  | {type: 'item.created'; item: Item}
  | {type: 'item.updated'; item: Item}
  | {type: 'item.deleted'; id: string}
  | {type: 'presence'; devices: number; peers?: Array<{id: string; name: string; kind: string}>; others?: number};
```

`presence.devices` 是该空间或房间上打开的 socket 数。它在快照之后发送，并在有 socket 离开时再次发送。其中不含任何地址；`peers` 列出当前连接的不同具名设备（只有至少一个 socket 报告了身份时才出现）。同一浏览器的多个标签页是多个 socket，但只算一个 peer。`others`（仅在存在 `peers` 且不为零时出现）是没有报告设备名的 socket 数，例如 CLI；网页界面把它们显示为一行“其他客户端”，“在线设备”数为不同 peer 数加上这一行，从不使用 `devices`。在**每一次**连接时，用第一条 `snapshot` 替换本地列表，然后按 `item.id` upsert 处理 created 和 updated 事件（置顶条目在其他条目之上，然后按 `createdAt`），按 `id` 移除处理 deleted 事件。`presence` 不改变列表。这样可以补齐离线期间创建、编辑、删除或过期的条目。重连使用带抖动的指数退避（例如 0.5s、1s、2s … 最长 30s），然后使用新的快照。也可以用 `GET base/items` 做权威的 HTTP 刷新。后端不运行浏览器的重连代码。用 serverTime 显示过期时间；条目过期时刷新/隐藏过时条目。遇到 401/403/404、登出或已知房间过期时停止重试；需要用户重新登录/加入。

socket 不接受客户端数据消息（以 1008 关闭）；所有写入都通过 HTTP 进行。会话失效/用户被禁用/房间过期时以代码 1008 关闭 socket。基于时间的授权每秒以及每次广播前检查一次；登出/禁用会显式地立即重新校验。限制：每个 IP 和每个账号 8 个 socket，总计 256 个；消费过慢的客户端以 1013 关闭，服务关闭时为 1001。每 30 秒进行一次 Ping/pong 检查。写入/撤回/过期都会向同一个已授权频道发送事件。

## 错误约定

```json
{"error":{"code":"QUOTA_EXCEEDED"}}
```

OAuth 发起和回调的页面跳转是例外：浏览器可见的失败会重定向到 `/login?error=CODE`，而不是返回此 JSON。未知的提供方名称和发起认证的限流仍使用 JSON。

| HTTP | 错误码 / 前端处理 |
| --- | --- |
| 400 | `INVALID_INPUT`、`INVALID_LIMITS`、`INVALID_JSON`、`JSON_REQUIRED`、`EMPTY_TEXT`、`EMPTY_FILE`、`UPLOAD_TIMEOUT`、`INVALID_FILENAME`、`INVALID_CHUNK_INDEX`、`INVALID_CHECKSUM`、`CHECKSUM_MISMATCH`、`CHUNK_SIZE_MISMATCH`、`UPLOAD_INCOMPLETE`、`OAUTH_STATE_INVALID`、`OAUTH_DENIED`、`OAUTH_PROVIDER_ERROR`、`INVALID_GROUP` |
| 401 | `UNAUTHENTICATED` → 跳转登录 |
| 403 | `FORBIDDEN`、`ORIGIN_REJECTED`、`USER_DISABLED`、`INVITATION_REQUIRED`、`INVITE_INVALID`、`VERIFIED_EMAIL_REQUIRED` |
| 403 | PAT 的 `INSUFFICIENT_SCOPE`、`BROWSER_SESSION_REQUIRED` |
| 404 | `NOT_FOUND`、`PROVIDER_UNAVAILABLE`、`GROUP_NOT_FOUND` |
| 416 | 下载/媒体的范围无法满足；Content-Range 为 `bytes */SIZE` |
| 409 | `LAST_ADMIN`、`EMAIL_IN_USE`、`CHUNK_CONFLICT`、`UPLOAD_IN_PROGRESS`、`GROUP_EXISTS`、`GROUP_LIMIT` |
| 413 | `BODY_TOO_LARGE`、`TEXT_TOO_LARGE`、`FILE_TOO_LARGE`、`QUOTA_EXCEEDED`、`ITEM_LIMIT` → 显示配置的上限 |
| 415 | `INVALID_IMAGE` → 不支持/已损坏/像素过多 |
| 429 | `RATE_LIMITED`、`UPLOAD_BUSY`、`CHUNK_BUSY`、`UPLOAD_SESSION_LIMIT`、`SOCKET_LIMIT`；HTTP 响应带整数秒的 `Retry-After` |
| 500 | `INTERNAL_ERROR` → 重试/报告；不会返回密钥或内部细节 |

限流窗口默认 60 秒；按可信的客户端 IP 和已认证账号分别限制。通用：240；认证：20；邀请：10；上传/写入：30；房间创建/写入：10；房间访问：30。分片 PUT：如上所述，在独立的桶中为 2000。认证还会跨 IP 限制同一个已验证的提供方身份。限额按进程统计（MVP 为单实例）。使用 Cookie/匿名的写入缺少 Origin 时会被拒绝；有效的 PAT 和两个无 Cookie 的设备接口遵循上文的机器规则。PAT 默认每个令牌每个窗口另有 120 次请求限额（`RATE_TOKEN`）。未设置 `TRUST_PROXY` 时忽略转发头。设置后，从实际 socket 开始沿 X-Forwarded-For 逐跳匹配 CIDR；第一个不可信的跳即为客户端 IP。

## 存储与运维

SQLite 使用 WAL 和带版本号的原子迁移。把数据库和文件存放在 `DATA_DIR` 处的持久化本地卷上。备份 SQLite 数据库请使用 SQLite 的备份 API（或停止服务后复制整个数据目录），不要单独复制正在使用的 `.sqlite` 文件。文件存储和广播都是注入的接口；SQL 都在 `SqliteRepository` 中。避免多个服务实例共享这些文件或数据库；分布式存储/广播不在 MVP 范围内。

即使周期性清理尚未运行，服务器也会立即拒绝过期内容。维护任务以事务方式删除数据库条目，并把文件/缩略图键加入删除队列。删除失败的会留在队列中重试。上传中断留下的无引用文件在一小时后回收（进行中的上传除外）。普通写入失败的文件会立即删除。已提交的分片在完成/取消/过期之前一直被引用，并使用同一个删除重试队列。过期条目的字节在清理时从配额中释放。`/healthz` 返回 `{status:'ok'}`。

OAuth 配置：创建一个 GitHub OAuth App（`read:user user:email`）和一个 Google OAuth Web 客户端（`openid email profile`）。注册精确的回调 URL `<APP_ORIGIN>/api/auth/github/callback` 和 `<APP_ORIGIN>/api/auth/google/callback`。客户端 ID/密钥只通过环境变量设置。自动化测试不需要真实凭据。流程参考：
[GitHub OAuth Web 流程](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)、
[Google OAuth Web 服务器流程](https://developers.google.com/identity/protocols/oauth2/web-server)。
