# EPUB Reader + 书籍库 Web App

EPUB 3 解析 + 书籍库管理的本地 Web 应用。

> 设计文档：[`docs/superpowers/specs/2026-07-12-epub-reader-webapp-design.md`](docs/superpowers/specs/2026-07-12-epub-reader-webapp-design.md)

**MVP 已完成**：自实现 EPUB 3 Reader + FastAPI 后端（42 测试）+ React 库管理 UI（3 测试 + 5 端到端冒烟用例）。

## 当前范围（MVP）

✅ 已覆盖：EPUB 3 解析（自实现 Reader）、FastAPI 后端、React 库管理 UI、本地磁盘 + SQLite 存储、基本结构校验。

⏳ 不在本 MVP（后续独立 spec）：EPUB 写作/生成、阅读器、用户系统、EpubCheck 严格校验、EPUB 2 完整兼容。

## 启动

### 后端

```bash
cd backend
uv sync --extra dev
uv run uvicorn epub_backend.main:app --reload --port 8000
```

健康检查：`curl http://localhost:8000/api/health` → `{"status":"ok"}`

### 前端

```bash
cd web
pnpm install
pnpm dev
```

浏览器打开 [http://localhost:5173](http://localhost:5173)。`/api/*` 请求会通过 Vite proxy 转发到 `localhost:8000`。

## 配置

后端环境变量（拷贝 `backend/.env.example` 为 `backend/.env` 后修改）：

| 变量 | 默认 | 含义 |
|---|---|---|
| `EPUB_STORAGE_DIR` | `./data/storage` | `.epb` 存放目录 |
| `EPUB_DB_URL` | `sqlite+aiosqlite:///./data/library.db` | 数据库连接 |
| `EPUB_MAX_UPLOAD_MB` | `100` | 单文件上传上限（MB） |
| `EPUB_CORS_ORIGINS` | `["http://localhost:5173"]` | 开发期允许跨域的前端源 |

## 项目结构

```
epub_project/
├─ backend/                  FastAPI 后端
│  ├─ src/epub_backend/
│  │  ├─ main.py             app 入口
│  │  ├─ config.py           pydantic-settings
│  │  ├─ reader/             EPUB 3 自实现 Reader
│  │  ├─ storage/            filesystem 工具
│  │  ├─ db/                 SQLAlchemy + Alembic
│  │  ├─ services/           业务层（BookService）
│  │  └─ api/                路由 + Pydantic
│  └─ tests/                 pytest
├─ web/                      React + Vite 前端
│  └─ src/
│     ├─ api/                fetch wrapper + types
│     ├─ hooks/              TanStack Query 封装
│     ├─ pages/              Library / Upload / Detail
│     └─ components/         BookCard / ErrorBanner / ConfirmDialog
└─ docs/superpowers/specs/   设计文档
```

## 测试

```bash
# 后端
cd backend && uv run pytest -v

# 前端
cd web && pnpm test
```