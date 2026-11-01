import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';

// PUBLIC_SITE_URL overrides this. The default is the clinic's production domain (attached to the Vercel
// project), so the canonical URL, sitemap and social tags point at the address people actually visit.
// Keep it in step with `seo.siteUrl` in src/data/site.ts.
const site = process.env.PUBLIC_SITE_URL ?? 'https://geetakrishnaphysiotherapy.co.in';

export default defineConfig({
  site,
  integrations: [
    sitemap({
      lastmod: new Date(),
      // Home page first; the landing pages follow. (Google ignores these hints, other engines read them.)
      serialize(item) {
        const home = new URL(item.url).pathname === '/';
        return { ...item, changefreq: home ? 'weekly' : 'monthly', priority: home ? 1.0 : 0.8 };
      },
    }),
  ],
  vite: { plugins: [tailwindcss()] },
  build: { inlineStylesheets: 'auto' },
  devToolbar: { enabled: false },
});
