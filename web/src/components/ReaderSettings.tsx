// Reader 设置面板：右侧滑入的 sheet（仿 iOS 风格）。
// 用 CSS transform + transition 实现，避免引入动画库。
// 组件采用"受控模式"：所有状态由父组件通过 props 传入，
// 本组件只负责 UI 展示和事件回调，不管理任何状态。

import { useEffect } from 'react';
import {
  FONTS,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  LINE_HEIGHT_LABELS,
  LINE_HEIGHTS,
  THEMES,
  type Font,          // type-only 导入，编译后不产生运行时代码
  type LineHeight,
  type Theme,
} from '../lib/readerPrefs';

// Props 接口：包含所有阅读设置值 + 对应的变更回调。
// open/onClose 控制面板的显示/隐藏。
// onXxxChange 是"受控组件"模式的标准命名：父组件传入当前值和变更处理函数。
export interface ReaderSettingsProps {
  open: boolean;
  onClose: () => void;
  fontSize: number;
  lineHeight: LineHeight;
  theme: Theme;
  font: Font;
  onFontSizeChange: (n: number) => void;
  onLineHeightChange: (v: LineHeight) => void;
  onThemeChange: (v: Theme) => void;
  onFontChange: (v: Font) => void;
}

export function ReaderSettings({
  open,
  onClose,
  fontSize,
  lineHeight,
  theme,
  font,
  onFontSizeChange,
  onLineHeightChange,
  onThemeChange,
  onFontChange,
}: ReaderSettingsProps) {
  // ESC 键关闭面板。
  // useEffect 的依赖数组 [open, onClose]：只有 open 或 onClose 变化时才重新注册监听。
  // open 为 false 时直接 return（不注册），避免隐藏状态下的无效事件监听。
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    // cleanup 函数：React 在组件卸载或依赖变化时调用，移除事件监听防止内存泄漏
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // 使用 Fragment (<>) 包裹两个同级元素：遮罩层和 Sheet 面板
  return (
    <>
      {/* 背景遮罩：点击可关闭面板 */}
      <div
        onClick={onClose}
        className={[
          'fixed inset-0 z-40 bg-black/30 transition-opacity duration-200',
          // open 时显示（opacity-100），关闭时隐藏（opacity-0 + pointer-events-none）
          // pointer-events-none 让隐藏的遮罩不拦截鼠标点击
          open ? 'opacity-100' : 'opacity-0 pointer-events-none',
        ].join(' ')}
        aria-hidden="true"
      />
      {/* Sheet 面板：从右侧滑入的设置面板 */}
      <aside
        role="dialog"
        aria-label="阅读设置"
        className={[
          'fixed top-0 right-0 bottom-0 z-50 w-full max-w-sm',
          'transition-transform duration-200 ease-out',
          // translate-x-0 = 完全可见，translate-x-full = 完全滑出到右侧外
          open ? 'translate-x-0' : 'translate-x-full',
        ].join(' ')}
        // CSS 变量（--bg, --fg）由主题系统动态设置，实现跟随主题的背景/文字颜色
        style={{ backgroundColor: 'var(--bg)', color: 'var(--fg)' }}
      >
        <div className="h-full flex flex-col">
          {/* 面板头部：标题 + 关闭按钮 */}
          <header className="flex items-center justify-between px-4 py-3 border-b border-black/10">
            <h2 className="font-display text-lg font-semibold">阅读设置</h2>
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1 rounded-md text-sm hover:bg-black/5"
              aria-label="关闭"
            >
              ✕
            </button>
          </header>

          {/* 可滚动的内容区域：overflow-y-auto 允许内容超出时纵向滚动 */}
          <div className="flex-1 overflow-y-auto px-4 py-4 space-y-6">
            {/* 字号调节：包含 -/+ 按钮和滑块 */}
            <Section label="字号">
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => onFontSizeChange(fontSize - 1)}
                  disabled={fontSize <= FONT_SIZE_MIN} // 到达最小值时禁用缩小按钮
                  className="w-9 h-9 rounded-md border border-black/10 hover:bg-black/5 disabled:opacity-30"
                  aria-label="字号缩小"
                >
                  −
                </button>
                {/* tabular-nums 让数字等宽，避免字号变化时布局跳动 */}
                <div className="flex-1 text-center tabular-nums">{fontSize}px</div>
                <button
                  type="button"
                  onClick={() => onFontSizeChange(fontSize + 1)}
                  disabled={fontSize >= FONT_SIZE_MAX} // 到达最大值时禁用放大按钮
                  className="w-9 h-9 rounded-md border border-black/10 hover:bg-black/5 disabled:opacity-30"
                  aria-label="字号放大"
                >
                  +
                </button>
              </div>
              {/* 滑块：type="range" 提供拖拽式数值选择 */}
              <input
                type="range"
                min={FONT_SIZE_MIN}
                max={FONT_SIZE_MAX}
                step={1}
                value={fontSize}
                onChange={(e) => onFontSizeChange(parseInt(e.target.value, 10))}
                className="w-full mt-3"
                aria-label="字号滑块"
              />
            </Section>

            {/* 行间距：使用分段控制器（SegmentedControl）切换三个预设值 */}
            <Section label="行间距">
              {/* 泛型组件 <LineHeight>：传入类型参数，确保 value 和 onChange 的类型一致 */}
              {/* 将三个选项映射为 SegmentOption 数组，包含值、标签和预览数值 */}
              <SegmentedControl<LineHeight>
                value={lineHeight}
                options={(['small', 'medium', 'large'] as const).map((v) => ({
                  value: v,
                  label: LINE_HEIGHT_LABELS[v],
                  preview: LINE_HEIGHTS[v],  // preview 用于在按钮中显示行高数值
                }))}
                onChange={onLineHeightChange}
              />
            </Section>

            {/* 主题：分段控制器 + 色块预览 */}
            <Section label="主题">
              <SegmentedControl<Theme>
                value={theme}
                options={(['light', 'sepia', 'dark'] as const).map((v) => ({
                  value: v,
                  label: THEMES[v].label,
                  swatch: THEMES[v],         // swatch 用于在按钮中显示颜色色块
                }))}
                onChange={onThemeChange}
              />
            </Section>

            {/* 字体：分段控制器 */}
            <Section label="字体">
              <SegmentedControl<Font>
                value={font}
                options={(['system', 'serif', 'sans'] as const).map((v) => ({
                  value: v,
                  label: FONTS[v].label,
                }))}
                onChange={onFontChange}
              />
            </Section>
          </div>
        </div>
      </aside>
    </>
  );
}

