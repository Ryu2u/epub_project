// PageWidget 仿真卷页几何 —— Android BookReader PageWidget.java 的
// TypeScript 移植(纯函数,无 DOM/Canvas 依赖,可单测)。
//
// 移植时修复的已知问题:
//   1. getCross() 用斜率式求交点,竖直直线(P1.x == P2.x)会除零;
//      这里改用行列式法,竖直/水平线均安全,平行时返回 null。
//   2. 大量 catch(Exception) 静默吞异常 → 这里用显式的 null/夹逼兜底。

export interface Pt {
  x: number;
  y: number;
}

export interface CurlGeometry {
  // 折痕多边形(当前页被卷起的部分)的两条贝塞尔边
  bezierStart1: Pt;
  bezierControl1: Pt;
  bezierVertex1: Pt;
  bezierEnd1: Pt;
  bezierStart2: Pt;
  bezierControl2: Pt;
  bezierVertex2: Pt;
  bezierEnd2: Pt;
  // 触点(可能被越界修正钳制过)
  touch: Pt;
  corner: Pt;
  isRTandLB: boolean;
  touchToCornerDis: number;
  // 背面阴影渐变方向角(度)
  degrees: number;
  // 背面反射矩阵(2x2,绕 bezierControl1 反射)
  reflect: { m00: number; m01: number; m10: number; m11: number };
  // 原始路径(供 Canvas Path2D 构建复用)
  pathCurrent: Array<{ cmd: 'move' | 'quad' | 'line'; pts: Pt[] }>;
  pathFold: Array<{ cmd: 'move' | 'line'; pts: Pt[] }>;
}

/** 计算拖拽点对应的页角(对应 PageWidget.calcCornerXY)。 */
export function calcCornerXY(
  width: number,
  height: number,
  x: number,
  y: number,
): { cornerX: number; cornerY: number; isRTandLB: boolean } {
  const cornerX = x <= width / 2 ? 0 : width;
  const cornerY = y <= height / 2 ? 0 : height;
  const isRTandLB =
    (cornerX === 0 && cornerY === height) || (cornerX === width && cornerY === 0);
  return { cornerX, cornerY, isRTandLB };
}

/**
 * 两直线交点(行列式法;竖直线安全;平行/共线返回 null)。
 * 对应 PageWidget.getCross(修复了斜率法的除零)。
 */
export function getCross(p1: Pt, p2: Pt, p3: Pt, p4: Pt): Pt | null {
  const d1x = p2.x - p1.x;
  const d1y = p2.y - p1.y;
  const d2x = p4.x - p3.x;
  const d2y = p4.y - p3.y;
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-9) return null;
  const t = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / denom;
  return { x: p1.x + d1x * t, y: p1.y + d1y * t };
}

const pt = (x: number, y: number): Pt => ({ x, y });

/**
 * 核心几何计算(对应 PageWidget.calcPoints,含越界修正块)。
 * touch 为当前触点,cornerX/cornerY 来自 calcCornerXY。
 */
