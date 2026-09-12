# 📚 EPUB Reader + 书籍库 Web App

一个基于 Web 的 EPUB 阅读器与个人书籍库管理系统,后端采用 **Rust + axum**,前端使用 **React + TypeScript**,追求 iOS Books 般的阅读体验。支持 EPUB 和 TXT 两种来源格式。

> 总体设计文档:[`docs/superpowers/specs/2026-07-12-epub-reader-webapp-design.md`](docs/superpowers/specs/2026-07-12-epub-reader-webapp-design.md),后续功能迭代文档见 [📄 设计文档](#-设计文档)。

---

## ✨ 功能特性

- **📖 书籍库管理** — 上传、浏览、搜索、删除书籍;批量上传 + 单文件上传
- **📱 移动端主页 + 书库** — 参考阅读 App 主页:之前读过 / 阅读目标(半圆进度环 + 周历 + 连续阅读 + 继续阅读)/ 今年读过的图书;书库为封面网格(进度百分比 + 新增徽标 + 排序 + 卡片菜单);浅色蓝调 + 深色金调**可切换主题**;阅读时长与连续天数自动统计并持久化(localStorage)
- **📊 删除/导入/导出实时进度** — 三者均走异步任务 + SSE 进度流:删除大书按批删章节(进度条 + 阶段消息,告别无反馈转圈);导入全程字节进度 + 解析/入库阶段进度(TXT 解析按行增量回报);导出阶段进度 + 完成下载
- **📚 多格式支持**
  - **EPUB 3 解析** — 完整的元数据提取(标题、作者、封面、目录等),EPUB 2 NCX 目录回退,非严格 XHTML 容错
  - **TXT 自动切章** — 整本 TXT 小说按章节标题自动切分,入库即可阅读,**编码自动检测**(UTF-8 / GBK / GB18030 / Big5 / UTF-16,统一转为 UTF-8 入库)。标题须**顶格**且为「第X卷/部/篇/章」或「X卷/部/篇/章」样式(X 支持阿拉伯与中文数词,如 `第一章`/`第12卷`/`第 3 章`),首个标题前的版权页等内容自动丢弃
- **📑 章节编辑器** — CodeMirror 源码 + 实时预览,支持在线编辑章节标题与 HTML 内容;编辑后的 HTML 落盘到存储目录
- **🖊️ 在线阅读器** — 章节级阅读,阅读进度自动保存与恢复(localStorage),内置目录面板
- **📖 分页阅读模式(平滑翻页)** — 与滚动阅读并存的逐页翻页模式:layout-then-slice 分页引擎(离屏测量容器 + `Range.getClientRects` 行盒二分切页,「测量=渲染」同一宽度来源)、锚点进度持久化(字号/行距/窗口变化保位重排,翻回上一章落回离开时的页)、三种翻页效果(**平移**(左右轮播式滑动,默认)/覆盖(新页滑入盖住当前页)/无动画)、键盘翻页(←/→/PgUp/PgDn/Space/Home/End)、邻章预取跨章零等待。设置面板「阅读模式」切换,默认仍为滚动。设计文档见 [2026-09-09](docs/superpowers/specs/2026-09-09-paged-reader-flip-design.md)
- **⚙️ 阅读偏好** — 字体大小、主题、行间距、阅读模式(滚动/分页)、翻页效果可自定义,实时生效
- **🔄 工具栏智能显隐** — 根据滚动方向自动显示/隐藏阅读工具栏(触屏 & 鼠标滚轮)
- **🖼️ 图片资源服务** — EPUB 内嵌图片经后端提取后按需加载,章节 HTML 中的图片与 CSS 引用自动重写
- **🔎 全文搜索(按章节分组)** — SQLite FTS5 索引章节正文,结果**按章节分组**:章一行(显示本章命中数、折叠时给一条预览),展开看**每一次出现**的上下文(全书命中总数与命中章节数分开统计,按章节分页加载);点击某次出现**跳到阅读器命中处并高亮**(滚动/分页两种模式都支持;定位用「章内第 N 次 + 命中前上下文」消歧,不受纯文本与渲染 DOM 空白差异影响);查询词少于 2 个字符时返回空
- **📤 导出（EPUB / TXT）** — EPUB:重新打包成标准 EPUB 3(导出 XHTML 严格符合 Sigil/EpubCheck,段首缩进 `text-indent:2em` 内置);TXT:标题顶格、正文段首空两格的纯文本,与 TXT 导入的切章格式互为镜像;**桌面端走原生「另存为」**——选格式后弹保存对话框,导出完成由后端直接把文件写入指定路径(字节不经过前端),浏览器端仍是下载
- **⚡ 虚拟化列表** — 章节列表与详情页目录使用 react-window 虚拟滚动,大书不卡顿
- **⚠️ 完善的错误处理** — DRM 检测、损坏文件识别、重复上传提示(按 SHA-256 去重)、编码错误提示

---

## 🗺️ 计划实现功能

- **📖 分页阅读(分页模式)** — ✅ **已实现**(见上方功能特性)。设计文档:[2026-09-09 分页阅读设计](docs/superpowers/specs/2026-09-09-paged-reader-flip-design.md)。
  - 历史教训存档:曾实现过一版 CSS Multi-column 方案,因列宽测量与渲染宽度不一致导致右侧文字溢出,已回滚;现行方案为 layout-then-slice(`Range.getClientRects` 行盒测量 + DOM 切片),由构造保证「测量 = 渲染」同一宽度来源。
  - 翻页效果说明:曾按需求做过一版「仿真卷页」(curl),因动画期间内容交接闪烁、且与平滑平移体验重复,已**整体移除**(`FlipStyle` 现为 `slide` / `cover` / `none`,默认 `slide`);历史值 `curl` 会自动回落到默认效果。
  - 待打磨(Phase 3):超长章节 idle 分页的更细粒度让出、图片高于整页时的缩放策略。

- **📚 更多计划中功能**
  - 阅读进度云同步(多设备)
  - 书架分组/标签管理
  - 阅读统计(时长、字数、连续阅读天数)

---

## 🏗️ 技术栈

### 后端 / 业务库 (`src-tauri/src/`)

| 层 | 技术 |
|---|------|
| 框架 | Tauri 2(WebView2)+ `epubasset://` 自定义协议;业务库不再单独建 crate |
| 异步运行时 | tokio |
| 数据库 | SQLite via sqlx 0.8(WAL 模式 + 外键约束) |
| 迁移 | sqlx 内置 migrate 机制(`src-tauri/migrations/`) |
| EPUB 解析 | quick-xml + scraper(html5ever) |
| ZIP / 文件 | zip 2、sha2(SHA-256 去重)、tempfile(原子写) |
| 配置 | dotenvy + 环境变量(`EPUB_*` 前缀) |
| 错误处理 | thiserror + 自定义 AppError |

### 前端 (`src/`,仓库根目录)

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

### 桌面客户端 (`src-tauri/`)

Tauri 2 桌面应用,业务库(service / EPUB 解析 / 进度任务)内置于 `src-tauri/src/`,原 axum HTTP 层替换为:

| 原 HTTP 接口 | 桌面端实现 |
|---|---|
| `/api/books` 全部 CRUD 端点 | `#[tauri::command]`(`src-tauri/src/commands.rs`) |
| `GET /api/books/:id/assets/:aid` | `epubasset://` 自定义协议(COS/本地同源支持) |
| `GET /api/progress/:id`(SSE) | `get_progress` 命令 200ms 轮询 |
| 导出文件保存 | `save_export_file`(另存为后直接写盘;浏览器端保留 `get_export_filename` + `take_export_bytes`) |

**桌面端专属功能**:

- **书库迁移/备份** — 书库页「迁移」按钮:整库导出为 `.epublib`(书目 + 章节 + 源文件 + 封面),拷到另一台电脑导入即可合并(同 id/SHA 自动跳过,FTS 索引自动重建)
- **系统托盘** — 应用常驻托盘,左键切换显示/隐藏,右键菜单退出;点窗口 × 最小化到托盘
- **可缩至手机尺寸** — 窗口最小 340×480,<768px 自动切换手机布局

前端 `src/api/client.ts` 为**双模式**:检测 `__TAURI_INTERNALS__`,Tauri 里路由到 invoke,浏览器里走原 HTTP——页面/组件零改动,错误形状两端一致。

- 数据默认落 `AppData/com.ryu2u.epublibrary/`(storage/ + library.db),可用 `EPUB_STORAGE_DIR` / `EPUB_DATABASE_URL` 覆盖(如指向项目内 `./data`)
- COS 配置沿用 `EPUB_COS_*` 环境变量约定

---

## 🚀 快速开始

### 环境要求

- Rust ≥ 1.75
- Node.js ≥ 18(pnpm / npm 均可,仓库附带 `pnpm-lock.yaml`)
- 桌面客户端另需:WebView2(Windows 10/11 自带)、MSVC 构建工具链

### 桌面客户端(Tauri)开发与构建

```bash
# 开发模式(热更新:前端即时生效,Rust 改动自动重编译重启)
pnpm tauri dev

# 构建 exe(需要 MSVC;产出 src-tauri/target/release/epub-library-app.exe)
pnpm tauri build --no-bundle

# 构建 NSIS 安装包
pnpm tauri build
```

> 数据默认落 `AppData/com.ryu2u.epublibrary/`(storage/ + library.db)。
> 想复用旧的 `./data` 数据目录:设 `EPUB_DATABASE_URL` / `EPUB_STORAGE_DIR` 指过去再启动。

---

## 🧪 测试

```bash
# Rust 端(业务库 + 桌面客户端)
cd src-tauri && cargo test

# 前端
pnpm test                  # 仓库根目录
```

Rust 端覆盖 TXT 章节切分、XHTML 规范化、字数统计、全文搜索等核心算法;前端覆盖 Library / Detail / Reader 关键交互,以及章节行、目录面板、文件大小格式化等组件与工具函数测试。

---

## ⚙️ 配置

### .env 文件位置

复制 `src-tauri/.env.example` 为 `.env`,按以下顺序被加载(**先找到的先加载**,已存在的环境变量不被覆盖):

1. `EPUB_ENV_FILE` 环境变量显式指定的路径
2. **exe 同目录**的 `.env`(打包版双击启动时)
3. **工作目录**的 `.env`(开发模式 = `src-tauri/.env`)
4. `AppData/com.ryu2u.epublibrary/.env`

> **日常开发直接放 `src-tauri/.env`**;打包分发时把 `.env` 放在 exe 旁边即可。

### EPUB_* 环境变量

(桌面端默认数据落 `AppData/com.ryu2u.epublibrary/`):

| 变量 | 默认值(桌面端) | 说明 |
|------|--------|------|
| `EPUB_STORAGE_DIR` | `AppData/com.ryu2u.epublibrary/storage` | 书籍文件存储目录 |
| `EPUB_DATABASE_URL` / `EPUB_DB_URL` | `sqlite:AppData/com.ryu2u.epublibrary/library.db` | 数据库连接串(sqlx 格式) |
| `EPUB_COS_SECRET_ID` | — | 腾讯云 COS SecretId;与下面三项**全有**才启用 COS 资源存储 |
| `EPUB_COS_SECRET_KEY` | — | 腾讯云 COS SecretKey |
| `EPUB_COS_BUCKET` | — | 桶名(`{name}-{appid}` 格式,如 `ryu2u-1305537946`) |
| `EPUB_COS_REGION` | — | 桶所在地域(如 `ap-nanjing`) |
| `EPUB_COS_KEY_PREFIX` | `books/{book_id}/assets/{asset_id}` | COS 对象 Key 模板;`{book_id}` / `{asset_id}` 为占位符 |

> 想与旧 Web 版共用数据:`EPUB_STORAGE_DIR=C:\project\epub_project\data\storage` + `EPUB_DATABASE_URL=sqlite:C:\project\epub_project\data\library.db`。

### ☁️ 腾讯云 COS 资源存储(可选)

未配置 `EPUB_COS_*` 时,资源(封面、EPUB 内嵌图片)直接落本地 `storage/covers/` 与 `.epb` zip 内。

配置全部 4 个必需环境变量后:
- EPUB 入库时图片资源**同步**上传到 COS(`books/{book_id}/assets/{asset_id}`)
- 资源读取时优先走 COS,读不到自动回退本地 `.epb` zip
- 用户上传封面、删除书 同步清理 COS 上的对象/prefix
- 导出 EPUB 时从 COS 下载资源字节打包

⚠️ 凭据请放在系统环境变量里,**不要硬编码到源码**。

---

## 📁 项目结构

```
epub_project/
├─ src-tauri/                      Tauri 2 桌面客户端 + Rust 业务库
│  ├─ tauri.conf.json              窗口/打包/CSP 配置
│  ├─ capabilities/default.json    权限(核心 IPC + 文件对话框)
│  ├─ icons/                       应用图标(ico/png + 生成脚本)
│  ├─ migrations/                  sqlx 迁移文件
│  │  ├─ 0001_initial.sql          books/chapters/assets 表
│  │  ├─ 0002_fts5.sql             FTS5 全文索引 + 触发器
│  │  └─ 0004_drop_chapters_html.sql    章节 HTML 迁出 DB → 存储目录
│  └─ src/
│     ├─ main.rs                   入口
│     ├─ lib.rs                    装配:状态/托盘/epubasset 协议/命令注册
│     ├─ commands.rs               #[tauri::command](前端 invoke 入口)
│     ├─ core_config.rs            环境变量配置(EPUB_*)
│     ├─ core_db.rs                SqlitePool + ORM 模型
│     ├─ core_cos.rs               腾讯云 COS 资源存储(可选)
│     ├─ schema.rs                 前端交互 DTO(serde)
│     ├─ storage.rs                SHA-256 + 原子写
│     ├─ migration.rs              书库迁移(导出归档/导入合并)
│     ├─ progress.rs               进度任务(原 SSE → 轮询)
│     ├─ epub/                     解析层
│     │  ├─ mod.rs                 SourceFormat 枚举 + parse_epub/parse_txt
│     │  ├─ chapter.rs             章节 XHTML 解析 + 字数统计
│     │  ├─ container.rs           META-INF/container.xml
│     │  ├─ opf.rs                 .opf 包描述
│     │  ├─ nav.rs                 nav / NCX 目录
│     │  ├─ path.rs                资源路径解析
│     │  ├─ html_rewrite.rs        图片/CSS 引用重写
│     │  ├─ errors.rs              EpubError 类型
│     │  └─ txt.rs                 TXT 章节切分 + 编码自动检测
│     ├─ epub_writer.rs            DB → 标准 EPUB 3 字节
│     ├─ txt_writer.rs             DB → TXT(标题顶格/段首缩进)
│     └─ service/                  业务层
│        ├─ mod.rs                 BookService struct
│        ├─ read.rs                读路径(列表/详情/章节/资源/批量统计)
│        ├─ write.rs               写路径(上传/更新/重排/删除)
│        ├─ cover.rs               封面上传/删除
│        ├─ search.rs              FTS5 + LIKE 兜底搜索(逐条命中 + 按章分组)
│        └─ export.rs              导出服务(EPUB / TXT)
├─ src/                            React + Vite 前端(Tauri WebView 加载)
│  ├─ App.tsx                      路由表 + QueryClient + 错误边界
│  ├─ api/                         API 层(双模式:浏览器 HTTP / Tauri invoke)
│  │  ├─ client.ts                 apiGet/Upload/Patch/Delete + 异步任务 + 迁移
│  │  └─ types.ts                  与后端 schema 镜像的 TS 类型
│  ├─ hooks/                       自定义 hooks
│  │  ├─ useBooks.ts               书籍 CRUD + 批量上传
│  │  ├─ useReaderProgress.ts      阅读进度持久化
│  │  └─ useReaderSettings.ts      阅读偏好管理
│  ├─ lib/                         工具库(readerPrefs、appTheme、formatFileSize、locateText 等)
│  ├─ reader/paged/                分页阅读引擎(对外只暴露 index.ts)
│  │  ├─ index.ts                  公开入口:PagedReaderView + 类型
│  │  └─ internal/                 内部实现(模块外禁止深层导入,有契约测试把关)
│  │     ├─ paginator.ts           分页计算(布局后切片 + 页边界锚点)
│  │     ├─ measureChapter.ts      当前/相邻章节测量
│  │     ├─ usePaginator.ts        分页状态 + 章节切换
│  │     ├─ PagedReaderView.tsx    分页渲染 + 手势
│  │     └─ flip/SlideFlip.ts      翻页动画(平滑平移,可切 cover)
│  ├─ pages/                       页面组件
│  │  ├─ Home.tsx                  主页(之前读过/阅读目标/今年读过的图书,浅色/深色可换肤)
│  │  ├─ Library.tsx               书库(封面网格 + 进度百分比 + 排序 + 卡片菜单,可换肤)
│  │  ├─ Upload.tsx                批量上传页(.epub/.epb/.txt)
│  │  ├─ Detail.tsx                书籍详情 + 虚拟化章节列表 + 全文搜索(命中按章分组)
│  │  ├─ ChapterEditor.tsx         章节 HTML 编辑器(CodeMirror 源码 + 预览)
│  │  └─ Reader.tsx                在线阅读器(滚动 / 分页两种模式)
│  ├─ components/                  通用组件
│  │  ├─ BottomNav.tsx             底部导航(主页/书库 + 搜索)
│  │  ├─ SearchSheet.tsx           搜索弹层
│  │  ├─ ShellCover.tsx            换肤封面(素封面兜底)
│  │  ├─ ChapterRow.tsx            章节列表行(详情页)
│  │  ├─ ReaderToolbar.tsx         阅读器工具栏(翻页时自动隐藏)
│  │  ├─ ReaderTocPanel.tsx        阅读器目录面板
│  │  ├─ ReaderSidebar.tsx         阅读器侧栏
│  │  ├─ ReaderChapterHeader.tsx   章节标题(H3,随正文头部显示)
│  │  ├─ ReaderChapterEnd.tsx      章节末尾(下一章入口)
│  │  ├─ ReaderSettings.tsx        阅读设置(字号/行距/主题/翻页方式)
│  │  ├─ HtmlEditor.tsx            CodeMirror 封装
│  │  ├─ ExportDialog.tsx          导出对话框(EPUB / TXT;桌面端另存为直接落盘)
│  │  ├─ MigrationDialog.tsx       书库迁移对话框(导出/导入)
│  │  ├─ ConfirmDialog.tsx
│  │  ├─ ErrorBanner.tsx
│  │  └─ ErrorBoundary.tsx         渲染错误兜底(不再整页白屏)
│  └─ test-setup.ts                Vitest + jsdom 测试初始化
└─ docs/superpowers/               设计文档与实施计划
   ├─ specs/                       设计文档
   └─ plans/                       实施计划
```

---

## 🧩 Tauri 命令(替代原 HTTP API)

前端 `client.ts` 按 URL 路由到以下命令(`src-tauri/src/commands.rs`):

| 命令 | 对应原 HTTP 端点 | 说明 |
|------|------|------|
| `list_books` | `GET /api/books` | 列表(分页 + 搜索) |
| `get_book` | `GET /api/books/{id}` | 详情 |
| `get_chapter` | `GET /api/books/{id}/chapters/{cid}` | 章节内容(html 引用重写为 epubasset) |
| `search_in_book` | `GET /api/books/{id}/search` | 章节内全文搜索(FTS5) |
| `upload_book` | `POST /api/books` | 单文件导入 |
| `upload_books_batch` | `POST /api/books/batch` | 批量导入 |
| `upload_book_async` | `POST /api/books/async` | 异步导入 |
| `delete_book` / `delete_book_async` | `DELETE /api/books/{id}` | 删除(同步/异步) |
| `update_book` / `update_chapter` / `reorder_chapters` | `PATCH ...` | 编辑与重排 |
| `upload_cover` / `delete_cover` | `POST/DELETE .../cover` | 封面管理 |
| `export_book_async` | `POST .../export/async` | 异步导出 |
| `get_export_filename` / `take_export_bytes` | `GET /api/tasks/{id}/download` | 取导出文件(二进制;浏览器端下载用) |
| `save_export_file` | —(桌面端专属) | 导出结果直接写入用户选定路径(原生「另存为」) |
| `get_progress` | `GET /api/progress/{id}`(SSE) | 进度轮询 |
| `export_library_async` / `import_library_async` / `get_migration_result` | —(桌面端新功能) | 书库迁移 |
| `epubasset://` 协议 | `GET /api/books/{id}/assets/{aid}` | 图片/字体资源 |

### 错误响应

所有错误统一为 `{code, message, existing_book_id?}`(invoke 抛出对象,HTTP 版为
`{"error": {...}}` 包裹):

| code | 触发场景 |
|------|----------|
| `DUPLICATE_FILE`(带 existing_book_id) | 同 SHA-256 已存在 |
| `UNSUPPORTED_MEDIA` | 扩展名/MIME 不支持 |
| `INVALID_CONTAINER` / `INCOMPLETE_METADATA` / `DRM_DETECTED` / `CORRUPT_EPUB` | EPUB 解析失败 |
| `TXT_EMPTY` / `TXT_ENCODING` / `TXT_NO_CHAPTERS` | TXT 解析失败 |
| `NOT_FOUND` | 书/章节/资源/任务不存在 |
| `BAD_REQUEST` | 空 body / 参数错误 |
| `INTERNAL` | 其他内部错误 |

---

## 📄 设计文档

- **总体设计** — [2026-07-12 EPUB Reader Web App](docs/superpowers/specs/2026-07-12-epub-reader-webapp-design.md)
- **主页 + 书库换肤** — [2026-08-20 主页与书库(参考阅读 App)](docs/superpowers/specs/2026-08-20-home-library-skin-design.md)
- **EPUB 导出对话框** — [2026-08-02](docs/superpowers/specs/2026-08-02-export-dialog-design.md)
- **章节标题样式** — [2026-08-02](docs/superpowers/specs/2026-08-02-epub-chapter-heading-design.md)
- **搜索清空后显示全部** — [2026-08-07](docs/superpowers/specs/2026-08-07-search-clear-shows-all-design.md)
- **2 字符中文搜索 panic 修复** — [2026-08-08](docs/superpowers/specs/2026-08-08-search-2char-chinese-panic-fix-design.md)
- **阅读器目录面板** — [2026-08-09](docs/superpowers/specs/2026-08-09-reader-toc-panel-design.md)
- **详情页目录虚拟化** — [2026-08-13](docs/superpowers/specs/2026-08-13-detail-toc-virtualization-design.md)
- **分页阅读(分页计算 + 平滑平移翻页)** — [2026-09-09](docs/superpowers/specs/2026-09-09-paged-reader-flip-design.md)
- **全文搜索(逐条命中 + 按章分组)** — [2026-09-09](docs/superpowers/specs/2026-09-09-fulltext-search-per-hit-design.md)
- **桌面端导出「另存为」直接落盘** — [2026-09-09](docs/superpowers/specs/2026-09-09-client-export-save-as-design.md)
- **分页引擎模块化(公开 API + internal)** — [2026-09-12](docs/superpowers/specs/2026-09-12-paged-reader-module-api-design.md)

---

## 📄 License

MIT
