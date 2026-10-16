/* ============================================================================================
 * LIVE GOOGLE REVIEWS — paste your own values here.
 *
 * Both constants are shipped to the browser, so restrict the key in Google Cloud Console
 * (Credentials → the key → "Websites" referrer restriction for your domain, and "API restrictions"
 * → Places API (New) only).
 *
 * While either value is still a placeholder this module does nothing at all: no request is made and
 * the page keeps its built-in reviews (`reviews` in src/data/site.ts).
 * ============================================================================================ */
const GOOGLE_PLACES_API_KEY = 'PASTE_KEY_HERE';
const GOOGLE_PLACE_ID = 'PASTE_PLACE_ID_HERE';

/* -------------------------------------------------------------------------------------------- */

interface PlacesReview {
  rating?: number;
  relativePublishTimeDescription?: string;
  text?: { text?: string };
  originalText?: { text?: string };
  authorAttribution?: { displayName?: string; uri?: string };
}
interface PlacesResponse {
  rating?: number;
  userRatingCount?: number;
  reviews?: PlacesReview[];
}

const CACHE_KEY = 'gk-google-places';
const MAX_REVIEWS = 5;
const TIMEOUT_MS = 8000;

const isPlaceholder = (v: string) => !v || /^PASTE_.*_HERE$/.test(v);

function readCache(placeId: string): PlacesResponse | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const cached = JSON.parse(raw) as { id?: string; data?: PlacesResponse };
    return cached.id === placeId && cached.data ? cached.data : null;
  } catch {
    return null;
  }
}
function writeCache(placeId: string, data: PlacesResponse): void {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({ id: placeId, data }));
  } catch {
    /* storage unavailable (private mode…) — the in-memory result is enough for this page view */
  }
}

/** Updates every hero / stats / reviews-score element that shows the rating or the review count. */
function applyAggregate(rating: number | undefined, count: number | undefined): void {
  const fmt = (n: number, d: number) => n.toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });
  if (typeof rating === 'number' && rating > 0) {
    document.querySelectorAll<HTMLElement>('[data-live-rating]').forEach((el) => {
      if (el.dataset.count !== undefined) {
        el.dataset.count = rating.toFixed(1);
        // A counter that has not started yet will count up to the new value; otherwise just show it
        if (!el.dataset.counting || el.dataset.counted) el.textContent = fmt(rating, 1);
      } else {
        el.textContent = fmt(rating, 1);
      }
    });
  }
  if (typeof count === 'number' && count > 0) {
    document.querySelectorAll<HTMLElement>('[data-live-count]').forEach((el) => {
      if (el.dataset.count !== undefined) {
        el.dataset.count = String(count);
        if (!el.dataset.counting || el.dataset.counted) el.textContent = fmt(count, 0);
      } else {
        el.textContent = fmt(count, 0);
      }
    });
    // The static copy says "467+"; a live figure is exact, so the plus goes
    document.querySelectorAll<HTMLElement>('[data-live-plus]').forEach((el) => (el.hidden = true));
  }
  document.querySelectorAll<HTMLElement>('[data-live-text]').forEach((el) => {
    const t = el.dataset.liveText ?? '';
    if (typeof rating === 'number' && rating > 0 && (typeof count === 'number' || !t.includes('{count}'))) {
      el.textContent = t.replace('{rating}', fmt(rating, 1)).replace('{count}', fmt(count ?? 0, 0));
    }
  });
}

function stars(rating: number): HTMLElement {
  const n = Math.max(0, Math.min(5, Math.round(rating)));
  const wrap = document.createElement('span');
  wrap.className = 'card__stars';
  wrap.setAttribute('role', 'img');
  wrap.setAttribute('aria-label', `${n} out of 5 stars`);
  const on = document.createElement('span');
  on.textContent = '★'.repeat(n);
  wrap.append(on);
  if (n < 5) {
    const off = document.createElement('span');
    off.className = 'off';
    off.textContent = '★'.repeat(5 - n);
    wrap.append(off);
  }
  return wrap;
}

