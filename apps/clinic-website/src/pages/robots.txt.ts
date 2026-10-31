import type { APIRoute } from 'astro';
import { seo } from '../data/site';

// Search and answer-engine crawlers are welcome (the clinic wants to be quoted when someone asks an assistant
// for a physiotherapist in Lucknow). Only the serverless endpoints are kept out of the index.
const crawlers = [
  '*',
  'Googlebot',
  'Bingbot',
  'Google-Extended',
  'GPTBot',
  'OAI-SearchBot',
  'ChatGPT-User',
  'ClaudeBot',
  'Claude-SearchBot',
  'Claude-User',
  'PerplexityBot',
  'Perplexity-User',
  'Applebot',
  'Applebot-Extended',
  'DuckDuckBot',
  'CCBot',
];

export const GET: APIRoute = ({ site }) => {
  const base = site ?? new URL(seo.siteUrl);
  const groups = crawlers.map((ua) => `User-agent: ${ua}`).join('\n');
  const body = `${groups}\nAllow: /\nDisallow: /api/\n\nSitemap: ${new URL('sitemap-index.xml', base).href}\n`;
  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
};
