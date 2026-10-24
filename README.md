# dropit

跨设备实时传递文本和文件的云剪贴板。前端按 Swiss 极简方案实现（登录、邀请、空间剪贴板、临时房间、管理后台），文本只作纯文本渲染，WebSocket 断线后按指数退避重连并用 snapshot 补拉。登录失败会回到登录页，只显示固定的中文原因。文本可以就地修改，修改同步到同一空间，创建时间不变。

- 后端：Hono、SQLite WAL、本地磁盘、GitHub/Google OAuth（state + PKCE）、邀请制、服务器会话、私人/共享空间、临时房间、限流与配额、缩略图、定时清理。
- WebSocket 使用 `@hono/node-server` 2.x 内置接口（替代已废弃的 `@hono/node-ws`），仅允许经过授权的空间/房间订阅。
- [API 与 WebSocket 契约](docs/api.md)供前端对接，[完整环境变量表](docs/backend-config.md)包含所有默认值、限额及生产配置。

## 本地开发

需要 Node.js 22+、pnpm 11。

```bash
pnpm install
cp .env.example .env
pnpm dev
```

浏览器访问 <http://localhost:5173>；Vite 将 `/api`（包括 WebSocket）及 `/healthz` 代理到后端 8787。`.env.example` 的 `APP_ORIGIN` 对应浏览器的 5173 origin。若直接访问后端，应设置 `APP_ORIGIN=http://localhost:8787`。开发环境自动读取仓库 `.env`，生产环境只读进程环境。

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

后端测试用 mock OAuth，无须真实凭据；包含真实 WebSocket、HTTP、SQLite、磁盘与安全用例。生产构建后可用 `pnpm --filter @dropit/server start` 托管 `apps/web/dist`，`/healthz` 可检查服务存活。

## OAuth 与首位管理员

注册 GitHub OAuth App（`read:user user:email`）和 Google Web OAuth client（`openid email profile`），回调地址分别为：

- `${APP_ORIGIN}/api/auth/github/callback`
- `${APP_ORIGIN}/api/auth/google/callback`

只通过环境变量提供 `GITHUB_CLIENT_ID`、`GITHUB_CLIENT_SECRET`、`GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`。未配置的 provider 不开放登录。无密码入口，测试用 mock 不会作为生产登录接口开放。

`ADMIN_EMAILS` 为空时，首个成功登录者是管理员；配置后，仅匹配 provider 已验证邮箱的人可首次建号成为管理员。其他新用户须通过有效邀请完成 OAuth，或由管理员按邮箱预创建（待首次已验证 OAuth 登录时绑定，不另建账号）。普通邮箱不会按邮箱自动合并不同 provider；预创建只绑定第一个匹配该邮箱的身份。列在 `ADMIN_EMAILS` 里的邮箱例外：GitHub 和 Google 只要给出同一个已验证邮箱，就绑定到同一个管理员账号，后登录的 provider 不会再另建用户。每次成功登录都会按当前环境把该邮箱设回管理员（环境优先于后台里的降权）。停用后不能靠换一个 provider 绕过。

`.env.example` 和 Compose 把 `ADMIN_EMAILS` 默认写成 `ltherowlh@gmail.com`。这只是示例默认值。进程环境里的值始终优先：改成别的邮箱就用别的邮箱；显式留空则仍是「第一个成功登录的人成为管理员」。服务器代码不把这个地址写死。

会话为服务器保存的随机令牌，数据库仅存 SHA-256；不需要占位 `SESSION_SECRET`。

## Docker（本机）

单镜像托管前端静态文件和 API，数据必须持久化到 `/data`。只绑定回环地址：

```bash
docker build -t dropit .
docker run --rm -p 127.0.0.1:8787:8787 \
  -e NODE_ENV=development \
  -e APP_ORIGIN=http://localhost:8787 \
  -v dropit-data:/data dropit
```

或直接 `docker compose up --build`（未复制 `.env` 时默认 localhost:8787；已有 `.env` 时将 `APP_ORIGIN` 改为实际浏览器 origin）。默认 Compose 发布地址是 `127.0.0.1:8787`。

## 私有部署

仓库保持 private。不要改成 public，不要把 8787 发布到 `0.0.0.0`，也不要做路由器端口转发或公网 DNS。

在私有主机上（示例地址 `192.168.1.152`，换成这台机器的内网地址）只绑定该地址：

```bash
docker build -t dropit .
docker run --rm -p 192.168.1.152:8787:8787 \
  -e NODE_ENV=development \
  -e APP_ORIGIN=http://192.168.1.152:8787 \
  -e ADMIN_EMAILS=ltherowlh@gmail.com \
  -e GITHUB_CLIENT_ID \
  -e GITHUB_CLIENT_SECRET \
  -e GOOGLE_CLIENT_ID \
  -e GOOGLE_CLIENT_SECRET \
  -v dropit-data:/data dropit
```

同一局域网的浏览器打开 `http://192.168.1.152:8787`。`APP_ORIGIN` 必须与浏览器地址栏的 origin 完全一致，OAuth 回调也要登记成这个 origin。纯 HTTP 只能用 `NODE_ENV=development`（生产模式要求 HTTPS）。若私有网前面有反代，反代终止 TLS 后设 `NODE_ENV=production`、`APP_ORIGIN=https://私有域名`，并把 `TRUST_PROXY` 设成该反代的 CIDR/IP，例如 `192.168.1.152/32`。默认忽略 `X-Forwarded-For`。不要用任意代理全信任配置。所有写请求及 WebSocket 都检查精确 Origin。

没有下列环境变量时，真实登录起不来（测试仍用 mock，不需要这些值）：

- `GITHUB_CLIENT_ID`、`GITHUB_CLIENT_SECRET`（两个都有才开放 GitHub）
- `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`（两个都有才开放 Google）
- `APP_ORIGIN`（浏览器实际 origin）
- `ADMIN_EMAILS`（示例默认是 `ltherowlh@gmail.com`，可用环境变量覆盖；留空时第一个成功登录的人成为管理员）

## 存储与维护

`ClipboardService` 依赖 `Repository`、`FileStorage`、`Broadcaster` 接口，具体实现分别是 `repository.ts`、`files.ts`、`events.ts`；组合根为 `backend.ts` / `index.ts`。SQLite 驱动和 SQL 只存在于 repository，迁移使用 `user_version` 并在事务内执行。

原始文件只允许带鉴权的 attachment 下载；安全的图片缩略图由 sharp 重编码为 WebP，SVG/HTML 不内联。上传流按实际字节限额，并在事务里核对配额。定时清理会删除过期记录和文件；删除失败保留队列待重试，进程中断遗留文件在一小时后回收。备份应使用 SQLite backup API，或停服后复制整个数据目录。

本期为单进程/单实例：限流与广播驻内存，不提供断点续传或多实例一致性。前端负责将文本作为纯文本渲染，以及按 API 文档重连并用服务端 snapshot 替换本地列表。真实 OAuth 联调需要用户提供凭据，自动化用例均使用 mock。

## CI

GitHub Actions 执行 lint、类型检查、测试、构建，并单独构建 Docker 镜像。
