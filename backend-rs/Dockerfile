# syntax=docker/dockerfile:1
###############################################################################
# 后端（Rust / axum）Dockerfile —— 多阶段构建：builder 编译、runtime 只留产物
#
# 注意：
#  - sqlx::migrate!("./migrations") 在「编译期」把迁移内嵌进二进制，
#    所以运行时不需要 migrations 目录。
#  - embedded_fonts() 用编译期 env!("CARGO_MANIFEST_DIR") 推导字体目录，
#    本文件把 crate 放在 /app/backend-rs，因此运行时复制字体到
#    /app/web/public/fonts 即可让「导出 EPUB」携带 Maple Mono 字体。
#  - 首次构建要编译 axum/sqlx/aws-lc 等大量依赖，通常约 15~30 分钟，属正常。
###############################################################################

############################## 构建阶段 ##############################
FROM rust:1-bookworm AS builder

# aws-lc-rs / ring 等 C 依赖需要 clang、cmake、perl 等编译工具
RUN apt-get update && apt-get install -y --no-install-recommends \
        clang cmake perl pkg-config build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app/backend-rs

# 拷贝后端源码 + 迁移（target 已被 .dockerignore 排除，不进入镜像）
COPY backend-rs/ ./

# 构建发布版二进制
RUN cargo build --release --bin epub-backend-rs

############################## 运行阶段 ##############################
FROM debian:bookworm-slim AS runtime

# 运行时最小依赖：ca-certificates(TLS/COS) + libsqlite3(SQLite)
# （若 sqlx 使用 bundled SQLite，libsqlite3-0 也无害）
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates libsqlite3-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /app/backend-rs/target/release/epub-backend-rs /app/epub-backend-rs
# 导出 EPUB 用的 Maple Mono 字体（路径对应该 crate 编译期 CARGO_MANIFEST_DIR= /app/backend-rs）
COPY web/public/fonts /app/web/public/fonts

# 数据目录：默认配置用 ../data（相对 WORKDIR /app）→ /data，通过卷挂载持久化
VOLUME /data

EXPOSE 8002

# 由 docker-compose 传入环境变量（EPUB_PORT/COS 等），未设置则用代码默认值
CMD ["/app/epub-backend-rs"]
