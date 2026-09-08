# 主页 + 书库换肤设计(参考起点读书移动端)

日期:2026-08-20
状态:已落地

## 背景

原书库页 `/`(LibraryPage)是桌面优先的"深色藏书阁"风:顶栏搜索 + 5 列大网格 + 数字分页。
三张参考截图(起点读书 App 主页/书库)展示了**移动端阅读 App 的信息组织方式**:

1. **主页**:之前读过(横排卡片)/ 阅读目标(半圆进度环 + 周历 + 连续阅读 + 继续阅读大按钮)/ 今年读过的图书(5 列小封面网格 + 序号占位 + 达成目标文案)/ 底部导航(主页 · 书库 · 搜索)。
2. **书库**:封面双列网格 + 进度百分比(9% / 34% / 17%)+ "新增"徽标(蓝色小标签)+ 每条"···"操作 + 右上"排序/更多"菜单。

## 目标

- 把应用改为**移动端优先**的双页结构:`/` = 主页(新),`/library` = 书库(重构)。
- 视觉遵循参考图:**浅色蓝调**(白底、黑字、`#2AA7F0` 蓝点缀、黑色大按钮);同时保留原有**深色金调**风格的等价皮肤(炭黑 `#14130f` + 暖金 `#d4a857`),**两套主题可切换**(主页头部月亮/太阳按钮),选择持久化到 localStorage。
- 所有数据仍走本地(localStorage),**不新增后端接口**:
  - 书库列表:现有 `GET /api/books`。
  - 阅读进度/状态:现有 `useReaderProgress`(按书存储)。
  - 阅读时长/连续天数:新增 `src/lib/readingStats.ts`(本地按日累计分钟,Reader 页计时)。

## 设计决策

### 1. 换肤 CSS 变量(`src/index.css` + `tailwind.config.ts`)

主题为**全站级**:`AppThemeProvider` 把 `data-shell-theme` 挂在 `<html>` 上
(`useLayoutEffect` 防闪白;`index.html` 预置 `light` 防首帧无变量)。

- `shell` 色板:主页/书库/搜索弹层/底部导航专用。
- `ink/gold/cream` 遗留令牌改造为 CSS 变量,浅色主题下语义翻转
  (ink → 灰白表面、gold → 蓝色系、cream → 深灰文字,`gold-on` = 点缀底上的文字色),
  因此**详情/上传/章节编辑器/全部弹窗也随主题切换**,不再只是主页/书库两页。
- 深色主题的值与原硬编码完全一致(视觉零回归)。

| token | light(参考图) | dark(原有风格) |
|---|---|---|
| `--shell-bg` | 246 247 250 | 20 19 15(=ink-900) |
| `--shell-card` | 255 255 255 | 31 28 21(=ink-800) |
| `--shell-text` | 24 26 28 | 236 229 214(=cream) |
| `--shell-accent` | 42 167 240(`#2AA7F0`) | 212 168 87(=gold-400) |
| `--shell-cta` | 17 17 17(黑) | 212 168 87(金) |
| `--ink-900` | 246 247 250 | 20 19 15 |
| `--gold-400` | 42 167 240 | 212 168 87 |
| `--gold-200` | 18 137 210(hover 更深的蓝) | 230 194 119(更亮的金) |
| `--gold-on` | 255 255 255 | 20 19 15 |
| `--cream` | 28 30 34 | 236 229 214 |

遗留硬编码同步清理:按钮 `text-ink-900` → `text-gold-on`、金色阴影
`rgba(212,168,87,…)` → `rgb(var(--gold-400)/…)`、`colorScheme:'dark'` 内联样式删除
(由 CSS `color-scheme` 承担)、`.shell-atmosphere`/shimmer/滚动条等改用变量。

**Reader 例外**:阅读面自带浅色/米色/深色三套读数主题,根节点以
`data-shell-theme={settings.theme === 'light' ? 'light' : 'dark'}` 覆盖外壳主题,
保证米色/深色读数仍配暖金。切换方式:页面根节点 `data-shell-theme="light|dark"`,
`useAppTheme()`(`src/lib/appTheme.tsx`)提供 context + 持久化
(`epub_reader:shellTheme`)+ 切换按钮。

### 2. 阅读统计 `src/lib/readingStats.ts`

