#!/usr/bin/env bash
# ==============================================================================
# JSONLens 一键 Docker 打包与部署脚本
# 仓库地址: https://github.com/suwenhy/json_resolve.git
# 默认端口: 9680 (可通过 -p <端口> 自定义)
# ==============================================================================

set -euo pipefail

# 默认配置（支持环境变量覆盖）
PORT="${PORT:-9680}"
BIND_ADDR="${BIND_ADDR:-0.0.0.0}"
CONTAINER_NAME="${CONTAINER_NAME:-jsonlens}"
IMAGE_NAME="${IMAGE_NAME:-jsonlens:latest}"
BASE_IMAGE="${BASE_IMAGE:-nginx:1.27-alpine}"
MIRROR_HOST="${MIRROR_HOST:-}"
REPO_URL="${REPO_URL:-https://github.com/suwenhy/json_resolve.git}"
INSTALL_DIR="${INSTALL_DIR:-/opt/json_resolve}"
AUTO_PULL_GIT=1
INSTALL_DOCKER_IF_MISSING=0
ACTION="deploy"

# 终端颜色输出
if [ -t 1 ]; then
  C_GREEN=$'\033[0;32m'
  C_CYAN=$'\033[0;36m'
  C_YELLOW=$'\033[1;33m'
  C_RED=$'\033[0;31m'
  C_BOLD=$'\033[1m'
  C_RESET=$'\033[0m'
else
  C_GREEN='' C_CYAN='' C_YELLOW='' C_RED='' C_BOLD='' C_RESET=''
fi

info()  { printf "${C_CYAN}[INFO]${C_RESET} %s\n" "$*"; }
ok()    { printf "${C_GREEN}[ OK ]${C_RESET} %s\n" "$*"; }
warn()  { printf "${C_YELLOW}[WARN]${C_RESET} %s\n" "$*"; }
err()   { printf "${C_RED}[ERR ]${C_RESET} %s\n" "$*" >&2; }

usage() {
  cat <<EOF
${C_BOLD}JSONLens 一键 Docker 打包与部署脚本${C_RESET}

用法:
  ./deploy.sh [命令] [选项]

命令:
  deploy      构建 Docker 镜像并启动/更新容器 (默认命令)
  status      查看当前容器运行状态与端口映射
  logs        实时查看容器访问与运行日志
  restart     重启容器
  stop        停止容器
  uninstall   停止并卸载 JSONLens 容器与镜像

选项:
  -p, --port <PORT>         宿主机监听端口 (默认: ${PORT})
  -b, --bind <IP>           宿主机绑定地址，如仅本机反代可设 127.0.0.1 (默认: 0.0.0.0)
  -n, --name <NAME>         容器名称 (默认: ${CONTAINER_NAME})
  -m, --mirror <REGISTRY>   指定 Docker 基础镜像加速域名 (如: docker.1ms.run)
      --base-image <IMAGE>  完整指定基础镜像 (默认: ${BASE_IMAGE})
      --no-pull             跳过 git pull 代码更新，直接用本地当前代码打包
      --install-docker      若服务器未安装 Docker，自动调用官方脚本安装
  -h, --help                显示本帮助说明

示例:
  ./deploy.sh                        # 使用默认端口 9680 一键打包并部署
  ./deploy.sh -p 18880               # 指定宿主机 18880 端口打包并部署
  ./deploy.sh -b 127.0.0.1 -p 9680   # 仅监听本机回环地址，配合宿主机 Nginx/Caddy 反代
  ./deploy.sh status                 # 查看容器运行状态
EOF
}

# 解析参数
while [ $# -gt 0 ]; do
  case "$1" in
    deploy|status|logs|restart|stop|uninstall)
      ACTION="$1"
      shift
      ;;
    -p|--port)
      PORT="${2:?缺少端口参数}"
      shift 2
      ;;
    -b|--bind)
      BIND_ADDR="${2:?缺少绑定地址参数}"
      shift 2
      ;;
    -n|--name)
      CONTAINER_NAME="${2:?缺少容器名称参数}"
      shift 2
      ;;
    -m|--mirror)
      MIRROR_HOST="${2:?缺少镜像源域名参数}"
      shift 2
      ;;
    --base-image)
      BASE_IMAGE="${2:?缺少基础镜像参数}"
      shift 2
      ;;
    --no-pull)
      AUTO_PULL_GIT=0
      shift
      ;;
    --install-docker)
      INSTALL_DOCKER_IF_MISSING=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      err "未知参数: $1"
      usage
      exit 1
      ;;
  esac
