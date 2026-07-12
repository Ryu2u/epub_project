# EPUB Reader + 书籍库 Web App — 设计文档

**日期**: 2026-07-12
**作者**: brainstorming 会话
**状态**: 待用户复核

---

## Context（背景）

`C:\project\epub_project` 当前是空目录，用户希望从零开始构建一个既能解析也能生成 EPUB 的项目。经过 brainstorming 澄清，**本 spec 仅覆盖"解析 + 书籍库 Web App"**；EPUB 生成、阅读器、用户系统等推迟到后续独立 spec。

**要解决的问题**：用户希望管理自己手头的 EPUB 文件——上传、入库、查看元数据、预览章节、做基本的库管理（列表、搜索、删除）。市面上现成工具要么太重（Calibre），要么写得太浅（只读 zip），需要一个可控、可学、代码量适中的自实现方案。

**预期结果**：一个本地可跑的全栈应用，后端是 FastAPI + 自实现 EPUB 3 Reader，前端是 React 库管理 UI；上传的 EPUB 解析后入库 SQLite，可列表/搜索/详情/删除。

---

## 范围（Scope）

### 在范围内

- EPUB 3.0 解析（容器、OPF、nav、章节 XHTML、内嵌资源）
- 上传 + 入库 + 列表 + 详情 + 章节预览 + 删除 + 搜索
- 后端 FastAPI + 前端 React（库管理 UI：Library / Upload / Detail）
- 本地磁盘 + SQLite 存储
- 基本结构校验（mimetype、container.xml、必填 metadata、DRM 检测）

### 不在范围内（明确排除）

- EPUB 写作/生成（下一轮 spec）
- 阅读器（前端只展示章节纯文本预览，不渲染 XHTML）
- 用户系统、登录、权限、多用户隔离
- EpubCheck 严格合规校验
- EPUB 2 完整兼容（只识别 `toc.ncx` 并出 warning）
- fixed-layout、多媒体、脚本、DRM 内容支持
- 云存储（S3）、PostgreSQL
- Docker 化生产部署（仅开发期启动脚本）
- 国际化 UI（中文）

---

## 架构

```
Browser (React + Vite + TanStack Query + Tailwind)
   │  REST/JSON
   ▼
FastAPI Backend
   ├─ API 层    : 路由 + Pydantic schema
   ├─ 服务层    : BookService（协调 reader/db/fs）
   ├─ 领域层    : EpubReader（纯函数式，给路径/字节，返回 Book）
   └─ 存储层    : filesystem + SQLite (SQLAlchemy + aiosqlite)

物理存储:
  /storage/books/{uuid}.epb            原始文件（扩展名 .epb 区分）
  (无持久化解压目录)                   reader 内部仅用 TemporaryDirectory，
                                       过程结束即清理；XHTML 进 SQLite
  ./data/library.db                    SQLite 元数据
```

### 职责切分（关键边界）

- **`EpubReader` 是纯函数**——不给它 DB、不给它 HTTP。给一个 `.epb` 路径/字节，返回 `Book` 数据对象。
- **`BookService` 有状态**——它协调 reader、DB、文件系统，处理事务、清理、错误映射。
- **前端不直连 SQLite**——只通过 REST API。
- **领域错误独立命名**（不泄露到 HTTP 层）——`BookService` 把 `InvalidContainerError` 映射到 `422 INVALID_CONTAINER`。

---

## 领域模型

```python
@dataclass
class Book:
    id: str                  # UUID
    title: str
    authors: list[str]
    language: str            # BCP-47
    publisher: str | None
    description: str | None
    pub_date: date | None
    identifier: str          # dc:identifier
    chapters: list[Chapter]
    assets: list[Asset]

@dataclass
class Chapter:
    id: str                  # manifest item id
    title: str
    order: int               # spine 顺序
    href: str
    text: str                # 纯文本预览
    html: str                # 原始 XHTML
    word_count: int

@dataclass
class Asset:
    id: str
    href: str
    media_type: str
    size: int
    is_cover: bool
```

`BookService` 把内存 `Book` 拆开存到 SQLite 三张表。

---

## EPUB 3 支持子集

### 支持

