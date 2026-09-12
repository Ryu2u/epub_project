// 公开 API 契约测试:钉住「模块只有一个入口」这个约定。
//
// 为什么用测试而不是 lint:仓库没有 ESLint 配置,而这条边界一旦破掉
// (业务层直接 import ./internal/paginator),以后改分页算法就会牵连调用方。
// 这里用 Vite 的 import.meta.glob 把源码当文本读进来做静态扫描 —— 不依赖
// node:fs(本项目未装 @types/node)。

import { describe, expect, it } from 'vitest';
import * as publicApi from './index';

const SOURCES = import.meta.glob('/src/**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/** 引擎自己的目录:模块内部互相引用是合法的。 */
const MODULE_PREFIX = '/src/reader/paged/';

/** 任何带引号的、指向引擎内部的深层路径(import / export from / vi.mock / 动态 import 都算)。 */
const DEEP_SPECIFIER = /(['"])[^'"]*reader\/paged\/[^'"]+\1/g;

describe('分页引擎公开 API', () => {
  it('运行时只导出 PagedReaderView,内部实现不外泄', () => {
    // 类型导出(FlipStyle / PagedReaderViewProps)编译后被抹掉,所以运行时只有组件。
    // 若将来要公开新东西,请连同本用例的期望值一起改 —— 这是有意的破坏性变更。
    expect(Object.keys(publicApi).sort()).toEqual(['PagedReaderView']);
  });

  it('模块外的文件没有深层导入内部实现', () => {
    const offenders: string[] = [];
    for (const [file, text] of Object.entries(SOURCES)) {
      if (file.startsWith(MODULE_PREFIX)) continue;
      for (const match of text.matchAll(DEEP_SPECIFIER)) {
        offenders.push(`${file} → ${match[0]}`);
      }
    }
    expect(offenders, `请改为从 'reader/paged' 导入:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('扫描本身是有效的(能读到源码,且只允许从入口导入)', () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThan(10);
    expect(SOURCES['/src/pages/Reader.tsx']).toContain("from '../reader/paged'");
    expect(SOURCES['/src/lib/readerPrefs.ts']).toContain("from '../reader/paged'");
  });
});
