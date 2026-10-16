import type { APIRoute } from 'astro';

export const GET: APIRoute = ({ site }) => {
  const base = site ?? new URL('https://geeta-krishna.grexa.site');
  const body = `User-agent: *\nAllow: /\n\nSitemap: ${new URL('sitemap-index.xml', base).href}\n`;
  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
};
