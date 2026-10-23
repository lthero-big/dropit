# dropit

跨设备实时传递文本和文件的云剪贴板。前端按 Swiss 极简方案实现（登录、邀请、空间剪贴板、临时房间、管理后台），文本只作纯文本渲染，WebSocket 断线后按指数退避重连并用 snapshot 补拉。

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

`ADMIN_EMAILS` 为空时，首个成功登录者是管理员；配置后，仅匹配 provider 已验证邮箱的人可首次建号成为管理员。其他新用户必须通过有效邀请完成 OAuth 后才建号并加入空间。不同 provider 的身份不按邮箱自动合并。会话为服务器保存的随机令牌，数据库仅存 SHA-256；不需要占位 `SESSION_SECRET`。

## Docker

单镜像托管前端静态文件和 API，数据必须持久化到 `/data`。本地 HTTP 冒烟：

```bash
docker build -t dropit .
docker run --rm -p 127.0.0.1:8787:8787 \
  -e NODE_ENV=development \
  -e APP_ORIGIN=http://localhost:8787 \
  -v dropit-data:/data dropit
```

或直接 `docker compose up --build`（未复制 `.env` 时默认 localhost:8787；已有 `.env` 时将 `APP_ORIGIN` 改为实际浏览器 origin）。生产需在 HTTPS 反代后设置 `NODE_ENV=production` 和 `APP_ORIGIN=https://实际域名`；会话 cookie 为 HttpOnly + Secure + SameSite=Lax。默认 Compose 仅绑定本机。

反代时将 `TRUST_PROXY` 设为可信代理的 CIDR/IP 列表，例如 `127.0.0.1/32`；默认忽略 `X-Forwarded-For`。不要用任意代理全信任配置。所有写请求及 WebSocket 都检查精确 Origin；脚本调用也须发送 Origin。

## 存储与维护

`ClipboardService` 依赖 `Repository`、`FileStorage`、`Broadcaster` 接口，具体实现分别是 `repository.ts`、`files.ts`、`events.ts`；组合根为 `backend.ts` / `index.ts`。SQLite 驱动和 SQL 只存在于 repository，迁移使用 `user_version` 并在事务内执行。

原始文件只允许带鉴权的 attachment 下载；安全的图片缩略图由 sharp 重编码为 WebP，SVG/HTML 不内联。上传流按实际字节限额，并在事务里核对配额。定时清理会删除过期记录和文件；删除失败保留队列待重试，进程中断遗留文件在一小时后回收。备份应使用 SQLite backup API，或停服后复制整个数据目录。

本期为单进程/单实例：限流与广播驻内存，不提供断点续传或多实例一致性。前端负责将文本作为纯文本渲染，以及按 API 文档重连并用服务端 snapshot 替换本地列表。真实 OAuth 联调需要用户提供凭据，自动化用例均使用 mock。

## CI

GitHub Actions 执行 lint、类型检查、测试、构建，并单独构建 Docker 镜像。
