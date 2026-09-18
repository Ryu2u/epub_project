import '@testing-library/jest-dom';
import { configure } from '@testing-library/react';

// Node ≥ 22 自带原生 localStorage/sessionStorage 全局（默认未初始化，读值为
// undefined）。vitest 注入 jsdom 环境时，这个已存在的键会遮蔽 jsdom 的实现
// （vitest 把原始实现 stash 到 _localStorage/_sessionStorage），于是测试里裸用
// localStorage 的地方全部拿到 undefined。这里把 jsdom 的实现重新定义回全局，
// 恢复 Node < 22 时代「jsdom 即真相」的行为。
type Stashable = { _localStorage?: Storage; _sessionStorage?: Storage };
const stash = globalThis as typeof globalThis & Stashable;
function restoreStorage(name: 'localStorage' | 'sessionStorage') {
  const stashed = stash[`_${name}` as keyof Stashable];
  const current = (globalThis as Record<string, unknown>)[name];
  if (stashed instanceof Storage && !(current instanceof Storage)) {
    Object.defineProperty(globalThis, name, {
      value: stashed,
      configurable: true,
      writable: true,
    });
  }
}
restoreStorage('localStorage');
restoreStorage('sessionStorage');

// 全量测试并行时环境较慢（分页测量 + 翻页动画 + 多个查询），
// findBy*/waitFor 默认 1s 会偶发超时。放宽到 4s：只影响失败判定速度，
// 不影响断言语义。
configure({ asyncUtilTimeout: 4000 });

// jsdom 的 window.scrollTo 是会报 "Not implemented" 噪音的占位，
// test-setup 仅在测试环境加载，这里无条件替换为空实现。
window.scrollTo = () => {};

// jsdom 未实现 ResizeObserver（Detail 页用它测量目录列表高度），
// 补一个 no-op 桩：observe/unobserve/disconnect 什么都不做，
// 测量逻辑本身在缺失 ResizeObserver 时仍会执行一次（measure() 直接调用）。
if (typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
}