export function calcPoints(
  width: number,
  height: number,
  touchX: number,
  touchY: number,
  cornerX: number,
  cornerY: number,
  isRTandLB: boolean,
): CurlGeometry {
  void height; // 仅为与其他函数签名对称保留
  // 防止 0 坐标引发除零(对应构造函数里 mTouch.x = 0.01f)
  let tx = touchX === 0 ? 0.01 : touchX;
  let ty = touchY === 0 ? 0.01 : touchY;

  let middleX = (tx + cornerX) / 2;
  let middleY = (ty + cornerY) / 2;

  let bezierControl1 = computeControl1(middleX, middleY, cornerX, cornerY);
  let bezierControl2 = computeControl2(middleX, middleY, cornerX, cornerY);
  let bezierStart1 = pt(
    bezierControl1.x - (cornerX - bezierControl1.x) / 2,
    cornerY,
  );

  // ---- 越界修正:start1 超出页面范围时钳制触点(照搬原逻辑) ----
  if (tx > 0 && tx < width) {
    if (bezierStart1.x < 0 || bezierStart1.x > width) {
      if (bezierStart1.x < 0) bezierStart1 = pt(width - bezierStart1.x, bezierStart1.y);
      const f1 = Math.abs(cornerX - tx);
      const f2 = (width * f1) / Math.max(bezierStart1.x, 1e-6);
      tx = Math.abs(cornerX - f2);
      const f3 = (Math.abs(cornerX - tx) * Math.abs(cornerY - ty)) / Math.max(f1, 1e-6);
      ty = Math.abs(cornerY - f3);
      middleX = (tx + cornerX) / 2;
      middleY = (ty + cornerY) / 2;
      bezierControl1 = computeControl1(middleX, middleY, cornerX, cornerY);
      bezierControl2 = computeControl2(middleX, middleY, cornerX, cornerY);
      bezierStart1 = pt(
        bezierControl1.x - (cornerX - bezierControl1.x) / 2,
        cornerY,
      );
    }
  }

  const bezierStart2 = pt(
    cornerX,
    bezierControl2.y - (cornerY - bezierControl2.y) / 2,
  );

  const touchToCornerDis = Math.hypot(tx - cornerX, ty - cornerY);

  const touch = pt(tx, ty);
  // 线1 = touch→control1;线2 = start1→start2。求两条贝塞尔的实际端点
  const end1 = getCross(touch, bezierControl1, bezierStart1, bezierStart2);
  const end2 = getCross(touch, bezierControl2, bezierStart1, bezierStart2);
  const fallback = pt(
    (bezierStart1.x + bezierStart2.x) / 2,
    (bezierStart1.y + bezierStart2.y) / 2,
  );
  const bezierEnd1 = end1 ?? fallback;
  const bezierEnd2 = end2 ?? fallback;

  // 二次贝塞尔顶点 = (start + 2*control + end) / 4
  const bezierVertex1 = pt(
    (bezierStart1.x + 2 * bezierControl1.x + bezierEnd1.x) / 4,
    (2 * bezierControl1.y + bezierStart1.y + bezierEnd1.y) / 4,
  );
  const bezierVertex2 = pt(
    (bezierStart2.x + 2 * bezierControl2.x + bezierEnd2.x) / 4,
    (2 * bezierControl2.y + bezierStart2.y + bezierEnd2.y) / 4,
  );

  // 背面阴影旋转角(对应 drawNextPageAreaAndShadow 中的 mDegrees)
  const degrees =
    (Math.atan2(bezierControl1.x - cornerX, bezierControl2.y - cornerY) * 180) / Math.PI;

  // 背面反射矩阵(对应 drawCurrentBackArea):绕 fold 方向的镜像
  const dis = Math.hypot(cornerX - bezierControl1.x, bezierControl2.y - cornerY);
  const f8 = (cornerX - bezierControl1.x) / (dis || 1e-6);
  const f9 = (bezierControl2.y - cornerY) / (dis || 1e-6);
  const reflect = {
    m00: 1 - 2 * f9 * f9,
    m01: 2 * f8 * f9,
    m10: 2 * f8 * f9,
    m11: 1 - 2 * f8 * f8,
  };

  // 当前页剩余区域路径(原 mPath0:quad-touch-quad-corner)
  const pathCurrent: CurlGeometry['pathCurrent'] = [
    { cmd: 'move', pts: [bezierStart1] },
    { cmd: 'quad', pts: [bezierControl1, bezierEnd1] },
    { cmd: 'line', pts: [touch] },
    { cmd: 'line', pts: [bezierEnd2] },
    { cmd: 'quad', pts: [bezierControl2, bezierStart2] },
    { cmd: 'line', pts: [pt(cornerX, cornerY)] },
  ];
  // 折痕区域路径(原 mPath1:start1-vertex1-vertex2-start2-corner)
  const pathFold: CurlGeometry['pathFold'] = [
    { cmd: 'move', pts: [bezierStart1] },
    { cmd: 'line', pts: [bezierVertex1] },
    { cmd: 'line', pts: [bezierVertex2] },
    { cmd: 'line', pts: [bezierStart2] },
    { cmd: 'line', pts: [pt(cornerX, cornerY)] },
  ];

  return {
    bezierStart1,
    bezierControl1,
    bezierVertex1,
    bezierEnd1,
    bezierStart2,
    bezierControl2,
    bezierVertex2,
    bezierEnd2,
    touch,
    corner: pt(cornerX, cornerY),
    isRTandLB,
    touchToCornerDis,
    degrees,
    reflect,
    pathCurrent,
    pathFold,
  };
}

// control1 落在 corner 所在的水平边上;control2 落在竖直边上。
// f4 == 0 的除零防护沿用原版(除以 0.1f)。
function computeControl1(
  middleX: number,
  middleY: number,
  cornerX: number,
  cornerY: number,
): Pt {
  const denom = cornerX - middleX;
  const safe = denom === 0 ? 0.1 : denom;
  return pt(middleX - ((cornerY - middleY) * (cornerY - middleY)) / safe, cornerY);
}

function computeControl2(
  middleX: number,
  middleY: number,
  cornerX: number,
  cornerY: number,
): Pt {
  const f4 = cornerY - middleY;
  const safe = f4 === 0 ? 0.1 : f4;
  return pt(cornerX, middleY - ((cornerX - middleX) * (cornerX - middleX)) / safe);
}

/**
 * 翻页完成动画的目标触点(对应 PageWidget.startAnimation 的滚动终点):
 * 把触点沿远离页角方向推出页面。
 */
export function finishTarget(
  width: number,
  height: number,
  cornerX: number,
  cornerY: number,
  touch: Pt,
): Pt {
  // cornerX > 0 → dx = -(width + touch.x):目标 x = -width(推出左侧)
  // cornerX == 0 → dx = width - touch.x + width:目标 x = 2*width
  const x = cornerX > 0 ? -width : 2 * width;
  const y = cornerY > 0 ? height + (height - touch.y) : 1;
  return pt(x, y);
}

/** 回弹动画目标:回到页角(对应 restoreAnimation)。 */
export function restoreTarget(
  width: number,
  height: number,
  cornerX: number,
  cornerY: number,
): Pt {
  // 原版是滚动回 (cornerX 或 cornerY 边缘):dx = width - touch.x 等
  void height;
  return pt(cornerX > 0 ? width : 0, cornerY > 0 ? height : 1);
}
