# Wiki 草稿

本目录是 dropit GitHub Wiki 的正式版草稿，尚未发布。发布方式：

```bash
git clone https://github.com/lthero-big/dropit.wiki.git   # 需先在 GitHub 网页上创建 Wiki 首页
cp docs/wiki/*.md dropit.wiki/ && rm dropit.wiki/README.md
cd dropit.wiki && git add . && git commit -m "Publish wiki" && git push
```

GitHub Wiki 中页面链接不带 `.md` 也可解析；本目录内使用带 `.md` 的相对链接，便于在仓库里直接浏览。
页面内容以仓库代码与 `docs/` 为准，修改功能时请同步更新。
