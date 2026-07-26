/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        text: {
          primary: 'rgba(255, 255, 255, 0.95)',
          secondary: 'rgba(255, 255, 255, 0.62)',
          tertiary: 'rgba(255, 255, 255, 0.38)',
        },

        warn: {
          DEFAULT: '#F97316',
          hover: '#EA580C',
          soft: 'rgba(249, 115, 22, 0.14)',
          glow: 'rgba(249, 115, 22, 0.22)',
        },

        accent: {
          DEFAULT: '#FFFFFF',
          hover: 'rgba(255, 255, 255, 0.92)',
          soft: 'rgba(255, 255, 255, 0.14)',
          glow: 'rgba(255, 255, 255, 0.22)',
        },

        surface: {
          work: '#161617',
          elevated: '#1F1F21',
          hover: '#262629',
          active: '#2D2D31',
          border: '#2A2A2D',
        },

        diff: {
          added: 'rgba(52, 211, 153, 0.10)',
          addedText: 'rgba(110, 231, 183, 0.95)',
          addedLine: 'rgba(52, 211, 153, 0.18)',
          removed: 'rgba(244, 63, 94, 0.10)',
          removedText: 'rgba(252, 165, 165, 0.95)',
          removedLine: 'rgba(244, 63, 94, 0.16)',
        },

        bg: {
          base: 'transparent',
          layer: 'rgba(255, 255, 255, 0.04)',
          'layer-alt': 'rgba(255, 255, 255, 0.06)',
          sidebar: 'transparent',
          hover: 'rgba(255, 255, 255, 0.08)',
        },
        border: 'rgba(255, 255, 255, 0.08)',
      },

      borderRadius: {
        DEFAULT: '4px',
        sm: '6px',
        md: '10px',
        lg: '16px',
        xl: '22px',
        '2xl': '28px',
        '3xl': '32px',
      },

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

      boxShadow: {
        soft: '0 1px 2px rgba(0,0,0,0.06), 0 2px 8px rgba(0,0,0,0.10)',
        card: '0 1px 2px rgba(0,0,0,0.08), 0 4px 12px rgba(0,0,0,0.12)',
        raised: '0 2px 8px rgba(0,0,0,0.12), 0 8px 24px rgba(0,0,0,0.16)',
        glow: '0 0 0 3px rgba(255, 255, 255, 0.10)',
      },

      opacity: {
        3: '0.03',
        4: '0.04',
        6: '0.06',
        8: '0.08',
        12: '0.12',
        15: '0.15',
        18: '0.18',
      },

      transitionDuration: {
        DEFAULT: '200ms',
        fast: '120ms',
        slow: '320ms',
      },
      transitionTimingFunction: {
        DEFAULT: 'cubic-bezier(0.16, 1, 0.3, 1)',
        smooth: 'cubic-bezier(0.4, 0, 0.2, 1)',
        bounce: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
      },
      animation: {
        'fade-in': 'fadeIn 200ms cubic-bezier(0.16, 1, 0.3, 1)',
        'slide-in': 'slideIn 280ms cubic-bezier(0.16, 1, 0.3, 1)',
        'scale-in': 'scaleIn 300ms cubic-bezier(0.34, 1.56, 0.64, 1)',
        'slide-up': 'slideUp 220ms cubic-bezier(0.16, 1, 0.3, 1)',
        'spring-in': 'springIn 400ms cubic-bezier(0.34, 1.56, 0.64, 1)',
        'slide-up-spring': 'slideUpSpring 450ms cubic-bezier(0.34, 1.56, 0.64, 1)',
        'page-transition': 'pageTransition 350ms cubic-bezier(0.16, 1, 0.3, 1)',
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
        slideUpSpring: {
          '0%': { transform: 'translateY(12px)', opacity: '0' },
          '60%': { transform: 'translateY(-2px)', opacity: '1' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
        springIn: {
          '0%': { transform: 'scale(0.9)', opacity: '0' },
          '60%': { transform: 'scale(1.02)', opacity: '1' },
          '100%': { transform: 'scale(1)', opacity: '1' },
        },
        scaleIn: {
          '0%': { transform: 'scale(0.92)', opacity: '0' },
          '100%': { transform: 'scale(1)', opacity: '1' },
        },
        pageTransition: {
          '0%': { opacity: '0', transform: 'translateY(8px) scale(0.98)' },
          '100%': { opacity: '1', transform: 'translateY(0) scale(1)' },
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
