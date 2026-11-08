/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/**/*.{js,ts,jsx,tsx}", "./components/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        wire: {
          bg: 'var(--bg)',
          surface: 'var(--surface)',
          line: 'var(--line)',
          text: 'var(--text)',
          muted: 'var(--muted)',
          green: 'var(--wire-green)',
          violet: 'var(--wire-violet)',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        display: ['Unbounded', 'Inter', 'system-ui', 'sans-serif'],
        mono: ['Martian Mono', 'ui-monospace', 'monospace'],
      },
    },
  },
  plugins: [],
};
