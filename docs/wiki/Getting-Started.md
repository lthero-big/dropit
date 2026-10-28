# 快速开始

## 方式一：Docker 镜像

```bash
docker run -d --name dropit \
  -p 127.0.0.1:8787:8787 \
  -v dropit-data:/data \
  lthero1/dropit:latest
```

打开 <http://localhost:8787>，确认 `curl http://localhost:8787/healthz` 返回 `{"status":"ok"}`。

不需要设置任何环境变量。`APP_ORIGIN` 未设置时，dropit 按浏览器访问的地址处理 CSRF 校验和生成的链接；用局域网 IP 访问也一样。要固定地址时，登录后在「管理 → 站点地址」填写，或设置环境变量 `APP_ORIGIN`。启动日志里的 `dropit APP_ORIGIN:` 一行会显示当前生效值。

第一次打开会进入 `/setup` 创建管理员（见下文「首次运行」）。之后用邮箱 + 密码登录；GitHub / Google 登录可选。不登录也可以「进入临时房间」体验实时同步。

## 方式二：Docker Compose（从源码构建）

```bash
git clone https://github.com/lthero-big/dropit.git
cd dropit
docker compose up --build
```

没有 `.env` 也能启动，默认只发布在 `127.0.0.1:8787`。需要改配置时：

```bash
cp .env.example .env
```

`.env.example` 分为「必填（无）/ 推荐 / 可选」三部分，并标出哪些项可以在管理后台修改（站点地址、OAuth、限额）。`docker-compose.yml` 只保留端口、数据卷和 `env_file: .env`。

## 方式三：本地开发

需要 Node.js 22+ 与 pnpm 11：

```bash
pnpm install
cp .env.example .env
pnpm dev
```

访问 <http://localhost:5173>（Vite 把 `/api`、WebSocket 与 `/healthz` 代理到 8787）。

## 首次运行：创建管理员

还没有任何账号时，服务启动会在日志里打印一次性初始化码：

```bash
docker logs dropit 2>&1 | grep 'setup code'
# dropit setup code: K7QM-4XHT
```

浏览器打开站点会自动跳到 `/setup`，填入初始化码、管理员邮箱和密码（至少 8 位）即完成初始化并登录。初始化码每次启动重新生成，创建出第一个账号后立即失效；错误尝试按 `RATE_AUTH` 限流。

不想开浏览器：在 `.env` 里**同时**设置 `ADMIN_EMAIL` 和 `ADMIN_PASSWORD`，数据库为空时启动即创建该管理员并跳过 `/setup`（启动日志会写 `created the first admin …`）。之后这两个变量不再起作用，建议删掉 `ADMIN_PASSWORD`。

忘记密码：`docker exec dropit dropit-admin reset-password 你的邮箱`，打印一个临时密码，登录后必须立即修改。

## 配置 OAuth（可选）

1. 创建 GitHub OAuth App（scope `read:user user:email`），回调地址 `${APP_ORIGIN}/api/auth/github/callback`；
   和/或 Google Web OAuth client（scope `openid email profile`），回调地址 `${APP_ORIGIN}/api/auth/google/callback`。
   「管理 → 站点地址」会列出这两个回调地址，可直接复制。
2. 通过环境变量提供 `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET` 或 `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`（成对设置才生效）。
3. 重启后登录。也可以不用环境变量，登录后在「管理 → OAuth 登录」填写凭据。密码账号可在「设置 → 登录方式」绑定 GitHub / Google。
   注意：如果在完成 `/setup` 之前就通过环境变量配好了 OAuth，用户表为空时**第一个成功 OAuth 登录的人也会成为管理员**（不需要初始化码）。公网部署请先完成 `/setup`，或用 `ADMIN_EMAIL` / `ADMIN_PASSWORD`。
4. 之后在管理后台创建邀请、按邮箱预创建用户（可生成临时密码），邀请其他人加入。默认注册策略是「仅邀请」，可在「管理 → 注册」改为关闭或开放。

下一步：[部署到生产](Deployment.md)。
