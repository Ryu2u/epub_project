# syntax=docker/dockerfile:1
###############################################################################
# 前端（Vite / React）Dockerfile —— 构建静态产物后交给 nginx 托管，
# 并把 /api 反向代理到后端容器。
#
# 说明：前端所有 API 都走相对路径 /api（见 web/src/api/client.ts），
#       因此生产环境由 nginx 统一入口，无需设置 VITE_BACKEND_URL（那只影响 dev 代理）。
###############################################################################

############################## 构建阶段 ##############################
FROM node:20-alpine AS builder

# pnpm/npm 在 CI 模式下非交互执行，避免构建脚本批准等提示卡住 docker build
ENV CI=true

# 项目用 pnpm（lockfileVersion 9），启用 corepack 并固定 pnpm 9
RUN corepack enable && corepack prepare pnpm@9 --activate

WORKDIR /app

# 先装依赖（利用层缓存：package.json/lock 不变就不重装）
COPY web/package.json web/pnpm-lock.yaml web/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# 拷贝源码并构建 → 产出 /app/dist
COPY web/ .
RUN pnpm build

############################## 运行阶段 ##############################
FROM nginx:alpine AS runtime

# 静态产物放到 nginx 默认目录
COPY --from=builder /app/dist /usr/share/nginx/html
# 自定义站点配置（SPA 回退 + /api 反代到后端 + SSE 支持）
COPY web/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
