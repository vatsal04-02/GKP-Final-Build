import type { ImageMetadata } from 'astro';

/**
 * Real clinic photography is picked up by filename from src/assets/clinic/.
* Slots: hero, gallery-1…N (see `gallery` in site.ts), doctors-together,
 *        doctor-sandeep, doctor-mahesh  (.jpg .jpeg .png .webp .avif)
 *
 * No stock or generated imagery is ever substituted — an empty slot renders a clearly
 * marked placeholder instead.
 */
const files = import.meta.glob<{ default: ImageMetadata }>('/src/assets/clinic/*.{jpg,jpeg,png,webp,avif}', {
  eager: true,
});

const bySlot = new Map<string, ImageMetadata>();
for (const [path, mod] of Object.entries(files)) {
  const slot = path.split('/').pop()!.replace(/\.[^.]+$/, '');
  bySlot.set(slot, mod.default);
}

/** Accepts one slot name or an ordered list of acceptable names (first match wins). */
export function getPhoto(slot: string | readonly string[]): ImageMetadata | undefined {
  for (const name of typeof slot === 'string' ? [slot] : slot) {
    const photo = bySlot.get(name);
    if (photo) return photo;
  }
  return undefined;
}
