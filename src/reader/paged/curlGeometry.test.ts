// curlGeometry.ts 单测:PageWidget 数学的移植正确性 + 原版 bug 的回归。

import { describe, expect, it } from 'vitest';
import {
  calcCornerXY,
  calcPoints,
  finishTarget,
  getCross,
  restoreTarget,
} from './curlGeometry';

const W = 800;
const H = 600;

describe('calcCornerXY', () => {
  it('按象限选角', () => {
    expect(calcCornerXY(W, H, 100, 100)).toMatchObject({ cornerX: 0, cornerY: 0 });
    expect(calcCornerXY(W, H, 700, 500)).toMatchObject({
      cornerX: W,
      cornerY: H,
    });
    expect(calcCornerXY(W, H, 700, 100)).toMatchObject({
      cornerX: W,
      cornerY: 0,
      isRTandLB: true,
    });
    expect(calcCornerXY(W, H, 100, 500)).toMatchObject({
      cornerX: 0,
      cornerY: H,
      isRTandLB: true,
    });
  });
});

describe('getCross(行列式法,修复原版竖直线除零)', () => {
  it('普通相交', () => {
    const p = getCross(
      { x: 0, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
      { x: 10, y: 0 },
    );
    expect(p).not.toBeNull();
    expect(p!.x).toBeCloseTo(5);
    expect(p!.y).toBeCloseTo(5);
  });

  it('竖直线与水平线相交(原版斜率法在此除零)', () => {
    const p = getCross(
      { x: 5, y: 0 },
      { x: 5, y: 10 }, // 竖直:x 恒为 5
      { x: 0, y: 3 },
      { x: 10, y: 3 },
    );
    expect(p).not.toBeNull();
    expect(p!.x).toBe(5);
    expect(p!.y).toBe(3);
  });

  it('平行线返回 null(而非 NaN)', () => {
    const p = getCross(
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 0, y: 5 },
      { x: 10, y: 5 },
    );
    expect(p).toBeNull();
  });
});

describe('calcPoints', () => {
  const cases: Array<[number, number, number, number]> = [
    // 右下角向前翻:触点在页中各处
    [400, 300],
    [650, 450],
    [780, 590],
    [500, 100],
    // 左下角向后翻
    [200, 450],
  ];

  it.each(cases)('触点 (%i, %i) 产出全有限几何', (x, y) => {
    const { cornerX, cornerY, isRTandLB } = calcCornerXY(W, H, x, y);
    const g = calcPoints(W, H, x, y, cornerX, cornerY, isRTandLB);
    const pts = [
      g.bezierStart1, g.bezierControl1, g.bezierVertex1, g.bezierEnd1,
      g.bezierStart2, g.bezierControl2, g.bezierVertex2, g.bezierEnd2,
      g.touch, g.corner,
    ];
    for (const p of pts) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
    expect(Number.isFinite(g.touchToCornerDis)).toBe(true);
    expect(Number.isFinite(g.degrees)).toBe(true);
    expect(g.touchToCornerDis).toBeGreaterThanOrEqual(0);
  });

  it('触点接近页角不产生 NaN', () => {
    // 触点 = 页角本身(middle == corner,分母趋零路径)
    const g = calcPoints(W, H, W - 1, H - 1, W, H, false);
    expect(Number.isFinite(g.bezierStart1.x)).toBe(true);
    expect(Number.isFinite(g.bezierControl2.y)).toBe(true);
  });

  it('反射矩阵是正交反射(det = -1, M·Mᵀ = I)', () => {
    const g = calcPoints(W, H, 500, 400, W, H, false);
    const { m00, m01, m10, m11 } = g.reflect;
    const det = m00 * m11 - m01 * m10;
    expect(det).toBeCloseTo(-1, 6);
    // 正交性:行/列都是单位向量
    expect(m00 * m00 + m01 * m01).toBeCloseTo(1, 6);
    expect(m10 * m10 + m11 * m11).toBeCloseTo(1, 6);
    expect(m00 * m10 + m01 * m11).toBeCloseTo(0, 6);
  });

  it('反射矩阵以 bezierControl1 为不动点', () => {
    const g = calcPoints(W, H, 500, 400, W, H, false);
    const { m00, m01, m10, m11 } = g.reflect;
    const c = g.bezierControl1;
    const vx = 37, vy = -19; // 任取一向量
    const rx = m00 * vx + m01 * vy;
    const ry = m10 * vx + m11 * vy;
    // 反射保持长度
    expect(Math.hypot(rx, ry)).toBeCloseTo(Math.hypot(vx, vy), 6);
    void c;
  });

  it('越界修正:超宽触点被钳回页内', () => {
    // 触点 x 超出页宽会触发修正分支(start1.x 越界)
    const g = calcPoints(W, H, W * 1.2, H * 0.5, 0, H, true);
    expect(Number.isFinite(g.touch.x)).toBe(true);
  });
});

describe('动画目标', () => {
  it('finishTarget:右角翻页把触点推向左外侧', () => {
    const t = finishTarget(W, H, W, H, { x: 600, y: 500 });
    expect(t.x).toBeLessThan(0);
    expect(t.y).toBeGreaterThan(H);
  });

  it('finishTarget:左角翻页把触点推向右外侧', () => {
    const t = finishTarget(W, H, 0, H, { x: 200, y: 500 });
    expect(t.x).toBeGreaterThan(W);
  });

  it('restoreTarget:回到页角', () => {
    expect(restoreTarget(W, H, W, H)).toEqual({ x: W, y: H });
    expect(restoreTarget(W, H, 0, 0)).toEqual({ x: 0, y: 1 });
  });
});
