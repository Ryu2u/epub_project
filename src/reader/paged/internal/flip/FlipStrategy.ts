// 内部实现,勿从外部直接导入 —— 对外入口见 ../../index.ts(只公开 PagedReaderView / FlipStyle)。
// 翻页策略接口。
//
// 生命周期:begin(准备两页)→ update(拖动帧)→ finish(完成)/ restore(回弹),
// 结束后通过 onSettled 通知视图提交页变更或复原。
// 手势层(gestures.ts)与策略层完全解耦:策略只管画,不管输入。

export interface FlipCallbacks {
  /** 动画落定:completed=true 翻页成立(视图提交页变更);false=回弹复原 */
  onSettled(completed: boolean): void;
}

export interface FlipHost {
  width: number;
  height: number;
  /** 完成动画时长(ms);0 = 无动画瞬翻 */
  durationMs: number;
  /** 当前页元素(平移模式下整体平移的就是它) */
  curPage: HTMLElement;
  /** 被揭示的页元素(内容为目标页) */
  nextPage: HTMLElement;
}

export interface FlipStrategy {
  /**
   * 开始翻页。dir=+1 向后(下一页),-1 向前(上一页)。
   * (x, y) 为按下点(视口坐标,策略内部换算为 stage 局部坐标)。
   * 返回 false 表示未就绪(如位图尚不可用),调用方应降级。
   */
  begin(dir: 1 | -1, x: number, y: number): boolean;
  /** 拖动帧(视口坐标) */
  update(x: number, y: number): void;
  /** 松手:自动完成翻页 */
  finish(): void;
  /** 松手:回弹复原 */
  restore(): void;
  /** 立即复位(模式切换/卸载时) */
  cancelNow(): void;
}

/** 通用缓动(Scroller 的插值替代)。 */
export function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (1 - t) * (2 - (2 * t));
}

export function easeOut(t: number): number {
  return 1 - (1 - t) * (1 - t);
}

/** rAF 动画驱动:把 [0,1] 的进度回调给调用方,结束回调 onDone。 */
export function animate(
  durationMs: number,
  onFrame: (t: number) => void,
  onDone: () => void,
): () => void {
  if (durationMs <= 0) {
    onFrame(1);
    onDone();
    return () => undefined;
  }
  let raf = 0;
  let cancelled = false;
  const start = performance.now();
  const tick = () => {
    if (cancelled) return;
    const now = performance.now();
    const t = Math.min(1, (now - start) / durationMs);
    onFrame(t);
    if (t >= 1) {
      cancelled = true;
      onDone();
      return;
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => {
    if (!cancelled) {
      cancelled = true;
      cancelAnimationFrame(raf);
    }
  };
}
