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

按首轮契约，Rust 的浏览器缺项包括站点元数据 `GET /api/site`、登录初始化 `GET /api/auth/providers`、空库设置 `/api/setup`，以及私人空间的 `/api/spaces/:space/ws` 和刷新所需的 `snapshot`。smoke 会报告缺失的站点元数据或登录初始化接口。登录可用后，缺失的 WS 快照会使刷新断言失败。OAuth、看板分组、文件上传和短链接下载等也在首轮契约之外。完整浏览器流程的实测基线为 TS。
