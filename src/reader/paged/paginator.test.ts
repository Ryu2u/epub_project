// paginator.ts 单测:用注入的假几何(每字符一行、行高 20)验证
// 分页累计/封页/替换元素原子性/切片渲染逻辑 —— 不依赖真实布局。

import { describe, expect, it } from 'vitest';
import {
  PositionIndex,
  hashString,
  paginate,
  renderSlice,
  type Geometry,
} from './paginator';
import { boundaryFromPosition, resolveBoundary, startBoundary } from './anchor';

/** 假几何:替换元素高 50(占位实现,空行盒触发单页兜底路径)。 */
function fakeGeometry(replacedHeight = 50): Geometry {
  return {
    rangeBox() {
      return null;
    },
    elementBox() {
      return { top: 0, bottom: replacedHeight };
    },
  };
}

// 构造「每个渲染原子分配行号」的几何。忠实模拟真实浏览器:
// 纯空白文本节点(块间 \n)没有行盒 → rangeBox 返回 null ——
// 这正是「每章只有一页」bug 的根源,用例必须覆盖。
// 用 root 重建 PositionIndex 把 DOM 位置反查回全局 g 坐标。
function makeGeometry(root: HTMLElement, lineHeight: number): Geometry & { index: PositionIndex } {
  const index = new PositionIndex(root);
  const lineOf = new Int32Array(index.total + 1).fill(-1);
  let g = 0;
  let line = 0;
  for (const a of index.atoms) {
    const size = a.kind === 'text' ? a.length : 1;
    const renders =
      a.kind === 'replaced' || (a.node.nodeValue ?? '').trim().length > 0;
    for (let k = 0; k < size; k++) {
      if (renders) {
        lineOf[g + k] = line;
        line += 1;
      } else {
        lineOf[g + k] = -1; // 空白:无行盒
      }
    }
    g += size;
  }
  const gOf = (node: Node, offset: number): number => {
    // 遍历 atoms 找到 (node,offset) 对应的 g
    let gg = 0;
    for (const a of index.atoms) {
      if (a.kind === 'text') {
        if (a.node === node) return gg + Math.max(0, Math.min(offset, a.length));
        gg += a.length;
      } else {
        const parent = a.node.parentNode!;
        const idx = Array.prototype.indexOf.call(parent.childNodes, a.node);
        if (parent === node && offset === idx + 1) return gg + 1;
        if (parent === node && offset <= idx) return gg;
        gg += 1;
      }
    }
    return gg;
  };
  return {
    index,
    rangeBox(start, end) {
      const g1 = gOf(start.node, start.offset);
      const g2 = gOf(end.node, end.offset);
      let top = Infinity;
      let bottom = -Infinity;
      for (let p = g1; p < g2; p++) {
        if (lineOf[p] >= 0) {
          top = Math.min(top, lineOf[p] * lineHeight);
          bottom = Math.max(bottom, (lineOf[p] + 1) * lineHeight);
        }
      }
      return Number.isFinite(top) ? { top, bottom } : null;
    },
    elementBox(el) {
      // 替换元素占一行高
      void el;
      return { top: 0, bottom: lineHeight };
    },
  };
}

function simpleChapter(): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = `<p>一二三四五六七八九十</p>`; // 10 个字符 = 10"行"
  return root;
}

describe('PositionIndex', () => {
  it('文本摊平成全局坐标', () => {
    const root = simpleChapter();
    const idx = new PositionIndex(root);
    expect(idx.total).toBe(10);
    expect(idx.atoms).toHaveLength(1);
    const p5 = idx.posAt(5);
    expect(p5.node.nodeType).toBe(Node.TEXT_NODE);
    expect(p5.offset).toBe(5);
  });

  it('图片作为替换元素占 1 个位置', () => {
    const root = document.createElement('div');
    root.innerHTML = `<p>ab<img src="x"><span>cd</span></p>`;
    const idx = new PositionIndex(root);
    // 文本 ab(2) + img(1) + 文本 cd(2) = 5
    expect(idx.total).toBe(5);
    const g2 = idx.posAt(2); // img 之前 → p 元素,offset=1
    expect(g2.node.nodeName).toBe('P');
    expect(g2.offset).toBe(1);
    // g=3 与 (p, offset=2)(img 之后)是同一文档位置,
    // posAt 解析到紧随其后的 cd 文本 offset 0 —— 等价且有序
    const g3 = idx.posAt(3);
    expect(g3.node.nodeType).toBe(Node.TEXT_NODE);
    expect((g3.node as Text).data).toBe('cd');
    expect(g3.offset).toBe(0);
    const g4 = idx.posAt(4);
    expect((g4.node as Text).data).toBe('cd');
    expect(g4.offset).toBe(1);
  });

  it('script/style 内文本被跳过', () => {
    const root = document.createElement('div');
    root.innerHTML = `<p>abc</p><script>var x = 1;</script>`;
    const idx = new PositionIndex(root);
    expect(idx.total).toBe(3);
  });
});

