---
title: 命令行
---

`@dropit/cli` 提供命令 `dropit`，适合脚本和没有打开网页的设备。需要 Node.js 22+。包未发布到公共 npm registry，请勿运行 `npx dropit`。

## 安装

```bash
pnpm install
pnpm --filter @dropit/cli build
npm install -g ./apps/cli
# 或不安装：npx --yes ./apps/cli --help
```

## 登录

```bash
dropit login --url https://dropit.example.com   # 打印验证码，在已登录的浏览器 /device 页批准
dropit whoami
dropit logout
```

- 可选参数：`--name <设备名>`、`--scopes read,write`、`--expires-in-days 30|never`。
- 令牌保存在 `$XDG_CONFIG_HOME/dropit/config.json`（或 `~/.config/dropit/config.json`），权限 `0600`；`DROPIT_CONFIG` 可改路径。
- 脚本 / CI：设置 `DROPIT_URL` 与 `DROPIT_TOKEN`，优先于配置文件且不会写回。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `dropit send "文本"` / `echo x \| dropit send` | 发送文本 |
| `dropit push <文件...> [--keep]` | 上传；≥ 256 KiB 分片上传（3 路并行，失败重试，可续传） |
| `dropit ls` | 列出条目 |
| `dropit get <id\|latest> [-o 目录] [-c] [--jobs N] [--force]` | 下载；`-c` 续传，`--jobs 1–8` 并行 Range |
| `dropit rm <id\|latest>` | 撤回条目 |
| `dropit share <id\|latest> --expires 1d --max-views 1` | 生成分享链接 |
| `dropit watch [--exec -- 程序 参数...]` | 实时监听新条目，可触发程序 |
| `dropit room new` / `dropit room join <URL>` | 创建 / 加入临时房间 |
| `dropit --space <id或名称> ls` | 指定并记住空间 |

`watch --exec` 的程序从 stdin 接收条目正文，并获得 `DROPIT_ITEM_ID`、`DROPIT_ITEM_KIND`、`DROPIT_ITEM_FILENAME`、`DROPIT_ITEM_MIME`、`DROPIT_ITEM_SIZE`、`DROPIT_ITEM_SPACE`、`DROPIT_ITEM_TEXT` 环境变量；不经过 shell。

## 输出与退出码

- `--json`：结果写 stdout，错误写 stderr（`{"error":{"code","message"}}`），`push` 进度为 stderr 上的 JSON 行。
- 退出码：`0` 成功，`2` 用法错误，`130` 中断，其他非 0 为失败。
- 令牌从不打印；分享链接和房间链接是能力凭据，会打印出来。

完整说明见 [apps/cli/README.md](https://github.com/lthero-big/dropit/blob/main/apps/cli/README.md)。
