// Reader 设置面板：右侧滑入的 sheet（仿 iOS 风格）。
// 用 CSS transform + transition 实现，避免引入动画库。

import { useEffect } from 'react';
import {
  FONTS,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  LINE_HEIGHT_LABELS,
  LINE_HEIGHTS,
  THEMES,
  type Font,
  type LineHeight,
  type Theme,
} from '../lib/readerPrefs';

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
  // ESC 关闭
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <>
      {/* 背景遮罩（点击关闭） */}
      <div
        onClick={onClose}
        className={[
          'fixed inset-0 z-40 bg-black/30 transition-opacity duration-200',
          open ? 'opacity-100' : 'opacity-0 pointer-events-none',
        ].join(' ')}
        aria-hidden="true"
      />
      {/* Sheet */}
      <aside
        role="dialog"
        aria-label="阅读设置"
        className={[
          'fixed top-0 right-0 bottom-0 z-50 w-full max-w-sm',
          'transition-transform duration-200 ease-out',
          open ? 'translate-x-0' : 'translate-x-full',
        ].join(' ')}
        style={{ backgroundColor: 'var(--bg)', color: 'var(--fg)' }}
      >
        <div className="h-full flex flex-col">
          <header className="flex items-center justify-between px-4 py-3 border-b border-black/10">
            <h2 className="text-lg font-semibold">阅读设置</h2>
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1 rounded-md text-sm hover:bg-black/5"
              aria-label="关闭"
            >
              ✕
            </button>
          </header>

          <div className="flex-1 overflow-y-auto px-4 py-4 space-y-6">
            {/* 字号 */}
            <Section label="字号">
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => onFontSizeChange(fontSize - 1)}
                  disabled={fontSize <= FONT_SIZE_MIN}
                  className="w-9 h-9 rounded-md border border-black/10 hover:bg-black/5 disabled:opacity-30"
                  aria-label="字号缩小"
                >
                  −
                </button>
                <div className="flex-1 text-center tabular-nums">{fontSize}px</div>
                <button
                  type="button"
                  onClick={() => onFontSizeChange(fontSize + 1)}
                  disabled={fontSize >= FONT_SIZE_MAX}
                  className="w-9 h-9 rounded-md border border-black/10 hover:bg-black/5 disabled:opacity-30"
                  aria-label="字号放大"
                >
                  +
                </button>
              </div>
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

            {/* 行间距 */}
            <Section label="行间距">
              <SegmentedControl<LineHeight>
                value={lineHeight}
                options={(['small', 'medium', 'large'] as const).map((v) => ({
                  value: v,
                  label: LINE_HEIGHT_LABELS[v],
                  preview: LINE_HEIGHTS[v],
                }))}
                onChange={onLineHeightChange}
              />
            </Section>

            {/* 主题 */}
            <Section label="主题">
              <SegmentedControl<Theme>
                value={theme}
                options={(['light', 'sepia', 'dark'] as const).map((v) => ({
                  value: v,
                  label: THEMES[v].label,
                  swatch: THEMES[v],
                }))}
                onChange={onThemeChange}
              />
            </Section>

            {/* 字体 */}
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

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="text-sm font-medium opacity-70 mb-2">{label}</h3>
      {children}
    </section>
  );
}

interface SegmentOption<V> {
  value: V;
  label: string;
  preview?: string; // 行间距：用数字预览
  swatch?: { bg: string; fg: string }; // 主题：色块
}

function SegmentedControl<V extends string>({
  value,
  options,
  onChange,
}: {
  value: V;
  options: SegmentOption<V>[];
  onChange: (v: V) => void;
}) {
  return (
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
              selected
                ? 'border-current opacity-100'
                : 'border-black/10 opacity-70 hover:opacity-100',
            ].join(' ')}
            aria-pressed={selected}
          >
            {opt.swatch && (
              <span
                className="block w-8 h-5 rounded border border-black/10"
                style={{ backgroundColor: opt.swatch.bg }}
              />
            )}
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