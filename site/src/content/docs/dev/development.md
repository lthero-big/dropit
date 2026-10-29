---
title: 开发与贡献
---

## 环境

- Node.js 22+，pnpm 11（`packageManager: pnpm@11.1.0`）

```bash
pnpm install
cp .env.example .env
pnpm dev            # 并行启动 @dropit/web（5173）与 @dropit/server（8787）
```

## 检查

```bash
pnpm lint           # oxlint
pnpm typecheck
pnpm test           # web 用 vitest，server 与 cli 用 tsx --test；后端使用 mock OAuth，包含真实 HTTP、WebSocket、SQLite、磁盘与安全用例
pnpm build
```

单包运行：`pnpm --filter @dropit/server test`、`pnpm --filter @dropit/web test`、`pnpm --filter dropit-cli test`。

自动化测试不需要真实 OAuth 凭据。`scripts/` 下另有浏览器与 Docker 验收脚本。

## 文档站

文档站源文件在 `site/`（Starlight），本地预览：`cd site && npm ci && npm run dev`。推送到 `main` 且改动 `site/` 时由 `.github/workflows/docs.yml` 发布到 GitHub Pages。

## CI

GitHub Actions（`.github/workflows/ci.yml`）在每次 push 和 pull request 上运行：

1. `pnpm install --frozen-lockfile` → lint → typecheck → test → build
2. 单独构建 Docker 镜像

## 贡献流程

1. 从 `main` 新建分支，不直接提交到 `main`。
2. 修改 API 或配置时同步更新 `docs/api.md`、`docs/backend-config.md` 与文档站 `site/` 中的相关页面。
3. 本地通过 lint / typecheck / test / build 后提交 Pull Request。
