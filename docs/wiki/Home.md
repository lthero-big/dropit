# dropit

dropit 是一个自托管的跨设备云剪贴板：在一台设备上粘贴文本或拖入文件，同一空间里的其他设备通过 WebSocket 立即看到。网页、命令行（`dropit`）和临时房间使用同一套 HTTP + WebSocket API。

## 主要特性

| 领域 | 能力 |
| --- | --- |
| 剪贴板 | 文本 / 文件条目、实时同步、就地编辑、Markdown 安全渲染、标签、置顶、分组、来源设备、命令面板 |
| 文件 | WebP 缩略图与预览、视频/音频内联播放、`Range` 断点下载、分片续传上传 |
| 分享 | 有时限、可限次、可撤销的只读链接；无需账号的临时房间（≤ 24 小时，一个房间码即短链接 `/r/<房间码>`，可选 PIN，二维码加入） |
| 账号 | 邮箱 + 密码与 GitHub / Google OAuth、首次运行 /setup 初始化码、注册策略（默认仅邀请）、管理员重置密码、个人访问令牌、设备码登录 |
| 管理 | 用户、邀请、令牌、运行时限额（即时生效 + 审计） |
| 运维 | 单进程 Node + SQLite（WAL）+ 本地磁盘；单 Docker 镜像；`/healthz` |

## 截图

![dropit 剪贴板](https://raw.githubusercontent.com/lthero-big/dropit/main/docs/screenshots/board-light.png)

更多截图（深色主题、分享、临时房间、管理后台、手机端）见仓库 [README](https://github.com/lthero-big/dropit#截图)。截图均为虚构示例数据。

## 从这里开始

- 第一次使用：[快速开始](Getting-Started.md)
- 部署到服务器：[部署](Deployment.md) 与 [配置](Configuration.md)
- 日常使用：[使用指南](User-Guide.md)、[命令行](CLI.md)
- 集成与二次开发：[API 概览](API.md)、[架构](Architecture.md)、[开发与贡献](Development.md)

## 项目信息

- 源码：<https://github.com/lthero-big/dropit>
- 镜像：[`lthero1/dropit`](https://hub.docker.com/r/lthero1/dropit)（`latest` 及按提交号的标签）
- 运行要求：Node.js 22+（源码）或 Docker
- 许可证：[GNU AGPL-3.0-only](https://github.com/lthero-big/dropit/blob/main/LICENSE)（可商用；修改后对外提供网络服务须公开源码，详见 [常见问题](FAQ.md)）
