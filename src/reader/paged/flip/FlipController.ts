// FlipController —— 翻页策略调度 + 降级链。
//
// 降级链(设计文档 §6):仿真(curl)→ 位图未就绪/失败 → 覆盖(cover)。
// BookReader 用三个 Widget 子类 + instanceof 特判达成同样效果,
// 这里用组合:控制器按风格实例化策略,curl 失败自动回落 slide。

import type { FlipStyle } from '../types';
import { CurlFlip } from './CurlFlip';
import type { FlipHost, FlipStrategy } from './FlipStrategy';
import { SlideFlip } from './SlideFlip';
import type { PageBitmaps } from './snapshot';

export interface FlipControllerHost extends FlipHost {
  /** 仿真位图(cur=当前页,next=被揭示页);未就绪返回 null。 */
  getBitmaps(): { cur: PageBitmaps; next: PageBitmaps } | null;
  /** 触发空闲预热(下次手势可用仿真)。 */
  requestPrewarm(): void;
}

export class FlipController {
  private slide: SlideFlip | null = null;
  private active: FlipStrategy | null = null;
  /** 快照彻底失败(如 foreignObject 不可用)→ 本会话永久用覆盖。 */
  private curlBroken = false;
  /** 预热快照失败次数:超过 2 次判死。 */
  private prewarmFailures = 0;

  constructor(
    private host: FlipControllerHost,
    private style: FlipStyle,
    private cb: { onSettled(completed: boolean, dir: 1 | -1): void },
    private onMarkCurlBroken?: () => void,
  ) {}

  setStyle(style: FlipStyle): void {
    this.cancelNow();
    this.style = style;
  }

  begin(dir: 1 | -1, x: number, y: number): boolean {
    this.cancelNow();
    if (this.style === 'curl' && !this.curlBroken) {
      const bitmaps = this.host.getBitmaps();
      if (bitmaps) {
        const curl = new CurlFlip(this.host, {
          onSettled: (completed) => this.cb.onSettled(completed, dir),
        }, bitmaps);
        if (curl.begin(dir, x, y)) {
          this.active = curl;
          return true;
        }
      } else {
        this.host.requestPrewarm(); // 下次就有了
      }
    }
    // cover/slide/none 或 curl 未就绪 → slide(duration 区分)
    if (!this.slide) {
      this.slide = new SlideFlip(this.host, {
        onSettled: (completed) => this.cb.onSettled(completed, dir),
      });
    }
    this.active = this.slide;
    return this.slide.begin(dir, x, y);
  }

  update(x: number, y: number): void {
    this.active?.update(x, y);
  }

  finish(): void {
    this.active?.finish();
  }

  restore(): void {
    this.active?.restore();
  }

  cancelNow(): void {
    this.active?.cancelNow();
    this.active = null;
  }

  /** 预热失败上报(超过阈值断定环境不支持,停用 curl)。 */
  reportPrewarmFailure(): void {
    this.prewarmFailures += 1;
    if (this.prewarmFailures >= 2 && !this.curlBroken) {
      this.curlBroken = true;
      this.onMarkCurlBroken?.();
    }
  }

  get isCurlActive(): boolean {
    return this.active instanceof CurlFlip;
  }
}
