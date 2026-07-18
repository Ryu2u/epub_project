/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // 深色图书馆:暖色调炭黑(非中性 zinc),分层的深色表面
        ink: {
          950: '#0d0b08',
          900: '#14130f', // 页面底色
          850: '#191711',
          800: '#1f1c15', // 卡片表面
          700: '#28241b', // 抬升 / hover
          600: '#39342a',
          line: 'rgba(212,168,87,0.14)',
        },
        // 暖金点缀:克制使用,仅用于强调/激活态
        gold: {
          50: '#fbf4e4',
          100: '#f3e3bf',
          200: '#e6c277',
          300: '#ddb35f',
          400: '#d4a857', // 主点缀
          500: '#c2913f',
          600: '#9a7330',
        },
        // 暖色文字:不用纯白,用奶油色保证纸感
        cream: {
          DEFAULT: '#ece5d6', // 主文字
          muted: '#9c9384', // 次要文字
          faint: '#6f685b', // 三级 / 禁用
        },
      },
      fontFamily: {
        // 展示衬线:拉丁走 Fraunces,中文回退到系统宋体(宋体即经典书籍字)
        display: ['Fraunces', '"Noto Serif SC"', 'Georgia', '"Songti SC"', '"SimSun"', 'serif'],
        serif: ['"Noto Serif SC"', 'Fraunces', 'Georgia', '"Songti SC"', 'serif'],
        sans: ['"Hanken Grotesk"', 'system-ui', '"PingFang SC"', '"Microsoft YaHei"', 'sans-serif'],
      },
      boxShadow: {
        // 书脊式投影:模拟书在架上的实体感
        book: '0 12px 28px -10px rgba(0,0,0,0.75), 0 3px 8px rgba(0,0,0,0.45), 0 0 0 1px rgba(0,0,0,0.4)',
        'book-hover':
          '0 24px 48px -12px rgba(0,0,0,0.85), 0 0 0 1px rgba(212,168,87,0.35), 0 0 34px -8px rgba(212,168,87,0.45)',
      },
    },
  },
  plugins: [],
};
