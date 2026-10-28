# 部署

dropit 是单进程应用：一个 Node 进程同时托管前端静态文件、HTTP API 和 WebSocket，数据存放在 `DATA_DIR`（镜像内为 `/data`）中的 SQLite 数据库和文件目录。

## 推荐拓扑

```
浏览器 / CLI ──HTTPS──▶ nginx（TLS 终止，443） ──HTTP──▶ dropit 容器 127.0.0.1:8787 ──▶ 卷 dropit-data:/data
```

## Docker Compose

```yaml
services:
  dropit:
    image: lthero1/dropit:latest     # 或 build: . 从源码构建
    container_name: dropit
    restart: unless-stopped
    ports:
      - "127.0.0.1:8787:8787"
    env_file: .env                   # 放 OAuth 凭据、ADMIN_EMAILS 等
    environment:
      NODE_ENV: production
      APP_ORIGIN: https://dropit.example.com
      TRUST_PROXY: loopback
    volumes:
      - dropit-data:/data
volumes:
  dropit-data:
```

如果 nginx 在宿主机、请求经 Docker 网桥网关进入容器，`TRUST_PROXY` 需要包含该网关地址（例如为网络固定子网后填 `loopback,10.87.87.1`）。

`APP_ORIGIN` 也可以不写在 compose 里，部署后在「管理 → 站点地址」填写（页面设置优先于环境变量）。如果反代不在 `TRUST_PROXY` 里、又没有设置站点地址，dropit 看不到原始的 https，生成的 OAuth 回调会是 http——请设置站点地址或 `TRUST_PROXY`。启动日志的 `dropit APP_ORIGIN:` 一行可以确认当前生效值。

镜像自带 `HEALTHCHECK`（请求 `/healthz`），以非 root 用户 `node` 运行。

## nginx

```nginx
map $http_upgrade $connection_upgrade { default upgrade; '' close; }

server {
    listen 443 ssl;
    server_name dropit.example.com;
    # ssl_certificate ... / ssl_certificate_key ...

    client_max_body_size 30m;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_request_buffering off;
        proxy_read_timeout 3600s;
    }
}
```

- `client_max_body_size` 必须大于上传分片大小 `UPLOAD_CHUNK_BYTES`（默认 8 MiB，硬上限 24 MiB）；30m 可覆盖上限。
- 长 `proxy_read_timeout` 让 WebSocket 不被代理过早断开；客户端也会自动重连。

## 内网 HTTP 部署

没有 TLS 时直接用默认镜像即可（`NODE_ENV=production`）。`APP_ORIGIN` 可以不设（按访问地址自动处理），也可以设成实际访问地址；此时 Cookie 不带 Secure，日志和后台会提示站点是 HTTP：

```bash
docker run -d --name dropit \
  -p 192.168.1.10:8787:8787 \
  -e APP_ORIGIN=http://192.168.1.10:8787 \
  -e GITHUB_CLIENT_ID -e GITHUB_CLIENT_SECRET \
  -v dropit-data:/data lthero1/dropit:latest
```

只绑定内网地址，不要发布到 `0.0.0.0`，也不要做端口转发。OAuth 回调需登记为这个 origin。

## 升级

数据库迁移在启动时按 `user_version` 自动、原子执行。升级前建议先备份。

| 部署方式 | 升级命令 |
| --- | --- |
| Docker 镜像（`image: lthero1/dropit:latest`） | `docker compose pull && docker compose up -d` |
| Docker Compose 从源码构建 | `./scripts/update.sh --docker` |
| 源码部署（pnpm + systemd / pm2） | `./scripts/update.sh` |

仓库自带的 `docker-compose.yml` 同时写了 `image: lthero1/dropit:latest` 和 `build:`：`docker compose pull` 拉 Docker Hub 镜像，`docker compose up -d --build` 则从源码构建并打成同名标签。两种方式二选一，不要混用，否则下一次 `pull` 会用 Hub 镜像覆盖本地构建。

