---
title: Getting started
---

## Option 1: Docker image

```bash
docker run -d --name dropit \
  -p 127.0.0.1:8787:8787 \
  -v dropit-data:/data \
  lthero1/dropit:latest
```

Open <http://localhost:8787> and check that `curl http://localhost:8787/healthz` returns `{"status":"ok"}`.

No environment variables are needed. When `APP_ORIGIN` is unset, dropit uses the address the browser is using for CSRF checks and generated links — a LAN IP works too. To pin the address, set it after signing in under “Admin → Site address”, or set the `APP_ORIGIN` environment variable. The `dropit APP_ORIGIN:` line in the startup log shows the effective value.

Without OAuth configured, the login page offers no sign-in method, but you can still use “Enter a temporary room” to try real-time sync. To enable accounts, configure OAuth (see below).

## Option 2: Docker Compose (build from source)

```bash
git clone https://github.com/lthero-big/dropit.git
cd dropit
docker compose up --build
```

It starts without a `.env` and is published on `127.0.0.1:8787` only. To change settings:

```bash
cp .env.example .env
```

`.env.example` is split into required (none) / recommended / optional, and marks what can be changed in the admin panel instead (site address, OAuth, limits). `docker-compose.yml` only keeps the port, the data volume and `env_file: .env`.

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
   “Admin → Site address” lists both callback URLs ready to copy.
2. Provide `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET` or `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` via environment variables (each pair only takes effect when both are set).
3. Restart and sign in. When the user table is empty, **the first person to sign in successfully automatically becomes admin**.
4. Then create invitations in the admin panel, or pre-create users by email, to invite others.

Next: [Deploy to production](../../deploy/deployment/).
