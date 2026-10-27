# 快速开始

## 方式一：Docker 镜像

```bash
docker run -d --name dropit \
  -p 127.0.0.1:8787:8787 \
  -e NODE_ENV=development \
  -e APP_ORIGIN=http://localhost:8787 \
  -v dropit-data:/data \
  lthero1/dropit:latest
```

打开 <http://localhost:8787>，确认 `curl http://localhost:8787/healthz` 返回 `{"status":"ok"}`。

未配置 OAuth 时登录页没有可用的登录方式，但可以「进入临时房间」体验实时同步。要启用账号，请配置 OAuth（见下文）。

## 方式二：Docker Compose（从源码构建）

```bash
git clone https://github.com/lthero-big/dropit.git
cd dropit
docker compose up --build
```

默认发布在 `127.0.0.1:8787`。若已复制 `.env`，请把其中的 `APP_ORIGIN` 改为实际访问地址。

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
2. 通过环境变量提供 `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET` 或 `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`（成对设置才生效）。
3. 重启后登录。用户表为空时，**第一个成功登录的人自动成为管理员**。
4. 之后在管理后台创建邀请或按邮箱预创建用户，邀请其他人加入。

下一步：[部署到生产](Deployment.md)。
