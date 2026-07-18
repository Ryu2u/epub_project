import '@testing-library/jest-dom';

// jsdom 的 window.scrollTo 是会报 "Not implemented" 噪音的占位，
// test-setup 仅在测试环境加载，这里无条件替换为空实现。
window.scrollTo = () => {};
