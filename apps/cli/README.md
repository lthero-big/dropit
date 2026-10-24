# dropit 命令行

`@dropit/cli` 是 dropit 的命令行客户端，命令名是 `dropit`。适合脚本，以及没有打开网页的另一台设备。

需要 Node.js 22+。在仓库里安装：

```bash
pnpm install
pnpm --filter @dropit/cli build
npm install -g ./apps/cli
```

`npm install -g` 会执行 `prepack` 并编译 TypeScript。也可以不安装，直接：

```bash
npx --yes ./apps/cli --help
```

包名是 `@dropit/cli`，不要对公共 registry 执行 `npx dropit`。

## 登录

```bash
dropit login --url http://127.0.0.1:8787
```

命令打印验证码和批准链接。在已经登录的浏览器里打开该链接并批准。令牌写入配置文件，权限 `0600`，不会出现在终端或日志里。

```bash
dropit whoami
dropit logout
```

脚本和 CI 可以不走设备码，把已有的个人访问令牌放在环境变量里：

```bash
export DROPIT_URL=http://127.0.0.1:8787
export DROPIT_TOKEN=...
```

`DROPIT_URL` 和 `DROPIT_TOKEN` 覆盖配置文件。环境变量里的令牌不会被写回文件。`DROPIT_CONFIG` 可以改配置文件路径；默认是 `$XDG_CONFIG_HOME/dropit/config.json`，否则是 `~/.config/dropit/config.json`。

`login` 可选参数：

- `--name` 设备名，默认主机名
- `--scopes read,write` 范围，默认同时有读和写
- `--expires-in-days 30` 或 `never`

只读令牌不能 `send`、`push`、`rm`，也不能在服务器上撤销自己。`logout` 遇到只读令牌时只清除本地配置。

## 剪贴板

```bash
dropit send "一行文本"
echo "来自管道" | dropit send
dropit push ./notes.txt ./photo.png
dropit ls
dropit get latest
dropit get <id> -o ./downloads
dropit get <id> -o ./downloads -c
dropit get <id> -o ./downloads --force
dropit rm latest
dropit share latest --expires 1d --max-views 1
```

没有参数的 `send` 从 stdin 读取。没有 TTY 时不会询问，空文本会失败。

`push` 在 stderr 是 TTY 时显示进度。某个文件失败时，该文件不会变成条目，命令停在这个文件；前面已经传完的文件会保留。

`get` 不加 `-o` 时把内容写到 stdout，可以继续管道。`-o` 是目录。文件名用服务器返回的名字，只取安全的基名，不会写到目录外面，默认也不覆盖已有文件。`-c` 用单段 `Range` 接着已有的普通文件写；目标是符号链接时拒绝续传。文本不能续传。

`share` 打印的 URL 是能力凭据。拿到链接的人就能读，直到过期、次数用尽或被撤销。

## 监听

```bash
dropit watch
dropit watch --exec -- ./on-item.sh
```

连接空间或房间的 WebSocket。第一条 snapshot 只作为基线。之后新出现的条目会打印出来。断线后按指数退避重连，再用新的 snapshot 补上没见过的条目。认证失败不再重试。Ctrl-C 退出码是 130。

`--exec` 必须放在最后。后面的程序按原样执行，不经过 shell。条目正文从 stdin 传入，元数据在这些环境变量里：

- `DROPIT_ITEM_ID`
- `DROPIT_ITEM_KIND`
- `DROPIT_ITEM_FILENAME`
- `DROPIT_ITEM_MIME`
- `DROPIT_ITEM_SIZE`
- `DROPIT_ITEM_SPACE`
- `DROPIT_ITEM_TEXT`（仅文本）

监听需要令牌包含 `read`。

## 空间和房间

```bash
dropit --space <id或名称> ls
dropit room new
dropit room join 'http://127.0.0.1:8787/rooms/<token>'
```

`--space` 会记住这个空间，并清除已选的房间。`room new` 和 `room join` 会把之后的命令默认发到该房间。房间 URL 同样是能力凭据。

`--space` 和 `--room` 不能同时使用。没有 TTY 时，多个空间且没有默认值会直接失败，不会交互选择。

## 机器可读输出

`--json` 时，成功结果写到 stdout，错误写到 stderr，形如 `{"error":{"code":"...","message":"..."}}`。`get` 不加 `-o` 时 stdout 仍是原始内容。`login --json` 先输出一行验证信息（不含设备码），批准后再输出一行登录结果（不含令牌）。

退出码：`0` 成功，`2` 用法错误，`130` 监听被中断，其他非 0 为失败。错误在 stderr。
