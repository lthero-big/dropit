# @dropit/web

Frontend workspace package. Setup, environment variables, and Docker are documented in the repository README.

## 本地开发代理

`pnpm --filter @dropit/web dev` 默认将 `/api`（含 WebSocket）、`/healthz` 和 `/d/` 代理到 `http://127.0.0.1:8787`。修改目标时，在启动 Vite 的进程环境中设置 `DROPIT_DEV_BACKEND_ORIGIN` 为后端的 HTTP(S) origin。后端的 `APP_ORIGIN` 应与浏览器访问的 Vite origin 一致，以便通过写请求的 Origin 校验。

```sh
DROPIT_DEV_BACKEND_ORIGIN=http://127.0.0.1:18878 pnpm --filter @dropit/web dev
```

## 浏览器 smoke

在仓库根目录用 Node.js 22+ 和仓库指定的 pnpm 版本运行以下命令。

```sh
pnpm install --frozen-lockfile
pnpm --filter @dropit/server build
pnpm --filter @dropit/web exec playwright install chromium --only-shell
pnpm --filter @dropit/web smoke
```

Playwright 启动真实 TS 服务（`127.0.0.1:18787`）与 Vite（`127.0.0.1:15173`）。TS 服务在临时目录创建 SQLite 和文件存储，使用 `ADMIN_EMAIL` / `ADMIN_PASSWORD` 初始化 `web-smoke@example.test`、随机密码和私人空间。测试进程仅向 TS 服务传入本地配置，服务入口跳过仓库的 `.env`。测试结束后 Playwright 停止两个进程，TS 进程退出时删除临时目录。以上两个端口需空闲。

测试检查代理默认与自定义配置，并通过自定义代理访问真实 TS 的健康检查和无效短链接。Chromium 在页面上用密码登录，确认私人空间，发送并显示唯一中文文本，刷新并验证 WebSocket 的新快照带回同一条文本，最后退出并确认 `GET /api/me` 返回 401。

## 使用同一 smoke 对接 Rust

先用 RHEA-227 的 TS fixture 流程生成独立数据库和密码账号，再以该副本启动 Rust。以下示例假定 Rust 监听 `127.0.0.1:18878`，运行时设置 `APP_ORIGIN=http://127.0.0.1:15173`，并用 fixture 的邮箱和密码替换示例值。

```sh
DROPIT_DEV_BACKEND_ORIGIN=http://127.0.0.1:18878 \
DROPIT_SMOKE_EMAIL=web-smoke@example.test \
DROPIT_SMOKE_PASSWORD='fixture-password' \
pnpm --filter @dropit/web smoke
```

指定目标后，smoke 只启动 Vite，所有请求都发往所选后端。测试会跳过 TS 基线专用的短链接断言。运行结束后，停止手动启动的 Rust 进程并删除这份 fixture 副本。

RHEA-230 已补齐 `GET /api/site`、`GET /api/auth/providers`、`GET /api/setup`（只读状态）、`GET /api/version` 以及私人空间 WebSocket。Rust 实测覆盖现有密码账号登录、发送文本、刷新快照、退出、两个独立浏览器的实时同步和断网重连。新增 `smoke/realtime.spec.mjs` 对 TS 与 Rust 使用相同入口，原 TS 基线仍可复跑。

可由脚本自动创建 TS schema-19 fixture、启动唯一 Rust 后端、运行完整 smoke 并清理服务与数据（端口 `18878` 和 `15173` 需空闲）：

```sh
pnpm --filter @dropit/server build
(cd rust/server && cargo build --locked)
node rust/server/tests/browser.mjs
```

OAuth、首次创建账号、看板编辑/分组管理、文件上传、房间、分享及设置/管理等仍待后续迁移。读取登录方式会忠实显示数据库/环境中已配置的 OAuth provider；本切片尚未实现其登录流程，浏览器验收仅覆盖既有密码账号。
