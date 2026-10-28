---
title: 安全模型
---

## 身份与会话

- 只支持 OAuth（GitHub / Google），无密码；OAuth 流程使用 state + PKCE，state 一次性、10 分钟有效，不保存 provider 的 access/refresh token。
- 新身份需要有效邀请或管理员预创建；第一位用户例外（成为管理员）。不同 provider 身份不按邮箱合并。
- 会话为服务端保存的随机令牌，数据库只存 SHA-256；`NODE_ENV=production` 且站点地址为 https 时 Cookie 为 Secure（`__Host-` 前缀）并启用 HSTS；站点地址为 http 时不加 Secure（否则浏览器不保存），并在日志与后台警告。
- 禁用用户立即吊销其会话、个人访问令牌与 WebSocket。

## 令牌与能力链接

| 凭据 | 熵 | 存储 | 说明 |
| --- | --- | --- | --- |
| 会话 | 随机 | SHA-256 | 浏览器 Cookie |
| 个人访问令牌 | 256 位 | SHA-256 | `read` / `write` 范围，可设有效期，只在创建时返回一次 |
| 邀请 | 随机 | SHA-256 | 限次、限时、可撤销 |
| 临时房间 | 256 位 | 哈希 | 链接即读写能力 |
| 分享链接 | 256 位 | SHA-256 | 只读，限时、限次、可撤销；各种无效情况统一 `404` |
| 设备码 | 256 位 | SHA-256 | 10 分钟过期，需在浏览器批准 |

没有任何令牌枚举接口。令牌不能放在 URL 查询参数中（分享 / 房间 / 邀请链接本身就是能力凭据）。

## 请求校验

- Cookie 与匿名写请求、WebSocket 必须带 `Origin`；Bearer 请求不叠加 Cookie 权限。
- 设置了站点地址时 `Origin` 必须与之完全一致。未设置时必须与请求自身地址一致：主机取 `Host` 头，协议取连接本身（只采信 `TRUST_PROXY` 反代的 `X-Forwarded-Proto` / `X-Forwarded-Host`）；另外接受同一主机的 `https://` 页面（TLS 在未登记的反代上终止的情况）。
- 未设置站点地址时，改写 `Host` 的手段（如 DNS 重绑定）最多触达匿名接口，因为 Cookie 按主机隔离；公网部署建议固定站点地址。
- 修改站点地址需要管理员浏览器会话；新地址与当前访问地址不同时需要二次确认。
- 个人访问令牌不能创建令牌、改名或批准设备（需浏览器会话）。
- `TRUST_PROXY` 为空时忽略 `X-Forwarded-For`；配置后从真实 socket 起逐跳验证。
- 多维度限流（IP、账号、令牌、provider 身份），超限返回 `429` + `Retry-After`。

## 内容处理

- 文本默认纯文本显示；Markdown 渲染只支持安全子集，不解析原始 HTML、不插入图片，链接仅 http/https。
- 图片只以 sharp 重编码的 WebP 展示；视频 / 音频按文件头白名单内联，忽略上传时声明的 MIME。
- SVG、HTML 不内联；原始文件以 `Content-Disposition: attachment` 与 `nosniff` 下载。
- 上传按实际字节限额，并在事务中核对配额。

## 运维建议

- 生产环境必须 HTTPS，容器只绑定回环或内网地址，由反向代理对外。
- 不要把 OAuth 凭据提交到仓库，使用 `env_file` 或密钥管理。
- 分享链接、房间链接是能力凭据，传播前请确认接收方。
