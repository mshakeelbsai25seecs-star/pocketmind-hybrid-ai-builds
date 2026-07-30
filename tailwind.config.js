/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Lighter green accent (shifted up from classic Conductor #22c55e)
        primary: {
          50: '#f3fef6',
          100: '#e8fceb',
          200: '#d1fadf',
          300: '#a7f3c0',
          400: '#86efac',
          500: '#4ade80',
          600: '#22c55e',
          700: '#16a34a',
          800: '#15803d',
          900: '#166534',
          950: '#14532d',
        },
        // True-black / zinc neutrals (matches Android PmBlack / PmPanel / PmLight*)
        surface: {
          50: '#fafafa',
          100: '#f5f5f5',
          200: '#e5e5e5',
          300: '#d4d4d4',
          400: '#a3a3a3',
          500: '#737373',
          600: '#525252',
          700: '#2a2a2a',
          800: '#171717',
          900: '#0a0a0a',
          950: '#000000',
        },
      },
    },
  },
  plugins: [],
}