function buildCard(tpl: HTMLTemplateElement, r: PlacesReview, i: number, total: number): HTMLElement | null {
  const text = (r.text?.text ?? r.originalText?.text ?? '').trim();
  if (!text) return null;
  const card = tpl.content.firstElementChild?.cloneNode(true) as HTMLElement | undefined;
  if (!card) return null;
  card.setAttribute('aria-label', `${i + 1} of ${total}`);
  card.style.setProperty('--ci', String(i)); // 80ms stagger between cards
  card.querySelector('[data-text]')!.textContent = text;

  const author = card.querySelector<HTMLElement>('[data-author]')!;
  const name = r.authorAttribution?.displayName?.trim() || 'Google reviewer';
  const uri = r.authorAttribution?.uri;
  if (uri && /^https:\/\//.test(uri)) {
    const a = document.createElement('a');
    a.href = uri;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = name;
    author.append(a);
  } else {
    author.textContent = name;
  }

  const meta = card.querySelector<HTMLElement>('[data-meta]')!;
  if (typeof r.rating === 'number') meta.append(stars(r.rating));
  if (r.relativePublishTimeDescription) {
    const time = document.createElement('span');
    time.textContent = r.relativePublishTimeDescription;
    meta.append(time);
  }
  meta.hidden = meta.childElementCount === 0;
  return card;
}

export function initGoogleReviews(): void {
  const key = GOOGLE_PLACES_API_KEY.trim();
  const placeId = GOOGLE_PLACE_ID.trim();
  if (isPlaceholder(key) || isPlaceholder(placeId)) return; // not configured: keep the built-in reviews, say nothing

  // "Read all reviews on Google" → the clinic's own listing
  document.querySelectorAll<HTMLAnchorElement>('[data-reviews-link]').forEach((a) => {
    a.href = `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(placeId)}`;
  });

  const slider = document.querySelector<HTMLElement>('[data-slider]');
  const track = slider?.querySelector<HTMLElement>('[data-slider-track]') ?? null;
  const cardTpl = slider?.querySelector<HTMLTemplateElement>('template[data-review-card]') ?? null;
  const skelTpl = slider?.querySelector<HTMLTemplateElement>('template[data-review-skeleton]') ?? null;
  const builtIn = track ? Array.from(track.children) : [];

  const show = (nodes: Element[]) => {
    if (!slider || !track || nodes.length === 0) return;
    track.replaceChildren(...nodes);
    slider.style.setProperty('--k', String(Math.min(nodes.length, 3)));
    slider.dispatchEvent(new Event('slider:refresh'));
  };

  const apply = (data: PlacesResponse) => {
    applyAggregate(data.rating, data.userRatingCount);
    if (!cardTpl) return;
    const live = (data.reviews ?? []).filter((r) => (r.text?.text ?? r.originalText?.text ?? '').trim()).slice(0, MAX_REVIEWS);
    const cards = live.map((r, i) => buildCard(cardTpl, r, i, live.length)).filter((c): c is HTMLElement => c !== null);
    show(cards.length > 0 ? cards : builtIn);
    slider?.removeAttribute('aria-busy');
  };

  // Fetched once per visit: later page views in the same tab reuse the stored response
  const cached = readCache(placeId);
  if (cached) {
    apply(cached);
    return;
  }

  if (skelTpl && track) {
    show(Array.from({ length: 3 }, () => skelTpl.content.firstElementChild!.cloneNode(true) as Element));
    slider?.setAttribute('aria-busy', 'true');
  }

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), TIMEOUT_MS);
  const url = `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}?fields=rating,userRatingCount,reviews&key=${encodeURIComponent(key)}`;

  fetch(url, { signal: controller.signal })
    .then((res) => {
      if (!res.ok) throw new Error(String(res.status));
      return res.json() as Promise<PlacesResponse>;
    })
    .then((data) => {
      writeCache(placeId, data);
      apply(data);
    })
    .catch(() => {
      // Network error, quota, bad key, blocked referrer… → the built-in reviews, never an empty section
      show(builtIn);
      slider?.removeAttribute('aria-busy');
    })
    .finally(() => window.clearTimeout(timeout));
}
