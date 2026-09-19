// 路由级测试:主页已移除 —— 根路径与未匹配路径都必须落到书库,
// 且底部导航里不再有「主页」入口。
import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';

/** 让书库页拿到空的书籍列表,便于断言"书库渲染出来了" */
function stubEmptyLibrary() {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [], total: 0, page: 1, size: 100 }),
    }),
  );
}

function renderAt(path: string) {
  window.history.pushState({}, '', path);
  return render(<App />);
}

describe('App 路由', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('根路径 / 重定向到书库', async () => {
    stubEmptyLibrary();

    renderAt('/');

    expect(await screen.findByText(/还没有书/)).toBeInTheDocument();
    expect(window.location.pathname).toBe('/library');
  });

  it('未匹配的路径重定向到书库', async () => {
    stubEmptyLibrary();

    renderAt('/no-such-page');

    expect(await screen.findByText(/还没有书/)).toBeInTheDocument();
    expect(window.location.pathname).toBe('/library');
  });

  it('底部导航只剩「书库」,不再有「主页」', async () => {
    stubEmptyLibrary();

    renderAt('/library');

    const nav = await screen.findByRole('navigation', { name: '底部导航' });
    expect(within(nav).getByText('书库')).toBeInTheDocument();
    expect(within(nav).queryByText('主页')).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: '搜索' })).toBeInTheDocument();
  });
});
