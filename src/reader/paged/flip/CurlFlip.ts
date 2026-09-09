// 仿真卷页(≈ BookReader PageWidget 的 Canvas 移植)。
//
// 帧合成次序与原版 onDraw 完全一致:
//   1. drawCurrentPageArea      —— path0 之外区域画当前页(evenodd 裁剪)
//   2. drawNextPageAreaAndShadow —— path0 ∩ path1 画下一页 + 背面阴影
//   3. drawCurrentPageShadow    —— 当前页上的两道折痕软阴影
//   4. drawCurrentBackArea      —— path0 ∩ path1 画纸背(反射矩阵 + 暗化)+ 纸背阴影
// 位图来自 snapshot.ts(含预计算的 ColorMatrix 纸背)。

import {
  calcCornerXY,
  calcPoints,
  finishTarget,
  restoreTarget,
  type CurlGeometry,
  type Pt,
} from '../curlGeometry';
import type { FlipCallbacks, FlipHost, FlipStrategy } from './FlipStrategy';
import { animate, easeInOut, easeOut } from './FlipStrategy';
import type { PageBitmaps } from './snapshot';

// GradientDrawable 颜色移植
const BACK_SHADOW = ['rgba(17,17,17,1)', 'rgba(17,17,17,0.067)']; // {0xff111111, 0x111111}
const FRONT_SHADOW = ['rgba(17,17,17,0.5)', 'rgba(17,17,17,0.067)']; // {0x80111111, 0x111111}
const FOLDER_SHADOW = ['rgba(51,51,51,0.2)', 'rgba(51,51,51,0.69)']; // {0x333333, 0xb0333333}

export class CurlFlip implements FlipStrategy {
  private cornerX = 0;
  private cornerY = 0;
  private isRTandLB = false;
  private touch: Pt = { x: 1, y: 1 };
  private stopAnim: (() => void) | null = null;
  private settling = false;
  private ctx: CanvasRenderingContext2D | null = null;
  private dpr = 1;

  constructor(
    private readonly host: FlipHost,
    private readonly cb: FlipCallbacks,
    private readonly bitmaps: { cur: PageBitmaps; next: PageBitmaps },
  ) {}

  begin(dir: 1 | -1, x: number, y: number): boolean {
    // 方向已体现在页角选择(向后翻拖右角,向前翻拖左角)
    const canvas = this.host.canvas;
    if (!canvas || !canvas.getContext) return false;
    this.stop();
    this.settling = false;
    const rect = canvas.getBoundingClientRect();
    const lx = x - rect.left;
    const ly = y - rect.top;
    // 页角选择:向后翻拖右下角,向前翻拖左下角(经典书页习惯)
    const px = dir === 1 ? Math.max(lx, rect.width / 2 + 1) : Math.min(lx, rect.width / 2 - 1);
    const py = Math.max(ly, rect.height / 2 + 1);
    const c = calcCornerXY(rect.width, rect.height, px, py);
    this.cornerX = c.cornerX;
    this.cornerY = c.cornerY;
    this.isRTandLB = c.isRTandLB;
    this.touch = { x: lx, y: ly };
    this.dpr = Math.max(1, window.devicePixelRatio || 1);
    this.ctx = canvas.getContext('2d');
    if (!this.ctx) return false;
    canvas.width = Math.max(1, Math.round(rect.width * this.dpr));
    canvas.height = Math.max(1, Math.round(rect.height * this.dpr));
    canvas.style.visibility = 'visible';
    // 手势期间隐藏 DOM 页,画布全权渲染(位图与 DOM 同尺寸同排版)
    this.host.curPage.style.visibility = 'hidden';
    this.host.nextPage.style.visibility = 'hidden';
    this.drawFrame();
    return true;
  }

  update(x: number, y: number): void {
    if (this.settling || !this.ctx) return;
    const rect = this.host.canvas!.getBoundingClientRect();
    this.touch = { x: x - rect.left, y: y - rect.top };
    this.drawFrame();
  }

  finish(): void {
    if (!this.ctx) return;
    this.settle(finishTarget(this.host.width, this.host.height, this.cornerX, this.cornerY, this.touch), true);
  }

  restore(): void {
    if (!this.ctx) return;
    this.settle(restoreTarget(this.host.width, this.host.height, this.cornerX, this.cornerY), false);
  }

  cancelNow(): void {
    this.stop();
    this.reset();
  }

  private settle(target: Pt, completed: boolean): void {
    this.stop();
    this.settling = true;
    const from: Pt = { ...this.touch };
    const dur = completed ? this.host.durationMs : Math.max(120, this.host.durationMs * 0.45);
    this.stopAnim = animate(
      dur,
      (t) => {
        const e = completed ? easeInOut(t) : easeOut(t);
        this.touch = {
          x: from.x + (target.x - from.x) * e,
          y: from.y + (target.y - from.y) * e,
        };
        this.drawFrame();
      },
      () => {
        this.stopAnim = null;
        this.reset();
        this.cb.onSettled(completed);
      },
    );
  }

