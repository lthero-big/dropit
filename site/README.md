# dropit 文档站

基于 [Starlight](https://starlight.astro.build/)（Astro）。发布地址：<https://lthero-big.github.io/dropit/>。

```bash
cd site
npm ci
npm run dev       # 本地预览 http://localhost:4321/dropit/
npm run build     # 输出到 site/dist/
```

- 页面在 `src/content/docs/`，侧栏在 `astro.config.mjs`。
- 中文为根语言；加英文时在 `locales` 增加 `en`，并在 `src/content/docs/en/` 放同名页面。
- 推送到 `main` 且改动 `site/` 时，`.github/workflows/docs.yml` 自动构建并发布到 GitHub Pages。
- 仓库 `docs/backend-config.md`、`docs/api.md`（英文，被测试引用）是权威原文：英文站 `en/config/backend-config.md`、`en/api/reference.md` 与其内容一致；中文站 `config/backend-config.md`、`api/reference.md` 是其中文译文。修改原文时请同步更新英文页并更新中文译文（没有自动同步脚本，不会覆盖译文）。
