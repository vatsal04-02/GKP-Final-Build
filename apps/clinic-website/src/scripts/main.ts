/**
 * Small, dependency-free progressive enhancement for the marketing page.
 * Everything here is optional: with JS off or failing, all content, links, WhatsApp and
 * phone actions still work (the `.js` class that hides reveal/FAQ content is only added by
 * an inline script in <head>, and every observer below falls back to showing content).
 */

import { initBodyMap } from './bodymap';
import { initBooking } from './booking';
import { initGallery } from './gallery';
import { initGoogleReviews } from './google-reviews';
import { initHeroVideo } from './hero-video';

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
  }
}

const root = document.documentElement;
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const qs = <T extends Element = HTMLElement>(sel: string, scope: ParentNode = document) => scope.querySelector<T>(sel);
const qsa = <T extends Element = HTMLElement>(sel: string, scope: ParentNode = document) =>
  Array.from(scope.querySelectorAll<T>(sel));

/* ---------- Analytics (no-op unless GA is configured; never sends patient data) ---------- */

type EventParams = Record<string, string | number>;

function track(name: string, params: EventParams = {}): void {
  try {
    window.gtag?.('event', name, params);
  } catch {
    /* analytics must never break the page */
  }
}

document.addEventListener('click', (event) => {
  const el = (event.target as Element | null)?.closest<HTMLElement>('[data-track]');
  if (!el?.dataset.track) return;
  const params: EventParams = {};
  if (el.dataset.location) params.location = el.dataset.location;
  if (el.dataset.concern) params.concern = el.dataset.concern;
  track(el.dataset.track, params);
});

/* ---------- Header: scrolled state + progress ---------- */

const header = qs('[data-header]');
const progress = qs('[data-progress]');
let scrollTick = false;

function updateScroll(): void {
  scrollTick = false;
  const y = window.scrollY;
  header?.classList.toggle('is-scrolled', y > 40);
  if (progress) {
    const max = root.scrollHeight - window.innerHeight;
    progress.style.setProperty('--p', String(max > 0 ? Math.min(1, y / max) : 0));
  }
}
window.addEventListener(
  'scroll',
  () => {
    if (!scrollTick) {
      scrollTick = true;
      requestAnimationFrame(updateScroll);
    }
  },
  { passive: true },
);
updateScroll();

// The header drops its blur while it floats over the hero video (see Header.astro)
const heroEl = qs('[data-hero]');
if (header && heroEl && 'IntersectionObserver' in window) {
  new IntersectionObserver((entries) => header.classList.toggle('is-over-video', entries.some((e) => e.isIntersecting)), {
    rootMargin: '-72px 0px 0px 0px',
  }).observe(heroEl);
}

/* ---------- Active section + sliding nav indicator ---------- */

const navList = qs('[data-nav-list]');
const indicator = qs('[data-nav-indicator]');
const navLinks = qsa<HTMLAnchorElement>('[data-nav-link]');
// Sections without their own nav entry highlight their closest parent topic.
const navAlias: Record<string, string | null> = { top: null, why: 'conditions', clinic: 'doctors', contact: 'reviews' };

function placeIndicator(link: HTMLElement | null): void {
  if (!indicator) return;
  if (!link || link.offsetParent === null) {
    indicator.removeAttribute('data-visible');
    return;
  }
  indicator.style.setProperty('--x', `${link.offsetLeft}px`);
  indicator.style.setProperty('--w', `${link.offsetWidth}px`);
  indicator.setAttribute('data-visible', 'true');
}

function setActive(id: string | null): void {
  const target = id ? (navAlias[id] === undefined ? id : navAlias[id]) : null;
  let activeLink: HTMLAnchorElement | null = null;
  for (const link of navLinks) {
    const match = target !== null && link.getAttribute('href') === `#${target}`;
    if (match) {
      link.setAttribute('aria-current', 'true');
      activeLink = link;
    } else {
      link.removeAttribute('aria-current');
    }
  }
  placeIndicator(activeLink);
}

const currentLink = () => navLinks.find((l) => l.getAttribute('aria-current') === 'true') ?? null;

