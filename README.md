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
- **⚙️ 阅读偏好** — 字体大小、主题、行间距可自定义,实时生效
- **🔄 工具栏智能显隐** — 根据滚动方向自动显示/隐藏阅读工具栏(触屏 & 鼠标滚轮)
- **🖼️ 图片资源服务** — EPUB 内嵌图片经后端提取后按需加载,章节 HTML 中的图片与 CSS 引用自动重写
- **🔎 全文搜索** — SQLite FTS5 索引章节正文,章节内快速定位关键词(`<mark>` 高亮片段;查询词少于 2 个字符时返回空)
- **📤 导出（EPUB / TXT）** — EPUB:重新打包成标准 EPUB 3(导出 XHTML 严格符合 Sigil/EpubCheck,段首缩进 `text-indent:2em` 内置);TXT:标题顶格、正文段首空两格的纯文本,与 TXT 导入的切章格式互为镜像
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

### 桌面客户端 (`src-tauri/`,feat/tauri2 分支)

Tauri 2 桌面应用,**复用 `backend-rs` 业务库**(service / EPUB 解析 / 进度任务),axum HTTP 层替换为:

| 原 HTTP 接口 | 桌面端实现 |
|---|---|
| `/api/books` 全部 CRUD 端点 | `#[tauri::command]`(`src-tauri/src/commands.rs`) |
| `GET /api/books/:id/assets/:aid` | `epubasset://` 自定义协议(COS/本地同源支持) |
| `GET /api/progress/:id`(SSE) | `get_progress` 命令 200ms 轮询 |
| 导出文件下载 | `get_export_filename` + `take_export_bytes`(二进制响应) |

**桌面端专属功能**:

- **书库迁移/备份** — 书库页「迁移」按钮:整库导出为 `.epublib`(书目 + 章节 + 源文件 + 封面),拷到另一台电脑导入即可合并(同 id/SHA 自动跳过,FTS 索引自动重建)
- **系统托盘** — 应用常驻托盘,左键切换显示/隐藏,右键菜单退出;点窗口 × 最小化到托盘
- **可缩至手机尺寸** — 窗口最小 340×480,<768px 自动切换手机布局

前端 `web/src/api/client.ts` 为**双模式**:检测 `__TAURI_INTERNALS__`,Tauri 里路由到 invoke,浏览器里走原 HTTP——页面/组件零改动,错误形状两端一致。

- 数据默认落 `AppData/com.ryu2u.epublibrary/`(storage/ + library.db),可用 `EPUB_STORAGE_DIR` / `EPUB_DATABASE_URL` 覆盖(如与 Web 版共用 `./data`)
- COS 配置沿用 `EPUB_COS_*` 环境变量约定

---

## 🚀 快速开始

### 环境要求

- Rust ≥ 1.75
- Node.js ≥ 18(pnpm / npm 均可,仓库附带 `pnpm-lock.yaml`)
- 桌面客户端另需:WebView2(Windows 10/11 自带)、MSVC 构建工具链

### 桌面客户端(Tauri,feat/tauri2 分支)

