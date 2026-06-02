# Bloom — Marketing Site

The public landing page for Bloom, **fully decoupled from the product app** in
[`../frontend`](../frontend). This is a static [Astro](https://astro.build) build —
no backend, no API calls, no React app dependency. It can go down or be redeployed
without ever touching the product, exactly how open-source products keep their
marketing site (`example.com`) separate from the app (`app.example.com`).

## Stack

- **Astro** (static output) + **Tailwind CSS v4** (`@tailwindcss/vite`)
- Fonts: Outfit + JetBrains Mono (Google Fonts), matching the product's brand
- Bilingual EN / 中文 — toggled client-side, persisted to `localStorage`, zero i18n deps
- The signature visual (twin normal distributions, +2σ apart) is a hand-built SVG,
  its path computed at build time

## Develop

```bash
cd site
npm install
npm run dev        # http://localhost:4321
```

## Build & preview

```bash
npm run build      # outputs to site/dist (static HTML/CSS/JS)
npm run preview    # serve the production build locally
```

## Deploy

`site/dist` is a plain static bundle — deploy it anywhere (Vercel, Netlify,
Cloudflare Pages, GitHub Pages, S3…). The app's own deploy is unaffected.

**GitHub Pages:** a manual workflow lives at
[`../.github/workflows/deploy-site.yml`](../.github/workflows/deploy-site.yml).
To use it:

1. Repo **Settings → Pages → Build and deployment → Source: GitHub Actions**
2. Run the **"Deploy site to GitHub Pages"** workflow (Actions tab → Run workflow)
3. If serving from a project page (`li-evan.github.io/Bloom`), uncomment `base: '/Bloom'`
   in `astro.config.mjs`. For a custom domain, set `site:` and add `public/CNAME`.

The "Get started" CTAs link to the [GitHub repo](https://github.com/Li-Evan/Bloom)
and the local quick-start. If you ever host the web app publicly, point those CTAs
at that URL.