if ('IntersectionObserver' in window) {
  const sectionObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) if (entry.isIntersecting) setActive(entry.target.id);
    },
    { rootMargin: '-42% 0px -53% 0px', threshold: 0 },
  );
  qsa('[data-section]').forEach((s) => sectionObserver.observe(s));
}

navLinks.forEach((link) => {
  link.addEventListener('pointerenter', () => placeIndicator(link));
  link.addEventListener('click', () => setActive(link.getAttribute('href')?.slice(1) ?? null));
});
navList?.addEventListener('pointerleave', () => placeIndicator(currentLink()));
window.addEventListener('resize', () => placeIndicator(currentLink()), { passive: true });

/* ---------- Mobile menu ---------- */

const menuToggle = qs<HTMLButtonElement>('[data-menu-toggle]');
const menu = qs('[data-menu]');
const backdropTargets = qsa('main, footer, [data-sticky-cta]');

function setMenu(open: boolean, returnFocus = false): void {
  if (!menuToggle || !menu) return;
  menuToggle.setAttribute('aria-expanded', String(open));
  menuToggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
  menu.dataset.open = String(open);
  menu.toggleAttribute('inert', !open);
  menu.setAttribute('aria-hidden', String(!open));
  root.classList.toggle('menu-open', open);
  backdropTargets.forEach((el) => el.toggleAttribute('inert', open));
  if (open) qs<HTMLAnchorElement>('a', menu)?.focus({ preventScroll: true });
  else if (returnFocus) menuToggle.focus({ preventScroll: true });
}

menuToggle?.addEventListener('click', () => setMenu(menuToggle.getAttribute('aria-expanded') !== 'true'));
menu?.addEventListener('click', (event) => {
  const target = event.target as Element;
  if (target.closest('a')) setMenu(false);
  else if (target === menu) setMenu(false, true); // click on the dimmed backdrop
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && menu?.dataset.open === 'true') setMenu(false, true);
});
window.matchMedia('(min-width: 1100px)').addEventListener('change', (e) => {
  if (e.matches) setMenu(false);
});

/* ---------- Scroll reveal ---------- */

const revealEls = qsa('.reveal');
if (reduceMotion || !('IntersectionObserver' in window)) {
  revealEls.forEach((el) => el.classList.add('in-view'));
} else {
  // A container can wait for a child to scroll into view (data-reveal-on="<selector>") so a
  // multi-step sequence starts when its main element is visible, not when its top edge is.
  const revealTarget = new Map<Element, Element>();
  const revealObserver = new IntersectionObserver(
    (entries, obs) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        revealTarget.get(entry.target)?.classList.add('in-view');
        obs.unobserve(entry.target);
      }
    },
    { rootMargin: '0px 0px -8% 0px', threshold: 0 },
  );
  revealEls.forEach((el) => {
    const trigger = (el.dataset.revealOn && el.querySelector(el.dataset.revealOn)) || el;
    revealTarget.set(trigger, el);
    revealObserver.observe(trigger);
  });
}

/* ---------- Ambient animation only while on screen ---------- */

if ('IntersectionObserver' in window) {
  const ambientObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) entry.target.classList.toggle('is-live', entry.isIntersecting);
    },
    { rootMargin: '120px 0px' },
  );
  qsa('[data-ambient]').forEach((el) => ambientObserver.observe(el));
}

/* ---------- Count-up numerals: 0 → value over 1.2s (ease-out) once, when the stats band comes into view ---------- */