done

# 校验端口号合法性
if ! [[ "${PORT}" =~ ^[0-9]+$ ]] || [ "${PORT}" -lt 1 ] || [ "${PORT}" -gt 65535 ]; then
  err "无效的端口号: ${PORT} (范围需为 1-65535)"
  exit 1
fi

# 检测 Docker 与权限 (必要时自动挂载 sudo)
DOCKER_CMD=(docker)
ensure_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    if [ "${INSTALL_DOCKER_IF_MISSING}" -eq 1 ]; then
      info "未检测到 Docker，正在自动安装 Docker..."
      curl -fsSL https://get.docker.com | sh
      if command -v systemctl >/dev/null 2>&1; then
        sudo systemctl enable --now docker || true
      fi
    else
      err "当前服务器未安装 Docker。请先安装 Docker，或运行: ./deploy.sh --install-docker"
      exit 1
    fi
  fi

  if ! docker info >/dev/null 2>&1; then
    if command -v sudo >/dev/null 2>&1 && sudo -n docker info >/dev/null 2>&1; then
      DOCKER_CMD=(sudo docker)
    elif [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1; then
      info "当前用户无直接访问 Docker 守护进程权限，将通过 sudo 执行..."
      DOCKER_CMD=(sudo docker)
      "${DOCKER_CMD[@]}" info >/dev/null
    else
      err "Docker 守护进程未启动或无权限访问，请执行: systemctl start docker"
      exit 1
    fi
  fi
}

# 管理子命令处理
run_action() {
  ensure_docker
  case "${ACTION}" in
    status)
      if "${DOCKER_CMD[@]}" ps -a --format '{{.Names}}' | grep -Fxq "${CONTAINER_NAME}"; then
        "${DOCKER_CMD[@]}" ps -a --filter "name=^/${CONTAINER_NAME}$" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}\t{{.Image}}"
      else
        warn "容器 ${CONTAINER_NAME} 当前不存在。"
      fi
      exit 0
      ;;
    logs)
      exec "${DOCKER_CMD[@]}" logs -f --tail 100 "${CONTAINER_NAME}"
      ;;
    restart)
      "${DOCKER_CMD[@]}" restart "${CONTAINER_NAME}"
      ok "容器 ${CONTAINER_NAME} 已重启。"
      exit 0
      ;;
    stop)
      "${DOCKER_CMD[@]}" stop "${CONTAINER_NAME}"
      ok "容器 ${CONTAINER_NAME} 已停止。"
      exit 0
      ;;
    uninstall)
      info "正在停止并移除容器 ${CONTAINER_NAME}..."
      "${DOCKER_CMD[@]}" rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
      "${DOCKER_CMD[@]}" rmi "${IMAGE_NAME}" >/dev/null 2>&1 || true
      ok "JSONLens 容器与镜像已清理完毕。"
      exit 0
      ;;
  esac
}

if [ "${ACTION}" != "deploy" ]; then
  run_action
fi

ensure_docker

# 确定构建上下文目录（支持仓库内直接运行，也支持单脚本远程下载后自动拉取仓库）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-.}")" && pwd)"
if [ -f "${SCRIPT_DIR}/Dockerfile" ] && [ -f "${SCRIPT_DIR}/index.html" ]; then
  WORK_DIR="${SCRIPT_DIR}"
else
  info "当前目录未找到项目源码，准备同步仓库至 ${INSTALL_DIR}..."
  if ! command -v git >/dev/null 2>&1; then
    err "未检测到 git，请先安装 git (apt install -y git 或 yum install -y git)"
    exit 1
  fi
  if [ -d "${INSTALL_DIR}/.git" ]; then
    WORK_DIR="${INSTALL_DIR}"
  else
    git clone "${REPO_URL}" "${INSTALL_DIR}"
    WORK_DIR="${INSTALL_DIR}"
  fi
