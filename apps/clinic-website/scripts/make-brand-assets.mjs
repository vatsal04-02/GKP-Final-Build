/**
 * Generates the social-share image (public/og.png) and iOS icon (public/apple-touch-icon.png).
 * Text is converted to vector outlines from the bundled DM Serif Display font, so output does not
 * depend on system fonts. Run with: node scripts/make-brand-assets.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import opentype from 'opentype.js';
import sharp from 'sharp';

const root = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const buf = readFileSync(root('node_modules/@fontsource/dm-serif-display/files/dm-serif-display-latin-400-normal.woff'));
const font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

// opentype.js's own toPathData() emits NaN for some coordinates in this font, so serialise manually.
const n = (v) => (Math.round(v * 100) / 100).toString();
const toD = (commands) =>
  commands
    .map((c) => {
      switch (c.type) {
        case 'M':
        case 'L':
          return `${c.type}${n(c.x)} ${n(c.y)}`;
        case 'Q':
          return `Q${n(c.x1)} ${n(c.y1)} ${n(c.x)} ${n(c.y)}`;
        case 'C':
          return `C${n(c.x1)} ${n(c.y1)} ${n(c.x2)} ${n(c.y2)} ${n(c.x)} ${n(c.y)}`;
        default:
          return 'Z';
      }
    })
    .join('');

const text = (str, x, y, size, fill, opacity = 1, anchor = 'start') => {
  const width = font.getAdvanceWidth(str, size, { kerning: false });
  const ox = anchor === 'middle' ? x - width / 2 : x;
  const path = font.getPath(str, ox, y, size, { kerning: false });
  return `<path d="${toD(path.commands)}" fill="${fill}" fill-opacity="${opacity}"/>`;
};

// Goniometer-style ring motif, matching the hero graphic
const ticks = Array.from({ length: 60 }, (_, i) => {
  const a = (i * 6 * Math.PI) / 180, major = i % 5 === 0, r = 230, len = major ? 22 : 10;
  const [cx, cy] = [940, 330];
  return `<line x1="${cx + Math.cos(a) * r}" y1="${cy + Math.sin(a) * r}" x2="${cx + Math.cos(a) * (r - len)}" y2="${cy + Math.sin(a) * (r - len)}" stroke="#E9DFC9" stroke-opacity="${major ? 0.6 : 0.3}" stroke-width="${major ? 2.5 : 1.5}"/>`;
}).join('');

const og = `
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0F766E"/><stop offset=".55" stop-color="#0C4A45"/><stop offset="1" stop-color="#0C3B36"/></linearGradient>
    <radialGradient id="glow" cx=".78" cy=".5" r=".55"><stop offset="0" stop-color="#2f9c92" stop-opacity=".55"/><stop offset="1" stop-color="#0C3B36" stop-opacity="0"/></radialGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <rect width="1200" height="630" fill="url(#glow)"/>
  <circle cx="940" cy="330" r="300" fill="none" stroke="#E9DFC9" stroke-opacity=".14" stroke-dasharray="3 12"/>
  <circle cx="940" cy="330" r="230" fill="none" stroke="#E9DFC9" stroke-opacity=".5" stroke-width="2"/>
  <circle cx="940" cy="330" r="140" fill="none" stroke="#E9DFC9" stroke-opacity=".16"/>
  ${ticks}
  <line x1="940" y1="330" x2="1130" y2="330" stroke="#FAF8F2" stroke-width="5" stroke-linecap="round"/>
  <line x1="940" y1="330" x2="${940 + 190 * Math.cos(0.9)}" y2="${330 - 190 * Math.sin(0.9)}" stroke="#FAF8F2" stroke-width="5" stroke-linecap="round"/>
  <circle cx="940" cy="330" r="22" fill="#0C3B36" stroke="#E9DFC9" stroke-width="3"/><circle cx="940" cy="330" r="9" fill="#E9DFC9"/>
  <rect x="72" y="72" width="72" height="72" rx="20" fill="#FAF8F2" fill-opacity=".12" stroke="#FAF8F2" stroke-opacity=".3"/>
  ${text('GK', 108, 123, 38, '#FAF8F2', 1, 'middle')}
  ${text('Geeta Krishna', 72, 330, 96, '#FAF8F2')}
  ${text('Physiotherapy', 72, 430, 96, '#E9DFC9')}
  ${text('Gomti Nagar, Lucknow', 72, 520, 40, '#FAF8F2', 0.82)}
  <rect x="72" y="560" width="64" height="3" fill="#E9DFC9" fill-opacity=".7"/>
</svg>`;

const icon = `
<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180" viewBox="0 0 180 180">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0F766E"/><stop offset="1" stop-color="#0C3B36"/></linearGradient></defs>
  <rect width="180" height="180" fill="url(#g)"/>
  <circle cx="90" cy="92" r="58" fill="none" stroke="#E9DFC9" stroke-opacity=".35" stroke-width="2" stroke-dasharray="3 7"/>
  ${text('GK', 90, 117, 72, '#FAF8F2', 1, 'middle')}
</svg>`;

await sharp(Buffer.from(og)).png({ compressionLevel: 9 }).toFile(root('public/og.png'));
await sharp(Buffer.from(icon)).png({ compressionLevel: 9 }).toFile(root('public/apple-touch-icon.png'));
console.log('Wrote public/og.png and public/apple-touch-icon.png');
