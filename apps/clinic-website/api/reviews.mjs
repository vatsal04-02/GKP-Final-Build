// GET /api/reviews  -  the clinic's live Google rating and latest reviews. The page asks this function instead of calling Google itself,
// so the API key stays on the server (it never appears in the page source) and Vercel caches the answer for a day: one Google call per
// day instead of one per visitor.
//
// Server-only environment variables (Vercel > Project > Settings > Environment Variables; never PUBLIC_*):
//   GOOGLE_PLACES_API_KEY   a Google Cloud API key restricted to "Places API (New)" only.
//   GOOGLE_PLACE_ID         the clinic's Google place id (find it with Google's free Place ID Finder).
// Without both, the function answers 204 and the page keeps its built-in, clinic-approved reviews. Any Google failure answers 502
// (cached briefly) and the page does the same. Google returns at most 5 reviews for a place and chooses which; the rating and the
// total count are exact. Authors stay attributed and linked. Nothing from the visitor is read or logged.
const MAX_REVIEWS = 5;
const MAX_TEXT = 1500;
const TIMEOUT_MS = 6000;
const DAY = 86_400;

const send = (res, status, body, cache) => {
  res.statusCode = status;
  res.setHeader('Cache-Control', cache);
  if (body === undefined) return res.end();
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
};

const text = (v) => (typeof v === 'string' ? v.trim() : '');

/** Keeps only what the page shows. The upstream body is never forwarded as it is. */
export const shape = (placeId, data) => {
  const reviews = (Array.isArray(data?.reviews) ? data.reviews : [])
    .map((r) => {
      const body = text(r?.text?.text) || text(r?.originalText?.text);
      if (!body) return null;
      const uri = text(r?.authorAttribution?.uri);
      return {
        rating: Number.isFinite(r?.rating) ? Math.max(1, Math.min(5, Math.round(r.rating))) : undefined,
        relativePublishTimeDescription: text(r?.relativePublishTimeDescription).slice(0, 60) || undefined,
        text: { text: body.slice(0, MAX_TEXT) },
        authorAttribution: {
          displayName: text(r?.authorAttribution?.displayName).slice(0, 80) || undefined,
          uri: /^https:\/\//i.test(uri) ? uri : undefined,
        },
      };
    })
    .filter(Boolean)
    .slice(0, MAX_REVIEWS);
  return {
    placeId,
    rating: Number.isFinite(data?.rating) && data.rating > 0 ? data.rating : undefined,
    userRatingCount: Number.isFinite(data?.userRatingCount) && data.userRatingCount > 0 ? Math.round(data.userRatingCount) : undefined,
    reviews,
  };
};

export const createHandler = ({ env = process.env, fetchImpl = globalThis.fetch } = {}) => async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return send(res, 405, { ok: false, error: 'method' }, 'no-store');
  }
  const key = text(env.GOOGLE_PLACES_API_KEY);
  const placeId = text(env.GOOGLE_PLACE_ID);
  if (!key || !/^[A-Za-z0-9_-]{10,200}$/.test(placeId)) return send(res, 204, undefined, 'public, s-maxage=300');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const upstream = await fetchImpl(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
      headers: { 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'rating,userRatingCount,reviews' },
      signal: controller.signal,
    });
    if (!upstream.ok) throw new Error(`google ${upstream.status}`);
    const body = shape(placeId, await upstream.json());
    return send(res, 200, body, `public, s-maxage=${DAY}, stale-while-revalidate=${DAY * 7}`);
  } catch {
    // bad key, quota, outage, timeout: say nothing about why; the page falls back to its built-in reviews
    return send(res, 502, { ok: false, error: 'unavailable' }, 'public, s-maxage=60');
  } finally {
    clearTimeout(timer);
  }
};

export default createHandler();
