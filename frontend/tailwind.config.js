/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        terminal: {
          // Solid colors (no opacity variants)
          bg:      'var(--t-bg)',
          surface: 'var(--t-surface)',
          card:    'var(--t-card)',
          hover:   'var(--t-hover)',
          blue:    'var(--t-blue)',
          gray:    'var(--t-gray)',
          text:    'var(--t-text)',
          muted:   'var(--t-muted)',
          // Colors used with opacity variants (e.g. /10, /30, /50)
          green:       'rgb(var(--t-green) / <alpha-value>)',
          'green-dim': 'rgb(var(--t-green-dim) / <alpha-value>)',
          red:         'rgb(var(--t-red) / <alpha-value>)',
          'red-dim':   'rgb(var(--t-red-dim) / <alpha-value>)',
          amber:       'rgb(var(--t-amber) / <alpha-value>)',
          border:      'rgb(var(--t-border) / <alpha-value>)',
          dim:         'rgb(var(--t-dim) / <alpha-value>)',
        }
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'Consolas', 'monospace'],
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      animation: {
        'pulse-green': 'pulseGreen 2s ease-in-out infinite',
      }
    }
  },
  plugins: []
}
