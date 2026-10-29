# 截图

README、Wiki 和文档站使用的界面截图。全部来自一个只填充了虚构示例数据的临时实例
（账号 `demo@example.com`、示例文本 / 图片 / 文件、房间 `demo-room`、占位 OAuth 应用、
Alice / Bob / Carol 三个待登录用户），不含任何真实数据。

| 文件 | 内容 |
| --- | --- |
| `login.png` | 登录页（邮箱密码、GitHub / Google、临时房间） |
| `board-light.png` / `board-dark.png` | 剪贴板，浅色 / 深色 |
| `command-palette.png` | Ctrl / ⌘ K 命令面板 |
| `share-panel.png` / `share-link.png` | 分享面板 / 接收方看到的分享页 |
| `room.png` | 临时房间与二维码 |
| `settings.png` | 设置 |
| `admin-users.png` / `admin-limits.png` | 管理 → 用户 / 限制 |
| `mobile-board.png` / `mobile-board-dark.png` / `mobile-room.png` | 手机端 |

## 重新生成

```bash
# 1. 起一个空的临时实例（不要用正式部署：脚本会写入示例数据）
docker volume create dropit-shots-data
docker run -d --name dropit-shots -p 127.0.0.1:15244:8787 -v dropit-shots-data:/data \
  -e APP_ORIGIN=http://dropit.example.com -e ADMIN_EMAIL=demo@example.com \
  -e ADMIN_PASSWORD=demo-pass-2026 -e UPDATE_CHECK=false lthero1/dropit:latest
# 想截当前源码的界面：先 docker build -t dropit:shots . 再把上面的镜像名换成 dropit:shots

# 2. Playwright 不是仓库依赖，装在临时目录
npm install --prefix /tmp/pw playwright && npx --prefix /tmp/pw playwright install chromium

# 3. 截图并压缩（桌面 1440×900，手机 430×932 @2x）
PLAYWRIGHT_PATH=/tmp/pw node scripts/screenshots.mjs http://127.0.0.1:15244 docs/screenshots
pngquant --force --skip-if-larger --quality 70-90 --ext .png docs/screenshots/*.png

# 4. 清理
docker rm -f dropit-shots && docker volume rm dropit-shots-data
```

浏览器把 `dropit.example.com` 解析到传入的地址，所以截图里的链接显示为 `http://dropit.example.com/...`；
`SITE_ORIGIN` 可改（须与 `APP_ORIGIN` 相同），`CHROME_PATH` 可改用本机 Chrome。
