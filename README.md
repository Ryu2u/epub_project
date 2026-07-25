# 📚 EPUB Reader + 书籍库 Web App

一个基于 Web 的 EPUB 阅读器与个人书籍库管理系统,后端采用 **Rust + axum**,前端使用 **React + TypeScript**,追求 iOS Books 般的阅读体验。支持 EPUB 和 TXT 两种来源格式。

> 设计文档:[`docs/superpowers/specs/2026-07-12-epub-reader-webapp-design.md`](docs/superpowers/specs/2026-07-12-epub-reader-webapp-design.md)

---

## ✨ 功能特性

- **📖 书籍库管理** — 上传、浏览、搜索、删除书籍;批量上传 + 单文件上传
- **📚 多格式支持**
  - **EPUB 3 解析** — 完整的元数据提取(标题、作者、封面、目录等),EPUB 2 NCX 目录回退,非严格 XHTML 容错
  - **TXT 自动切章** — 整本 TXT 小说按章节标题自动切分,入库即可阅读
- **📑 章节编辑器** — 源码 + 实时预览,支持在线编辑章节标题与 HTML 内容
- **🖊️ 在线阅读器** — 章节级阅读,支持阅读进度自动保存与恢复
- **⚙️ 阅读偏好** — 字体大小、主题、行间距可自定义,实时生效
- **🔄 工具栏智能显隐** — 根据滚动方向自动显示/隐藏阅读工具栏(触屏 & 鼠标滚轮)
- **🖼️ 图片资源服务** — EPUB 内嵌图片经后端提取后按需加载
- **🔎 全文搜索** — SQLite FTS5 索引章节正文,章节内快速定位关键词
- **📤 EPUB 导出** — 把数据库里的书重新打包成标准 EPUB 3(导出 XHTML 严格符合 Sigil/EpubCheck)
- **⚠️ 完善的错误处理** — DRM 检测、损坏文件识别、重复上传提示、编码错误提示

---

## 🏗️ 技术栈

### 后端 (`backend-rs/`)

| 层 | 技术 |
|---|------|
| 框架 | axum 0.7 + tower-http |
| 异步运行时 | tokio |
| 数据库 | SQLite via sqlx 0.8(WAL 模式 + 外键约束) |
| 迁移 | sqlx-cli 内置 migrate 机制 |
| EPUB 解析 | quick-xml + scraper(html5ever) |
| 配置 | dotenvy + 环境变量 |
| 错误处理 | thiserror + 自定义 AppError |

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

- Rust ≥ 1.75
- Node.js ≥ 18
- pnpm / npm

### 后端启动

```bash
cd backend-rs

# 启动开发服务器(自动跑迁移)
cargo run

# 默认监听 http://localhost:8002
```

健康检查:`curl http://localhost:8002/api/health` → `{"status":"ok"}`

> 第一次启动会在 `data/storage/` 和 `data/library.db` 创建存储目录与 SQLite 数据库。

### 前端启动

```bash
cd web

# 安装依赖
npm install

# 启动开发服务器
npm run dev
```

