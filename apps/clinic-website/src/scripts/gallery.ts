/**
 * Clinic photo viewer. The track is a plain CSS scroll-snap row, so swiping already works with no script;
 * this adds the arrows, the counter and the thumbnails on top of that one mechanism, plus an eager preload
 * (images in a clipped, scrolled row would otherwise not start loading until they were swiped into view).
 */

export function initGallery(root: HTMLElement, reduceMotion: boolean): void {
  const track = root.querySelector<HTMLElement>('[data-gal-track]');
  const slides = Array.from(root.querySelectorAll<HTMLElement>('[data-gal-slide]'));
  if (!track || slides.length < 2) return;

  const ctrl = root.querySelector<HTMLElement>('[data-gal-ctrl]');
  const thumbsWrap = root.querySelector<HTMLElement>('[data-gal-thumbs]');
  const thumbs = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-gal-thumb]'));
  const prev = root.querySelector<HTMLButtonElement>('[data-gal-prev]');
  const next = root.querySelector<HTMLButtonElement>('[data-gal-next]');
  const now = root.querySelector<HTMLElement>('[data-gal-now]');

  let index = 0;

  const setActive = (i: number): void => {
    if (i === index && slides[i].classList.contains('is-active')) return;
    index = i;
    slides.forEach((s, n) => s.classList.toggle('is-active', n === i));
    thumbs.forEach((t, n) => {
      if (n === i) t.setAttribute('aria-current', 'true');
      else t.removeAttribute('aria-current');
    });
    if (now) now.textContent = String(i + 1);
    prev?.setAttribute('aria-disabled', String(i === 0));
    next?.setAttribute('aria-disabled', String(i === slides.length - 1));
  };

  // While an arrow / thumbnail scroll is gliding past the slides in between, the observer must not
  // flicker the counter or send a quick second click to the wrong place
  let gliding = false;
  let glideTimer = 0;
  const endGlide = (): void => {
    gliding = false;
    window.clearTimeout(glideTimer);
  };
  track.addEventListener('scrollend', endGlide);

  const go = (i: number): void => {
    const target = Math.max(0, Math.min(slides.length - 1, i));
    setActive(target);
    gliding = true;
    window.clearTimeout(glideTimer);
    glideTimer = window.setTimeout(endGlide, 900); // browsers without `scrollend`
    track.scrollTo({ left: slides[target].offsetLeft - track.offsetLeft, behavior: reduceMotion ? 'auto' : 'smooth' });
  };

  // Whichever slide fills most of the viewport is the current one — works for swipes, arrows and keys alike
  const io = new IntersectionObserver(
    (entries) => {
      if (gliding) return;
      for (const entry of entries) {
        if (entry.isIntersecting && entry.intersectionRatio >= 0.6) setActive(slides.indexOf(entry.target as HTMLElement));
      }
    },
    { root: track, threshold: [0.6] },
  );
  slides.forEach((s) => io.observe(s));

  prev?.addEventListener('click', () => index > 0 && go(index - 1));
  next?.addEventListener('click', () => index < slides.length - 1 && go(index + 1));
  thumbs.forEach((t, n) => t.addEventListener('click', () => go(n)));

  track.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowRight') go(index + 1);
    else if (event.key === 'ArrowLeft') go(index - 1);
    else if (event.key === 'Home') go(0);
    else if (event.key === 'End') go(slides.length - 1);
    else return;
    event.preventDefault();
  });

  // Start fetching the off-screen photographs as the section approaches
  const preload = new IntersectionObserver(
    (entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      preload.disconnect();
      root.querySelectorAll<HTMLImageElement>('img[loading="lazy"]').forEach((img) => (img.loading = 'eager'));
    },
    { rootMargin: '600px 0px' },
  );
  preload.observe(root);

  ctrl?.removeAttribute('hidden');
  thumbsWrap?.removeAttribute('hidden');
  setActive(0);
  prev?.setAttribute('aria-disabled', 'true');
  next?.setAttribute('aria-disabled', 'false');
}