epub_project/
├─ src-tauri/                     Tauri 2 桌面客户端(含全部业务代码)
│  ├─ tauri.conf.json             窗口/打包/CSP 配置
│  ├─ capabilities/default.json   权限(核心 IPC + 文件对话框)
│  ├─ icons/                      应用图标(ico/png + 生成脚本)
│  ├─ migrations/                 sqlx 迁移文件
│  └─ src/
│     ├─ main.rs                  入口
│     ├─ lib.rs                   装配:AppState/托盘/epubasset 协议/命令注册
│     ├─ commands.rs              18 个 tauri command(前端 invoke 入口)
│     ├─ core_config.rs           环境变量配置(EPUB_*)
│     ├─ core_cos.rs              腾讯云 COS 客户端
│     ├─ core_db.rs               SqlitePool + 迁移 + ORM 模型
│     ├─ schema.rs                前端交互 DTO(serde)
│     ├─ storage.rs               SHA-256 + 原子写
│     ├─ migration.rs             书库迁移(导出归档/导入合并)
│     ├─ epub/                    解析层(mod.rs: SourceFormat + parse 入口;
│     │                           chapter/container/opf/nav/path/
│     │                           html_rewrite/errors/txt: 切分+编码检测)
│     ├─ epub_writer.rs           DB - 标准 EPUB 3 字节
│     ├─ txt_writer.rs            DB - TXT(标题顶格/段首缩进)
│     ├─ progress.rs              任务表 + 进度快照(导入/导出/删除/迁移)
│     └─ service/                 业务层
│        ├─ mod.rs                BookService struct
│        ├─ read.rs               读路径(列表/详情/章节/资源/批量统计)
│        ├─ write.rs              写路径(上传/更新/重排/删除)
│        ├─ cover.rs              封面上传/删除
│        ├─ search.rs             FTS5 + LIKE 兜底搜索
│        └─ export.rs             导出服务(EPUB / TXT)
├─ web/                           React + Vite 界面(Tauri WebView 加载)
│  └─ src/
│     ├─ App.tsx                  路由表 + QueryClient
│     ├─ api/                     API 层(双模式:浏览器 HTTP / Tauri invoke)
│     │  ├─ client.ts             apiGet/Upload/Patch/Delete + 异步任务 + 迁移
│     │  └─ types.ts              与后端 schema 镜像的 TS 类型
│     ├─ hooks/                   自定义 hooks
│     │  ├─ useBooks.ts           书籍 CRUD + 批量上传
│     │  ├─ useReaderProgress.ts  阅读进度持久化
│     │  └─ useReaderSettings.ts  阅读偏好管理
│     ├─ lib/                     工具库(readerPrefs、formatFileSize、readingStats)
│     ├─ pages/                   页面组件
│     │  ├─ Home.tsx              主页(之前读过/阅读目标/今年读过的图书,浅色/深色可换肤)
│     │  ├─ Library.tsx           书库(封面网格 + 进度百分比 + 排序 + 卡片菜单,可换肤)
│     │  ├─ Upload.tsx            批量上传页(.epub/.epb/.txt)
│     │  ├─ Detail.tsx            书籍详情 + 虚拟化章节列表
│     │  ├─ ChapterEditor.tsx     章节 HTML 编辑器(CodeMirror 源码 + 预览)
│     │  └─ Reader.tsx            在线阅读器
│     ├─ components/              通用组件
│     │  ├─ BottomNav.tsx         底部导航(主页/书库 + 搜索)
│     │  ├─ SearchSheet.tsx       搜索弹层
│     │  ├─ ShellCover.tsx        换肤封面(素封面兜底)
│     │  ├─ ChapterRow.tsx        章节列表行(详情页)
│     │  ├─ ReaderToolbar.tsx
│     │  ├─ ReaderTocPanel.tsx    阅读器目录面板
│     │  ├─ ReaderSettings.tsx
│     │  ├─ HtmlEditor.tsx        CodeMirror 封装
│     │  ├─ ExportDialog.tsx      导出对话框(EPUB / TXT 格式选择)
│     │  ├─ MigrationDialog.tsx   书库迁移对话框(导出/导入)
│     │  ├─ ConfirmDialog.tsx
│     │  └─ ErrorBanner.tsx
│     └─ test-setup.ts            Vitest + jsdom 测试初始化
└─ docs/superpowers/              设计文档与实施计划
   ├─ specs/                      设计文档
   └─ plans/                      实施计划

### 桌面客户端(Tauri,feat/tauri2 分支)

```bash
# 开发模式(热更新:前端即时生效,Rust 改动自动重编译重启)
pnpm tauri dev

# 构建 exe(需要 MSVC;产出 src-tauri/target/release/epub-library-app.exe)
pnpm tauri build --no-bundle

# 构建 NSIS 安装包
pnpm tauri build
```

