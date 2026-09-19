# AGENTS.md（src-tauri —— Rust 后端细则）

**根目录的 `AGENTS.md` 仍然是总规则,始终优先适用。本文件只补充 `src-tauri/` 目录下的细则。**

存在形式是**增量**:这里的每一条都是根文件的细化,不是根文件的替代。根文件里已写明的通用规则(安全、数据、Git、虚假验证等)此处不重复。

> 本文件只在 Agent 工作到 `src-tauri/` 时被加载(Claude Code 惰性加载;Codex 需从本目录启动才会读到)。
> 因此**不要把任何「漏掉会出事」的规则只写在这里** —— 那些必须写在根文件。

---

## 1. 模块布局

```
src-tauri/src/
  commands.rs      Tauri 命令层(原 axum HTTP 端点的镜像)
  service/         业务逻辑
  epub/            EPUB 解析 / 改写;txt.rs 是 TXT 切章
  epub_writer.rs   EPUB 导出打包
  txt_writer.rs    TXT 导出序列化
  storage.rs       文件存储 + atomic_write
  migration.rs     书库归档导出 / 导入合并
  progress.rs      任务注册表(TaskRegistry)与进度
  schema.rs        数据结构与 ALLOWED_EXT / ALLOWED_COVER_TYPES
  core_db.rs       数据库连接与 pragma
  core_config.rs   配置加载
  core_cos.rs      腾讯云 COS
```

原 axum HTTP 层已被 `#[tauri::command]` 取代,不要按 HTTP 服务端的思路改。

## 2. 命令(Rust 侧)

```bash
cd src-tauri && cargo test              # 全量单测
cd src-tauri && cargo test <名字>        # 过滤单测
cd src-tauri && cargo clippy --all-targets   # 静态检查(当前失败,见下)
cd src-tauri && cargo fmt               # 格式化
```

## 3. Rust 静态门禁(注意:当前是红的)

本目录有 clippy 门禁(`Cargo.toml` 的 `[lints.clippy] all = "deny"`,每条 lint 都是错误级),命令与当前失败状态见**根 `AGENTS.md` 第 14 节**。

这里只补充一条根文件没写的:因为仓库没有 CI、没有 pre-commit,**这道门禁没有任何自动化会替你触发**,只能靠人记得跑。

## 4. 新增 Tauri 命令

新增 `#[tauri::command]` 后,**必须同时在 `src-tauri/src/lib.rs` 的 `generate_handler!` 宏里注册**,否则前端 invoke 会报 command not found。

前端对应的调用要同步补进 `src/api/client.ts` 的两个分支(Tauri invoke + 浏览器 fetch),详见 `src/AGENTS.md`。

## 5. 数据库

- **SQLite + sqlx 0.8 内置 migrate 机制**,迁移文件在 `src-tauri/migrations/`
- 连接参数:schema 见 `src-tauri/src/core_db.rs`,启用 `foreign_keys(true)` 与 **WAL** 模式
- 结构变更**必须新增迁移文件**(编号递增),**禁止修改已存在的历史迁移**
- 现有迁移:`0001_initial.sql`、`0002_fts5.sql`、`0004_drop_chapters_html.sql`
  (`0003` 已不存在——编号**无需连续,但必须递增**)
- 优先向后兼容的迁移路径:加新字段 → 双写/双读 → 回填 → 切逻辑 → 确认旧字段无引用 → 最后删除
- 改数据库前必须检查:当前 schema、现有 migration、`schema.rs`、数据访问代码、相关测试

**未经明确授权,禁止** `DROP DATABASE` / `DROP TABLE` / `TRUNCATE` / 无 `WHERE` 的 `DELETE`。

### 5.1 WAL 手工拷贝陷阱

数据库默认落在 macOS `~/Library/Application Support/com.ryu2u.epublibrary/`(即 `AppData/com.ryu2u.epublibrary/`),文件名 `library.db`。

> ⚠️ **只拷 `library.db` 会丢数据。** WAL 模式下有大量已提交内容还在 `library.db-wal` 里(实测见过 27 MB),没有合并回主库文件。
> 搬迁数据必须把 `library.db` + `library.db-wal` + `library.db-shm` **一起**拷(且须先关闭程序),或直接连 `storage/` 目录整体处理。

## 6. 写用户可见的文件必须原子写

用 `src-tauri/src/storage.rs` 的 `atomic_write`(同目录临时文件 + `sync_all` + `rename`,失败时清理临时文件)。

**不要用 `std::fs::write` 直接覆盖**:它是先截断再写,磁盘满或进程被杀会把用户**原有的**目标文件毁成半截,而「另存为」对话框已经让用户确认过覆盖,旧内容不可恢复。

## 7. 归档解包安全

**永远不要信任压缩包里的条目路径。** 现有两套机制,新增相关代码时不要绕过:

- **`.epublib` 导入**(`migration.rs`):用 `entry.enclosed_name()` 拒绝绝对路径 / 盘符前缀 / `..` 段,再做解压目标的前缀断言,并限制解压总量
- **`.epub` 内部路径**:统一经 `epub/path.rs::normalize_path` 归一,`..` 不会跨根目录

历史上这里出过真实漏洞(绝对路径条目可逃出解压目录),回归测试是 **cfg 门控**的跨平台写法。

## 8. 任务与并发

后台任务走 `progress.rs` 的 `TaskRegistry`,大任务用 `spawn_blocking`。

- **异步任务结束时必须清理任务槽**,否则泄漏
- 重试必须考虑最大次数、超时、间隔与失败后的最终行为
- 禁止无限并发 / 无限队列 / 无限轮询
- 注意 `unwrap()` 滥用,尤其在**持锁路径**上

日志用 `tracing`(`warn!` / `info!`),已有 `tracing-subscriber` + `env-filter`。不要留 `println!`。

## 9. 配置与环境变量

配置层级:`代码 → .env / 环境变量(EPUB_* 前缀)→ 默认值(AppData 目录)`。

`.env` 的加载顺序(先找到的先加载,**已存在的环境变量不被覆盖**):

1. `EPUB_ENV_FILE` 环境变量显式指定的路径
2. exe 同目录的 `.env`(打包版双击启动时)
3. **工作目录**的 `.env`(开发模式 = `src-tauri/.env`)
4. `AppData/com.ryu2u.epublibrary/.env`

模板见 `src-tauri/.env.example`。**不要为了「方便」改动这套加载体系。**

## 10. 腾讯云 COS(可选)

`EPUB_COS_SECRET_ID` / `EPUB_COS_SECRET_KEY` / `EPUB_COS_BUCKET` / `EPUB_COS_REGION` **四项全有才启用**,否则走本地存储。

- 只能来自 `.env` 或环境变量,**永远不要硬编码、不要写进日志或测试夹具**
- 启用后上传资源会在**真实云存储**产生对象与费用 —— 不要为了测试向用户的真实 COS 桶写入数据

## 11. 打包

- `pnpm tauri build` 产出安装包;`pnpm tauri build --no-bundle` 只出可执行文件
- 打包目标在 `src-tauri/tauri.conf.json` 的 `bundle.targets`(当前 `nsis`,面向 Windows)
- 图标集为 `src-tauri/icons/icon.ico` + `icon.png`
- **`tauri.conf.json` 里的 CSP、`frontendDist`、`devUrl` 属高风险配置**,改动前先读现有配置并确认意图
- `devUrl`(15173)必须与 `vite.config.ts` 的 `server.port` 保持一致

## 12. 本目录测试基线

见**根 `AGENTS.md` 第 28.5 节**(Rust 87 passed / clippy 失败)。此处不重复,避免两处维护同一份数字。
