// DOM 页 → 位图快照(仿真翻页 CurlFlip 的地基)。
//
// BookReader 的 PageWidget 拿到的就是两张现成 Bitmap;Web 侧用
// SVGforeignObject 把页 DOM 栅格化:
//   克隆页元素 → 内联排版参数(CSS 变量在 data: SVG 里不解析,
//   必须物化为具体值)→ 图片 URL 转 data: 内联(图像上下文不加载
//   外部资源)→ XMLSerializer 序列化 → <img> 解码 → canvas。
//
// 同时预计算「纸背」位图:精确复刻 PageWidget 的 ColorMatrix
// ({0.55 scale + 80 offset, alpha 0.2}),避免逐帧 ctx.filter
// (WebView2 支持参差,且像素级一次性处理更便宜)。
//
// 失败模式:decode()/fetch 抛错 → 上层捕获 → 永久降级为覆盖翻页。

export interface PageBitmaps {
  front: HTMLCanvasElement;
  back: HTMLCanvasElement;
}

export interface SnapshotTypography {
  /** 页元素的完整尺寸(舞台大小,含 padding)。 */
  width: number;
  height: number;
  fontSize: number;
  lineHeight: number;
  fontFamily: string;
  color: string;
  background: string;
}

// data: URL 图片缓存(同 asset 只转换一次)
const dataUrlCache = new Map<string, string>();

async function toDataUrl(src: string): Promise<string | null> {
  const cached = dataUrlCache.get(src);
  if (cached) return cached;
  try {
    const res = await fetch(src);
    if (!res.ok) return null;
    const blob = await res.blob();
    const url = await new Promise<string | null>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
    if (url) dataUrlCache.set(src, url);
    return url;
  } catch {
    return null;
  }
}

// .paged-article 规则文本缓存:优先从 document.styleSheets 读取
// (与 index.css 单一来源),读不到再用内置副本(容错)。
// 副本与 index.css 保持同构:字号/行高/字体走 var(--fs)/var(--lh)/
// var(--font-family),变量由 foreignObject 包装器定义(见 snapshotPage)。
const FALLBACK_CSS = `
.paged-article { font-size: var(--fs) !important; line-height: var(--lh) !important; font-family: var(--font-family) !important; text-align: justify; overflow-wrap: break-word; word-break: break-word; white-space: normal !important; }
.paged-article p { text-indent: 2em !important; margin: 0 0 0.85em; }
.paged-article h1,.paged-article h2,.paged-article h3,.paged-article h4,.paged-article h5,.paged-article h6 { text-indent: 0; font-weight: 700; line-height: 1.4; }
.paged-article h1 { font-size: 1.45em; margin: 0.55em 0 0.9em; }
.paged-article h2 { font-size: 1.3em; margin: 0.55em 0 0.85em; }
.paged-article h3 { font-size: 1.15em; margin: 0.5em 0 0.8em; }
.paged-article h4,.paged-article h5,.paged-article h6 { font-size: 1.05em; margin: 0.5em 0 0.8em; }
.paged-article img { max-width: 100%; height: auto; display: block; margin: 1em auto; border-radius: 4px; }
.paged-page { position: absolute; inset: 0; padding: 26px 30px 36px; overflow: hidden; background: var(--bg); }
`;

let cssCache: string | null = null;

function collectPagedCss(): string {
  if (cssCache !== null) return cssCache;
  let out = '';
  try {
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules;
      } catch {
        continue; // 跨域样式表
      }
      for (const rule of Array.from(rules)) {
        const text = rule.cssText;
        if (text && text.includes('paged-article')) out += text + '\n';
      }
    }
  } catch {
    /* 读取失败走兜底 */
  }
  cssCache = out || FALLBACK_CSS;
  return cssCache;
}

/**
 * 把页元素栅格化为前后两张位图。
 * 坐标为 CSS px;canvas 物理尺寸按 devicePixelRatio 放大。
 */
