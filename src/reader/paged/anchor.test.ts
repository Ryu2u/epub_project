// anchor.ts 单测:Boundary 寻址的往返与文档序比较(jsdom,无需布局)。

import { describe, expect, it } from 'vitest';
import {
  boundaryFromPosition,
  compareBoundaries,
  endBoundary,
  findPageForBoundary,
  resolveBoundary,
  startBoundary,
} from './anchor';

function buildRoot(): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = `
    <h2>标题</h2>
    <p>第一段<em>强调</em>尾巴</p>
    <p><img src="x.png"><span>第二段文字</span></p>
  `;
  // innerHTML 的换行缩进会产生空白文本节点,占据 childNodes 序号;
  // 测试里剥掉它们,让断言的路径直观([1,0] = 第一个 p 的文本)。
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const toRemove: Text[] = [];
  let n: Node | null;
  while ((n = walker.nextNode()) !== null) {
    if (!(n.nodeValue ?? '').trim()) toRemove.push(n as Text);
  }
  toRemove.forEach((t) => t.remove());
  return root;
}

describe('boundaryFromPosition / resolveBoundary', () => {
  it('文本节点内偏移往返', () => {
    const root = buildRoot();
    const text = root.querySelector('p')?.firstChild as Text; // "第一段"
    const b = boundaryFromPosition(root, text, 2);
    expect(b.path).toEqual([1, 0]);
    expect(b.textOffset).toBe(2);
    const pos = resolveBoundary(root, b);
    expect(pos?.node).toBe(text);
    expect(pos?.offset).toBe(2);
  });

  it('嵌套 em 内文本往返', () => {
    const root = buildRoot();
    const emText = root.querySelector('em')?.firstChild as Text; // "强调"
    const b = boundaryFromPosition(root, emText, 1);
    expect(b.path).toEqual([1, 1, 0]);
    const pos = resolveBoundary(root, b);
    expect(pos?.node).toBe(emText);
    expect(pos?.offset).toBe(1);
  });

  it('元素边界(childIndex 语义)往返', () => {
    const root = buildRoot();
    // p 内第 1 个子节点之后(即 <em> 之前)
    const p = root.querySelectorAll('p')[0];
    const b = boundaryFromPosition(root, p, 1);
    expect(b.path).toEqual([1]);
    expect(b.childIndex).toBe(1);
    const pos = resolveBoundary(root, b);
    expect(pos?.node).toBe(p);
    expect(pos?.offset).toBe(1);
  });

  it('root 自身 start/end 边界', () => {
    const root = buildRoot();
    const s = startBoundary(root);
    const e = endBoundary(root);
    const sp = resolveBoundary(root, s);
    const ep = resolveBoundary(root, e);
    expect(sp?.node).toBe(root);
    expect(sp?.offset).toBe(0);
    expect(ep?.node).toBe(root);
    expect(ep?.offset).toBe(root.childNodes.length);
  });

  it('越界路径返回 null', () => {
    const root = buildRoot();
    expect(resolveBoundary(root, { path: [99], textOffset: 0, childIndex: 0 })).toBeNull();
    expect(
      resolveBoundary(root, { path: [1, 0, 7], textOffset: 0, childIndex: 0 }),
    ).toBeNull();
  });

  it('textOffset 超长被夹取', () => {
    const root = buildRoot();
    const text = root.querySelector('p')?.firstChild as Text;
    const b = boundaryFromPosition(root, text, 999);
    const pos = resolveBoundary(root, b);
    expect(pos?.offset).toBe(text.length);
  });
});

describe('compareBoundaries / findPageForBoundary', () => {
  it('文档序比较', () => {
    const root = buildRoot();
    const text = root.querySelector('p')?.firstChild as Text;
    const a = boundaryFromPosition(root, text, 1);
    const b = boundaryFromPosition(root, text, 3);
    expect(compareBoundaries(root, a, b)).toBe(-1);
    expect(compareBoundaries(root, b, a)).toBe(1);
    expect(compareBoundaries(root, a, a)).toBe(0);
    const start = startBoundary(root);
    const end = endBoundary(root);
    expect(compareBoundaries(root, start, end)).toBe(-1);
  });

  it('二分定位锚点所在页', () => {
    const root = buildRoot();
    const text = root.querySelectorAll('p')[1].querySelector('span')
      ?.firstChild as Text;
    const anchor = boundaryFromPosition(root, text, 2);
    // 三"页":第一段前半 / 第一段后半 / 第二段
    const p0end = boundaryFromPosition(root, root.querySelector('p')!.firstChild as Text, 2);
    const p1end = endBoundary(root);
    const slices = [
      { index: 0, start: startBoundary(root), end: p0end },
      { index: 1, start: p0end, end: p1end },
    ];
    expect(findPageForBoundary(root, slices, anchor)).toBe(1);
    expect(findPageForBoundary(root, slices, startBoundary(root))).toBe(0);
  });
});
