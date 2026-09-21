# 阅读状态持久化：从 localStorage 迁入数据库

- 日期：2026-09-19
- 状态：已批准，待实施

## 问题

`.epublib` 备份打包的是**数据库行 + storage 文件**（books / chapters / assets 三个行集）。
而阅读状态全部存在 `localStorage`：

| 类别 | 键 | 内容 |
|---|---|---|
| 全局偏好 | `fontSize` / `lineHeight` / `theme:v2` / `font` / `colWidth` / `mode` / `flipStyle` | 阅读设置与分页偏好 |
| 按书进度 | `progress:{bookId}` | 滚动模式 `ProgressMap`（chapterId → 百分比） |
| 按书进度 | `progressPaged:{bookId}` | 分页模式锚点（`current` / `recent` 的嵌套结构，含 anchor、pageIndex、paramsHash） |
| 按书状态 | `lastRead:{bookId}` / `status:{bookId}` | 最近章节、阅读状态 |
| 阅读时长 | `readMinutes:YYYY-MM-DD` | 每日分钟数 |

**后果**：按现有流程把书库搬到另一台电脑，书全在，但每本书的阅读进度归零、主题与字号回到默认。
对读书软件而言，书可以重新导入，读到第 37 章的进度找不回来——这是缺陷，不是缺功能。

## 目标

1. 阅读状态随 `.epublib` 备份走，换电脑后进度与偏好完整恢复
2. 合并两台设备的书库时，逐键取较新者，不互相覆盖
3. 改动面尽可能小，不重写调用方

非目标：跨设备自动同步（这是本设计之上的独立一层，本次不做）；重构分页进度的 JSON 结构。

## 关键前提（已核实）

`src/lib/readerPrefs.ts` 的 `safeGet` / `safeSet` / `safeRemove` 已经是阅读状态的**唯一读写入口**。
全仓扫描确认：唯一绕过它直接使用 `localStorage` 的是 `src/pages/Detail.tsx` 的分栏宽度 `ASIDE_WIDTH_KEY`。

因此可以**只更换底层存储，调用方零改动**。

## 设计

### 1. 数据模型

新增迁移 `src-tauri/migrations/0005_reader_prefs.sql`：

```sql
CREATE TABLE IF NOT EXISTS reader_prefs (
    key        TEXT PRIMARY KEY,   -- 沿用现有键名，如 epub_reader:progress:{bookId}
    value      TEXT NOT NULL,      -- 原样存字符串（复杂值是 JSON）
    updated_at DATETIME NOT NULL   -- 供导入时逐键比较取较新
);
```

单表镜像 localStorage，**键名与 JSON 结构一律不变**。`updated_at` 逐键记录，
而进度本就是逐书一个键（`progress:{bookId}`），时间粒度天然对齐到「每本书」。

**不做结构化表**（`reading_progress` / `book_state` 分开建）。代价是要拆解分页进度的嵌套 JSON、
调用方要改、迁移要写解析逻辑；收益是可 SQL 查询，当前没有这个需求。

### 2. 前端存储层

新增 `src/lib/readerStore.ts`。`safeGet` / `safeSet` / `safeRemove` 改为它的薄封装。

- **Tauri 模式**：启动时全量载入内存 `Map`；读走内存，写内存 + fire-and-forget 调后端 upsert
- **浏览器模式**：仍旧直接读写 `localStorage`（浏览器没有后端，沿用现有双模式）

### 3. 启动时序

`src/main.tsx` 必须 **`await initReaderStore()` 之后才渲染**。

原因：滚动位置恢复依赖进度，若先渲染再载入，打开书会先跳到章首再跳回来。
载入是一次小表 SELECT，毫秒级；期间显示极简骨架。

### 4. 后端命令

```
get_reader_prefs()      -> Vec<{key, value, updated_at}>   // 启动时全量拉取
set_reader_pref(key, value)                                // upsert，刷新 updated_at
remove_reader_pref(key)
import_reader_prefs(items)                                 // 存量迁移用，批量
```

### 5. 存量迁移（首次启动）

条件：**后端表为空** 且 `localStorage` 中存在 `epub_reader:` 前缀的键。
满足则批量导入，**成功后清除**这些 localStorage 键。迁移幂等，中断可重试。

「表为空」是有意选择的判据：若用户在新电脑上先导入了含进度的备份，表已非空，
此时**不应**再拿本机 localStorage 覆盖它。

**已知边界**：升级到新版后回退旧版用了几天、再升回来，那几天的 localStorage 写入不会被迁移
（表已非空）。接受此边界。

### 6. 备份集成

- `BACKUP_VERSION` 由 `1` → `2`，新增 `reader_prefs` 行集
- 导入时逐键比较备份与本地 `updated_at`，**取较新**——同一套逻辑覆盖「新电脑恢复」与「合并两台设备」
- 旧版备份（v1，无 prefs 行集）→ 其余部分照常导入，prefs 跳过，**不报错**

### 7. 顺带修复的既有缺陷

**删除书籍时清理该书的键**（`progress:` / `progressPaged:` / `lastRead:` / `status:`）。
当前删除书籍只动数据库，localStorage 里的这些键无人清理；搬进 DB 后会变成备份里的垃圾行。

**`Detail.tsx` 的分栏宽度改走 store**，让「唯一入口」名副其实——否则无法用一句 grep 保证覆盖率。

### 8. 错误处理

- **init 失败**（DB 打不开等）→ 降级为 localStorage 支撑并打 warn，**绝不静默清空**。
  宁可用旧机制，也不能让用户看到「进度全没了」。
- **写入失败** → 内存已更新，重试一次；仍失败则 warn，不回滚内存（避免 UI 抖动）。

### 9. 测试

- **Rust**：四个命令的单测；导入合并「取较新」的三种边界（备份新 / 本地新 / 仅一方有）
- **前端**：store 读写删；迁移逻辑（空表 + 有存量 → 导入并清除；非空表 → 不迁移）；浏览器降级路径
- **回归基线**：现有 179 前端 + 87 Rust 必须保持全绿

## 明确不做

- 结构化表（见 1）
- 跨设备自动同步——本次只让备份带上进度
- 为 `useReaderSettings` 的 `storage` 事件跨标签同步补等价机制。该机制切到 DB 后不再触发，
  但**桌面端是单窗口**，浏览器模式仍是 localStorage 也仍生效，无实际影响（YAGNI）

## 影响面

| 层 | 文件 |
|---|---|
| 数据库 | 新增 `0005_reader_prefs.sql` |
| 后端 | `commands.rs`（4 个命令）、`lib.rs`（注册）、`migration.rs`（行集 + 版本 + 合并） |
| 前端 | 新增 `readerStore.ts`；改 `readerPrefs.ts`、`main.tsx`、`api/client.ts`、`pages/Detail.tsx` |
| 文档 | README（备份范围、数据位置）、`src-tauri/AGENTS.md` §5（迁移清单）、根 `AGENTS.md` §28.5（基线） |