浏览器打开 [http://localhost:5173](http://localhost:5173)。`/api/*` 请求会通过 Vite proxy 转发到 `localhost:8002`(可通过 `web/.env` 的 `VITE_BACKEND_URL` 覆盖)。

---

## 🧪 测试

```bash
# 后端
cd backend-rs && cargo test

# 前端
cd web && npm test
```

后端覆盖 TXT 章节切分、XHTML 规范化、字数统计等核心算法;前端覆盖 Library/Detail/Reader 关键交互。

---

## ⚙️ 配置

后端通过 `EPUB_` 前缀的环境变量配置(`backend-rs/.env` 可选):

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `EPUB_STORAGE_DIR` | `../data/storage` | 书籍文件存储目录 |
| `EPUB_DATABASE_URL` / `EPUB_DB_URL` | `sqlite:../data/library.db` | 数据库连接串(sqlx 格式) |
| `EPUB_MAX_UPLOAD_MB` | `100` | 单文件最大上传大小(MB) |
| `EPUB_PORT` | `8002` | 监听端口 |
| `EPUB_CORS_ORIGINS` | `["http://localhost:5173"]` | CORS 允许的来源(JSON 数组) |

---

## 📁 项目结构

```
epub_project/
├─ backend-rs/                  Rust/axum 后端
│  ├─ migrations/               sqlx 迁移文件
│  │  ├─ 0001_initial.sql       books/chapters/assets 表
│  │  └─ 0002_fts5.sql          FTS5 全文索引 + 触发器
│  ├─ src/
│  │  ├─ main.rs                启动入口 + 路由挂载
│  │  ├─ config.rs              环境变量配置
│  │  ├─ db.rs                  SqlitePool + ORM 模型
│  │  ├─ error.rs               统一 AppError → HTTP 响应
│  │  ├─ storage.rs             SHA-256 + 原子写
│  │  ├─ epub/                  解析层
│  │  │  ├─ mod.rs              SourceFormat 枚举 + parse_epub 入口
│  │  │  ├─ chapter.rs          章节 XHTML 解析 + 字数统计
│  │  │  ├─ container.rs        META-INF/container.xml
│  │  │  ├─ opf.py  → opf.rs    .opf 包描述
│  │  │  ├─ nav.rs              nav / NCX 目录
│  │  │  ├─ path.rs             资源路径解析
│  │  │  ├─ html_rewrite.rs     图片引用重写
│  │  │  ├─ errors.rs           EpubError 类型
│  │  │  └─ txt.rs              TXT 章节切分(纯函数)
│  │  ├─ epub_writer.rs         DB → 标准 EPUB 3 字节
│  │  ├─ service/               业务层
│  │  │  ├─ mod.rs              BookService struct
│  │  │  ├─ read.rs             读路径(列表/详情/章节/资源)
│  │  │  ├─ write.rs            写路径(上传/更新/重排/删除)
│  │  │  ├─ cover.rs            封面上传/删除
│  │  │  ├─ search.rs           FTS5 + LIKE 兜底搜索
│  │  │  └─ export.rs           EPUB 导出服务
│  │  └─ api/
│  │     ├─ mod.rs              Router 入口
│  │     ├─ schema.rs           请求/响应 schema
│  │     └─ books/
│  │        ├─ mod.rs           路由注册 + 公共辅助
│  │        ├─ read.rs          GET handler
│  │        └─ write.rs         POST/PATCH/DELETE handler
│  └─ Cargo.toml
├─ web/                         React + Vite 前端
│  └─ src/
│     ├─ App.tsx                路由表 + QueryClient
│     ├─ api/                   fetch wrapper & 类型定义
│     │  ├─ client.ts           apiGet/Upload/Patch/Delete
│     │  └─ types.ts            与后端 schema 镜像的 TS 类型
│     ├─ hooks/                 自定义 hooks
│     │  ├─ useBooks.ts         书籍 CRUD + 批量上传
│     │  ├─ useReaderProgress.ts│ 阅读进度持久化
│     │  └─ useReaderSettings.ts│ 阅读偏好管理
│     ├─ lib/                   工具库(readerPrefs)
│     ├─ pages/                 页面组件
│     │  ├─ Library.tsx         书籍库首页(分页 + 搜索)
│     │  ├─ Upload.tsx          批量上传页(.epub/.epb/.txt)
│     │  ├─ Detail.tsx          书籍详情 + 章节编辑器入口
│     │  ├─ ChapterEditor.tsx   章节 HTML 编辑器(源码 + 预览)
│     │  └─ Reader.tsx          在线阅读器
│     ├─ components/            通用组件
│     │  ├─ BookCard.tsx
│     │  ├─ ReaderToolbar.tsx
│     │  ├─ ReaderSettings.tsx
│     │  ├─ HtmlEditor.tsx
│     │  ├─ ConfirmDialog.tsx
│     │  └─ ErrorBanner.tsx
│     └─ test-setup.ts          Vitest + jsdom 测试初始化
└─ docs/superpowers/specs/      设计文档
```

---

## 📡 API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/health` | 健康检查 |
| `POST` | `/api/books` | 上传书籍(单文件,支持 .epub/.epb/.txt) |
| `POST` | `/api/books/batch` | 批量上传(支持混合格式) |
| `GET` | `/api/books?q=&page=&size=` | 书籍列表(分页 + 搜索) |
| `GET` | `/api/books/{id}` | 书籍详情 |
| `PATCH` | `/api/books/{id}` | 更新元数据(标题/作者/简介/...) |
| `DELETE` | `/api/books/{id}` | 删除书籍 |
| `GET` | `/api/books/{id}/search?q=&page=&size=` | 章节内全文搜索(FTS5) |
| `GET` | `/api/books/{id}/chapters/{chapterId}?format=text|html` | 章节内容 |
| `PATCH` | `/api/books/{id}/chapters/{chapterId}` | 更新章节标题/HTML |
| `PATCH` | `/api/books/{id}/chapters/reorder` | 批量重排章节顺序 |
| `GET` | `/api/books/{id}/assets/{aid}` | 获取 EPUB 内嵌资源 |
| `POST` | `/api/books/{id}/cover` | 上传封面 |
| `DELETE` | `/api/books/{id}/cover` | 删除封面 |
| `GET` | `/api/books/{id}/export` | 导出为标准 EPUB 3 |

### 错误响应

所有错误统一为 `{"error": {"code": "...", "message": "..."}}`:

| code | HTTP | 触发场景 |
|------|------|----------|
| `DUPLICATE_FILE` | 409 | 同 SHA-256 已存在 |
| `UNSUPPORTED_MEDIA` | 415 | 扩展名不支持 |
| `INVALID_CONTAINER` / `INCOMPLETE_METADATA` / `DRM_DETECTED` / `CORRUPT_EPUB` | 422 | EPUB 解析失败 |
| `TXT_EMPTY` / `TXT_ENCODING` / `TXT_NO_CHAPTERS` | 422 | TXT 解析失败 |
| `NOT_FOUND` | 404 | 书/章节/资源不存在 |
| `BAD_REQUEST` | 400 | 空 body / multipart 错误 |
| `INTERNAL` | 500 | 其他内部错误 |

---

## 📄 License

MIT