// 分组小标题组件。
// children 是 React 的特殊 prop，代表组件标签之间的嵌套内容。
// 这是一个纯展示组件，没有状态管理。
function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="text-sm font-medium opacity-70 mb-2">{label}</h3>
      {children}
    </section>
  );
}

// 分段控制器的选项类型。
// 泛型 <V extends string> 约束 V 必须是字符串类型，这样 opt.value 可以与外部传入的类型联动。
interface SegmentOption<V> {
  value: V;
  label: string;
  preview?: string;               // 行间距：用数字字符串做预览（如 '1.7'）
  swatch?: { bg: string; fg: string }; // 主题：用颜色色块做预览
}

// 通用分段控制器组件。
// 泛型 <V extends string>：V 由调用方通过 <SegmentedControl<Theme>> 等方式指定，
// 确保 value 和 onChange 的类型在编译期一致（类型安全的通用组件）。
function SegmentedControl<V extends string>({
  value,
  options,
  onChange,
}: {
  value: V;
  options: SegmentOption<V>[];  // 选项数组
  onChange: (v: V) => void;     // 选中项变化时的回调
}) {
  return (
    // 三列网格布局（grid-cols-3），所有阅读设置刚好三个选项
    <div className="grid grid-cols-3 gap-2">
      {options.map((opt) => {
        const selected = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className={[
              'flex flex-col items-center justify-center gap-1 px-2 py-2 rounded-md border text-sm',
              // 选中态：边框高亮 + 不透明；未选中：淡化 + hover 恢复
              selected
                ? 'border-current opacity-100'
                : 'border-black/10 opacity-70 hover:opacity-100',
            ].join(' ')}
            aria-pressed={selected}  // 无障碍：告知屏幕阅读器按钮的按下状态
          >
            {/* 色块预览（仅主题选项有） */}
            {opt.swatch && (
              <span
                className="block w-8 h-5 rounded border border-black/10"
                style={{ backgroundColor: opt.swatch.bg }}
              />
            )}
            {/* 数字预览（仅行间距选项有）：用字号模拟行高效果 */}
            {opt.preview ? (
              <span style={{ fontSize: `${opt.preview}em` }}>字</span>
            ) : (
              <span>{opt.label}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}