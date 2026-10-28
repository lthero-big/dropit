---
title: 常见问题
---

**第一次打开就跳到 /setup，初始化码在哪？**
在服务启动日志里：`docker logs dropit 2>&1 | grep 'setup code'`，形如 `dropit setup code: K7QM-4XHT`。每次重启都会换一个新码，以最近一次启动的为准。不想用浏览器可以在 `.env` 里同时设 `ADMIN_EMAIL` / `ADMIN_PASSWORD` 再启动。

**忘记密码 / 管理员被锁在外面？**
其他管理员可在「管理 → 用户 → 编辑 → 重置密码」生成临时密码。只有你一个管理员时，在服务器上运行 `docker exec dropit dropit-admin reset-password 你的邮箱`，用打印出的临时密码登录后设置新密码。

**登录页没有 GitHub / Google 按钮？**
邮箱 + 密码登录总是可用。要用 GitHub / Google，需要成对设置 `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET` 或 `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` 并重启，或在「管理 → OAuth 登录」填写。

**别人打不开注册？**
默认注册策略是「仅邀请」。给对方发邀请链接、在「管理 → 用户」预创建账号（可生成临时密码），或在「管理 → 注册」改为开放。

**登录后跳回登录页并显示错误？**
错误码在 `/login?error=CODE`：`INVITATION_REQUIRED` 表示需要邀请；`VERIFIED_EMAIL_REQUIRED` 表示 provider 未返回已验证邮箱；`OAUTH_STATE_INVALID` 多为回调地址或 `APP_ORIGIN` 不一致、流程超时（10 分钟）。

**请求返回 `403 ORIGIN_REJECTED`？**
设置了站点地址（`APP_ORIGIN` 或「管理 → 站点地址」）时，它必须与浏览器地址栏的 origin 完全一致（协议、域名、端口）。登录页和错误提示会写出期望地址和当前地址：改用期望地址访问，或把站点地址改成当前地址。改错进不去后台时，用 `RESET_APP_ORIGIN=1` 启动一次清除页面设置。启动日志的 `dropit APP_ORIGIN:` 一行显示当前生效值。

**生产模式下用 HTTP 无法登录？**
现在可以：站点地址是 http 时 Cookie 不带 Secure，日志和后台只会警告。面向公网的实例仍建议 HTTPS。如果浏览器用 https 访问而站点地址写的是 http（或反过来），按上一条处理。

**限流对所有人生效 / 看到的都是代理 IP？**
反代后面请设置 `TRUST_PROXY` 为反代地址（宿主机 nginx 访问容器时通常还需加入 Docker 网关地址）。

**大文件上传失败（413）？**
检查反代 `client_max_body_size` 是否大于 `UPLOAD_CHUNK_BYTES`，以及 `MAX_FILE_BYTES`、配额设置。

**WebSocket 频繁断开？**
确认反代转发了 `Upgrade` / `Connection` 头，并设置较长的 `proxy_read_timeout`。

**可以多实例部署吗？**
不可以。当前为单进程设计，内存中维护限流、广播与在线状态。

**如何备份？**
用 SQLite backup API 备份 `DATA_DIR/dropit.sqlite`，同时备份整个数据目录；或停服后复制整个卷。

**忘了谁是管理员 / 管理员都被禁用了？**
最后一个启用的管理员不能被禁用或降级，系统始终至少保留一个管理员。也可以在 `ADMIN_EMAILS` 中加入邮箱，让之后经 OAuth 新注册的该邮箱账号成为管理员；或用 `dropit-admin reset-password` 找回现有管理员的密码。

**可以商用吗？用的是什么许可证？**
可以商用。dropit 以 [GNU AGPL-3.0-only](https://github.com/lthero-big/dropit/blob/main/LICENSE) 发布：可以免费使用、修改、分发和商用；但分发修改版，或把修改版作为网络服务给他人使用时，必须以 AGPL-3.0 向用户公开完整源代码。不修改、原样部署时，向用户提供本仓库地址即可。