- EPUB 3.0 / OPF 2.0
- 容器：`mimetype` + `META-INF/container.xml` + `OEBPS/` 内容
- `content.opf`（metadata + manifest + spine）
- `nav.xhtml`（TOC + landmarks）
- 章节 XHTML（`lxml` 提取纯文本 + 保留 HTML）
- 内嵌图片、字体（识别 + 入库，不渲染）

### 不支持（解析时显式报错或忽略）

- EPUB 2 `toc.ncx` —— 识别并出 warning，不强制解析
- fixed-layout（`rendition:layout pre-paginated`）—— 忽略
- 多媒体叠加（SMIL） / `<script>` —— 警告 + 跳过
- DRM（`encryption.xml`）—— 显式拒绝入库
- 远程资源依赖 —— 入库前必须所有相对路径资源都在包内

---

## SQLite Schema

```sql
CREATE TABLE books (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    authors     TEXT NOT NULL,        -- JSON array
    language    TEXT NOT NULL,
    publisher   TEXT,
    description TEXT,
    pub_date    TEXT,                -- ISO date
    identifier  TEXT NOT NULL,
    file_path   TEXT NOT NULL,
    file_size   INTEGER NOT NULL,
    file_sha256 TEXT NOT NULL UNIQUE, -- 去重
    created_at  TEXT NOT NULL
);

CREATE TABLE chapters (
    id           TEXT NOT NULL,
    book_id      TEXT NOT NULL,
    title        TEXT NOT NULL,
    spine_order  INTEGER NOT NULL,
    href         TEXT NOT NULL,
    text         TEXT NOT NULL,
    html         TEXT NOT NULL,
    word_count   INTEGER NOT NULL,
    PRIMARY KEY (book_id, id),
    FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
);

CREATE TABLE assets (
    id          TEXT NOT NULL,
    book_id     TEXT NOT NULL,
    href        TEXT NOT NULL,
    media_type  TEXT NOT NULL,
    size        INTEGER NOT NULL,
    is_cover    INTEGER NOT NULL,    -- 0/1
    PRIMARY KEY (book_id, id),
    FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
);

CREATE INDEX idx_books_created ON books(created_at DESC);
CREATE INDEX idx_chapters_book ON chapters(book_id, spine_order);
```

**关键决策**：
- 不存解压后的章节文件——`text`/`html` 直接进 SQLite（按需取，不写盘）
- reader 解析过程内用 `TemporaryDirectory` 解压，过程结束即清理，不留任何中间目录
- sha256 去重 + UNIQUE 约束
- 删除级联

---

## EpubReader 工作流

```
Open(path)
  ├─ 验证 mimetype === "application/epub+zip"
  ├─ 解压到临时目录（TemporaryDirectory）
  ├─ 读 META-INF/container.xml → rootfile (OEBPS/content.opf)
  ├─ 解析 OPF:
  │    ├─ metadata: dc:title, dc:creator, dc:language, dc:identifier,
  │    │            dc:publisher, dc:description, dc:date
  │    ├─ manifest: item id, href, media-type, properties
  │    └─ spine: itemref idref 排序
  ├─ 找 nav.xhtml（manifest 中 properties="nav" 的项）
  │    └─ 提取 toc (h1/h2/ol) 用于章节 title 兜底
  ├─ 检测 encryption.xml → DRMError
  ├─ 按 spine 顺序遍历章节 XHTML:
  │    └─ lxml 解析 → text() 提取纯文本 + 保留 html 字符串
  └─ 遍历 manifest → Asset[]
       └─ properties="cover-image" 或 nav guide → is_cover=true
返回 Book
```

### 错误类型

| 错误 | 触发条件 | HTTP | code |
|---|---|---|---|
| `InvalidContainerError` | mimetype 错 / container.xml 缺 | 422 | `INVALID_CONTAINER` |
| `IncompleteMetadataError` | 缺 title/language/identifier | 422 | `INCOMPLETE_METADATA` |
| `DRMError` | 含 `META-INF/encryption.xml` | 422 | `DRM_DETECTED` |
| `CorruptEpubError` | ZIP 解压失败 | 422 | `CORRUPT_EPUB` |

错误对象包含原始文件名 + 解析阶段（"container_parse" / "opf_parse" / "chapter_parse"），便于前端展示。

---

## REST API

