// 覆盖/平移翻页(≈ BookReader OverlappedWidget / NoAimWidget)。
//
// 语义与原版一致:当前页始终在顶层,向拖拽方向整体平移,
// 目标页垫底从下方露出;移动页边缘带渐变阴影。
// durationMs=0 时退化为 NoAimWidget(瞬翻)。

import type { FlipCallbacks, FlipHost, FlipStrategy } from './FlipStrategy';
import { animate, easeInOut, easeOut } from './FlipStrategy';

export class SlideFlip implements FlipStrategy {
  private dir: 1 | -1 = 1;
  private startX = 0;
  private curDx = 0;
  private stopAnim: (() => void) | null = null;
  private settling = false;

  constructor(
    private readonly host: FlipHost,
    private readonly cb: FlipCallbacks,
  ) {}

  begin(dir: 1 | -1, x: number, y: number): boolean {
    this.stop();
    this.dir = dir;
    this.startX = x;
    this.curDx = 0;
    this.settling = false;
    const { curPage, nextPage } = this.host;
    nextPage.style.transform = 'translateX(0)';
    nextPage.style.visibility = 'visible';
    curPage.style.visibility = 'visible';
    this.apply(0);
    void y;
    return true;
  }

  update(x: number, y: number): void {
    void y;
    if (this.settling) return;
    const dx = x - this.startX;
    // 向后翻(dx≤0,当前页左移);向前翻(dx≥0,当前页右移)
    this.apply(this.dir === 1 ? Math.min(0, dx) : Math.max(0, dx));
  }

  finish(): void {
    const target = this.dir === 1 ? -this.host.width : this.host.width;
    this.settle(target, true);
  }

  restore(): void {
    this.settle(0, false);
  }

  cancelNow(): void {
    this.stop();
    this.resetStyles();
  }

  private settle(target: number, completed: boolean): void {
    this.stop();
    this.settling = true;
    const from = this.curDx;
    const dur = completed ? this.host.durationMs : Math.max(120, this.host.durationMs * 0.45);
    this.stopAnim = animate(
      dur,
      (t) => {
        const e = completed ? easeInOut(t) : easeOut(t);
        this.apply(from + (target - from) * e);
      },
      () => {
        this.stopAnim = null;
        this.resetStyles();
        this.cb.onSettled(completed);
      },
    );
  }

  private apply(dx: number): void {
    this.curDx = dx;
    const { curPage } = this.host;
    curPage.style.transform = `translateX(${dx}px)`;
    // 阴影挂在移动方向的后缘(渐隐带;原版是 10px GradientDrawable)
    const shadowX = this.dir === 1 ? 16 : -16;
    curPage.style.boxShadow = dx === 0 ? '' : `${shadowX}px 0 24px rgba(0,0,0,0.35)`;
  }

  private stop(): void {
    if (this.stopAnim) {
      this.stopAnim();
      this.stopAnim = null;
    }
  }

  private resetStyles(): void {
    const { curPage, nextPage } = this.host;
    curPage.style.transform = '';
    curPage.style.boxShadow = '';
    curPage.style.visibility = '';
    nextPage.style.transform = '';
    nextPage.style.visibility = 'hidden'; // 非手势期间不遮挡(也避免重复内容被读屏)
  }
}
