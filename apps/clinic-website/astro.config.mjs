import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';

// PUBLIC_SITE_URL overrides this. The default is the clinic's production domain (attached to the Vercel
// project), so the canonical URL, sitemap and social tags point at the address people actually visit.
// Keep it in step with `seo.siteUrl` in src/data/site.ts.
const site = process.env.PUBLIC_SITE_URL ?? 'https://geetakrishnaphysiotherapy.co.in';

export default defineConfig({
  site,
  integrations: [sitemap({ lastmod: new Date() })],
  vite: { plugins: [tailwindcss()] },
  build: { inlineStylesheets: 'auto' },
  devToolbar: { enabled: false },
});