| 方法 | 路径 | 用途 | 入参 | 出参 |
|---|---|---|---|---|
| GET | `/api/books` | 列表（分页 + 搜索） | `?q=&page=&size=` | `{ items, total, page, size }` |
| POST | `/api/books` | 上传入库 | `multipart: file` | `{ book, warnings }` |
| GET | `/api/books/{id}` | 详情 + 章节列表 + 资源 | — | `{ book, chapters, assets }` |
| GET | `/api/books/{id}/chapters/{cid}` | 单章节内容 | `?format=text\|html` | `{ title, content }` |
| GET | `/api/books/{id}/assets/{aid}` | 取资源字节 | — | 二进制 + Content-Type |
| DELETE | `/api/books/{id}` | 删书（级联） | — | `204` |
| GET | `/api/health` | 健康检查 | — | `{ status: "ok" }` |

### Pydantic Schemas（前端 TS 镜像）

```python
class ChapterOut(BaseModel):
    id: str
    title: str
    spine_order: int
    word_count: int

class AssetOut(BaseModel):
    id: str
    href: str
    media_type: str
    size: int
    is_cover: bool

class BookSummary(BaseModel):
    id: str
    title: str
    authors: list[str]
    language: str
    chapter_count: int
    asset_count: int
    file_size: int
    has_cover: bool
    created_at: datetime

class BookDetail(BookSummary):
    publisher: str | None
    description: str | None
    pub_date: date | None
    identifier: str
    chapters: list[ChapterOut]
    assets: list[AssetOut]

class UploadResult(BaseModel):
    book: BookDetail
    warnings: list[str]
```

### 错误响应统一格式

```json
{ "error": { "code": "INVALID_CONTAINER", "message": "...", "phase": "container_parse" } }
```

### 完整错误码表

| HTTP | code | 场景 |
|---|---|---|
| 413 | `FILE_TOO_LARGE` | 文件 > 100MB |
| 415 | `UNSUPPORTED_MEDIA` | 扩展名非 .epub/.epb |
| 422 | `INVALID_CONTAINER` | mimetype/container 错 |
| 422 | `INCOMPLETE_METADATA` | 缺必填 metadata |
| 422 | `DRM_DETECTED` | 含 encryption.xml |
| 422 | `CORRUPT_EPUB` | ZIP 损坏 |
| 404 | `NOT_FOUND` | 书/章节/资源不存在 |
| 409 | `DUPLICATE_FILE` | sha256 已存在（响应里带已有 book） |
| 500 | `INTERNAL_ERROR` | DB/IO 异常 |

---

## 前端

### 技术栈

- React 18 + TypeScript + Vite + TailwindCSS
- React Router 6（路由）
- TanStack Query（数据获取 / 缓存 / 错误状态）

### 路由 / 页面

| 路由 | 页面 | 内容 |
|---|---|---|
| `/` | Library | 卡片网格 + 搜索框 + 上传按钮 |
| `/upload` | Upload | 拖拽 + 进度 + 错误展示 |
| `/books/:id` | Detail | 左元数据 / 右章节列表（点击展开纯文本预览）/ 资源 tab / 删除 |

### 代码组织

```
web/src/
  api/             # fetch wrapper 或 generated client
  pages/           # Library, Upload, Detail
  components/      # BookCard, ErrorBanner, ConfirmDialog
  hooks/           # useBooks, useUpload (TanStack Query 封装)
```

---

## 项目结构

```
epub_project/
├─ backend/
│  ├─ pyproject.toml                 # uv 管理
│  ├─ src/epub_backend/
│  │  ├─ main.py                     # FastAPI app
│  │  ├─ config.py                   # pydantic-settings
│  │  ├─ api/
│  │  │  ├─ books.py
│  │  │  └─ schemas.py
│  │  ├─ services/
│  │  │  └─ book_service.py
│  │  ├─ reader/
│  │  │  ├─ epub_reader.py
│  │  │  ├─ container.py
│  │  │  ├─ opf.py
│  │  │  ├─ nav.py
│  │  │  ├─ chapter.py
│  │  │  └─ errors.py
│  │  ├─ db/
│  │  │  ├─ models.py
│  │  │  ├─ session.py
│  │  │  └─ migrations/              # Alembic
│  │  └─ storage/
│  │     └─ filesystem.py
│  ├─ tests/
│  │  ├─ fixtures/epubs/             # 真实样例
│  │  ├─ reader/
│  │  ├─ services/
│  │  └─ api/
│  └─ data/                          # .gitignore
│
├─ web/
│  ├─ package.json
│  ├─ vite.config.ts
│  ├─ src/
│  └─ tests/
│
├─ docs/superpowers/specs/           # 本文件
├─ .gitignore
├─ README.md
└─ docker-compose.yml                # 可选（开发期）
```

