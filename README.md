# 📚 EPUB Reader + 书籍库 Web App

一个基于 Web 的 EPUB 阅读器与个人书籍库管理系统,后端采用 **Rust + axum**,前端使用 **React + TypeScript**,追求 iOS Books 般的阅读体验。支持 EPUB 和 TXT 两种来源格式。

> 总体设计文档:[`docs/superpowers/specs/2026-07-12-epub-reader-webapp-design.md`](docs/superpowers/specs/2026-07-12-epub-reader-webapp-design.md),后续功能迭代文档见 [📄 设计文档](#-设计文档)。

---

## ✨ 功能特性

- **📖 书籍库管理** — 上传、浏览、搜索、删除书籍;批量上传 + 单文件上传
- **📊 删除/导入/导出实时进度** — 三者均走异步任务 + SSE 进度流:删除大书按批删章节(进度条 + 阶段消息,告别无反馈转圈);导入全程字节进度 + 解析/入库阶段进度(TXT 解析按行增量回报);导出阶段进度 + 完成下载
- **📚 多格式支持**
  - **EPUB 3 解析** — 完整的元数据提取(标题、作者、封面、目录等),EPUB 2 NCX 目录回退,非严格 XHTML 容错
  - **TXT 自动切章** — 整本 TXT 小说(UTF-8)按章节标题自动切分,入库即可阅读。标题须**顶格**且为「第X卷/部/篇/章」或「X卷/部/篇/章」样式(X 支持阿拉伯与中文数词,如 `第一章`/`第12卷`/`第 3 章`),首个标题前的版权页等内容自动丢弃
- **📑 章节编辑器** — CodeMirror 源码 + 实时预览,支持在线编辑章节标题与 HTML 内容;编辑后的 HTML 落盘到存储目录
- **🖊️ 在线阅读器** — 章节级阅读,阅读进度自动保存与恢复(localStorage),内置目录面板
- **⚙️ 阅读偏好** — 字体大小、主题、行间距可自定义,实时生效
- **🔄 工具栏智能显隐** — 根据滚动方向自动显示/隐藏阅读工具栏(触屏 & 鼠标滚轮)
- **🖼️ 图片资源服务** — EPUB 内嵌图片经后端提取后按需加载,章节 HTML 中的图片与 CSS 引用自动重写
- **🔎 全文搜索** — SQLite FTS5 索引章节正文,章节内快速定位关键词(`<mark>` 高亮片段;查询词少于 2 个字符时返回空)
- **📤 导出（EPUB / TXT）** — EPUB:重新打包成标准 EPUB 3(导出 XHTML 严格符合 Sigil/EpubCheck);TXT:标题顶格、正文段首空两格的纯文本,与 TXT 导入的切章格式互为镜像
- **⚡ 虚拟化列表** — 章节列表与详情页目录使用 react-window 虚拟滚动,大书不卡顿
- **⚠️ 完善的错误处理** — DRM 检测、损坏文件识别、重复上传提示(按 SHA-256 去重)、编码错误提示

---

## 🗺️ 计划实现功能

- **📖 仿真分页阅读(分页模式)** — 与现有滚动阅读并存的"逐页翻页"阅读模式,模拟纸质书/微信读书式分页体验。
  - **分页原理**:页面 = 文本区间,不预切分文件。阅读时按"视口尺寸 - 边距"动态计算每页可容纳内容,维护 `Page(start, end)` 区间缓存;字号、行高、字体、屏幕尺寸变化时全部重新分页。
  - **核心难点**(已知坑,需先行验证):
    - 分页算法与渲染必须使用**完全一致的宽度**(内容区宽度、边距),否则正文绘制到可视区外、右侧露出残字
    - 中文排版需处理:两端对齐、首行缩进 2 字符、标题层级、标点压缩
    - 原书 EPUB `<style>` 会覆盖阅读器排版,需"净化排版"兜底
    - 图片跨页截断处理(`break-inside: avoid`)、懒分页(只分页当前章节 + 滑动窗口缓存)、跨页进度持久化
  - **候选实现**:CSS Multi-column(`column-width` = 视口内容宽 + `column-fill: auto`,每列一页,`translateX` 翻页)或逐字符测量排版(浏览器 `Range` API / canvas 测量)。
  - 曾实现过一版 CSS Multi-column 方案,因列宽测量与渲染宽度不一致导致右侧文字溢出等问题,已回滚;重构时优先保证"测量 = 渲染"同一宽度来源。

- **📚 更多计划中功能**
  - 阅读进度云同步(多设备)
  - 书架分组/标签管理
  - 阅读统计(时长、字数、连续阅读天数)

---

## 🏗️ 技术栈

### 后端 (`backend-rs/`)

| 层 | 技术 |
|---|------|
| 框架 | axum 0.7 + tower-http |
| 异步运行时 | tokio |
| 数据库 | SQLite via sqlx 0.8(WAL 模式 + 外键约束) |
| 迁移 | sqlx 内置 migrate 机制(`backend-rs/migrations/`) |
| EPUB 解析 | quick-xml + scraper(html5ever) |
| ZIP / 文件 | zip 2、sha2(SHA-256 去重)、tempfile(原子写) |
| 配置 | dotenvy + 环境变量(`EPUB_*` 前缀) |
| 错误处理 | thiserror + 自定义 AppError |

### 前端 (`web/`)

| 层 | 技术 |
|---|------|
| 框架 | React 18 + TypeScript |
| 构建 | Vite 5 |
| 路由 | React Router v6 |
| 数据层 | TanStack Query (React Query) |
| 编辑器 | CodeMirror 6(章节 HTML 源码编辑) |
| 虚拟列表 | react-window(章节列表 / 目录面板) |
| 样式 | Tailwind CSS |
| 测试 | Vitest + Testing Library |

---

## 🚀 快速开始

### 环境要求

- Rust ≥ 1.75
- Node.js ≥ 18(pnpm / npm 均可,仓库附带 `pnpm-lock.yaml`)

### 一键启动(Windows)

```bat
start.bat
```

`start.ps1` 会检测端口占用并分别启动两个进程:

| 进程 | 命令 | 地址 |
|------|------|------|
| 后端 | `cd backend-rs && cargo run` | http://localhost:8001 |
| 前端 | `cd web && pnpm dev`(代理 `/api` → 8001) | http://localhost:3000 |

### 手动启动后端

```bash
cd backend-rs

# 启动开发服务器(自动跑迁移;仓库自带 .env 已将端口设为 8001)
cargo run

# 监听 http://0.0.0.0:8001(默认绑定所有网卡,同一局域网可直接访问)
```

健康检查:`curl http://localhost:8001/api/health` → `{"status":"ok"}`

> **局域网访问(手机/平板)**:
> 前端 Vite 与后端都监听 `0.0.0.0`,同一 Wi-Fi 下的手机浏览器直接访问
> `http://<电脑局域网IP>:3000` 即可(用 `ipconfig` 查 IP,如 `192.168.1.5`)。
> 手机请求经 Vite 代理转发到后端,图片等资源为相对路径,无需额外配置。
> 若手机连不上,请检查 Windows 防火墙是否放行了 3000/8001 端口入站
> (管理员执行 `netsh advfirewall firewall add rule name="epub-reader" dir=in action=allow protocol=TCP localport=3000,8001`)。

> 第一次启动会在 `data/storage/` 和 `data/library.db` 创建存储目录与 SQLite 数据库。
> 章节 HTML 内容存于 `data/storage/chapters/{book_id}/{chapter_id}.html`(数据库只存纯文本)。

> **端口说明**:代码内置默认端口为 `8002`,但仓库自带 `backend-rs/.env` 将 `EPUB_PORT` 设为 `8001`,与前端 Vite 代理的默认目标一致。若自行修改端口,请同步通过 `web/.env` 设置 `VITE_BACKEND_URL`。

### 手动启动前端

```bash
cd web

# 安装依赖(仓库使用 pnpm workspace,也可用 npm)
pnpm install

# 启动开发服务器
pnpm dev
```

浏览器打开 [http://localhost:3000](http://localhost:3000)。`/api/*` 请求会通过 Vite proxy 转发到 `http://localhost:8001`(可通过 `web/.env` 的 `VITE_BACKEND_URL` 覆盖)。

---

## 🧪 测试

```bash
# 后端
cd backend-rs && cargo test

# 前端
cd web && pnpm test
```

后端覆盖 TXT 章节切分、XHTML 规范化、字数统计等核心算法;前端覆盖 Library / Detail / Reader 关键交互,以及章节行、目录面板、文件大小格式化等组件与工具函数测试。

---

## ⚙️ 配置

后端通过 `EPUB_` 前缀的环境变量配置(`backend-rs/.env` 已提供开箱即用的默认配置):

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `EPUB_STORAGE_DIR` | `../data/storage` | 书籍文件存储目录 |
| `EPUB_DATABASE_URL` / `EPUB_DB_URL` | `sqlite:../data/library.db` | 数据库连接串(sqlx 格式) |
| `EPUB_MAX_UPLOAD_MB` | `100` | 单文件最大上传大小(MB;另有 200 MB 硬性请求体上限) |
| `EPUB_BIND` | `0.0.0.0` | 监听地址(局域网访问默认所有网卡;可用 `127.0.0.1` 仅本机) |
| `EPUB_PORT` | `8002` | 监听端口(仅绑定指定地址;仓库 `.env` 设为 8001) |
| `EPUB_CORS_ORIGINS` | `[]`(允许所有) | 允许的跨域来源(JSON 数组,如 `["http://192.168.1.5:3000"]`);留空时允许所有来源 |
| `EPUB_COS_SECRET_ID` | — | 腾讯云 COS SecretId;与下面三项**全有**才启用 COS 资源存储 |
| `EPUB_COS_SECRET_KEY` | — | 腾讯云 COS SecretKey |
| `EPUB_COS_BUCKET` | — | 桶名(`{name}-{appid}` 格式,如 `ryu2u-1305537946`) |
| `EPUB_COS_REGION` | — | 桶所在地域(如 `ap-nanjing`) |
| `EPUB_COS_KEY_PREFIX` | `books/{book_id}/assets/{asset_id}` | COS 对象 Key 模板;`{book_id}` / `{asset_id}` 为占位符 |

### ☁️ 腾讯云 COS 资源存储(可选)

未配置 `EPUB_COS_*` 时,资源(封面、EPUB 内嵌图片)直接落本地 `data/storage/covers/` 与 `.epb` zip 内。

配置全部 4 个必需环境变量后:
- EPUB 入库时图片资源**同步**上传到 COS(`books/{book_id}/assets/{asset_id}`);本地不保留图片字节
- 前端 `GET /api/books/{id}/assets/{aid}` 返回 302 重定向到 **5 分钟有效**的预签名 URL(浏览器直接读 COS,不走后端流量)
- 用户上传封面、删除书 同步清理 COS 上的对象/prefix
- 导出 EPUB 时从 COS 下载资源字节打包

⚠️ 凭据请放在 `backend-rs/.env`(已被 git 忽略)或系统环境变量里,**不要硬编码到源码**。

---

## 📁 项目结构

```
epub_project/
├─ start.bat / start.ps1        Windows 一键启动脚本(后端 8001 + 前端 3000)
├─ backend-rs/                  Rust/axum 后端
│  ├─ migrations/               sqlx 迁移文件
│  │  ├─ 0001_initial.sql       books/chapters/assets 表
│  │  ├─ 0002_fts5.sql          FTS5 全文索引 + 触发器
│  │  └─ 0004_drop_chapters_html.sql   章节 HTML 迁出 DB → 存储目录
│  ├─ src/
│  │  ├─ main.rs                启动入口 + 路由挂载 + CORS
│  │  ├─ config.rs              环境变量配置(EPUB_*)
│  │  ├─ db.rs                  SqlitePool + ORM 模型
│  │  ├─ error.rs               统一 AppError → HTTP 响应
│  │  ├─ storage.rs             SHA-256 + 原子写
│  │  ├─ epub/                  解析层
│  │  │  ├─ mod.rs              SourceFormat 枚举 + parse_epub 入口
│  │  │  ├─ chapter.rs          章节 XHTML 解析 + 字数统计
│  │  │  ├─ container.rs        META-INF/container.xml
│  │  │  ├─ opf.rs              .opf 包描述
│  │  │  ├─ nav.rs              nav / NCX 目录
│  │  │  ├─ path.rs             资源路径解析
│  │  │  ├─ html_rewrite.rs     图片/CSS 引用重写
│  │  │  ├─ errors.rs           EpubError 类型
│  │  │  └─ txt.rs              TXT 章节切分(纯函数)
│  │  ├─ epub_writer.rs         DB → 标准 EPUB 3 字节
│  │  ├─ txt_writer.rs          DB → TXT(标题顶格/段首缩进)
│  │  ├─ service/               业务层
│  │  │  ├─ mod.rs              BookService struct
│  │  │  ├─ read.rs             读路径(列表/详情/章节/资源)
│  │  │  ├─ write.rs            写路径(上传/更新/重排/删除)
│  │  │  ├─ cover.rs            封面上传/删除
│  │  │  ├─ search.rs           FTS5 + LIKE 兜底搜索
│  │  │  └─ export.rs           导出服务(EPUB / TXT)
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
│     ├─ lib/                   工具库(readerPrefs、formatFileSize)
│     ├─ pages/                 页面组件
│     │  ├─ Library.tsx         书籍库首页(分页 + 搜索)
│     │  ├─ Upload.tsx          批量上传页(.epub/.epb/.txt)
│     │  ├─ Detail.tsx          书籍详情 + 虚拟化章节列表
│     │  ├─ ChapterEditor.tsx   章节 HTML 编辑器(CodeMirror 源码 + 预览)
│     │  └─ Reader.tsx          在线阅读器
│     ├─ components/            通用组件
│     │  ├─ BookCard.tsx
│     │  ├─ ChapterRow.tsx      章节列表行(详情页)
│     │  ├─ ReaderToolbar.tsx
│     │  ├─ ReaderTocPanel.tsx  阅读器目录面板
│     │  ├─ ReaderSettings.tsx
│     │  ├─ HtmlEditor.tsx      CodeMirror 封装
│     │  ├─ ExportDialog.tsx    导出对话框(EPUB / TXT 格式选择)
│     │  ├─ ConfirmDialog.tsx
│     │  └─ ErrorBanner.tsx
│     └─ test-setup.ts          Vitest + jsdom 测试初始化
└─ docs/superpowers/            设计文档与实施计划
   ├─ specs/                    设计文档
   └─ plans/                    实施计划
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
| `GET` | `/api/books/{id}/chapters/{chapterId}?format=text\|html` | 章节内容 |
| `PATCH` | `/api/books/{id}/chapters/{chapterId}` | 更新章节标题/HTML |
| `PATCH` | `/api/books/{id}/chapters/reorder` | 批量重排章节顺序 |
| `GET` | `/api/books/{id}/assets/{aid}` | 获取 EPUB 内嵌资源 |
| `POST` | `/api/books/{id}/cover` | 上传封面 |
| `DELETE` | `/api/books/{id}/cover` | 删除封面 |
| `GET` | `/api/books/{id}/export` | 导出（`?format=epub\|txt`，默认 epub） |
| `POST` | `/api/books/{id}/export/async` | 异步导出（`?format=epub\|txt`，SSE 进度 + 任务下载） |

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

## 📄 设计文档

- **总体设计** — [2026-07-12 EPUB Reader Web App](docs/superpowers/specs/2026-07-12-epub-reader-webapp-design.md)
- **EPUB 导出对话框** — [2026-08-02](docs/superpowers/specs/2026-08-02-export-dialog-design.md)
- **章节标题样式** — [2026-08-02](docs/superpowers/specs/2026-08-02-epub-chapter-heading-design.md)
- **搜索清空后显示全部** — [2026-08-07](docs/superpowers/specs/2026-08-07-search-clear-shows-all-design.md)
- **2 字符中文搜索 panic 修复** — [2026-08-08](docs/superpowers/specs/2026-08-08-search-2char-chinese-panic-fix-design.md)
- **阅读器目录面板** — [2026-08-09](docs/superpowers/specs/2026-08-09-reader-toc-panel-design.md)
- **详情页目录虚拟化** — [2026-08-13](docs/superpowers/specs/2026-08-13-detail-toc-virtualization-design.md)

---

## 📄 License

MIT
