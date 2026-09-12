/// <reference types="vite/client" />
//
// Vite 客户端类型(import.meta.env / import.meta.glob / 资源导入等)。
// 仓库 tsconfig 里 "types" 只列了 vitest 与 jest-dom,这里是显式引入,
// 让 import.meta.glob 在测试里有类型(模块边界静态扫描用得上)。
