/**
 * Tailwind 配置。
 *
 * 全部颜色令牌都映射为 CSS 变量(rgb 三元组)。
 * 两套主题变量在 src/index.css 的 [data-shell-theme] 作用域里定义:
 *  - light:浅色蓝调(参考图)
 *  - dark:深色金调(原藏书阁风格)
 * AppThemeProvider 把 data-shell-theme 挂在 <html> 上,整个应用随主题切换,
 * 包括遗留页面(详情/上传/章节编辑器)与各弹窗——不再出现"主页亮、详情暗"的割裂。
 */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // 深色表面层级——浅色主题下映射为灰白层级
        ink: {
          950: 'rgb(var(--ink-950) / <alpha-value>)',
          900: 'rgb(var(--ink-900) / <alpha-value>)',
          850: 'rgb(var(--ink-850) / <alpha-value>)',
          800: 'rgb(var(--ink-800) / <alpha-value>)',
          700: 'rgb(var(--ink-700) / <alpha-value>)',
          600: 'rgb(var(--ink-600) / <alpha-value>)',
          line: 'rgb(var(--ink-line) / <alpha-value>)',
        },
        // 点缀色——浅色主题下映射为蓝色;on = 点缀底上的文字色(深金/白蓝自适应)
        gold: {
          50: 'rgb(var(--gold-50) / <alpha-value>)',
          100: 'rgb(var(--gold-100) / <alpha-value>)',
          200: 'rgb(var(--gold-200) / <alpha-value>)',
          300: 'rgb(var(--gold-300) / <alpha-value>)',
          400: 'rgb(var(--gold-400) / <alpha-value>)',
          500: 'rgb(var(--gold-500) / <alpha-value>)',
          600: 'rgb(var(--gold-600) / <alpha-value>)',
          on: 'rgb(var(--gold-on) / <alpha-value>)',
        },
        // 文字色——浅色主题下映射为深灰
        cream: {
          DEFAULT: 'rgb(var(--cream) / <alpha-value>)',
          muted: 'rgb(var(--cream-muted) / <alpha-value>)',
          faint: 'rgb(var(--cream-faint) / <alpha-value>)',
        },
        // 换肤外壳专用令牌(主页/书库/搜索弹层/底部导航)
        shell: {
          bg: 'rgb(var(--shell-bg) / <alpha-value>)',
          card: 'rgb(var(--shell-card) / <alpha-value>)',
          text: 'rgb(var(--shell-text) / <alpha-value>)',
          muted: 'rgb(var(--shell-muted) / <alpha-value>)',
          faint: 'rgb(var(--shell-faint) / <alpha-value>)',
          line: 'rgb(var(--shell-line) / <alpha-value>)',
          accent: 'rgb(var(--shell-accent) / <alpha-value>)',
          accentStrong: 'rgb(var(--shell-accent-strong) / <alpha-value>)',
          onAccent: 'rgb(var(--shell-on-accent) / <alpha-value>)',
          cta: 'rgb(var(--shell-cta) / <alpha-value>)',
          onCta: 'rgb(var(--shell-on-cta) / <alpha-value>)',
          track: 'rgb(var(--shell-track) / <alpha-value>)',
        },
      },
      fontFamily: {
        // 展示衬线:拉丁走 Fraunces,中文回退到系统宋体(宋体即经典书籍字)
        display: ['Fraunces', '"Noto Serif SC"', 'Georgia', '"Songti SC"', '"SimSun"', 'serif'],
        serif: ['"Noto Serif SC"', 'Fraunces', 'Georgia', '"Songti SC"', 'serif'],
        sans: ['"Hanken Grotesk"', 'system-ui', '"PingFang SC"', '"Microsoft YaHei"', 'sans-serif'],
      },
      boxShadow: {
        // 书脊式投影:模拟书在架上的实体感(黑投影两主题通用)
        book: '0 12px 28px -10px rgba(0,0,0,0.75), 0 3px 8px rgba(0,0,0,0.45), 0 0 0 1px rgba(0,0,0,0.4)',
        // 悬停辉光:金色部分跟随主题变量(浅色=蓝辉光)
        'book-hover':
          '0 24px 48px -12px rgba(0,0,0,0.85), 0 0 0 1px rgb(var(--gold-400) / 0.35), 0 0 34px -8px rgb(var(--gold-400) / 0.45)',
        // 移动端外壳:浮层卡片 / 底部导航的柔和投影
        float: '0 12px 28px -10px rgba(0,0,0,0.18), 0 2px 8px rgba(0,0,0,0.08)',
      },
    },
  },
  plugins: [],
};