if (!reduceMotion && 'IntersectionObserver' in window) {
  const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
  const counters = qsa('.num [data-count], .num[data-count]');
  const render = (el: HTMLElement, v: number) => {
    const decimals = Number(el.dataset.decimals ?? 0);
    el.textContent = v.toLocaleString('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  };
  // Read live: google-reviews.ts may replace data-count with the real figure before or during the count
  const target = (el: HTMLElement) => parseFloat(el.dataset.count ?? '');
  const live = counters.filter((el) => !Number.isNaN(target(el)));
  live.forEach((el) => {
    el.dataset.counting = '1';
    render(el, 0);
  });
  const band = live[0]?.closest('.trust');
  if (band) {
    new IntersectionObserver(
      ([entry], obs) => {
        if (!entry?.isIntersecting) return;
        obs.disconnect();
        const start = performance.now();
        const duration = 1200;
        const frame = (now: number) => {
          const t = Math.min(1, (now - start) / duration);
          live.forEach((el) => render(el, target(el) * easeOut(t)));
          if (t < 1) requestAnimationFrame(frame);
          else live.forEach((el) => ((el.dataset.counted = '1'), render(el, target(el))));
        };
        requestAnimationFrame(frame);
      },
      { threshold: 0.4 },
    ).observe(band);
  }
}

/* ---------- Sticky WhatsApp CTA: appears once the hero CTA scrolls away ---------- */

const stickyCta = qs('[data-sticky-cta]');
const heroCta = qs('[data-hero-cta]');
if (stickyCta && 'IntersectionObserver' in window) {
  let heroVisible = Boolean(heroCta);
  const hideZones = new Set<Element>();
  const refresh = () => stickyCta.classList.toggle('is-visible', !heroVisible && hideZones.size === 0);

  if (heroCta) {
    new IntersectionObserver(([entry]) => {
      heroVisible = Boolean(entry?.isIntersecting);
      refresh();
    }).observe(heroCta);
  }
  const zoneObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) hideZones.add(entry.target);
        else hideZones.delete(entry.target);
      }
      refresh();
    },
    { rootMargin: '-25% 0px -25% 0px' },
  );
  qsa('[data-hide-sticky]').forEach((z) => zoneObserver.observe(z));
  refresh();
} else {
  stickyCta?.classList.add('is-visible');
}

/* ---------- FAQ accordion — one open at a time ---------- */

const faqButtons = qsa<HTMLButtonElement>('[data-faq-btn]');
faqButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    const open = btn.getAttribute('aria-expanded') !== 'true';
    for (const other of faqButtons) {
      const isOpen = other === btn && open;
      other.setAttribute('aria-expanded', String(isOpen));
      other.closest('.item')?.classList.toggle('is-open', isOpen);
    }
    if (open) track('faq_open', { question_index: Number(btn.dataset.faqIndex ?? 0) });
  });
});

/* ---------- Hero background video ---------- */

qsa('[data-hero]').forEach((el) => initHeroVideo(el, reduceMotion));

/* ---------- Body map: hotspot → condition card ---------- */

qsa('[data-bodymap]').forEach((el) => initBodyMap(el, reduceMotion));

/* ---------- Clinic photo viewer: arrows, counter, thumbnails ---------- */

qsa('[data-gallery]').forEach((el) => initGallery(el, reduceMotion));

/* ---------- Review slider: dots, arrows, 6s autoplay that pauses on hover/touch ---------- */

const AUTOPLAY_MS = 6000;

