<div align="center">

<img src="apps/web/public/favicon.svg" width="72" height="72" alt="dropit" />

# dropit

**跨设备实时传递文本和文件的自托管云剪贴板**

网页、命令行与临时房间共用一套实时 API：在一台设备上粘贴，其他设备立即看到。

[![Docker Image Size](https://img.shields.io/docker/image-size/lthero1/dropit/latest?logo=docker&label=image)](https://hub.docker.com/r/lthero1/dropit)
[![Docker Pulls](https://img.shields.io/docker/pulls/lthero1/dropit?logo=docker)](https://hub.docker.com/r/lthero1/dropit)
![Node.js](https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white)
[![Docs](https://img.shields.io/badge/docs-lthero--big.github.io%2Fdropit-0a7bbb)](https://lthero-big.github.io/dropit/)
[![License: AGPL-3.0-only](https://img.shields.io/badge/license-AGPL--3.0--only-blue)](LICENSE)

**[📖 文档站](https://lthero-big.github.io/dropit/)** · [快速开始](https://lthero-big.github.io/dropit/start/getting-started/) · [部署](https://lthero-big.github.io/dropit/deploy/deployment/) · [配置](https://lthero-big.github.io/dropit/config/configuration/) · [API](https://lthero-big.github.io/dropit/api/overview/)

</div>

---

## 主要特性

| 领域 | 能力 |
| --- | --- |
| 剪贴板 | 文本 / 文件条目、WebSocket 实时同步、就地编辑、Markdown 安全渲染、标签、置顶、分组、来源设备、Ctrl/⌘ K 命令面板 |
| 文件 | WebP 缩略图与预览、视频/音频内联播放、`Range` 断点下载、分片续传上传 |
| 分享 | 有时限、可限次、可撤销的只读链接；无需账号的临时房间（≤ 24 小时，二维码加入） |
| 账号 | GitHub / Google OAuth（无密码）、邀请制、首位登录者为管理员、个人访问令牌、设备码登录 |
| 管理 | 用户、邀请、令牌、登录设备、运行时限额（即时生效 + 审计）、新版本提示 |
| 命令行 | `dropit` CLI：发送、上传、下载、分享、`watch` 实时监听、临时房间 |
| 运维 | 单进程 Node + SQLite（WAL）+ 本地磁盘；单 Docker 镜像；`/healthz` |

## 快速开始

### Docker（推荐）

```bash
docker run -d --name dropit \
  -p 127.0.0.1:8787:8787 \
  -e NODE_ENV=development \
  -e APP_ORIGIN=http://localhost:8787 \
  -v dropit-data:/data \
  lthero1/dropit:latest
```

打开 <http://localhost:8787>。未配置 OAuth 时可以直接「进入临时房间」体验实时同步。

### 启用登录

成对设置 `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`（或 `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`），回调地址为 `${APP_ORIGIN}/api/auth/github/callback`（或 `.../google/callback`）。用户表为空时，**第一个成功登录的人自动成为管理员**。

### 生产部署

设 `NODE_ENV=production`、`APP_ORIGIN=https://你的域名`，容器只绑定 `127.0.0.1:8787`，由 nginx 等反向代理终止 TLS 并转发 WebSocket；`TRUST_PROXY` 填反代地址（如 `loopback`）。完整的 compose、nginx、升级与备份说明见 [部署文档](https://lthero-big.github.io/dropit/deploy/deployment/)。

### 从源码运行

```bash
pnpm install          # Node.js 22+，pnpm 11
cp .env.example .env
pnpm dev              # http://localhost:5173
```

## 文档

完整文档在 **<https://lthero-big.github.io/dropit/>**（源文件在 [`site/`](site/)）：

- [快速开始](https://lthero-big.github.io/dropit/start/getting-started/) · [使用指南](https://lthero-big.github.io/dropit/start/user-guide/) · [命令行](https://lthero-big.github.io/dropit/start/cli/)
- [部署](https://lthero-big.github.io/dropit/deploy/deployment/) · [管理后台](https://lthero-big.github.io/dropit/deploy/administration/) · [安全模型](https://lthero-big.github.io/dropit/deploy/security/)
- [配置](https://lthero-big.github.io/dropit/config/configuration/) · [后端配置参考](docs/backend-config.md)
- [API 概览](https://lthero-big.github.io/dropit/api/overview/) · [API 契约](docs/api.md)
- [架构](https://lthero-big.github.io/dropit/dev/architecture/) · [开发与贡献](https://lthero-big.github.io/dropit/dev/development/) · [常见问题](https://lthero-big.github.io/dropit/faq/)

## 许可证

[GNU AGPL-3.0-only](LICENSE)：可以免费使用、修改、分发和商用；分发修改版，或把修改版作为网络服务提供给他人时，须以 AGPL-3.0 公开完整源代码。详见 [常见问题](https://lthero-big.github.io/dropit/faq/)。
