# 常见问题

**登录页没有登录按钮？**
没有配置任何 OAuth provider。需要成对设置 `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET` 或 `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` 并重启。

**登录后跳回登录页并显示错误？**
错误码在 `/login?error=CODE`：`INVITATION_REQUIRED` 表示需要邀请；`VERIFIED_EMAIL_REQUIRED` 表示 provider 未返回已验证邮箱；`OAUTH_STATE_INVALID` 多为回调地址或 `APP_ORIGIN` 不一致、流程超时（10 分钟）。

**请求返回 `403 ORIGIN_REJECTED`？**
`APP_ORIGIN` 必须与浏览器地址栏的 origin 完全一致（协议、域名、端口）。

**生产模式下用 HTTP 无法登录？**
`NODE_ENV=production` 使用 Secure Cookie，必须 HTTPS。内网纯 HTTP 请用 `NODE_ENV=development`。

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
最后一个启用的管理员不能被禁用或降级，系统始终至少保留一个管理员。也可以在 `ADMIN_EMAILS` 中加入邮箱，让之后新注册的该邮箱账号成为管理员。