---

## 关键依赖

### 后端

- `fastapi[standard]`
- `uvicorn[standard]`
- `pydantic`, `pydantic-settings`
- `sqlalchemy[asyncio]`, `aiosqlite`
- `alembic`
- `lxml`
- `python-multipart`
- 开发：`pytest`, `pytest-asyncio`, `httpx`, `ruff`

**明确不引入**：`ebooklib`、BeautifulSoup、任何 ORM 之外的查询构建器。

### 前端

- `react`, `react-dom`, `react-router-dom`
- `@tanstack/react-query`
- `tailwindcss`
- 开发：`vite`, `typescript`, `vitest`, `@testing-library/react`

---

## 配置

| 环境变量 | 默认 | 含义 |
|---|---|---|
| `EPUB_STORAGE_DIR` | `./data/storage` | `.epb` 存放 |
| `EPUB_DB_URL` | `sqlite+aiosqlite:///./data/library.db` | DB 连接 |
| `EPUB_MAX_UPLOAD_MB` | `100` | 单文件上限 |
| `EPUB_CORS_ORIGINS` | `http://localhost:5173` | 开发期 |

---

## 启动方式（开发期）

```bash
# 终端 1
cd backend && uv run uvicorn epub_backend.main:app --reload --port 8000

# 终端 2
cd web && pnpm install && pnpm dev
# 浏览器访问 http://localhost:5173
```

Vite 配置 `/api` 代理到 `8000`，绕过 CORS。

---

## 测试策略

| 层 | 工具 | 覆盖 |
|---|---|---|
| Reader | pytest | 5 个 fixture EPUB：合规 / 缺 metadata / 坏 ZIP / EPUB 2 混合 / DRM |
| Service | pytest + tmpfs | DB 写、级联删、sha256 去重、临时目录清理 |
| API | pytest + httpx AsyncClient | 路由、错误码、schema |
| 前端 | Vitest + Testing Library | 关键交互：上传、删除、搜索 |

**为什么用真实 EPUB fixture**：EPUB 解析的真坑（命名空间、缺文件、奇怪编码）只有真实数据能验。

---

## 验证（端到端）

```bash
# 1. 后端测试
cd backend && uv run pytest -v

# 2. 后端手测（curl）
uv run uvicorn epub_backend.main:app --reload
# 上传 → 列详情 → 删

# 3. 前端
cd web && pnpm build && pnpm dev
# 浏览器三页签走通

# 4. 端到端冒烟用例
```

### 冒烟用例（最小可发布）

1. 上传合法 EPUB 3 → 列表出现 → 详情可见 → 删除成功
2. 上传损坏 ZIP → `422 CORRUPT_EPUB` + 文件不上磁盘
3. 同一文件再上传 → `409 DUPLICATE_FILE` + 返回已有 book
4. 上传 >100MB 文件 → `413 FILE_TOO_LARGE`
5. 上传 DRM EPUB → `422 DRM_DETECTED` + 文件不上磁盘

---

## 风险与未决项

- **EPUB 2 兼容性**：目前仅识别 `toc.ncx` 并出 warning；如果用户实际有大量 EPUB 2 库，需要在后续 spec 里加完整兼容。
- **大文件入库**：XHTML 直接进 SQLite，超过 ~50MB 的书会让 DB 变胖；后续可改为"XHTML 存盘 + DB 只存路径"。
- **XHTML 渲染安全**：章节预览只展示纯文本（`text`），不渲染 `html`；阅读器 spec 引入时再讨论 XSS 沙箱。
- **国际化**：MVP 中文 UI；扩展到多语言是后续 spec。

---

## 后续 Spec 候选（不在本轮）

按价值排序：

1. **EPUB 生成**（从 Markdown / JSON 输入打包 EPUB 3）—— 用户原始诉求之一
2. **章节 XHTML 阅读器**（在前端渲染 XHTML，含 XSS 沙箱）
3. **EPUB 2 完整兼容**（解析 toc.ncx 兜底 TOC）
4. **多用户 / 鉴权**
5. **云存储 / 生产部署**