export async function snapshotPage(
  pageEl: HTMLElement,
  typo: SnapshotTypography,
): Promise<PageBitmaps> {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const { width, height } = typo;

  // 1) 克隆并复位拖拽残留;尺寸取元素实际值(舞台大小,含 padding)
  const clone = pageEl.cloneNode(true) as HTMLElement;
  clone.style.transform = '';
  clone.style.boxShadow = '';
  clone.style.visibility = '';
  clone.style.width = `${Math.max(1, Math.round(pageEl.offsetWidth || typo.width))}px`;
  clone.style.height = `${Math.max(1, Math.round(pageEl.offsetHeight || typo.height))}px`;

  // 2) 图片内联为 data:
  const imgs = Array.from(clone.querySelectorAll('img'));
  await Promise.all(
    imgs.map(async (img) => {
      const src = img.getAttribute('src');
      if (!src) return;
      const data = await toDataUrl(src);
      if (data) img.setAttribute('src', data);
      else img.setAttribute('src', transparentPixel());
    }),
  );

  // 3) 组装 foreignObject 文档:
  //    - .paged-article 规则用 var(--fs)/var(--lh)/var(--font-family) 且带
  //      !important,直接内联 font-size 会被压掉;data: SVG 里变量不解析,
  //      所以在包装器上「定义变量」让类规则正常解析(变量可继承)
  //    - 图片内联为 data:(图像上下文不加载外部资源)
  const wrapper = document.createElement('div');
  wrapper.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
  wrapper.setAttribute(
    'style',
    [
      `--fs:${typo.fontSize}px`,
      `--lh:${typo.lineHeight}`,
      `--font-family:${typo.fontFamily}`,
      `--bg:${typo.background}`,
      `--fg:${typo.color}`,
      `width:${width}px`,
      `height:${height}px`,
      `background:${typo.background}`,
      'margin:0',
      'overflow:hidden',
    ].join(';'),
  );
  const style = document.createElement('style');
  style.textContent = collectPagedCss();
  wrapper.appendChild(style);
  wrapper.appendChild(clone);

  const xhtml = new XMLSerializer().serializeToString(wrapper);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<foreignObject width="100%" height="100%">${xhtml}</foreignObject></svg>`;

  // 4) 解码并绘制
  const img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  await img.decode();

  const front = document.createElement('canvas');
  front.width = Math.max(1, Math.round(width * dpr));
  front.height = Math.max(1, Math.round(height * dpr));
  const ctx = front.getContext('2d');
  if (!ctx) throw new Error('canvas 2d context unavailable');
  ctx.scale(dpr, dpr);
  ctx.drawImage(img, 0, 0, width, height);

  return { front, back: makeBackBitmap(front) };
}

/**
 * 纸背位图:ColorMatrix 精确移植。
 * 原矩阵:{0.55,0,0,0,80, 0,0.55,0,0,80, 0,0,0.55,0,80, 0,0,0,0.2,0}
 * → RGB' = 0.55*C + 80(整体提亮压灰),A' = 0.2*A(80% 透)。
 */
function makeBackBitmap(front: HTMLCanvasElement): HTMLCanvasElement {
  const back = document.createElement('canvas');
  back.width = front.width;
  back.height = front.height;
  const ctx = back.getContext('2d');
  if (!ctx) return front; // 拿不到 2d 就直接用正面(视觉退化为不透明纸背)
  ctx.drawImage(front, 0, 0);
  const data = ctx.getImageData(0, 0, back.width, back.height);
  const px = data.data;
  for (let i = 0; i < px.length; i += 4) {
    px[i] = Math.min(255, px[i] * 0.55 + 80);
    px[i + 1] = Math.min(255, px[i + 1] * 0.55 + 80);
    px[i + 2] = Math.min(255, px[i + 2] * 0.55 + 80);
    px[i + 3] = px[i + 3] * 0.2;
  }
  ctx.putImageData(data, 0, 0);
  return back;
}

function transparentPixel(): string {
  return 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
}

/** 供测试/主题切换时清空 CSS 缓存。 */
export function resetSnapshotCaches(): void {
  cssCache = null;
  dataUrlCache.clear();
}
