// 手势状态机 —— BookReader BaseReadView.onTouchEvent 的 Pointer Events 移植。
//
// 交互规则(与原版一致):
//   - 按下落在「中央 1/3 × 中央 1/3」区域 → center 模式,不翻页;
//     松手位移 < 5px 触发 onCenterClick(呼出/隐藏菜单)
//   - 左 1/3 按下 → 向前翻(dir=-1);右 1/3 按下 → 向后翻(dir=+1);
//     (顶部/底部条带按左右半屏归属)
//   - MOVE 中 cancel = 最近一步朝起点方向回撤 → 松手时回弹
//   - UP:位移 < 10px 且 < 1s → 单击翻页(由策略自动完成动画);
//         位移 < 10px 且 ≥ 1s → 长按回弹;位移大 → cancel ? 回弹 : 完成

export interface GestureOptions {
  getWidth(): number;
  getHeight(): number;
  /** 中央点击(菜单) */
  onCenterClick(): void;
  /**
   * 开始一次翻页(dir: +1 向后/下一页,-1 向前/上一页)。
   * 返回 false 表示该方向无页可翻(手势转为无效,不会收到 move/end;
   * 若该方向存在跨章目标,松手点击时会收到 onBoundaryTap)。
   */
  onFlipStart(dir: 1 | -1, x: number, y: number): boolean;
  onFlipMove(x: number, y: number): void;
  /** cancel=回弹;tap=单击触发的自动完成(策略可用 0ms 瞬翻) */
  onFlipEnd(cancel: boolean, tap: boolean): void;
  /** 章节边界处的点击(跨章跳转入口);仅当 onFlipStart 返回 false 后生效 */
  onBoundaryTap?(dir: 1 | -1): void;
}

const CENTER_TAP_SLOP = 5; // 中央点击判定半径(px)
const TAP_SLOP = 10; // 单击/长按判定半径(px)
const TAP_TIME_MS = 1000; // 单击最长按压时间

export function attachGestures(el: HTMLElement, opts: GestureOptions): () => void {
  let active = false;
  let center = false;
  let cancel = false;
  let downX = 0;
  let downY = 0;
  let lastX = 0;
  let downTime = 0;
  let dir: 1 | -1 = 1;
  // onFlipStart 失败但该方向存在跨章目标:记录方向,松手点击时上报
  let boundaryDir: 1 | -1 | null = null;

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return; // 只响应左键
    const w = opts.getWidth();
    const h = opts.getHeight();
    downX = e.clientX;
    downY = e.clientY;
    lastX = downX;
    downTime = Date.now();
    cancel = false;

    // 中央 1/3 × 中央 1/3 → 菜单区(与屏幕坐标无关:调用方保证 el 铺满 stage)
    const rect = el.getBoundingClientRect();
    const lx = e.clientX - rect.left;
    const ly = e.clientY - rect.top;
    center =
      lx >= w / 3 && lx <= (w * 2) / 3 && ly >= h / 3 && ly <= (h * 2) / 3;

    if (center) {
      active = true; // center 也要收 UP(判定点击)
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* 已释放等场景 */
      }
      return;
    }

    dir = lx < w / 2 ? -1 : 1;
    active = opts.onFlipStart(dir, e.clientX, e.clientY);
    if (active) {
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* 同上 */
      }
    } else {
      // 无页可翻:仍需跟踪 UP 判定「点击」以支持跨章跳转
      boundaryDir = dir;
      downX = e.clientX;
      downY = e.clientY;
      downTime = Date.now();
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* 同上 */
      }
    }
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!active || center) return;
    // cancel:最近一步向起点侧回撤(向前翻却往左撤 / 向后翻却往右撤)
    cancel = dir === -1 ? e.clientX < lastX : e.clientX > lastX;
    lastX = e.clientX;
    opts.onFlipMove(e.clientX, e.clientY);
  };

  const finish = (e: PointerEvent, canceled: boolean) => {
    active = false;
    const centerWas = center;
    center = false;
    try {
      el.releasePointerCapture(e.pointerId);
    } catch {
      /* 未捕获 */
    }
    if (centerWas) {
      if (
        Math.abs(e.clientX - downX) < CENTER_TAP_SLOP &&
        Math.abs(e.clientY - downY) < CENTER_TAP_SLOP
      ) {
        opts.onCenterClick();
      }
      return;
    }
    const dt = Date.now() - downTime;
    const moved =
      Math.abs(e.clientX - downX) >= TAP_SLOP || Math.abs(e.clientY - downY) >= TAP_SLOP;
    if (!moved && dt < TAP_TIME_MS) {
      opts.onFlipEnd(false, true); // 单击 → 自动完成
    } else if (!moved) {
      opts.onFlipEnd(true, false); // 长按 → 回弹
    } else {
      opts.onFlipEnd(canceled || cancel, false);
    }
  };

  const onPointerUp = (e: PointerEvent) => {
    if (boundaryDir !== null) {
      const dt = Date.now() - downTime;
      const moved =
        Math.abs(e.clientX - downX) >= TAP_SLOP || Math.abs(e.clientY - downY) >= TAP_SLOP;
      if (!moved && dt < TAP_TIME_MS) opts.onBoundaryTap?.(boundaryDir);
      boundaryDir = null;
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        /* 未捕获 */
      }
      return;
    }
    if (!active) return;
    finish(e, false);
  };
  const onPointerCancel = (e: PointerEvent) => {
    boundaryDir = null;
    if (!active) return;
    finish(e, true);
  };

  // 拖拽期间禁掉原生手势/选择(touch-action 由 CSS 控制,这里双保险)
  const onDragStart = (e: Event) => e.preventDefault();

  el.addEventListener('pointerdown', onPointerDown);
  el.addEventListener('pointermove', onPointerMove);
  el.addEventListener('pointerup', onPointerUp);
  el.addEventListener('pointercancel', onPointerCancel);
  el.addEventListener('dragstart', onDragStart);

  return () => {
    el.removeEventListener('pointerdown', onPointerDown);
    el.removeEventListener('pointermove', onPointerMove);
    el.removeEventListener('pointerup', onPointerUp);
    el.removeEventListener('pointercancel', onPointerCancel);
    el.removeEventListener('dragstart', onDragStart);
  };
}
