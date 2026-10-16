import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';

// Set PUBLIC_SITE_URL at deploy time. The default is the clinic's current site and must be
// confirmed before launch — it drives the canonical URL, sitemap and social tags.
const site = process.env.PUBLIC_SITE_URL ?? 'https://geeta-krishna.grexa.site';

export default defineConfig({
  site,
  integrations: [sitemap()],
  vite: { plugins: [tailwindcss()] },
  build: { inlineStylesheets: 'auto' },
  devToolbar: { enabled: false },
});
