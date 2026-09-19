// 从 React 导入 StrictMode —— 开发模式下的额外检查工具，
// 会在渲染时检测副作用、废弃 API 等问题（生产环境会自动跳过，不影响性能）。
import { StrictMode } from 'react';
// createRoot 是 React 18 的新 API，替代了旧的 ReactDOM.render，
// 启用并发渲染（Concurrent Mode）特性，如自动批处理和 Suspense。
import { createRoot } from 'react-dom/client';
// 根组件，整个应用的入口
import App from './App';
// 阅读状态存储：启动时须先载入，见下方说明
import { initReaderStore } from './lib/readerStore';
// 全局样式（Tailwind CSS 的 base/components/utilities + 自定义主题变量）
import './index.css';

// **必须先等阅读状态就绪再渲染**，原因有二：
//   1. 阅读器恢复滚动位置依赖进度。若先渲染再载入，打开书会先跳到章首再跳回来。
//   2. 未就绪时写入会落到 localStorage 而不是数据库，那部分改动不会有备份。
// 载入是一次小表查询，毫秒级；initReaderStore 内部已兜底——后端不可用时
// 会降级为 localStorage 并返回，不会抛错卡住启动。
await initReaderStore();

// document.getElementById('root')! 中的感叹号是 TypeScript 的"非空断言"（non-null assertion），
// 告诉编译器这个元素一定存在（对应 index.html 中的 <div id="root">）。
createRoot(document.getElementById('root')!).render(
  // StrictMode 仅在开发环境生效，会额外调用一次 render 帮助发现不纯函数等副作用
  <StrictMode>
    <App />
  </StrictMode>,
);