describe('paginate', () => {
  it('按行高切页:行高 20 / 页高 60 → 每页 3 行', async () => {
    const root = simpleChapter();
    const geo = makeGeometry(root, 20);
    const slices = await paginate(root, 60, geo);
    expect(slices).toHaveLength(4); // ceil(10/3)
    // 每页 start 的文本偏移 = 3*index
    const text = root.querySelector('p')!.firstChild as Text;
    slices.forEach((s, i) => {
      const pos = resolveBoundary(root, s.start);
      expect(pos?.node).toBe(text);
      expect(pos?.offset).toBe(Math.min(i * 3, 10));
    });
  });

  it('回归:章首/段间空白无行盒,不再误触发整章单页', async () => {
    // 忠实还原后端 text_to_xhtml 的产物形态:
    // <body>\n<p>…</p>\n<p>…</p> — 首个子节点是 "\n" 空白文本
    const root = document.createElement('div');
    root.innerHTML = `\n<p>一二三四五六七八九十</p>\n<p>abcdefghij</p>`;
    const geo = makeGeometry(root, 20);
    const slices = await paginate(root, 60, geo);
    // 20 个渲染字符,每页 3 行 → 7 页(空白被跳过,不占行)
    expect(slices).toHaveLength(7);
    // 第一页从第一段正文起(跳过章首空白)
    const firstText = root.querySelector('p')!.firstChild as Text;
    const pos = resolveBoundary(root, slices[0].start);
    expect(pos?.node).toBe(firstText);
    expect(pos?.offset).toBe(0);
    // 空白划归上一页末尾:第二页起点仍是正文偏移 3 的倍数
    const pos1 = resolveBoundary(root, slices[1].start);
    expect(pos1?.node).toBe(firstText);
    expect(pos1?.offset).toBe(3);
    // 末页区间收在最后一段文本末尾(= 章末等价位置)
    const lastText = root.querySelectorAll('p')[1].firstChild as Text;
    const endPos = resolveBoundary(root, slices[6].end);
    expect(endPos?.node).toBe(lastText);
    expect(endPos?.offset).toBe(lastText.length);
  });

  it('全部内容都无行盒(极端空白章)→ 整章单页兜底', async () => {
    const root = document.createElement('div');
    root.innerHTML = `\n  \n\t`;
    const geo = makeGeometry(root, 20);
    const slices = await paginate(root, 60, geo);
    expect(slices).toHaveLength(1);
  });

  it('页高大于内容 → 单页', async () => {
    const root = simpleChapter();
    const geo = makeGeometry(root, 20);
    const slices = await paginate(root, 999, geo);
    expect(slices).toHaveLength(1);
  });

  it('几何不可用(jsdom 空行盒)→ 整章单页兜底', async () => {
    const root = simpleChapter();
    const slices = await paginate(root, 100, fakeGeometry());
    expect(slices).toHaveLength(1);
  });

  it('空内容 → 单页', async () => {
    const root = document.createElement('div');
    const geo = makeGeometry(root, 20);
    const slices = await paginate(root, 60, geo);
    expect(slices).toHaveLength(1);
  });

  it('让出回调被周期调用(长章节防卡顿)', async () => {
    const root = document.createElement('div');
    root.innerHTML = `<p>${'字'.repeat(300)}</p>`;
    const geo = makeGeometry(root, 20);
    let yields = 0;
    const slices = await paginate(root, 60, geo, {
      yieldEvery: 5,
      yieldFn: async () => {
        yields += 1;
      },
    });
    expect(slices.length).toBeGreaterThan(20);
    expect(yields).toBeGreaterThan(3);
  });
});

describe('renderSlice', () => {
  it('切片只保留区间内文本,区间外前缀被删除', () => {
    const root = document.createElement('div');
    root.innerHTML = `<p>前半后半</p><p>第二段</p>`;
    const text = root.querySelector('p')!.firstChild as Text;
    const start = boundaryFromPosition(root, text, 2); // "后半"起
    const end = { path: [], textOffset: 0, childIndex: 2 }; // 章末
    const page = renderSlice(root, { index: 0, start, end });
    expect(page.querySelector('p')?.textContent).toBe('后半');
    expect(page.querySelectorAll('p')).toHaveLength(2); // 第二段保留
  });

  it('尾部删除 + 空壳清理', () => {
    const root = document.createElement('div');
    root.innerHTML = `<p>abcdef</p><p>ghijkl</p>`;
    const t1 = root.querySelectorAll('p')[0].firstChild as Text;
    const slice = {
      index: 0,
      start: startBoundary(root),
      end: boundaryFromPosition(root, t1, 3), // abc
    };
    const page = renderSlice(root, slice);
    expect(page.textContent).toBe('abc');
    // 第二段整体在区间外,应被清掉(空壳也清)
    expect(page.querySelectorAll('p')).toHaveLength(1);
  });

  it('保留含图片的空文本容器', () => {
    const root = document.createElement('div');
    root.innerHTML = `<p><img src="a"><img src="b"></p>`;
    const slice = { index: 0, start: startBoundary(root), end: { path: [], textOffset: 0, childIndex: 1 } };
    const page = renderSlice(root, slice);
    expect(page.querySelectorAll('img')).toHaveLength(2);
  });
});

describe('hashString', () => {
  it('确定性 & 内容敏感', () => {
    expect(hashString('abc')).toBe(hashString('abc'));
    expect(hashString('abc')).not.toBe(hashString('abd'));
    expect(hashString('')).toBe(hashString(''));
  });
});