- `epub_reader:readMinutes:YYYY-MM-DD` → 当日阅读分钟(本地时区 key)。
- `epub_reader:readingGoal` → 每日目标分钟,默认 120,下限 10。
- `getWeekStats()` → 周日~周六 7 天(参考图周历顺序)。
- `getCurrentStreak()`:今日有记录从今天倒计数,今日无记录从昨天算(不打断)。
- `getLongestStreak()`:扫描全部 key 求最长连续。
- 变更事件 `READING_STATS_EVENT`,主页同 tab 实时刷新;跨 tab 靠 `storage` 事件。
- **Reader 计时**:页面可见期间 30s 节拍累计,`visibilitychange` 暂停/结算,卸载结算剩余
  (不满 1 分钟舍入,诚实且防注水)。用途:主页"今日阅读进度"。

### 3. 时间戳补齐(`useReaderProgress`)

`setChapterProgress` 每次写入还会 `safeSet(lastReadAtKey(bookId), Date.now())`(新 key
`epub_reader:lastReadAt:{bookId}`),主页"之前读过"按此倒序;"今年读过的图书"按此做年度过滤。
老数据无时间戳时降级:有进度或已读完也算今年读过。

### 4. 页面结构

**主页 `src/pages/Home.tsx`**(移动端优先,`max-w-md` 居中;桌面等同移动 App 宽度):

- 顶栏:日期 + 标题"我的书库" + 主题切换。
- 之前读过:横向滚动胶囊卡片(封面 80×112 / 书名两行 / 作者 / `图书 · 17%` 或"已读完"),
  点击进详情;只显示有进度的书(≤8 本)。
- 阅读目标:半圆 SVG 进度环(SVG stroke-dasharray,左→右 180°,圆头端点);
  中心"今日阅读进度"+ 对勾圆 + `N 分钟` + "调整目标"(弹窗:预设 30/60/90/120/180/240 +
  自定义,≥10 分钟);下方黑色胶囊"继续阅读 + 书名"跳最近阅读章节;
  周历(7 天圆环,当天蓝描边,有阅读蓝底白勾);"连续阅读 N 天 / 最长记录 M 天"。
- 今年读过的图书:5 列封面网格,每本中央蓝色对勾;未达标位显示灰色序号占位(2..20);
  底部"再读 N 本图书即可达成目标 / 继续阅读!"。
- 空库:上传引导。

**书库 `src/pages/Library.tsx`**(`max-w-3xl` 居中,2→3→4 列响应):

- 顶栏:标题"书库" + 排序菜单(最近添加/按书名/按进度)+ 更多菜单(上传、迁移[仅桌面端])+ 主题切换。
- 封面网格:每本封面 + 下行(`N%` / "新增"徽标[7 天内未读] / "已读完")+ "···"菜单
  (查看详情 / 标记已读完 / 重置进度)。
- 数据:一次拉 `size=100`(后端 clamp 上限),>100 时提示"已显示 100/N 本"。
- 空库:上传引导。

**共享**:

- `src/components/BottomNav.tsx`:底部胶囊导航(主页/书库)+ 右侧圆形搜索按钮。
- `src/components/SearchSheet.tsx`:搜索弹层(输入防抖 250ms,复用 `useBooks`,Escape/遮罩关闭)。
- `src/components/ShellCover.tsx`:封面/素封面(首字 + 书名),走 shell token。
- 路由:`/` → Home,`/library` → Library;Detail/Upload/ReaderSidebar 的"返回书库"全部指向 `/library`。
- 阅读器侧栏"书架"也指向 `/library`(名称保留"书架"避免误改阅读体验)。

### 5. 兼容与回归

- `Library.tsx` 原测试重写为书库版(封面/百分比/新增徽标/排序/···菜单/搜索弹层)。
- 新增 `Home.test.tsx`(空库/之前读过/阅读目标/继续阅读链接/今年网格/调整目标/主题切换)
  与 `readingStats.test.ts`(累计/目标/周历/连续/最长)。
- Reader 侧栏 href 断言更新为 `/library`。
- 删除不再被引用的 `BookCard.tsx`(深色风,被新封面组件替代;Detail 页仍用自己的封面块)。

## 未做 / 后续

- 书库 >100 本的"加载更多"分页(当前提示已显示数量,避免假按钮)。
- 阅读目标达标提醒、周历未来天点击预排。
- 主页"之前读过"卡片"···"菜单(详情/删除)可后续补。