  private reset(): void {
    const canvas = this.host.canvas;
    if (canvas) {
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
      canvas.style.visibility = 'hidden';
    }
    this.host.curPage.style.visibility = '';
    this.host.nextPage.style.visibility = '';
    this.ctx = null;
  }

  private stop(): void {
    if (this.stopAnim) {
      this.stopAnim();
      this.stopAnim = null;
    }
  }

  // ---------- 帧渲染 ----------

  private drawFrame(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const { width: w, height: h } = this.host;
    const g = calcPoints(w, h, this.touch.x, this.touch.y, this.cornerX, this.cornerY, this.isRTandLB);

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    this.drawCurrentPageArea(ctx, g);
    this.drawNextPageAreaAndShadow(ctx, g);
    this.drawCurrentPageShadow(ctx, g);
    this.drawCurrentBackArea(ctx, g);
  }

  private pathCurrent(g: CurlGeometry): Path2D {
    const p = new Path2D();
    let first = true;
    for (const seg of g.pathCurrent) {
      if (seg.cmd === 'move') p.moveTo(seg.pts[0].x, seg.pts[0].y);
      else if (seg.cmd === 'line') p.lineTo(seg.pts[0].x, seg.pts[0].y);
      else p.quadraticCurveTo(seg.pts[0].x, seg.pts[0].y, seg.pts[1].x, seg.pts[1].y);
      first = false;
    }
    void first;
    p.closePath();
    return p;
  }

  private pathFold(g: CurlGeometry): Path2D {
    const p = new Path2D();
    for (const seg of g.pathFold) {
      if (seg.cmd === 'move') p.moveTo(seg.pts[0].x, seg.pts[0].y);
      else p.lineTo(seg.pts[0].x, seg.pts[0].y);
    }
    p.closePath();
    return p;
  }

  /** 1. 当前页剩余区域(path0 的补集)。 */
  private drawCurrentPageArea(ctx: CanvasRenderingContext2D, g: CurlGeometry): void {
    const outside = new Path2D();
    outside.rect(-2, -2, this.host.width + 4, this.host.height + 4); // 稍放大避免边缘发丝缝
    const p0 = this.pathCurrent(g);
    outside.addPath(p0);
    ctx.save();
    ctx.clip(outside, 'evenodd'); // ≈ Region.Op.XOR
    ctx.drawImage(this.bitmaps.cur.front, 0, 0, this.host.width, this.host.height);
    ctx.restore();
  }

  /** 2. 折起露出的下一页 + 投到下一页的阴影。 */
  private drawNextPageAreaAndShadow(ctx: CanvasRenderingContext2D, g: CurlGeometry): void {
    const p0 = this.pathCurrent(g);
    const p1 = this.pathFold(g);
    ctx.save();
    ctx.clip(p0);
    ctx.clip(p1); // ≈ INTERSECT
    ctx.drawImage(this.bitmaps.next.front, 0, 0, this.host.width, this.host.height);
    // 背面阴影:沿折线方向的渐变带(旋转后竖直填充)
    const maxLength = Math.hypot(this.host.width, this.host.height);
    const left = g.isRTandLB ? g.bezierStart1.x : g.bezierStart1.x - g.touchToCornerDis / 4;
    const right = g.isRTandLB ? g.bezierStart1.x + g.touchToCornerDis / 4 : g.bezierStart1.x;
    ctx.translate(g.bezierStart1.x, g.bezierStart1.y);
    ctx.rotate((g.degrees * Math.PI) / 180);
    const grad = ctx.createLinearGradient(left, 0, right, 0);
    grad.addColorStop(0, g.isRTandLB ? BACK_SHADOW[0] : BACK_SHADOW[1]);
    grad.addColorStop(1, g.isRTandLB ? BACK_SHADOW[1] : BACK_SHADOW[0]);
    ctx.fillStyle = grad;
    ctx.fillRect(left, 0, right - left, maxLength);
    ctx.restore();
  }

