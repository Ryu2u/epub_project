// readerStore 测试：Tauri(数据库) / 浏览器(localStorage) 双模式、
// 存量迁移、以及初始化失败时的降级路径。
//
// 每个用例用 vi.resetModules() + 动态 import 拿一份全新的模块实例，
// 避免模块级缓存(mode / cache)在用例间串味——这样生产代码里就不需要
// 塞一个仅供测试的 reset 导出。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runningInTauriMock = vi.fn<() => boolean>();
const fetchReaderPrefsMock = vi.fn<() => Promise<{ key: string; value: string; updated_at: string }[]>>();
const putReaderPrefMock = vi.fn<(key: string, value: string) => Promise<void>>();
const dropReaderPrefMock = vi.fn<(key: string) => Promise<void>>();
const importReaderPrefsMock = vi.fn<(items: unknown[]) => Promise<number>>();

vi.mock('../api/client', () => ({
  runningInTauri: () => runningInTauriMock(),
  fetchReaderPrefs: () => fetchReaderPrefsMock(),
  putReaderPref: (key: string, value: string) => putReaderPrefMock(key, value),
  dropReaderPref: (key: string) => dropReaderPrefMock(key),
  importReaderPrefs: (items: unknown[]) => importReaderPrefsMock(items),
}));

/** 拿一份全新的 readerStore 模块实例 */
async function freshStore() {
  vi.resetModules();
  return import('./readerStore');
}

const K = 'epub_reader:progress:b1';

function seedLocalStorage(entries: Record<string, string>) {
  for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, v);
}

describe('readerStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    runningInTauriMock.mockReturnValue(true);
    fetchReaderPrefsMock.mockResolvedValue([]);
    putReaderPrefMock.mockResolvedValue(undefined);
    dropReaderPrefMock.mockResolvedValue(undefined);
    importReaderPrefsMock.mockResolvedValue(1);
  });

  afterEach(() => {
    localStorage.clear();
  });

  // ---------- 浏览器模式 ----------

  it('浏览器模式:init 不请求后端,读写直接走 localStorage', async () => {
    runningInTauriMock.mockReturnValue(false);
    const store = await freshStore();

    await store.initReaderStore();
    store.storeSet(K, '{"ch1":10}');

    expect(fetchReaderPrefsMock).not.toHaveBeenCalled();
    expect(localStorage.getItem(K)).toBe('{"ch1":10}');
    expect(store.storeGet(K)).toBe('{"ch1":10}');

    store.storeRemove(K);
    expect(localStorage.getItem(K)).toBeNull();
  });

  // ---------- Tauri 模式 ----------

  it('Tauri 模式:init 把后端数据载入内存,get 命中', async () => {
    fetchReaderPrefsMock.mockResolvedValue([
      { key: K, value: '{"ch2":20}', updated_at: '2026-01-01T00:00:00.000Z' },
    ]);
    const store = await freshStore();

    await store.initReaderStore();

    expect(store.isReaderStoreReady()).toBe(true);
    expect(store.storeGet(K)).toBe('{"ch2":20}');
  });

  it('Tauri 模式:set 立即更新内存并异步落库', async () => {
    const store = await freshStore();
    await store.initReaderStore();

    store.storeSet(K, '{"ch3":30}');

    expect(store.storeGet(K)).toBe('{"ch3":30}');
    await vi.waitFor(() => expect(putReaderPrefMock).toHaveBeenCalledWith(K, '{"ch3":30}'));
  });

  it('Tauri 模式:remove 立即清内存并异步删库', async () => {
    fetchReaderPrefsMock.mockResolvedValue([
      { key: K, value: '{"ch2":20}', updated_at: '2026-01-01T00:00:00.000Z' },
    ]);
    const store = await freshStore();
    await store.initReaderStore();

    store.storeRemove(K);

    expect(store.storeGet(K)).toBeNull();
    await vi.waitFor(() => expect(dropReaderPrefMock).toHaveBeenCalledWith(K));
  });

  it('写入后端的 put 失败会重试一次', async () => {
    putReaderPrefMock
      .mockRejectedValueOnce(new Error('磁盘忙'))
      .mockResolvedValueOnce(undefined);
    const store = await freshStore();
    await store.initReaderStore();

    store.storeSet(K, 'x');

    await vi.waitFor(() => expect(putReaderPrefMock).toHaveBeenCalledTimes(2));
  });

  // ---------- 存量迁移 ----------

  it('表为空且 localStorage 有存量:导入后端并清除 localStorage', async () => {
    seedLocalStorage({ [K]: '{"ch9":90}', 'epub_reader:fontSize:global': '22' });
    fetchReaderPrefsMock.mockResolvedValue([]); // 表为空
    importReaderPrefsMock.mockResolvedValue(2);
    const store = await freshStore();

    await store.initReaderStore();

    expect(importReaderPrefsMock).toHaveBeenCalledTimes(1);
    const sent = importReaderPrefsMock.mock.calls[0][0] as {
      key: string;
      value: string;
      updated_at: string;
    }[];
    expect(sent.map((r) => r.key).sort()).toEqual([K, 'epub_reader:fontSize:global'].sort());
    // 时间戳必须是 JS toISOString() 的规范格式，才能与后端做字符串比较
    expect(sent[0].updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    // 迁移后 localStorage 应被清空，避免下次重复迁移
    expect(localStorage.getItem(K)).toBeNull();
    expect(localStorage.getItem('epub_reader:fontSize:global')).toBeNull();
    // 内存缓存要立刻可用，否则首屏读不到进度
    expect(store.storeGet(K)).toBe('{"ch9":90}');
  });

  it('表非空:不迁移,本机 localStorage 保持原样', async () => {
    seedLocalStorage({ [K]: '{"ch9":90}' });
    fetchReaderPrefsMock.mockResolvedValue([
      { key: K, value: '{"ch1":1}', updated_at: '2026-01-01T00:00:00.000Z' },
    ]);
    const store = await freshStore();

    await store.initReaderStore();

    expect(importReaderPrefsMock).not.toHaveBeenCalled();
    expect(localStorage.getItem(K)).toBe('{"ch9":90}');
    expect(store.storeGet(K)).toBe('{"ch1":1}'); // 以库里的为准
  });

  it('表为空但 localStorage 无存量:不调用导入', async () => {
    const store = await freshStore();
    await store.initReaderStore();

    expect(importReaderPrefsMock).not.toHaveBeenCalled();
  });

  // ---------- 降级 ----------

  it('init 失败:降级为 localStorage,读写仍可用且不丢数据', async () => {
    seedLocalStorage({ [K]: '{"ch5":50}' });
    fetchReaderPrefsMock.mockRejectedValue(new Error('数据库打不开'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = await freshStore();

    await store.initReaderStore();

    expect(store.isReaderStoreDegraded()).toBe(true);
    // 关键的：既不能抛，也不能清空
    expect(store.storeGet(K)).toBe('{"ch5":50}');
    expect(localStorage.getItem(K)).toBe('{"ch5":50}');
    warn.mockRestore();
  });

  it('重复 init 幂等,不重复请求后端', async () => {
    const store = await freshStore();
    await store.initReaderStore();
    await store.initReaderStore();

    expect(fetchReaderPrefsMock).toHaveBeenCalledTimes(1);
  });
});
