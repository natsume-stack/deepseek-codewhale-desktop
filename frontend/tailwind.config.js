/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      /* ================== 色彩体系（Codex Desktop 风格） ==================
       * 设计原则：
       *   1. 左侧 SideNav 透明，让 Mica 穿透显示
       *   2. 右侧工作区为不透明深色板块（surface.work），与左侧分层
       *   3. 主点缀色：克制的蓝色（Codex 标志色，替代原翠绿）
       *   4. 文字分层依靠透明度区分：primary / secondary / tertiary
       *   5. 边框使用 white/N 极淡透明或纯色 #2A2A2A
       */
      colors: {
        /* 文本（白色不同透明度，对齐深色底） */
        text: {
          primary: 'rgba(255, 255, 255, 0.95)',
          secondary: 'rgba(255, 255, 255, 0.62)',
          tertiary: 'rgba(255, 255, 255, 0.38)',
        },

        /* 主强调色：克制蓝色（Codex 标志色，替代原翠绿） */
        accent: {
          DEFAULT: '#3B82F6',
          hover: '#2563EB',
          soft: 'rgba(59, 130, 246, 0.14)',
          glow: 'rgba(59, 130, 246, 0.22)',
        },

        /* 工作区表面（不透明深色板块，与左侧 Mica 分层） */
        surface: {
          work: '#161617',      // 工作区主背景（近黑灰）
          elevated: '#1F1F21',  // 浮起卡片 / 输入框
          hover: '#262629',     // hover 态
          active: '#2D2D31',    // 选中态
          border: '#2A2A2D',    // 边框
        },

        /* Diff 标记色（低饱和，新增保留柔和绿语义，删除柔和红） */
        diff: {
          added: 'rgba(52, 211, 153, 0.10)',
          addedText: 'rgba(110, 231, 183, 0.95)',
          addedLine: 'rgba(52, 211, 153, 0.18)',
          removed: 'rgba(244, 63, 94, 0.10)',
          removedText: 'rgba(252, 165, 165, 0.95)',
          removedLine: 'rgba(244, 63, 94, 0.16)',
        },

        /* 旧别名兼容（避免大面积改动组件） */
        bg: {
          base: 'transparent',
          layer: 'rgba(255, 255, 255, 0.04)',
          'layer-alt': 'rgba(255, 255, 255, 0.06)',
          sidebar: 'transparent',
          hover: 'rgba(255, 255, 255, 0.08)',
        },
        border: 'rgba(255, 255, 255, 0.08)',
      },

      /* ================== 圆角规范（Codex 统一标准） ==================
       * 窗口外层 12px / 面板卡片 8px / 按钮小组件 4px
       */
      borderRadius: {
        DEFAULT: '4px',
        sm: '4px',
        md: '6px',
        lg: '8px',
        xl: '12px',
        '2xl': '14px',
      },

      /* ================== 字体规范（黑体优先，简洁清爽） ==================
       * 界面常规：无衬线黑体
       * 代码块、Diff：等宽
       */
      fontFamily: {
        sans: [
          '"Microsoft YaHei UI"',
          '"Segoe UI Variable"',
          '"Segoe UI"',
          'system-ui',
          '-apple-system',
          'BlinkMacSystemFont',
          'sans-serif',
        ],
        mono: [
          '"JetBrains Mono"',
          '"SF Mono"',
          'Menlo',
          'Monaco',
          'Consolas',
          '"Courier New"',
          'monospace',
        ],
      },

      fontSize: {
        base: '14px',
        '2xs': '10px',
        xs: '12px',
        sm: '13px',
        md: '14px',
        lg: '16px',
        xl: '18px',
      },

      /* ================== 阴影规范（柔和分层） ================== */
      boxShadow: {
        soft: '0 1px 2px rgba(0,0,0,0.06), 0 2px 8px rgba(0,0,0,0.10)',
        card: '0 1px 2px rgba(0,0,0,0.08), 0 4px 12px rgba(0,0,0,0.12)',
        raised: '0 2px 8px rgba(0,0,0,0.12), 0 8px 24px rgba(0,0,0,0.16)',
        glow: '0 0 0 3px rgba(59, 130, 246, 0.18)',
      },

      /* ================== 透明度扩展（确保 @apply 中能识别非标准档位） ==================
       * Tailwind 默认仅支持 /0 /5 /10 /20 ... /95 /100，
       * 这里补充 Codex 风格需要的 /3 /4 /6 /8 /12 等中间档位
       */
      opacity: {
        3: '0.03',
        4: '0.04',
        6: '0.06',
        8: '0.08',
        12: '0.12',
        15: '0.15',
        18: '0.18',
      },

      /* ================== 动画规范（克制平缓） ================== */
      transitionDuration: {
        DEFAULT: '200ms',
        fast: '120ms',
        slow: '320ms',
      },
      transitionTimingFunction: {
        DEFAULT: 'cubic-bezier(0.16, 1, 0.3, 1)',
        smooth: 'cubic-bezier(0.4, 0, 0.2, 1)',
      },
      animation: {
        'fade-in': 'fadeIn 200ms cubic-bezier(0.16, 1, 0.3, 1)',
        'slide-in': 'slideIn 280ms cubic-bezier(0.16, 1, 0.3, 1)',
        'scale-in': 'scaleIn 220ms cubic-bezier(0.16, 1, 0.3, 1)',
        'slide-up': 'slideUp 220ms cubic-bezier(0.16, 1, 0.3, 1)',
        'pulse-soft': 'pulseSoft 2.4s ease-in-out infinite',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideIn: {
          '0%': { transform: 'translateX(-8px)', opacity: '0' },
          '100%': { transform: 'translateX(0)', opacity: '1' },
        },
        slideUp: {
          '0%': { transform: 'translateY(8px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
        scaleIn: {
          '0%': { transform: 'scale(0.96)', opacity: '0' },
          '100%': { transform: 'scale(1)', opacity: '1' },
        },
        pulseSoft: {
          '0%, 100%': { opacity: '0.4' },
          '50%': { opacity: '0.8' },
        },
      },
    },
  },
  plugins: [],
}
