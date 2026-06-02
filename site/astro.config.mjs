// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

// Bloom marketing site — a fully static, backend-free Astro build.
// Decoupled from the product app in ../frontend (see site/README.md).
// https://astro.build/config
export default defineConfig({
  // Your deployed URL. Used for canonical links / sitemap.
  site: 'https://li-evan.github.io',
  // Served from a GitHub *project* page at li-evan.github.io/Bloom — asset paths resolve under /Bloom.
  // For a custom domain or user page, set base back to '/' (or remove this line).
  base: '/Bloom',
  vite: {
    plugins: [tailwindcss()],
  },
});
