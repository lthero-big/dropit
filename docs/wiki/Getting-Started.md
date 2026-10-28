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

未配置 OAuth 时登录页没有可用的登录方式，但可以「进入临时房间」体验实时同步。要启用账号，请配置 OAuth（见下文）。

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

## 配置 OAuth 并成为管理员

1. 创建 GitHub OAuth App（scope `read:user user:email`），回调地址 `${APP_ORIGIN}/api/auth/github/callback`；
   和/或 Google Web OAuth client（scope `openid email profile`），回调地址 `${APP_ORIGIN}/api/auth/google/callback`。
   「管理 → 站点地址」会列出这两个回调地址，可直接复制。
2. 通过环境变量提供 `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET` 或 `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`（成对设置才生效）。
3. 重启后登录。用户表为空时，**第一个成功登录的人自动成为管理员**。
4. 之后在管理后台创建邀请或按邮箱预创建用户，邀请其他人加入。

下一步：[部署到生产](Deployment.md)。