fi

cd "${WORK_DIR}"
info "项目工作目录: ${WORK_DIR}"

# 如果位于 git 仓库中且工作区干净，自动拉取最新提交
if [ "${AUTO_PULL_GIT}" -eq 1 ] && [ -d ".git" ] && command -v git >/dev/null 2>&1; then
  if [ -z "$(git status --porcelain 2>/dev/null || true)" ]; then
    info "正在检查并同步 GitHub 仓库最新代码..."
    git pull --ff-only || warn "git pull 未能快进更新，继续使用本地当前代码打包。"
  else
    info "检测到本地有未提交的修改，跳过 git pull，直接使用本地修改进行打包。"
  fi
fi

# 检查目标端口是否已被其他非本容器进程占用
check_port_conflict() {
  local existing_port=""
  if "${DOCKER_CMD[@]}" ps --format '{{.Names}}' | grep -Fxq "${CONTAINER_NAME}"; then
    existing_port="$("${DOCKER_CMD[@]}" port "${CONTAINER_NAME}" 80/tcp 2>/dev/null | awk -F: 'NR==1{print $NF}' || true)"
  fi

  # 若当前运行的同名容器已经占用该端口，升级替换时会先释放，不属于冲突
  if [ "${existing_port}" = "${PORT}" ]; then
    return 0
  fi

  local in_use=0
  if command -v ss >/dev/null 2>&1; then
    ss -tuln 2>/dev/null | awk '{print $5}' | grep -Eq "[:.]${PORT}$" && in_use=1 || true
  elif command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:"${PORT}" -sTCP:LISTEN -P -n >/dev/null 2>&1 && in_use=1 || true
  elif command -v netstat >/dev/null 2>&1; then
    netstat -tuln 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]${PORT}$" && in_use=1 || true
  fi

  if [ "${in_use}" -eq 1 ]; then
    err "端口 ${PORT} 已被服务器上的其他应用占用！"
    err "请通过 -p 指定其他空闲端口，例如: ./deploy.sh -p 9681"
    exit 1
  fi
}

check_port_conflict

# 解析并预拉取基础镜像（兼容国内云服务器 Docker Hub 连接受限场景）
resolve_base_image() {
  if [ -n "${MIRROR_HOST}" ]; then
    EFFECTIVE_BASE_IMAGE="${MIRROR_HOST%/}/library/${BASE_IMAGE#library/}"
    info "使用指定加速源基础镜像: ${EFFECTIVE_BASE_IMAGE}"
    "${DOCKER_CMD[@]}" pull "${EFFECTIVE_BASE_IMAGE}"
    return 0
  fi

  EFFECTIVE_BASE_IMAGE="${BASE_IMAGE}"
  if "${DOCKER_CMD[@]}" image inspect "${EFFECTIVE_BASE_IMAGE}" >/dev/null 2>&1; then
    info "本地已缓存基础镜像 ${EFFECTIVE_BASE_IMAGE}"
    return 0
  fi

  info "正在拉取基础镜像 ${EFFECTIVE_BASE_IMAGE}..."
  if "${DOCKER_CMD[@]}" pull "${EFFECTIVE_BASE_IMAGE}"; then
    return 0
  fi

  warn "默认 Docker Hub 拉取超时，正在自动尝试国内镜像加速节点..."
  local mirrors=(
    "docker.1ms.run"
    "docker.m.daocloud.io"
  )
  for m in "${mirrors[@]}"; do
    local candidate="${m}/library/${BASE_IMAGE#library/}"
    info "尝试镜像源: ${candidate}"
    if "${DOCKER_CMD[@]}" pull "${candidate}"; then
      EFFECTIVE_BASE_IMAGE="${candidate}"
      ok "成功通过加速节点拉取基础镜像: ${EFFECTIVE_BASE_IMAGE}"
      return 0
    fi
  done

  err "基础镜像拉取失败，请检查服务器网络或通过 ./deploy.sh -m <您的镜像加速域名> 指定可用源。"
  exit 1
}

EFFECTIVE_BASE_IMAGE="${BASE_IMAGE}"
resolve_base_image