qsa('[data-slider]').forEach((slider) => {
  const viewport = qs('[data-slider-track]', slider);
  const controls = qs('.slider__ctrl', slider);
  const dotsWrap = qs('[data-slider-dots]', slider);
  const pauseBtn = qs<HTMLButtonElement>('[data-slider-pause]', slider);
  if (!viewport || !controls || !dotsWrap) return;
  // Read live: the cards can be swapped for live Google reviews after load
  const slides = () => Array.from(viewport.children) as HTMLElement[];

  let pages = 1;
  let index = 0;
  let timer = 0;
  let userPaused = reduceMotion; // never auto-advance for people who asked for less motion
  let hovering = false;
  let touching = false;
  let focused = false;
  let onScreen = true;

  const metrics = () => {
    const gap = parseFloat(getComputedStyle(viewport).columnGap) || 0;
    const list = slides();
    const step = (list[0]?.offsetWidth ?? 1) + gap;
    const perView = Math.max(1, Math.round((viewport.clientWidth + gap) / step));
    return { step, pages: Math.max(1, list.length - perView + 1) };
  };
  const paint = () => {
    Array.from(dotsWrap.children).forEach((d, i) => d.setAttribute('aria-current', String(i === index)));
  };
  const schedule = () => {
    window.clearInterval(timer);
    if (pages > 1 && !userPaused && !hovering && !touching && !focused && onScreen && !document.hidden) {
      timer = window.setInterval(() => goTo(index + 1), AUTOPLAY_MS);
    }
  };
  const goTo = (i: number) => {
    const m = metrics();
    index = (i + m.pages) % m.pages;
    viewport.scrollTo({ left: index * m.step, behavior: reduceMotion ? 'auto' : 'smooth' });
    paint();
  };
  // "Read more" is only offered on cards whose text is actually cut off at three lines
  const checkClamp = () => {
    for (const card of slides()) {
      const text = qs('.card__text', card);
      const more = qs<HTMLButtonElement>('.card__more', card);
      if (!text || !more || card.classList.contains('is-open')) continue;
      more.hidden = text.scrollHeight <= text.clientHeight + 1;
    }
  };
  viewport.addEventListener('click', (event) => {
    const more = (event.target as Element | null)?.closest<HTMLButtonElement>('.card__more');
    const card = more?.closest<HTMLElement>('.card');
    if (!more || !card) return;
    const open = !card.classList.contains('is-open');
    card.classList.toggle('is-open', open);
    more.setAttribute('aria-expanded', String(open));
    more.textContent = open ? 'Show less' : 'Read more';
    track('review_interaction', { action: open ? 'expand' : 'collapse' });
  });
  const build = () => {
    checkClamp();
    pages = metrics().pages;
    controls.hidden = pages <= 1;
    dotsWrap.replaceChildren(
      ...Array.from({ length: pages }, (_, i) => {
        const dot = document.createElement('button');
        dot.type = 'button';
        dot.className = 'dot';
        dot.setAttribute('aria-label', `Go to review ${i + 1}`);
        dot.addEventListener('click', () => {
          goTo(i);
          schedule();
          track('review_interaction', { action: 'dot' });
        });
        return dot;
      }),
    );
    index = Math.min(index, pages - 1);
    paint();
    schedule();
  };

  viewport.addEventListener(
    'scroll',
    () => {
      const i = Math.round(viewport.scrollLeft / metrics().step);
      if (i !== index && i < pages) {
        index = i;
        paint();
      }
    },
    { passive: true },
  );
  qs('[data-slider-prev]', slider)?.addEventListener('click', () => {
    goTo(index - 1);
    schedule();
  });
  qs('[data-slider-next]', slider)?.addEventListener('click', () => {
    goTo(index + 1);
    schedule();
  });
  pauseBtn?.addEventListener('click', () => {
    userPaused = !userPaused;
    pauseBtn.setAttribute('aria-pressed', String(userPaused));
    pauseBtn.setAttribute('aria-label', userPaused ? 'Resume automatic slides' : 'Pause automatic slides');
    schedule();
  });
  if (pauseBtn && userPaused) {
    pauseBtn.setAttribute('aria-pressed', 'true');
    pauseBtn.setAttribute('aria-label', 'Resume automatic slides');
  }

  // Pause while the pointer is over it, while anything inside has focus, off screen, or in a background tab
  slider.addEventListener('pointerenter', () => ((hovering = true), schedule()));
  slider.addEventListener('pointerleave', () => ((hovering = false), schedule()));
  // A finger on the slider (swiping or just resting) holds it too; the next advance is a full interval after it lifts
  slider.addEventListener('touchstart', () => ((touching = true), schedule()), { passive: true });
  slider.addEventListener('touchend', () => ((touching = false), schedule()), { passive: true });
  slider.addEventListener('touchcancel', () => ((touching = false), schedule()), { passive: true });
  slider.addEventListener('focusin', () => ((focused = true), schedule()));
  slider.addEventListener('focusout', () => ((focused = false), schedule()));
  document.addEventListener('visibilitychange', schedule);
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(([entry]) => {
      onScreen = Boolean(entry?.isIntersecting);
      schedule();
    }).observe(slider);
  }

  let resizeTimer = 0;
  window.addEventListener(
    'resize',
    () => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(build, 150);
    },
    { passive: true },
  );
  // Web fonts change line breaks, so re-check which cards are cut off once they have loaded
  void document.fonts?.ready.then(checkClamp);
  // Fired when the cards are swapped (skeletons → live reviews → …)
  slider.addEventListener('slider:refresh', () => {
    index = 0;
    viewport.scrollTo({ left: 0, behavior: 'auto' });
    build();
  });
  build();
});

