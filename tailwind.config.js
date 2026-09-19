/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
    "./components/**/*.{js,ts,jsx,tsx}",
    "./*.{js,ts,jsx,tsx}",
    // The AI module ships components that are bundled into the app and already
    // render Tailwind classes. Without this glob a utility used ONLY there is
    // never generated — `select-text` and `pl-0.5` in the stack drill-down were
    // silently missing. The glob matches nothing when the module is absent.
    "./ai-intelligence/src/**/*.{ts,tsx}",
  ],
  darkMode: ['class', '[data-theme="dark"]'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', '-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'Roboto', '"Helvetica Neue"', 'Arial', 'sans-serif'],
      },
      colors: {
        'gray-950': 'rgb(var(--gray-950) / <alpha-value>)',
        'gray-900': 'rgb(var(--gray-900) / <alpha-value>)',
        'gray-800': 'rgb(var(--gray-800) / <alpha-value>)',
        'gray-700': 'rgb(var(--gray-700) / <alpha-value>)',
        'gray-600': 'rgb(var(--gray-600) / <alpha-value>)',
        'gray-500': 'rgb(var(--gray-500) / <alpha-value>)',
        'gray-400': 'rgb(var(--gray-400) / <alpha-value>)',
        'gray-300': 'rgb(var(--gray-300) / <alpha-value>)',
        'gray-200': 'rgb(var(--gray-200) / <alpha-value>)',
        'gray-100': 'rgb(var(--gray-100) / <alpha-value>)',
        'gray-50': 'rgb(var(--gray-50) / <alpha-value>)',
        'blue-500': 'rgb(var(--blue-500) / <alpha-value>)',
        'accent': 'rgb(var(--accent) / <alpha-value>)',
      }
    },
  },
  plugins: [],
}
