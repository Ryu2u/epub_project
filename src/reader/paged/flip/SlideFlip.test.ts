// SlideFlip 单测:核心是「完成路径不提前复位」的防闪屏契约 ——
// finish() 落定时 next(新页)必须仍停在最终位置且可见,
// 由视图在同一同步块内完成内容交接后再 cleanup()。
// 否则旧页会在换内容前的一帧露出(实测「翻页完成闪一下上个页面」)。

import { describe, expect, it, vi } from 'vitest';
import type { FlipHost } from './FlipStrategy';
import { SlideFlip } from './SlideFlip';

function makeHost(width = 400): { host: FlipHost; cur: HTMLElement; next: HTMLElement } {
  const cur = document.createElement('div');
  const next = document.createElement('div');
  const host: FlipHost = { width, height: 600, durationMs: 0, curPage: cur, nextPage: next };
  return { host, cur, next };
}

describe('SlideFlip 完成路径不提前复位(防闪屏契约)', () => {
  it('平移:finish 落定时新页停在最终位置且可见,旧页仍在屏幕外', () => {
    const { host, cur, next } = makeHost();
    const onSettled = vi.fn();
    const flip = new SlideFlip(host, { onSettled }, 'slide');

    expect(flip.begin(1, 100, 100)).toBe(true); // 前进翻页
    flip.update(60, 100); // 向左拖 40px
    flip.finish(); // durationMs = 0 → 同步落定

    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledWith(true);
    // 契约:onSettled 触发时不得复位
    expect(next.style.visibility).toBe('visible'); // 新页可见
    expect(next.style.transform).toBe('translateX(0px)'); // 新页在最终位置
    expect(cur.style.transform).toBe('translateX(-400px)'); // 旧页还在屏幕外
  });

  it('cleanup() 复位全部手势样式并隐藏 next', () => {
    const { host, cur, next } = makeHost();
    const flip = new SlideFlip(host, { onSettled: vi.fn() }, 'slide');
    flip.begin(1, 100, 100);
    flip.update(60, 100);
    flip.finish();
    flip.cleanup();

    expect(next.style.visibility).toBe('hidden');
    expect(next.style.transform).toBe('');
    expect(next.style.zIndex).toBe('');
    expect(cur.style.transform).toBe('');
    expect(cur.style.boxShadow).toBe('');
  });

  it('回弹路径:动画结束即复位(无需视图交接)', async () => {
    const { host, cur, next } = makeHost();
    const onSettled = vi.fn();
    const flip = new SlideFlip(host, { onSettled }, 'slide');
    flip.begin(1, 100, 100);
    flip.update(60, 100);
    flip.restore(); // 回弹有 ≥120ms 最小时长,异步落定

    await vi.waitFor(() => expect(onSettled).toHaveBeenCalledWith(false));
    expect(next.style.visibility).toBe('hidden');
    expect(cur.style.transform).toBe(''); // 旧页回原位(内容未变,无闪屏)
  });

  it('覆盖模式:新页 zIndex 压过当前页,完成后同样不提前复位', () => {
    const { host, cur, next } = makeHost();
    const onSettled = vi.fn();
    const flip = new SlideFlip(host, { onSettled }, 'cover');
    flip.begin(1, 100, 100);
    expect(next.style.zIndex).toBe('3'); // 盖在 cur(z-2)之上
    flip.update(60, 100);
    flip.finish();

    expect(onSettled).toHaveBeenCalledWith(true);
    expect(next.style.visibility).toBe('visible');
    expect(next.style.transform).toBe('translateX(0px)');
    expect(cur.style.transform).toBe(''); // 覆盖模式当前页不动
  });

  it('begin() 会清掉上次手势残留', () => {
    const { host, cur, next } = makeHost();
    const flip = new SlideFlip(host, { onSettled: vi.fn() }, 'cover');
    flip.begin(1, 100, 100);
    flip.finish();
    // 未 cleanup 的残留状态下直接开新手势
    flip.begin(-1, 100, 100); // 后退:新页从左侧进入
    expect(next.style.visibility).toBe('visible');
    expect(next.style.transform).toBe('translateX(-400px)'); // side = -W
    flip.cleanup();
    expect(next.style.zIndex).toBe(''); // cover 的 z-index 残留被清
    void cur;
  });

  it('拖拽只接受既定方向:前进翻向左拖才有效', () => {
    const { host, cur } = makeHost();
    const flip = new SlideFlip(host, { onSettled: vi.fn() }, 'slide');
    flip.begin(1, 100, 100);
    flip.update(300, 100); // 反向拖(向右)→ 位移被钳为 0
    expect(cur.style.transform).toBe('translateX(0px)');
  });
});
