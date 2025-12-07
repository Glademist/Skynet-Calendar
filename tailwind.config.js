/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./src/**/*.{js,jsx,ts,tsx}",   // prohledá všechny soubory v src
    "./public/index.html"
  ],
  safelist: [
    'bg-amber-500',
    'text-white',
    'font-bold'
  ],
  theme: {
    extend: {},
  },
  plugins: [],
}