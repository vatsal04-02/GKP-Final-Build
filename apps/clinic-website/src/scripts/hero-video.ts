/**
 * Hero background video. Nothing here is on the critical path: the poster (the loop's first frame) is what paints,
 * and the video is only attached once the page has loaded and the browser is idle.
 *
 * It stays a still poster for visitors who ask for reduced motion, for data-saver and 2G connections, and
 * wherever autoplay is refused. It pauses while the hero is off screen or the tab is hidden, and a visible
 * button lets anyone stop it.
 */

interface NetworkInformation {
  saveData?: boolean;
  effectiveType?: string;
}

export function initHeroVideo(root: HTMLElement, reduceMotion: boolean): void {
  const media = root.querySelector<HTMLElement>('[data-hero-media]');
  const video = root.querySelector<HTMLVideoElement>('[data-hero-video]');
  const pauseBtn = root.querySelector<HTMLButtonElement>('[data-hero-pause]');
  if (!media || !video) return;

  const conn = (navigator as Navigator & { connection?: NetworkInformation }).connection;
  const lean = Boolean(conn?.saveData) || /(^|-)2g$/.test(conn?.effectiveType ?? '');
  if (reduceMotion || lean) return;

  const phone = window.matchMedia('(max-width: 639px)');
  const pick = (): string => (phone.matches ? video.dataset.srcPhone : video.dataset.src) || video.dataset.src || '';

  let started = false;
  let onScreen = true;
  let userPaused = false;

  const sync = (): void => {
    if (!started) return;
    if (userPaused || !onScreen || document.hidden) video.pause();
    else void video.play().catch(() => undefined); // autoplay refused: the poster simply stays
  };

  const start = (): void => {
    started = true;
    video.muted = true; // as a property too: some browsers only honour autoplay for a muted *property*
    video.src = pick();
    video.addEventListener(
      'playing',
      () => {
        media.classList.add('is-playing');
        if (pauseBtn) pauseBtn.hidden = false;
      },
      { once: true },
    );
    video.addEventListener('error', () => {
      media.classList.remove('is-playing');
      if (pauseBtn) pauseBtn.hidden = true;
    });
    video.load();
    sync();
  };

  // Rotating a tablet or resizing across the phone breakpoint swaps to the matching file
  phone.addEventListener('change', () => {
    if (!started) return;
    const next = pick();
    if (next && !video.currentSrc.endsWith(next.split('/').pop() ?? '')) {
      video.src = next;
      video.load();
      sync();
    }
  });

  if ('IntersectionObserver' in window) {
    new IntersectionObserver(
      (entries) => {
        onScreen = entries.some((e) => e.isIntersecting);
        sync();
      },
      { threshold: 0 },
    ).observe(root);
  }
  document.addEventListener('visibilitychange', sync);

  pauseBtn?.addEventListener('click', () => {
    userPaused = !userPaused;
    pauseBtn.setAttribute('aria-pressed', String(userPaused));
    pauseBtn.setAttribute('aria-label', userPaused ? 'Play the background video' : 'Pause the background video');
    sync();
  });

  const whenIdle = (): void => {
    // Safari has no requestIdleCallback
    if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(start, { timeout: 2500 });
    else window.setTimeout(start, 600);
  };
  if (document.readyState === 'complete') whenIdle();
  else window.addEventListener('load', whenIdle, { once: true });
}