# 记录旧镜像 ID，便于构建成功后仅清理被替换的旧悬空镜像（绝不影响服务器其他业务镜像）
OLD_IMAGE_ID="$("${DOCKER_CMD[@]}" images -q "${IMAGE_NAME}" 2>/dev/null || true)"

info "正在构建 Docker 镜像 ${IMAGE_NAME}..."
"${DOCKER_CMD[@]}" build \
  --build-arg BASE_IMAGE="${EFFECTIVE_BASE_IMAGE}" \
  -t "${IMAGE_NAME}" \
  .

NEW_IMAGE_ID="$("${DOCKER_CMD[@]}" images -q "${IMAGE_NAME}" 2>/dev/null || true)"

# 停止并移除旧容器
if "${DOCKER_CMD[@]}" ps -a --format '{{.Names}}' | grep -Fxq "${CONTAINER_NAME}"; then
  info "正在平滑替换旧容器 ${CONTAINER_NAME}..."
  "${DOCKER_CMD[@]}" rm -f "${CONTAINER_NAME}" >/dev/null
fi

# 启动新容器（自动重启 + 日志轮转防磁盘写满）
info "正在启动容器 ${CONTAINER_NAME} (映射 ${BIND_ADDR}:${PORT} -> 80)..."
"${DOCKER_CMD[@]}" run -d \
  --name "${CONTAINER_NAME}" \
  --restart unless-stopped \
  -p "${BIND_ADDR}:${PORT}:80" \
  --log-driver json-file \
  --log-opt max-size=10m \
  --log-opt max-file=3 \
  "${IMAGE_NAME}" >/dev/null

# 安全清理上一次被替换的旧镜像
if [ -n "${OLD_IMAGE_ID}" ] && [ "${OLD_IMAGE_ID}" != "${NEW_IMAGE_ID}" ]; then
  "${DOCKER_CMD[@]}" rmi "${OLD_IMAGE_ID}" >/dev/null 2>&1 || true
fi

# 启动健康校验
info "正在执行 HTTP 服务存活校验..."
HEALTH_OK=0
for _ in 1 2 3 4 5 6; do
  if command -v curl >/dev/null 2>&1; then
    if curl -fsS "http://127.0.0.1:${PORT}/" >/dev/null 2>&1; then
      HEALTH_OK=1
      break
    fi
  elif command -v wget >/dev/null 2>&1; then
    if wget -q -O /dev/null "http://127.0.0.1:${PORT}/" 2>/dev/null; then
      HEALTH_OK=1
      break
    fi
  else
    sleep 1
    if "${DOCKER_CMD[@]}" ps --format '{{.Names}}' | grep -Fxq "${CONTAINER_NAME}"; then
      HEALTH_OK=1
      break
    fi
  fi
  sleep 1
done

# 探测本机内网 IP 便于展示
SERVER_IP="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
[ -z "${SERVER_IP}" ] && SERVER_IP="您的服务器IP"

echo ""
if [ "${HEALTH_OK}" -eq 1 ]; then
  ok "=========================================================="
  ok " JSONLens Docker 部署成功！"
  ok "----------------------------------------------------------"
  ok " 容器名称 : ${CONTAINER_NAME}"
  ok " 镜像版本 : ${IMAGE_NAME}"
  if [ "${BIND_ADDR}" = "127.0.0.1" ]; then
    ok " 本机地址 : http://127.0.0.1:${PORT}"
  else
    ok " 访问地址 : http://${SERVER_IP}:${PORT}"
  fi
  ok "----------------------------------------------------------"
  ok " 常用运维命令:"
  ok "   查看状态 : ./deploy.sh status"
  ok "   查看日志 : ./deploy.sh logs"
  ok "   更新重装 : ./deploy.sh"
  ok "   更换端口 : ./deploy.sh -p 新端口"
  ok "=========================================================="
  if [ "${BIND_ADDR}" = "0.0.0.0" ]; then
    info "提示: 若外网无法访问，请确认云服务器安全组/防火墙已放行 TCP ${PORT} 端口，或使用 Nginx/宝塔反代 http://127.0.0.1:${PORT}"
  fi
else
  warn "容器已启动，但本地 HTTP 探针暂未返回成功，请运行 './deploy.sh logs' 查看详情。"
fi
