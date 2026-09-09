// 平移翻页(轮播式左右平移)。
//
// 两种语义(对应设置里的「平移」与「覆盖」):
//   - slide(平移):双页刚性平移 —— 当前页滑出屏幕的同时,
//     下一页从同侧滑入,像一条纸带整体移动(微信读书式);
//   - cover(覆盖):当前页不动,新页从侧面滑入盖在上方,带投影;
//   - durationMs = 0 时退化为瞬翻(原 NoAimWidget 语义)。
//
// 拖拽参数化:dx ∈ [-W, W],前进方向 dx ≤ 0(向左),后退 dx ≥ 0(向右)。
// 进入页初始偏移 side = dir * W(前进从右侧 +W 进入,后退从左侧 -W 进入)。

import type { FlipCallbacks, FlipHost, FlipStrategy } from './FlipStrategy';
import { animate, easeInOut, easeOut } from './FlipStrategy';

export type SlideMode = 'slide' | 'cover';

export class SlideFlip implements FlipStrategy {
  private dir: 1 | -1 = 1;
  private startX = 0;
  private dx = 0;
  private stopAnim: (() => void) | null = null;
  private settling = false;

  constructor(
    private readonly host: FlipHost,
    private readonly cb: FlipCallbacks,
    private readonly mode: SlideMode,
  ) {}

  begin(dir: 1 | -1, x: number, y: number): boolean {
    this.stop();
    this.resetStyles(); // 清掉上次手势的残留(z-index/隐藏态)
    this.dir = dir;
    this.startX = x;
    this.dx = 0;
    this.settling = false;
    const { nextPage } = this.host;
    if (!nextPage) return false;
    nextPage.style.visibility = 'visible';
    // cover 模式新页要在当前页之上(z 轴压过 .paged-page-cur 的 2)
    nextPage.style.zIndex = this.mode === 'cover' ? '3' : '';
    this.apply(0);
    void y;
    return true;
  }

  update(x: number, y: number): void {
    void y;
    if (this.settling) return;
    let dx = x - this.startX;
    // 只接受拖拽方向上的位移:前进(右缘起)只向左,后退(左缘起)只向右
    dx = this.dir === 1 ? Math.min(0, dx) : Math.max(0, dx);
    dx = Math.max(-this.host.width, Math.min(this.host.width, dx));
    this.apply(dx);
  }

  finish(): void {
    this.settle(this.dir === 1 ? -this.host.width : this.host.width, true);
  }

  restore(): void {
    this.settle(0, false);
  }

  cancelNow(): void {
    this.stop();
    this.resetStyles();
  }

  /**
   * 复位所有手势样式(供视图在完成内容交接后调用)。
   * 完成路径不在动画结束时自动调用:若先复位旧页/隐藏新页,
   * 视图换内容前的一帧会露出旧页文字(实测「闪一下」)。
   */
  cleanup(): void {
    this.stop();
    this.resetStyles();
  }

  private settle(target: number, completed: boolean): void {
    this.stop();
    this.settling = true;
    const from = this.dx;
    const dur = completed ? this.host.durationMs : Math.max(120, this.host.durationMs * 0.45);
    this.stopAnim = animate(
      dur,
      (t) => {
        const e = completed ? easeInOut(t) : easeOut(t);
        this.apply(from + (target - from) * e);
      },
      () => {
        this.stopAnim = null;
        if (completed) {
          // 新页正停在最终位置:保持现状,交由视图在同一同步块内
          // 完成「cur 换新内容 → cleanup()」,中间不产生绘制
          this.settling = false;
          this.cb.onSettled(true);
        } else {
          this.resetStyles();
          this.cb.onSettled(false);
        }
      },
    );
  }

  private apply(dx: number): void {
    this.dx = dx;
    const cur = this.host.curPage;
    const next = this.host.nextPage;
    if (!cur || !next) return; // 卸载竞态:元素已脱离
    const { width } = this.host;
    const side = this.dir * width; // 进入页初始偏移
    next.style.transform = `translateX(${side + dx}px)`;
    if (this.mode === 'slide') {
      // 纸带平移:两页一起动
      cur.style.transform = `translateX(${dx}px)`;
      cur.style.boxShadow = dx === 0 ? '' : '0 0 18px rgba(0,0,0,0.28)';
      next.style.boxShadow = '';
    } else {
      // 覆盖:只有新页动,投影跟随
      cur.style.transform = '';
      next.style.boxShadow = dx === 0 ? '' : '0 0 18px rgba(0,0,0,0.30)';
    }
  }

  private stop(): void {
    if (this.stopAnim) {
      this.stopAnim();
      this.stopAnim = null;
    }
  }

  private resetStyles(): void {
    const cur = this.host.curPage;
    const next = this.host.nextPage;
    if (!cur || !next) return; // 卸载竞态:元素已脱离
    cur.style.transform = '';
    cur.style.boxShadow = '';
    next.style.transform = '';
    next.style.boxShadow = '';
    next.style.zIndex = '';
    next.style.visibility = 'hidden'; // 非手势期间不遮挡(也避免读屏重复内容)
  }
}
