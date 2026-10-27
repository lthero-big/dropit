# Wiki 源文件

本目录是 dropit [GitHub Wiki](https://github.com/lthero-big/dropit/wiki) 的源文件，已发布。更新 Wiki 的方式：

```bash
git clone https://github.com/lthero-big/dropit.wiki.git
cp docs/wiki/*.md dropit.wiki/ && rm dropit.wiki/README.md
sed -i -E 's/\]\(([A-Za-z_-]+)\.md(#[^)]*)?\)/](\1\2)/g' dropit.wiki/*.md   # Wiki 内链接去掉 .md
cd dropit.wiki && git add . && git commit -m "Publish wiki" && git push
```

本目录内使用带 `.md` 的相对链接，便于在仓库里直接浏览；发布到 Wiki 时用上面的 sed 去掉 `.md`。
页面内容以仓库代码与 `docs/` 为准，修改功能时请同步更新。