/* ---------- Live Google rating + reviews (no-op until a key and place ID are pasted in google-reviews.ts) ---------- */

initGoogleReviews();

/* ---------- Booking request form (WhatsApp message composer) ---------- */

initBooking(track);

/* ---------- Map: hand the embedded map over on tap/click so it never traps page scrolling ---------- */

qsa('[data-map]').forEach((stage) => {
  const guard = qs('[data-map-guard]', stage);
  guard?.addEventListener('click', () => {
    stage.dataset.active = 'true';
    track('map_interaction');
  });
  // Tapping anywhere else puts the guard back
  document.addEventListener('pointerdown', (event) => {
    if (stage.dataset.active && !stage.contains(event.target as Node)) delete stage.dataset.active;
  });
});

/* ---------- section_view analytics (once per section) ---------- */

if ('IntersectionObserver' in window) {
  const seen = new Set<string>();
  const viewObserver = new IntersectionObserver(
    (entries, obs) => {
      for (const entry of entries) {
        if (!entry.isIntersecting || seen.has(entry.target.id)) continue;
        seen.add(entry.target.id);
        track('section_view', { section: entry.target.id });
        obs.unobserve(entry.target);
      }
    },
    { threshold: 0.35 },
  );
  qsa('[data-section]').forEach((s) => viewObserver.observe(s));
}

/* ---------- Live "Open now / Closed" pill (always evaluated in clinic time, IST) ---------- */

const statusEl = qs('[data-open-status]');
const statusText = statusEl ? qs('[data-status-text]', statusEl) : null;
if (statusEl && statusText && statusEl.dataset.schedule) {
  type Schedule = { timeZone: string; days: number[]; sessions: [string, string][] };
  const cfg = JSON.parse(statusEl.dataset.schedule) as Schedule;
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const toMin = (hhmm: string) => {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
  };
  const sessions = cfg.sessions.map(([a, b]) => [toMin(a), toMin(b)] as const);
  const clock = (min: number) => {
    const h = Math.floor(min / 60);
    const m = min % 60;
    return `${h % 12 || 12}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h < 12 ? 'AM' : 'PM'}`;
  };
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: cfg.timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });

  const renderStatus = () => {
    const parts = formatter.formatToParts(new Date());
    const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    const day = WEEKDAYS.indexOf(part('weekday'));
    const now = Number(part('hour')) * 60 + Number(part('minute'));

    let state: 'open' | 'closed' = 'closed';
    let text = '';
    const current = cfg.days.includes(day) ? sessions.find(([a, b]) => now >= a && now < b) : undefined;
    const upcoming = cfg.days.includes(day) ? sessions.find(([a]) => now < a) : undefined;

    if (current) {
      state = 'open';
      text = `Open now · until ${clock(current[1])}`;
    } else if (upcoming) {
      text = `Closed now · opens ${clock(upcoming[0])}`;
    } else {
      // after the last session, or a closed day: find the next open day.
      // "tomorrow" is only right when today is a working day that has finished; from a closed day
      // (Sunday) or across one (Saturday night) it is named: "opens Monday 9 AM".
      let ahead = 1;
      while (ahead < 7 && !cfg.days.includes((day + ahead) % 7)) ahead++;
      const label = ahead === 1 && cfg.days.includes(day) ? 'tomorrow' : DAY_NAMES[(day + ahead) % 7];
      text = `Closed now · opens ${label} ${clock(sessions[0][0])}`;
    }
    statusEl.setAttribute('data-state', state);
    statusText.textContent = text;
  };
  renderStatus();
  window.setInterval(renderStatus, 30_000);
  document.addEventListener('visibilitychange', () => !document.hidden && renderStatus());
}

export {};