> 数据默认落 `AppData/com.ryu2u.epublibrary/`(storage/ + library.db)。
> 想与 Web 版共用数据:设 `EPUB_DATABASE_URL` / `EPUB_STORAGE_DIR` 指向 `./data` 后启动。

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
├─ src-tauri/                     Tauri 2 桌面客户端
│  ├─ tauri.conf.json             窗口/打包/CSP 配置
│  ├─ capabilities/default.json   权限(核心 IPC + 文件对话框)
│  ├─ icons/                      应用图标(ico/png + 生成脚本)
│  └─ src/
│     ├─ main.rs                  入口
│     ├─ lib.rs                   装配:状态/托盘/epubasset 协议/命令注册
│     └─ commands.rs              18 个 #[tauri::command](前端 invoke 入口)
├─ backend-rs/                    Rust 业务库(被 src-tauri 复用)
│  ├─ migrations/                 sqlx 迁移文件
│  │  ├─ 0001_initial.sql         books/chapters/assets 表
│  │  ├─ 0002_fts5.sql            FTS5 全文索引 + 触发器
│  │  └─ 0004_drop_chapters_html.sql   章节 HTML 迁出 DB → 存储目录
│  ├─ src/
│  │  ├─ config.rs                环境变量配置(EPUB_*)
│  │  ├─ db.rs                    SqlitePool + ORM 模型
│  │  ├─ schema.rs                前端交互 DTO(serde)
│  │  ├─ storage.rs               SHA-256 + 原子写
│  │  ├─ migration.rs             书库迁移(导出归档/导入合并)
│  │  ├─ epub/                    解析层
│  │  │  ├─ mod.rs                SourceFormat 枚举 + parse_epub/parse_txt
│  │  │  ├─ chapter.rs            章节 XHTML 解析 + 字数统计
│  │  │  ├─ container.rs          META-INF/container.xml
│  │  │  ├─ opf.rs                .opf 包描述
│  │  │  ├─ nav.rs                nav / NCX 目录
│  │  │  ├─ path.rs               资源路径解析
│  │  │  ├─ html_rewrite.rs       图片/CSS 引用重写
│  │  │  ├─ errors.rs             EpubError 类型
│  │  │  └─ txt.rs                TXT 章节切分 + 编码自动检测
│  │  ├─ epub_writer.rs           DB → 标准 EPUB 3 字节
│  │  ├─ txt_writer.rs            DB → TXT(标题顶格/段首缩进)
│  │  └─ service/                 业务层
│  │     ├─ mod.rs                BookService struct
│  │     ├─ read.rs               读路径(列表/详情/章节/资源/批量统计)
│  │     ├─ write.rs              写路径(上传/更新/重排/删除)
│  │     ├─ cover.rs              封面上传/删除
│  │     ├─ search.rs             FTS5 + LIKE 兜底搜索
│  │     └─ export.rs             导出服务(EPUB / TXT)
│  └─ Cargo.toml
├─ web/                           React + Vite 界面(Tauri WebView 加载)
│  └─ src/
│     ├─ App.tsx                  路由表 + QueryClient
│     ├─ api/                     API 层(双模式:浏览器 HTTP / Tauri invoke)
│     │  ├─ client.ts             apiGet/Upload/Patch/Delete + 异步任务 + 迁移
│     │  └─ types.ts              与后端 schema 镜像的 TS 类型
│     ├─ hooks/                   自定义 hooks
│     │  ├─ useBooks.ts           书籍 CRUD + 批量上传
│     │  ├─ useReaderProgress.ts  阅读进度持久化
│     │  └─ useReaderSettings.ts  阅读偏好管理
│     ├─ lib/                     工具库(readerPrefs、formatFileSize、readingStats)
│     ├─ pages/                   页面组件
│     │  ├─ Home.tsx              主页(之前读过/阅读目标/今年读过的图书,浅色/深色可换肤)
│     │  ├─ Library.tsx           书库(封面网格 + 进度百分比 + 排序 + 卡片菜单,可换肤)
│     │  ├─ Upload.tsx            批量上传页(.epub/.epb/.txt)
│     │  ├─ Detail.tsx            书籍详情 + 虚拟化章节列表
│     │  ├─ ChapterEditor.tsx     章节 HTML 编辑器(CodeMirror 源码 + 预览)
│     │  └─ Reader.tsx            在线阅读器
│     ├─ components/              通用组件
│     │  ├─ BottomNav.tsx         底部导航(主页/书库 + 搜索)
│     │  ├─ SearchSheet.tsx       搜索弹层
│     │  ├─ ShellCover.tsx        换肤封面(素封面兜底)
│     │  ├─ ChapterRow.tsx        章节列表行(详情页)
│     │  ├─ ReaderToolbar.tsx
│     │  ├─ ReaderTocPanel.tsx    阅读器目录面板
│     │  ├─ ReaderSettings.tsx
│     │  ├─ HtmlEditor.tsx        CodeMirror 封装
│     │  ├─ ExportDialog.tsx      导出对话框(EPUB / TXT 格式选择)
│     │  ├─ MigrationDialog.tsx   书库迁移对话框(导出/导入)
│     │  ├─ ConfirmDialog.tsx
│     │  └─ ErrorBanner.tsx
│     └─ test-setup.ts            Vitest + jsdom 测试初始化
└─ docs/superpowers/              设计文档与实施计划
   ├─ specs/                      设计文档
   └─ plans/                      实施计划
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
| `get_export_filename` / `take_export_bytes` | `GET /api/tasks/{id}/download` | 取导出文件(二进制) |
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

---

## 📄 License

MIT