### 版本号

- 每个构建都带版本号和 git 短 hash：镜像通过 build-arg `DROPIT_VERSION` / `DROPIT_COMMIT` / `DROPIT_BUILD_DATE` 写入环境变量和 OCI 标签（`org.opencontainers.image.version` / `.revision` / `.created`）；源码部署由 `pnpm build` 生成 `apps/server/build-info.json`。
- `GET /api/version` 返回 `{"version","commit","buildDate","install"}`，`install` 为 `docker`（Hub 镜像）、`docker-build`（compose 本地构建）或 `source`。
- 本地构建镜像时带上提交号：`DROPIT_COMMIT=$(git rev-parse --short HEAD) docker compose up -d --build`（`scripts/update.sh --docker` 会自动设置）。
- `docker image inspect lthero1/dropit:latest --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}'` 可以看到镜像对应的提交。

### 检测新版本

服务端默认每 12 小时检查一次（缓存在 `DATA_DIR/update-check.json`，重启后不重复请求）：

- Docker 镜像：读取 Docker Hub `lthero1/dropit:latest` 的 digest，以及与它同 digest 的提交号 / 版本号标签，再用 GitHub compare 判断是否比当前新。
- 源码部署 / 本地构建：用 GitHub compare 比较当前提交和上游 `main`，显示落后的提交数。
- 两种方式都会参考 GitHub Releases：有更新的语义化版本 release 时同样提示。

管理员在「管理 → 更新」查看当前版本、上次检查时间、最新版本和对应部署方式的升级命令，可以「立即检查」；有新版本时管理页和设置页顶部会出现提示。检查只发出匿名 GET 请求，不上传任何实例信息。离线或被防火墙拦截时只记一行警告、显示「检查失败」，不影响使用，下个周期自动重试。完全离线的部署设 `UPDATE_CHECK=false`，相关变量见 [配置](Configuration.md#更新检查)。

### 自动更新（可选）

Docker 镜像部署可以启用 compose 里的 `watchtower` 服务（默认不启动）：

```bash
docker compose --profile autoupdate up -d
```

它使用仍在维护的 `nickfedor/watchtower`（原 `containrrr/watchtower` 已归档，且不支持 Docker 29+），参数 `--label-enable --cleanup --interval 43200`：只更新带 `com.centurylinklabs.watchtower.enable=true` 标签的容器（即 dropit），每 12 小时拉取一次 `latest`，新镜像就绪后重建容器并清理旧镜像。它需要挂载 `/var/run/docker.sock`，等同于宿主机 root 权限，请自行评估；不想这样做就保留手动命令。

如果自己的 compose 文件已经有别的 watchtower，给 dropit 加上同样的标签即可，不需要再起一个。

### 源码部署脚本

`scripts/update.sh` 依次执行 `git pull --ff-only`、`pnpm install --frozen-lockfile`、`pnpm build`，然后重启：

- 设置了 `DROPIT_RESTART_CMD` 时执行它（例如 `DROPIT_RESTART_CMD="systemctl restart dropit"`）；
- 否则存在 `dropit.service` 就 `systemctl restart dropit`，存在名为 `dropit` 的 pm2 应用就 `pm2 restart dropit`；
- 都没有时只构建并提示手动重启。

`--check` 只报告落后上游几个提交；`--docker` 改为 `docker compose up -d --build`。已跟踪文件有本地修改时脚本会拒绝执行；已是最新时跳过构建（`FORCE=1` 强制重建）。

## 备份与恢复

- 使用 SQLite backup API（如 `sqlite3 dropit.sqlite ".backup backup.sqlite"`），或停服后复制整个数据目录。
- 不要只复制运行中的 `.sqlite` 文件；数据库与文件目录要一起备份。
- 删除数据卷会同时删除内容、运行时限额覆盖和审计记录。

## 限制

- 仅支持单实例：限流、广播、在线人数、上传并发计数都在进程内存中，不要让多个实例共享同一数据目录。
