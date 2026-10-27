/**
 * Builds every logo asset from the two supplied files in src/assets/brand/:
 *   gkp-logo-light.webp   pine lettering on cream  (supplied by the clinic)
 *   gkp-logo-dark.webp    cream lettering on pine  (supplied by the clinic)
 *
 * Outputs
 *   public/brand/gkp-mark-pine.webp    transparent GKP + peacock-feather mark (no tagline), for light surfaces
 *   public/brand/gkp-mark-cream.webp   the same for dark surfaces
 *   public/favicon.png, public/apple-touch-icon.png   the feather mark on pine
 *   public/og.png                      the full lockup, 1200 × 630, for social previews
 *
 * The supplied files have a solid background, so the transparent marks are made with "colour to alpha": each pixel's
 * opacity is how far it is from the background colour, and its colour is un-mixed from that background. Run with:
 *   node scripts/make-logo-assets.mjs
 */
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const at = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));

async function colourToAlpha(file) {
  const { data, info } = await sharp(at(file)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const out = Buffer.from(data);
  const bg = [data[0], data[1], data[2]]; // the corner pixel is the background
  for (let i = 0; i < data.length; i += 4) {
    let alpha = 0;
    for (let c = 0; c < 3; c++) {
      const p = data[i + c], b = bg[c];
      const a = p < b ? (b ? (b - p) / b : 0) : 255 - b ? (p - b) / (255 - b) : 0;
      if (a > alpha) alpha = a;
    }
    if (alpha < 0.035) { out[i + 3] = 0; continue; } // compression noise in the flat background
    for (let c = 0; c < 3; c++) out[i + c] = Math.max(0, Math.min(255, Math.round(bg[c] + (data[i + c] - bg[c]) / alpha)));
    out[i + 3] = Math.round(Math.min(1, alpha) * 255);
  }
  return { out, info };
}

async function mark(file, name) {
  const { out, info } = await colourToAlpha(file);
  // the tagline sits below row ~1030 of the 2000 × 1367 sources: keep only the GKP lettering and the feather
  const img = sharp(out, { raw: { width: info.width, height: info.height, channels: 4 } });
  const { data, info: ci } = await img.clone().extract({ left: 0, top: 0, width: info.width, height: 1030 }).raw().toBuffer({ resolveWithObject: true });
  // bounding box of the solid artwork: a row or column only counts if several clearly opaque pixels sit in it,
  // so stray compression specks in the flat background never widen the crop
  const rows = new Uint16Array(ci.height), cols = new Uint16Array(ci.width);
  for (let y = 0; y < ci.height; y++) for (let x = 0; x < ci.width; x++) if (data[(y * ci.width + x) * 4 + 3] > 140) { rows[y]++; cols[x]++; }
  const first = (a) => a.findIndex((n) => n >= 4);
  const last = (a) => a.length - 1 - [...a].reverse().findIndex((n) => n >= 4);
  const [x0, y0, x1, y1] = [first(cols), first(rows), last(cols), last(rows)];
  const pad = 12;
  await img
    .extract({ left: Math.max(0, x0 - pad), top: Math.max(0, y0 - pad), width: x1 - x0 + 2 * pad, height: y1 - y0 + 2 * pad })
    .resize({ width: 720 })
    .webp({ quality: 92, alphaQuality: 100 })
    .toFile(at(`public/brand/${name}.webp`));
}

await mark('src/assets/brand/gkp-logo-light.webp', 'gkp-mark-pine');
await mark('src/assets/brand/gkp-logo-dark.webp', 'gkp-mark-cream');

// Icons: the feather alone, on the brand pine (the dark logo's own background)
const feather = { left: 1080, top: 290, width: 260, height: 260 };
for (const [file, size] of [['public/favicon.png', 64], ['public/apple-touch-icon.png', 180]]) {
  await sharp(at('src/assets/brand/gkp-logo-dark.webp')).extract(feather).resize(size, size).png({ compressionLevel: 9 }).toFile(at(file));
}

// Social preview: the full lockup, centred on the cream the file is already painted with
await sharp(at('src/assets/brand/gkp-logo-light.webp'))
  .resize({ width: 1200, height: 630, fit: 'contain', background: { r: 242, g: 238, b: 223 } })
  .png({ compressionLevel: 9 })
  .toFile(at('public/og.png'));

console.log('logo assets written');
