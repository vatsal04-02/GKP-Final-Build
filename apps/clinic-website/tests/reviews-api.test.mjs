// Tests for api/reviews.mjs. Google is a fake `fetch`; nothing touches a network and no real key or place id is used.
// Run: npm test   (node --test)
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../api/reviews.mjs';

const KEY = 'synthetic-google-key-0123456789';
const ENV = { GOOGLE_PLACES_API_KEY: KEY, GOOGLE_PLACE_ID: 'ChIJsynthetic0123456789' };

const call = async (handler, method = 'GET') => {
  const res = { statusCode: 0, headers: {}, body: '', setHeader(k, v) { this.headers[k] = v; }, end(s = '') { this.body = s; } };
  await handler({ method, headers: {} }, res);
  return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null, headers: res.headers, raw: res.body };
};
const mk = (impl, env = ENV) => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return impl(url, init); };
  return { handler: createHandler({ env, fetchImpl }), calls };
};
const google = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
const review = (i, over = {}) => ({
  rating: 5,
  relativePublishTimeDescription: `${i} months ago`,
  text: { text: `Synthetic review ${i}` },
  authorAttribution: { displayName: `Reviewer ${i}`, uri: `https://www.google.com/maps/contrib/${i}` },
  ...over,
});

test('1 not configured: 204, Google is never called', async () => {
  for (const env of [{}, { GOOGLE_PLACES_API_KEY: KEY }, { GOOGLE_PLACE_ID: ENV.GOOGLE_PLACE_ID }, { ...ENV, GOOGLE_PLACE_ID: 'bad id!' }]) {
    const { handler, calls } = mk(() => google({}), env);
    const r = await call(handler);
    assert.equal(r.status, 204);
    assert.equal(r.raw, '');
    assert.equal(calls.length, 0);
  }
});

test('2 configured: one Google call with the key in a header (not the URL), a trimmed answer, cached for a day', async () => {
  const { handler, calls } = mk(() => google({ rating: 5, userRatingCount: 467, reviews: [review(1), review(2)], somethingElse: 'x' }));
  const r = await call(handler);
  assert.equal(r.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://places.googleapis.com/v1/places/ChIJsynthetic0123456789');
  assert.equal(calls[0].init.headers['X-Goog-Api-Key'], KEY);
  assert.equal(calls[0].init.headers['X-Goog-FieldMask'], 'rating,userRatingCount,reviews');
  assert(!calls[0].url.includes(KEY), 'the key is never in the URL');
  assert.equal(r.json.rating, 5);
  assert.equal(r.json.userRatingCount, 467);
  assert.equal(r.json.placeId, ENV.GOOGLE_PLACE_ID);
  assert.equal(r.json.reviews.length, 2);
  assert.deepEqual(r.json.reviews[0].authorAttribution, { displayName: 'Reviewer 1', uri: 'https://www.google.com/maps/contrib/1' });
  assert.equal(r.json.somethingElse, undefined, 'unknown upstream fields are not forwarded');
  assert(!r.raw.includes(KEY), 'the key is never in the answer');
  assert.match(r.headers['Cache-Control'], /s-maxage=86400/);
});

test('3 at most 5 reviews; empty ones dropped; non-https author links removed; long text cut', async () => {
  const many = [1, 2, 3, 4, 5, 6, 7].map((i) => review(i));
  many[0] = review(1, { text: { text: '   ' } });
  many[1] = review(2, { authorAttribution: { displayName: 'No Link', uri: 'javascript:alert(1)' } });
  many[2] = review(3, { text: { text: 'x'.repeat(5000) } });
  const { handler } = mk(() => google({ rating: 4.8, userRatingCount: 10, reviews: many }));
  const r = await call(handler);
  assert.equal(r.json.reviews.length, 5);
  assert(r.json.reviews.every((x) => x.text.text.trim()));
  assert.equal(r.json.reviews[0].authorAttribution.uri, undefined);
  assert.equal(r.json.reviews[1].text.text.length, 1500);
});

test('4 Google error, bad JSON or timeout: 502 "unavailable", no upstream detail, short cache', async () => {
  const cases = [
    () => google({ error: { message: `API key ${KEY} is invalid` } }, 403),
    () => ({ ok: true, status: 200, json: async () => { throw new Error('not json'); } }),
    () => { throw new Error('network down'); },
  ];
  for (const impl of cases) {
    const { handler } = mk(impl);
    const r = await call(handler);
    assert.equal(r.status, 502);
    assert.deepEqual(r.json, { ok: false, error: 'unavailable' });
    assert(!r.raw.includes(KEY));
    assert.match(r.headers['Cache-Control'], /s-maxage=60/);
  }
});

test('5 only GET and HEAD are served', async () => {
  const { handler, calls } = mk(() => google({}));
  const r = await call(handler, 'POST');
  assert.equal(r.status, 405);
  assert.equal(r.headers.Allow, 'GET, HEAD');
  assert.equal(calls.length, 0);
});
