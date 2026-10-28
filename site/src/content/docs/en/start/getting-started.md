---
title: Getting started
---

## Option 1: Docker image

```bash
docker run -d --name dropit \
  -p 127.0.0.1:8787:8787 \
  -e NODE_ENV=development \
  -e APP_ORIGIN=http://localhost:8787 \
  -v dropit-data:/data \
  lthero1/dropit:latest
```

Open <http://localhost:8787> and check that `curl http://localhost:8787/healthz` returns `{"status":"ok"}`.

Without OAuth configured, the login page offers no sign-in method, but you can still use “Enter a temporary room” to try real-time sync. To enable accounts, configure OAuth (see below).

## Option 2: Docker Compose (build from source)

```bash
git clone https://github.com/lthero-big/dropit.git
cd dropit
docker compose up --build
```

It is published on `127.0.0.1:8787` by default. If you have copied `.env`, change its `APP_ORIGIN` to the address you actually use.

## Option 3: Local development

Requires Node.js 22+ and pnpm 11:

```bash
pnpm install
cp .env.example .env
pnpm dev
```

Visit <http://localhost:5173> (Vite proxies `/api`, WebSocket and `/healthz` to 8787).

## Configure OAuth and become admin

1. Create a GitHub OAuth App (scope `read:user user:email`) with callback URL `${APP_ORIGIN}/api/auth/github/callback`;
   and/or a Google Web OAuth client (scope `openid email profile`) with callback URL `${APP_ORIGIN}/api/auth/google/callback`.
2. Provide `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET` or `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` via environment variables (each pair only takes effect when both are set).
3. Restart and sign in. When the user table is empty, **the first person to sign in successfully automatically becomes admin**.
4. Then create invitations in the admin panel, or pre-create users by email, to invite others.

Next: [Deploy to production](../../deploy/deployment/).
