#!/usr/bin/env bash
# EPUB Library (Rust backend) —— WSL/Linux 启动脚本
# 用法: ./start.sh                (前后台检测,已在运行则跳过)
#       ./start.sh restart|-f     (强制重启:先杀旧进程再启动)

set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$ROOT/backend-rs"
WEB_DIR="$ROOT/web"
BACKEND_PORT=8002   # 后端默认端口(config.rs 默认 8002;start.ps1 里的 8001 是旧值)
FRONTEND_PORT=3000
LOG_DIR="$ROOT/logs"
mkdir -p "$LOG_DIR"

CARGO="$(command -v cargo || true)"
if command -v pnpm >/dev/null 2>&1; then
    PNPM_CMD=(pnpm)
elif command -v corepack >/dev/null 2>&1; then
    PNPM_CMD=(corepack pnpm)
else
    PNPM_CMD=()
fi

port_in_use() {
    # $1 = 端口号;返回 0 表示被占用
    if command -v ss >/dev/null 2>&1; then
        ss -ltn "sport = :$1" 2>/dev/null | grep -q LISTEN
    elif command -v netstat >/dev/null 2>&1; then
        netstat -ltn 2>/dev/null | awk '{print $4}' | grep -q ":$1$"
    else
        (exec 3<>/dev/tcp/127.0.0.1/"$1") 2>/dev/null && exec 3>&- 3<&- && return 0
        return 1
    fi
}

kill_port() {
    # 杀掉占用 $1 端口的进程
    local pids
    pids="$(ss -ltnp "sport = :$1" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | sort -u)"
    [ -z "$pids" ] && pids="$(fuser "$1"/tcp 2>/dev/null | tr -s ' ')"
    if [ -n "$pids" ]; then
        echo "Killing processes on port $1: $pids"
        # shellcheck disable=SC2086
        kill $pids 2>/dev/null
        sleep 1
        # shellcheck disable=SC2086
        kill -9 $pids 2>/dev/null || true
    fi
}

# ---- 强制重启模式 ----
ARG="${1:-}"
if [ "$ARG" = "-f" ] || [ "$ARG" = "--force" ] || [ "$ARG" = "restart" ]; then
    echo "== Force restart =="
    kill_port "$BACKEND_PORT"
    kill_port "$FRONTEND_PORT"
elif [ -n "$ARG" ] && [ "$ARG" != "start" ]; then
    echo "提示: 未识别的参数 '$ARG'(可用: restart / -f),按默认模式运行(已在运行则跳过)" >&2
fi

# ---- 依赖检查 ----
if [ -z "$CARGO" ]; then
    echo "错误: 未找到 cargo,请先安装 Rust (https://rustup.rs)" >&2
    exit 1
fi
if [ "${#PNPM_CMD[@]}" -eq 0 ]; then
    echo "错误: 未找到 pnpm 或 corepack,请先: npm install -g pnpm 或 corepack enable" >&2
    exit 1
fi

echo "=============================="
echo "  EPUB Library (Rust backend)"
echo "=============================="

# ---- 后端 ----
if port_in_use "$BACKEND_PORT"; then
    echo "Backend already running on :$BACKEND_PORT, skipping."
else
    echo "Starting Rust backend (axum :$BACKEND_PORT)..."
    (
        cd "$BACKEND_DIR" || exit 1
        # nohup + 日志文件;cargo run 首次会编译,可能较慢
        nohup "$CARGO" run --bin epub-backend-rs >"$LOG_DIR/backend.log" 2>&1 &
        echo $! >"$LOG_DIR/backend.pid"
    )
fi

# ---- 前端 ----
if port_in_use "$FRONTEND_PORT"; then
    echo "Frontend already running on :$FRONTEND_PORT, skipping."
else
    echo "Starting frontend (vite :$FRONTEND_PORT, proxy to :$BACKEND_PORT)..."
    (
        cd "$WEB_DIR" || exit 1
        export VITE_BACKEND_URL="http://localhost:$BACKEND_PORT"
        nohup "${PNPM_CMD[@]}" dev >"$LOG_DIR/frontend.log" 2>&1 &
        echo $! >"$LOG_DIR/frontend.pid"
    )
fi

echo ""
echo "Backend:  http://localhost:$BACKEND_PORT"
echo "Frontend: http://localhost:$FRONTEND_PORT"
echo "Logs:     $LOG_DIR/{backend,frontend}.log"
echo ""
