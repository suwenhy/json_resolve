ARG BASE_IMAGE=nginx:1.27-alpine
FROM ${BASE_IMAGE}

LABEL maintainer="JSONLens"
LABEL description="Self-hosted zero-dependency modern JSON parser & visualizer workbench"

# 清理默认站点并注入优化后的 Nginx 配置
RUN rm -rf /usr/share/nginx/html/*
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf

# 仅复制前端运行所需的纯净静态文件（不含测试文件）
COPY index.html favicon.svg /usr/share/nginx/html/
COPY css /usr/share/nginx/html/css
COPY js /usr/share/nginx/html/js

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
