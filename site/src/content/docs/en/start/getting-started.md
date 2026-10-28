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

The first visit opens `/setup` to create the admin (see “First run” below). After that, sign in with email + password; GitHub / Google sign-in is optional. Without signing in you can still use “Enter a temporary room” to try real-time sync.

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

## First run: create the admin

While no account exists, the server prints a one-time setup code in its startup log:

```bash
docker logs dropit 2>&1 | grep 'setup code'
# dropit setup code: K7QM-4XHT
```

Opening the site redirects to `/setup`: enter the code, the admin email and a password (at least 8 characters) and you are signed in. A new code is generated at every start and stops working as soon as the first account exists; wrong attempts are rate limited by `RATE_AUTH`.

Headless alternative: set **both** `ADMIN_EMAIL` and `ADMIN_PASSWORD` in `.env`. On an empty database the server creates that admin at startup and skips `/setup` (the log says `created the first admin …`). Afterwards the variables are ignored; remove `ADMIN_PASSWORD`.

Forgot the password: `docker exec dropit dropit-admin reset-password you@example.com` prints a temporary password that must be changed at the next sign-in.

## Configure OAuth (optional)

1. Create a GitHub OAuth App (scope `read:user user:email`) with callback URL `${APP_ORIGIN}/api/auth/github/callback`;
   and/or a Google Web OAuth client (scope `openid email profile`) with callback URL `${APP_ORIGIN}/api/auth/google/callback`.
   “Admin → Site address” lists both callback URLs ready to copy.
2. Provide `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET` or `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` via environment variables (each pair only takes effect when both are set).
3. Restart and sign in — or skip the environment variables and enter the credentials under “Admin → OAuth sign-in”. Password accounts can bind GitHub / Google under “Settings → Sign-in methods”.
   Note: if OAuth is configured through the environment before `/setup` is completed, **the first successful OAuth sign-in on an empty user table also becomes admin** (no setup code needed). On a public server, finish `/setup` first or use `ADMIN_EMAIL` / `ADMIN_PASSWORD`.
4. Then create invitations in the admin panel, or pre-create users by email (optionally with a temporary password), to invite others. Registration is invite-only by default; change it under “Admin → Registration”.

Next: [Deploy to production](../../deploy/deployment/).
