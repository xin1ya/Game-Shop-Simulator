#!/usr/bin/env bash
# 服务器一次性初始化（在阿里云服务器上以 root/sudo 执行）：
#   curl -sSL <本文件> | sudo bash   或   sudo bash server-setup.sh
# 安装 nginx、写入站点配置、建站点目录。之后本地跑 tools/deploy/deploy.sh 即可发布。
set -euo pipefail

ALI_DIR="${ALI_DIR:-/var/www/game-shop}"

# ---- 安装 nginx ----
if ! command -v nginx >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -y && apt-get install -y nginx
  elif command -v yum >/dev/null 2>&1; then
    yum install -y nginx
  else
    echo "✗ 未识别的包管理器，请手动安装 nginx" >&2; exit 1
  fi
fi

# ---- 站点目录 ----
mkdir -p "$ALI_DIR/releases"

# ---- nginx 站点配置 ----
cat > /etc/nginx/conf.d/game-shop.conf <<'NGINX'
server {
    listen 80 default_server;
    server_name _;
    root /var/www/game-shop/current;
    index index.html;

    # 注意：不要自起 types{} 块（替换语义会覆盖默认 MIME 表，html 会变 octet-stream 触发下载）。
    # .glb/.mjs 的类型补在主 /etc/nginx/mime.types（server-setup.sh 已处理；新版 nginx 自带）。

    gzip on;
    gzip_types text/css text/javascript application/javascript application/json model/gltf-binary;
    gzip_min_length 1k;

    location / {
        try_files $uri $uri/ =404;
    }

    # 入口与源码不缓存（发版即生效），大资产长缓存
    location ~* \.(html|js|mjs|css|json)$ {
        add_header Cache-Control "no-cache";
        try_files $uri =404;
    }
    location ~* \.(glb|png|jpg|jpeg|webp|ico)$ {
        add_header Cache-Control "public, max-age=86400";
        try_files $uri =404;
    }
}
NGINX

# GLB/ESM 类型补进主 mime.types（幂等；新版 nginx mime.types 已含 glb/mjs，grep 守卫）
grep -q "model/gltf-binary" /etc/nginx/mime.types \
  || sed -i "s|types {|types {\n    model/gltf-binary  glb;\n    text/javascript  js mjs;|" /etc/nginx/mime.types

nginx -t
systemctl enable nginx
systemctl reload nginx

# ---- 防火墙提示 ----
echo "==> nginx 已就绪。请确认阿里云安全组已放行 80 端口（443 如需 HTTPS）。"
echo "==> 如需 HTTPS：装 certbot 后执行 certbot --nginx -d <你的域名>"
echo "==> 初始化完成，回本地跑：bash tools/deploy/deploy.sh"