  /** 3. 当前页上的折痕软阴影(两道,沿两条贝塞尔边)。 */
  private drawCurrentPageShadow(ctx: CanvasRenderingContext2D, g: CurlGeometry): void {
    const p0 = this.pathCurrent(g);
    const SHADOW_W = 25;
    // 第一道:沿 bezierControl1 附近
    ctx.save();
    {
      const outside = new Path2D();
      outside.rect(-2, -2, this.host.width + 4, this.host.height + 4);
      outside.addPath(p0);
      ctx.clip(outside, 'evenodd');
      const left = g.isRTandLB ? g.bezierControl1.x : g.bezierControl1.x - SHADOW_W;
      const right = g.isRTandLB ? g.bezierControl1.x + SHADOW_W : g.bezierControl1.x + 1;
      const maxLength = Math.hypot(this.host.width, this.host.height);
      ctx.translate(g.bezierControl1.x, g.bezierControl1.y);
      const rot =
        (Math.atan2(g.touch.x - g.bezierControl1.x, g.bezierControl1.y - g.touch.y) * 180) /
        Math.PI;
      ctx.rotate((rot * Math.PI) / 180);
      const grad = ctx.createLinearGradient(left, 0, right, 0);
      grad.addColorStop(0, g.isRTandLB ? FRONT_SHADOW[0] : FRONT_SHADOW[1]);
      grad.addColorStop(1, g.isRTandLB ? FRONT_SHADOW[1] : FRONT_SHADOW[0]);
      ctx.fillStyle = grad;
      ctx.fillRect(left, -maxLength, right - left, maxLength);
    }
    ctx.restore();
    // 第二道:沿 bezierControl2 附近(水平向)
    ctx.save();
    {
      const outside = new Path2D();
      outside.rect(-2, -2, this.host.width + 4, this.host.height + 4);
      outside.addPath(p0);
      ctx.clip(outside, 'evenodd');
      const maxLength = Math.hypot(this.host.width, this.host.height);
      const c2 = g.bezierControl2;
      const top = g.isRTandLB ? c2.y : c2.y - SHADOW_W;
      const bottom = g.isRTandLB ? c2.y + SHADOW_W : c2.y + 1;
      ctx.translate(c2.x, c2.y);
      const rot =
        (Math.atan2(c2.y - g.touch.y, c2.x - g.touch.x) * 180) / Math.PI;
      ctx.rotate((rot * Math.PI) / 180);
      const grad = ctx.createLinearGradient(0, top, 0, bottom);
      grad.addColorStop(0, g.isRTandLB ? FRONT_SHADOW[0] : FRONT_SHADOW[1]);
      grad.addColorStop(1, g.isRTandLB ? FRONT_SHADOW[1] : FRONT_SHADOW[0]);
      ctx.fillStyle = grad;
      ctx.fillRect(-maxLength, top, maxLength * 2, bottom - top);
    }
    ctx.restore();
  }

  /** 4. 纸背:反射矩阵绘制暗化当前页 + 纸背渐变。 */
  private drawCurrentBackArea(ctx: CanvasRenderingContext2D, g: CurlGeometry): void {
    const p0 = this.pathCurrent(g);
    const p1 = this.pathFold(g);
    ctx.save();
    ctx.clip(p0);
    ctx.clip(p1);

    // 反射:translate(c1) · M · translate(-c1)
    const c1 = g.bezierControl1;
    const { m00, m01, m10, m11 } = g.reflect;
    ctx.translate(c1.x, c1.y);
    ctx.transform(m00, m10, m01, m11, 0, 0);
    ctx.translate(-c1.x, -c1.y);
    ctx.drawImage(this.bitmaps.cur.back, 0, 0, this.host.width, this.host.height);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); // 撤销反射,保留 DPR 基准
    // 还原裁剪(反射后仍需在 p0∩p1 内):重新应用
    ctx.clip(p0);
    ctx.clip(p1);

    // 纸背阴影:折线附近的渐变带
    const i1 = Math.trunc((g.bezierStart1.x + g.bezierControl1.x) / 2);
    const f1 = Math.abs(i1 - g.bezierControl1.x);
    const i2 = Math.trunc((g.bezierStart2.y + g.bezierControl2.y) / 2);
    const f2 = Math.abs(i2 - g.bezierControl2.y);
    const f3 = Math.min(f1, f2);
    const maxLength = Math.hypot(this.host.width, this.host.height);
    const left = g.isRTandLB ? g.bezierStart1.x - 1 : g.bezierStart1.x - f3 - 1;
    const right = g.isRTandLB ? g.bezierStart1.x + f3 + 1 : g.bezierStart1.x + 1;
    ctx.translate(g.bezierStart1.x, g.bezierStart1.y);
    ctx.rotate((g.degrees * Math.PI) / 180);
    const grad = ctx.createLinearGradient(left, 0, right, 0);
    grad.addColorStop(0, g.isRTandLB ? FOLDER_SHADOW[0] : FOLDER_SHADOW[1]);
    grad.addColorStop(1, g.isRTandLB ? FOLDER_SHADOW[1] : FOLDER_SHADOW[0]);
    ctx.fillStyle = grad;
    ctx.fillRect(left, 0, right - left, maxLength);
    ctx.restore();
  }
}
