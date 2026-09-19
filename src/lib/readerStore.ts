// 阅读状态的存储层。
//
// 两套底层，同一个接口：
//   - Tauri(桌面端)：后端数据库 reader_prefs 表 —— 随 .epublib 备份走
//   - 浏览器：localStorage —— 浏览器没有后端，沿用旧机制
//
// 形态刻意做成「localStorage 的镜像」：键名与 JSON 结构一律不变。
// 因此 safeGet/safeSet/safeRemove 及它们的全部调用方零改动——
// 换存储这件事被收敛在本文件里。
//
// 为什么不直接用 localStorage：阅读进度、偏好、阅读时长此前只在 webview 里，
// 备份带不走，换电脑后进度归零。改存数据库后这些状态随备份一起迁移。

import {
  dropReaderPref,
  fetchReaderPrefs,
  importReaderPrefs,
  putReaderPref,
  runningInTauri,
  type ReaderPrefRow,
} from '../api/client';

/// 与 readerPrefs.ts 一致的键前缀
const K_PREFIX = 'epub_reader:';

type Mode = 'uninitialized' | 'db' | 'local';

let mode: Mode = 'uninitialized';
/// 内存缓存：Tauri 模式下是唯一的读取来源（localStorage 那份已不再权威）
let cache = new Map<string, string>();
/// 是否因初始化失败而降级为 localStorage 支撑
let degraded = false;

/// 初始化是否完成。Tauri 模式下未完成前读写不可靠，故 main.tsx 会等它。
export function isReaderStoreReady(): boolean {
  return mode !== 'uninitialized';
}

/// 是否处于降级状态（后端不可用，退回 localStorage）。供诊断与测试。
export function isReaderStoreDegraded(): boolean {
  return degraded;
}

// ---------- localStorage 兜底实现（浏览器模式与降级路径共用） ----------

function lsGet(key: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null; // 隐私模式等可能抛 SecurityError
  }
}

function lsSet(key: string, value: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // 配额满 / 隐私模式 — 静默失败
  }
}

function lsRemove(key: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    // 静默失败
  }
}

// ---------- 存量迁移 ----------

/// 收集 localStorage 里的全部阅读状态键。
/// 时间戳取「现在」：这批数据代表本机当前状态，应能被更旧的备份认作较新。
function collectLocalStorageRows(): ReaderPrefRow[] {
  if (typeof window === 'undefined') return [];
  const rows: ReaderPrefRow[] = [];
  // 必须是 JS toISOString() 的规范格式，才能与后端 now_stamp() 做字符串比较
  const stamp = new Date().toISOString();
  try {
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (!key || !key.startsWith(K_PREFIX)) continue;
      const value = window.localStorage.getItem(key);
      if (value === null) continue;
      rows.push({ key, value, updated_at: stamp });
    }
  } catch {
    return []; // localStorage 不可用，当作没有存量
  }
  return rows;
}

/// 清除 localStorage 里的阅读状态键。
/// 先收集再删除：边遍历边按索引删除会因下标前移而漏删。
function clearLocalStorageRows(keys: string[]): void {
  for (const key of keys) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // 静默失败
    }
  }
}

/// 首次运行：把 localStorage 存量搬进数据库。
///
/// 只在**后端表为空**时执行。若用户先导入了含进度的备份，表已非空，
/// 此时不该拿本机 localStorage 覆盖它。
/// 顺序上先等全部写入成功、再清 localStorage——中途失败宁可留着重复的
/// 本地副本，也不能两头都丢。
async function migrateFromLocalStorage(): Promise<void> {
  const rows = collectLocalStorageRows();
  if (rows.length === 0) return;

  const written = await importReaderPrefs(rows);

  // 同步进内存缓存，否则迁移完的首屏读不到刚搬过去的进度
  for (const row of rows) cache.set(row.key, row.value);
  clearLocalStorageRows(rows.map((r) => r.key));

  console.info(`[readerStore] 已将 ${written}/${rows.length} 项本地阅读状态迁入数据库`);
}

// ---------- 初始化 ----------

/// 载入阅读状态。**必须在首屏渲染前 await**——滚动位置恢复依赖它，
/// 否则打开书会先跳到章首再跳回来。幂等。
export async function initReaderStore(): Promise<void> {
  if (mode !== 'uninitialized') return;

  if (!runningInTauri()) {
    mode = 'local';
    return;
  }

  try {
    const rows = await fetchReaderPrefs();
    for (const row of rows) cache.set(row.key, row.value);
    mode = 'db';

    if (rows.length === 0) await migrateFromLocalStorage();
  } catch (e) {
    // 降级：宁可用旧机制，也不能让用户看到「进度全没了」。
    // 注意这里**不碰** localStorage，所以存量数据完好。
    degraded = true;
    mode = 'local';
    console.warn('[readerStore] 阅读状态初始化失败，降级为 localStorage：', e);
  }
}

// ---------- 读写 ----------

/// 写入后端，失败重试一次，仍失败只记日志。
/// 不回滚内存：内存与 UI 已经用上新值了，回滚只会造成抖动；
/// 一次失败的持久化不值得让正在阅读的页面跳回去。
async function pushWithRetry(key: string, value: string): Promise<void> {
  try {
    await putReaderPref(key, value);
  } catch {
    try {
      await putReaderPref(key, value);
    } catch (e) {
      console.warn(`[readerStore] 写入阅读状态失败（已重试）：${key}`, e);
    }
  }
}

export function storeGet(key: string): string | null {
  if (mode === 'db') return cache.get(key) ?? null;
  return lsGet(key);
}

export function storeSet(key: string, value: string): void {
  if (mode === 'db') {
    cache.set(key, value);
    void pushWithRetry(key, value);
    return;
  }
  lsSet(key, value);
}

export function storeRemove(key: string): void {
  if (mode === 'db') {
    cache.delete(key);
    void dropReaderPref(key).catch((e) => {
      console.warn(`[readerStore] 删除阅读状态失败：${key}`, e);
    });
    return;
  }
  lsRemove(key);
}
