# dropit

跨设备实时传递文本和文件的云剪贴板。本仓库目前是可运行的工程脚手架：pnpm monorepo、前端壳、Hono 服务、单 Docker 镜像和 CI。账号、邀请、空间和产品界面尚未实现。

## 结构

- `apps/web`：Vite + React + TypeScript + Tailwind CSS v4 + shadcn/ui 初始化。只有主题壳，没有业务页面。
- `apps/server`：Node + Hono。静态文件、`/healthz`、存储 / SQLite / 广播接口。
- WebSocket 使用 `@hono/node-server` 内置的 `upgradeWebSocket`（依赖 `ws`）。`@hono/node-ws` 已由上游标记为废弃，所以这里不引入它。

## 本地开发

需要 Node.js 22+ 和 pnpm 11。

```bash
pnpm install
cp .env.example .env
pnpm dev
```

- 前端：<http://localhost:5173>（把 `/healthz`、`/api`、`/ws` 代理到后端）
- 后端：<http://localhost:8787>
- 开发模式下如果没有 `.env`，服务仍会启动，并使用仅用于开发的会话占位密钥。
- 生产模式缺少 `SESSION_SECRET`，或仍是 `change-me` 时，进程会拒绝启动。

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## Docker

镜像内由后端托管前端构建产物。健康检查请求 `/healthz`。

```bash
docker build -t dropit .
docker run --rm -p 8787:8787 \
  -e SESSION_SECRET="$(openssl rand -hex 32)" \
  -e APP_URL=http://localhost:8787 \
  -v dropit-data:/data \
  dropit
```

或：

```bash
SESSION_SECRET="$(openssl rand -hex 32)" docker compose up --build
```

打开 <http://localhost:8787>。数据在卷 `/data`（SQLite 文件和对象目录）。

OAuth 应用可以先注册，回调地址约定为：

- GitHub：`${APP_URL}/auth/github/callback`，scope `read:user user:email`
- Google：`${APP_URL}/auth/google/callback`，scope `openid email profile`

这些路由还没有实现。Client ID 和 Secret 只从环境变量读取，不要写进仓库。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `NODE_ENV` | `development` | `production` 时强制检查 `SESSION_SECRET`，并且不读取 `.env` 文件 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `PORT` | `8787` | 监听端口 |
| `APP_URL` | `http://localhost:$PORT` | 对外 origin，不要以 `/` 结尾 |
| `SESSION_SECRET` | 开发占位值 | 生产环境必填，且不能是 `change-me` |
| `GITHUB_CLIENT_ID` | 空 | GitHub OAuth |
| `GITHUB_CLIENT_SECRET` | 空 | GitHub OAuth |
| `GOOGLE_CLIENT_ID` | 空 | Google OAuth |
| `GOOGLE_CLIENT_SECRET` | 空 | Google OAuth |
| `ADMIN_EMAILS` | 空 | 逗号分隔。除首位用户外，这些邮箱也是管理员 |
| `DATA_DIR` | 仓库下 `data/` | SQLite 和对象文件的目录。镜像里是 `/data` |
| `DATABASE_PATH` | `$DATA_DIR/dropit.sqlite` | 可单独指定数据库文件 |
| `STATIC_DIR` | 空 | 前端构建目录。镜像里是 `/app/public`。为空时不托管静态文件 |
| `MAX_UPLOAD_BYTES` | `104857600` | 单文件上限（100 MiB） |
| `USER_QUOTA_BYTES` | `1073741824` | 单用户总配额（1 GiB） |
| `RETENTION_HOURS` | `168` | 登录空间文件保留时间 |
| `GUEST_RETENTION_HOURS` | `24` | 临时房间保留时间 |
| `TRUST_PROXY` | `0` | 设为 `1` 或 `true` 才信任 `X-Forwarded-For` |

完整模板见 `.env.example`。

## 接口骨架

业务代码通过构造函数注入，不直接引用磁盘、SQLite 驱动或内存实现。

- `ObjectStorage`：`apps/server/src/storage/types.ts`。`DiskObjectStorage` 把对象写成安全 id，不用用户文件名。`MemoryObjectStorage` 供测试使用。
- `Database`：`apps/server/src/db/types.ts`。`SqliteDatabase` 打开文件并设置 WAL。
- `Broadcaster`：`apps/server/src/broadcast/types.ts`。`MemoryBroadcaster` 是单进程实现。
- 组合根是 `apps/server/src/index.ts`。路由使用 `createApp` 得到的依赖。

`/ws` 目前只订阅内部主题 `scaffold`，用来证明广播端口已经接上。它没有鉴权，也没有业务消息。后端实现时应替换这条路由。

## CI

`.github/workflows/ci.yml` 在 push 和 pull request 上运行 lint、类型检查、测试、构建，并单独构建 Docker 镜像。
