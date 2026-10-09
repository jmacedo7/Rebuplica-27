/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{js,jsx}', './public/index.html'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"IBM Plex Sans"', 'system-ui', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'monospace'],
        display: ['"Bitter"', 'Georgia', 'serif'],
      },
      colors: {
        ink: {
          900: '#0b0f14',
          800: '#121820',
          700: '#1a2230',
          600: '#243041',
          500: '#36455a',
        },
        bone: '#e8e6e1',
        muted: '#98a3b3',
        verde: '#1f8a5b',
        amarelo: '#d8a21a',
        sangue: '#b4452f',
        azul: '#2f6fb4',
      },
      boxShadow: {
        panel: '0 1px 0 rgba(255,255,255,0.04) inset, 0 12px 32px -20px rgba(0,0,0,0.9)',
      },
    },
  },
  plugins: [],
};
