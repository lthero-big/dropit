# API 概览

本页是概览，权威契约见仓库 [docs/api.md](https://github.com/lthero-big/dropit/blob/main/docs/api.md)。

## 约定

- 同源 HTTP API，前缀 `/api`；除下载、缩略图、预览、媒体、OAuth 重定向和 `204` 外均为 JSON。
- 时间为 Unix 毫秒，大小为字节。
- 浏览器使用服务端会话 Cookie；命令行和脚本使用个人访问令牌：`Authorization: Bearer <token>`。
- Cookie 或匿名的写请求必须带 `Origin: <APP_ORIGIN>`；有效 Bearer 令牌免 Origin 校验。
- JSON 请求需要 `Content-Type: application/json`。
- 错误格式：`{"error":{"code":"QUOTA_EXCEEDED"}}`；429 带 `Retry-After`。
- 健康检查：`GET /healthz` → `{"status":"ok"}`。

## 端点分组

| 分组 | 主要路径 |
| --- | --- |
| 认证 | `GET /auth/providers`、`GET /auth/:provider`、`GET /auth/:provider/callback`、`POST /auth/logout`、`GET /me`、`GET /invites/:token` |
| 个人访问令牌 | `POST/GET /tokens`、`PATCH/DELETE /tokens/:id` |
| 设备码登录 | `POST /auth/device/authorize`、`POST /auth/device/token`、`GET /auth/device`、`POST /auth/device/approve`、`POST /auth/device/deny` |
| 管理 | `/admin/users`、`/admin/users/:id/logout`、`/admin/invites`、`/admin/tokens`、`/admin/limits`、`/admin/limits/audit` |
| 空间与房间 | `GET /spaces`、`POST /rooms` |
| 条目（`base` = `/spaces/:id` 或 `/rooms/:token`） | `GET base`、`GET base/items`、`POST base/items/text`、`POST base/items/file`、`PATCH base/items/:id`、`PATCH base/items/:id/labels`、`DELETE base/items/:id`、`GET base/items/:id/{download,thumbnail,preview,media}` |
| 分组 | `GET/POST base/groups`、`PATCH/DELETE base/groups/:name` |
| 分片上传 | `POST base/uploads`、`GET base/uploads/:id`、`PUT base/uploads/:id/chunks/:index`、`POST base/uploads/:id/complete`、`DELETE base/uploads/:id` |
| 分享链接 | `POST/GET base/items/:id/shares`、`DELETE base/shares/:shareId`、公开 `GET /s/:token` 及 `/s/:token/{file,thumbnail,preview,media}` |
| 实时 | `GET base/ws`（WebSocket） |

## WebSocket

服务端只推送、不接收客户端消息：

```ts
type Message =
  | {type: 'snapshot'; items: Item[]; groups?: string[]; serverTime: number; expiresAt: number | null}
  | {type: 'groups'; groups: string[]}
  | {type: 'item.created'; item: Item}
  | {type: 'item.updated'; item: Item}
  | {type: 'item.deleted'; id: string}
  | {type: 'presence'; devices: number; peers?: Array<{id: string; name: string; kind: string}>};
```

每次连接都用第一条 `snapshot` 替换本地列表，再按 `id` 应用增量事件；断线后指数退避（含抖动，最长 30 秒）重连。遇到 401/403/404 停止重试。

## 示例

```bash
export DROPIT_URL=https://dropit.example.com
export DROPIT_TOKEN=...   # 在 /settings 创建

# 列出空间
curl -s -H "Authorization: Bearer $DROPIT_TOKEN" $DROPIT_URL/api/spaces

# 发送文本
curl -s -X POST -H "Authorization: Bearer $DROPIT_TOKEN" -H 'Content-Type: application/json' \
  -d '{"text":"hello"}' $DROPIT_URL/api/spaces/<spaceId>/items/text

# 上传文件（单请求）
curl -s -X POST -H "Authorization: Bearer $DROPIT_TOKEN" -H 'Content-Type: image/png' \
  -H 'X-File-Name: photo.png' --data-binary @photo.png $DROPIT_URL/api/spaces/<spaceId>/items/file
```
