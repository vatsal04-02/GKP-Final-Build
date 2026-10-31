/** Design tokens live in src/web/styles.css (CSS variables, light only); Tailwind only points at them. */
const v = (name) => `rgb(var(--${name}) / <alpha-value>)`;
export default {
  content: ['./index.html', './src/web/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        'side-fg': v('side-fg'), 'side-muted': v('side-muted'),
        bg: v('bg'), 'bg-2': v('bg-2'), surface: v('surface'), field: v('field'), 'surface-2': v('surface-2'), elevated: v('elevated'),
        line: v('line'), 'line-2': v('line-2'),
        fg: v('fg'), 'fg-2': v('fg-2'), muted: v('muted'),
        blue: { DEFAULT: v('blue'), bright: v('blue-bright'), soft: v('blue-soft') },
        accent: { DEFAULT: v('accent'), strong: v('accent-strong') }, sage: v('sage'),
        ok: v('ok'), warn: v('warn'), bad: v('bad'),
      },
      // Noto Sans for text (it covers Devanagari, so Hindi patient names render in the same family), Figtree for headings and figures.
      fontFamily: { sans: ['"Noto Sans"', 'ui-sans-serif', 'system-ui', 'Segoe UI', 'Roboto', 'sans-serif'], display: ['Figtree', '"Noto Sans"', 'ui-sans-serif', 'system-ui', 'sans-serif'], mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'] },
      borderRadius: { lg: '8px', xl: '10px', '2xl': '14px' },
      boxShadow: {
        glow: '0 0 0 1px rgb(var(--blue) / 0.35), 0 6px 20px -8px rgb(var(--blue) / 0.35)',
        card: 'var(--shadow-card)',
        pop: 'var(--shadow-pop)',
      },
      keyframes: {
        'fade-up': { from: { opacity: 0, transform: 'translateY(8px)' }, to: { opacity: 1, transform: 'none' } },
        shimmer: { from: { backgroundPosition: '-400px 0' }, to: { backgroundPosition: '400px 0' } },
        'pulse-dot': { '0%,100%': { opacity: 1 }, '50%': { opacity: 0.45 } },
      },
      animation: { 'fade-up': 'fade-up 260ms cubic-bezier(0.2, 0.7, 0.2, 1) both', shimmer: 'shimmer 1.4s linear infinite', 'pulse-dot': 'pulse-dot 1.8s ease-in-out infinite' },
    },
  },
  plugins: [],
};
