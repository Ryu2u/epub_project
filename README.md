# 📚 EPUB Reader + 书籍库 Web App

一个基于 Web 的 EPUB 阅读器与个人书籍库管理系统，后端采用 FastAPI，前端使用 React + TypeScript 构建，追求 iOS Books 般的阅读体验。

> 设计文档：[`docs/superpowers/specs/2026-07-12-epub-reader-webapp-design.md`](docs/superpowers/specs/2026-07-12-epub-reader-webapp-design.md)

---

## ✨ 功能特性

- **📖 书籍库管理** — 上传、浏览、搜索、删除 EPUB 文件
- **📑 EPUB 3 解析** — 完整的 EPUB 3 元数据提取（标题、作者、封面、目录等）
- **🖊️ 在线阅读** — 章节级阅读器，支持阅读进度自动保存与恢复
- **⚙️ 阅读偏好** — 字体大小、主题、行间距等可自定义，实时生效
- **🔄 工具栏智能显隐** — 根据滚动方向自动显示/隐藏阅读工具栏（触屏 & 鼠标滚轮）
- **🖼️ 图片资源服务** — EPUB 内嵌图片经后端提取后按需加载
- **⚠️ 完善的错误处理** — DRM 检测、损坏文件识别、重复上传提示

---

## 🏗️ 技术栈

### 后端 (`backend/`)

| 层 | 技术 |
|---|------|
| 框架 | FastAPI + Uvicorn |
| ORM | SQLAlchemy 2.0 (async) |
| 数据库 | SQLite + aiosqlite |
| 迁移 | Alembic |
| EPUB 解析 | lxml |
| 配置 | pydantic-settings |

### 前端 (`web/`)

| 层 | 技术 |
|---|------|
| 框架 | React 18 + TypeScript |
| 构建 | Vite |
| 路由 | React Router v6 |
| 数据层 | TanStack Query (React Query) |
| 样式 | Tailwind CSS |
| 测试 | Vitest + Testing Library |

---

## 🚀 快速开始

### 环境要求

- Python ≥ 3.11
- Node.js ≥ 18
- pnpm（推荐）

### 后端启动

```bash
cd backend

# 安装依赖（含开发工具）
uv sync --extra dev

# 初始化数据库
alembic upgrade head

# 配置环境变量（可选）
cp .env.example .env

# 启动开发服务器
uv run uvicorn epub_backend.main:app --reload --port 8000
```

健康检查：`curl http://localhost:8000/api/health` → `{"status":"ok"}`

### 前端启动

```bash
cd web

# 安装依赖
pnpm install

# 启动开发服务器
pnpm dev
```

浏览器打开 [http://localhost:5173](http://localhost:5173)。`/api/*` 请求会通过 Vite proxy 转发到 `localhost:8000`。

---

## 🧪 测试

```bash
# 后端
cd backend && uv run pytest -v

# 前端
cd web && pnpm test
```

---

## ⚙️ 配置

后端通过 `EPUB_` 前缀的环境变量配置，支持 `.env` 文件（拷贝 `backend/.env.example` 为 `backend/.env`）：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `EPUB_STORAGE_DIR` | `./data/storage` | EPUB 文件存储目录 |
| `EPUB_DB_URL` | `sqlite+aiosqlite:///./data/library.db` | 数据库连接串 |
| `EPUB_MAX_UPLOAD_MB` | `100` | 最大上传文件大小 (MB) |
| `EPUB_CORS_ORIGINS` | `["http://localhost:5173"]` | CORS 允许的来源 |

---

## 📁 项目结构

```
epub_project/
├─ backend/                     FastAPI 后端
│  ├─ src/epub_backend/
│  │  ├─ api/                   REST 路由 & Pydantic schemas
│  │  ├─ db/                    SQLAlchemy models & Alembic 迁移
│  │  ├─ reader/                EPUB 3 解析引擎
│  │  │  ├─ container.py        │ 读取 META-INF/container.xml
│  │  │  ├─ opf.py              │ 解析 .opf 包描述文件
│  │  │  ├─ nav.py              │ 解析导航目录 (nav / NCX)
│  │  │  ├─ chapter.py          │ 提取章节 XHTML 内容
│  │  │  └─ epub_reader.py      │ 顶层 Reader，串联各层
│  │  ├─ services/              业务逻辑层 (BookService)
│  │  ├─ storage/               文件系统存储抽象
│  │  ├─ config.py              应用配置 (pydantic-settings)
│  │  └─ main.py                FastAPI app 工厂
│  └─ tests/                    pytest 测试套件
│     ├─ api/                   API 集成测试
│     ├─ reader/                EPUB 解析单元测试
│     ├─ services/              服务层测试
│     ├─ storage/               存储层测试
│     └─ fixtures/              测试用 EPUB fixture
├─ web/                         React + Vite 前端
│  └─ src/
│     ├─ api/                   fetch wrapper & 类型定义
│     ├─ hooks/                 自定义 hooks
│     │  ├─ useBooks.ts         │ 书籍 CRUD
│     │  ├─ useReaderProgress.ts│ 阅读进度持久化
│     │  └─ useReaderSettings.ts│ 阅读偏好管理
│     ├─ lib/                   工具库 (readerPrefs)
│     ├─ pages/                 页面组件
│     │  ├─ Library.tsx         │ 书籍库首页
│     │  ├─ Upload.tsx          │ 上传页
│     │  ├─ Detail.tsx          │ 书籍详情
│     │  └─ Reader.tsx          │ 在线阅读器
│     └─ components/            通用组件
│        ├─ BookCard.tsx        │ 书籍卡片
│        ├─ ReaderToolbar.tsx   │ 阅读工具栏
│        ├─ ReaderSettings.tsx  │ 阅读设置面板
│        ├─ ConfirmDialog.tsx   │ 确认对话框
│        └─ ErrorBanner.tsx     │ 错误提示
└─ docs/superpowers/specs/      设计文档
```

---

## 📡 API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/health` | 健康检查 |
| `POST` | `/api/books` | 上传 EPUB |
| `GET` | `/api/books` | 获取书籍列表 |
| `GET` | `/api/books/{id}` | 获取书籍详情 |
| `DELETE` | `/api/books/{id}` | 删除书籍 |
| `GET` | `/api/books/{id}/chapters/{chapterId}` | 获取章节内容 |
| `GET` | `/api/books/{id}/resources/{path}` | 获取 EPUB 内嵌资源 |

---

## 📄 License

MIT
