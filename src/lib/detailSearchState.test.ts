// detailSearchState 单测:按书隔离、读取即消费、脏数据兜底。

import { afterEach, describe, expect, it } from 'vitest';
import {
  clearDetailSearch,
  saveDetailSearch,
  takeDetailSearch,
} from './detailSearchState';

const state = {
  query: '殷萱儿',
  expanded: ['c1'],
  scrollTop: 1234,
  windowScrollY: 56,
};

describe('detailSearchState', () => {
  afterEach(() => sessionStorage.clear());

  it('存 → 取 往返', () => {
    saveDetailSearch('b1', state);
    expect(takeDetailSearch('b1')).toEqual(state);
  });

  it('读取即消费:第二次取为 null', () => {
    saveDetailSearch('b1', state);
    expect(takeDetailSearch('b1')).not.toBeNull();
    expect(takeDetailSearch('b1')).toBeNull();
  });

  it('按书隔离', () => {
    saveDetailSearch('b1', state);
    saveDetailSearch('b2', { ...state, query: '别的' });
    expect(takeDetailSearch('b1')?.query).toBe('殷萱儿');
    expect(takeDetailSearch('b2')?.query).toBe('别的');
  });

  it('空关键词不恢复(视为无状态)', () => {
    saveDetailSearch('b1', { ...state, query: '' });
    expect(takeDetailSearch('b1')).toBeNull();
  });

  it('脏数据兜底', () => {
    sessionStorage.setItem('epub_reader:detailSearch:b1', '{not json');
    expect(takeDetailSearch('b1')).toBeNull();
    sessionStorage.setItem(
      'epub_reader:detailSearch:b1',
      JSON.stringify({ query: 'x', expanded: 'oops', scrollTop: 'nope' }),
    );
    const got = takeDetailSearch('b1');
    expect(got).toEqual({ query: 'x', expanded: [], scrollTop: 0, windowScrollY: 0 });
  });

  it('clear 清除', () => {
    saveDetailSearch('b1', state);
    clearDetailSearch('b1');
    expect(takeDetailSearch('b1')).toBeNull();
  });
});
