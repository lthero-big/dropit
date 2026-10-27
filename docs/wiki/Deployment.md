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

没有 TLS 时只能使用 `NODE_ENV=development`，并让 `APP_ORIGIN` 与访问地址完全一致：

```bash
docker run -d --name dropit \
  -p 192.168.1.10:8787:8787 \
  -e NODE_ENV=development \
  -e APP_ORIGIN=http://192.168.1.10:8787 \
  -e GITHUB_CLIENT_ID -e GITHUB_CLIENT_SECRET \
  -v dropit-data:/data lthero1/dropit:latest
```

只绑定内网地址，不要发布到 `0.0.0.0`，也不要做端口转发。OAuth 回调需登记为这个 origin。

## 升级

```bash
docker compose pull && docker compose up -d      # 使用镜像
git pull && docker compose up -d --build         # 从源码构建
```

数据库迁移在启动时按 `user_version` 自动、原子执行。升级前建议先备份。

## 备份与恢复

- 使用 SQLite backup API（如 `sqlite3 dropit.sqlite ".backup backup.sqlite"`），或停服后复制整个数据目录。
- 不要只复制运行中的 `.sqlite` 文件；数据库与文件目录要一起备份。
- 删除数据卷会同时删除内容、运行时限额覆盖和审计记录。

## 限制

- 仅支持单实例：限流、广播、在线人数、上传并发计数都在进程内存中，不要让多个实例共享同一数据目录。
