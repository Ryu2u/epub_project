import '@testing-library/jest-dom';

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
