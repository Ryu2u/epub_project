// locateText 单测:搜索命中 → DOM 位置的映射(jsdom 无布局也能跑)。

import { describe, expect, it } from 'vitest';
import { locateTextRange, locateTextStart } from './locateText';

function root(html: string): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = html;
  return el;
}

describe('locateTextRange', () => {
  it('定位第 N 次出现', () => {
    const el = root('<p>殷萱儿来了。殷萱儿走了。殷萱儿又来了。</p>');
    const r2 = locateTextRange(el, { term: '殷萱儿', index: 2 });
    expect(r2).not.toBeNull();
    expect(r2!.toString()).toBe('殷萱儿');
    // 第 2 次出现前文应为「殷萱儿来了。」
    const before = r2!.startContainer.nodeValue!.slice(0, r2!.startOffset);
    expect(before).toBe('殷萱儿来了。');
  });

  it('跨行内标签的命中也能定位(文本被拆分到多个节点)', () => {
    const el = root('<p>前文<em>殷萱</em>儿后文</p>');
    const r = locateTextRange(el, { term: '殷萱儿', index: 1 });
    expect(r).not.toBeNull();
    expect(r!.toString()).toBe('殷萱儿');
  });

  it('序号越界时取最后一次', () => {
    const el = root('<p>殷萱儿甲殷萱儿</p>');
    const r = locateTextRange(el, { term: '殷萱儿', index: 99 });
    expect(r).not.toBeNull();
    expect(r!.startOffset).toBe(4); // 殷萱儿甲 = 4 字
  });

  it('序号漂移时用 before 上下文纠正(空白差异导致计数不准)', () => {
    // 数据库文本里第 2 次命中的前文是「乙」，但渲染后空白被压缩，
    // 序号可能对不上；before 应把它拉回正确位置
    const el = root('<p>殷萱儿甲 乙殷萱儿 丙殷萱儿</p>');
    const r = locateTextRange(el, { term: '殷萱儿', index: 2, before: '乙' });
    expect(r).not.toBeNull();
    // 应命中「乙」后面的那一次（文本里是第 2 次，验证偏移）
    expect(r!.startContainer.nodeValue!.slice(0, r!.startOffset)).toBe('殷萱儿甲 乙');
  });

  it('找不到时返回 null', () => {
    const el = root('<p>无关内容</p>');
    expect(locateTextRange(el, { term: '殷萱儿', index: 1 })).toBeNull();
    expect(locateTextRange(el, { term: '', index: 1 })).toBeNull();
  });

  it('忽略 script/style 文本', () => {
    const el = root('<p>殷萱儿</p><script>var x = "殷萱儿";</script>');
    const r = locateTextRange(el, { term: '殷萱儿', index: 1 });
    expect(r).not.toBeNull();
    expect(r!.startContainer.parentElement?.tagName).toBe('P');
  });

  it('忽略 display:none 的隐藏文本(阅读器会隐藏重复标题)', () => {
    const el = root('<h1 style="display:none">殷萱儿</h1><p>殷萱儿</p>');
    const r = locateTextRange(el, { term: '殷萱儿', index: 1 });
    expect(r).not.toBeNull();
    expect(r!.startContainer.parentElement?.tagName).toBe('P');
  });
});

describe('locateTextStart', () => {
  it('返回文本节点与节点内偏移', () => {
    const el = root('<p>甲甲殷萱儿乙</p>');
    const pos = locateTextStart(el, { term: '殷萱儿', index: 1 });
    expect(pos).not.toBeNull();
    expect(pos!.node.nodeType).toBe(Node.TEXT_NODE);
    expect(pos!.offset).toBe(2);
  });
});
