<div align="center">

<img src="apps/web/public/favicon.svg" width="72" height="72" alt="dropit" />

# dropit

**跨设备实时传递文本和文件的自托管云剪贴板**

网页、命令行与临时房间共用一套实时 API：在一台设备上粘贴，其他设备立即看到。

[![Docker Image Size](https://img.shields.io/docker/image-size/lthero1/dropit/latest?logo=docker&label=image)](https://hub.docker.com/r/lthero1/dropit)
[![Docker Pulls](https://img.shields.io/docker/pulls/lthero1/dropit?logo=docker)](https://hub.docker.com/r/lthero1/dropit)
![Node.js](https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white)
![pnpm](https://img.shields.io/badge/pnpm-11-F69220?logo=pnpm&logoColor=white)
[![License: AGPL-3.0-only](https://img.shields.io/badge/license-AGPL--3.0--only-blue)](LICENSE)

[功能](#功能) · [快速开始](#快速开始) · [部署](#生产部署) · [配置](#配置) · [命令行](#命令行) · [API](docs/api.md) · [开发](#开发) · [许可证](#许可证)

</div>

---

## 功能

**剪贴板**

- 文本与文件条目，WebSocket 实时同步到同一空间的所有设备；断线后指数退避重连，并用服务端 snapshot 补齐。
- 私人空间（每个账号自动创建）与通过邀请加入的共享空间。
- 文本可就地编辑（创建时间不变）；Markdown 可切换「渲染」视图，只渲染安全子集，不解析原始 HTML。
- 标签（每条最多 8 个）、置顶、分组（每个空间最多 24 个），以及 Ctrl/⌘ K 命令面板搜索。
- 条目记录来源设备（如 `Mac · Chrome`），方便分辨内容来自哪台设备。

**文件**

- 图片显示经 sharp 重编码的 WebP 缩略图和预览；视频、音频按文件头识别后才内联播放，支持拖动。
- 下载支持单段 `Range` 断点续传；大文件走分片上传，可中断后续传。
- SVG / HTML 不内联，上传时声明的 MIME 不被信任。

**分享与临时房间**

- 只读分享链接：有效期 1 小时 / 1 天 / 7 天 / 不过期，可限制查看次数，随时撤销；公开页面 `/s/<token>` 无需登录。
- 临时房间：无需账号，持有房间链接即可读写，最长 24 小时；房间页可显示二维码供另一台设备扫码加入。

**账号与管理**

- GitHub / Google OAuth 登录（state + PKCE），无密码；邀请制注册，第一位登录者自动成为管理员。
- 管理后台：用户（预创建、禁用、角色、单独配额、强制下线）、邀请、个人访问令牌，以及运行时限额（即时生效，带审计记录）。
- 个人访问令牌（read / write 范围）与设备码登录（`/device`），供命令行和脚本使用。

**命令行**

- `dropit` CLI：设备码登录、发送文本、上传、列出、下载（`--jobs` 并行 Range）、删除、分享、`watch` 实时监听（可 `--exec` 触发脚本）、临时房间。

**运维**

- 单个 Node 进程 + SQLite（WAL）+ 本地磁盘，单镜像同时托管前端和 API。
- 限流、配额、保留期、定时清理与删除重试队列；`/healthz` 健康检查。

## 快速开始

### Docker（推荐）

镜像已发布在 Docker Hub：[`lthero1/dropit`](https://hub.docker.com/r/lthero1/dropit)。

```bash
docker run -d --name dropit \
  -p 127.0.0.1:8787:8787 \
  -e NODE_ENV=development \
  -e APP_ORIGIN=http://localhost:8787 \
  -v dropit-data:/data \
  lthero1/dropit:latest
```

打开 <http://localhost:8787>。真实登录需要配置至少一个 OAuth provider，见 [OAuth 与首位管理员](#oauth-与首位管理员)；未登录时也可以直接创建临时房间。

也可以从源码构建：

```bash
docker compose up --build        # 默认发布在 127.0.0.1:8787
```

### 从源码运行

需要 Node.js 22+ 与 pnpm 11。

```bash
pnpm install
cp .env.example .env
pnpm dev
```

浏览器访问 <http://localhost:5173>。Vite 把 `/api`（含 WebSocket）和 `/healthz` 代理到后端 8787；`.env.example` 中 `APP_ORIGIN` 已对应 5173。开发模式自动读取仓库根目录的 `.env`，生产模式只读进程环境变量。

## 生产部署

生产环境要求 HTTPS：设 `NODE_ENV=production`（启用 Secure Cookie 与 HSTS），`APP_ORIGIN` 设为浏览器地址栏中的精确 origin，由反向代理终止 TLS。

```yaml
# compose.yml 示例
services:
  dropit:
    image: lthero1/dropit:latest
    restart: unless-stopped
    ports:
      - "127.0.0.1:8787:8787"      # 只绑定回环，由反代对外
    env_file: .env                 # OAuth 凭据等，不要提交到仓库
    environment:
      NODE_ENV: production
      APP_ORIGIN: https://dropit.example.com
      TRUST_PROXY: loopback        # 反代的 IP/CIDR；容器经 Docker 网关访问时填网关地址
    volumes:
      - dropit-data:/data
volumes:
  dropit-data:
```

nginx 反向代理要点（WebSocket 升级、请求体不小于上传分片、长连接超时）：

```nginx
map $http_upgrade $connection_upgrade { default upgrade; '' close; }

server {
    listen 443 ssl;
    server_name dropit.example.com;
    client_max_body_size 30m;          # 需大于 UPLOAD_CHUNK_BYTES（默认 8 MiB，上限 24 MiB）

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_request_buffering off;
        proxy_read_timeout 3600s;
    }
}
```

注意事项：

- 不要把 8787 直接发布到 `0.0.0.0`；所有写请求和 WebSocket 都校验精确 `Origin`。
- `TRUST_PROXY` 只填真实反代地址；留空时忽略 `X-Forwarded-For`。
- 数据（SQLite + 文件）都在 `/data`，务必挂载持久卷。备份请用 SQLite backup API，或停服后复制整个数据目录。
- 本项目为单进程、单实例设计：限流、广播、在线人数驻留内存，不要多实例共享同一数据目录。
- 纯 HTTP 内网使用时只能 `NODE_ENV=development`，且 `APP_ORIGIN` 必须与访问地址一致（如 `http://192.168.1.10:8787`）。

## 配置

所有配置通过环境变量提供，启动时校验；不合法的组合会直接拒绝启动。常用项：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `NODE_ENV` | `development` | `production` 启用 Secure Cookie 与 HSTS，并要求 HTTPS |
| `APP_ORIGIN` | `http://localhost:$PORT` | 浏览器访问的精确 origin（无路径），OAuth 回调基于它 |
| `PORT` / `HOST` | `8787` / `0.0.0.0` | 监听端口与地址 |
| `DATA_DIR` | 仓库 `data/`（镜像为 `/data`） | SQLite 与文件存储目录 |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | 未设置 | 两者都设置才开放 GitHub 登录 |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | 未设置 | 两者都设置才开放 Google 登录 |
| `ADMIN_EMAILS` | 空 | 可选，逗号分隔；这些已验证邮箱注册时也成为管理员 |
| `TRUST_PROXY` | 空 | 受信任反代的 IP/CIDR（可用 `loopback`） |
| `MAX_FILE_BYTES` | 26214400（25 MiB） | 单文件上限 |
| `USER_QUOTA_BYTES` | 1073741824（1 GiB） | 每用户默认配额 |
| `RETENTION_HOURS` | 168 | 空间条目保留时长 |
| `ROOM_RETENTION_HOURS` | 24 | 临时房间保留时长（≤ 24） |

完整列表（房间限额、限流、分片上传并发等 30 余项）及运行时覆盖规则见 [docs/backend-config.md](docs/backend-config.md)。管理员可以在后台修改大部分限额，即时生效并写入审计；优先级为 **SQLite 运行时覆盖 > 环境变量默认值**。

## OAuth 与首位管理员

注册 GitHub OAuth App（`read:user user:email`）和/或 Google Web OAuth client（`openid email profile`），回调地址：

- `${APP_ORIGIN}/api/auth/github/callback`
- `${APP_ORIGIN}/api/auth/google/callback`

用户表为空时，第一个成功登录的身份成为管理员（在 SQLite `BEGIN IMMEDIATE` 事务中完成，并发首登只会产生一个管理员），无需预先配置 `ADMIN_EMAILS`。之后的新用户需持有效邀请，或由管理员按邮箱预创建（首次已验证 OAuth 登录时绑定）。不同 provider 的身份不会按邮箱自动合并。会话为服务端保存的随机令牌，数据库只存 SHA-256。

## 命令行

`apps/cli` 提供命令 `dropit`（包名 `@dropit/cli`，未发布到 npm registry，请从仓库安装）。

```bash
pnpm --filter @dropit/cli build
npm install -g ./apps/cli

dropit login --url https://dropit.example.com   # 设备码登录，在浏览器批准
dropit send "一行文本"
dropit push ./photo.png ./large.bin             # ≥ 256 KiB 自动分片、可续传
dropit ls
dropit get latest -o ./downloads --jobs 4
dropit share latest --expires 1d --max-views 1
dropit watch --exec -- ./on-item.sh
dropit room new
```

脚本/CI 可用 `DROPIT_URL` + `DROPIT_TOKEN`（个人访问令牌）代替交互登录。完整用法见 [apps/cli/README.md](apps/cli/README.md)。

## API

同源 HTTP API 位于 `/api`，浏览器使用会话 Cookie，命令行和脚本使用 `Authorization: Bearer <PAT>`；实时事件通过 `.../ws` WebSocket 推送。端点、错误码、上传会话协议、分享链接和重连语义见 [docs/api.md](docs/api.md)。

## 架构

```
apps/
  server/   Hono + @hono/node-server 2.x，better-sqlite3（WAL），sharp，OAuth
  web/      React 19 + React Router + Vite + Tailwind CSS 4
  cli/      dropit 命令行客户端（TypeScript）
docs/       API 契约、后端配置
scripts/    浏览器 / Docker 验收脚本
```

- `ClipboardService` 依赖 `Repository`、`FileStorage`、`Broadcaster` 接口，实现分别在 `repository.ts`、`files.ts`、`events.ts`；组合根为 `backend.ts` / `index.ts`。
- SQL 只存在于 repository；迁移使用 `user_version`，在事务内执行。
- 上传按实际字节计数并在事务里核对配额；定时清理删除过期记录与文件，删除失败留在队列重试，中断遗留文件一小时后回收。

## 安全

- 无密码登录；OAuth 使用 state + PKCE，测试用 mock 登录不会在生产开放。
- 会话、邀请、房间、分享、个人访问令牌均为随机值，数据库只存哈希。
- Cookie 及匿名写请求校验精确 `Origin`；Bearer 请求不接受 Cookie 叠加权限；URL 中的令牌不被接受（分享/房间链接除外，它们本身就是能力凭据）。
- 文本仅作纯文本或安全 Markdown 子集渲染；媒体按文件头白名单内联，原始文件以 attachment + `nosniff` 下载。
- 分享链接与房间链接是能力凭据：拿到 URL 的人即可访问，请谨慎传播。

## 开发

```bash
pnpm lint        # oxlint
pnpm typecheck
pnpm test        # 后端使用 mock OAuth，含真实 HTTP / WebSocket / SQLite / 磁盘用例
pnpm build
```

生产构建后可用 `pnpm --filter @dropit/server start` 托管 `apps/web/dist`。GitHub Actions 在每次 push / PR 上执行 lint、类型检查、测试、构建，并单独构建 Docker 镜像。

## 文档

- [API 与 WebSocket 契约](docs/api.md)
- [后端环境变量与运行时限额](docs/backend-config.md)
- [命令行用法](apps/cli/README.md)
- [Wiki](https://github.com/lthero-big/dropit/wiki)（源文件在 [docs/wiki/](docs/wiki/Home.md)）

## 许可证

本项目以 [GNU AGPL-3.0-only](LICENSE) 发布。

- 可以免费使用、修改、分发，**也可以商用**。
- 分发本项目或修改版时，必须同样以 AGPL-3.0 开放完整源代码。
- 修改后**作为网络服务对外提供**（例如部署给他人访问），也必须向这些用户提供修改后的完整源代码。
- 本软件按「原样」提供，不附带任何担保。具体条款以 [LICENSE](LICENSE) 原文为准。
