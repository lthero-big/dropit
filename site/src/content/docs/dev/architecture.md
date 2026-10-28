---
title: 架构
---

## 仓库结构

```
apps/
  server/   后端：Hono 4 + @hono/node-server 2.x（内置 WebSocket），better-sqlite3，sharp
  web/      前端：React 19 + React Router + Vite + Tailwind CSS 4
  cli/      命令行：@dropit/cli（命令 dropit）
docs/       API 契约（api.md）、后端配置（backend-config.md）、Wiki 源文件
site/       文档站（Starlight，发布到 GitHub Pages）
scripts/    浏览器与 Docker 验收脚本
Dockerfile  多阶段构建：构建前端与后端，运行镜像只含生产依赖与静态文件
```

pnpm workspace 管理三个包，根目录 `pnpm lint / typecheck / test / build` 递归执行。

## 后端模块（apps/server/src）

| 文件 | 职责 |
| --- | --- |
| `index.ts` | 进程入口：加载配置、启动 HTTP/WebSocket 服务、托管静态文件 |
| `backend.ts` | 组合根与路由定义 |
| `config.ts` / `limits.ts` | 环境变量解析校验；运行时限额策略、硬上限与覆盖 |
| `service.ts` | `ClipboardService` 业务逻辑：权限、配额、条目、分享 |
| `uploads.ts` | 分片上传会话 |
| `repository.ts` / `migrations.ts` | SQLite 访问（SQL 只在此处）与 `user_version` 迁移 |
| `files.ts` | 本地磁盘文件存储 |
| `events.ts` | WebSocket 广播 |
| `media.ts` | 缩略图、预览与媒体文件头识别 |
| `oauth.ts` | GitHub / Google OAuth（state + PKCE） |
| `rate-limit.ts` | 固定窗口限流 |
| `domain.ts` | 领域类型 |

`ClipboardService` 依赖 `Repository`、`FileStorage`、`Broadcaster` 三个接口，便于测试替换实现。

## 数据

- SQLite（WAL）文件 `DATA_DIR/dropit.sqlite` 与上传文件同在 `DATA_DIR`。
- 迁移在事务中原子执行；运行时限额与审计、上传会话等均通过迁移添加。
- 定时任务（`CLEANUP_INTERVAL_MS`）删除过期条目、房间、上传会话，重试失败的文件删除，回收一小时以上的孤儿文件。

## 前端

- 路由：`/`（剪贴板）、`/login`、`/invite/:token`、`/r/:code`（房间码即链接；旧的 `/rooms/:token` 会跳转到 `/r/<房间码>`）、`/join`、`/s/:token`（分享页）、`/admin`、`/settings`、`/device`。
- 通过 WebSocket 接收 snapshot 与增量事件，断线指数退避重连。
- 大文件分片上传，支持中断续传。

## 部署模型

单进程、单实例。限流、广播、在线人数和上传并发计数都在内存中；不支持多实例共享数据目录。
